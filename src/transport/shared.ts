import path from 'node:path';

import * as state from '../state';
/**
 * Подмена `@caeliq/ccr-shared`: линкуются только общие экспорты, которые нужны транспорту Codex,
 * а пути — свои: state моста и каталог Claude с учётом `CLAUDE_CONFIG_DIR`.
 */
export * from '../../vendor/ccr/shared/src/codex-auth';
export * from '../../vendor/ccr/shared/src/model-alias';
export const HOME_DIR = state.RUNTIME_DIR;
export const CLAUDE_PROJECTS_DIR = path.join(state.claudeConfigDir(), 'projects');
/**
 * Значение upstream. Роутер сессии не регистрирует `@fastify/rate-limit`, поэтому лимит
 * маршрутов CCR в нём не действует: экспорт нужен только как форма модуля.
 */
export const RATE_LIMIT_CONFIG = { max: 1000, timeWindow: '1 minute' } as const;
