// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

/**
 * Shared FLASHSALE ESLint config (flat config, ESLint 9).
 *
 * Rules here encode section 51 of the project brief:
 * - no `any` unless justified (explicit eslint-disable with a reason)
 * - no magic strings for anything that should be a constant/enum
 * - consistent import ordering so diffs stay small
 *
 * Type-aware linting (recommendedTypeChecked, no-floating-promises, etc.)
 * is scoped to `src/**\/*.{ts,tsx}` ONLY. Every package's tsconfig.json
 * only `include`s its `src/` directory (see packages/*\/tsconfig.json) --
 * root-level files like eslint.config.js, vitest.config.ts, next.config.ts
 * are deliberately outside every tsconfig's project, so asking
 * typescript-eslint's `projectService` to type-check them fails with
 * "was not found by the project service". Those files still get
 * non-type-aware TS/JS linting (tseslint.configs.recommended, without the
 * TypeChecked suffix), which is all a handful of config files need.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // `any` defeats the entire point of strict mode. Force an explicit,
      // reviewable opt-out instead of a silent escape hatch.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  importPlugin.flatConfigs.recommended,
  {
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',

      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-default-export': 'warn',
      'import/no-cycle': 'error',

      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'FLASHSALE never stores auth state in localStorage. Use HttpOnly cookies.',
        },
      ],
    },
  },
  {
    // Tooling config files are REQUIRED to use a default export by the
    // tools that load them (ESLint flat config, Vite/Vitest config) --
    // this isn't the accidental default export the rule is meant to catch.
    files: ['**/eslint.config.js', '**/vitest.config.ts', '**/vitest.integration.config.ts', '**/next.config.ts'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  {
    // Test doubles routinely need to be `async` to satisfy an interface
    // (e.g. `() => Promise<void>`) without needing a real `await` inside
    // -- a fake `closeEmailWorker: async () => { order.push('email') }`
    // is not the "forgot to await" bug this rule exists to catch
    // elsewhere; it's a deliberate, minimal stand-in for a real async
    // dependency.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      // `expect(mockObject.method).toHaveBeenCalledWith(...)` is the
      // standard vitest/jest assertion shape, and it's a well-known
      // false positive for this rule (flagging that `method` is
      // "unbound" from `mockObject`) -- the assertion never actually
      // invokes the method in a detached `this` context, it just reads
      // the mock's call history.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  prettier,
);
