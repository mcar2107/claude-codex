/**
 * Сборка только под Codex считает токены в своём процессе: eval-воркер upstream динамически
 * грузит tiktoken с диска, а в standalone-бинарнике его нет. Точный подсчёт важнее: работа в
 * главном потоке лучше молчаливой оценки.
 */
export {
  estimateTokenizePayloadChars,
  estimateTokensFromChars,
} from '../../vendor/ccr/core/src/utils/token-count-worker';
export const TOKEN_COUNT_WORKER_THRESHOLD_CHARS = Number.POSITIVE_INFINITY;

export async function countTokensInWorker(): Promise<number> {
  throw new Error('Token-count workers are not enabled in this build');
}
