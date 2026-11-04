import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import packageJson from '../package.json' with { type: 'json' };

import type { ProcessResult } from './test-e2e.types';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-e2e-'));

/**
 * Дедлайн одного запуска моста: зависший запуск снимается сигналом, а тест падает с его выводом,
 * а не держит раннер.
 */
const RUN_TIMEOUT_MS = 60_000;

/**
 * Сколько мост ждёт штатного выхода после SIGTERM до SIGKILL.
 */
const KILL_GRACE_MS = 5000;

/**
 * Сколько ждать, пока параллельные клиенты поднимутся и запишут ответ count_tokens.
 */
const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 30;

/**
 * Потолок запроса к роутеру из теста: зависший роутер должен ронять тест, а не держать его.
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Окружение разработчика, которое увело бы мост мимо временного state: свой каталог Claude Code,
 * ключ сессии, OAuth-файл и настройки моста (`CLAUDE_CODEX_*`, `CCR_*`).
 */
const FOREIGN_ENV = /^(CLAUDE_CODEX_|CCR_|CLAUDE_CONFIG_DIR$)/;

/**
 * Запущенные мосты: каждый — лидер своей группы процессов, чтобы по таймауту или Ctrl-C снять и
 * его клиента с роутером, даже если сам мост не успел их завершить.
 */
const groups = new Set<number>();

/**
 * Входы standalone-сборки: бинарник старше любого из них собран из другого кода.
 */
const STANDALONE_INPUTS = [
  'src',
  'vendor/ccr',
  'scripts/build.ts',
  'scripts/licenses.ts',
  'scripts/standalone.ts',
  'package.json',
  'bun.lock',
];

/**
 * Фейковый клиент Claude: пишет адрес роутера и ответ count_tokens в файл `--record`; с `--hold`
 * живёт до SIGTERM. Проверяет, что мост вычистил чужие учётные данные из окружения, передал
 * плагин сессии и положил `claude-codex` в PATH.
 */
const FAKE_CLAUDE = `#!/bin/sh
record=
hold=no
plugin=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --record) record="$2"; shift ;;
    --plugin-dir) plugin="$2"; shift ;;
    --hold) hold=yes ;;
  esac
  shift
done
[ -f "$plugin/commands/settings.md" ] || exit 85
claude-codex --version > "$record.shim" || exit 84
[ -z "$CLAUDE_CODE_USE_BEDROCK" ] || exit 89
[ -z "$ANTHROPIC_API_KEY" ] || exit 88
[ "$CLAUDE_CODE_AUTO_MODE_SERVER" = 0 ] || exit 83
[ -n "$record" ] || exit 87
printf '%s\\n' "$ANTHROPIC_BASE_URL" > "$record"
/usr/bin/curl -fsS --max-time 10 -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hello"}]}' "$ANTHROPIC_BASE_URL/v1/messages/count_tokens" > "$record.tokens" || exit 86
if [ "$hold" = yes ]; then
  trap 'exit 0' TERM INT
  # Смерть моста — тоже выход: сирота не должен крутиться после сбоя теста.
  while kill -0 "$PPID" 2>/dev/null; do /bin/sleep 1; done
  exit 0
fi
exit 7
`;

const delay = (ms: number) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

const run = (
  command: string,
  args: string[],
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {}
) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
  );

  return result.stdout;
};

const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    /**
     * Группы уже нет: все её процессы вышли.
     */
  }
};

const start = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
  /**
   * `detached` — своя группа процессов: `killGroup` снимает мост вместе с потомками.
   */
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';

  if (child.pid) {
    groups.add(child.pid);
  }

  child.once('exit', () => {
    if (child.pid) {
      groups.delete(child.pid);
    }
  });

  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const done = new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      return resolve({ code, output });
    });
  });

  done.catch(() => {});

  return {
    child,
    done,
    output: () => {
      return output;
    },
  };
};

type Started = ReturnType<typeof start>;

/**
 * Ждёт `check`, но падает сразу, если один из процессов вышел раньше, — с его выводом.
 */
const waitFor = async (check: () => boolean, message: string, watched: Started[]) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (!check()) {
    const exited = watched.find(({ child }) => {
      return child.exitCode !== null || child.signalCode !== null;
    });

    /**
     * Код 0 — тоже ранний выход, а не «кода нет»: `||` подменил бы его сигналом.
     */
    if (exited) {
      throw new Error(
        `${message}: a process exited early (${exited.child.exitCode ?? exited.child.signalCode})\n${exited.output()}`
      );
    }

    if (Date.now() > deadline) {
      throw new Error(
        watched.reduce((text, { output }) => {
          return `${text}\n${output()}`;
        }, message)
      );
    }

    await delay(POLL_INTERVAL_MS);
  }
};

/**
 * Результат запуска не позже `RUN_TIMEOUT_MS`: по дедлайну мост получает SIGTERM (и уносит с
 * собой роутер и клиента), затем SIGKILL всей группе — на случай, если мост не ответил.
 */
const finish = async ({ child, done }: Started, label: string) => {
  let isTimedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const deadline = setTimeout(() => {
    isTimedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      return killGroup(child.pid, 'SIGKILL');
    }, KILL_GRACE_MS);
  }, RUN_TIMEOUT_MS);

  try {
    const result = await done;

    if (isTimedOut) {
      throw new Error(`${label} timed out after ${RUN_TIMEOUT_MS} ms\n${result.output}`);
    }

    return result;
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
  }
};

/**
 * Самое позднее время правки среди входов сборки, мс.
 */
const newestInput = () => {
  return STANDALONE_INPUTS.reduce((newest, input) => {
    const absolute = path.join(root, input);
    const files = fs.statSync(absolute).isDirectory()
      ? fs.readdirSync(absolute, { recursive: true, encoding: 'utf8' }).map((name) => {
          return path.join(absolute, name);
        })
      : [absolute];

    return files.reduce((latest, file) => {
      return Math.max(latest, fs.statSync(file).mtimeMs);
    }, newest);
  }, 0);
};

const sessions = (state: string) => {
  return fs.readdirSync(state).filter((name) => {
    return name.startsWith('session-');
  });
};

const exercise = async (cli: string, isStandalone: boolean) => {
  const kind = isStandalone ? 'standalone' : 'bundle';
  const state = path.join(temp, `${kind}-state`);
  const clientBin = path.join(temp, `${kind}-path`);

  fs.mkdirSync(state);
  fs.mkdirSync(clientBin);
  const tokens = {
    access_token: `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`,
    refresh_token: 'fake-refresh',
    account_id: 'test-account',
  };

  fs.writeFileSync(path.join(state, 'codex_auth.json'), JSON.stringify(tokens), {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(clientBin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  /**
   * Подмены HOME мало: `CLAUDE_CONFIG_DIR` разработчика важнее homedir, и мост писал бы в его
   * настоящий `settings.json`.
   */
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => {
        return !FOREIGN_ENV.test(name);
      })
    ),
    PATH: isStandalone ? clientBin : `${clientBin}:${process.env.PATH}`,
    HOME: path.join(temp, 'home'),
    CLAUDE_CONFIG_DIR: path.join(temp, `${kind}-claude`),
    CLAUDE_CODEX_STATE_DIR: state,
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_AUTO_MODE_SERVER: '1',
    ANTHROPIC_API_KEY: 'fake-old-key',
  };

  /**
   * Для standalone-теста в этом PATH нет ни Node, ни Bun.
   */
  if (isStandalone) {
    assert.deepEqual(fs.readdirSync(clientBin), ['claude']);
  }

  assert(run(cli, ['--version'], { env }).includes(packageJson.version));
  run(cli, ['settings', 'set', '--model', 'gpt-6.1-sol', '--effort', 'high'], { env });
  const one = path.join(state, 'one');
  const result = await finish(start(cli, ['--record', one], env), `${kind} launch`);

  assert.equal(result.code, 7, result.output);
  assert(JSON.parse(fs.readFileSync(one + '.tokens', 'utf8')).input_tokens > 0);
  assert(fs.readFileSync(one + '.shim', 'utf8').includes(packageJson.version));
  assert(!sessions(state).length, 'session must be cleaned after Claude exit');
  /**
   * Первый запуск перекрывает унаследованное включение; параллельные ниже проверяют запуск
   * без переменной в окружении родителя.
   */
  delete env.CLAUDE_CODE_AUTO_MODE_SERVER;
  const aFile = path.join(state, 'a'),
    bFile = path.join(state, 'b');
  const a = start(
    cli,
    ['--model', 'gpt-6-astra', '--effort', 'max', '--record', aFile, '--hold'],
    env
  );
  const b = start(
    cli,
    ['--model', 'gpt-6-luna', '--effort', 'low', '--record', bFile, '--hold'],
    env
  );

  try {
    await waitFor(
      () => {
        return [aFile, bFile].every((file) => {
          return (
            fs.existsSync(file + '.tokens') && fs.statSync(file + '.tokens').size > 0
          );
        });
      },
      'concurrent clients did not become ready',
      [a, b]
    );
    assert.notEqual(fs.readFileSync(aFile, 'utf8'), fs.readFileSync(bFile, 'utf8'));
    assert.equal(sessions(state).length, 2);
    a.child.kill('SIGTERM');
    const closed = await finish(a, `${kind} session a`);

    /**
     * Клиент выходит по пересланному SIGTERM с кодом 0, и мост возвращает его код.
     */
    assert.equal(closed.code, 0, closed.output);
    assert.equal(b.child.exitCode, null, 'closing one session must not stop another');
    assert.equal(
      sessions(state).length,
      1,
      'the closed session must be cleaned while another is alive'
    );
    const base = fs.readFileSync(bFile, 'utf8').trim();

    /**
     * Аутентификация по-прежнему обязательна: соседний запрос без ключа должен упасть.
     */
    assert.equal(
      (await fetch(base + '/health', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
        .status,
      401
    );
  } finally {
    a.child.kill('SIGTERM');
    b.child.kill('SIGTERM');
    await Promise.all([finish(a, `${kind} session a`), finish(b, `${kind} session b`)]);
  }

  assert(!sessions(state).length);
};

/**
 * Ctrl-C или SIGTERM тестового прогона: мосты в своих группах сигнал терминала не получат —
 * снимаем их сами.
 */
for (const name of ['SIGINT', 'SIGTERM'] as const) {
  process.once(name, () => {
    for (const pid of groups) {
      killGroup(pid, 'SIGKILL');
    }

    fs.rmSync(temp, { recursive: true, force: true });
    process.exit(130);
  });
}

try {
  const native = path.join(
    root,
    'artifacts',
    `bun-${process.platform}-${process.arch}`,
    'claude-codex'
  );

  /**
   * Свежесть проверяется до пересборки бандла: `dist/` ниже — не вход standalone-сборки.
   */
  if (!fs.existsSync(native)) {
    throw new Error('Native standalone not built. Run bun run build:standalone first.');
  }

  if (fs.statSync(native).mtimeMs < newestInput()) {
    throw new Error(
      'Native standalone is older than its sources. Run bun run build:standalone first.'
    );
  }

  run(process.execPath, [path.join(root, 'scripts/build.ts')]);
  await exercise(path.join(root, 'dist/cli.js'), false);
  console.log(
    'PASS: bundled CLI launches its own local router + WASM, session plugin and PATH shim, client exit status, concurrent sessions, termination and session cleanup.'
  );
  const copied = path.join(temp, 'claude-codex');

  fs.copyFileSync(native, copied);
  fs.chmodSync(copied, 0o755);
  await exercise(copied, true);
  console.log(
    'PASS: relocated native standalone launches its own router, embedded WASM, session plugin and PATH shim with no Node/Bun in PATH, using a fake external Claude client.'
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
