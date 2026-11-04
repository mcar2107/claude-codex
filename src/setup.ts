import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Команды сессии приходят плагином `--plugin-dir` (`src/client.ts`); `setup --remove` удаляет
 * глобальные `/codex-*` из каталога команд Claude, если они там есть. Содержимое ниже — эти
 * команды байт в байт: файл с другим текстом — чужой и не удаляется.
 */
export const setup = (args: string[]) => {
  if (args.length !== 1 || args[0] !== '--remove')
    throw new Error(
      'Session commands are built in (/codex:settings, /codex:models). Usage: claude-codex setup --remove'
    );
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
   * Все цели проверяются до удаления: чужая команда с тем же именем не трогается.
   */
  for (const item of files)
    if (fs.existsSync(item.file) && fs.readFileSync(item.file, 'utf8') !== item.content)
      throw new Error(`Refusing to remove a modified or foreign command: ${item.file}`);
  for (const item of files) if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
  console.log('claude-codex slash commands removed.');
};
