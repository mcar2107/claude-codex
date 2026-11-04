import type * as upstream from '../../vendor/ccr/core/src/utils/token-count-worker';

/**
 * Сборка только под Codex считает токены в своём процессе: воркер upstream в standalone-бинарнике
 * не запускается. С порогом `Infinity` до `countTokensInWorker` дело не доходит, а вызов всё же
 * отклоняется явной ошибкой. Точный подсчёт важнее: работа в главном потоке лучше молчаливой
 * оценки.
 *
 * Типы экспортов взяты у upstream: разойдётся контракт подмены с модулем, который она заменяет, —
 * это покажет typecheck.
 */
export {
  estimateTokenizePayloadChars,
  estimateTokensFromChars,
} from '../../vendor/ccr/core/src/utils/token-count-worker';
export const TOKEN_COUNT_WORKER_THRESHOLD_CHARS: number = Number.POSITIVE_INFINITY;

export const countTokensInWorker: typeof upstream.countTokensInWorker = async () => {
  throw new Error('Token-count workers are not enabled in this build');
};

export const closeTokenCountWorkers: typeof upstream.closeTokenCountWorkers =
  async () => {
    /**
     * Воркеров нет — закрывать нечего.
     */
  };
