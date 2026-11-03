const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main: build } = require('./build.cjs');

async function main() {
  if (Bun.version !== '1.4.4')
    throw new Error(
      'Standalone build currently requires Bun 1.4.4; review and update runtime notices before changing it.'
    );
  const targets = [
    'bun-darwin-arm64',
    'bun-darwin-x64',
    'bun-linux-x64',
    'bun-linux-arm64',
  ];
  const native = `bun-${process.platform}-${process.arch}`;
  const args = process.argv.slice(2);

  if (args.length && (args.length !== 2 || args[0] !== '--target'))
    throw new Error(
      'Usage: bun scripts/standalone.cjs [--target bun-darwin-arm64|bun-darwin-x64|bun-linux-x64|bun-linux-arm64]'
    );
  const target = args[1] || native;

  if (!targets.includes(target)) throw new Error('Unsupported standalone target');
  await build();
  const directory = path.resolve(__dirname, '../artifacts', target);

  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'claude-codex');
  const result = spawnSync(
    process.execPath,
    [
      'build',
      path.resolve(__dirname, '../dist/cli.cjs'),
      '--compile',
      `--target=${target}`,
      '--outfile',
      output,
    ],
    { stdio: 'inherit' }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Standalone build failed (${result.status})`);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt'])
    fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(directory, file));
  fs.copyFileSync(
    path.resolve(__dirname, '../vendor/ccr/LICENSE'),
    path.join(directory, 'CCR-LICENSE')
  );
  fs.copyFileSync(
    path.resolve(__dirname, '../dist/cli.cjs.LEGAL.txt'),
    path.join(directory, 'CODE-LEGAL.txt')
  );
  fs.copyFileSync(
    path.resolve(__dirname, '../licenses/BUN-1.4.4-LICENSE.md'),
    path.join(directory, 'BUN-LICENSE.md')
  );
  console.log(
    `Built ${output}. Compilation alone is not an OS/runtime verification; run package smoke tests on the target OS.`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
