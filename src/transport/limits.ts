import type { RateLimits, RateLimitWindow } from './limits.types';

/**
 * Окна Codex в минутах, которым есть место в схеме statusline Claude Code.
 */
const WINDOWS: Record<number, keyof RateLimits> = {
  300: 'five_hour',
  10080: 'seven_day',
};

/**
 * Окно, о длине которого Codex не сообщил, определяется по слоту: основной — пятичасовой,
 * дополнительный — недельный.
 */
const SLOTS: Record<string, keyof RateLimits> = {
  primary: 'five_hour',
  secondary: 'seven_day',
};

const numeric = (value: string | null) => {
  if (value === null || !value.trim()) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Сброс окна, секунды Unix: Codex сообщает либо момент сброса, либо сколько до него осталось.
 */
const resetTime = (headers: Headers, slot: string, now: number) => {
  const at = numeric(headers.get(`x-codex-${slot}-reset-at`));

  if (at !== undefined) {
    return Math.round(at);
  }

  const after = numeric(headers.get(`x-codex-${slot}-reset-after-seconds`));

  return after === undefined ? undefined : Math.round(now / 1000 + after);
};

/**
 * Лимиты из заголовков ответа Codex (`x-codex-primary-*`, `x-codex-secondary-*`). Окно другой
 * длины пропускается: подписать его в схеме Claude Code нечем. `undefined` — Codex лимитов не
 * сообщил.
 */
export const codexRateLimits = (
  headers: Headers,
  now = Date.now()
): RateLimits | undefined => {
  const limits = Object.entries(SLOTS).reduce<RateLimits>((result, [slot, fallback]) => {
    const used = numeric(headers.get(`x-codex-${slot}-used-percent`));

    if (used === undefined) {
      return result;
    }

    const minutes = numeric(headers.get(`x-codex-${slot}-window-minutes`));
    const key = minutes === undefined ? fallback : WINDOWS[minutes];

    if (!key) {
      return result;
    }

    const resetsAt = resetTime(headers, slot, now);
    const window: RateLimitWindow = { used_percentage: used };

    if (resetsAt !== undefined) {
      window.resets_at = resetsAt;
    }

    result[key] = window;

    return result;
  }, {});

  return Object.keys(limits).length ? limits : undefined;
};
