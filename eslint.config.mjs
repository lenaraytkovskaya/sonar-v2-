import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
export default ts.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/next-env.d.ts',
      'wiki/**',
      '.agents/**',
      '.codex/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
);
