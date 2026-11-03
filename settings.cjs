const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const lib = require('./lib.cjs');
const presets = {
  max: { model: 'gpt-6-astra', reasoningEffort: 'max' },
  balanced: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
  fast: { model: 'gpt-6-luna', reasoningEffort: 'low' },
  sol: lib.defaults,
};

function show() {
  const s = lib.readSettings();

  console.log(
    `model=${s.model}\nreasoningEffort=${s.reasoningEffort}\nsettingsFile=${lib.settingsFile}`
  );
}

module.exports = function settings(args) {
  const [command = 'show', ...rest] = args;

  if (command === 'show' || command === 'status') return show();

  if (command === 'models') {
    if (rest[0] === 'refresh') {
      const result = spawnSync(
        'bun',
        [path.join(lib.runtime, 'cli.js'), 'model', 'get', 'codex'],
        { stdio: 'inherit' }
      );

      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error('Model discovery failed; current settings were preserved');
    }

    const config = JSON.parse(fs.readFileSync(lib.configFile, 'utf8'));

    console.log('Configured candidates (account availability is checked by Codex):');
    for (const model of config.Providers[0].models)
      console.log(`${model}: ${lib.effortsFor(model).join(', ')}`);

    return;
  }

  if (command === 'help' || command === '--help') {
    console.log(
      'claude-gpt-settings show\nclaude-gpt-settings models [refresh]\nclaude-gpt-settings set --model gpt-6.1-sol --effort xhigh\nclaude-gpt-settings preset sol|balanced|fast|max\nclaude-gpt-settings reset\nChanges apply on the next request, including open sessions.'
    );

    return;
  }

  let next;

  if (command === 'reset') next = lib.defaults;
  else if (command === 'preset') {
    next = presets[rest[0]];
    if (!next)
      throw new Error(`Unknown preset. Choose ${Object.keys(presets).join(', ')}`);
  } else if (command === 'set') {
    next = lib.readSettings();

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];

      if (arg === '--model' || arg === '-m') next.model = rest[++i];
      else if (arg.startsWith('--model=')) next.model = arg.slice(8);
      else if (arg === '--effort' || arg === '-e') next.reasoningEffort = rest[++i];
      else if (arg.startsWith('--effort=')) next.reasoningEffort = arg.slice(9);
      else throw new Error(`Unknown setting: ${arg}`);
    }
  } else throw new Error(`Unknown command: ${command}. See claude-gpt-settings help`);
  next = lib.validate(next);
  /**
   * Будущие ID моделей регистрируются без очередной миграции зашитого allowlist.
   */
  const config = JSON.parse(fs.readFileSync(lib.configFile, 'utf8'));

  if (!config.Providers[0].models.includes(next.model)) {
    config.Providers[0].models.push(next.model);
    lib.writeJson(lib.configFile, config);
  }

  lib.saveSettings(next);
  show();
  console.log(
    'Applies on the next request. A session model/effort override takes precedence.'
  );
};
