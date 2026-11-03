/**
 * Ключи не перекрываются: lint-staged запускает их параллельно, а `ast-grep scan` должен читать
 * файл после правки — поэтому он идёт в том же массиве за редактирующей командой.
 *
 * `--no-warn-ignored`: staged-файл из vendor/ccr eslint игнорирует молча, без предупреждения.
 */
export default {
  '*.{ts,cjs,mjs,js}': ['eslint --fix --no-warn-ignored', 'mise x -- ast-grep scan'],
  '*.{json,yml,yaml}': 'prettier --write',
};
