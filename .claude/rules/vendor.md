---
paths:
  - "vendor/**"
  - "src/transport/**"
  - "scripts/build.ts"
---

# vendor/ccr и адаптер

`vendor/ccr` — исходники claude-code-router (core и shared) закреплённой ревизии upstream, байт в байт. Ревизия,
происхождение и граница адаптера — `vendor/ccr/PROVENANCE.md`, хеши исходных файлов — `vendor/ccr/original-sha256.json`,
лицензия — `vendor/ccr/LICENSE`.

1. **vendor/ccr не правится.** Ни руками, ни автофиксом, ни переводом строк: `.gitattributes` держит `vendor/** -text`,
   а линтеры, prettier, editorconfig и хук его исключают. Нужно другое поведение — подмена через адаптер.
2. **Адаптер — `src/transport/`.** Плагин `Bun.build` в `scripts/build.ts` на этапе сборки подставляет вместо модулей
   upstream свои файлы: `@/transformer` → `registry.ts` (только Anthropic, OpenAI, Responses, Codex),
   `@caeliq/ccr-shared` → `shared.ts`, `tiktoken` → `tiktoken.ts` (WASM встроен в бандл base64-модулем), воркер подсчёта
   токенов → `token-count.ts`. Новая подмена — в плагине сборки, в `paths` `tsconfig.json` (иначе её не увидит
   typecheck) и в `entry` `knip.jsonc`. Исключения из `paths`: `tiktoken` (tsc читает типы самого пакета, адаптер
   повторяет его API), виртуальные `tiktoken-bindings` / `tiktoken-wasm` (объявлены в `tiktoken.types.ts`) и
   `./token-count-worker` (подменяется только для импорта из `utils/router.ts`, а алиас `paths` подменил бы его для
   всех). Контракт такой подмены держат типы: экспорты адаптера объявлены через `typeof` экспортов upstream.
3. **Контракт подмен — экспорты upstream.** Имена и форма экспортов файла адаптера повторяют модуль, который он
   заменяет (отсюда default-экспорт `registry.ts`).
4. **Обновление upstream** — новая ревизия целиком: исходники, `original-sha256.json`, `PROVENANCE.md`, затем
   `bun run typecheck`, `bun run test`, `bun run build`.
5. **Сверка хешей** — `scripts/verify-vendor.ts`: `bun run lint:vendor` и первый шаг `bun run build` (а с ним
   standalone и релиза). Расхождение с `original-sha256.json` роняет сборку списком файлов.
