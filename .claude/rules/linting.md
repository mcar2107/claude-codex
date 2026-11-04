---
paths:
  - "**/*"
---

# Линтеры

Конфиги линтеров, поток проверки, запреты и действующие послабления.

Правила стиля и синтаксиса живут в конфигах, а не в голове:

- `/eslint.config.ts` — TS (typescript-eslint + prettier + jsdoc + simple-import-sort + unicorn); typed-lint
  (`no-floating-promises`) — только для `.ts`;
- `/.prettierrc` + `/.prettierignore` — форматирование; `*.md` не форматируется — таблицы выровнены руками;
- `/tsconfig.json` — строгий TS для всего кода проекта (и транзитивно vendor/ccr);
- `/lint-staged.config.ts` — `eslint --fix` + `ast-grep scan` / `prettier --write` по staged-файлам;
  `/.husky/pre-commit` — lint-staged, затем параллельно typecheck, `bun run test` и поиск секретов в staged
  (lint-staged переписывает файлы и прячет unstaged-правки в stash — параллельно с ним проверки не идут);
- `/.editorconfig` — отступы и переводы строк; на vendor/ не распространяется;
- проверки сверх eslint — таблица ниже.

vendor/ccr исключён из eslint, prettier, ast-grep, agnix и хука: это исходники upstream байт в байт. Их хеши с
`vendor/ccr/original-sha256.json` сверяет `scripts/verify-vendor.ts` — в `bun run lint:vendor` и в начале
`bun run build` (`vendor.md`).

## Проверки сверх eslint

Подборка — https://github.com/mokevnin/dev-guardrails. Каждая падает с ненулевым кодом. Бинарные инструменты
(ast-grep, agnix, betterleaks, osv-scanner, shellcheck, actionlint) закреплены в `/.mise.toml` и запускаются через
`mise x --`, который доставит недостающий; без mise pre-commit падает с подсказкой. Пакеты-обёртки с докачкой на
`postinstall` не берём.

| Команда | Что | Конфиг | Где ещё |
|---|---|---|---|
| `bun run typecheck` | типы всего TS проекта | `/tsconfig.json` | `bun run lint`, pre-commit |
| `bun run lint:knip` | неиспользуемые файлы, экспорты, типы, зависимости | `/knip.jsonc` | `bun run lint` |
| `bun run lint:sg` | правила проекта ast-grep и тесты правил | `/sgconfig.yml`, `/.ast-grep/` | `bun run lint`, pre-commit (только `scan` по staged) |
| `bun run lint:agents` | `CLAUDE.md`, `.claude/rules`, хуки, `settings.json` (agnix `--strict`) | `/.agnix.toml` | `bun run lint` |
| `bun run lint:release` | `install.sh` (shellcheck) и workflow (actionlint) | `/.mise.toml` (версии) | `bun run lint` |
| `bun run lint:vendor` | vendor/ccr совпадает с `original-sha256.json` | `scripts/verify-vendor.ts` | `bun run lint`, `bun run build` |
| `bun run lint:secrets` | секреты во всей истории git | `/.betterleaks.toml` | pre-commit (staged) |
| `bun run lint:deps` | известные уязвимости в `bun.lock` | `/osv-scanner.toml` | — |

- **Knip.** Экспорт, нужный только своему файлу, — без `export`; ненужный никому — удаляется. Файлы адаптера, которые
  подставляет плагин сборки, и зависимости кода vendor/ccr перечислены в конфиге с причиной.
- **ast-grep.** Правило: `no-iterator-chain` (`filter` / `map` / `flatMap` подряд). Новое правило — с тестом в
  `.ast-grep/tests/` и снапшотом (`mise x -- ast-grep test -U`). Известные пропуски: цепочка за `!` / `as` / скобками и
  пары итераторов кроме `filter` / `map` / `flatMap`.
- **Новый `lint:*`** — и в `bun run lint`, если он быстрый и не ходит в сеть.
- **Секреты.** Отчёт — с `--redact -v`: файл и строка, значение скрыто. Исключение в `.betterleaks.toml` — точечное:
  путь + значение (`regexTarget = "secret"`), не весь каталог.
- **Уязвимости.** Исправление — обновление пакета; иначе исключение с `reason` и `ignoreUntil`.

Исключение из любой проверки — в её конфиге и всегда с причиной.

## Поток проверки

1. **Перед правкой** сомнительного места — открой конфиг и прочитай релевантную секцию.
2. **После каждой правки** срабатывает PostToolUse-хук `.claude/hooks/lint.ts` (TypeScript на Bun, проверяется тем же
   eslint и tsc):

   - правленые файлы — `file_path` правки и пути из Bash-команды с mtime не старше 180 сек; файл, не изменившийся с
     прошлой проверки (журнал `node_modules/.cache/claude-lint-checked.json`), повторно не линтуется — `rg`/`cat`
     после правки не перезапускают проверку;
   - `eslint` для `.ts/.js/.mjs/.cjs` — одним процессом по всем правленым файлам (таймаут 60 сек); в отчёте errors
     идут первыми, затем warnings (потолок 80 строк);
   - `tsc -p tsconfig.json --incremental` для `.ts` — типы по всему проекту (кэш в
     `node_modules/.cache/claude-tsc.tsbuildinfo`, таймаут 90 сек). Ошибки в правленом файле и ошибки конфигурации
     (`error TS…` без пути, ошибки в `tsconfig.json`) блокируют; ошибки в других файлах показываются предупреждением;
   - `severity: error` в правленом файле → exit 2, правка блокируется, ошибки — в stderr;
   - `severity: warning` и ошибки tsc в других файлах → exit 0, отчёт агенту — JSON `additionalContext` в stdout
     (stderr при exit 0 агент не видит);
   - сбой линтера (нет бинарника, убит сигналом, неожиданный код выхода, таймаут, неразбираемый вывод) → exit 1 +
     диагностика. Исключение одного линтера не теряет отчёт другого. Ошибки в правке важнее сбоя соседнего
     линтера: при обоих — exit 2.

3. **Перед завершением задачи** — `bun run lint` (eslint, tsc, prettier, Knip, ast-grep, agnix, shellcheck/actionlint,
   сверка vendor параллельно), `bun run test`; правка зависимостей — ещё `bun run lint:deps`, правка сборки —
   `bun run build:standalone` и `bun run test:e2e`. 0 errors и 0 warnings в новом коде.

## Запреты

- Не отключать правила через `// eslint-disable*`, `@ts-ignore`, `@ts-expect-error` ради прохождения проверки.
- Не ослаблять и не удалять правила в `eslint.config.ts` / `tsconfig.json`. Действующие послабления и причины
  перечислены ниже («Послабления») — новые заводятся только с обоснованием там же.
- Не обходить типы через `any`, `as unknown as T`, `@ts-nocheck`.
- Не править vendor/ccr ради проверки — ни автофиксом, ни руками.
- Автофиксы допустимы (`eslint --fix`, `prettier --write`), после автофикса — прочитай диф. Исключение —
  `jsdoc/require-jsdoc`: его фикс вставляет пустые заглушки `/** */`, описания пиши руками.
- Если непонятно, как починить правильно, — спроси. Не прячь проблему в TODO.

## Послабления

- `no-undef` выключен для TS: необъявленное имя ловит `tsc`.
- `no-console` выключен: это CLI, консоль — его интерфейс.
- Глобал `Bun` объявлен в eslint: рантайм CLI — Bun.
- `@typescript-eslint/no-unused-vars` игнорирует имена с префиксом `_`: параметр, которого требует сигнатура upstream
  (`_provider` трансформера), или намеренный пропуск при деструктуризации.
- `jsdoc/require-jsdoc` — только на `TSPropertySignature` (поля типов, `typescript.md` п. 9): у функций и классов имя и
  сигнатура обычно объясняют назначение, заглушки ради правила — шум.
- `no-fallthrough` с `allowEmptyCase`: пустой `case` — синонимы одной ветки (`help` / `--help` / `-h`), а не забытый
  `break`.
- `no-duplicate-imports` с `allowSeparateTypeImports`: `import type` и импорт значений из одного модуля остаются
  раздельными — тип виден в строке импорта.
