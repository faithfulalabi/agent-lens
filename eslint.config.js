import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'ui/dist',
      'ui/node_modules',
      'node_modules',
      'internal_docs',
      'test-results',
      'playwright-report',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['ui/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@shared/index', '@shared/index.*', '**/src/shared/index*'],
              message:
                'The @shared barrel re-exports token.js and pricing.js, which import ' +
                'node:crypto/fs/os/path — importing it drags Node builtins into the ' +
                'browser bundle. Import the module directly instead: @shared/entities.ts, ' +
                '@shared/api.ts.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
