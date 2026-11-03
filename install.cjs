const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const lib = require('./lib.cjs');
const commands = {
  'claude-gpt': 'launch',
  'claude-gpt-settings': 'settings',
  'claude-gpt-auth': 'auth',
  'claude-gpt-doctor': 'doctor',
};
const binDir = path.dirname(process.execPath);

const quote = (text) => {
  return "'" + text.replaceAll("'", "'\\''") + "'";
};

function snapshot(file, backup, index) {
  try {
    const stat = fs.lstatSync(file);

    if (stat.isSymbolicLink())
      return { file, kind: 'symlink', target: fs.readlinkSync(file) };
    if (!stat.isFile()) throw new Error(`Cannot replace non-file: ${file}`);
    const copy = path.join(backup, `file-${index}`);

    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o600);

    return { file, kind: 'file', copy, mode: stat.mode & 0o777 };
  } catch (e) {
    if (e.code === 'ENOENT') return { file, kind: 'missing' };
    throw e;
  }
}

function restore(records) {
  for (const item of [...records].reverse()) {
    fs.rmSync(item.file, { force: true });

    if (item.kind === 'symlink') fs.symlinkSync(item.target, item.file);
    else if (item.kind === 'file') {
      fs.copyFileSync(item.copy, item.file);
      fs.chmodSync(item.file, item.mode);
    }
  }
}

function install() {
  /**
   * Падаем до изменения команд, если в глобальный bin нельзя писать.
   */
  const probe = path.join(binDir, `.claude-gpt-install-${process.pid}`);

  fs.writeFileSync(probe, '', { flag: 'wx' });
  fs.unlinkSync(probe);
  const prepared = spawnSync(process.execPath, [path.join(lib.root, 'prepare.cjs')], {
    stdio: 'inherit',
  });

  if (prepared.status !== 0) throw new Error('Could not prepare CCR');
  lib.configure();
  const backup = fs.mkdtempSync(path.join(lib.runtime, 'backup-'));
  const scripts = path.join(lib.root, 'bin');

  fs.mkdirSync(scripts, { recursive: true });
  const changes = [];

  for (const [name, command] of Object.entries(commands)) {
    const wrapper = path.join(scripts, name);

    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(lib.root, 'bridge.cjs'))} ${command} "$@"\n`,
      { mode: 0o755 }
    );
    fs.chmodSync(wrapper, 0o755);
    changes.push({ file: path.join(binDir, name), target: wrapper });
  }

  const commandDir = path.join(os.homedir(), '.claude', 'commands');

  fs.mkdirSync(commandDir, { recursive: true });
  const executable = quote(path.join(binDir, 'claude-gpt-settings'));

  for (const [name, args] of Object.entries({
    'gpt-settings': '$ARGUMENTS',
    'gpt-model': 'set --model $ARGUMENTS',
    'gpt-effort': 'set --effort $ARGUMENTS',
  })) {
    changes.push({
      file: path.join(commandDir, `${name}.md`),
      content: `---\ndescription: Configure the local Codex bridge\nallowed-tools: Bash(${path.join(binDir, 'claude-gpt-settings')}:*)\n---\nRun this exact command with Bash and show its result:\n\n\`\`\`bash\n${executable} ${args}\n\`\`\`\n\nModel and effort changes apply to the next request. Do not edit OAuth files.\n`,
    });
  }

  const records = changes.map((item, i) => {
    return snapshot(item.file, backup, i);
  });

  lib.writeJson(path.join(backup, 'manifest.json'), records);
  let applied = 0;

  try {
    for (const item of changes) {
      applied++;
      fs.rmSync(item.file, { force: true });
      if (item.target) fs.symlinkSync(item.target, item.file);
      else fs.writeFileSync(item.file, item.content, { mode: 0o600 });
    }
  } catch (e) {
    restore(records.slice(0, applied));
    throw e;
  }

  const reshim = spawnSync('mise', ['reshim'], { encoding: 'utf8' });

  console.log(`Installed new claude-gpt commands in ${binDir}`);
  console.log(`Default/current: ${JSON.stringify(lib.readSettings())}`);
  console.log(`Rollback: node ${quote(__filename)} rollback ${quote(backup)}`);
  if (reshim.status !== 0)
    console.log('Run mise reshim if your shell does not find the commands.');
}

if (require.main === module)
  try {
    if (process.argv[2] === 'rollback') {
      const backup = process.argv[3];

      if (!backup) throw new Error('Provide the backup directory printed by install');
      restore(JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8')));
      console.log('Previous commands and slash commands restored.');
    } else install();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }

module.exports = { snapshot, restore };
