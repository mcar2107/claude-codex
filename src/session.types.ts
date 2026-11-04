import type { Settings, SettingsOverrides } from './state.types';

/**
 * Разбор аргументов: флаги моста отдельно от аргументов клиента.
 */
export type ParsedOverrides = {
  /**
   * Переопределения модели и effort на эту сессию.
   */
  overrides: SettingsOverrides;

  /**
   * Остальные аргументы — уходят клиенту как есть.
   */
  rest: string[];
};

/**
 * Метаданные, которые роутер сессии печатает первой строкой stdout и пишет в `health.json`.
 */
export type RouterMetadata = {
  /**
   * PID процесса роутера.
   */
  pid: number;

  /**
   * Адрес роутера на loopback: `http://127.0.0.1:<port>`.
   */
  base: string;

  /**
   * Время старта, ISO 8601.
   */
  startedAt: string;
};

/**
 * Что получает действие, запущенное поверх роутера сессии.
 */
export type RouterSession = {
  /**
   * Адрес роутера на loopback.
   */
  base: string;

  /**
   * Локальный ключ сессии — без него роутер отвечает 401.
   */
  key: string;

  /**
   * Действующие настройки с учётом переопределений.
   */
  active: Settings;

  /**
   * Окружение для дочерних процессов сессии.
   */
  env: NodeJS.ProcessEnv;

  /**
   * Срабатывает при отмене сессии или смерти роутера.
   */
  signal: AbortSignal;
};

export type SpawnClientOptions = {
  /**
   * Окружение клиента.
   */
  env?: NodeJS.ProcessEnv;

  /**
   * Отмена сессии: клиент получает SIGTERM, через 2 секунды — SIGKILL.
   */
  signal?: AbortSignal;
};
