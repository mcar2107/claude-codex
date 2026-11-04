import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { plugin } from './build';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'dist/offline-tests.js');
const isStandalone = process.argv.includes('--standalone');

/**
 * Офлайн-тесты идут секунды; зависший тест не должен подвешивать `bun run test` и pre-commit.
 */
const TEST_TIMEOUT_MS = 120_000;

/**
 * Тесты собираются тем же плагином, что и CLI: так они проверяют код с подменами адаптера, а не
 * исходники upstream как есть.
 */
await Bun.build({
  root,
  entrypoints: [path.join(root, 'tests/offline.ts')],
  outdir: path.join(root, 'dist'),
  naming: 'offline-tests.js',
  target: 'bun',
  format: 'esm',
  plugins: [plugin],
  throw: true,
});
let command = process.execPath;
let args = [bundle];

if (isStandalone) {
  const output = path.join(root, 'dist/offline-tests');
  const compile = spawnSync(
    process.execPath,
    ['build', bundle, '--compile', '--outfile', output],
    {
      stdio: 'inherit',
    }
  );

  if (compile.status !== 0) {
    throw new Error('Could not compile standalone test harness');
  }

  command = output;
  args = [];
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  timeout: TEST_TIMEOUT_MS,
  env: { ...process.env, ...(isStandalone ? { PATH: '/nonexistent' } : {}) },
});

/**
 * Код выхода 0 — успех, а не «нет значения»: `||` превратил бы его в 1. null — процесс убит
 * сигналом.
 */
process.exitCode = result.status ?? 1;

if (result.error) {
  throw result.error;
}
