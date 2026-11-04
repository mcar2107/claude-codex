#!/usr/bin/env bun
import packageJson from '../package.json' with { type: 'json' };

import type { ContentBlock, DoctorResult } from './cli.types';
import { internalRouter, parseOverrides, spawnClient, withRouter } from './session';
import * as state from './state';

const { version } = packageJson;

/**
 * Окружение, которое увело бы клиента мимо роутера сессии или подменило бы его модель: ключ
 * Anthropic, провайдеры Bedrock, Vertex и Foundry, свои заголовки, модель субагентов.
 * `CLAUDECODE` Claude Code ставит своим дочерним процессам — мост, запущенный из сессии, не должен
 * передать его дальше.
 */
const FOREIGN_CLIENT_ENV = [
  'ANTHROPIC_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/**
 * Тело ответа как JSON; не-JSON (HTML прокси, пустой 502) — `undefined`, а не `SyntaxError`.
 */
const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Потолок проверки doctor: чуть дольше таймаута роутера к Codex (`API_TIMEOUT_MS` в
 * `src/transport/server.ts`), чтобы ошибку upstream успел вернуть роутер, а не оборвать клиент.
 */
const DOCTOR_TIMEOUT_MS = 130_000;

const isDoctorResult = (value: unknown): value is DoctorResult => {
  return typeof value === 'object' && value !== null;
};

const help = () => {
  console.log(
    `claude-codex ${version} — Claude Code → Codex OAuth\n\nUsage:\n  claude-codex [launch] [--model GPT-ID] [--effort LEVEL] [Claude Code arguments]\n  claude-codex auth login|status\n  claude-codex doctor [--model GPT-ID] [--effort LEVEL]\n  claude-codex settings show|set|reset|preset\n  claude-codex models [refresh]\n  claude-codex setup --remove\n  claude-codex update [vX.Y.Z]\n\nState: ${state.RUNTIME_DIR}\nRequires Bun >=1.4.0 for the bundled CLI and a separately installed Claude Code.\nFlags and saved settings pick the starting model/effort; switch in a session with /model and /effort.\nSession commands: /codex:settings, /codex:models. Use -- to stop parsing bridge flags.\nupdate replaces this binary; for Claude Code's own update run claude update or claude-codex launch update.\nUse doctor for a real upstream check. Candidate model names do not prove access.`
  );
};

const doctor = async (args: string[]) => {
  const { overrides, rest } = parseOverrides(args);

  if (rest.length) {
    throw new Error('doctor accepts only --model and --effort');
  }

  return withRouter(overrides, async ({ base, key, active, signal }) => {
    console.log(
      `Testing ${active.model} ${active.reasoningEffort} via Codex OAuth (real upstream request)...`
    );
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: state.CLIENT_PREFIX + active.model,
        max_tokens: 1024,
        stream: false,
        output_config: { effort: active.reasoningEffort },
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOCTOR_TIMEOUT_MS)]),
    });
    const result = await readJson(response);

    if (!response.ok || !isDoctorResult(result) || result.error) {
      throw new Error(
        `Upstream check failed (HTTP ${response.status}): ${(isDoctorResult(result) && result.error?.type) || 'provider_error'}`
      );
    }

    const content = Array.isArray(result.content) ? result.content : [];
    const answer = content.reduce((text: string, item: ContentBlock) => {
      return item.type === 'text' ? text + (item.text || '') : text;
    }, '');

    console.log(`Returned model: ${result.model || '(not reported)'}\nAnswer: ${answer}`);

    if (answer.trim() !== 'ok') {
      throw new Error('Unexpected doctor response');
    }

    console.log('PASS');

    return 0;
  });
};

const auth = async (args: string[]) => {
  const { login, status } = await import('./auth');

  switch (args.length === 1 && args[0]) {
    case 'status': {
      return status();
    }

    case 'login': {
      return login();
    }

    default: {
      throw new Error('Usage: claude-codex auth login|status');
    }
  }
};

const launch = (args: string[]) => {
  const { overrides, rest: clientArgs } = parseOverrides(args);

  return withRouter(overrides, async ({ base, key, session, active, env, signal }) => {
    console.error(
      `${active.model} ${active.reasoningEffort} via Codex OAuth. Switch with /model and /effort; claude-codex settings are defaults for new sessions.`
    );

    for (const name of FOREIGN_CLIENT_ENV) {
      delete env[name];
    }

    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_AUTH_TOKEN = key;
    const { isClientModel, prepareClient, restoreUserModel, snapshotUserModel } =
      await import('./client');
    const snapshot = snapshotUserModel();

    if (snapshot?.hasModel && isClientModel(snapshot.model)) {
      console.error(
        `Warning: "model" in ${snapshot.file} is ${snapshot.model}; plain claude will start with a Codex model. Remove it or pick a Claude model with /model.`
      );
    }

    try {
      return await spawnClient(
        'claude',
        prepareClient({ session, active, clientArgs, env }),
        { env, signal }
      );
    } finally {
      /**
       * Сбой восстановления не должен подменить код выхода клиента: только предупреждение.
       */
      try {
        const restored = restoreUserModel(snapshot);

        if (restored) {
          console.error(restored);
        }
      } catch (error) {
        console.error(
          `Warning: could not restore "model" in ${snapshot?.file}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
  });
};

/**
 * Модули команд грузятся лениво: запуск клиента не тянет OAuth и setup.
 */
const main = async (args: string[]): Promise<number | void> => {
  const [command, ...rest] = args;

  switch (command) {
    case '__router': {
      return internalRouter(rest[0]);
    }

    case 'help':

    case '--help':

    case '-h': {
      return help();
    }

    case 'version':

    case '--version': {
      console.log(version);

      return;
    }

    case 'settings': {
      return (await import('./settings')).settings(rest);
    }

    case 'models': {
      return (await import('./settings')).models(rest);
    }

    case '__statusline': {
      return (await import('./statusline')).statusline(rest[0]);
    }

    case 'setup': {
      return (await import('./setup')).setup(rest);
    }

    case 'update': {
      return (await import('./update')).update(rest);
    }

    case 'auth': {
      return auth(rest);
    }

    case 'doctor': {
      return doctor(rest);
    }

    case 'launch': {
      return launch(rest);
    }

    default: {
      return launch(args);
    }
  }
};

try {
  process.exitCode = (await main(process.argv.slice(2))) || 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
