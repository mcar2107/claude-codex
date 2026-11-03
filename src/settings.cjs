const fs = require('node:fs');
const path = require('node:path');
const state = require('./state.cjs');
const { parseOverrides } = require('./session.cjs');
function show() {
  const settings = state.readSettings();
  console.log(`model=${settings.model}\nreasoningEffort=${settings.reasoningEffort}\nsettingsFile=${state.settingsFile}`);
}
function settings(args) {
  const [command = 'show', ...rest] = args;
  if (['show', 'status'].includes(command) && !rest.length) return show();
  let next;
  if (command === 'set') {
    const parsed = parseOverrides(rest);
    if (parsed.rest.length || !Object.keys(parsed.overrides).length) throw new Error('Usage: claude-codex settings set --model GPT-ID --effort LEVEL');
    next = { ...state.readSettings(), ...parsed.overrides };
  } else if (command === 'reset' && !rest.length) next = state.defaults;
  else if (command === 'preset' && rest.length === 1) {
    const presets = { sol: state.defaults, balanced: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, fast: { model: 'gpt-6-luna', reasoningEffort: 'low' }, max: { model: 'gpt-6-astra', reasoningEffort: 'max' } };
    next = presets[rest[0]];
    if (!next) throw new Error('Unknown preset. Choose sol|balanced|fast|max');
  } else throw new Error('Usage: claude-codex settings show|set|reset|preset');
  state.saveSettings(next);
  show();
  console.log('Applies on the next request, including open sessions. Session overrides take precedence.');
}
async function models(args) {
  const cache = path.join(state.runtime, 'models.json');
  if (args.length && (args.length !== 1 || args[0] !== 'refresh')) throw new Error('Usage: claude-codex models [refresh]');
  if (args[0] === 'refresh') {
    const tokens = await require('./auth.cjs').validTokens();
    const version = require('../vendor/ccr/shared/src/codex-auth.ts').CODEX_CLI_VERSION;
    const headers = { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': `codex_cli_rs/${version}`, originator: 'codex_cli_rs', client_version: version };
    if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
    const response = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status}); saved settings and discovery cache preserved`);
    const data = await response.json();
    const items = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : null;
    if (!items) throw new Error('Unexpected model discovery response; saved settings and cache preserved');
    const ids = [...new Set(items.map(item => item.slug || item.id).filter(id => typeof id === 'string' && /^gpt-[a-z0-9][a-z0-9.-]*$/.test(id)))];
    state.writeJson(cache, { refreshedAt: new Date().toISOString(), models: ids });
  }
  if (fs.existsSync(cache)) {
    const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
    console.log(`Discovered for this OAuth account (${cached.refreshedAt}; requests remain the definitive access check):`);
    for (const model of cached.models) console.log(model);
  }
  console.log('Configured candidates (not a promise of account access):');
  for (const model of [...new Set([...state.models, state.readSettings().model])]) console.log(`${model}: ${state.effortsFor(model).join(', ')}`);
}
module.exports = { settings, models };
