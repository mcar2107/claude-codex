import { timingSafeEqual } from 'node:crypto';

import Fastify from 'fastify';

import { errorHandler } from '../../vendor/ccr/core/src/api/middleware';
import { registerApiRoutes } from '../../vendor/ccr/core/src/api/routes';
import { ConfigService } from '../../vendor/ccr/core/src/services/config';
import { ProviderService } from '../../vendor/ccr/core/src/services/provider';
import { TokenizerService } from '../../vendor/ccr/core/src/services/tokenizer';
import { TransformerService } from '../../vendor/ccr/core/src/services/transformer';
import type { UnifiedChatRequest } from '../../vendor/ccr/core/src/types/llm';
import type { TransformerContext } from '../../vendor/ccr/core/src/types/transformer';
import { calculateTokenCount } from '../../vendor/ccr/core/src/utils/router';
import * as state from '../state';

import { probeResponseModel } from './last-request';
import type { LastRequest, ModelChoice } from './last-request.types';
import { codexRateLimits } from './limits';
import type { CountTokensRoute, CreateRouterOptions } from './server.types';

/**
 * Маршруты, тело которых несёт модель клиента.
 */
const MODEL_ROUTES = ['/v1/messages', '/v1/messages/count_tokens'];

/**
 * Наружу — только Messages API и список моделей: администрирование CCR, другие провайдеры и
 * протоколы недоступны.
 */
const ALLOWED_ROUTES = ['/health', '/v1/models', ...MODEL_ROUTES];

/**
 * Потолок тела запроса: диалог Claude Code с картинками и файлами не помещается в 1 МиБ — лимит
 * Fastify по умолчанию.
 */
const BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * Таймаут запроса CCR к Codex.
 */
const API_TIMEOUT_MS = 120_000;

/**
 * Служебные файлы сессии — для statusline и проверки; сбой записи не должен ронять ответ модели.
 */
const writeQuietly = (file: string | undefined, data: unknown) => {
  if (!file) return;

  try {
    state.writeJson(file, data);
  } catch {
    /**
     * Файл диагностический: без него ответ модели всё равно корректен.
     */
  }
};

const stringOrNull = (value: unknown) => {
  return typeof value === 'string' && value ? value : null;
};

export async function createRouter({
  key,
  limitsFile,
  requestFile,
}: CreateRouterOptions) {
  /**
   * Настройки читаются один раз, на старте сессии: сохранённые позже — умолчания для новых сессий.
   * Иначе `settings set` из другого терминала менял бы открытую сессию, а несовместимая с её
   * `--effort` модель валила бы каждый запрос.
   */
  const startup = state.activeSettings();
  /**
   * Выбор клиента и итоговый запрос — по объекту запроса Fastify: их видят и хук, и трансформеры
   * (`context.req`), а параллельные запросы сессии не путаются.
   */
  const clientChoices = new WeakMap<object, ModelChoice>();
  const lastRequests = new WeakMap<object, LastRequest>();
  /**
   * Самая свежая запись `last-request.json`: модель ответа дописывается, только пока запись
   * текущая, — иначе медленный ответ затёр бы более новый запрос.
   */
  let latestRecord: LastRequest | undefined;

  process.env.CCR_CODEX_AUTH_FILE = state.authFile;
  process.env.CCR_MODELSDEV_DISABLE = '1';
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', async (request, reply) => {
    const token =
      request.headers['x-api-key'] ||
      String(request.headers.authorization || '').replace(/^Bearer /, '');
    const actual = Buffer.from(typeof token === 'string' ? token : '');
    const expected = Buffer.from(key);

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(401).send({
        error: { type: 'authentication_error', message: 'Invalid local session key' },
      });
    if (!ALLOWED_ROUTES.includes(request.url.split('?')[0]))
      return reply.code(404).send({ error: { message: 'Not found' } });
  });
  /**
   * Модель выбирает клиент (`/model`), но только среди моделей Codex: ID без префикса `codex,`
   * (алиас Claude, модель фоновой задачи) уходит в стартовую модель сессии, а не в маршрут CCR по
   * умолчанию.
   */
  app.addHook('preHandler', async (request) => {
    const { body } = request;

    if (
      !MODEL_ROUTES.includes(request.url.split('?')[0]) ||
      typeof body !== 'object' ||
      body === null
    )
      return;
    const requested: unknown = Reflect.get(body, 'model');
    const outputConfig: unknown = Reflect.get(body, 'output_config');

    clientChoices.set(request, {
      model: stringOrNull(requested),
      effort:
        typeof outputConfig === 'object' && outputConfig !== null
          ? stringOrNull(Reflect.get(outputConfig, 'effort'))
          : null,
    });
    const id =
      typeof requested === 'string' && requested.startsWith(state.CLIENT_PREFIX)
        ? requested.slice(state.CLIENT_PREFIX.length)
        : undefined;

    if (!state.isModelId(id))
      Reflect.set(body, 'model', state.CLIENT_PREFIX + startup.model);
  });
  const route = state.CLIENT_PREFIX + startup.model;
  const configService = new ConfigService({
    useJsonFile: false,
    useEnvFile: false,
    initialConfig: {
      LOG: false,
      API_TIMEOUT_MS,
      providers: [
        {
          name: 'codex',
          api_base_url: 'https://chatgpt.com/backend-api/codex',
          api_key: 'oauth',
          models: [...state.models],
          transformer: {
            use: [
              'local-codex-settings',
              'openai-responses',
              'codex',
              'local-codex-limits',
            ],
          },
        },
      ],
      Router: {
        default: route,
        background: route,
        think: route,
        longContext: route,
        webSearch: route,
      },
    },
    logger: app.log,
  });
  const transformerService = new TransformerService(configService, app.log);

  await transformerService.initialize();
  /**
   * Модель и effort — из запроса клиента: `/model` и `/effort` Claude Code переключают их в
   * открытой сессии. Стартовые настройки сессии — запасной вариант, когда клиент их не прислал.
   */
  transformerService.registerTransformer('local-codex-settings', {
    name: 'local-codex-settings',
    async transformRequestIn(
      body: UnifiedChatRequest,
      _provider: unknown,
      context?: TransformerContext
    ) {
      const model = state.isModelId(body.model) ? body.model : startup.model;
      const reasoningEffort =
        state.fitEffort(model, body.reasoning?.effort) ||
        state.fitEffort(model, startup.reasoningEffort) ||
        state.effortsFor(model)[0];
      const { req } = context || {};

      if (requestFile && typeof req === 'object' && req !== null) {
        const record: LastRequest = {
          at: new Date().toISOString(),
          client: clientChoices.get(req) || { model: null, effort: null },
          upstream: { model, effort: reasoningEffort },
        };

        lastRequests.set(req, record);
        latestRecord = record;
        writeQuietly(requestFile, record);
      }

      return {
        ...body,
        model,
        reasoning: {
          ...body.reasoning,
          effort: reasoningEffort,
          enabled: reasoningEffort !== 'none',
        },
      };
    },
  });
  /**
   * Последний в цепочке запроса — значит, первый в цепочке ответа (`compileTransformerPlan`):
   * видит заголовки ответа Codex до того, как ответ пересоберут в протокол клиента.
   */
  transformerService.registerTransformer('local-codex-limits', {
    name: 'local-codex-limits',
    requestPhase: 'headers',
    async transformResponseOut(response: Response, context?: TransformerContext) {
      const limits = codexRateLimits(response.headers);

      if (limits) writeQuietly(limitsFile, limits);
      const record =
        typeof context?.req === 'object' && context.req !== null
          ? lastRequests.get(context.req)
          : undefined;

      if (!record || !response.ok || !response.body) return response;
      /**
       * Модель ответа Codex — в первом событии стрима; клиент получает свою копию потока.
       */
      const [forClient, probe] = response.body.tee();

      probeResponseModel(probe, context?.signal)
        .then((returnedModel) => {
          if (returnedModel && record === latestRecord)
            writeQuietly(requestFile, { ...record, returnedModel });
        })
        .catch(() => {
          /**
           * Зонд не бросает, но и сбой здесь касается только диагностического файла.
           */
        });

      return new Response(forClient, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  const providerService = new ProviderService(configService, transformerService, app.log);
  const tokenizerService = new TokenizerService(configService, app.log);

  await tokenizerService.initialize();
  app.decorate('configService', configService);
  app.decorate('transformerService', transformerService);
  app.decorate('providerService', providerService);
  app.decorate('tokenizerService', tokenizerService);
  app.post<CountTokensRoute>('/v1/messages/count_tokens', async (request, reply) => {
    const { body } = request;

    if (typeof body !== 'object' || body === null || !Array.isArray(body.messages))
      return reply.code(400).send({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages: expected an array' },
      });

    return {
      input_tokens: calculateTokenCount(body.messages, body.system, body.tools),
    };
  });
  app.get('/v1/models', async () => {
    return {
      object: 'list',
      data: state.models.map((id: string) => {
        return {
          id: state.CLIENT_PREFIX + id,
          object: 'model',
          owned_by: 'codex',
        };
      }),
    };
  });
  await registerApiRoutes(app);
  app.addHook('onClose', async () => {
    tokenizerService.dispose();
  });
  await app.ready();

  return app;
}
