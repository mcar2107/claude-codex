import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

import type { JwtClaims, LoginOptions, TokenExchange } from './auth.types';
import * as state from './state';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/**
 * Порт колбэка, зарегистрированный у OAuth-клиента Codex: redirect URI строится из фактического
 * порта, и другой порт (тесты слушают на нулевом) годится только с моком token endpoint.
 */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';

const redirectUri = (port: number) => {
  return `http://localhost:${port}${CALLBACK_PATH}`;
};

const claims = (token: string | undefined): JwtClaims => {
  try {
    return JSON.parse(
      Buffer.from(token?.split('.')[1] || '', 'base64url').toString('utf8')
    );
  } catch {
    return {};
  }
};

/**
 * Обязательные поля проверяются в рантайме: ответ token endpoint — внешний ввод.
 */
const isTokenExchange = (value: unknown): value is TokenExchange => {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['access_token', 'refresh_token', 'id_token'].every((key) => {
      const field: unknown = Reflect.get(value, key);

      return typeof field === 'string' && field;
    })
  );
};

export const status = () => {
  if (!fs.existsSync(state.authFile)) {
    console.log('OAuth credentials: missing\nRun: claude-codex auth login');

    return 1;
  }

  const auth = state.requireAuth();
  const expiry = claims(auth.access_token).exp || auth.expires_at;

  console.log(
    `OAuth credentials: present\nAccess expires: ${typeof expiry === 'number' && Number.isFinite(expiry) ? new Date(expiry * 1000).toISOString() : 'unknown'}\nRefresh token: ${auth.refresh_token ? 'present' : 'missing'}`
  );

  return 0;
};

export const validTokens = async () => {
  state.requireAuth();
  process.env.CCR_CODEX_AUTH_FILE = state.authFile;
  const { getValidAccessToken } = await import('../vendor/ccr/core/src/utils/codex-auth');

  return getValidAccessToken();
};

export const login = async ({
  port = CALLBACK_PORT,
  onUrl = (url) => {
    return console.log(`Open this URL in your browser (valid for 5 minutes):\n${url}`);
  },
  fetchImpl = fetch,
  timeout = 300000,
  signal,
}: LoginOptions = {}) => {
  state.ensureState();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  /**
   * Задаётся после listen: redirect URI — с портом, который реально слушает сервер.
   */
  let redirect = redirectUri(port);
  const {
    promise: done,
    resolve: finish,
    reject: fail,
  } = Promise.withResolvers<number>();
  let isBusy = false;

  /**
   * Обработчик отказа вешается до listen и колбэков: иначе они успеют отклонить промис без обработчика.
   */
  done.catch(() => {});
  const controller = new AbortController();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    let callback: URL;

    try {
      callback = new URL(request.url || '/', 'http://localhost');
    } catch {
      /**
       * Битый request-target (`//`) — не наш колбэк: отвечаем 400 и ждём настоящий. Исключение
       * из обработчика уронило бы процесс логина.
       */
      response.writeHead(400).end();

      return;
    }

    if (request.method !== 'GET' || callback.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();

      return;
    }

    const provided = Buffer.from(callback.searchParams.get('state') || '');
    const expected = Buffer.from(nonce);

    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      response.writeHead(400).end('Invalid OAuth state.');

      return;
    }

    if (callback.searchParams.has('error')) {
      response.writeHead(400).end('Authorization denied. Return to your terminal.');
      fail(new Error('OAuth authorization was denied'));

      return;
    }

    const code = callback.searchParams.get('code');

    if (!code || isBusy) {
      response.writeHead(400).end('Invalid or duplicate callback.');

      return;
    }

    isBusy = true;

    try {
      const result = await fetchImpl('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });

      if (!result.ok)
        throw new Error(`OAuth token exchange failed (HTTP ${result.status})`);
      let tokens: unknown;

      try {
        tokens = await result.json();
      } catch {
        throw new Error('Invalid OAuth token exchange response');
      }

      if (!isTokenExchange(tokens))
        throw new Error('OAuth exchange omitted required credentials');
      const idClaims = claims(tokens.id_token)['https://api.openai.com/auth'] || {};

      state.writeJson(state.authFile, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        token_type: tokens.token_type || 'Bearer',
        expires_at:
          claims(tokens.access_token).exp ||
          tokens.expires_at ||
          Date.now() / 1000 + (tokens.expires_in || 3600),
        account_id: tokens.account_id || idClaims.chatgpt_account_id,
        account_is_fedramp: idClaims.chatgpt_account_is_fedramp === true,
        last_refresh: Date.now() / 1000,
      });
      response
        .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Authentication complete. You can close this window.', () => {
          return finish(0);
        });
    } catch (error) {
      response.writeHead(502).end('OAuth exchange failed. Return to your terminal.');
      fail(error);
    }
  });

  const abort = () => {
    controller.abort();
    fail(new Error('OAuth login cancelled'));
  };

  const onInterrupt = () => {
    return abort();
  };

  let timer: NodeJS.Timeout | undefined;

  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    server.on('error', fail);
    timer = setTimeout(() => {
      controller.abort();
      fail(new Error('OAuth login timed out'));
    }, timeout);
    const address = server.address();

    if (!address || typeof address === 'string')
      throw new Error('OAuth callback is not listening');
    redirect = redirectUri(address.port);
    const url = new URL('https://auth.openai.com/oauth/authorize');

    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      scope:
        'openid profile email offline_access api.connectors.read api.connectors.invoke',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: nonce,
      originator: 'codex_cli_rs',
      codex_cli_simplified_flow: 'true',
      id_token_add_organizations: 'true',
    }).toString();
    if (signal?.aborted) abort();
    else await onUrl(url.toString(), address);
    await done;
    console.log('OAuth credentials saved. Run: claude-codex doctor');

    return 0;
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve) => {
        return server.close(resolve);
      });
  }
};
