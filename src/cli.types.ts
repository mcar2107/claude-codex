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
