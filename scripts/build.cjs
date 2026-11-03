#!/usr/bin/env bun
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const core = path.join(root, 'vendor/ccr/core/src');
const resolve = file => path.join(root, file);
const tiktokenDir = path.dirname(require.resolve('tiktoken'));
const plugin = {
  name: 'codex-source-adapter',
  setup(build) {
    build.onResolve({ filter: /^@caeliq\/ccr-shared$/ }, () => ({ path: resolve('src/transport/shared.ts') }));
    build.onResolve({ filter: /^@\/transformer$/ }, () => ({ path: resolve('src/transport/registry.ts') }));
    build.onResolve({ filter: /^@\// }, args => {
      const file = path.join(core, args.path.slice(2));
      return { path: fs.existsSync(file + '.ts') ? file + '.ts' : path.join(file, 'index.ts') };
    });
    build.onResolve({ filter: /^tiktoken$/ }, () => ({ path: resolve('src/transport/tiktoken.cjs') }));
    build.onResolve({ filter: /^tiktoken-bindings$/ }, () => ({ path: path.join(tiktokenDir, 'tiktoken_bg.cjs') }));
    build.onResolve({ filter: /^tiktoken-wasm$/ }, () => ({ path: path.join(tiktokenDir, 'tiktoken_bg.wasm') }));
    build.onResolve({ filter: /^\.\/token-count-worker$/ }, args => args.importer === path.join(core, 'utils/router.ts') ? { path: resolve('src/transport/token-count.ts') } : undefined);
  }
};
async function main() {
  fs.mkdirSync(resolve('dist'), { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: [resolve('src/cli.cjs')], outfile: resolve('dist/cli.cjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', treeShaking: true,
    tsconfigRaw: { compilerOptions: { esModuleInterop: true } },
    plugins: [plugin], loader: { '.wasm': 'binary' }, metafile: true,
    legalComments: 'linked', banner: { js: '#!/usr/bin/env bun' },
  });
  const licenseCount = require('./licenses.cjs').licenses(result.metafile, root);
  console.log(`Collected license texts for ${licenseCount} bundled dependencies.`);
  fs.chmodSync(resolve('dist/cli.cjs'), 0o755);
  fs.writeFileSync(resolve('dist/build-meta.json'), JSON.stringify(result.metafile, null, 2));
  console.log('Built dist/cli.cjs (CCR source adapter, embedded tiktoken WASM).');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { plugin, main };
