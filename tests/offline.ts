import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ContentBlock } from '../src/cli.types';

import type {
  CancellationProbe,
  CapturedRequest,
  FetchImpl,
  ResponseOutputItem,
} from './offline.types';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-test-'));

process.env.CLAUDE_CODEX_STATE_DIR = fixture;
delete process.env.CLAUDE_CODEX_MODEL;
delete process.env.CLAUDE_CODEX_EFFORT;

/**
 * Модули проекта — динамическим импортом после env: state-каталог вычисляется при загрузке
 * модуля, а статические импорты всплыли бы выше присваивания.
 */
const state = await import('../src/state');
const { createRouter } = await import('../src/transport/server');
const { login } = await import('../src/auth');
const originalFetch = globalThis.fetch;

const mockFetch = (impl: FetchImpl) => {
  globalThis.fetch = Object.assign(impl, { preconnect: originalFetch.preconnect });
};

const jwt = (claims: object) => {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
};

const fresh = {
  access_token: jwt({ exp: Date.now() / 1000 + 3600 }),
  refresh_token: 'fake-refresh',
  account_id: 'test-account',
};

const sse = (type: string, data: object) => {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
};

const DEFAULT_OUTPUT: ResponseOutputItem[] = [
  {
    id: 'msg_test',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'ok', annotations: [] }],
  },
];

const upstreamResponse = (model: string, output = DEFAULT_OUTPUT) => {
  return {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    model,
    output,
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
  };
};

type UpstreamResponse = ReturnType<typeof upstreamResponse>;

const streamFrames = (response: UpstreamResponse) => {
  const [message] = response.output;

  return [
    sse('response.created', {
      response: { ...response, status: 'in_progress', output: [] },
    }),
    sse('response.output_item.added', {
      output_index: 0,
      item: { ...message, content: [] },
    }),
    sse('response.content_part.added', {
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
    sse('response.output_text.delta', {
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: 'o',
    }),
    sse('response.output_text.delta', {
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: 'k',
    }),
    sse('response.output_item.done', { output_index: 0, item: message }),
    sse('response.completed', { response }),
  ];
};

try {
  assert.equal(state.runtime, fixture);
  assert.deepEqual(state.readSettings(), state.defaults);
  assert.equal(
    state.readSettings().reasoningEffort,
    'high',
    'Fresh installations must default to high'
  );
  assert(!fs.existsSync(state.settingsFile), 'reading defaults must not write home');
  state.saveSettings(state.defaults);
  const before = fs.readFileSync(state.settingsFile, 'utf8');

  assert.throws(() => {
    return state.saveSettings({ model: 'gpt-6.1-sol', reasoningEffort: 'none' });
  });
  assert.equal(fs.readFileSync(state.settingsFile, 'utf8'), before);
  assert.equal(fs.statSync(state.settingsFile).mode & 0o777, 0o600);
  const { parseOverrides } = await import('../src/session');

  assert.deepEqual(
    parseOverrides(['--model=gpt-future-test', '--effort', 'high', '--', '-p', 'hi']),
    {
      overrides: { model: 'gpt-future-test', reasoningEffort: 'high' },
      rest: ['-p', 'hi'],
    }
  );
  assert.throws(() => {
    return parseOverrides(['--model=']);
  });
  assert.equal(
    state.activeSettings({ reasoningEffort: 'low' }, { CLAUDE_CODEX_EFFORT: 'high' })
      .reasoningEffort,
    'low'
  );
  console.log(
    'PASS: defaults, atomic private settings, future IDs, effort validation and overrides.'
  );
  state.writeJson(state.authFile, fresh);
  let captured: CapturedRequest | undefined;
  let output: ResponseOutputItem[] | undefined;
  let upstreamError: number | undefined;
  let cancellationProbe: CancellationProbe | undefined;

  mockFetch(async (url, opts) => {
    assert(
      String(url).includes('chatgpt.com/backend-api/codex/responses'),
      `Unexpected network: ${url}`
    );
    const request: CapturedRequest = JSON.parse(String(opts?.body));

    captured = request;
    if (upstreamError)
      return new Response(
        JSON.stringify({
          error: { message: 'Mock request rejected', type: 'invalid_request_error' },
        }),
        { status: upstreamError, headers: { 'Content-Type': 'application/json' } }
      );
    const response = upstreamResponse(request.model, output);
    const probe = cancellationProbe;

    if (probe) {
      const { promise: opened, resolve: onOpen } =
        Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of streamFrames(response).slice(0, 4))
            controller.enqueue(new TextEncoder().encode(frame));
          onOpen(controller);
        },
        cancel() {
          probe.isCancelled = true;
        },
      });
      const controller = await opened;

      opts?.signal?.addEventListener(
        'abort',
        () => {
          probe.isAborted = true;

          try {
            controller.error(new DOMException('Aborted', 'AbortError'));
          } catch {
            /**
             * Поток уже закрыт — отменять нечего, достаточно отметки в probe.
             */
          }
        },
        { once: true }
      );

      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }

    return new Response(
      output ? sse('response.completed', { response }) : streamFrames(response).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });

  const lastRequest = () => {
    assert(captured, 'mock upstream received no request');

    return captured;
  };

  const app = await createRouter({ key: 'test-key' });
  const headers = { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' };
  const request = {
    model: 'codex,gpt-6.1-sol',
    max_tokens: 1024,
    stream: false,
    messages: [{ role: 'user', content: 'Reply ok' }],
    tools: [
      {
        name: 'read_file',
        description: 'Read file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  };

  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/config', headers })).statusCode,
      404
    );
    const counted = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers,
      payload: request,
    });

    assert.equal(counted.statusCode, 200, counted.body);
    assert(counted.json().input_tokens > 0);

    for (const [model, reasoningEffort] of [
      ['gpt-6.1-sol', 'xhigh'],
      ['gpt-6-astra', 'max'],
      ['gpt-6.1-terra', 'low'],
      ['gpt-6-luna', 'high'],
      ['gpt-future-test', 'high'],
    ]) {
      state.saveSettings({ model, reasoningEffort });
      const result = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers,
        payload: request,
      });
      const sent = lastRequest();

      assert.equal(result.statusCode, 200, result.body.slice(0, 1000));
      assert.equal(sent.model, model);
      assert.equal(sent.reasoning.effort, reasoningEffort);
      assert.equal(sent.stream, true);
      assert.equal(sent.store, false);
      if (model !== 'gpt-future-test')
        assert.equal(sent.input[0].type, 'additional_tools', model);
      else
        assert(
          sent.tools?.length,
          'Unknown future IDs use standard Responses until the transport catalog recognizes Lite'
        );
      assert.equal(result.json().content[0].text, 'ok');
    }

    process.env.CLAUDE_CODEX_MODEL = 'gpt-6-astra';
    process.env.CLAUDE_CODEX_EFFORT = 'max';
    const overridden = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: request,
    });

    assert.equal(overridden.statusCode, 200);
    assert.equal(lastRequest().model, 'gpt-6-astra');
    assert.equal(lastRequest().reasoning.effort, 'max');
    delete process.env.CLAUDE_CODEX_MODEL;
    delete process.env.CLAUDE_CODEX_EFFORT;
    output = [
      {
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
    ];
    const tool = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: request,
    });

    assert.equal(tool.statusCode, 200, tool.body);
    const call = tool.json().content.find((item: ContentBlock) => {
      return item.type === 'tool_use';
    });

    assert(call, tool.body);
    assert.equal(call.name, 'read_file');
    assert.deepEqual(call.input, { path: 'a.txt' });
    output = undefined;
    const followup = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: [call] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: call.id, content: 'file contents' },
          ],
        },
      ],
    };
    const followupResult = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: followup,
    });

    assert.equal(followupResult.statusCode, 200, followupResult.body);
    assert(JSON.stringify(lastRequest().input).includes('file contents'));
    const streamed = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: { ...request, stream: true },
    });

    assert.equal(streamed.statusCode, 200, streamed.body);
    assert(streamed.body.includes('message_start'));
    assert(streamed.body.includes('message_stop'));
    const deltas = streamed.body.split('\n').reduce((text, line) => {
      if (!line.startsWith('data: ')) {
        return text;
      }

      const event = JSON.parse(line.slice(6));
      const isTextDelta =
        event.type === 'content_block_delta' && event.delta.type === 'text_delta';

      return isTextDelta ? text + event.delta.text : text;
    }, '');

    assert.equal(deltas, 'ok');
    upstreamError = 400;
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: request,
    });

    assert(bad.statusCode >= 400, bad.body);
    upstreamError = undefined;
    console.log(
      'PASS: actual source-backed CCR, 5 hot-switched model IDs, overrides, Responses Lite, tools/results, incremental SSE, auth and provider errors (mock upstream).'
    );
    const probe: CancellationProbe = { isAborted: false, isCancelled: false };

    cancellationProbe = probe;
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const clientAbort = new AbortController();
    const streamResponse = await originalFetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
      signal: clientAbort.signal,
    });

    assert.equal(streamResponse.status, 200);
    assert(streamResponse.body, 'stream response has no body');
    const reader = streamResponse.body.getReader();

    assert.equal((await reader.read()).done, false);
    clientAbort.abort();
    await reader.cancel().catch(() => {});
    const deadline = Date.now() + 3000;

    while (!probe.isAborted && !probe.isCancelled && Date.now() < deadline)
      await new Promise((resolve) => {
        return setTimeout(resolve, 20);
      });
    assert(
      probe.isAborted || probe.isCancelled,
      'client cancellation must abort upstream fetch or cancel its stream'
    );
    console.log(
      'PASS: disconnecting a real loopback SSE client cancels the mocked upstream stream.'
    );
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }

  /**
   * OAuth с чистого каталога: колбэк браузера и token endpoint — моки.
   */
  fs.unlinkSync(state.authFile);
  await login({
    port: 0,
    onUrl: async (url, address) => {
      const parsed = new URL(url);

      assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
      const base = `http://127.0.0.1:${address.port}/auth/callback`;

      assert.equal((await originalFetch(`${base}?code=fake&state=wrong`)).status, 400);
      assert.equal(
        (
          await originalFetch(
            `${base}?code=fake&state=${parsed.searchParams.get('state')}`
          )
        ).status,
        200
      );
    },
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      assert(opts.body instanceof URLSearchParams);
      assert.equal(opts.body.get('code'), 'fake');
      assert(opts.body.get('code_verifier'));

      return Response.json({
        ...fresh,
        id_token: jwt({
          'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' },
        }),
      });
    },
  });
  assert(state.requireAuth().refresh_token);
  assert.equal(fs.statSync(state.authFile).mode & 0o777, 0o600);
  await assert.rejects(login({ port: 0, timeout: 20, onUrl: () => {} }), /timed out/);
  console.log(
    'PASS: clean PKCE OAuth, invalid state, private token storage and timeout cleanup (mock token endpoint).'
  );
  /**
   * Тот же хелпер обновления, что у настоящего трансформера, — без настоящих токенов.
   */
  state.writeJson(state.authFile, {
    ...fresh,
    access_token: jwt({ exp: 1 }),
    expires_at: 1,
  });
  process.env.CCR_CODEX_AUTH_FILE = state.authFile;
  let refreshed = 0;

  mockFetch(async () => {
    refreshed++;

    return Response.json({ ...fresh, refresh_token: 'rotated-fake' });
  });

  try {
    const { getValidAccessToken } =
      await import('../vendor/ccr/core/src/utils/codex-auth');

    await Promise.all([getValidAccessToken(), getValidAccessToken()]);
    assert.equal(refreshed, 1);
    assert.equal(state.requireAuth().refresh_token, 'rotated-fake');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(
    'PASS: CCR refresh helper deduplicates simultaneous refresh and atomically persists rotation (mock endpoint).'
  );
  const commands = path.join(fixture, 'claude');

  process.env.CLAUDE_CONFIG_DIR = commands;
  const { setup } = await import('../src/setup');

  setup([]);
  setup([]);
  setup(['--remove']);
  fs.writeFileSync(path.join(commands, 'commands', 'codex-model.md'), 'foreign command');
  assert.throws(() => {
    return setup([]);
  }, /foreign command/);
  assert.equal(
    fs.readFileSync(path.join(commands, 'commands', 'codex-model.md'), 'utf8'),
    'foreign command'
  );
  console.log('PASS: slash setup is idempotent and preserves foreign commands.');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
