/**
 * Итог запуска линтера.
 */
export type RunResult = {
  /**
   * Код выхода; `null` — процесс убит сигналом.
   */
  exitCode: number | null;

  /**
   * Сигнал, которым убит процесс; `null` — процесс вышел сам.
   */
  signalCode: string | null;

  /**
   * stdout процесса — отдельно от stderr: там JSON eslint и диагностики tsc.
   */
  stdout: string;

  /**
   * stderr процесса — для диагностики сбоя.
   */
  stderr: string;

  /**
   * Процесс снят по таймауту.
   */
  isTimedOut: boolean;
};

/**
 * Замечание eslint из `--format json`.
 */
type EslintMessage = {
  /**
   * Правило; `null` — ошибка разбора файла.
   */
  ruleId: string | null;

  /**
   * 1 — warning, 2 — error.
   */
  severity: number;

  /**
   * Текст замечания.
   */
  message: string;

  /**
   * Строка, с 1.
   */
  line?: number;

  /**
   * Колонка, с 1.
   */
  column?: number;
};

/**
 * Результат eslint по одному файлу из `--format json`.
 */
export type EslintFileResult = {
  /**
   * Абсолютный путь файла.
   */
  filePath: string;

  /**
   * Замечания по файлу.
   */
  messages: EslintMessage[];
};

/**
 * Диагностика tsc из вывода `--pretty false`.
 */
export type TscDiagnostic = {
  /**
   * Файл относительно корня репозитория; `undefined` — ошибка конфигурации без файла.
   */
  file?: string;

  /**
   * Текст диагностики со строками продолжения.
   */
  text: string;
};

/**
 * Итог одного линтера: что блокирует правку, что — сбой самого линтера.
 */
export type LintOutcome = {
  /**
   * Есть ошибки в правленых файлах — правка блокируется (exit 2).
   */
  hasErrors: boolean;

  /**
   * Линтер не отработал (нет бинарника, упал, таймаут, неразбираемый вывод) — exit 1.
   */
  hasCrashed: boolean;

  /**
   * Строки отчёта для stderr; линтеры идут параллельно, и отчёт каждого печатается целиком.
   */
  report: string[];
};

/**
 * Диагностики tsc, разделённые по тому, блокируют ли они правку.
 */
export type TscGroups = {
  /**
   * В правленых файлах или в конфигурации.
   */
  blocking: string[];

  /**
   * В других файлах — только предупреждение.
   */
  other: string[];
};
