import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Single flat config for the whole monorepo. Root `pnpm lint` runs `eslint .` once,
 * which avoids per-package config resolution entirely.
 *
 * Deliberately NOT using type-aware rules (recommendedTypeChecked): they require a
 * TS program per package and are slow/brittle in CI. `pnpm typecheck` is the source
 * of truth for type errors.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.cache/**',
      'packages/db/drizzle/**',
      // Playwright writes traces and screenshots here, including minified third-party JS that
      // would otherwise be linted as if we had written it.
      '**/test-results/**',
      '**/playwright-report/**',
      '**/blob-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /* Plain JS tooling: config files, benchmarks, scripts. Node globals, no TS rules. */
  {
    files: ['**/*.{mjs,cjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
  },

  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  /* Browser code: React rules + browser globals. */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  /*
   * NestJS relies on parameter decorators and empty constructors.
   *
   * consistent-type-imports must be OFF here: with emitDecoratorMetadata, TypeScript
   * emits `design:paramtypes` referencing the imported class as a runtime value. An
   * `import type` would be elided and dependency injection would break at runtime,
   * even though the import looks type-only to a non-type-aware linter.
   */
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  /*
   * shadcn/ui components export their cva variants next to the component by
   * convention, which the react-refresh rule flags. Keeping the convention is worth
   * more than HMR purity on a leaf component file.
   */
  {
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  /*
   * Tests may assert on fixtures they just constructed. Requiring optional-chaining
   * ceremony there hides what the test is actually checking.
   */
  {
    files: ['**/*.{test,spec}.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  prettier,
);
