---
paths:
  - "vendor/**"
  - "src/transport/**"
  - "scripts/build.cjs"
---

# vendor/ccr и адаптер

`vendor/ccr` — исходники claude-code-router (core и shared) закреплённой ревизии upstream, байт в байт. Ревизия,
происхождение и граница адаптера — `vendor/ccr/PROVENANCE.md`, хеши исходных файлов — `vendor/ccr/original-sha256.json`,
лицензия — `vendor/ccr/LICENSE`.

1. **vendor/ccr не правится.** Ни руками, ни автофиксом, ни переводом строк: `.gitattributes` держит `vendor/** -text`,
   а линтеры, prettier, editorconfig и хук его исключают. Нужно другое поведение — подмена через адаптер.
2. **Адаптер — `src/transport/`.** Плагин `scripts/build.cjs` на этапе сборки подставляет вместо модулей upstream свои
   файлы: `@/transformer` → `registry.ts` (только Anthropic, OpenAI, Responses, Codex), `@caeliq/ccr-shared` →
   `shared.ts`, `tiktoken` → `tiktoken.cjs` (WASM встроен в бандл), воркер подсчёта токенов → `token-count.ts`.
   Новая подмена — в плагине сборки, в `paths` `tsconfig.json` (иначе её не увидит typecheck) и в `entry` `knip.jsonc`.
3. **Контракт подмен — экспорты upstream.** Имена и форма экспортов файла адаптера повторяют модуль, который он
   заменяет (отсюда default-экспорт `registry.ts`).
4. **Обновление upstream** — новая ревизия целиком: исходники, `original-sha256.json`, `PROVENANCE.md`, затем
   `npm run typecheck`, `bun run test`, `bun run build`.
