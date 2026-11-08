import type { TSESLint } from '@typescript-eslint/utils';

const security: TSESLint.ClassicConfig.Config = {
  plugins: ['ai-guard'],
  rules: {
    // Security-only preset:
    // Error = direct high-risk patterns. Warn = security-relevant but context-sensitive.
    'ai-guard/no-hardcoded-secret': 'error',
    'ai-guard/no-eval-dynamic': 'error',
    'ai-guard/no-sql-string-concat': 'error',
    'ai-guard/no-client-exposed-secret': 'error',
    'ai-guard/no-invisible-unicode': 'error',
    'ai-guard/no-unsanitized-html': 'error',
    'ai-guard/no-unsafe-deserialize': 'warn',
    'ai-guard/require-auth-middleware': 'warn',
    'ai-guard/require-authz-check': 'warn',
    'ai-guard/no-undeclared-import': 'warn',
    'ai-guard/no-silent-fallback': 'warn',
  },
};

export default security;
