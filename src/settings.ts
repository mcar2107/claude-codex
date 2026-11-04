import { parseOverrides } from './session';
import * as state from './state';
import type { ModelsCache, Settings } from './state.types';

/**
 * `Map`, а не объект: имя пресета приходит из аргументов, и `constructor` или `toString` не должны
 * находить свойства прототипа.
 */
const PRESETS = new Map<string, Settings>([
  ['sol', state.DEFAULT_SETTINGS],
  ['balanced', { model: state.DEFAULT_SETTINGS.model, reasoningEffort: 'medium' }],
  ['fast', { model: 'gpt-6-luna', reasoningEffort: 'low' }],
  ['max', { model: 'gpt-6-astra', reasoningEffort: 'max' }],
]);

const SETTINGS_USAGE = 'Usage: claude-codex settings show|set|reset|preset';

const show = () => {
  const { model, reasoningEffort } = state.readSettings();

  console.log(
    `model=${model}\nreasoningEffort=${reasoningEffort}\nsettingsFile=${state.SETTINGS_FILE}`
  );
};

/**
 * Элементы ответа discovery: у одних версий API ID в `slug`, у других — в `id`. Окно контекста
 * берётся, только если Codex его сообщил: своих оценок окна мост не делает.
 */
const discoveryCache = (items: unknown[]) => {
  return items.reduce<Omit<ModelsCache, 'refreshedAt'>>(
    (cache, item) => {
      if (typeof item !== 'object' || item === null) {
        return cache;
      }

      const id: unknown = Reflect.get(item, 'slug') || Reflect.get(item, 'id');

      if (!state.isModelId(id) || cache.models.includes(id)) {
        return cache;
      }

      cache.models.push(id);
      const size: unknown =
        Reflect.get(item, 'context_window') || Reflect.get(item, 'max_context_window');

      if (typeof size === 'number' && Number.isInteger(size) && size > 0) {
        cache.contextWindows[id] = size;
      }

      return cache;
    },
    { models: [], contextWindows: {} }
  );
};

/**
 * Новые настройки команды; `undefined` — команда только показывает текущие.
 */
const nextSettings = (command: string, rest: string[]): Settings | undefined => {
  switch (command) {
    case 'show':

    case 'status': {
      if (rest.length) {
        throw new Error(SETTINGS_USAGE);
      }

      return undefined;
    }

    case 'set': {
      const parsed = parseOverrides(rest);

      if (parsed.rest.length || !Object.keys(parsed.overrides).length) {
        throw new Error('Usage: claude-codex settings set --model GPT-ID --effort LEVEL');
      }

      return { ...state.readSettings(), ...parsed.overrides };
    }

    case 'reset': {
      if (rest.length) {
        throw new Error(SETTINGS_USAGE);
      }

      return state.DEFAULT_SETTINGS;
    }

    case 'preset': {
      const preset = rest.length === 1 ? PRESETS.get(rest[0]) : undefined;

      if (!preset) {
        throw new Error(`Unknown preset. Choose ${[...PRESETS.keys()].join('|')}`);
      }

      return preset;
    }

    default: {
      throw new Error(SETTINGS_USAGE);
    }
  }
};

export const settings = (args: string[]) => {
  const [command = 'show', ...rest] = args;
  const next = nextSettings(command, rest);

  if (!next) {
    return show();
  }

  state.saveSettings(next);
  show();
  console.log(
    'Saved as the default for new sessions. Open sessions keep their starting model and effort; switch them with /model and /effort.'
  );
};

/**
 * Список моделей из ответа discovery: у одних версий API он в `models`, у других — в `data`.
 */
const discoveryItems = (data: unknown): unknown[] | undefined => {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const models: unknown = Reflect.get(data, 'models');
  const items: unknown = Array.isArray(models) ? models : Reflect.get(data, 'data');

  return Array.isArray(items) ? items : undefined;
};

export const models = async (args: string[]) => {
  if (args.length && (args.length !== 1 || args[0] !== 'refresh')) {
    throw new Error('Usage: claude-codex models [refresh]');
  }

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

    if (tokens.account_id) {
      headers['ChatGPT-Account-Id'] = tokens.account_id;
    }

    const response = await fetch(
      `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,
      { headers, signal: AbortSignal.timeout(30000) }
    );

    if (!response.ok) {
      throw new Error(
        `Model discovery failed (HTTP ${response.status}); saved settings and discovery cache preserved`
      );
    }

    let data: unknown;

    try {
      data = await response.json();
    } catch {
      data = undefined;
    }

    const items = discoveryItems(data);

    if (!items) {
      throw new Error(
        'Unexpected model discovery response; saved settings and cache preserved'
      );
    }

    const discovered = discoveryCache(items);

    /**
     * Пустой список — скорее сбой discovery, чем аккаунт без моделей: прежний кэш полезнее.
     */
    if (!discovered.models.length) {
      throw new Error(
        'Model discovery returned no models; saved settings and cache preserved'
      );
    }

    state.writeJson(state.MODELS_CACHE_FILE, {
      refreshedAt: new Date().toISOString(),
      ...discovered,
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

  for (const model of [...new Set([...state.MODELS, state.readSettings().model])]) {
    console.log(`${model}: ${state.effortsFor(model).join(', ')}`);
  }
};
