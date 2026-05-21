import type { TSESLint } from '@typescript-eslint/utils';

const strict: TSESLint.ClassicConfig.Config = {
  plugins: ['ai-guard'],
  rules: {
    // Strict preset: enforce every ai-guard rule at error for mature teams
    // that want maximum coverage and are ready to tune exceptions locally.

    // Error Handling - all at error
    'ai-guard/no-empty-catch': 'error',
    'ai-guard/no-broad-exception': 'error',
    'ai-guard/no-catch-log-rethrow': 'error',
    'ai-guard/no-catch-without-use': 'error',
    // Async - all at error
    'ai-guard/no-async-array-callback': 'error',
    'ai-guard/no-floating-promise': 'error',
    'ai-guard/no-await-in-loop': 'error',
    'ai-guard/no-async-without-await': 'error',
    'ai-guard/no-redundant-await': 'error',
    // Security - all at error
    'ai-guard/no-hardcoded-secret': 'error',
    'ai-guard/no-eval-dynamic': 'error',
    'ai-guard/no-sql-string-concat': 'error',
    'ai-guard/no-unsafe-deserialize': 'error',
    'ai-guard/require-auth-middleware': 'error',
    'ai-guard/require-authz-check': 'error',
    // AI Patterns - all at error
    'ai-guard/no-console-in-handler': 'error',
    'ai-guard/no-duplicate-logic-block': 'error',
    'ai-guard/no-dead-branch': 'error',
  },
};

export default strict;
