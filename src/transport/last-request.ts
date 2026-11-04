/**
 * Сколько символов стрима читать в поисках модели: `response.created` — первое событие Codex.
 */
const PROBE_LIMIT = 64 * 1024;

/**
 * Первое событие SSE Responses с объектом `response`: `undefined` — такого события в тексте ещё
 * нет, `{ model: undefined }` — событие есть, но модели в нём нет.
 */
export const responseEvent = (text: string) => {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) {
      continue;
    }

    let event: unknown;

    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }

    const response: unknown =
      typeof event === 'object' && event !== null
        ? Reflect.get(event, 'response')
        : undefined;

    if (typeof response !== 'object' || response === null) {
      continue;
    }

    const model: unknown = Reflect.get(response, 'model');

    return { model: typeof model === 'string' && model ? model : undefined };
  }

  return undefined;
};

/**
 * Читает копию стрима ответа до первого события с `response` и сразу её отменяет: исходный поток
 * отменяется только после отмены обеих копий, поэтому зонд не должен держать upstream открытым.
 * По той же причине зонд отменяется вместе с запросом клиента.
 */
export const probeResponseModel = async (
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const cancel = () => {
    reader.cancel().catch(() => {
      /**
       * Отмена копии стрима — уборка: поток уже закрыт или упал, и ответ клиента от неё не
       * зависит.
       */
    });
  };

  signal?.addEventListener('abort', cancel, { once: true });
  let text = '';

  try {
    while (text.length < PROBE_LIMIT) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });
      const found = responseEvent(text);

      if (found) {
        return found.model;
      }
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
};
