import type { Settings } from './state.types';

/**
 * Настройки Claude Code в виде JSON-объекта: поля, которые мост не трогает, проходят как есть.
 */
export type ClaudeSettings = Record<string, unknown>;

/**
 * Значение `statusLine` из настроек Claude Code — команда и её параметры отображения.
 */
export type StatusLine = Record<string, unknown> & {
  /**
   * Тип строки состояния; мост оборачивает только `command`.
   */
  type?: unknown;

  /**
   * Shell-команда, которой Claude Code передаёт JSON сессии на stdin.
   */
  command?: unknown;
};

/**
 * Аргументы клиента после извлечения `--settings`.
 */
export type ExtractedSettings = {
  /**
   * Настройки из `--settings` пользователя: JSON-строка или файл; нет флага — `undefined`.
   */
  settings: ClaudeSettings | undefined;

  /**
   * Остальные аргументы клиента.
   */
  rest: string[];
};

export type PrepareClientOptions = {
  /**
   * Приватный каталог сессии: сюда пишутся плагин, настройки и обёртка statusline.
   */
  session: string;

  /**
   * Стартовые модель и effort сессии.
   */
  active: Settings;

  /**
   * Аргументы клиента, которые передал пользователь.
   */
  clientArgs: string[];

  /**
   * Окружение клиента; дополняется на месте.
   */
  env: NodeJS.ProcessEnv;

  /**
   * Каталог проекта — по нему ищутся project- и local-настройки Claude Code.
   */
  cwd?: string;
};

/**
 * Поле `model` пользовательских настроек Claude Code на момент запуска сессии.
 */
export type UserModelSnapshot = {
  /**
   * Файл пользовательских настроек Claude Code.
   */
  file: string;

  /**
   * Было ли поле `model` в файле.
   */
  hasModel: boolean;

  /**
   * Значение поля `model`, если оно было.
   */
  model?: unknown;
};
