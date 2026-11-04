import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintPluginJsdoc from 'eslint-plugin-jsdoc';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import eslintPluginSimpleImportSort from 'eslint-plugin-simple-import-sort';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    /**
     * vendor/ccr — исходники upstream байт в байт: их хеши сверяет vendor/ccr/original-sha256.json,
     * поэтому ни линт, ни автофикс их не трогают. Остальное — сборки, артефакты и локальный state.
     */
    ignores: [
      'vendor/**',
      'dist/**',
      'node_modules/**',
      'artifacts/**',
      'licenses/**',
      '.work/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs,ts}'],
    plugins: {
      jsdoc: eslintPluginJsdoc,
      'simple-import-sort': eslintPluginSimpleImportSort,
      unicorn: eslintPluginUnicorn,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        /**
         * Рантайм — Bun: версия и признак standalone-бинарника берутся из его глобала.
         */
        Bun: 'readonly',
      },
    },
  },
  tseslint.configs.recommended,
  eslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-unused-vars': 'off',
      /**
       * Глобалы описаны типами; необъявленное имя ловит tsc. Правило даёт только ложные
       * срабатывания.
       */
      'no-undef': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      'jsdoc/require-jsdoc': [
        'error',
        {
          require: {
            ArrowFunctionExpression: false,
            ClassDeclaration: false,
            FunctionDeclaration: false,
            FunctionExpression: false,
            MethodDefinition: false,
          },
          contexts: ['TSPropertySignature'],
        },
      ],
      'jsdoc/require-description': [
        'error',
        {
          contexts: ['TSPropertySignature'],
        },
      ],
    },
  },
  {
    files: ['**/*.{js,cjs,mjs,ts}'],
    rules: {
      'jsdoc/multiline-blocks': [
        'error',
        {
          noSingleLineBlocks: true,
          singleLineTags: [],
        },
      ],
      'arrow-body-style': ['error', 'always'],
      'arrow-parens': ['error', 'always'],
      /**
       * Это CLI: консоль — его интерфейс, а не отладочный вывод.
       */
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      /**
       * Импорты одного вида из одного спецификатора сливаются в один; пара `import type` и импорта
       * значений остаётся раздельной — так тип виден в строке импорта.
       */
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^\\u0000'],
            ['^node:'],
            ['^@?\\w'],
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
          ],
        },
      ],
      'operator-linebreak': [
        2,
        'after',
        {
          overrides: {
            '?': 'before',
            ':': 'before',
          },
        },
      ],
      'padded-blocks': [2, 'never'],
      'no-fallthrough': [2, { allowEmptyCase: true }],
      'unicorn/switch-case-braces': ['error', 'always'],
      'padding-line-between-statements': [
        2,
        {
          blankLine: 'always',
          prev: '*',
          next: 'return',
        },
        {
          blankLine: 'always',
          prev: ['const', 'let', 'var'],
          next: '*',
        },
        {
          blankLine: 'any',
          prev: ['const', 'let', 'var'],
          next: ['const', 'let', 'var'],
        },
        {
          blankLine: 'always',
          prev: 'directive',
          next: '*',
        },
        {
          blankLine: 'any',
          prev: 'directive',
          next: 'directive',
        },
        {
          blankLine: 'always',
          prev: 'block-like',
          next: '*',
        },
        {
          blankLine: 'always',
          prev: 'multiline-block-like',
          next: '*',
        },
        {
          blankLine: 'always',
          prev: '*',
          next: 'multiline-block-like',
        },
        {
          blankLine: 'always',
          prev: '*',
          next: ['case', 'default'],
        },
      ],
    },
  }
);
