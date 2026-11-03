const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
/**
 * Старые переменные окружения поддерживаются, но .runtime проекта неявно не выбирается никогда.
 */
const runtime = path.resolve(
  process.env.CLAUDE_CODEX_STATE_DIR ||
    process.env.CLAUDE_GPT_STATE_DIR ||
    path.join(os.homedir(), '.claude-codex')
);
const settingsFile = path.join(runtime, 'settings.json');
const authFile = path.join(runtime, 'codex_auth.json');
const defaults = { model: 'gpt-6.1-sol', reasoningEffort: 'high' };
const models = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
];

function effortsFor(model) {
  if (/^gpt-(6|5\.6)(?:[.-]|$)/.test(model))
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (model === 'gpt-5.5') return ['low', 'medium', 'high', 'xhigh'];

  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
}

function validate(value) {
  const model = String(value.model || '').replace(/^codex,/, '');

  if (!/^gpt-[a-z0-9][a-z0-9.-]*$/.test(model))
    throw new Error('Expected a GPT model ID, such as gpt-6.1-sol');
  if (!effortsFor(model).includes(value.reasoningEffort))
    throw new Error(`${model}: supported effort levels: ${effortsFor(model).join(', ')}`);

  return { model, reasoningEffort: value.reasoningEffort };
}

function ensureState() {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;

  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readSettings() {
  return validate(
    fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      : defaults
  );
}

function saveSettings(value) {
  writeJson(settingsFile, validate(value));
}

function activeSettings(overrides = {}, env = process.env) {
  return validate({
    ...readSettings(),
    ...(env.CLAUDE_GPT_MODEL ? { model: env.CLAUDE_GPT_MODEL } : {}),
    ...(env.CLAUDE_GPT_EFFORT ? { reasoningEffort: env.CLAUDE_GPT_EFFORT } : {}),
    ...overrides,
  });
}

function requireAuth() {
  let auth;

  try {
    auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error('Not authenticated. Run: claude-codex auth login', {
        cause: error,
      });
    throw new Error('Cannot read OAuth credentials; run: claude-codex auth login', {
      cause: error,
    });
  }

  if (typeof auth.access_token !== 'string' || !auth.access_token)
    throw new Error('OAuth access token missing. Run: claude-codex auth login');

  return auth;
}

module.exports = {
  runtime,
  settingsFile,
  authFile,
  defaults,
  models,
  effortsFor,
  validate,
  ensureState,
  writeJson,
  readSettings,
  saveSettings,
  activeSettings,
  requireAuth,
};
