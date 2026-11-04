import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const setup = (args: string[]) => {
  const shouldRemove = args.length === 1 && args[0] === '--remove';

  if (args.length && !shouldRemove)
    throw new Error('Usage: claude-codex setup [--remove]');
  const directory = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'commands'
  );
  const files = Object.entries({
    'codex-settings': '$ARGUMENTS',
    'codex-model': 'set --model $ARGUMENTS',
    'codex-effort': 'set --effort $ARGUMENTS',
  }).map(([name, command]) => {
    return {
      file: path.join(directory, name + '.md'),
      content: `---\ndescription: Configure claude-codex model and reasoning\nallowed-tools: Bash(claude-codex:*)\n---\nRun this command with Bash and show its result:\n\n\`\`\`sh\nclaude-codex settings ${command}\n\`\`\`\n\nChanges apply on the next request. Session overrides take precedence. Never read or print OAuth files.\n`,
    };
  });

  /**
   * Все цели проверяются до любых изменений: чужая команда с тем же именем не заменяется.
   */
  for (const item of files)
    if (fs.existsSync(item.file) && fs.readFileSync(item.file, 'utf8') !== item.content)
      throw new Error(
        `Refusing to ${shouldRemove ? 'remove' : 'replace'} a modified or foreign command: ${item.file}`
      );
  if (!shouldRemove) fs.mkdirSync(directory, { recursive: true });

  for (const item of files) {
    if (shouldRemove) {
      if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
    } else if (!fs.existsSync(item.file))
      fs.writeFileSync(item.file, item.content, { mode: 0o600, flag: 'wx' });
  }

  console.log(
    shouldRemove
      ? 'claude-codex slash commands removed.'
      : 'Installed /codex-settings, /codex-model, /codex-effort.'
  );
};
