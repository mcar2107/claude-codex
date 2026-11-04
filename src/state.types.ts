/**
 * Сохранённые настройки — модель и effort, которые транспорт подставляет в каждый запрос.
 */
export type Settings = {
  /**
   * ID модели Codex без префикса провайдера: `gpt-6.1-sol`.
   */
  model: string;

  /**
   * Уровень reasoning effort из списка, допустимого для модели (`effortsFor`).
   */
  reasoningEffort: string;
};

/**
 * Переопределения сессии: флаги `--model` / `--effort` поверх сохранённых настроек.
 */
export type SettingsOverrides = Partial<Settings>;

/**
 * Непроверенные настройки — из JSON, env или флагов; `validate` превращает их в `Settings`.
 */
export type SettingsInput = {
  /**
   * ID модели; допускается префикс провайдера `codex,`.
   */
  model?: unknown;

  /**
   * Уровень effort до проверки по списку модели.
   */
  reasoningEffort?: unknown;
};

/**
 * OAuth-файл state-каталога — формат, который читает хелпер обновления токена CCR.
 */
export type AuthFile = {
  /**
   * Access token Codex (JWT).
   */
  access_token: string;

  /**
   * Refresh token: без него просроченный access token не обновить.
   */
  refresh_token?: string;

  /**
   * ID token из обмена кода: из него берутся claims аккаунта.
   */
  id_token?: string;

  /**
   * Тип токена для заголовка Authorization.
   */
  token_type?: string;

  /**
   * Срок действия access token, секунды Unix.
   */
  expires_at?: number;

  /**
   * ID аккаунта ChatGPT для заголовка `ChatGPT-Account-Id`.
   */
  account_id?: string;

  /**
   * Признак аккаунта FedRAMP из claims ID token.
   */
  account_is_fedramp?: boolean;

  /**
   * Время последнего обновления токенов, секунды Unix.
   */
  last_refresh?: number;
};
