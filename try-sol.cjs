const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runtime = path.join(__dirname, '.runtime');
const config = JSON.parse(fs.readFileSync(path.join(runtime, 'config.json'), 'utf8'));
const base = `http://${config.HOST}:${config.PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mode = process.argv[2] || 'test';
if (!['test', 'code', 'server', 'models'].includes(mode)) {
  console.error('Usage: node try-sol.cjs [test|code|server|models]');
  process.exit(1);
}
const router = spawn('bun', [path.join(runtime, 'cli.js'), 'start'], {
  stdio: ['ignore', 'inherit', 'inherit'], env: process.env
});
let startupError;
router.on('error', e => { startupError = e; });
let client;
function cleanup() {
  if (router.exitCode === null && !router.killed) router.kill('SIGTERM');
}
process.on('SIGINT', () => { client?.kill('SIGINT'); cleanup(); process.exit(130); });
process.on('SIGTERM', () => { client?.kill('SIGTERM'); cleanup(); process.exit(143); });

async function main() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startupError) throw startupError;
    if (router.exitCode !== null) throw new Error(`CCR exited during startup (${router.exitCode}). Check port ${config.PORT} and local permissions.`);
    try {
      const response = await fetch(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${config.APIKEY}` },
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) break;
    } catch {}
    if (attempt === 59) throw new Error('CCR did not become ready within 15 seconds');
    await sleep(250);
  }
  console.log('CCR ready on 127.0.0.1:3457. Model: gpt-6.1-sol; effort: xhigh.');
  if (mode === 'server') {
    await new Promise(resolve => router.once('exit', resolve));
    return;
  }
  if (mode === 'models') {
    client = spawn('bun', [path.join(runtime, 'cli.js'), 'model', 'get', 'codex'], { stdio: 'inherit' });
    process.exitCode = await new Promise(resolve => client.once('exit', resolve));
    return;
  }
  if (mode === 'code') {
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: config.APIKEY,
      ANTHROPIC_MODEL: 'codex,gpt-6.1-sol',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'codex,gpt-6.1-sol',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'codex,gpt-6.1-sol',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'codex,gpt-6.1-sol'
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[name];
    client = spawn('claude', ['--model', 'codex,gpt-6.1-sol', '--effort', 'xhigh', ...process.argv.slice(3)], { env, stdio: 'inherit' });
    client.on('error', e => console.error(e.message));
    process.exitCode = await new Promise(resolve => client.once('exit', resolve));
    return;
  }
  console.log('Sending a real request through the Anthropic Messages route...');
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': config.APIKEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'codex,gpt-6.1-sol', max_tokens: 1024, stream: false,
      output_config: { effort: 'xhigh' },
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }]
    }),
    signal: AbortSignal.timeout(130000)
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    const message = result.error?.message || JSON.stringify(result);
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  const answer = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('');
  console.log(`Returned model: ${result.model || '(not reported)'}`);
  console.log(`Answer: ${answer}`);
  if (answer.trim() !== 'ok') throw new Error('Response did not match the smoke test');
  console.log('PASS: Sol answered through CCR with requested effort xhigh.');
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(cleanup);
