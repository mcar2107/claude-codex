import type { calculateTokenCount } from '../../vendor/ccr/core/src/utils/router';

type TokenCountArgs = Parameters<typeof calculateTokenCount>;

export type CreateRouterOptions = {
  /**
   * Локальный ключ сессии: без него роутер отвечает 401 на любой запрос, чтобы чужой процесс
   * на той же машине не ходил в Codex от имени пользователя.
   */
  key: string;

  /**
   * Куда писать снимок лимитов Codex из заголовков ответа; нет — лимиты не сохраняются.
   */
  limitsFile?: string;

  /**
   * Куда писать последний запрос к Codex: выбор клиента, отправленное и модель ответа.
   */
  requestFile?: string;
};

/**
 * Тело `POST /v1/messages/count_tokens` — подмножество запроса Anthropic Messages, которое
 * нужно для подсчёта токенов.
 */
type CountTokensBody = {
  /**
   * Сообщения диалога.
   */
  messages: TokenCountArgs[0];

  /**
   * Системный промпт: строка или массив блоков.
   */
  system: TokenCountArgs[1];

  /**
   * Описания инструментов — тоже входят в счёт токенов.
   */
  tools: TokenCountArgs[2];
};

/**
 * Generic маршрута Fastify для `POST /v1/messages/count_tokens`.
 */
export type CountTokensRoute = {
  /**
   * Тело запроса.
   */
  Body: CountTokensBody;
};
