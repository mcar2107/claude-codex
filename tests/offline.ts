import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
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

/**
 * Вывод команды в тесте не нужен: проверяется результат в state, а не текст. Асинхронная команда
 * молчит до завершения промиса, а не до его создания, поэтому хелпер всегда ждёт результат.
 */
const quietly = async <T>(action: () => T | Promise<T>): Promise<T> => {
  const { log } = console;

  console.log = () => {};

  try {
    return await action();
  } finally {
    console.log = log;
  }
};

/**
 * Код ошибки подключения к порту: после остановки сервера ожидается `ECONNREFUSED`.
 */
const connectError = (port: number) => {
  return new Promise<string | undefined>((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve(undefined);
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code);
    });
  });
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
  assert.equal(state.RUNTIME_DIR, fixture);
  assert.deepEqual(state.readSettings(), state.DEFAULT_SETTINGS);
  assert.equal(
    state.readSettings().reasoningEffort,
    'high',
    'Fresh installations must default to high'
  );
  assert(!fs.existsSync(state.SETTINGS_FILE), 'reading defaults must not write home');
  state.saveSettings(state.DEFAULT_SETTINGS);
  const before = fs.readFileSync(state.SETTINGS_FILE, 'utf8');

  assert.throws(() => {
    return state.saveSettings({ model: 'gpt-6.1-sol', reasoningEffort: 'none' });
  }, /supported effort levels/);
  assert.equal(fs.readFileSync(state.SETTINGS_FILE, 'utf8'), before);
  assert.equal(fs.statSync(state.SETTINGS_FILE).mode & 0o777, 0o600);
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
  }, /--model/);
  assert.equal(
    state.activeSettings({ reasoningEffort: 'low' }, { CLAUDE_CODEX_EFFORT: 'high' })
      .reasoningEffort,
    'low'
  );
  fs.writeFileSync(state.SETTINGS_FILE, 'null');
  assert.throws(
    () => {
      return state.readSettings();
    },
    new RegExp(`Cannot read ${state.SETTINGS_FILE}.*settings reset`)
  );
  fs.writeFileSync(state.SETTINGS_FILE, before);
  const { settings } = await import('../src/settings');

  assert.throws(() => {
    return settings(['preset', 'constructor']);
  }, /Unknown preset\. Choose sol\|balanced\|fast\|max/);
  await quietly(() => {
    return settings(['preset', 'fast']);
  });
  assert.deepEqual(state.readSettings(), { model: 'gpt-6-luna', reasoningEffort: 'low' });
  await quietly(() => {
    return settings(['set', '--effort', 'high']);
  });
  assert.deepEqual(
    state.readSettings(),
    { model: 'gpt-6-luna', reasoningEffort: 'high' },
    'set changes only the given field'
  );
  assert.throws(() => {
    return settings(['set', '--effort', 'none']);
  }, /supported effort levels/);
  assert.equal(
    state.readSettings().reasoningEffort,
    'high',
    'a rejected set keeps the file'
  );
  await quietly(() => {
    return settings(['show']);
  });
  await quietly(() => {
    return settings(['reset']);
  });
  assert.deepEqual(state.readSettings(), state.DEFAULT_SETTINGS);
  assert.deepEqual(
    fs.readdirSync(fixture).filter((name) => {
      return name.endsWith('.tmp');
    }),
    [],
    'atomic writes leave no temporary files'
  );
  console.log(
    'PASS: defaults, atomic private settings, readable errors for a broken settings file, future IDs, effort validation, presets, settings set/show/reset and overrides.'
  );
  state.writeJson(state.AUTH_FILE, fresh);
  let captured: CapturedRequest | undefined;
  let output: ResponseOutputItem[] | undefined;
  let upstreamError: number | undefined;
  let cancellationProbe: CancellationProbe | undefined;
  let limitHeaders: Record<string, string> = {};

  mockFetch(async (url, opts) => {
    assert(
      String(url).includes('chatgpt.com/backend-api/codex/responses'),
      `Unexpected network: ${url}`
    );
    const upstreamRequest: CapturedRequest = JSON.parse(String(opts?.body));

    captured = upstreamRequest;

    if (upstreamError) {
      return new Response(
        JSON.stringify({
          error: { message: 'Mock request rejected', type: 'invalid_request_error' },
        }),
        { status: upstreamError, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const response = upstreamResponse(upstreamRequest.model, output);
    const cancellation = cancellationProbe;

    if (cancellation) {
      const { promise: opened, resolve: onOpen } =
        Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of streamFrames(response).slice(0, 4)) {
            controller.enqueue(new TextEncoder().encode(frame));
          }

          onOpen(controller);
        },
        cancel() {
          cancellation.isCancelled = true;
        },
      });
      const controller = await opened;

      opts?.signal?.addEventListener(
        'abort',
        () => {
          cancellation.isAborted = true;

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
      { headers: { 'Content-Type': 'text/event-stream', ...limitHeaders } }
    );
  });

  const lastRequest = () => {
    assert(captured, 'mock upstream received no request');

    return captured;
  };

  const limitsFile = path.join(fixture, 'session-test', 'rate-limits.json');
  const requestFile = path.join(fixture, 'session-test', 'last-request.json');

  /**
   * Настройки сессии — снимок на старте роутера: сохранённые после него сессию не меняют.
   */
  state.saveSettings({ model: 'gpt-6-luna', reasoningEffort: 'low' });
  const app = await createRouter({ key: 'test-key', limitsFile, requestFile });
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

  const post = (payload: object) => {
    return app.inject({ method: 'POST', url: '/v1/messages', headers, payload });
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
    const uncounted = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers,
    });

    assert.equal(uncounted.statusCode, 400, 'count_tokens without a body');
    state.saveSettings({ model: 'gpt-5.5', reasoningEffort: 'high' });

    for (const [model, reasoningEffort] of [
      ['gpt-6.1-sol', 'xhigh'],
      ['gpt-6-astra', 'max'],
      ['gpt-6.1-terra', 'low'],
      ['gpt-6-luna', 'high'],
      ['gpt-future-test', 'high'],
    ]) {
      const result = await post({
        ...request,
        model: `codex,${model}`,
        output_config: { effort: reasoningEffort },
      });
      const sent = lastRequest();

      assert.equal(result.statusCode, 200, result.body.slice(0, 1000));
      assert.equal(sent.model, model);
      assert.equal(sent.reasoning.effort, reasoningEffort);
      assert.equal(sent.stream, true);
      assert.equal(sent.store, false);

      if (model !== 'gpt-future-test') {
        assert.equal(sent.input[0].type, 'additional_tools', model);
      } else {
        assert(
          sent.tools?.length,
          'Unknown future IDs use standard Responses until the transport catalog recognizes Lite'
        );
      }

      assert.equal(result.json().content[0].text, 'ok');
    }

    /**
     * Не модель Codex и без effort — стартовые модель и уровень сессии, хотя сохранённые настройки
     * с тех пор сменились.
     */
    const fallback = await post({ ...request, model: 'claude-haiku-4-5' });

    assert.equal(fallback.statusCode, 200, fallback.body);
    assert.equal(lastRequest().model, 'gpt-6-luna');
    assert.equal(lastRequest().reasoning.effort, 'low');
    const clamped = await post({
      ...request,
      model: 'codex,gpt-5.5',
      output_config: { effort: 'max' },
    });

    assert.equal(clamped.statusCode, 200, clamped.body);
    assert.equal(lastRequest().model, 'gpt-5.5');
    assert.equal(
      lastRequest().reasoning.effort,
      'xhigh',
      'unsupported max falls back to xhigh'
    );

    const readLastRequest = () => {
      return JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    };

    const returnedBy = Date.now() + 2000;

    while (!readLastRequest().returnedModel && Date.now() < returnedBy) {
      await new Promise((resolve) => {
        return setTimeout(resolve, 10);
      });
    }

    const lastRecord = readLastRequest();

    assert.deepEqual(lastRecord.client, { model: 'codex,gpt-5.5', effort: 'max' });
    assert.deepEqual(lastRecord.upstream, { model: 'gpt-5.5', effort: 'xhigh' });
    assert.equal(lastRecord.returnedModel, 'gpt-5.5', 'model from the Codex response');
    /**
     * Сессия с `--effort max`: сохранённая позже модель без `max` не должна ронять её запросы.
     */
    state.saveSettings({ model: 'gpt-6-luna', reasoningEffort: 'low' });
    process.env.CLAUDE_CODEX_EFFORT = 'max';
    const overrideApp = await createRouter({ key: 'test-key' });

    delete process.env.CLAUDE_CODEX_EFFORT;

    try {
      state.saveSettings({ model: 'gpt-5.5', reasoningEffort: 'high' });

      const postOverride = (payload: object) => {
        return overrideApp.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload,
        });
      };

      const overridden = await postOverride({ ...request, model: 'sonnet' });

      assert.equal(overridden.statusCode, 200, overridden.body);
      assert.equal(lastRequest().model, 'gpt-6-luna');
      assert.equal(lastRequest().reasoning.effort, 'max');
      const selected = await postOverride(request);

      assert.equal(selected.statusCode, 200, selected.body);
      assert.equal(lastRequest().model, 'gpt-6.1-sol');
      assert.equal(lastRequest().reasoning.effort, 'max');
    } finally {
      await overrideApp.close();
    }

    assert(!fs.existsSync(limitsFile), 'no Codex limit headers, no snapshot');
    const now = Math.floor(Date.now() / 1000);

    limitHeaders = {
      'x-codex-primary-used-percent': '42.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(now + 3600),
      'x-codex-secondary-used-percent': '7',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '86400',
    };
    const limited = await post(request);

    assert.equal(limited.statusCode, 200, limited.body);
    const snapshot = JSON.parse(fs.readFileSync(limitsFile, 'utf8'));

    assert.deepEqual(snapshot.five_hour, {
      used_percentage: 42.5,
      resets_at: now + 3600,
    });
    assert.equal(snapshot.seven_day.used_percentage, 7);
    assert(Math.abs(snapshot.seven_day.resets_at - (now + 86400)) <= 2);
    limitHeaders = {};
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
    const tool = await post(request);

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
    const followupResult = await post(followup);

    assert.equal(followupResult.statusCode, 200, followupResult.body);
    assert(JSON.stringify(lastRequest().input).includes('file contents'));
    const streamed = await post({ ...request, stream: true });

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
    const bad = await post(request);

    assert.equal(bad.statusCode, 400, bad.body);
    assert.match(bad.body, /Mock request rejected/);
    upstreamError = undefined;
    console.log(
      'PASS: actual source-backed CCR, client-selected model/effort for 5 IDs, startup settings fallback unaffected by later saves, effort clamping, overrides, count_tokens validation, Codex limit snapshot, last request record with the returned model, Responses Lite, tools/results, incremental SSE, auth and provider errors (mock upstream).'
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

    while (!probe.isAborted && !probe.isCancelled && Date.now() < deadline) {
      await new Promise((resolve) => {
        return setTimeout(resolve, 20);
      });
    }

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
  fs.unlinkSync(state.AUTH_FILE);
  await login({
    port: 0,
    onUrl: async (url, address) => {
      const parsed = new URL(url);

      assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(
        parsed.searchParams.get('redirect_uri'),
        `http://localhost:${address.port}/auth/callback`
      );
      const base = `http://127.0.0.1:${address.port}/auth/callback`;
      /**
       * Битый request-target не должен уронить логин: ответ 400, колбэк ждётся дальше.
       */
      const malformed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(address.port, '127.0.0.1', () => {
          socket.end('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        });
        let reply = '';

        socket.on('data', (chunk) => {
          reply += chunk;
        });
        socket.once('end', () => {
          return resolve(reply);
        });
        socket.once('error', reject);
      });

      assert.match(malformed, /^HTTP\/1\.1 400/);

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
  assert.equal(fs.statSync(state.AUTH_FILE).mode & 0o777, 0o600);
  let timedOutPort = 0;

  await assert.rejects(
    login({
      port: 0,
      timeout: 20,
      onUrl: (_url, { port }) => {
        timedOutPort = port;
      },
    }),
    /timed out/
  );
  assert(timedOutPort > 0);
  assert.equal(
    await connectError(timedOutPort),
    'ECONNREFUSED',
    'the callback server is closed after a timeout'
  );
  console.log(
    'PASS: clean PKCE OAuth, redirect URI from the listening port, malformed and invalid-state callbacks, private token storage and timeout cleanup (mock token endpoint).'
  );
  /**
   * Тот же хелпер обновления, что у настоящего трансформера, — без настоящих токенов.
   */
  state.writeJson(state.AUTH_FILE, {
    ...fresh,
    access_token: jwt({ exp: 1 }),
    expires_at: 1,
  });
  state.exposeAuthFile();
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

  const { validTokens, withBridgeHint } = await import('../src/auth');

  state.writeJson(state.AUTH_FILE, { access_token: jwt({ exp: 1 }), expires_at: 1 });
  await assert.rejects(validTokens(), (error: Error) => {
    assert.match(error.message, /claude-codex auth login/);
    assert.doesNotMatch(error.message, /ccr codex-auth/);

    return true;
  });
  assert.equal(withBridgeHint('not an error'), 'not an error');
  state.writeJson(state.AUTH_FILE, fresh);
  console.log(
    'PASS: CCR refresh helper deduplicates simultaneous refresh and atomically persists rotation; its errors name claude-codex auth login (mock endpoint).'
  );
  const claudeDir = path.join(fixture, 'claude');

  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const { setup } = await import('../src/setup');

  assert.throws(() => {
    return setup([]);
  }, /setup --remove/);
  const logged: unknown[] = [];
  const { log } = console;

  console.log = (...args: unknown[]) => {
    logged.push(...args);
  };

  try {
    setup(['--remove']);
  } finally {
    console.log = log;
  }

  assert.match(String(logged[0]), /^No claude-codex slash commands found/);
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'commands', 'codex-model.md'), 'foreign command');
  assert.throws(() => {
    return setup(['--remove']);
  }, /foreign command/);
  assert.equal(
    fs.readFileSync(path.join(claudeDir, 'commands', 'codex-model.md'), 'utf8'),
    'foreign command'
  );
  console.log('PASS: legacy slash removal preserves foreign commands.');
  const { codexRateLimits } = await import('../src/transport/limits');
  const { withRateLimits } = await import('../src/statusline');

  assert.equal(codexRateLimits(new Headers()), undefined);
  assert.deepEqual(
    codexRateLimits(
      new Headers({
        'x-codex-primary-used-percent': '10',
        'x-codex-secondary-used-percent': '20',
        'x-codex-secondary-window-minutes': '60',
      })
    ),
    { five_hour: { used_percentage: 10 } },
    'a window without a statusline slot is skipped'
  );
  const { responseEvent } = await import('../src/transport/last-request');

  assert.equal(responseEvent('event: x\ndata: {"type":"ping"}\n'), undefined);
  assert.deepEqual(
    responseEvent(
      'data: {"type":"response.created","response":{"model":"gpt-6-luna"}}\n'
    ),
    { model: 'gpt-6-luna' }
  );
  assert.deepEqual(responseEvent('data: {"response":{}}\n'), { model: undefined });
  assert.equal(responseEvent('data: {"response":{"mod'), undefined, 'partial line waits');
  const statusInput = JSON.stringify({ model: { display_name: 'GPT-6.1 Sol' } });
  const nowMs = Date.now();
  const augmented = JSON.parse(
    withRateLimits(
      statusInput,
      {
        five_hour: { used_percentage: 50, resets_at: nowMs / 1000 + 60 },
        seven_day: { used_percentage: 5, resets_at: nowMs / 1000 - 60 },
      },
      nowMs
    )
  );

  assert.equal(augmented.model.display_name, 'GPT-6.1 Sol');
  assert.equal(augmented.rate_limits.five_hour.used_percentage, 50);
  assert.equal(augmented.rate_limits.seven_day, undefined, 'a reset window is stale');
  assert.equal(withRateLimits(statusInput, undefined), statusInput);
  assert.equal(
    withRateLimits('not json', { five_hour: { used_percentage: 1 } }),
    'not json'
  );
  const ownLimits = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 99 } },
  });

  assert.equal(
    withRateLimits(ownLimits, { five_hour: { used_percentage: 1 } }),
    ownLimits
  );
  console.log(
    'PASS: Codex limit headers map to statusline rate_limits; stale windows and client limits are respected.'
  );
  const client = await import('../src/client');

  assert.equal(client.modelLabel('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(client.modelLabel('gpt-5.3-codex-spark'), 'GPT-5.3 Codex Spark');
  assert.deepEqual(client.extractSettings(['-p', 'hi', '--settings={"a":1}']), {
    settings: { a: 1 },
    rest: ['-p', 'hi'],
  });
  assert.throws(() => {
    return client.extractSettings(['--settings', '[1]']);
  }, /--settings/);
  const project = path.join(fixture, 'project');

  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  const userSettings = path.join(claudeDir, 'settings.json');

  fs.writeFileSync(
    userSettings,
    JSON.stringify({
      model: 'opus',
      theme: 'dark',
      statusLine: { type: 'command', command: 'echo user', padding: 1 },
    }),
    { mode: 0o644 }
  );
  assert.equal(
    client.resolveStatusLine(undefined, project, claudeDir)?.command,
    'echo user'
  );
  fs.writeFileSync(
    path.join(project, '.claude', 'settings.local.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo local' } })
  );
  assert.equal(
    client.resolveStatusLine(undefined, project, claudeDir)?.command,
    'echo local'
  );
  assert.equal(
    client.resolveStatusLine(
      { statusLine: { type: 'command', command: 'echo flag' } },
      project,
      claudeDir
    )?.command,
    'echo flag'
  );
  fs.rmSync(path.join(project, '.claude', 'settings.local.json'));
  const session = fs.mkdtempSync(path.join(fixture, 'session-'));
  const clientEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', ANTHROPIC_MODEL: 'opus' };
  const clientArgs = client.prepareClient({
    session,
    active: { model: 'gpt-6-astra', reasoningEffort: 'max' },
    clientArgs: ['-p', 'hi', '--settings', '{"theme":"light"}'],
    env: clientEnv,
    cwd: project,
  });

  assert.deepEqual(clientArgs.slice(-4), ['--effort', 'max', '-p', 'hi']);
  assert.equal(clientArgs[clientArgs.indexOf('--model') + 1], 'codex,gpt-6-astra');
  const clientSettings = JSON.parse(
    fs.readFileSync(clientArgs[clientArgs.indexOf('--settings') + 1], 'utf8')
  );

  assert.equal(clientSettings.theme, 'light');
  assert.equal(clientSettings.modelPicker.replaceBuiltInOptions, true);
  assert(
    clientSettings.modelPicker.options.every((row: unknown) => {
      return (
        typeof row === 'object' &&
        row !== null &&
        String(Reflect.get(row, 'model')).startsWith('codex,gpt-')
      );
    })
  );
  assert.equal(clientSettings.statusLine.padding, 1);
  assert(clientSettings.statusLine.command.includes('__statusline'));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(session, 'statusline.json'), 'utf8')).command,
    'echo user'
  );
  const plugin = clientArgs[clientArgs.indexOf('--plugin-dir') + 1];

  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')
    ).name,
    'codex'
  );
  assert(fs.existsSync(path.join(plugin, 'commands', 'settings.md')));
  assert(clientEnv.PATH?.startsWith(path.join(session, 'bin')));
  assert.equal(
    fs.statSync(path.join(session, 'bin', 'claude-codex')).mode & 0o100,
    0o100
  );
  assert.equal(clientEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'codex,gpt-6-astra');
  assert.equal(
    clientEnv.ANTHROPIC_MODEL,
    undefined,
    'the session model comes from --model'
  );
  assert.equal(clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, 'unknown window');
  const legacyEnv: NodeJS.ProcessEnv = {};
  const legacyArgs = client.prepareClient({
    session,
    active: { model: 'gpt-5.2', reasoningEffort: 'none' },
    clientArgs: [],
    env: legacyEnv,
    cwd: project,
  });

  assert(!legacyArgs.includes('--effort'));
  assert.equal(legacyEnv.CLAUDE_CODE_EFFORT_LEVEL, 'unset');
  console.log(
    'PASS: session client gets Codex /model rows, merged --settings, wrapped statusLine, plugin commands and PATH shim.'
  );
  const modelSnapshot = client.snapshotUserModel(userSettings);

  assert.deepEqual(modelSnapshot, { file: userSettings, hasModel: true, model: 'opus' });
  assert.equal(client.restoreUserModel(modelSnapshot), undefined, 'unchanged file');
  const saved = JSON.parse(fs.readFileSync(userSettings, 'utf8'));

  fs.writeFileSync(userSettings, JSON.stringify({ ...saved, model: 'codex,gpt-6-luna' }));
  fs.chmodSync(userSettings, 0o644);
  assert.match(client.restoreUserModel(modelSnapshot) || '', /codex,gpt-6-luna/);
  const restored = JSON.parse(fs.readFileSync(userSettings, 'utf8'));

  assert.equal(restored.model, 'opus');
  assert.equal(restored.theme, 'dark', 'other user settings survive');
  assert.equal(fs.statSync(userSettings).mode & 0o777, 0o644);
  fs.writeFileSync(userSettings, JSON.stringify({ ...saved, model: 'sonnet' }));
  assert.equal(client.restoreUserModel(modelSnapshot), undefined, 'foreign change stays');
  const noModel = path.join(fixture, 'no-model.json');

  fs.writeFileSync(noModel, '{}');
  const emptySnapshot = client.snapshotUserModel(noModel);

  fs.writeFileSync(noModel, JSON.stringify({ model: 'codex,gpt-6-astra' }));
  client.restoreUserModel(emptySnapshot);
  assert.deepEqual(JSON.parse(fs.readFileSync(noModel, 'utf8')), {});
  /**
   * Настройки из dotfiles: восстановление пишет в цель симлинка, симлинк остаётся.
   */
  const dotfile = path.join(fixture, 'dotfiles-settings.json');
  const linked = path.join(fixture, 'linked-settings.json');

  fs.writeFileSync(dotfile, JSON.stringify({ model: 'opus' }));
  fs.symlinkSync(dotfile, linked);
  const linkedSnapshot = client.snapshotUserModel(linked);

  fs.writeFileSync(dotfile, JSON.stringify({ model: 'codex,gpt-6-luna' }));
  client.restoreUserModel(linkedSnapshot);
  assert(fs.lstatSync(linked).isSymbolicLink(), 'the symlink survives');
  assert.equal(JSON.parse(fs.readFileSync(dotfile, 'utf8')).model, 'opus');
  console.log(
    'PASS: a Codex model saved by /model is restored in user settings on exit, through a symlink; foreign edits are kept.'
  );
  /**
   * Релиз — архив со скриптом вместо бинарника: `--version` печатает версию, которую ему задали.
   */
  const { installRelease, latestReleaseUrl, update } = await import('../src/update');
  const { version: currentVersion } = (await import('../package.json')).default;
  const asset = 'claude-codex-test-x64';
  const installDir = path.join(fixture, 'bin');
  const target = path.join(installDir, 'claude-codex');
  const shareDir = path.join(fixture, 'share');
  const missingShareDir = path.join(fixture, 'no-share');
  const fileShareDir = path.join(fixture, 'share-file');

  const releaseArchive = async (reported: string) => {
    return new Bun.Archive(
      {
        [`${asset}/claude-codex`]: `#!/bin/sh\necho ${reported}\n`,
        [`${asset}/LICENSE`]: `license ${reported}`,
      },
      { compress: 'gzip' }
    ).bytes();
  };

  /**
   * Отвечает на оба канала: тесты идут и на prerelease-версии из `package.json`.
   */
  const serveRelease = (archive: Uint8Array, sums: string, latest = 'v9.9.9') => {
    const requested: string[] = [];

    mockFetch(async (url) => {
      const href = String(url);

      requested.push(href);

      if (href.endsWith('/releases/latest')) {
        return Response.json({ tag_name: latest });
      }

      if (href.endsWith('/releases?per_page=1')) {
        return Response.json([{ tag_name: latest }]);
      }

      if (href.endsWith(`/${latest}/${asset}.tar.gz`)) {
        /**
         * Копия — `Uint8Array<ArrayBuffer>`: `bytes()` архива типизирован `ArrayBufferLike`, а его
         * `BodyInit` не принимает.
         */
        return new Response(archive.slice());
      }

      if (href.endsWith(`/${latest}/SHA256SUMS`)) {
        return new Response(sums);
      }

      return new Response('not found', { status: 404 });
    });

    return requested;
  };

  const sha256 = (bytes: Uint8Array) => {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  };

  const goodArchive = await releaseArchive('9.9.9');
  const goodSums = `${sha256(goodArchive)}  ${asset}.tar.gz\n`;

  fs.mkdirSync(installDir);
  fs.mkdirSync(shareDir);
  fs.writeFileSync(fileShareDir, 'not a directory');
  fs.writeFileSync(target, 'old binary');
  assert.match(latestReleaseUrl('1.0.0'), /\/releases\/latest$/);
  assert.match(
    latestReleaseUrl('1.1.0-dev.1'),
    /\/releases\?per_page=1$/,
    'a prerelease follows the newest release, as install.sh does'
  );

  try {
    await assert.rejects(update(['v1.0.0', 'v1.0.1']), /Usage: claude-codex update/);
    await assert.rejects(update(['--force']), /Usage: claude-codex update/);

    /**
     * Скомпилированный тест сам standalone: там `update` заменил бы бинарник теста.
     */
    if (!state.isStandalone()) {
      await assert.rejects(update([]), /replaces the standalone binary/);
    }

    const older = serveRelease(goodArchive, goodSums, 'v0.0.1');

    assert.equal(
      await quietly(() => {
        return installRelease({ target, asset, shareDir });
      }),
      0
    );
    assert.equal(older.length, 1, 'an older latest release is not downloaded');
    assert.equal(fs.readFileSync(target, 'utf8'), 'old binary');
    serveRelease(goodArchive, `${'0'.repeat(64)}  ${asset}.tar.gz\n`);
    await assert.rejects(
      quietly(() => {
        return installRelease({ target, asset, shareDir });
      }),
      /Checksum mismatch/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'old binary');
    const wrongArchive = await releaseArchive('1.2.3');

    serveRelease(wrongArchive, `${sha256(wrongArchive)}  ${asset}.tar.gz\n`);
    await assert.rejects(
      quietly(() => {
        return installRelease({ target, asset, shareDir });
      }),
      /does not run as 9\.9\.9 \(reported 1\.2\.3\)/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'old binary');
    assert.deepEqual(
      fs.readdirSync(installDir),
      ['claude-codex'],
      'no temporary file left'
    );
    serveRelease(goodArchive, goodSums);
    assert.equal(
      await quietly(() => {
        return installRelease({ target, asset, shareDir: missingShareDir });
      }),
      0
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\necho 9.9.9\n');
    assert(!fs.existsSync(missingShareDir), 'a missing share directory is not created');
    fs.writeFileSync(target, 'old binary');
    serveRelease(goodArchive, goodSums);
    const { error } = console;
    const warnings: string[] = [];

    console.error = (message: unknown) => {
      warnings.push(String(message));
    };

    try {
      assert.equal(
        await quietly(() => {
          return installRelease({ target, asset, shareDir: fileShareDir });
        }),
        0,
        'a failed license refresh does not fail the update'
      );
    } finally {
      console.error = error;
    }

    assert.match(warnings.join('\n'), /could not update license notices/);
    assert.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\necho 9.9.9\n');
    fs.writeFileSync(target, 'old binary');
    serveRelease(goodArchive, goodSums);
    assert.equal(
      await quietly(() => {
        return installRelease({ target, asset, shareDir });
      }),
      0
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\necho 9.9.9\n');
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
    assert.equal(
      fs.readFileSync(path.join(shareDir, 'LICENSE'), 'utf8'),
      'license 9.9.9'
    );
    assert(
      !fs.existsSync(path.join(shareDir, 'claude-codex')),
      'the binary stays out of share'
    );
    const sameVersion = serveRelease(goodArchive, goodSums);

    await quietly(() => {
      return installRelease({ tag: `v${currentVersion}`, target, asset, shareDir });
    });
    assert.deepEqual(sameVersion, [], 'the current version is not downloaded');
    await assert.rejects(
      installRelease({ tag: 'latest', target, asset, shareDir }),
      /Expected a release tag/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(
    'PASS: update installs the latest release of its channel only after SHA256 and --version checks, never downgrades without a tag, refreshes licenses only in an existing share directory and only warns if that fails; failures keep the old binary; bad arguments are rejected.'
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
