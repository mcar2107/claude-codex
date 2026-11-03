# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Здесь — то, что нужно в любой задаче. Конвенции и устройство подсистем — в `.claude/rules/*.md` с `paths:`: файл
правила подгружается сам, когда агент работает с его файлами (таблица — «Правила для агентов»).

## Что это

claude-codex — мост Claude Code → Codex OAuth. Claude Code остаётся отдельно установленным клиентом (`claude` в
`PATH`); пакет поднимает на каждую сессию свой локальный сервер CCR (claude-code-router) с приватным ключом и портом,
переводит Anthropic Messages API в Responses API Codex и подставляет модель и effort из живых настроек. Пользовательская
документация, статус и ограничения — `README.md`.

## Стек и команды

CommonJS (`.cjs`) на Bun ≥ 1.4, адаптер к CCR — TypeScript. Сборка — esbuild в один `dist/cli.cjs` (npm bin
`claude-codex`) и `bun build --compile` в standalone-бинарник. Пакетный менеджер — npm (`package-lock.json`); бинарные
инструменты проверок — mise (`.mise.toml`).

```bash
npm ci                    # зависимости и хук husky
mise install              # ast-grep, betterleaks, osv-scanner, agnix (linting.md)
bun run build             # dist/cli.cjs
bun run build:standalone  # artifacts/<target>/claude-codex
bun run test              # офлайн-тесты (testing.md)
npm run test:legacy       # старый путь claude-gpt*
bun run test:package      # tarball, чистая установка, standalone
npm run typecheck         # tsc
npm run lint              # eslint, tsc, prettier --check, Knip, ast-grep, agnix
npm run lint:fix          # eslint --fix
npm run format            # prettier --write
npm run lint:secrets      # секреты в истории git; lint:deps — уязвимости
```

## Карта кода

```
src/
  cli.cjs                 вход CLI: launch, auth, doctor, settings, models, setup, migrate
  session.cjs             сессия: свой роутер на порту с ключом, запуск клиента, завершение
  state.cjs               state-каталог (~/.claude-codex, CLAUDE_CODEX_STATE_DIR), настройки, OAuth-файл
  auth.cjs                PKCE OAuth login, status
  settings.cjs setup.cjs migrate.cjs   настройки и модели, slash-команды /codex-*, перенос state
  transport/              адаптер к vendor/ccr: сервер Fastify и подмены модулей upstream (vendor.md)
vendor/ccr/               исходники CCR upstream байт в байт — не править (vendor.md)
scripts/                  сборка (build.cjs — плагин подмен), standalone, лицензии, тест-раннеры
tests/offline.cjs         офлайн-тесты нового CLI (testing.md)
*.cjs в корне              старый путь claude-gpt* (bridge, install, prepare, settings, lib, verify*) — путь отката
eslint.config.mjs .prettierrc .lintstagedrc.mjs .husky/ tsconfig.json knip.jsonc sgconfig.yml .ast-grep/
.agnix.toml .betterleaks.toml osv-scanner.toml .mise.toml   линтеры и гейт коммита (linting.md)
```

## Сквозные правила

- **vendor/ccr не правится** — поведение меняется подменой в адаптере `src/transport/` (`vendor.md`).
- **Без настоящих учётных данных.** Ни токены, ни локальный ключ сессии не печатаются, не логируются и не попадают
  в метаданные и тесты; тесты — на моках и временном state (`testing.md`).
- **State пользователя не перезаписывается молча.** Миграция, setup и установка проверяют все цели до первой записи
  и не заменяют чужие файлы и команды.
- **Старый путь `claude-gpt*`** (корневые `*.cjs`, `.runtime/`) — путь отката: меняется только по явной задаче.
- **Язык.** Комментарии, JSDoc, правила и CLAUDE.md — на русском; строки CLI и `README.md` — на английском.
- **Перед завершением задачи** — `npm run lint`, `bun run test`, `npm run test:legacy` (`linting.md`).

## Правила для агентов

`.claude/rules/*.md` подгружаются по `paths:` из frontmatter. Новое знание о подсистеме пишется в её файл правила, а не
в CLAUDE.md; новый файл правила — строкой в эту таблицу.

| Файл | О чём |
|---|---|
| `code-style.md`, `naming.md`, `comments.md` | стиль, именование, комментарии — на любой файл кода |
| `linting.md` | линтеры, поток проверки, запреты и послабления |
| `typescript.md` | типы адаптера, `as`, jsdoc на полях, typecheck с vendor |
| `testing.md` | офлайн-тесты, package-тест, старый путь |
| `vendor.md` | vendor/ccr и адаптер `src/transport/` |
