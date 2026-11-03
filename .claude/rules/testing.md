---
paths:
  - "tests/**"
  - "scripts/test*.cjs"
  - "verify*.cjs"
---

# Тестирование

Тестового фреймворка нет: тесты — скрипты на `node:assert/strict`, каждый сценарий печатает строку `PASS: …`,
падение — исключение и ненулевой код выхода.

| Команда | Что | Как |
|---|---|---|
| `bun run test` | офлайн-тесты нового CLI: настройки, транспорт CCR → mock Codex, SSE, отмена, PKCE OAuth, refresh, миграция, setup | `scripts/test.cjs` собирает `tests/offline.cjs` esbuild-ом с плагином `scripts/build.cjs` и запускает бандл |
| `bun scripts/test.cjs --standalone` | те же тесты скомпилированным бинарником без Node/Bun в `PATH` | `bun build --compile` |
| `bun run test:package` | `npm pack`, чистая установка tarball, сохранность state, standalone | `scripts/test-package.cjs`; нужен `bun run build:standalone` |
| `npm run test:legacy` | старый путь `claude-gpt*`: live settings, откат, транспорт | `verify.cjs`, `verify-transport.cjs` |

1. **Без настоящих учётных данных и сети.** State — во временном каталоге (`CLAUDE_CODEX_STATE_DIR` на `mkdtemp`),
   upstream Codex и token endpoint — локальные моки, токены — фейковые. Настоящий запрос — только `claude-codex doctor`
   руками, не в тестах.
2. **Новый сценарий** — в `tests/offline.cjs` отдельным блоком со своей строкой `PASS: …`, описывающей проверенное.
3. **Логика, до которой тест не дотянется** (браузер, реальный Codex), выносится в чистую функцию и тестируется она,
   обёртка остаётся тонкой.
4. **Гейт коммита** (`.husky/pre-commit`) гоняет `npm test` целиком — тесты офлайн и идут меньше секунды. `test:legacy`
   и `test:package` — руками перед завершением задачи, если правка их касается.
5. **Стиль** — конвенции проекта действуют и в тестах: JSDoc на русском, `arrow-body-style`, без цепочек итераторов.
