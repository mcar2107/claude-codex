---
paths:
  - "**/*"
---

# Линтеры

Конфиги линтеров, поток проверки, запреты и действующие послабления.

Правила стиля и синтаксиса живут в конфигах, а не в голове:

- `/eslint.config.mjs` — JS/TS (typescript-eslint + prettier + jsdoc + simple-import-sort + unicorn); typed-lint
  (`no-floating-promises`) — только для `.ts`;
- `/.prettierrc` + `/.prettierignore` — форматирование; `*.md` не форматируется — таблицы выровнены руками;
- `/tsconfig.json` — строгий TS для `src/**/*.ts` (и транзитивно vendor/ccr);
- `/.lintstagedrc.mjs` — `eslint --fix` + `ast-grep scan` / `prettier --write` по staged-файлам;
  `/.husky/pre-commit` — lint-staged + typecheck + `npm test` + поиск секретов в staged параллельно;
- `/.editorconfig` — отступы и переводы строк; на vendor/ не распространяется;
- проверки сверх eslint — таблица ниже.

vendor/ccr исключён из eslint, prettier, ast-grep, agnix и хука: это исходники upstream байт в байт, их хеши сверяет
`vendor/ccr/original-sha256.json` (`vendor.md`).

## Проверки сверх eslint

Подборка — https://github.com/mokevnin/dev-guardrails. Каждая падает с ненулевым кодом. Бинарные инструменты
(ast-grep, agnix, betterleaks, osv-scanner) закреплены в `/.mise.toml` и запускаются через `mise x --`, который доставит
недостающий; без mise pre-commit падает с подсказкой. npm-обёртки с докачкой на `postinstall` не берём.

| Команда | Что | Конфиг | Где ещё |
|---|---|---|---|
| `npm run typecheck` | типы `src/**/*.ts` | `/tsconfig.json` | `npm run lint`, pre-commit |
| `npm run lint:knip` | неиспользуемые файлы, экспорты, типы, зависимости | `/knip.jsonc` | `npm run lint` |
| `npm run lint:sg` | правила проекта ast-grep и тесты правил | `/sgconfig.yml`, `/.ast-grep/` | `npm run lint`, pre-commit (только `scan` по staged) |
| `npm run lint:agents` | `CLAUDE.md`, `.claude/rules`, хуки, `settings.json` (agnix `--strict`) | `/.agnix.toml` | `npm run lint` |
| `npm run lint:secrets` | секреты во всей истории git | `/.betterleaks.toml` | pre-commit (staged) |
| `npm run lint:deps` | известные уязвимости в `package-lock.json` | `/osv-scanner.toml` | — |

- **Knip.** Экспорт, нужный только своему файлу, — без `export`; ненужный никому — удаляется. Экспорты `.cjs` Knip не
  проверяет: обращения к свойствам `module.exports` (`state.requireAuth()`) он не прослеживает. Файлы адаптера, которые
  подставляет плагин сборки, и зависимости кода vendor/ccr перечислены в конфиге с причиной.
- **ast-grep.** `.cjs` и `.mjs` разбираются парсером TypeScript (`languageGlobs`). Правило: `no-iterator-chain`
  (`filter` / `map` / `flatMap` подряд). Новое правило — с тестом в `.ast-grep/tests/` и снапшотом
  (`mise x -- ast-grep test -U`). Известные пропуски: цепочка за `!` / `as` / скобками и пары итераторов кроме
  `filter` / `map` / `flatMap`.
- **Новый `lint:*`** — и в `npm run lint`, если он быстрый и не ходит в сеть.
- **Секреты.** Отчёт — с `--redact -v`: файл и строка, значение скрыто. Исключение в `.betterleaks.toml` — точечное:
  путь + значение (`regexTarget = "secret"`), не весь каталог.
- **Уязвимости.** Исправление — обновление пакета; иначе исключение с `reason` и `ignoreUntil`.

Исключение из любой проверки — в её конфиге и всегда с причиной.

## Поток проверки

1. **Перед правкой** сомнительного места — открой конфиг и прочитай релевантную секцию.
2. **После каждой правки** срабатывает PostToolUse-хук `.claude/hooks/lint.sh`:

   - `eslint` для `.ts/.js/.mjs/.cjs` по одному файлу;
   - `tsc -p tsconfig.json --incremental` для `.ts` — типы по всему проекту (кэш в
     `node_modules/.cache/claude-tsc.tsbuildinfo`, таймаут 90 сек). Ошибки в правленом файле блокируют; ошибки в других
     файлах показываются предупреждением;
   - `severity: error` в правленом файле → exit 2, правка блокируется, ошибки — в stderr;
   - `severity: warning` → exit 0, предупреждения всё равно в stderr;
   - сбой линтера → exit 1 + диагностика.

3. **Перед завершением задачи** — `npm run lint` (eslint, tsc, prettier, Knip, ast-grep, agnix параллельно),
   `bun run test` и `npm run test:legacy`; правка зависимостей — ещё `npm run lint:deps`, правка сборки —
   `bun run build` и `bun run test:package`. 0 errors и 0 warnings в новом коде.

## Запреты

- Не отключать правила через `// eslint-disable*`, `@ts-ignore`, `@ts-expect-error` ради прохождения проверки.
- Не ослаблять и не удалять правила в `eslint.config.mjs` / `tsconfig.json`. Действующие послабления и причины
  перечислены ниже («Послабления») — новые заводятся только с обоснованием там же.
- Не обходить типы через `any`, `as unknown as T`, `@ts-nocheck`.
- Не править vendor/ccr ради проверки — ни автофиксом, ни руками.
- Автофиксы допустимы (`eslint --fix`, `prettier --write`), после автофикса — прочитай диф. Исключение —
  `jsdoc/require-jsdoc`: его фикс вставляет пустые заглушки `/** */`, описания пиши руками.
- Если непонятно, как починить правильно, — спроси. Не прячь проблему в TODO.

## Послабления

- `no-undef` выключен для TS: необъявленное имя ловит `tsc`.
- `no-console` выключен: это CLI, консоль — его интерфейс.
- `@typescript-eslint/no-require-imports` выключен для `.cjs`: `require` — штатный импорт CommonJS, а ленивый `require`
  внутри команды не грузит лишние модули.
- Глобал `Bun` объявлен в eslint: рантайм CLI — Bun.
