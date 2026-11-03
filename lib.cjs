const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const runtime = process.env.CLAUDE_GPT_STATE_DIR || path.join(root, '.runtime');
const settingsFile = path.join(runtime, 'settings.json');
const configFile = path.join(runtime, 'config.json');
const defaults = { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' };
const models = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2'];
function effortsFor(model) {
  // Match the Codex transport's catalog, rather than promising API-only levels
  // which this version of CCR would silently clamp before sending upstream.
  if (/^gpt-(6|5\.6)(?:[.-]|$)/.test(model)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (model === 'gpt-5.5') return ['low', 'medium', 'high', 'xhigh'];
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
}
function validate(value) {
  const model = String(value.model || '').replace(/^codex,/, '');
  if (!/^gpt-[a-z0-9][a-z0-9.-]*$/.test(model)) throw new Error('Expected a GPT model ID, such as gpt-6.1-sol');
  if (!effortsFor(model).includes(value.reasoningEffort)) {
    throw new Error(`${model}: supported effort levels in this bridge: ${effortsFor(model).join(', ')}`);
  }
  return { model, reasoningEffort: value.reasoningEffort };
}
function readSettings() {
  return validate(fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : defaults);
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function saveSettings(settings) { writeJson(settingsFile, validate(settings)); }
function configure() {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.Providers[0].models = [...new Set([...models, ...config.Providers[0].models])];
  config.Providers[0].models_api_url = 'https://chatgpt.com/backend-api/codex/models';
  config.transformers = [{ path: path.join(root, 'live-settings.cjs') }];
  config.Providers[0].transformer.use = ['local-codex-settings', 'openai-responses', 'codex'];
  writeJson(configFile, config);
  if (!fs.existsSync(settingsFile)) saveSettings(defaults);
}
module.exports = { root, runtime, settingsFile, configFile, defaults, models, effortsFor, validate, readSettings, saveSettings, writeJson, configure };
