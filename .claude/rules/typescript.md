---
paths:
  - "**/*.ts"
  - "tsconfig.json"
---

# TypeScript

TypeScript в проекте — только адаптер `src/transport/` к исходникам vendor/ccr; остальной код — CommonJS (`.cjs`).

1. Типы — в отдельных `*.types.ts` рядом с кодом (`server.ts` → `server.types.ts`). Не инлайни объектные типы в
   сигнатуре: правило jsdoc ниже требует описания каждого поля, а в сигнатуре его негде писать.
2. `type`, не `interface` (`@typescript-eslint/consistent-type-definitions`).
3. `const enum` или `as const`-объекты; обычный `enum` — только если нужно runtime-значение.
4. `any` запрещён. Не типизируется — бери `unknown` и сужай проверкой. Типы данных upstream — из vendor/ccr
   (`import type { UnifiedChatRequest } from '…/vendor/ccr/core/src/types/llm'`), не копией.
5. Type-гарды — функциями рядом с соответствующими типами.
6. В рамках одного файла допустимы локальные алиасы для читаемости (`type TokenCountArgs = Parameters<…>`).
7. `T[]`, а не `Array<T>`.
8. Не кастуй через `as` без обоснования. *(см. ниже)*
9. JSDoc обязателен для каждого поля типа; описание — непустое и осмысленное (`jsdoc/require-jsdoc` +
   `jsdoc/require-description` на `TSPropertySignature`). На сам тип — по желанию, если имя не объясняет назначение.
10. `import type` для импорта только типов.

---

## Подробности

### #8. Не кастуй через `as` без обоснования

**Why:** `as` отключает проверку компилятора. Ошибся в касте — баг доедет до пользователя молча.

**Когда `as` оправдан:**

- `as const` — фиксация литерального типа, не каст;
- сразу после type-guard / рантайм-валидации;
- ошибка в типах upstream, которую не исправить без правки vendor/ccr, — с комментарием-обоснованием.

**Плохо:**

```ts
await registerApiRoutes(app as any);
const config = rawValue as unknown as Config;
```

### Проверка типов

`npm run typecheck` — `tsc -p tsconfig.json`. В проверку транзитивно попадает vendor/ccr: `tsconfig.json` повторяет
подмены `scripts/build.cjs` (`@/transformer`, `@/*`, `@caeliq/ccr-shared`). `openai` и `@anthropic-ai/sdk` в
devDependencies — только ради их типов в коде upstream; в бандл они не попадают.
