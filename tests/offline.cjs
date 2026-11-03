const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-test-'));
process.env.CLAUDE_CODEX_STATE_DIR = fixture;
delete process.env.CLAUDE_GPT_MODEL; delete process.env.CLAUDE_GPT_EFFORT;
const state = require('../src/state.cjs');
const { createRouter } = require('../src/transport/server.ts');
const { login } = require('../src/auth.cjs');
const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
const fresh = { access_token: jwt({ exp: Date.now() / 1000 + 3600 }), refresh_token: 'fake-refresh', account_id: 'test-account' };
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function upstreamResponse(model, output = [{ id: 'msg_test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }]) {
  return { id: 'resp_test', object: 'response', status: 'completed', model, output, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
}
async function main() {
  assert.equal(state.runtime, fixture);
  assert.deepEqual(state.readSettings(), state.defaults);
  assert.equal(state.readSettings().reasoningEffort, 'high', 'Fresh installations must default to high');
  assert(!fs.existsSync(state.settingsFile), 'reading defaults must not write home');
  state.saveSettings(state.defaults);
  const before = fs.readFileSync(state.settingsFile, 'utf8');
  assert.throws(() => state.saveSettings({ model: 'gpt-6.1-sol', reasoningEffort: 'none' }));
  assert.equal(fs.readFileSync(state.settingsFile, 'utf8'), before);
  assert.equal(fs.statSync(state.settingsFile).mode & 0o777, 0o600);
  const { parseOverrides } = require('../src/session.cjs');
  assert.deepEqual(parseOverrides(['--model=gpt-future-test', '--effort', 'high', '--', '-p', 'hi']), { overrides: { model: 'gpt-future-test', reasoningEffort: 'high' }, rest: ['-p', 'hi'] });
  assert.throws(() => parseOverrides(['--model=']));
  assert.equal(state.activeSettings({ reasoningEffort: 'low' }, { CLAUDE_GPT_EFFORT: 'high' }).reasoningEffort, 'low');
  console.log('PASS: defaults, atomic private settings, future IDs, effort validation and overrides.');
  state.writeJson(state.authFile, fresh);
  const originalFetch = global.fetch;
  let captured, output, upstreamError, cancellationProbe;
  const streamFrames = response => {
    const message = response.output[0];
    return [sse('response.created', { response: { ...response, status: 'in_progress', output: [] } }),
      sse('response.output_item.added', { output_index: 0, item: { ...message, content: [] } }),
      sse('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
      sse('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: 'o' }),
      sse('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: 'k' }),
      sse('response.output_item.done', { output_index: 0, item: message }), sse('response.completed', { response })];
  };
  global.fetch = async (url, opts) => {
    assert(String(url).includes('chatgpt.com/backend-api/codex/responses'), `Unexpected network: ${url}`);
    captured = JSON.parse(opts.body);
    if (upstreamError) return new Response(JSON.stringify({ error: { message: 'Mock request rejected', type: 'invalid_request_error' } }), { status: upstreamError, headers: { 'Content-Type': 'application/json' } });
    const response = upstreamResponse(captured.model, output);
    if (cancellationProbe) {
      let controller;
      const stream = new ReadableStream({
        start(value) { controller = value; for (const frame of streamFrames(response).slice(0, 4)) controller.enqueue(new TextEncoder().encode(frame)); },
        cancel() { cancellationProbe.cancelled = true; },
      });
      opts.signal?.addEventListener('abort', () => { cancellationProbe.aborted = true; try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} }, { once: true });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(output ? sse('response.completed', { response }) : streamFrames(response).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const app = await createRouter({ key: 'test-key' });
  const headers = { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' };
  const request = { model: 'codex,gpt-6.1-sol', max_tokens: 1024, stream: false, messages: [{ role: 'user', content: 'Reply ok' }], tools: [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] };
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/config', headers })).statusCode, 404);
    const counted = await app.inject({ method: 'POST', url: '/v1/messages/count_tokens', headers, payload: request });
    assert.equal(counted.statusCode, 200, counted.body); assert(counted.json().input_tokens > 0);
    for (const [model, reasoningEffort] of [['gpt-6.1-sol', 'xhigh'], ['gpt-6-astra', 'max'], ['gpt-6.1-terra', 'low'], ['gpt-6-luna', 'high'], ['gpt-future-test', 'high']]) {
      state.saveSettings({ model, reasoningEffort });
      const result = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: request });
      assert.equal(result.statusCode, 200, result.body.slice(0, 1000));
      assert.equal(captured.model, model); assert.equal(captured.reasoning.effort, reasoningEffort);
      assert.equal(captured.stream, true); assert.equal(captured.store, false);
      if (model !== 'gpt-future-test') assert.equal(captured.input[0].type, 'additional_tools', model);
      else assert(captured.tools?.length, 'Unknown future IDs use standard Responses until the transport catalog recognizes Lite');
      assert.equal(result.json().content[0].text, 'ok');
    }
    process.env.CLAUDE_GPT_MODEL = 'gpt-6-astra'; process.env.CLAUDE_GPT_EFFORT = 'max';
    const overridden = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: request });
    assert.equal(overridden.statusCode, 200); assert.equal(captured.model, 'gpt-6-astra'); assert.equal(captured.reasoning.effort, 'max');
    delete process.env.CLAUDE_GPT_MODEL; delete process.env.CLAUDE_GPT_EFFORT;
    output = [{ id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }];
    const tool = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: request });
    assert.equal(tool.statusCode, 200, tool.body);
    const call = tool.json().content.find(item => item.type === 'tool_use');
    assert(call, tool.body); assert.equal(call.name, 'read_file'); assert.deepEqual(call.input, { path: 'a.txt' });
    output = undefined;
    const followup = structuredClone(request);
    followup.messages.push({ role: 'assistant', content: [call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'file contents' }] });
    const followupResult = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: followup });
    assert.equal(followupResult.statusCode, 200, followupResult.body);
    assert(JSON.stringify(captured.input).includes('file contents'));
    const streamed = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: { ...request, stream: true } });
    assert.equal(streamed.statusCode, 200, streamed.body); assert(streamed.body.includes('message_start')); assert(streamed.body.includes('message_stop'));
    const deltas = streamed.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta').map(event => event.delta.text).join('');
    assert.equal(deltas, 'ok');
    upstreamError = 400;
    const bad = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: request });
    assert(bad.statusCode >= 400, bad.body);
    upstreamError = undefined;
    console.log('PASS: actual source-backed CCR, 5 hot-switched model IDs, overrides, Responses Lite, tools/results, incremental SSE, auth and provider errors (mock upstream).');
    cancellationProbe = { aborted: false, cancelled: false };
    await app.listen({ host: '127.0.0.1', port: 0 });
    const clientAbort = new AbortController();
    const streamResponse = await originalFetch(`http://127.0.0.1:${app.server.address().port}/v1/messages`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }), signal: clientAbort.signal });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    assert.equal((await reader.read()).done, false);
    clientAbort.abort();
    await reader.cancel().catch(() => {});
    const deadline = Date.now() + 3000;
    while (!cancellationProbe.aborted && !cancellationProbe.cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert(cancellationProbe.aborted || cancellationProbe.cancelled, 'client cancellation must abort upstream fetch or cancel its stream');
    console.log('PASS: disconnecting a real loopback SSE client cancels the mocked upstream stream.');
  } finally { global.fetch = originalFetch; await app.close(); }
  // OAuth from a clean directory: browser callback and token endpoint are mocked.
  fs.unlinkSync(state.authFile);
  await login({ port: 0, onUrl: async (url, address) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    const base = `http://127.0.0.1:${address.port}/auth/callback`;
    assert.equal((await originalFetch(`${base}?code=fake&state=wrong`)).status, 400);
    assert.equal((await originalFetch(`${base}?code=fake&state=${parsed.searchParams.get('state')}`)).status, 200);
  }, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    assert.equal(opts.body.get('code'), 'fake'); assert(opts.body.get('code_verifier'));
    return Response.json({ ...fresh, id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }) });
  } });
  assert(state.requireAuth().refresh_token); assert.equal(fs.statSync(state.authFile).mode & 0o777, 0o600);
  await assert.rejects(login({ port: 0, timeout: 20, onUrl: () => {} }), /timed out/);
  console.log('PASS: clean PKCE OAuth, invalid state, private token storage and timeout cleanup (mock token endpoint).');
  // The same refresh helper as the real transformer is tested without real tokens.
  state.writeJson(state.authFile, { ...fresh, access_token: jwt({ exp: 1 }), expires_at: 1 });
  process.env.CCR_CODEX_AUTH_FILE = state.authFile;
  let refreshed = 0;
  global.fetch = async () => { refreshed++; return Response.json({ ...fresh, refresh_token: 'rotated-fake' }); };
  try {
    const auth = require('../vendor/ccr/core/src/utils/codex-auth.ts');
    await Promise.all([auth.getValidAccessToken(), auth.getValidAccessToken()]);
    assert.equal(refreshed, 1); assert.equal(state.requireAuth().refresh_token, 'rotated-fake');
  } finally { global.fetch = originalFetch; }
  console.log('PASS: CCR refresh helper deduplicates simultaneous refresh and atomically persists rotation (mock endpoint).');
  const source = path.join(fixture, 'migration-source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify(state.defaults));
  const { migrate } = require('../src/migrate.cjs');
  assert.throws(() => migrate(['--from', source]), /overwrite/);
  fs.unlinkSync(state.settingsFile); migrate(['--from', source]);
  assert.deepEqual(state.readSettings(), state.defaults);
  const commands = path.join(fixture, 'claude'); process.env.CLAUDE_CONFIG_DIR = commands;
  const { setup } = require('../src/setup.cjs');
  setup([]); setup([]); setup(['--remove']);
  fs.writeFileSync(path.join(commands, 'commands', 'codex-model.md'), 'foreign command');
  assert.throws(() => setup([]), /foreign command/);
  assert.equal(fs.readFileSync(path.join(commands, 'commands', 'codex-model.md'), 'utf8'), 'foreign command');
  console.log('PASS: explicit migration refuses overwrite; slash setup is idempotent and preserves foreign commands.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(fixture, { recursive: true, force: true }));
