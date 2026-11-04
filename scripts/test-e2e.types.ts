/**
 * Итог запущенного CLI.
 */
export type ProcessResult = {
  /**
   * Код выхода; null — процесс убит сигналом.
   */
  code: number | null;

  /**
   * stdout и stderr вперемешку — для сообщения упавшей проверки.
   */
  output: string;
};
