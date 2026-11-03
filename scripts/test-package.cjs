const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-package-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
async function waitFor(check, message) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error(message); await delay(30); }
}
function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
  done.catch(() => {});
  return { child, done };
}
async function exercise(cli, standalone) {
  const state = path.join(temp, standalone ? 'standalone-state' : 'npm-state');
  const clientBin = path.join(temp, standalone ? 'standalone-path' : 'npm-path');
  fs.mkdirSync(state); fs.mkdirSync(clientBin);
  const tokens = { access_token: `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`, refresh_token: 'fake-refresh', account_id: 'test-account' };
  fs.writeFileSync(path.join(state, 'codex_auth.json'), JSON.stringify(tokens), { mode: 0o600 });
  fs.writeFileSync(path.join(clientBin, 'claude'), `#!/bin/sh\nrecord=\nhold=no\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --record) record="$2"; shift ;;\n    --hold) hold=yes ;;\n  esac\n  shift\ndone\n[ -z "$CLAUDE_CODE_USE_BEDROCK" ] || exit 89\n[ -z "$ANTHROPIC_API_KEY" ] || exit 88\n[ -n "$record" ] || exit 87\nprintf '%s\\n' "$ANTHROPIC_BASE_URL" > "$record"\n/usr/bin/curl -fsS --max-time 10 -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hello"}]}' "$ANTHROPIC_BASE_URL/v1/messages/count_tokens" > "$record.tokens" || exit 86\nif [ "$hold" = yes ]; then\n  trap 'exit 0' TERM INT\n  while :; do /bin/sleep 1; done\nfi\nexit 7\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: standalone ? clientBin : `${clientBin}:${process.env.PATH}`, HOME: path.join(temp, 'home'), CLAUDE_CODEX_STATE_DIR: state, CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'fake-old-key' };
  delete env.CLAUDE_GPT_MODEL; delete env.CLAUDE_GPT_EFFORT;
  // No Node/Bun executable exists anywhere on this PATH for the standalone test.
  if (standalone) assert.deepEqual(fs.readdirSync(clientBin), ['claude']);
  assert(run(cli, ['--version'], { env }).includes('0.1.0-dev.0'));
  run(cli, ['settings', 'set', '--model', 'gpt-6.1-sol', '--effort', 'high'], { env });
  const one = path.join(state, 'one');
  const result = await start(cli, ['--record', one], env).done;
  assert.equal(result.code, 7, result.output);
  assert(JSON.parse(fs.readFileSync(one + '.tokens')).input_tokens > 0);
  assert(!fs.readdirSync(state).some(name => name.startsWith('session-')), 'session must be cleaned after Claude exit');
  const aFile = path.join(state, 'a'), bFile = path.join(state, 'b');
  const a = start(cli, ['--model', 'gpt-6-astra', '--effort', 'max', '--record', aFile, '--hold'], env);
  const b = start(cli, ['--model', 'gpt-6-luna', '--effort', 'low', '--record', bFile, '--hold'], env);
  try {
    await waitFor(() => [aFile, bFile].every(file => fs.existsSync(file + '.tokens') && fs.statSync(file + '.tokens').size), 'concurrent clients did not become ready');
    assert.notEqual(fs.readFileSync(aFile, 'utf8'), fs.readFileSync(bFile, 'utf8'));
    assert.equal(fs.readdirSync(state).filter(name => name.startsWith('session-')).length, 2);
    a.child.kill('SIGTERM');
    await a.done;
    assert.equal(b.child.exitCode, null, 'closing one session must not stop another');
    const base = fs.readFileSync(bFile, 'utf8').trim();
    // Authentication remains required; a keyless sibling request must fail.
    assert.equal((await fetch(base + '/health')).status, 401);
  } finally { a.child.kill('SIGTERM'); b.child.kill('SIGTERM'); await Promise.all([a.done, b.done]); }
  assert(!fs.readdirSync(state).some(name => name.startsWith('session-')));
  // Upgrade/reinstall must preserve state bytes; caller reinstalls below for npm.
  return { env, state, settings: fs.readFileSync(path.join(state, 'settings.json')), auth: fs.readFileSync(path.join(state, 'codex_auth.json')) };
}
async function main() {
  run(process.execPath, [path.join(root, 'scripts/build.cjs')]);
  const dry = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']))[0];
  const allowed = new Set(['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt', 'vendor/ccr/LICENSE', 'vendor/ccr/PROVENANCE.md', 'dist/cli.cjs', 'dist/cli.cjs.LEGAL.txt']);
  assert.deepEqual(new Set(dry.files.map(file => file.path)), allowed);
  const pack = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp]))[0];
  const tarball = path.join(temp, pack.filename);
  const entries = run('/usr/bin/tar', ['-tzf', tarball]).trim().split('\n').map(file => file.replace(/^package\//, ''));
  assert.deepEqual(new Set(entries), allowed);
  const install = path.join(temp, 'install');
  run('npm', ['install', '--prefix', install, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball]);
  const cli = path.join(install, 'node_modules/.bin/claude-codex');
  const saved = await exercise(cli, false);
  run('npm', ['install', '--prefix', install, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--force', tarball]);
  assert.deepEqual(fs.readFileSync(path.join(saved.state, 'settings.json')), saved.settings);
  assert.deepEqual(fs.readFileSync(path.join(saved.state, 'codex_auth.json')), saved.auth);
  assert(!fs.existsSync(path.join(install, 'node_modules/fastify')), 'runtime dependencies must be bundled');
  console.log('PASS: npm dry-run + real tarball exact allowlist, clean install, live local child server + WASM, client exit status, concurrent sessions, termination and state preservation on reinstall.');
  const native = path.join(root, 'artifacts', `bun-${process.platform}-${process.arch}`, 'claude-codex');
  if (!fs.existsSync(native)) throw new Error('Native standalone not built. Run bun run build:standalone first.');
  const copied = path.join(temp, 'claude-codex'); fs.copyFileSync(native, copied); fs.chmodSync(copied, 0o755);
  await exercise(copied, true);
  console.log('PASS: relocated native standalone launches its own router and embedded WASM with no Node/Bun in PATH, using a fake external Claude client.');
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.copyFileSync(tarball, path.join(root, 'artifacts', pack.filename));
  console.log(`Verified local npm artifact: artifacts/${pack.filename}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
