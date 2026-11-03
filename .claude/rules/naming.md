---
paths:
  - "**/*.{cjs,mjs,js,ts}"
---

# Именование

Здесь — только конвенции, которые линтер не проверяет.

1. Переменные и функции — `camelCase`, константы — `SCREAMING_SNAKE_CASE`, классы и типы — `PascalCase`.
2. Типы без венгерской нотации (`IData`, `TUser`).
3. Обработчики событий — `handle…` (`handleCallback`), колбэки в параметрах и опциях — `on…` (`onAbort`).
4. Булевы переменные и поля — только с префиксами `is`, `has`, `should`. *(см. ниже)*
5. Короткие, но точные имена: `auth`, `settings`, `router`, а не `data`, `obj`, `tmp`.
6. Тип параметров функции-объекта — `{FunctionName}Options` (`CreateRouterOptions`).
7. Имена переменных окружения — `CLAUDE_CODEX_*`; `CLAUDE_GPT_*` — только старый путь и обратная совместимость.

---

## Подробности

### #4. Префиксы булевых переменных

| Префикс  | Когда                                              |
|----------|----------------------------------------------------|
| `is`     | текущее состояние: `isStandalone`, `isTextDelta`   |
| `has`    | наличие чего-то: `hasRefreshToken`, `hasErrors`    |
| `should` | необходимость действия: `shouldRefresh`            |

**Плохо:**

```js
const standalone = true;   // нет префикса
const canWrite = true;     // префикс вне списка
const needsRefresh = true; // префикс вне списка
```
