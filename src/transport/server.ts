import { timingSafeEqual } from 'node:crypto';

import Fastify from 'fastify';

import { errorHandler } from '../../vendor/ccr/core/src/api/middleware';
import { registerApiRoutes } from '../../vendor/ccr/core/src/api/routes';
import { ConfigService } from '../../vendor/ccr/core/src/services/config';
import { ProviderService } from '../../vendor/ccr/core/src/services/provider';
import { TokenizerService } from '../../vendor/ccr/core/src/services/tokenizer';
import { TransformerService } from '../../vendor/ccr/core/src/services/transformer';
import type { UnifiedChatRequest } from '../../vendor/ccr/core/src/types/llm';
import { calculateTokenCount } from '../../vendor/ccr/core/src/utils/router';
import state from '../state.cjs';

import type { CountTokensRoute, CreateRouterOptions } from './server.types';

export async function createRouter({ key }: CreateRouterOptions) {
  process.env.CCR_CODEX_AUTH_FILE = state.authFile;
  process.env.CCR_MODELSDEV_DISABLE = '1';
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });

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
    const pathname = request.url.split('?')[0];

    /**
     * Наружу — только Messages API и список моделей: администрирование CCR, другие провайдеры
     * и протоколы недоступны.
     */
    if (
      !['/health', '/v1/models', '/v1/messages', '/v1/messages/count_tokens'].includes(
        pathname
      )
    )
      return reply.code(404).send({ error: { message: 'Not found' } });
  });
  const route = 'codex,gpt-6.1-sol';
  const configService = new ConfigService({
    useJsonFile: false,
    useEnvFile: false,
    initialConfig: {
      LOG: false,
      API_TIMEOUT_MS: 120000,
      providers: [
        {
          name: 'codex',
          api_base_url: 'https://chatgpt.com/backend-api/codex',
          api_key: 'oauth',
          models: [...state.models],
          transformer: { use: ['local-codex-settings', 'openai-responses', 'codex'] },
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
  transformerService.registerTransformer('local-codex-settings', {
    name: 'local-codex-settings',
    async transformRequestIn(body: UnifiedChatRequest) {
      const active = state.activeSettings();

      return {
        ...body,
        model: active.model,
        reasoning: {
          ...body.reasoning,
          effort: active.reasoningEffort,
          enabled: active.reasoningEffort !== 'none',
        },
      };
    },
  });
  const providerService = new ProviderService(configService, transformerService, app.log);
  const tokenizerService = new TokenizerService(configService, app.log);

  await tokenizerService.initialize();
  app.decorate('configService', configService);
  app.decorate('transformerService', transformerService);
  app.decorate('providerService', providerService);
  app.decorate('tokenizerService', tokenizerService);
  app.post<CountTokensRoute>('/v1/messages/count_tokens', async (request) => {
    return {
      input_tokens: calculateTokenCount(
        request.body.messages,
        request.body.system,
        request.body.tools
      ),
    };
  });
  app.get('/v1/models', async () => {
    return {
      object: 'list',
      data: state.models.map((id: string) => {
        return {
          id: `codex,${id}`,
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
