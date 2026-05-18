// Flat config (ESLint 9). Type-aware linting via typescript-eslint's
// projectService, which picks up tsconfig.json automatically.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, deps, and config files are not linted.
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // SDK embeds in customer servers: unused code is a real smell, but
      // allow leading-underscore args for interface-driven signatures.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Passive capture touches untyped peer payloads (express/ws); warn
      // rather than block so intentional `any` at boundaries is visible.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Tests and config: looser, no type-checking project required.
    files: ['test/**/*.ts', '*.config.{ts,js}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
