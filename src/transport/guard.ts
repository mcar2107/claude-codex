import { isRecord } from '../state';

import type { ArgumentsScan, GuardToolArgumentsOptions, ToolCall } from './guard.types';

/**
 * Сколько пробельных символов подряд вне строк JSON считается петлёй. Между токенами отступы
 * короткие даже в отформатированных аргументах, а переносы и табы внутри строк приходят
 * экранированными (`\n`) и в серию не попадают. Модель в петле выдаёт сотни пробелов в секунду,
 * поэтому порог срабатывает примерно через секунду.
 */
export const WHITESPACE_RUN_LIMIT = 256;

/**
 * Код ошибки, которой обрывается поток, если аргументы закрыть нельзя.
 */
const LOOP_ERROR_CODE = 'tool_arguments_whitespace_loop';

const WHITESPACE = new Set([' ', '\n', '\r', '\t']);

export const createScan = (): ArgumentsScan => {
  return { isInString: false, isEscaped: false, depth: 0, whitespaceRun: 0 };
};

/**
 * Продвигает лексер по очередной порции аргументов. `true` — серия пробелов вне строк превысила
 * порог хотя бы раз внутри порции: проверка только в конце пропустила бы серию, за которой в той же
 * порции пришёл другой символ.
 */
export const scanArguments = (scan: ArgumentsScan, delta: string, limit: number) => {
  let hasLoop = false;

  for (const char of delta) {
    if (scan.isInString) {
      if (scan.isEscaped) {
        scan.isEscaped = false;
      } else if (char === '\\') {
        scan.isEscaped = true;
      } else if (char === '"') {
        scan.isInString = false;
      }

      continue;
    }

    if (WHITESPACE.has(char)) {
      scan.whitespaceRun += 1;
      hasLoop ||= scan.whitespaceRun > limit;

      continue;
    }

    scan.whitespaceRun = 0;

    switch (char) {
      case '"': {
        scan.isInString = true;
        break;
      }

      case '{':

      case '[': {
        scan.depth += 1;
        break;
      }

      case '}':

      case ']': {
        scan.depth -= 1;
        break;
      }

      default: {
        break;
      }
    }
  }

  return hasLoop;
};

/**
 * Аргументы вызова, если модель дописала их целиком и ушла в петлю вместо конца вызова: объект
 * верхнего уровня закрыт, к аргументам не дописывается ни символа. Петля внутри объекта не
 * чинится: закрыть его скобками можно, но так молча пропали бы параметры и элементы массивов,
 * которые модель не успела дописать, и инструмент выполнился бы не с теми аргументами.
 */
export const repairArguments = (args: string, scan: ArgumentsScan) => {
  if (scan.isInString || scan.depth > 0) {
    return undefined;
  }

  let input: unknown;

  try {
    input = JSON.parse(args);
  } catch {
    return undefined;
  }

  return isRecord(input) ? input : undefined;
};

export const sse = (type: string, data: object) => {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
};

/**
 * Оборачивает SSE-поток Responses API от Codex: при петле пробелов в аргументах вызова инструмента
 * закрывает поток сам и отменяет upstream, чтобы клиент не ждал бесконечно, а токены не тратились.
 *
 * Дописанные целиком аргументы отдаются клиенту завершённым вызовом (`response.completed`,
 * клиент выполняет инструмент), если других незавершённых вызовов нет; иначе ответ завершается
 * ошибкой.
 * Без срабатывания поток проходит без изменений.
 */
export const guardToolArguments = (
  body: ReadableStream<Uint8Array>,
  { limit = WHITESPACE_RUN_LIMIT, onTrip }: GuardToolArgumentsOptions = {}
) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const calls = new Map<string, ToolCall>();
  /**
   * Завершённые элементы вывода — для итогового `response.completed`: по ним клиент определяет
   * причину остановки.
   */
  const doneItems: unknown[] = [];
  let response: Record<string, unknown> = {};
  let pending = '';

  const trip = (itemId: string, call: ToolCall) => {
    /**
     * Параллельный вызов, ещё не дописанный к моменту петли, в завершённый ответ не попадёт: клиент
     * получил бы его оборванным. Такой ответ завершается ошибкой целиком.
     */
    const hasOtherOpenCalls = calls.size > 1;
    const input = hasOtherOpenCalls
      ? undefined
      : repairArguments(call.arguments, call.scan);
    const tool = typeof call.item.name === 'string' ? call.item.name : '';

    onTrip?.({
      at: new Date().toISOString(),
      tool,
      whitespace: call.scan.whitespaceRun,
      depth: call.scan.depth,
      isRepaired: Boolean(input),
    });

    const { id, object, model, created_at: createdAt } = response;

    if (!input) {
      const error = {
        code: LOOP_ERROR_CODE,
        message: `Codex looped on whitespace in ${tool || 'tool'} arguments; the response was stopped. Retry the request.`,
      };

      /**
       * `error` завершает стрим клиента. Нестриминговый ответ собирается из
       * `response.completed`: без него клиент получил бы пустой успешный ответ, а статус `failed`
       * превращает его в ошибку.
       */
      return (
        sse('error', error) +
        sse('response.completed', {
          response: {
            id,
            object,
            model,
            created_at: createdAt,
            status: 'failed',
            error,
            output: doneItems,
          },
        })
      );
    }

    const { outputIndex } = call;
    const item = {
      ...call.item,
      arguments: JSON.stringify(input),
      status: 'completed',
    };

    return [
      sse('response.function_call_arguments.done', {
        item_id: itemId,
        output_index: outputIndex,
        arguments: item.arguments,
      }),
      sse('response.output_item.done', { output_index: outputIndex, item }),
      sse('response.completed', {
        response: {
          id,
          object,
          model,
          created_at: createdAt,
          status: 'completed',
          output: [...doneItems, item],
        },
      }),
    ].join('');
  };

  /**
   * Разбирает событие SSE; строка — хвост, которым поток закрывается вместо продолжения upstream.
   */
  const inspect = (data: string) => {
    let event: unknown;

    try {
      event = JSON.parse(data);
    } catch {
      return undefined;
    }

    if (!isRecord(event)) {
      return undefined;
    }

    const { item, item_id: itemId, delta } = event;

    switch (event.type) {
      case 'response.created': {
        if (isRecord(event.response)) {
          response = event.response;
        }

        return undefined;
      }

      case 'response.output_item.added': {
        if (
          isRecord(item) &&
          item.type === 'function_call' &&
          typeof item.id === 'string'
        ) {
          calls.set(item.id, {
            item,
            outputIndex: event.output_index,
            arguments: '',
            scan: createScan(),
          });
        }

        return undefined;
      }

      case 'response.output_item.done': {
        if (isRecord(item)) {
          doneItems.push(item);

          if (typeof item.id === 'string') {
            calls.delete(item.id);
          }
        }

        return undefined;
      }

      case 'response.function_call_arguments.delta': {
        const call = typeof itemId === 'string' ? calls.get(itemId) : undefined;

        if (!call || typeof itemId !== 'string' || typeof delta !== 'string') {
          return undefined;
        }

        call.arguments += delta;

        return scanArguments(call.scan, delta, limit) ? trip(itemId, call) : undefined;
      }

      default: {
        return undefined;
      }
    }
  };

  const cancelUpstream = async () => {
    try {
      await reader.cancel();
    } catch {
      /**
       * Upstream уже закрыт или упал: клиенту поток закрыт сторожем, отменять нечего.
       */
    }
  };

  /**
   * Каждый вызов кладёт в поток хотя бы одну строку или закрывает его: `pull`, который ничего не
   * положил, поток больше не вызовет, и клиент повиснет. Строка `response.created` с инструкциями —
   * десятки килобайт и приходит несколькими кусками, поэтому неполную строку дочитываем здесь же.
   */
  const pull = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const { done, value } = await reader.read();

    if (done) {
      const rest = pending + decoder.decode();

      if (rest) {
        controller.enqueue(encoder.encode(rest));
      }

      controller.close();

      return;
    }

    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');

    pending = lines.pop() || '';
    let text = '';

    for (const line of lines) {
      text += line + '\n';
      const tail = line.startsWith('data:') ? inspect(line.slice(5)) : undefined;

      if (tail !== undefined) {
        /**
         * Пустая строка завершает событие, строку которого уже отдали, — хвост идёт отдельными
         * событиями.
         */
        controller.enqueue(encoder.encode(text + '\n' + tail));
        controller.close();
        await cancelUpstream();

        return;
      }
    }

    if (!text) {
      return pull(controller);
    }

    controller.enqueue(encoder.encode(text));
  };

  return new ReadableStream<Uint8Array>({
    pull,
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
};
