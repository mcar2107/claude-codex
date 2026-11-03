const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const runtime = path.join(__dirname, '.runtime');
const dist = path.join(__dirname, 'node_modules/@caeliq/claude-code-router/dist');

fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
/**
 * Форк жёстко задаёт каталог state. Переносим только его — в одноразовом бандле; установленный
 * пакет и настоящий домашний каталог не трогаем.
 */
let bundle = fs.readFileSync(path.join(dist, 'cli.js'), 'utf8');
let replacements = 0;

bundle = bundle.replace(
  /(?:[\w$]+\.default\.homedir\(\)|\(0,[\w$]+\.homedir\)\(\)),"\.claude-code-router"/g,
  () => {
    replacements++;

    return JSON.stringify(runtime);
  }
);
if (replacements < 2) throw new Error('Unexpected bundle layout: cannot isolate state');
fs.writeFileSync(path.join(runtime, 'cli.js'), bundle);

for (const asset of ['index.html', 'tiktoken_bg.wasm']) {
  fs.copyFileSync(path.join(dist, asset), path.join(runtime, asset));
}

const configPath = path.join(runtime, 'config.json');

if (!fs.existsSync(configPath)) {
  const route = 'codex,gpt-6.1-sol';
  const config = {
    HOST: '127.0.0.1',
    PORT: 3457,
    APIKEY: crypto.randomBytes(32).toString('hex'),
    LOG: false,
    LOG_LEVEL: 'warn',
    HEARTBEAT_INTERVAL_MS: 0,
    API_TIMEOUT_MS: 120000,
    Providers: [
      {
        name: 'codex',
        api_base_url: 'https://chatgpt.com/backend-api/codex',
        models_api_url: 'https://chatgpt.com/backend-api/codex/models',
        api_key: 'oauth_dummy_key',
        models: ['gpt-6.1-sol'],
        transformer: { use: ['openai-responses', 'codex'] },
      },
    ],
    Router: { default: route, background: route, think: route, longContext: route },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

const authPath = path.join(runtime, 'codex_auth.json');

if (!fs.existsSync(authPath)) {
  const old = JSON.parse(
    fs.readFileSync(
      path.join(os.homedir(), '.claude-code-router/codex-auth.json'),
      'utf8'
    )
  );

  if (!old.access || !old.refresh) throw new Error('Bridge OAuth credentials missing');
  const auth = {
    access_token: old.access,
    refresh_token: old.refresh,
    account_id: old.accountId,
    expires_at: Math.floor(old.expires / 1000),
    token_type: 'Bearer',
  };

  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
}

console.log(
  `Prepared isolated CCR (${replacements} state paths), port 3457, gpt-6.1-sol.`
);
