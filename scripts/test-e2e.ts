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
[ -n "$record" ] || exit 87
printf '%s\\n' "$ANTHROPIC_BASE_URL" > "$record"
/usr/bin/curl -fsS --max-time 10 -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hello"}]}' "$ANTHROPIC_BASE_URL/v1/messages/count_tokens" > "$record.tokens" || exit 86
if [ "$hold" = yes ]; then
  trap 'exit 0' TERM INT
  while :; do /bin/sleep 1; done
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
    timeout: 60000,
    ...options,
  });

  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
  );

  return result.stdout;
};

const waitFor = async (check: () => boolean, message: string) => {
  const deadline = Date.now() + 15000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(30);
  }
};

const start = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';

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

  return { child, done };
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: isStandalone ? clientBin : `${clientBin}:${process.env.PATH}`,
    HOME: path.join(temp, 'home'),
    CLAUDE_CODEX_STATE_DIR: state,
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: 'fake-old-key',
  };

  delete env.CLAUDE_CODEX_MODEL;
  delete env.CLAUDE_CODEX_EFFORT;
  /**
   * Для standalone-теста в этом PATH нет ни Node, ни Bun.
   */
  if (isStandalone) assert.deepEqual(fs.readdirSync(clientBin), ['claude']);
  assert(run(cli, ['--version'], { env }).includes(packageJson.version));
  run(cli, ['settings', 'set', '--model', 'gpt-6.1-sol', '--effort', 'high'], { env });
  const one = path.join(state, 'one');
  const result = await start(cli, ['--record', one], env).done;

  assert.equal(result.code, 7, result.output);
  assert(JSON.parse(fs.readFileSync(one + '.tokens', 'utf8')).input_tokens > 0);
  assert(fs.readFileSync(one + '.shim', 'utf8').includes(packageJson.version));
  assert(!sessions(state).length, 'session must be cleaned after Claude exit');
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
    await waitFor(() => {
      return [aFile, bFile].every((file) => {
        return fs.existsSync(file + '.tokens') && fs.statSync(file + '.tokens').size > 0;
      });
    }, 'concurrent clients did not become ready');
    assert.notEqual(fs.readFileSync(aFile, 'utf8'), fs.readFileSync(bFile, 'utf8'));
    assert.equal(sessions(state).length, 2);
    a.child.kill('SIGTERM');
    await a.done;
    assert.equal(b.child.exitCode, null, 'closing one session must not stop another');
    const base = fs.readFileSync(bFile, 'utf8').trim();

    /**
     * Аутентификация по-прежнему обязательна: соседний запрос без ключа должен упасть.
     */
    assert.equal((await fetch(base + '/health')).status, 401);
  } finally {
    a.child.kill('SIGTERM');
    b.child.kill('SIGTERM');
    await Promise.all([a.done, b.done]);
  }

  assert(!sessions(state).length);
};

try {
  run(process.execPath, [path.join(root, 'scripts/build.ts')]);
  await exercise(path.join(root, 'dist/cli.js'), false);
  console.log(
    'PASS: bundled CLI launches its own local router + WASM, session plugin and PATH shim, client exit status, concurrent sessions, termination and session cleanup.'
  );
  const native = path.join(
    root,
    'artifacts',
    `bun-${process.platform}-${process.arch}`,
    'claude-codex'
  );

  if (!fs.existsSync(native))
    throw new Error('Native standalone not built. Run bun run build:standalone first.');
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
