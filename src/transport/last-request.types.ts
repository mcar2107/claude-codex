/**
 * Модель и effort одной стороны запроса.
 */
export type ModelChoice = {
  /**
   * ID модели; `null` — сторона модель не указала.
   */
  model: string | null;

  /**
   * Уровень effort; `null` — сторона уровень не указала.
   */
  effort: string | null;
};

/**
 * Последний запрос сессии к Codex (`last-request.json`) — чтобы проверить, что `/model` и
 * `/effort` действительно дошли до upstream.
 */
export type LastRequest = {
  /**
   * Время запроса, ISO 8601.
   */
  at: string;

  /**
   * Что прислал Claude Code: модель с префиксом `codex,` и `output_config.effort`.
   */
  client: ModelChoice;

  /**
   * Что мост отправил в Codex после выбора модели и понижения effort.
   */
  upstream: ModelChoice;

  /**
   * Модель из ответа Codex (`response.model`); нет — ответ ещё не пришёл или модели в нём нет.
   */
  returnedModel?: string;
};
