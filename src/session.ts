import { type ChildProcess, type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type {
  ParsedOverrides,
  RouterMetadata,
  RouterSession,
  SpawnClientOptions,
} from './session.types';
import * as state from './state';
import type { SettingsOverrides } from './state.types';

/**
 * Сколько процесс сессии ждёт после сигнала до SIGKILL. Тот же срок роутер даёт себе на
 * закрытие сервера перед принудительным выходом.
 */
const KILL_GRACE_MS = 2000;

/**
 * Родитель ждёт роутер чуть дольше его собственного дедлайна: штатный выход роутера успевает
 * раньше SIGKILL.
 */
const ROUTER_STOP_GRACE_MS = KILL_GRACE_MS + 200;

const STARTUP_TIMEOUT_MS = 20_000;

/**
 * Первая строка stdout роутера — короткий JSON с адресом; больше — значит, это не он.
 */
const MAX_STARTUP_OUTPUT = 8192;

/**
 * Сигналы завершения: сессия отменяется, клиент получает тот же сигнал. SIGHUP приходит при
 * закрытии вкладки терминала — без обработчика процесс умер бы до уборки сессии.
 */
const SESSION_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const isSessionSignal = (value: unknown): value is NodeJS.Signals => {
  return SESSION_SIGNALS.some((name) => {
    return name === value;
  });
};

/**
 * Сигнал процессу и SIGKILL, если тот не вышел за `graceMs`. Таймер снимается при выходе
 * процесса и не держит event loop.
 */
const signalWithEscalation = (
  child: ChildProcess,
  signal: NodeJS.Signals,
  graceMs: number
) => {
  const timer = setTimeout(() => {
    return child.kill('SIGKILL');
  }, graceMs);

  timer.unref();
  child.once('exit', () => {
    return clearTimeout(timer);
  });
  child.kill(signal);
};

/**
 * Снимок лимитов Codex в каталоге сессии: его пишет роутер, читает обёртка statusline.
 */
export const LIMITS_FILE = 'rate-limits.json';

/**
 * Последний запрос сессии к Codex — для проверки `/model` и `/effort` (`cat` во время сессии).
 */
const REQUEST_FILE = 'last-request.json';

export const selfCommand = (args: string[]) => {
  const isStandalone = Bun.main.startsWith('/$bunfs/');

  return [process.execPath, ...(isStandalone ? [] : [process.argv[1]]), ...args];
};

export const parseOverrides = (args: string[]): ParsedOverrides => {
  const overrides: SettingsOverrides = {},
    rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }

    if (arg === '--model' || arg === '--effort') {
      if (!args[i + 1] || args[i + 1].startsWith('-'))
        throw new Error(`Missing value for ${arg}`);
      overrides[arg === '--model' ? 'model' : 'reasoningEffort'] = args[++i];
    } else if (arg.startsWith('--model=')) {
      if (!arg.slice(8)) throw new Error('Missing value for --model');
      overrides.model = arg.slice(8);
    } else if (arg.startsWith('--effort=')) {
      if (!arg.slice(9)) throw new Error('Missing value for --effort');
      overrides.reasoningEffort = arg.slice(9);
    } else rest.push(arg);
  }

  return { overrides, rest };
};

export const internalRouter = async (session: string | undefined) => {
  const key = process.env.CLAUDE_CODEX_SESSION_KEY;

  if (
    !session ||
    !key ||
    !/^[a-f0-9]{64}$/.test(key) ||
    !path.resolve(session).startsWith(state.RUNTIME_DIR + path.sep)
  )
    throw new Error('Internal router requires a private session');
  /**
   * Ни учётные данные, ни локальный ключ сессии не печатаются и не попадают в метаданные.
   */
  const { createRouter } = await import('./transport/server');
  const app = await createRouter({
    key,
    limitsFile: path.join(session, LIMITS_FILE),
    requestFile: path.join(session, REQUEST_FILE),
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const metadata: RouterMetadata = {
    pid: process.pid,
    base,
    startedAt: new Date().toISOString(),
  };

  state.writeJson(path.join(session, 'health.json'), metadata);
  let isStopping = false;

  const handleStop = async () => {
    if (isStopping) return;
    isStopping = true;
    const deadline = setTimeout(() => {
      return process.exit(1);
    }, KILL_GRACE_MS);

    deadline.unref();

    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  for (const name of SESSION_SIGNALS) process.on(name, handleStop);
  process.stdin.resume();
  /**
   * Смерть родителя закрывает pipe — даже после SIGKILL.
   */
  process.stdin.once('end', handleStop);
  process.stdout.write(JSON.stringify(metadata) + '\n');
};

const isRouterMetadata = (value: unknown): value is RouterMetadata => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'base' in value &&
    typeof value.base === 'string'
  );
};

export const withRouter = async <T>(
  overrides: SettingsOverrides,
  action: (session: RouterSession) => Promise<T>
): Promise<T> => {
  state.requireAuth();
  const active = state.activeSettings(overrides);

  state.ensureState();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODEX_STATE_DIR: state.RUNTIME_DIR,
  };

  for (const [key, value] of Object.entries(overrides))
    env[key === 'model' ? 'CLAUDE_CODEX_MODEL' : 'CLAUDE_CODEX_EFFORT'] = value;
  const key = crypto.randomBytes(32).toString('hex');
  const session = fs.mkdtempSync(path.join(state.RUNTIME_DIR, 'session-'));
  const [command, ...args] = selfCommand(['__router', session]);
  let router: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let exited: Promise<unknown> | undefined;
  let failure: Error | undefined;
  const controller = new AbortController();

  /**
   * Сигнал — единственная точка отмены: причина отмены несёт его имя, и `spawnClient` передаёт
   * клиенту тот же сигнал. Роутер останавливается в `finally`, когда действие завершилось.
   * Подписка `on`, а не `once`: повторный сигнал не должен убить мост действием по умолчанию до
   * уборки сессии.
   */
  const handleSignal = (signal: NodeJS.Signals) => {
    controller.abort(signal);
  };

  for (const name of SESSION_SIGNALS) process.on(name, handleSignal);

  try {
    const child = spawn(command, args, {
      env: { ...env, CLAUDE_CODEX_SESSION_KEY: key },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    router = child;
    exited = new Promise((resolve) => {
      return child.once('exit', resolve);
    });
    child.once('error', (error) => {
      failure = error;
    });
    const metadata = await new Promise<RouterMetadata>((resolve, reject) => {
      let output = '';

      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        controller.signal.removeEventListener('abort', onAbort);
      };

      const finish = (error: Error | null, value?: RouterMetadata) => {
        cleanup();

        if (error) {
          reject(error);

          return;
        }

        if (value) resolve(value);
      };

      const onAbort = () => {
        return finish(new Error('Session cancelled'));
      };

      const onError = (error: Error) => {
        return finish(error);
      };

      const onExit = (code: number | null) => {
        return finish(new Error(`CCR exited during startup (${code})`));
      };

      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > MAX_STARTUP_OUTPUT)
          return finish(new Error('Unexpected CCR startup output'));
        if (!output.includes('\n')) return;

        let parsed: unknown;

        try {
          parsed = JSON.parse(output.split('\n')[0]);
        } catch {
          /**
           * Не JSON — та же ошибка, что и для JSON без адреса: ниже.
           */
        }

        if (isRouterMetadata(parsed)) finish(null, parsed);
        else finish(new Error('Invalid CCR startup response'));
      };

      const timer = setTimeout(() => {
        return finish(new Error('CCR startup timed out'));
      }, STARTUP_TIMEOUT_MS);

      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });

    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(metadata.base))
      throw new Error('Invalid router address');
    if (controller.signal.aborted) throw new Error('Session cancelled');
    /**
     * Вычитываем pipe, хотя вывода роутера больше не ждём.
     */
    child.stdout.resume();

    const handleRouterExit = () => {
      return controller.abort(new Error('Router exited'));
    };

    child.once('exit', handleRouterExit);

    try {
      return await action({
        base: metadata.base,
        key,
        session,
        active,
        env,
        signal: controller.signal,
      });
    } finally {
      child.removeListener('exit', handleRouterExit);
    }
  } finally {
    /**
     * Обработчики сигналов снимаются последними: повторный Ctrl-C во время остановки роутера
     * иначе убил бы мост до удаления каталога сессии.
     */
    try {
      if (router && router.exitCode === null && router.signalCode === null && !failure) {
        signalWithEscalation(router, 'SIGTERM', ROUTER_STOP_GRACE_MS);
        await exited;
      }

      fs.rmSync(session, { recursive: true, force: true });
    } finally {
      for (const name of SESSION_SIGNALS) process.removeListener(name, handleSignal);
    }
  }
};

export const spawnClient = (
  command: string,
  args: string[],
  { env, signal }: SpawnClientOptions = {}
) => {
  return new Promise<number>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Session cancelled'));

      return;
    }

    const child = spawn(command, args, { env, stdio: 'inherit' });

    /**
     * Отмена сигналом передаёт клиенту тот же сигнал; смерть роутера — SIGTERM.
     */
    const handleAbort = () => {
      signalWithEscalation(
        child,
        isSessionSignal(signal?.reason) ? signal.reason : 'SIGTERM',
        KILL_GRACE_MS
      );
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort);
    };

    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new Error(
          error.code === 'ENOENT'
            ? 'Claude Code not found in PATH. Install Claude Code separately.'
            : error.message
        )
      );
    });
    child.once('exit', (code, sig) => {
      cleanup();
      /**
       * Код 0 — успех клиента, а не «кода нет»: `||` превратил бы его в код сигнала. null — процесс
       * убит сигналом: код по конвенции shell, 128 + номер сигнала.
       */
      resolve(
        code ?? 128 + (sig ? os.constants.signals[sig] : os.constants.signals.SIGTERM)
      );
    });
  });
};
