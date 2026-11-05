import { isRecord } from '../state';

import type {
  ArgumentsScan,
  GuardToolArgumentsOptions,
  LoopError,
  LoopKind,
  ToolCall,
} from './guard.types';

/**
 * Сколько пробельных символов подряд вне строк JSON считается петлёй. Между токенами отступы
 * короткие даже в отформатированных аргументах, а переносы и табы внутри строк приходят
 * экранированными (`\n`) и в серию не попадают. Модель в петле выдаёт сотни пробелов в секунду,
 * поэтому порог срабатывает примерно через секунду.
 */
export const WHITESPACE_RUN_LIMIT = 256;

/**
 * Самый длинный кусок текста, повтор которого внутри строки ищется. Петли Codex — короткие слоги
 * (`cтатиcтати…`); длиннее — уже повтор строк или блоков, который бывает в настоящих данных.
 */
const REPEAT_UNIT_LIMIT = 40;

/**
 * Сколько символов подряд должен занять повтор, чтобы считаться петлёй. Петля пишется десятками
 * символов в секунду — порог срабатывает примерно через 10–15 секунд, а осмысленный текст
 * короткого куска на тысячу символов почти не повторяет.
 */
export const REPEAT_RUN_LIMIT = 1000;

/**
 * Поля с содержимым файлов: повторяющийся текст в них бывает настоящим, и ложный обрыв записи
 * файла хуже долгого ответа. Поэтому порог повтора в них выше в `FILE_CONTENT_REPEAT_FACTOR` раз:
 * настоящий файл редко повторяет кусок до `REPEAT_UNIT_LIMIT` символов на десятки тысяч символов
 * подряд, а без порога петля в `Write` или `Edit` висела бы бесконечно.
 */
const FILE_CONTENT_KEYS = new Set(['content', 'new_string', 'old_string', 'new_source']);

export const FILE_CONTENT_REPEAT_FACTOR = 20;

const LOOP_ERRORS: Record<LoopKind, LoopError> = {
  whitespace: { code: 'tool_arguments_whitespace_loop', text: 'whitespace' },
  repeat: { code: 'tool_arguments_repeat_loop', text: 'repeated text' },
};

const WHITESPACE = new Set([' ', '\n', '\r', '\t']);

/**
 * Буква в повторяющемся куске: повторы разделителей и чисел (`-----`, `0,0,0`) — обычные данные.
 */
const LETTER = /\p{L}/u;

/**
 * Символы, которые означают однобуквенные escape-последовательности JSON: в поиск повтора идёт
 * сам символ, а не буква после `\` — иначе повтор строк из цифр и разделителей (`0,0,0\n…`)
 * нашёл бы букву `n`.
 */
const ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

export const createScan = (): ArgumentsScan => {
  return {
    isInString: false,
    isEscaped: false,
    unicodeHex: undefined,
    containers: '',
    isKeyNext: false,
    isKey: false,
    key: '',
    keyText: '',
    isFileContent: false,
    recent: [],
    periodRuns: [],
    whitespaceRun: 0,
  };
};

/**
 * Продвигает поиск повтора на символ строкового значения. `true` — последние `limit` символов
 * повторяют кусок до `REPEAT_UNIT_LIMIT` символов, в котором есть буква.
 */
const scanRepeat = (scan: ArgumentsScan, char: string, limit: number) => {
  const { recent, periodRuns } = scan;
  /**
   * Букву ищем только в наименьшем периоде, прошедшем порог: порог много больше двух
   * `REPEAT_UNIT_LIMIT`, поэтому остальные такие периоды кратны ему (теорема Файна — Вильфа) и
   * состоят из тех же символов. Иначе повтор без букв (`-----`) проверялся бы на каждом из
   * `REPEAT_UNIT_LIMIT` периодов для каждого символа.
   */
  let hasLoop: boolean | undefined;

  for (let period = 1; period <= recent.length; period += 1) {
    periodRuns[period] =
      recent[recent.length - period] === char ? (periodRuns[period] || 0) + 1 : 0;

    if (hasLoop === undefined && periodRuns[period] >= limit) {
      hasLoop = LETTER.test(recent.slice(recent.length - period + 1).join('') + char);
    }
  }

  recent.push(char);

  if (recent.length > REPEAT_UNIT_LIMIT) {
    recent.shift();
  }

  return Boolean(hasLoop);
};

/**
 * Раскодированный символ строки: текст ключа или символ значения для поиска повтора.
 */
const scanDecodedChar = (scan: ArgumentsScan, char: string, repeatLimit: number) => {
  if (scan.isKey) {
    scan.keyText += char;

    return false;
  }

  return scanRepeat(
    scan,
    char,
    scan.isFileContent ? repeatLimit * FILE_CONTENT_REPEAT_FACTOR : repeatLimit
  );
};

/**
 * Символ внутри строки — ключа или значения.
 */
const scanStringChar = (scan: ArgumentsScan, char: string, repeatLimit: number) => {
  if (scan.unicodeHex !== undefined) {
    scan.unicodeHex += char;

    if (scan.unicodeHex.length < 4) {
      return false;
    }

    /**
     * `\u2500` и подобные — один символ: иначе буква `u` сделала бы повтор псевдографики
     * петлёй.
     */
    const decoded = String.fromCharCode(Number.parseInt(scan.unicodeHex, 16));

    scan.unicodeHex = undefined;

    return scanDecodedChar(scan, decoded, repeatLimit);
  }

  if (scan.isEscaped) {
    scan.isEscaped = false;

    if (char === 'u') {
      scan.unicodeHex = '';

      return false;
    }

    return scanDecodedChar(scan, ESCAPES[char] || char, repeatLimit);
  }

  if (char === '\\') {
    scan.isEscaped = true;

    return false;
  }

  if (char === '"') {
    scan.isInString = false;

    if (scan.isKey) {
      scan.key = scan.keyText;
    }

    return false;
  }

  return scanDecodedChar(scan, char, repeatLimit);
};

/**
 * Начало строки: ключ — после `{` или запятой в объекте, иначе значение.
 */
const startString = (scan: ArgumentsScan) => {
  scan.isInString = true;
  scan.isKey = scan.isKeyNext;
  scan.isKeyNext = false;

  if (scan.isKey) {
    scan.keyText = '';

    return;
  }

  scan.isFileContent = FILE_CONTENT_KEYS.has(scan.key);
  scan.recent = [];
  scan.periodRuns = [];
};

/**
 * Продвигает лексер по очередной порции аргументов и возвращает вид петли, если она случилась
 * хотя бы раз внутри порции: проверка только в конце пропустила бы серию, за которой в той же
 * порции пришёл другой символ.
 */
export const scanArguments = (
  scan: ArgumentsScan,
  delta: string,
  limit: number,
  repeatLimit = REPEAT_RUN_LIMIT
): LoopKind | undefined => {
  let loop: LoopKind | undefined;

  for (const char of delta) {
    if (scan.isInString) {
      if (scanStringChar(scan, char, repeatLimit)) {
        loop ||= 'repeat';
      }

      continue;
    }

    if (WHITESPACE.has(char)) {
      scan.whitespaceRun += 1;

      if (scan.whitespaceRun > limit) {
        loop ||= 'whitespace';
      }

      continue;
    }

    scan.whitespaceRun = 0;

    switch (char) {
      case '"': {
        startString(scan);
        break;
      }

      case '{':

      case '[': {
        scan.containers += char;
        scan.isKeyNext = char === '{';
        break;
      }

      case '}':

      case ']': {
        scan.containers = scan.containers.slice(0, -1);
        scan.isKeyNext = false;
        break;
      }

      case ',': {
        scan.isKeyNext = scan.containers.endsWith('{');
        break;
      }

      default: {
        scan.isKeyNext = false;
        break;
      }
    }
  }

  return loop;
};

/**
 * Аргументы вызова, если модель дописала их целиком и ушла в петлю вместо конца вызова: объект
 * верхнего уровня закрыт, к аргументам не дописывается ни символа. Петля внутри объекта не
 * чинится: закрыть его скобками можно, но так молча пропали бы параметры и элементы массивов,
 * которые модель не успела дописать, и инструмент выполнился бы не с теми аргументами.
 */
export const repairArguments = (args: string, scan: ArgumentsScan) => {
  if (scan.isInString || scan.containers) {
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
 * Оборачивает SSE-поток Responses API от Codex: при петле в аргументах вызова инструмента — пробелах
 * вне строк или повторе текста внутри строки — закрывает поток сам и отменяет upstream, чтобы клиент
 * не ждал бесконечно, а токены не тратились. Петля повтора обычно обрывает аргументы внутри строки —
 * такой ответ завершается ошибкой. Если порция, на которой повтор прошёл порог, заодно закрыла
 * объект, вызов отдаётся завершённым: те же аргументы клиент получил бы и без сторожа.
 *
 * Дописанные целиком аргументы отдаются клиенту завершённым вызовом (`response.completed`,
 * клиент выполняет инструмент), если других незавершённых вызовов нет; иначе ответ завершается
 * ошибкой.
 * Без срабатывания поток проходит без изменений.
 */
export const guardToolArguments = (
  body: ReadableStream<Uint8Array>,
  {
    limit = WHITESPACE_RUN_LIMIT,
    repeatLimit = REPEAT_RUN_LIMIT,
    onTrip,
  }: GuardToolArgumentsOptions = {}
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

  const trip = (itemId: string, call: ToolCall, kind: LoopKind) => {
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
      kind,
      whitespace: call.scan.whitespaceRun,
      depth: call.scan.containers.length,
      isRepaired: Boolean(input),
    });

    const { id, object, model, created_at: createdAt } = response;

    if (!input) {
      const { code, text } = LOOP_ERRORS[kind];
      const error = {
        code,
        message: `Codex looped on ${text} in ${tool || 'tool'} arguments; the response was stopped. Retry the request.`,
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
        const loop = scanArguments(call.scan, delta, limit, repeatLimit);

        return loop ? trip(itemId, call, loop) : undefined;
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
