import os from 'node:os';
import path from 'node:path';

import * as state from '../state';
export * from '../../vendor/ccr/shared/src/codex-auth';
export * from '../../vendor/ccr/shared/src/model-alias';
/**
 * Линкуются только общие экспорты, которые нужны транспорту Codex.
 */
export const HOME_DIR = state.runtime;
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export const RATE_LIMIT_CONFIG = { max: 10000, timeWindow: '1 minute' };
