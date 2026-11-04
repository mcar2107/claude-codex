/**
 * Окно лимита в схеме `rate_limits` из JSON statusline Claude Code.
 */
export type RateLimitWindow = {
  /**
   * Израсходованная доля окна, проценты: 0–100, при перерасходе — больше 100.
   */
  used_percentage: number;

  /**
   * Время сброса окна, секунды Unix; нет — Codex его не сообщил.
   */
  resets_at?: number;
};

/**
 * Снимок лимитов Codex в схеме `rate_limits` statusline Claude Code: скрипт, который показывает
 * лимиты подписки Claude, покажет их без правок.
 */
export type RateLimits = {
  /**
   * Пятичасовое окно.
   */
  five_hour?: RateLimitWindow;

  /**
   * Недельное окно.
   */
  seven_day?: RateLimitWindow;
};
