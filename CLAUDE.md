# CLAUDE.md

Инструкции для Claude Code (claude.ai/code) при работе с кодом этого репозитория.

Здесь — то, что нужно в любой задаче. Конвенции и устройство подсистем — в `.claude/rules/*.md` с `paths:`: файл
правила подгружается сам, когда агент работает с его файлами (таблица — «Правила для агентов»).

## Что это

claude-codex — мост Claude Code → Codex OAuth. Claude Code остаётся отдельно установленным клиентом (`claude` в
`PATH`); пакет поднимает на каждую сессию свой локальный сервер CCR (claude-code-router) с приватным ключом и портом,
переводит Anthropic Messages API в Responses API Codex: модель и effort — из запроса клиента (`/model`, `/effort`),
запасной вариант — настройки на старте сессии. Пользовательская
документация, статус и ограничения — `README.md`.

## Стек и команды

TypeScript + ESM (`"type": "module"`) на Bun ≥ 1.4: исходники запускаются и собираются Bun без шага компиляции, `tsc`
только проверяет типы. Сборка — `Bun.build` в один `dist/cli.js` (bin `claude-codex`) и `bun build --compile` в
standalone-бинарник. Пакетный менеджер — bun (`bun.lock`); бинарные инструменты проверок — mise (`.mise.toml`). npm-пакет
пока не собирается.

```bash
bun install               # зависимости и хук husky
mise install              # ast-grep, betterleaks, osv-scanner, agnix, shellcheck, actionlint (linting.md)
bun run build             # dist/cli.js
bun run build:standalone  # artifacts/<target>/claude-codex
bun run test              # офлайн-тесты (testing.md)
bun run test:e2e          # бандл и standalone с фейковым клиентом Claude
bun run typecheck         # tsc
bun run lint              # eslint, tsc, prettier --check, Knip, ast-grep, agnix, shellcheck/actionlint, сверка vendor
bun run lint:fix          # eslint --fix
bun run format            # prettier --write
bun run lint:secrets      # секреты в истории git; lint:deps — уязвимости
```

## Карта кода

```
src/
  cli.ts                  вход CLI: launch, auth, doctor, settings, models, setup, update
  session.ts              сессия: свой роутер на порту с ключом, запуск клиента, завершение
  state.ts                state-каталог (~/.claude-codex, CLAUDE_CODEX_STATE_DIR), настройки, OAuth-файл
  auth.ts                 PKCE OAuth login, status
  settings.ts             настройки и модели, discovery
  client.ts               подготовка клиента: модели в /model, --settings, плагин /codex:*, statusLine, model в ~/.claude
  statusline.ts           обёртка statusLine: rate_limits Codex в JSON statusline
  setup.ts                удаление глобальных /codex-* (setup --remove)
  update.ts               самообновление standalone-бинарника из GitHub Releases (update)
  *.types.ts              типы модуля рядом с ним (typescript.md)
  transport/              адаптер к vendor/ccr: сервер Fastify, лимиты Codex (limits.ts), подмены модулей upstream (vendor.md)
vendor/ccr/               исходники CCR upstream байт в байт — не править (vendor.md)
scripts/                  сборка (build.ts — плагин подмен), сверка vendor, standalone, лицензии, тест-раннеры
tests/offline.ts          офлайн-тесты нового CLI (testing.md)
.github/workflows/release.yml  сборка и публикация бинарников по тегу v* (release.md)
install.sh                установщик бинарника из GitHub Releases (release.md)
eslint.config.ts .prettierrc lint-staged.config.ts .husky/ tsconfig.json knip.jsonc sgconfig.yml .ast-grep/
.agnix.toml .betterleaks.toml osv-scanner.toml .mise.toml   линтеры и гейт коммита (linting.md)
.claude/hooks/lint.ts     PostToolUse-хук: eslint и tsc после каждой правки агента (linting.md)
```

## Сквозные правила

- **vendor/ccr не правится** — поведение меняется подменой в адаптере `src/transport/` (`vendor.md`).
- **Без настоящих учётных данных.** Ни токены, ни локальный ключ сессии не печатаются, не логируются и не попадают
  в метаданные и тесты; тесты — на моках и временном state (`testing.md`).
- **State пользователя не перезаписывается молча.** `setup --remove` проверяет все цели до первого удаления и не
  удаляет чужие или изменённые команды.
- **Язык.** Комментарии, JSDoc, правила и CLAUDE.md — на русском; строки CLI и `README.md` — на английском.
- **Перед завершением задачи** — `bun run lint`, `bun run test` (`linting.md`).

## Правила для агентов

`.claude/rules/*.md` подгружаются по `paths:` из frontmatter. Новое знание о подсистеме пишется в её файл правила, а не
в CLAUDE.md; новый файл правила — строкой в эту таблицу.

| Файл | О чём |
|---|---|
| `code-style.md`, `naming.md`, `comments.md` | стиль, именование, комментарии — на любой файл кода |
| `linting.md` | линтеры, поток проверки, запреты и послабления |
| `typescript.md` | типы адаптера, `as`, jsdoc на полях, typecheck с vendor |
| `testing.md` | офлайн-тесты, standalone и e2e |
| `vendor.md` | vendor/ccr и адаптер `src/transport/` |
| `release.md` | релизный workflow, ассеты, `install.sh` |
