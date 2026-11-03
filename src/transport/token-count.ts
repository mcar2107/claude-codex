// Codex-only builds count in-process. Upstream's eval worker dynamically
// requires tiktoken from disk, which is unavailable inside a standalone binary.
// Keep exact tokenization; accept main-thread work rather than silent estimates.
export { estimateTokenizePayloadChars, estimateTokensFromChars } from '../../vendor/ccr/core/src/utils/token-count-worker';
export const TOKEN_COUNT_WORKER_THRESHOLD_CHARS = Number.POSITIVE_INFINITY;
export async function countTokensInWorker(): Promise<number> { throw new Error('Token-count workers are not enabled in this build'); }
