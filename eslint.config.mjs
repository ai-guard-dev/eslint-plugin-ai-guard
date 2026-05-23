import aiGuard from 'eslint-plugin-ai-guard';
import tsParser from '@typescript-eslint/parser';

export default [
  // Ignore generated / dependency directories
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'out/**',
      // Test fixtures intentionally contain both valid and invalid code patterns
      'tests/fixtures/**',
    ],
  },

  // ai-guard: catch AI-generated code patterns
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'ai-guard': aiGuard,
    },
    rules: {
      ...aiGuard.configs.recommended.rules,
    },
  },
];
