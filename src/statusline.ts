import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { RateLimits } from './transport/limits.types';
import { STATUS_LINE_FILE } from './client';
import { LIMITS_FILE } from './session';

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Окна снимка, которые ещё не сброшены: после сброса процент в снимке уже не правда.
 */
const currentLimits = (limits: unknown, now: number): RateLimits | undefined => {
  if (typeof limits !== 'object' || limits === null) return undefined;
  const current = (['five_hour', 'seven_day'] as const).reduce<RateLimits>(
    (result, key) => {
      const window: unknown = Reflect.get(limits, key);

      if (typeof window !== 'object' || window === null) return result;
      const used: unknown = Reflect.get(window, 'used_percentage');
      const resetsAt: unknown = Reflect.get(window, 'resets_at');

      if (typeof used !== 'number') return result;
      if (typeof resetsAt === 'number') {
        if (resetsAt * 1000 > now)
          result[key] = { used_percentage: used, resets_at: resetsAt };
      } else result[key] = { used_percentage: used };

      return result;
    },
    {}
  );

  return Object.keys(current).length ? current : undefined;
};

/**
 * JSON statusline с лимитами Codex в поле `rate_limits` — в той схеме, в которой Claude Code
 * отдаёт лимиты подписки. Свои `rate_limits` клиента не перезаписываются.
 */
export const withRateLimits = (input: string, limits: unknown, now = Date.now()) => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input);
  } catch {
    return input;
  }

  const current = currentLimits(limits, now);

  if (
    !current ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Reflect.get(parsed, 'rate_limits')
  )
    return input;

  return JSON.stringify({ ...parsed, rate_limits: current });
};

/**
 * Обёртка statusLine сессии: дополняет JSON клиента и передаёт его исходной команде
 * пользователя. Вывод и код выхода — исходной команды.
 */
export const statusline = async (session: string | undefined) => {
  if (!session) throw new Error('Usage: claude-codex __statusline SESSION');
  const original: unknown = readJson(path.join(session, STATUS_LINE_FILE));
  const command: unknown =
    typeof original === 'object' && original !== null
      ? Reflect.get(original, 'command')
      : undefined;

  if (typeof command !== 'string') return 0;
  const input = await Bun.stdin.text();
  const output = withRateLimits(input, readJson(path.join(session, LIMITS_FILE)));

  return new Promise<number>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      /**
       * Код 0 — успех команды, а не «кода нет»: `||` превратил бы его в 1.
       */
      resolve(code ?? 1);
    });
    child.stdin.on('error', () => {
      /**
       * Команда может не читать stdin и закрыть его раньше: это не ошибка statusline.
       */
    });
    child.stdin.end(output);
  });
};
