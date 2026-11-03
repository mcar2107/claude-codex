#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lib = require('./lib.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function spawnClient(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    const terminate = () => child.kill('SIGTERM');
    const interrupt = () => child.kill('SIGINT');
    process.once('SIGTERM', terminate);
    process.once('SIGINT', interrupt);
    const cleanup = () => {
      process.removeListener('SIGTERM', terminate);
      process.removeListener('SIGINT', interrupt);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 130 : 1)); });
  });
}
function sessionBundle(source, session) {
  for (const name of ['config.json', '.claude-code-router.pid', 'health.json']) {
    const pattern = new RegExp(`([\\w$]+\\.default\\.join\\([\\w$]+,)"${name.replaceAll('.', '\\.')}"\\)`, 'g');
    let count = 0;
    source = source.replace(pattern, () => { count++; return JSON.stringify(path.join(session, name)); });
    if (count !== 2) throw new Error(`CCR layout changed: expected two ${name} constants, found ${count}`);
  }
  return source;
}
function parseOverrides(args) {
  const rest = [];
  const overrides = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '--effort') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      overrides[arg === '--model' ? 'model' : 'reasoningEffort'] = args[++i];
    } else if (arg.startsWith('--model=')) overrides.model = arg.slice(8);
    else if (arg.startsWith('--effort=')) overrides.reasoningEffort = arg.slice(9);
    else rest.push(arg);
  }
  return { overrides, rest };
}
async function withRouter(overrides, action) {
  const config = JSON.parse(fs.readFileSync(lib.configFile, 'utf8'));
  const env = { ...process.env };
  if (overrides.model) env.CLAUDE_GPT_MODEL = overrides.model;
  if (overrides.reasoningEffort) env.CLAUDE_GPT_EFFORT = overrides.reasoningEffort;
  const active = lib.validate({
    ...lib.readSettings(),
    ...(env.CLAUDE_GPT_MODEL ? { model: env.CLAUDE_GPT_MODEL } : {}),
    ...(env.CLAUDE_GPT_EFFORT ? { reasoningEffort: env.CLAUDE_GPT_EFFORT } : {})
  });
  // Each session owns a separate runtime directory and port. This prevents
  // one session from stopping another's server or inheriting its overrides.
  const net = require('node:net');
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
  const session = fs.mkdtempSync(path.join(lib.runtime, 'session-'));
  const sharedBundle = fs.readFileSync(path.join(lib.runtime, 'cli.js'), 'utf8');
  // Only session metadata moves; credentials, plugin settings, and assets stay
  // shared. Atomic refresh locks in CCR coordinate concurrent token refreshes.
  const sessionConfig = { ...config, PORT: port, APIKEY: require('node:crypto').randomBytes(32).toString('hex') };
  lib.writeJson(path.join(session, 'config.json'), sessionConfig);
  const bundle = sessionBundle(sharedBundle, session);
  fs.writeFileSync(path.join(session, 'cli.js'), bundle);
  for (const asset of ['index.html', 'tiktoken_bg.wasm']) fs.symlinkSync(path.join(lib.runtime, asset), path.join(session, asset));
  env.CCR_CODEX_AUTH_FILE = path.join(lib.runtime, 'codex_auth.json');
  const router = spawn('bun', [path.join(session, 'cli.js'), 'start'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  let failure;
  router.once('error', error => { failure = error; });
  const abort = () => router.kill('SIGTERM');
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; ; attempt++) {
      if (failure) throw failure;
      if (router.exitCode !== null) throw new Error(`CCR exited during startup (${router.exitCode})`);
      try {
        const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${sessionConfig.APIKEY}` }, signal: AbortSignal.timeout(1000) });
        if (r.ok) break;
      } catch {}
      if (attempt >= 60) throw new Error('CCR startup timed out');
      await sleep(250);
    }
    return await action({ base, key: sessionConfig.APIKEY, active, env });
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    if (router.exitCode === null && !failure) {
      router.kill('SIGTERM');
      const stopped = new Promise(resolve => router.once('exit', resolve));
      await Promise.race([stopped, sleep(2000)]);
      if (router.exitCode === null) { router.kill('SIGKILL'); await stopped; }
    }
    fs.rmSync(session, { recursive: true, force: true });
  }
}
async function doctor(args) {
  const { overrides } = parseOverrides(args);
  return withRouter(overrides, async ({ base, key, active }) => {
    console.log(`Testing ${active.model} ${active.reasoningEffort} via Codex OAuth...`);
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'codex,gpt-6.1-sol', max_tokens: 1024, stream: false, output_config: { effort: active.reasoningEffort }, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
      signal: AbortSignal.timeout(130000)
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(`HTTP ${response.status}: ${result.error?.message || JSON.stringify(result)}`);
    const answer = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    console.log(`Returned model: ${result.model || '(not reported)'}\nAnswer: ${answer}`);
    if (answer.trim() !== 'ok') throw new Error('Unexpected test response');
    console.log('PASS');
    return 0;
  });
}
async function main(command, args) {
  if (command === 'settings') return require('./settings.cjs')(args);
  if (command === 'auth') {
    if (args[0] === 'status') {
      const auth = JSON.parse(fs.readFileSync(path.join(lib.runtime, 'codex_auth.json'), 'utf8'));
      console.log(`OAuth credentials: ${auth.access_token ? 'present' : 'missing'}\nAccess expires: ${auth.expires_at ? new Date(auth.expires_at * 1000).toISOString() : 'unknown'}\nRefresh token: ${auth.refresh_token ? 'present' : 'missing'}`);
      return;
    }
    if (args[0] !== 'login') throw new Error('Usage: claude-gpt-auth login|status');
    return withRouter({}, async ({ base }) => {
      // This fork expects OAuth callbacks on its server, while the registered
      // redirect URI uses port 1455. Forward only that callback to our session.
      const http = require('node:http');
      const callback = http.createServer(async (request, response) => {
        if (request.method !== 'GET' || !request.url.startsWith('/auth/callback?')) {
          response.writeHead(404).end();
          return;
        }
        try {
          const upstream = await fetch(`${base}${request.url}`, { signal: AbortSignal.timeout(30000) });
          response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'text/html', 'Cache-Control': 'no-store' });
          response.end(await upstream.text());
        } catch { response.writeHead(502).end('OAuth callback failed. Retry login.'); }
      });
      await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(1455, '127.0.0.1', resolve); });
      try {
        return await spawnClient('bun', [path.join(lib.runtime, 'cli.js'), 'codex-auth']);
      } finally { await new Promise(resolve => callback.close(resolve)); }
    });
  }
  if (command === 'doctor') return doctor(args);
  if (command !== 'launch') throw new Error(`Unknown bridge command: ${command}`);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('claude-gpt [--model GPT-ID] [--effort low|medium|high|xhigh|max] [Claude Code arguments]\nModel/effort flags override saved settings for this session.\nUse claude-gpt-settings help for saved settings and model discovery.');
    return;
  }
  const { overrides, rest } = parseOverrides(args);
  return withRouter(overrides, async ({ base, key, active, env }) => {
    console.error(`${active.model} ${active.reasoningEffort} via Codex OAuth`);
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_AUTH_TOKEN = key;
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) env[key] = 'codex,gpt-6.1-sol';
    return spawnClient('claude', ['--model', 'codex,gpt-6.1-sol', '--effort', active.reasoningEffort, ...rest], { env });
  });
}
if (require.main === module) main(process.argv[2], process.argv.slice(3)).then(code => { process.exitCode = code || 0; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parseOverrides, withRouter, sessionBundle };
