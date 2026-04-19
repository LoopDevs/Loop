import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

// eslint-plugin-react intentionally NOT imported: we never opted into its
// `recommended` config, and the only two rules we referenced
// (react/react-in-jsx-scope, react/prop-types) were both set to `off`. It
// was dead weight that also blocked upgrading to eslint 10 because its peer
// range is capped at `^9.7`. If we later want real React rules (jsx-key,
// jsx-no-target-blank), re-add the plugin in a focused PR with an explicit
// set of enabled rules.

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.react-router/**',
      '**/packages/shared/src/proto/**',
      '**/*.generated.ts',
      '**/vitest.config.ts',
      '**/tsup.config.ts',
      '**/vite.config.ts',
      '**/react-router.config.ts',
      '**/capacitor.config.ts',
      'playwright.config.ts',
      'playwright.mocked.config.ts',
      'commitlint.config.js',
      // NOTE: tests/ is intentionally NOT listed here. A top-level `ignores`
      // block excludes files from every subsequent config in flat config —
      // so if we ignored `tests/**` here, the `files: ['tests/**/*.ts']`
      // override below would never match and our Playwright e2e tests
      // would go completely unlinted.
    ],
  },
  // ─── All TypeScript files ───────────────────────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        // project: true enables typed lint rules (no-floating-promises etc.)
        // Each file uses the nearest tsconfig.json in its directory tree.
        project: true,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // TypeScript — basic rules (no type information needed)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // TypeScript — typed rules (require parserOptions.project)
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // General
      'no-console': 'error',
      'no-debugger': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],

      // React hooks
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps catches real bugs (most recently the PaymentStep
      // polling regression). Warnings get ignored; make this an error so CI
      // fails on it. Intentional escape hatches still work via inline
      // // eslint-disable-next-line react-hooks/exhaustive-deps comments.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // ─── Web app — enforce import boundaries ────────────────────────────────────
  //
  // AGENTS.md architecture rule #3: "All Capacitor plugin calls live in
  // `apps/web/app/native/`." The intent covers the whole Capacitor
  // ecosystem, not just the `@capacitor/*` core — `@aparajita/capacitor-*`
  // (biometric-auth, secure-storage, ADR-006) and `@capgo/inappbrowser`
  // are Capacitor plugins that must be wrapped in native/ so web still
  // gets a graceful fallback and test files can mock them at one boundary.
  {
    files: ['apps/web/app/**/*.ts', 'apps/web/app/**/*.tsx'],
    ignores: ['apps/web/app/native/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@capacitor/*', '@aparajita/capacitor-*', '@capgo/*'],
              message:
                'Capacitor plugins must only be imported in app/native/. Import from ~/native/ instead.',
            },
          ],
        },
      ],
    },
  },
  // ─── Test files — relax rules that hamper test expressiveness ───────────────
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Typed rules can be slow on test files; typed assertions are common in tests
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
  // ─── Playwright e2e tests ───────────────────────────────────────────────────
  // tests/ doesn't have its own tsconfig.json, so typed-lint rules (which
  // require parserOptions.project) can't resolve. Override with project:null
  // so only untyped rules run. That's enough to catch no-console, eqeqeq,
  // prefer-const style issues in e2e specs; full typed-lint on e2e would
  // require a tests/tsconfig.json and isn't worth the setup right now.
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: null,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      // Typed rules that need parserOptions.project — disable explicitly so
      // their `| never` unreachable config doesn't get evaluated.
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
];
