---
paths:
  - ".github/**"
  - "install.sh"
  - "scripts/standalone.ts"
---

# Релизы и установка

Бинарники для установки без Bun — standalone-сборка (`scripts/standalone.ts`), которую публикует
`.github/workflows/release.yml` и ставит `install.sh`.

1. **Триггер** — push тега `v*`; тег обязан совпадать с `v` + `version` из `package.json`, иначе сборка падает.
   Версия с суффиксом (`-dev.1`) — prerelease. `workflow_dispatch` только собирает и тестирует, без публикации.
2. **Каждый таргет — на своём раннере** (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`):
   typecheck, `test`, `test.ts --standalone`, `test:e2e`. Кросс-компиляцию в релиз не берём — она не доказывает запуск.
3. **Имена ассетов без версии**: `claude-codex-<os>-<arch>.tar.gz` (каталог с бинарником и лицензиями) и `SHA256SUMS`.
   `install.sh` строит URL из этих имён — переименование ассета ломает установщик уже выпущенных версий.
4. **Bun 1.4.4** закреплён и в `scripts/standalone.ts`, и в workflow (`bun-version`): смена версии — в обоих местах
   вместе с `licenses/BUN-*-LICENSE.md`.
5. **Actions — по SHA коммита** с тегом в комментарии; `persist-credentials: false`, право `contents: write` — только
   у job публикации.
6. **`install.sh`** — POSIX sh, проверяется `mise x shellcheck@0.11.0 -- shellcheck install.sh`; workflow —
   `mise x actionlint@latest -- actionlint`. Установщик обязан сверять SHA256 и не трогать state и конфигурацию Claude;
   строки вывода — на английском.
