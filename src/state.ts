import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AuthFile,
  ModelsCache,
  Settings,
  SettingsInput,
  SettingsOverrides,
  WriteJsonOptions,
} from './state.types';

export const runtime = path.resolve(
  process.env.CLAUDE_CODEX_STATE_DIR || path.join(os.homedir(), '.claude-codex')
);
export const settingsFile = path.join(runtime, 'settings.json');
export const authFile = path.join(runtime, 'codex_auth.json');
export const defaults: Settings = { model: 'gpt-6.1-sol', reasoningEffort: 'high' };
export const models = [
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

export const modelsCacheFile = path.join(runtime, 'models.json');

/**
 * Уровни effort по возрастанию: по этому порядку неподдерживаемый уровень понижается.
 */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_ID = /^gpt-[a-z0-9][a-z0-9.-]*$/;

/**
 * Префикс провайдера в ID модели клиента: `codex,gpt-6.1-sol`.
 */
export const CLIENT_PREFIX = 'codex,';

export const isModelId = (value: unknown): value is string => {
  return typeof value === 'string' && MODEL_ID.test(value);
};

export const effortsFor = (model: string): string[] => {
  if (/^gpt-(6|5\.6)(?:[.-]|$)/.test(model))
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (model === 'gpt-5.5') return ['low', 'medium', 'high', 'xhigh'];

  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
};

/**
 * Уровень из запроса клиента, приведённый к модели: неподдерживаемый понижается до ближайшего
 * поддерживаемого — так же Claude Code поступает со своими моделями. `undefined` — уровень
 * неизвестен или ниже всех допустимых.
 */
export const fitEffort = (model: string, effort: unknown): string | undefined => {
  const supported = effortsFor(model);
  const rank = typeof effort === 'string' ? EFFORT_ORDER.indexOf(effort) : -1;

  if (rank < 0) return undefined;

  return EFFORT_ORDER.slice(0, rank + 1)
    .reverse()
    .find((level) => {
      return supported.includes(level);
    });
};

/**
 * Каталог конфигурации Claude Code: `CLAUDE_CONFIG_DIR` или `~/.claude` — так же его ищет сам
 * клиент.
 */
export const claudeConfigDir = () => {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const validate = (value: SettingsInput): Settings => {
  const raw = String(value.model || '');
  const model = raw.startsWith(CLIENT_PREFIX) ? raw.slice(CLIENT_PREFIX.length) : raw;
  const { reasoningEffort } = value;

  if (!isModelId(model)) throw new Error('Expected a GPT model ID, such as gpt-6.1-sol');
  if (typeof reasoningEffort !== 'string' || !effortsFor(model).includes(reasoningEffort))
    throw new Error(`${model}: supported effort levels: ${effortsFor(model).join(', ')}`);

  return { model, reasoningEffort };
};

export const ensureState = () => {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
};

/**
 * Атомарная запись JSON: временный файл рядом с целью и `rename`. Путь-симлинк (dotfiles через
 * stow или chezmoi) разрешается до записи: `rename` поверх самого симлинка отвязал бы файл от
 * его цели.
 */
export const writeJson = (
  file: string,
  data: unknown,
  { mode = 0o600 }: WriteJsonOptions = {}
) => {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;

  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {
      mode,
      flag: 'wx',
    });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

/**
 * JSON-объект из файла state; битый файл — ошибка с путём и подсказкой, а не голый `SyntaxError`.
 */
const readStateObject = (file: string, hint: string): Record<string, unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${hint}`, { cause: error });
  }

  if (!isRecord(parsed)) throw new Error(`Cannot read ${file}: ${hint}`);

  return parsed;
};

export const readSettings = (): Settings => {
  return validate(
    fs.existsSync(settingsFile)
      ? readStateObject(
          settingsFile,
          'expected a JSON object; fix it or run: claude-codex settings reset'
        )
      : defaults
  );
};

export const saveSettings = (value: SettingsInput) => {
  writeJson(settingsFile, validate(value));
};

export const activeSettings = (
  overrides: SettingsOverrides = {},
  env: NodeJS.ProcessEnv = process.env
): Settings => {
  return validate({
    ...readSettings(),
    ...(env.CLAUDE_CODEX_MODEL ? { model: env.CLAUDE_CODEX_MODEL } : {}),
    ...(env.CLAUDE_CODEX_EFFORT ? { reasoningEffort: env.CLAUDE_CODEX_EFFORT } : {}),
    ...overrides,
  });
};

/**
 * Кэш discovery необязателен: битый или чужой файл значит «кэша нет», а не ошибку запуска.
 */
export const readModelsCache = (): ModelsCache => {
  try {
    const cache = JSON.parse(fs.readFileSync(modelsCacheFile, 'utf8'));
    const discovered: unknown[] = Array.isArray(cache.models) ? cache.models : [];
    const windows: [string, unknown][] =
      typeof cache.contextWindows === 'object' && cache.contextWindows !== null
        ? Object.entries(cache.contextWindows)
        : [];

    return {
      refreshedAt: typeof cache.refreshedAt === 'string' ? cache.refreshedAt : '',
      models: discovered.filter(isModelId),
      contextWindows: windows.reduce<Record<string, number>>((result, [id, size]) => {
        if (
          isModelId(id) &&
          typeof size === 'number' &&
          Number.isInteger(size) &&
          size > 0
        )
          result[id] = size;

        return result;
      }, {}),
    };
  } catch {
    return { refreshedAt: '', models: [], contextWindows: {} };
  }
};

export const requireAuth = (): AuthFile => {
  if (!fs.existsSync(authFile))
    throw new Error('Not authenticated. Run: claude-codex auth login');
  const auth = readStateObject(authFile, 'run: claude-codex auth login');
  const { access_token: accessToken } = auth;

  if (typeof accessToken !== 'string' || !accessToken)
    throw new Error('OAuth access token missing. Run: claude-codex auth login');

  /**
   * Обязательное поле проверено выше; остальные необязательны и читаются с проверкой типа.
   */
  return { ...auth, access_token: accessToken };
};
