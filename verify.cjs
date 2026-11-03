const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gpt-verify-'));

process.env.CLAUDE_GPT_STATE_DIR = fixture;
const lib = require('./lib.cjs');
const LiveSettings = require('./live-settings.cjs');
const { parseOverrides } = require('./bridge.cjs');
const env = { ...process.env };

function settings(...args) {
  return spawnSync(
    process.execPath,
    [path.join(__dirname, 'bridge.cjs'), 'settings', ...args],
    { env, encoding: 'utf8' }
  );
}

async function main() {
  lib.writeJson(lib.configFile, { Providers: [{ models: ['gpt-6.1-sol'] }] });
  lib.saveSettings(lib.defaults);
  const original = fs.readFileSync(lib.settingsFile, 'utf8');

  assert.equal(settings('set', '--model', 'gpt-6.1-sol', '--effort', 'none').status, 1);
  assert.equal(
    fs.readFileSync(lib.settingsFile, 'utf8'),
    original,
    'Rejected settings must not modify saved state'
  );
  assert.equal(
    settings('set', '--model', 'gpt-future-test', '--effort', 'high').status,
    0,
    'Future model IDs must not require an allowlist update'
  );
  assert(lib.readSettings().model === 'gpt-future-test');
  assert(
    JSON.parse(fs.readFileSync(lib.configFile)).Providers[0].models.includes(
      'gpt-future-test'
    )
  );
  const transformer = new LiveSettings();
  const input = {
    model: 'gpt-6.1-sol',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        type: 'function',
        function: { name: 'read_file', parameters: { type: 'object' } },
      },
    ],
  };

  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna']) {
    for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      lib.saveSettings({ model, reasoningEffort });
      const result = await transformer.transformRequestIn(input);

      assert.equal(result.model, model);
      assert.equal(result.reasoning.effort, reasoningEffort);
      assert.deepEqual(result.tools, input.tools);
      assert.deepEqual(result.messages, input.messages);
      assert.equal(input.model, 'gpt-6.1-sol', 'Must not mutate the inbound request');
    }
  }

  process.env.CLAUDE_GPT_MODEL = 'gpt-6.1-sol';
  process.env.CLAUDE_GPT_EFFORT = 'low';
  const overridden = await transformer.transformRequestIn(input);

  assert.equal(overridden.model, 'gpt-6.1-sol');
  assert.equal(overridden.reasoning.effort, 'low');
  delete process.env.CLAUDE_GPT_MODEL;
  delete process.env.CLAUDE_GPT_EFFORT;
  assert.deepEqual(
    parseOverrides(['--model', 'gpt-6-astra', '--effort=max', '-p', 'hello']),
    { overrides: { model: 'gpt-6-astra', reasoningEffort: 'max' }, rest: ['-p', 'hello'] }
  );
  assert.throws(() => {
    return parseOverrides(['--model', '--effort', 'high']);
  });
  const { snapshot, restore } = require('./install.cjs');
  const existing = path.join(fixture, 'existing-command');
  const link = path.join(fixture, 'command-link');
  const absent = path.join(fixture, 'previously-absent');
  const backup = path.join(fixture, 'backup');

  fs.mkdirSync(backup);
  fs.writeFileSync(existing, 'old command', { mode: 0o755 });
  fs.symlinkSync('existing-command', link);
  const records = [existing, link, absent].map((file, i) => {
    return snapshot(file, backup, i);
  });

  for (const file of [existing, link, absent]) {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, 'replacement');
  }

  restore(records);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'old command');
  assert.equal(fs.statSync(existing).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(link), 'existing-command');
  assert.equal(fs.existsSync(absent), false);
  console.log(
    'PASS: live settings for 4 models × 5 efforts, unchanged tools/messages, session overrides, future models, and validation without partial writes.'
  );
  console.log(
    'PASS: rollback restores original files, permissions, relative symlinks, and absent commands.'
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    return fs.rmSync(fixture, { recursive: true, force: true });
  });
