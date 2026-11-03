const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { plugin } = require('./build.cjs');
async function main() {
  await esbuild.build({ entryPoints: [path.join(__dirname, '../tests/offline.cjs')], outfile: path.join(__dirname, '../dist/offline-tests.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', tsconfigRaw: { compilerOptions: { esModuleInterop: true } }, plugins: [plugin], loader: { '.wasm': 'binary' }, logLevel: 'warning' });
  const standalone = process.argv.includes('--standalone');
  let command = process.execPath;
  let args = [path.join(__dirname, '../dist/offline-tests.cjs')];
  if (standalone) {
    const output = path.join(__dirname, '../dist/offline-tests');
    const compile = spawnSync(process.execPath, ['build', args[0], '--compile', '--outfile', output], { stdio: 'inherit' });
    if (compile.status !== 0) throw new Error('Could not compile standalone test harness');
    command = output; args = [];
  }
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...(standalone ? { PATH: '/nonexistent' } : {}) } });
  process.exitCode = result.status ?? 1;
  if (result.error) throw result.error;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
