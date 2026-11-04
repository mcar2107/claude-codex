import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

const sleep = (ms: number) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

const selfCommand = (args: string[]) => {
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
    !path.resolve(session).startsWith(state.runtime + path.sep)
  )
    throw new Error('Internal router requires a private session');
  /**
   * Ни учётные данные, ни локальный ключ сессии не печатаются и не попадают в метаданные.
   */
  const { createRouter } = await import('./transport/server');
  const app = await createRouter({ key });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const metadata: RouterMetadata = {
    pid: process.pid,
    base,
    startedAt: new Date().toISOString(),
  };

  state.writeJson(path.join(session, 'health.json'), metadata);
  let isStopping = false;

  const stop = async () => {
    if (isStopping) return;
    isStopping = true;
    const force = setTimeout(() => {
      return process.exit(1);
    }, 2000);

    force.unref();

    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.resume();
  /**
   * Смерть родителя закрывает pipe — даже после SIGKILL.
   */
  process.stdin.once('end', stop);
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
    CLAUDE_CODEX_STATE_DIR: state.runtime,
  };

  for (const [key, value] of Object.entries(overrides))
    env[key === 'model' ? 'CLAUDE_CODEX_MODEL' : 'CLAUDE_CODEX_EFFORT'] = value;
  const key = crypto.randomBytes(32).toString('hex');
  const session = fs.mkdtempSync(path.join(state.runtime, 'session-'));
  const [command, ...args] = selfCommand(['__router', session]);
  let router: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let exited: Promise<unknown> | undefined;
  let failure: Error | undefined;
  const controller = new AbortController();

  const abort = () => {
    controller.abort();
    router?.kill('SIGTERM');
  };

  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);

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
        if (output.length > 8192)
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
      }, 20000);

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

    const died = () => {
      return controller.abort(new Error('Router exited'));
    };

    child.once('exit', died);

    try {
      return await action({
        base: metadata.base,
        key,
        active,
        env,
        signal: controller.signal,
      });
    } finally {
      child.removeListener('exit', died);
    }
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);

    if (router && router.exitCode === null && router.signalCode === null && !failure) {
      router.kill('SIGTERM');
      await Promise.race([exited, sleep(2200)]);

      if (router.exitCode === null && router.signalCode === null) {
        router.kill('SIGKILL');
        await exited;
      }
    }

    fs.rmSync(session, { recursive: true, force: true });
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
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      return child.kill('SIGTERM');
    };

    const interrupt = () => {
      return child.kill('SIGINT');
    };

    const force = () => {
      terminate();
      killTimer = setTimeout(() => {
        return child.kill('SIGKILL');
      }, 2000);
      killTimer.unref();
    };

    signal?.addEventListener('abort', force, { once: true });
    process.once('SIGTERM', terminate);
    process.once('SIGINT', interrupt);

    const cleanup = () => {
      clearTimeout(killTimer);
      process.removeListener('SIGTERM', terminate);
      process.removeListener('SIGINT', interrupt);
      signal?.removeEventListener('abort', force);
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
       * убит сигналом.
       */
      resolve(code ?? (sig === 'SIGTERM' ? 143 : 130));
    });
  });
};
