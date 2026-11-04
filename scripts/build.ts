#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

import type { BunPlugin } from 'bun';

import { licenses } from './licenses';

const root = path.resolve(import.meta.dirname, '..');
const core = path.join(root, 'vendor/ccr/core/src');
const tiktokenDir = path.dirname(Bun.resolveSync('tiktoken', root));
const WASM_NAMESPACE = 'tiktoken-wasm';

const resolve = (file: string) => {
  return path.join(root, file);
};

/**
 * Подмены модулей upstream на адаптер `src/transport/` (vendor.md). Те же алиасы повторяет
 * `paths` в tsconfig.json — иначе их не увидит typecheck.
 */
export const plugin: BunPlugin = {
  name: 'codex-source-adapter',
  setup(build) {
    build.onResolve({ filter: /^@caeliq\/ccr-shared$/ }, () => {
      return { path: resolve('src/transport/shared.ts') };
    });
    build.onResolve({ filter: /^@\/transformer$/ }, () => {
      return { path: resolve('src/transport/registry.ts') };
    });
    build.onResolve({ filter: /^@\// }, (args) => {
      const file = path.join(core, args.path.slice(2));

      return {
        path: fs.existsSync(file + '.ts') ? file + '.ts' : path.join(file, 'index.ts'),
      };
    });
    build.onResolve({ filter: /^tiktoken$/ }, () => {
      return { path: resolve('src/transport/tiktoken.ts') };
    });
    build.onResolve({ filter: /^tiktoken-bindings$/ }, () => {
      return { path: path.join(tiktokenDir, 'tiktoken_bg.cjs') };
    });
    build.onResolve({ filter: /^tiktoken-wasm$/ }, () => {
      return {
        path: path.join(tiktokenDir, 'tiktoken_bg.wasm'),
        namespace: WASM_NAMESPACE,
      };
    });
    /**
     * У загрузчиков бандлера Bun нет аналога `binary`: байты WASM встраиваются модулем с
     * base64-строкой, а не путём к файлу — в standalone-бинарнике файла рядом нет.
     */
    build.onLoad({ filter: /\.wasm$/, namespace: WASM_NAMESPACE }, (args) => {
      const base64 = fs.readFileSync(args.path).toString('base64');

      return {
        contents: `export default Buffer.from(${JSON.stringify(base64)}, 'base64');`,
        loader: 'js',
      };
    });
    build.onResolve({ filter: /^\.\/token-count-worker$/ }, (args) => {
      return args.importer === path.join(core, 'utils/router.ts')
        ? { path: resolve('src/transport/token-count.ts') }
        : undefined;
    });
  },
};

export const build = async () => {
  const result = await Bun.build({
    root,
    entrypoints: [resolve('src/cli.ts')],
    outdir: resolve('dist'),
    naming: '[name].[ext]',
    target: 'bun',
    format: 'esm',
    plugins: [plugin],
    metafile: true,
    throw: true,
  });

  if (!result.metafile) throw new Error('Bun.build returned no metafile');
  const licenseCount = licenses(result.metafile, root);

  console.log(`Collected license texts for ${licenseCount} bundled dependencies.`);
  fs.chmodSync(resolve('dist/cli.js'), 0o755);
  fs.writeFileSync(
    resolve('dist/build-meta.json'),
    JSON.stringify(result.metafile, null, 2)
  );
  console.log('Built dist/cli.js (CCR source adapter, embedded tiktoken WASM).');
};

if (import.meta.main) await build();
