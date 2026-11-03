const state = require('./state.cjs');
const {
  parseOverrides,
  withRouter,
  spawnClient,
  internalRouter,
} = require('./session.cjs');
const version = require('../package.json').version;

function help() {
  console.log(
    `claude-codex ${version} — Claude Code → Codex OAuth\n\nUsage:\n  claude-codex [launch] [--model GPT-ID] [--effort LEVEL] [Claude Code arguments]\n  claude-codex auth login|status\n  claude-codex doctor [--model GPT-ID] [--effort LEVEL]\n  claude-codex settings show|set|reset|preset\n  claude-codex models [refresh]\n  claude-codex setup [--remove]\n  claude-codex migrate --from STATE-DIRECTORY\n\nState: ${state.runtime}\nRequires Bun >=1.4.0 for the npm CLI and a separately installed Claude Code.\nModel/effort overrides last for this session. Use -- to stop parsing bridge flags.\nUse doctor for a real upstream check. Candidate model names do not prove access.`
  );
}

async function doctor(args) {
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
        model: 'codex,gpt-6.1-sol',
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
    const answer = (result.content || []).reduce((text, item) => {
      return item.type === 'text' ? text + (item.text || '') : text;
    }, '');

    console.log(`Returned model: ${result.model || '(not reported)'}\nAnswer: ${answer}`);
    if (answer.trim() !== 'ok') throw new Error('Unexpected doctor response');
    console.log('PASS');

    return 0;
  });
}

async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;

  if (command === '__router') return internalRouter(rest[0]);
  if (['help', '--help', '-h'].includes(command)) return help();

  if (command === '--version' || command === 'version') {
    console.log(version);

    return;
  }

  if (command === 'settings') return require('./settings.cjs').settings(rest);
  if (command === 'models') return require('./settings.cjs').models(rest);
  if (command === 'setup') return require('./setup.cjs').setup(rest);
  if (command === 'migrate') return require('./migrate.cjs').migrate(rest);

  if (command === 'auth') {
    if (rest.length === 1 && rest[0] === 'status') return require('./auth.cjs').status();
    if (rest.length === 1 && rest[0] === 'login') return require('./auth.cjs').login();
    throw new Error('Usage: claude-codex auth login|status');
  }

  if (command === 'doctor') return doctor(rest);
  const { overrides, rest: clientArgs } = parseOverrides(
    command === 'launch' ? rest : args
  );

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
      env[name] = 'codex,gpt-6.1-sol';

    return spawnClient(
      'claude',
      ['--model', 'codex,gpt-6.1-sol', '--effort', active.reasoningEffort, ...clientArgs],
      { env, signal }
    );
  });
}

if (require.main === module)
  main()
    .then((code) => {
      process.exitCode = code || 0;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { main, doctor };
