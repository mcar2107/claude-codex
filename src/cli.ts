#!/usr/bin/env bun
import packageJson from '../package.json' with { type: 'json' };

import type { ContentBlock } from './cli.types';
import { internalRouter, parseOverrides, spawnClient, withRouter } from './session';
import * as state from './state';

const { version } = packageJson;
const CLIENT_MODEL = 'codex,gpt-6.1-sol';

const help = () => {
  console.log(
    `claude-codex ${version} — Claude Code → Codex OAuth\n\nUsage:\n  claude-codex [launch] [--model GPT-ID] [--effort LEVEL] [Claude Code arguments]\n  claude-codex auth login|status\n  claude-codex doctor [--model GPT-ID] [--effort LEVEL]\n  claude-codex settings show|set|reset|preset\n  claude-codex models [refresh]\n  claude-codex setup [--remove]\n\nState: ${state.runtime}\nRequires Bun >=1.4.0 for the bundled CLI and a separately installed Claude Code.\nModel/effort overrides last for this session. Use -- to stop parsing bridge flags.\nUse doctor for a real upstream check. Candidate model names do not prove access.`
  );
};

const doctor = async (args: string[]) => {
  const { overrides, rest } = parseOverrides(args);

  if (rest.length) throw new Error('doctor accepts only --model and --effort');

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
        model: CLIENT_MODEL,
        max_tokens: 1024,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(130000)]),
    });
    const result = await response.json();

    if (!response.ok || result.error)
      throw new Error(
        `Upstream check failed (HTTP ${response.status}): ${result.error?.type || 'provider_error'}`
      );
    const answer = (result.content || []).reduce((text: string, item: ContentBlock) => {
      return item.type === 'text' ? text + (item.text || '') : text;
    }, '');

    console.log(`Returned model: ${result.model || '(not reported)'}\nAnswer: ${answer}`);
    if (answer.trim() !== 'ok') throw new Error('Unexpected doctor response');
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

  return withRouter(overrides, async ({ base, key, active, env, signal }) => {
    console.error(
      `${active.model} ${active.reasoningEffort} via Codex OAuth. Claude's startup alias is not upstream model verification.`
    );
    for (const name of [
      'ANTHROPIC_API_KEY',
      'CLAUDECODE',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    ])
      delete env[name];
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_AUTH_TOKEN = key;
    for (const name of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ])
      env[name] = CLIENT_MODEL;

    return spawnClient(
      'claude',
      ['--model', CLIENT_MODEL, '--effort', active.reasoningEffort, ...clientArgs],
      { env, signal }
    );
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

    case 'setup': {
      return (await import('./setup')).setup(rest);
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
