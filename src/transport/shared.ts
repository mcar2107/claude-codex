import path from 'node:path';
import os from 'node:os';
import state from '../state.cjs';
export * from '../../vendor/ccr/shared/src/codex-auth';
export * from '../../vendor/ccr/shared/src/model-alias';
// Only the shared exports used by the Codex transport are linked.
export const HOME_DIR = state.runtime;
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export const RATE_LIMIT_CONFIG = { max: 10000, timeWindow: '1 minute' };
