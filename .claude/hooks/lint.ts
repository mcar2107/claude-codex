#!/usr/bin/env bun
/**
 * PostToolUse-хук: после правки гоняет линтеры по правленым файлам (linting.md).
 *
 * Ловит и Edit/Write (`tool_input.file_path`), и Bash (`tool_input.command`): при работе через
 * `sed -i`, heredoc или скрипты правка идёт мимо `file_path`, поэтому пути вытаскиваются из самой
 * команды. Файлы, которые команда только читала, отсекает окно по времени изменения.
 *
 * - `.ts` — eslint и tsc по проекту; `.js`, `.mjs`, `.cjs` — eslint;
 * - vendor/ccr, сборки и зависимости не линтуются;
 * - автофикс не применяется: хук сообщает, но не переписывает файл за спиной агента.
 *
 * Коды выхода:
 *
 * - 0 — чисто, только warnings или ошибки tsc в других файлах;
 * - 1 — линтер не отработал: нет бинарника, упал, снят по таймауту, неразбираемый вывод;
 * - 2 — ошибки в правленых файлах или в конфигурации tsc: правка блокируется, отчёт уходит агенту.
 */
import fs from 'node:fs';
import path from 'node:path';

import type {
  EslintFileResult,
  LintOutcome,
  RunResult,
  TscDiagnostic,
  TscGroups,
} from './lint.types';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ESLINT_BIN = path.join(ROOT, 'node_modules/.bin/eslint');
const TSC_BIN = path.join(ROOT, 'node_modules/.bin/tsc');
const TSC_CACHE = 'node_modules/.cache/claude-tsc.tsbuildinfo';
const ESLINT_TIMEOUT_MS = 60_000;
const TSC_TIMEOUT_MS = 90_000;

/**
 * Сколько ждать выхода после SIGTERM по таймауту до SIGKILL.
 */
const KILL_GRACE_MS = 1000;

/**
 * Потолок печатаемых замечаний: большой файл не должен залить контекст агента.
 */
const MAX_REPORT_LINES = 80;

/**
 * Ошибки tsc в других файлах — только предупреждение, их печатается меньше.
 */
const MAX_OTHER_TSC_LINES = 30;

/**
 * Окно, в котором файл из Bash-команды считается правленым ею, а не только прочитанным.
 */
const MTIME_WINDOW_MS = 180_000;

/**
 * Потолок вывода упавшего линтера в отчёте.
 */
const MAX_CRASH_OUTPUT = 500;

const IGNORED_DIRECTORIES = ['node_modules/', 'dist/', 'vendor/', 'artifacts/', '.work/'];
const LINTED_FILE = /\.(?:ts|js|mjs|cjs)$/;

/**
 * Пути в тексте команды. Правая граница отсекает `a.json` → `a.js` и `b.tsx` → `b.ts`.
 */
const COMMAND_PATH = /[\w@./~-]+\.(?:ts|js|mjs|cjs)(?![\w.])/g;

/**
 * `path(line,col): error TSxxxx: …` — диагностика файла; `error TSxxxx: …` без пути — ошибка
 * конфигурации (`TS18003: No inputs were found`, `TS5023: Unknown compiler option`).
 */
const TSC_FILE_DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+:/;
const TSC_CONFIG_DIAGNOSTIC = /^error TS\d+:/;

const crashed = (report: string[]): LintOutcome => {
  return { hasErrors: false, hasCrashed: true, report };
};

/**
 * Запуск с раздельными stdout и stderr: предупреждение рантайма в stderr не портит JSON eslint.
 */
const run = async (command: string[], timeoutMs: number): Promise<RunResult> => {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let isTimedOut = false;
  let killTimer: Timer | undefined;
  const deadline = setTimeout(() => {
    isTimedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      return child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    await child.exited;

    return {
      exitCode: child.exitCode,
      signalCode: child.signalCode === null ? null : String(child.signalCode),
      stdout,
      stderr,
      isTimedOut,
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
  }
};

/**
 * Сбой запуска: таймаут, сигнал или код вне `expected`. `undefined` — линтер отработал.
 */
const runFailure = (
  name: string,
  result: RunResult,
  timeoutMs: number,
  expected: number[]
): string[] | undefined => {
  if (result.isTimedOut)
    return [`[${name}] timed out after ${timeoutMs / 1000}s — not checked`];
  if (result.signalCode)
    return [`[${name}] killed by ${result.signalCode} — not checked`];
  if (result.exitCode !== null && expected.includes(result.exitCode)) return undefined;

  return [
    `[${name}] crashed (exit ${result.exitCode}):`,
    (result.stderr || result.stdout || '(no output)').slice(0, MAX_CRASH_OUTPUT),
  ];
};

/**
 * Путь из ввода хука → путь от корня репозитория; `undefined` — вне репозитория, в
 * игнорируемом каталоге, не линтуемое расширение или не файл.
 */
const toRelative = (cwd: string, candidate: string) => {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(ROOT, absolute);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    return undefined;
  if (!LINTED_FILE.test(relative)) return undefined;
  if (
    IGNORED_DIRECTORIES.some((directory) => {
      return relative.startsWith(directory);
    })
  )
    return undefined;

  try {
    return fs.statSync(absolute).isFile() ? relative : undefined;
  } catch {
    /**
     * Файла нет — команда его удалила или путь только похож на путь.
     */
    return undefined;
  }
};

const stringField = (value: unknown, key: string) => {
  const field: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

  return typeof field === 'string' && field ? field : undefined;
};

/**
 * Правленые файлы из ввода хука: `file_path` правки и свежие пути из Bash-команды.
 */
const editedFiles = (input: unknown, now: number) => {
  const toolInput: unknown =
    typeof input === 'object' && input !== null
      ? Reflect.get(input, 'tool_input')
      : undefined;
  const cwd = stringField(input, 'cwd') || ROOT;
  const files = new Set<string>();
  const filePath = stringField(toolInput, 'file_path');
  const command = stringField(toolInput, 'command') || '';

  if (filePath) {
    const relative = toRelative(cwd, filePath);

    if (relative) files.add(relative);
  }

  for (const [candidate] of command.matchAll(COMMAND_PATH)) {
    const relative = toRelative(cwd, candidate);

    if (
      relative &&
      now - fs.statSync(path.join(ROOT, relative)).mtimeMs <= MTIME_WINDOW_MS
    )
      files.add(relative);
  }

  return [...files];
};

const isEslintResults = (value: unknown): value is EslintFileResult[] => {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return (
        typeof item === 'object' &&
        item !== null &&
        typeof item.filePath === 'string' &&
        Array.isArray(item.messages)
      );
    })
  );
};

/**
 * eslint одним процессом по всем файлам: typed-lint поднимает проект TypeScript один раз.
 */
const lintEslint = async (files: string[]): Promise<LintOutcome> => {
  if (!fs.existsSync(ESLINT_BIN))
    return crashed([`[eslint] binary not found at ${ESLINT_BIN}; run bun install`]);
  const result = await run(
    [ESLINT_BIN, '--format', 'json', '--no-warn-ignored', ...files],
    ESLINT_TIMEOUT_MS
  );
  /**
   * eslint: 0 — чисто или только warnings, 1 — есть errors, 2 — сбой.
   */
  const failure = runFailure('eslint', result, ESLINT_TIMEOUT_MS, [0, 1]);

  if (failure) return crashed(failure);
  let parsed: unknown;

  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }

  if (!isEslintResults(parsed))
    return crashed([
      '[eslint] unparseable JSON output:',
      result.stdout.slice(0, MAX_CRASH_OUTPUT),
    ]);
  const lines = parsed.flatMap(({ filePath, messages }) => {
    const file = path.relative(ROOT, filePath);

    return messages.map(({ line, column, severity, message, ruleId }) => {
      return `${file}:${line || 0}:${column || 0} ${severity === 2 ? 'error' : 'warn'} ${message} [${ruleId || '?'}]`;
    });
  });
  const errors = lines.filter((line) => {
    return line.includes(' error ');
  }).length;

  if (!lines.length) return { hasErrors: false, hasCrashed: false, report: [] };

  return {
    hasErrors: errors > 0,
    hasCrashed: false,
    report: [
      `[eslint] ${errors} error(s), ${lines.length - errors} warning(s):`,
      ...lines.slice(0, MAX_REPORT_LINES),
    ],
  };
};

/**
 * Диагностики tsc `--pretty false`; строки продолжения (с отступом) приклеиваются к предыдущей.
 */
const parseTsc = (output: string) => {
  return output.split('\n').reduce<TscDiagnostic[]>((diagnostics, line) => {
    const [, file] = line.match(TSC_FILE_DIAGNOSTIC) || [];
    const last = diagnostics.at(-1);

    if (file) diagnostics.push({ file, text: line });
    else if (TSC_CONFIG_DIAGNOSTIC.test(line)) diagnostics.push({ text: line });
    else if (last && /^\s/.test(line)) last.text += `\n${line}`;

    return diagnostics;
  }, []);
};

/**
 * tsc по всему проекту с инкрементальным кэшем: блокируют ошибки в правленых файлах и ошибки
 * конфигурации (без пути или в `tsconfig.json`): с ними tsc не проверил ничего; ошибки в других файлах (в том числе в vendor/ccr, который tsc проверяет
 * транзитивно) — предупреждение, чтобы агент не застрял на чужом долге.
 */
const lintTsc = async (edited: string[]): Promise<LintOutcome> => {
  if (!fs.existsSync(TSC_BIN))
    return crashed([`[tsc] binary not found at ${TSC_BIN}; run bun install`]);
  fs.mkdirSync(path.join(ROOT, path.dirname(TSC_CACHE)), { recursive: true });
  const result = await run(
    [
      TSC_BIN,
      '-p',
      'tsconfig.json',
      '--incremental',
      '--tsBuildInfoFile',
      TSC_CACHE,
      '--pretty',
      'false',
    ],
    TSC_TIMEOUT_MS
  );
  /**
   * tsc: 0 — чисто, 1 и 2 — есть диагностики; остальное — сбой.
   */
  const failure = runFailure('tsc', result, TSC_TIMEOUT_MS, [0, 1, 2]);

  if (failure) return crashed(failure);
  const diagnostics = parseTsc(result.stdout);

  if (result.exitCode !== 0 && !diagnostics.length)
    return crashed([
      `[tsc] exit ${result.exitCode} without diagnostics:`,
      (result.stdout || result.stderr).slice(0, MAX_CRASH_OUTPUT),
    ]);
  const { blocking, other } = diagnostics.reduce<TscGroups>(
    (groups, { file, text }) => {
      const isBlocking = !file || file.endsWith('.json') || edited.includes(file);

      (isBlocking ? groups.blocking : groups.other).push(text);

      return groups;
    },
    { blocking: [], other: [] }
  );
  const report = [
    ...(blocking.length
      ? [`[tsc] ${blocking.length} error(s) in edited files or config:`, ...blocking]
      : []),
    ...(other.length
      ? [
          `[tsc] ${other.length} error(s) in OTHER files (does not block this edit):`,
          ...other.slice(0, MAX_OTHER_TSC_LINES),
        ]
      : []),
  ];

  return { hasErrors: blocking.length > 0, hasCrashed: false, report };
};

const readInput = async (): Promise<unknown> => {
  try {
    return JSON.parse(await Bun.stdin.text());
  } catch {
    /**
     * Ввод хука не JSON — линтовать нечего.
     */
    return undefined;
  }
};

const files = editedFiles(await readInput(), Date.now());
const tsFiles = files.filter((file) => {
  return file.endsWith('.ts');
});
const outcomes = await Promise.all([
  files.length ? lintEslint(files) : undefined,
  tsFiles.length ? lintTsc(tsFiles) : undefined,
]);

for (const outcome of outcomes)
  for (const line of outcome?.report || []) process.stderr.write(`${line}\n`);

/**
 * Ошибки в правке важнее сбоя соседнего линтера: агенту нужен их отчёт.
 */
process.exitCode = outcomes.some((outcome) => {
  return outcome?.hasErrors;
})
  ? 2
  : outcomes.some((outcome) => {
        return outcome?.hasCrashed;
      })
    ? 1
    : 0;
