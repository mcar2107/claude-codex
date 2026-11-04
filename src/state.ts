import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuthFile, Settings, SettingsInput, SettingsOverrides } from './state.types';

export const runtime = path.resolve(
  process.env.CLAUDE_CODEX_STATE_DIR || path.join(os.homedir(), '.claude-codex')
);
export const settingsFile = path.join(runtime, 'settings.json');
export const authFile = path.join(runtime, 'codex_auth.json');
export const defaults: Settings = { model: 'gpt-6.1-sol', reasoningEffort: 'high' };
export const models = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
];

export const effortsFor = (model: string): string[] => {
  if (/^gpt-(6|5\.6)(?:[.-]|$)/.test(model))
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (model === 'gpt-5.5') return ['low', 'medium', 'high', 'xhigh'];

  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
};

const validate = (value: SettingsInput): Settings => {
  const model = String(value.model || '').replace(/^codex,/, '');
  const { reasoningEffort } = value;

  if (!/^gpt-[a-z0-9][a-z0-9.-]*$/.test(model))
    throw new Error('Expected a GPT model ID, such as gpt-6.1-sol');
  if (typeof reasoningEffort !== 'string' || !effortsFor(model).includes(reasoningEffort))
    throw new Error(`${model}: supported effort levels: ${effortsFor(model).join(', ')}`);

  return { model, reasoningEffort };
};

export const ensureState = () => {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
};

export const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;

  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

export const readSettings = (): Settings => {
  return validate(
    fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      : defaults
  );
};

export const saveSettings = (value: SettingsInput) => {
  writeJson(settingsFile, validate(value));
};

export const activeSettings = (
  overrides: SettingsOverrides = {},
  env: NodeJS.ProcessEnv = process.env
): Settings => {
  return validate({
    ...readSettings(),
    ...(env.CLAUDE_CODEX_MODEL ? { model: env.CLAUDE_CODEX_MODEL } : {}),
    ...(env.CLAUDE_CODEX_EFFORT ? { reasoningEffort: env.CLAUDE_CODEX_EFFORT } : {}),
    ...overrides,
  });
};

export const requireAuth = (): AuthFile => {
  let auth;

  try {
    auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new Error('Not authenticated. Run: claude-codex auth login', {
        cause: error,
      });
    throw new Error('Cannot read OAuth credentials; run: claude-codex auth login', {
      cause: error,
    });
  }

  if (typeof auth.access_token !== 'string' || !auth.access_token)
    throw new Error('OAuth access token missing. Run: claude-codex auth login');

  return auth;
};
