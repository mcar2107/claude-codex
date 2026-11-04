import { parseOverrides } from './session';
import * as state from './state';
import type { ModelsCache, Settings } from './state.types';

const PRESETS: Record<string, Settings> = {
  sol: state.defaults,
  balanced: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
  fast: { model: 'gpt-6-luna', reasoningEffort: 'low' },
  max: { model: 'gpt-6-astra', reasoningEffort: 'max' },
};

const show = () => {
  const { model, reasoningEffort } = state.readSettings();

  console.log(
    `model=${model}\nreasoningEffort=${reasoningEffort}\nsettingsFile=${state.settingsFile}`
  );
};

/**
 * Элементы ответа discovery: у одних версий API ID в `slug`, у других — в `id`. Окно контекста
 * берётся, только если Codex его сообщил: своих оценок окна мост не делает.
 */
const discoveryCache = (items: unknown[]) => {
  return items.reduce<Omit<ModelsCache, 'refreshedAt'>>(
    (cache, item) => {
      if (typeof item !== 'object' || item === null) return cache;
      const id = Reflect.get(item, 'slug') || Reflect.get(item, 'id');

      if (!state.isModelId(id) || cache.models.includes(id)) return cache;
      cache.models.push(id);
      const size =
        Reflect.get(item, 'context_window') || Reflect.get(item, 'max_context_window');

      if (Number.isInteger(size) && size > 0) cache.contextWindows[id] = size;

      return cache;
    },
    { models: [], contextWindows: {} }
  );
};

export const settings = (args: string[]) => {
  const [command = 'show', ...rest] = args;

  if (['show', 'status'].includes(command) && !rest.length) return show();
  let next: Settings | undefined;

  if (command === 'set') {
    const parsed = parseOverrides(rest);

    if (parsed.rest.length || !Object.keys(parsed.overrides).length)
      throw new Error('Usage: claude-codex settings set --model GPT-ID --effort LEVEL');
    next = { ...state.readSettings(), ...parsed.overrides };
  } else if (command === 'reset' && !rest.length) next = state.defaults;
  else if (command === 'preset' && rest.length === 1) {
    next = PRESETS[rest[0]];
    if (!next) throw new Error('Unknown preset. Choose sol|balanced|fast|max');
  } else throw new Error('Usage: claude-codex settings show|set|reset|preset');
  state.saveSettings(next);
  show();
  console.log(
    'Applies on the next request, including open sessions. Session overrides take precedence.'
  );
};

export const models = async (args: string[]) => {
  if (args.length && (args.length !== 1 || args[0] !== 'refresh'))
    throw new Error('Usage: claude-codex models [refresh]');

  if (args[0] === 'refresh') {
    const { validTokens } = await import('./auth');
    const { CODEX_CLI_VERSION: version } =
      await import('../vendor/ccr/shared/src/codex-auth');
    const tokens = await validTokens();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.access_token}`,
      'User-Agent': `codex_cli_rs/${version}`,
      originator: 'codex_cli_rs',
      client_version: version,
    };

    if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
    const response = await fetch(
      `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,
      { headers, signal: AbortSignal.timeout(30000) }
    );

    if (!response.ok)
      throw new Error(
        `Model discovery failed (HTTP ${response.status}); saved settings and discovery cache preserved`
      );
    const data = await response.json();
    const items = Array.isArray(data.models)
      ? data.models
      : Array.isArray(data.data)
        ? data.data
        : null;

    if (!items)
      throw new Error(
        'Unexpected model discovery response; saved settings and cache preserved'
      );

    state.writeJson(state.modelsCacheFile, {
      refreshedAt: new Date().toISOString(),
      ...discoveryCache(items),
    });
  }

  const cached = state.readModelsCache();

  if (cached.refreshedAt) {
    console.log(
      `Discovered for this OAuth account (${cached.refreshedAt}; requests remain the definitive access check):`
    );

    for (const model of cached.models) {
      const size = cached.contextWindows[model];

      console.log(size ? `${model} (context ${size})` : model);
    }
  }

  console.log('Configured candidates (not a promise of account access):');
  for (const model of [...new Set([...state.models, state.readSettings().model])])
    console.log(`${model}: ${state.effortsFor(model).join(', ')}`);
};
