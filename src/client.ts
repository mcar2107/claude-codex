import fs from 'node:fs';
import path from 'node:path';

import packageJson from '../package.json' with { type: 'json' };

import type {
  ClaudeSettings,
  ExtractedSettings,
  PrepareClientOptions,
  StatusLine,
  UserModelSnapshot,
} from './client.types';
import { selfCommand } from './session';
import * as state from './state';

/**
 * Уровни, которые принимает `--effort` Claude Code. Остальные (`none`, `minimal`) клиенту не
 * передаются: их подставляет роутер, когда клиент уровня не прислал.
 */
const CLIENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Оригинальная команда statusLine для обёртки — в каталоге сессии.
 */
export const STATUS_LINE_FILE = 'statusline.json';

const PLUGIN_COMMANDS = {
  settings: {
    description: 'Show or change claude-codex defaults for new sessions',
    hint: 'show | set --model GPT-ID --effort LEVEL | preset sol|balanced|fast|max | reset',
    command: 'claude-codex settings $ARGUMENTS',
  },
  models: {
    description: 'List Codex model candidates, or refresh account discovery',
    hint: '[refresh]',
    command: 'claude-codex models $ARGUMENTS',
  },
};

const SETTINGS_PREFIX = '--settings=';

const shellQuote = (value: string) => {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
};

const isRecord = (value: unknown): value is ClaudeSettings => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Отсутствующий или битый файл настроек — `undefined`: такой файл не читает и Claude Code.
 */
const readSettingsFile = (file: string): ClaudeSettings | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `--settings` пользователя забирается из аргументов: мост передаёт клиенту один флаг, в котором
 * настройки пользователя объединены со своими.
 */
export const extractSettings = (args: string[]): ExtractedSettings => {
  const rest: string[] = [];
  let value: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--settings') {
      value = args[++i];
      if (value === undefined) throw new Error('Missing value for --settings');
    } else if (arg.startsWith(SETTINGS_PREFIX)) value = arg.slice(SETTINGS_PREFIX.length);
    else rest.push(arg);
  }

  if (value === undefined) return { settings: undefined, rest };
  let parsed: unknown;

  try {
    parsed = JSON.parse(
      value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8')
    );
  } catch (error) {
    throw new Error('Cannot read --settings: expected a JSON object or a JSON file', {
      cause: error,
    });
  }

  if (!isRecord(parsed))
    throw new Error('Cannot read --settings: expected a JSON object or a JSON file');

  return { settings: parsed, rest };
};

/**
 * Действующая команда statusLine — в порядке приоритета Claude Code: `--settings`, local,
 * project, user. Managed-настройки не смотрим: их statusLine всё равно перекроет флаг моста.
 */
export const resolveStatusLine = (
  flagSettings: ClaudeSettings | undefined,
  cwd: string,
  configDir: string
): StatusLine | undefined => {
  const sources = [
    flagSettings,
    readSettingsFile(path.join(cwd, '.claude', 'settings.local.json')),
    readSettingsFile(path.join(cwd, '.claude', 'settings.json')),
    readSettingsFile(path.join(configDir, 'settings.json')),
  ];
  const statusLine = sources.find((source) => {
    return source && 'statusLine' in source;
  })?.statusLine;

  if (
    !isRecord(statusLine) ||
    statusLine.type !== 'command' ||
    typeof statusLine.command !== 'string' ||
    !statusLine.command.trim()
  )
    return undefined;

  return statusLine;
};

/**
 * Подпись строки `/model`: `gpt-6.1-sol` → `GPT-6.1 Sol`.
 */
export const modelLabel = (model: string) => {
  const [, version, ...words] = model.split('-');

  return [
    `GPT-${version}`,
    ...words.map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }),
  ].join(' ');
};

/**
 * Строки `/model`: только модели Codex. Встроенные модели Claude скрыты — через мост они бы
 * ушли в Codex под чужим именем.
 */
const modelPicker = (active: string) => {
  const candidates = [
    ...new Set([active, ...state.models, ...state.readModelsCache().models]),
  ];

  return {
    replaceBuiltInOptions: true,
    options: candidates.map((model) => {
      return {
        model: state.CLIENT_PREFIX + model,
        label: modelLabel(model),
        description: `Codex · effort ${state.effortsFor(model).join('/')}`,
      };
    }),
  };
};

const writePlugin = (directory: string) => {
  state.writeJson(path.join(directory, '.claude-plugin', 'plugin.json'), {
    name: 'codex',
    description: 'claude-codex defaults and model discovery for this session',
    version: packageJson.version,
  });
  fs.mkdirSync(path.join(directory, 'commands'), { recursive: true, mode: 0o700 });

  for (const [name, { description, hint, command }] of Object.entries(PLUGIN_COMMANDS))
    fs.writeFileSync(
      path.join(directory, 'commands', `${name}.md`),
      `---\ndescription: ${description}\nargument-hint: ${hint}\nallowed-tools: Bash(claude-codex:*)\n---\nRun this command with Bash and show its result:\n\n\`\`\`sh\n${command}\n\`\`\`\n\nSaved settings are defaults for new claude-codex sessions; switch this session with /model and /effort. Never read or print OAuth files.\n`,
      { mode: 0o600 }
    );
};

/**
 * `claude-codex` в PATH клиента: команды плагина работают, даже если мост запущен не из PATH.
 */
const writeShim = (directory: string) => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, 'claude-codex'),
    `#!/bin/sh\nexec ${selfCommand([]).map(shellQuote).join(' ')} "$@"\n`,
    { mode: 0o700 }
  );
};

/**
 * Готовит клиента к сессии: плагин с командами, `claude-codex` в PATH, модели Codex в `/model`,
 * обёртку statusline и окружение. Всё пишется в каталог сессии; настройки Claude Code
 * пользователя не меняются.
 */
export const prepareClient = ({
  session,
  active,
  clientArgs,
  env,
  cwd = process.cwd(),
}: PrepareClientOptions) => {
  const { settings: flagSettings, rest } = extractSettings(clientArgs);
  const settings: ClaudeSettings = {
    ...flagSettings,
    modelPicker: flagSettings?.modelPicker || modelPicker(active.model),
  };
  const statusLine = resolveStatusLine(flagSettings, cwd, state.claudeConfigDir());

  if (statusLine) {
    state.writeJson(path.join(session, STATUS_LINE_FILE), statusLine);
    settings.statusLine = {
      ...statusLine,
      command: selfCommand(['__statusline', session]).map(shellQuote).join(' '),
    };
  }

  const settingsFile = path.join(session, 'client-settings.json');
  const plugin = path.join(session, 'plugin');
  const bin = path.join(session, 'bin');
  const model = state.CLIENT_PREFIX + active.model;

  state.writeJson(settingsFile, settings);
  writePlugin(plugin);
  writeShim(bin);
  env.PATH = env.PATH ? `${bin}${path.delimiter}${env.PATH}` : bin;
  /**
   * Стартовую модель задаёт `--model`. С `ANTHROPIC_MODEL` Claude Code после `/model` пишет, что
   * переменная перекрывает выбор, и модель в диалоге принимает это за отмену переключения.
   */
  delete env.ANTHROPIC_MODEL;
  for (const name of [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
  ])
    env[name] = model;
  /**
   * Окно контекста — только известное из discovery: без него Claude Code считает 200k.
   */
  const contextWindow = state.readModelsCache().contextWindows[active.model];

  if (contextWindow && !env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  const args = ['--model', model, '--settings', settingsFile, '--plugin-dir', plugin];

  /**
   * Уровень, который Claude Code не принимает (`none`, `minimal`): клиент не шлёт effort, и
   * роутер подставляет сохранённый.
   */
  const isClientEffort = CLIENT_EFFORTS.includes(active.reasoningEffort);

  if (isClientEffort) args.push('--effort', active.reasoningEffort);
  else if (!env.CLAUDE_CODE_EFFORT_LEVEL) env.CLAUDE_CODE_EFFORT_LEVEL = 'unset';

  return [...args, ...rest];
};

export const snapshotUserModel = (
  file = path.join(state.claudeConfigDir(), 'settings.json')
): UserModelSnapshot | undefined => {
  if (!fs.existsSync(file)) return { file, hasModel: false };
  const settings = readSettingsFile(file);

  if (!settings) return undefined;

  return 'model' in settings
    ? { file, hasModel: true, model: settings.model }
    : { file, hasModel: false };
};

export const isClientModel = (value: unknown): value is string => {
  return typeof value === 'string' && value.startsWith(state.CLIENT_PREFIX);
};

/**
 * `/model` с Enter сохраняет выбор в пользовательские настройки Claude Code, и обычный `claude`
 * начал бы с модели Codex. Возвращается только такая правка: модель Codex, которой не было при
 * запуске. Остальные изменения файла — чужие и не трогаются. Возвращает сообщение о
 * восстановлении или `undefined`.
 */
export const restoreUserModel = (snapshot: UserModelSnapshot | undefined) => {
  if (!snapshot) return undefined;
  const current = readSettingsFile(snapshot.file);

  if (!current || !isClientModel(current.model) || current.model === snapshot.model)
    return undefined;
  const replaced = current.model;
  const next = { ...current };

  if (snapshot.hasModel) next.model = snapshot.model;
  else delete next.model;
  /**
   * Права файла пользователя сохраняются; симлинк на dotfiles остаётся симлинком (`writeJson`).
   */
  state.writeJson(snapshot.file, next, { mode: fs.statSync(snapshot.file).mode & 0o777 });

  return `Restored "model" in ${snapshot.file}: ${replaced} -> ${snapshot.hasModel ? JSON.stringify(snapshot.model) : '(unset)'}. Use "s" in /model to switch only the current session.`;
};
