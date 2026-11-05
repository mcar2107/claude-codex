/**
 * Тело запроса в Responses API, которое мок Codex перехватил у транспорта.
 */
export type CapturedRequest = {
  /**
   * Модель, которую транспорт отправил upstream.
   */
  model: string;

  /**
   * Параметры reasoning.
   */
  reasoning: {
    /**
     * Уровень effort.
     */
    effort: string;
  };

  /**
   * Транспорт всегда стримит ответ Codex.
   */
  stream: boolean;

  /**
   * Codex OAuth не хранит ответы.
   */
  store: boolean;

  /**
   * Элементы входа Responses.
   */
  input: {
    /**
     * Тип элемента: `message`, `additional_tools`…
     */
    type: string;
  }[];

  /**
   * Инструменты стандартного Responses.
   */
  tools?: unknown[];
};

/**
 * Отметки мока о том, что клиент оборвал стрим.
 */
export type CancellationProbe = {
  /**
   * Сработал AbortSignal запроса к upstream.
   */
  isAborted: boolean;

  /**
   * Транспорт отменил поток ответа upstream.
   */
  isCancelled: boolean;
};

/**
 * Поток, который мок Codex отдаёт кадрами как есть.
 */
export type MockStream = {
  /**
   * Кадры SSE.
   */
  frames: string[];

  /**
   * Поток закрывается после кадров; иначе висит, как Codex в петле.
   */
  isClosed: boolean;

  /**
   * Отметка, что транспорт отменил поток.
   */
  probe: CancellationProbe;
};

/**
 * Элемент `output` ответа Responses.
 */
export type ResponseOutputItem = {
  /**
   * ID элемента.
   */
  id: string;

  /**
   * Тип: `message` или `function_call`.
   */
  type: string;

  /**
   * Прочие поля элемента — мок передаёт их как есть.
   */
  [field: string]: unknown;
};

/**
 * Реализация `fetch` для мока: без `preconnect`, который есть у глобального `fetch` Bun.
 */
export type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;
