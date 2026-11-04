/**
 * Блок содержимого ответа Anthropic Messages — поля, которые читает doctor.
 */
export type ContentBlock = {
  /**
   * Тип блока: `text`, `tool_use`, `thinking`…
   */
  type: string;

  /**
   * Текст блока `text`.
   */
  text?: string;
};

/**
 * Ответ роутера на запрос doctor — поля Anthropic Messages, которые он читает.
 */
export type DoctorResult = {
  /**
   * Ошибка провайдера; есть — проверка не прошла.
   */
  error?: {
    /**
     * Тип ошибки Anthropic: `authentication_error`, `api_error`…
     */
    type?: string;
  };

  /**
   * Модель, которую назвал ответ.
   */
  model?: string;

  /**
   * Блоки содержимого ответа.
   */
  content?: ContentBlock[];
};
