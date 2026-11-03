const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const state = require('./state.cjs');
function migrate(args) {
  if (args.length !== 2 || args[0] !== '--from') throw new Error('Usage: claude-codex migrate --from /path/to/old/state-directory');
  const source = path.resolve(args[1]);
  if (source === state.runtime) throw new Error('Source and destination must differ');
  const pending = [];
  const settingsFile = path.join(source, 'settings.json');
  if (fs.existsSync(settingsFile)) pending.push([state.settingsFile, state.validate(JSON.parse(fs.readFileSync(settingsFile, 'utf8')))]);
  const modern = path.join(source, 'codex_auth.json');
  const legacy = path.join(source, 'codex-auth.json');
  const authPath = fs.existsSync(modern) ? modern : legacy;
  if (fs.existsSync(authPath)) {
    let old;
    try { old = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { throw new Error('Cannot parse source OAuth credentials; use auth login instead'); }
    const auth = old.access_token ? old : { access_token: old.access, refresh_token: old.refresh, account_id: old.accountId, expires_at: Math.floor(old.expires / 1000), token_type: 'Bearer' };
    if (typeof auth.access_token !== 'string' || !auth.access_token || typeof auth.refresh_token !== 'string' || !auth.refresh_token) throw new Error('Source credentials are incomplete; use auth login instead');
    pending.push([state.authFile, auth]);
  }
  if (!pending.length) throw new Error('No supported settings or credentials found in source directory');
  for (const [file] of pending) if (fs.existsSync(file)) throw new Error(`Refusing to overwrite existing state: ${path.basename(file)}. Choose a new state directory or use auth login.`);
  state.ensureState();
  const created = [];
  try {
    for (const [file, data] of pending) {
      const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.migration`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.linkSync(temporary, file); // Atomic create, never replaces existing data.
        created.push(file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  } catch (error) { for (const file of created) fs.rmSync(file, { force: true }); throw error; }
  console.log(`Imported ${pending.map(([file]) => path.basename(file)).join(', ')} into ${state.runtime}. Source files were not changed.`);
  console.log('Do not refresh the copied OAuth credential from both bridges. Prefer a fresh login when switching clients.');
}
module.exports = { migrate };
