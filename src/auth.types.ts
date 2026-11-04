import type { AddressInfo } from 'node:net';

/**
 * Подмножество `fetch`, которое нужно обмену кода: тесты подставляют мок token endpoint.
 */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LoginOptions = {
  /**
   * Порт колбэка; 0 — любой свободный (тесты).
   */
  port?: number;

  /**
   * Показ URL авторизации; получает и адрес поднятого колбэка.
   */
  onUrl?: (url: string, address: AddressInfo) => unknown;

  /**
   * Реализация запроса к token endpoint.
   */
  fetchImpl?: FetchLike;

  /**
   * Сколько ждать колбэк браузера, мс.
   */
  timeout?: number;

  /**
   * Отмена входа снаружи.
   */
  signal?: AbortSignal;
};

/**
 * Claims из payload JWT, которые читает мост.
 */
export type JwtClaims = {
  /**
   * Срок действия, секунды Unix.
   */
  exp?: number;

  /**
   * Claims аккаунта ChatGPT в ID token.
   */
  'https://api.openai.com/auth'?: {
    /**
     * ID аккаунта ChatGPT.
     */
    chatgpt_account_id?: string;

    /**
     * Признак аккаунта FedRAMP.
     */
    chatgpt_account_is_fedramp?: boolean;
  };
};

/**
 * Ответ token endpoint на обмен кода авторизации.
 */
export type TokenExchange = {
  /**
   * Access token Codex.
   */
  access_token: string;

  /**
   * Refresh token.
   */
  refresh_token: string;

  /**
   * ID token с claims аккаунта.
   */
  id_token: string;

  /**
   * Тип токена; по умолчанию Bearer.
   */
  token_type?: string;

  /**
   * Срок действия, секунды Unix, — если endpoint его вернул.
   */
  expires_at?: number;

  /**
   * Время жизни access token, секунды.
   */
  expires_in?: number;

  /**
   * ID аккаунта, если endpoint вернул его явно.
   */
  account_id?: string;
};
