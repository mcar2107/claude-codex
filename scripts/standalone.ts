import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { build } from './build';

const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
];
const root = path.resolve(import.meta.dirname, '..');

/**
 * Версия Bun, чей рантайм входит в бинарник: под неё лежит лицензия в `licenses/`, её же ставит
 * workflow (release.md).
 */
const BUN_VERSION = '1.4.4';

if (Bun.version !== BUN_VERSION) {
  throw new Error(
    `Standalone build currently requires Bun ${BUN_VERSION}; review and update runtime notices before changing it.`
  );
}

const native = `bun-${process.platform}-${process.arch}`;
const args = process.argv.slice(2);

if (args.length && (args.length !== 2 || args[0] !== '--target')) {
  throw new Error(`Usage: bun scripts/standalone.ts [--target ${TARGETS.join('|')}]`);
}

const target = args[1] || native;

if (!TARGETS.includes(target)) {
  throw new Error('Unsupported standalone target');
}

await build();
const directory = path.join(root, 'artifacts', target);

fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'claude-codex');
const result = spawnSync(
  process.execPath,
  [
    'build',
    path.join(root, 'dist/cli.js'),
    '--compile',
    `--target=${target}`,
    '--outfile',
    output,
  ],
  { stdio: 'inherit' }
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  throw new Error(`Standalone build failed (${result.status})`);
}

for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) {
  fs.copyFileSync(path.join(root, file), path.join(directory, file));
}

fs.copyFileSync(
  path.join(root, 'vendor/ccr/LICENSE'),
  path.join(directory, 'CCR-LICENSE')
);
fs.copyFileSync(
  path.join(root, `licenses/BUN-${BUN_VERSION}-LICENSE.md`),
  path.join(directory, 'BUN-LICENSE.md')
);
console.log(
  `Built ${output}. Compilation alone is not an OS/runtime verification; run bun run test:e2e on the target OS.`
);
