import type { TSESLint } from '@typescript-eslint/utils';

const recommended: TSESLint.ClassicConfig.Config = {
  plugins: ['ai-guard'],
  rules: {
    // Adoption-first default:
    // Keep only high-confidence, high-impact rules at error so first run is actionable,
    // not overwhelming. Context-sensitive rules are warn/off by design.

    // ── Reliability ────────────────────────────────────────────────────────────
    // Critical (error): low-noise, high-impact correctness failures.
    'ai-guard/no-empty-catch': 'error',

    // Important but context-dependent (warn).
    'ai-guard/no-broad-exception': 'warn',

    // Off in recommended — too noisy in mixed codebases.
    'ai-guard/no-catch-without-use': 'off',
    'ai-guard/no-catch-log-rethrow': 'off',

    // Warn: hardcoded secret fallbacks and catch blocks that hide failed I/O.
    'ai-guard/no-silent-fallback': 'warn',

    // ── Async ──────────────────────────────────────────────────────────────────
    'ai-guard/no-floating-promise': 'error',
    'ai-guard/no-await-in-loop': 'warn',
    'ai-guard/no-async-without-await': 'warn',
    'ai-guard/no-async-array-callback': 'warn',

    // Off in recommended — reduces noise in common patterns.
    'ai-guard/no-redundant-await': 'off',

    // ── Security ───────────────────────────────────────────────────────────────
    // Critical (error): direct security vulnerabilities.
    'ai-guard/no-hardcoded-secret': 'error',
    'ai-guard/no-eval-dynamic': 'error',
    'ai-guard/no-client-exposed-secret': 'error',
    'ai-guard/no-invisible-unicode': 'error',

    // Context-sensitive (warn): useful but require project context.
    'ai-guard/no-sql-string-concat': 'warn',
    'ai-guard/no-unsafe-deserialize': 'warn',
    'ai-guard/require-auth-middleware': 'warn',
    'ai-guard/require-authz-check': 'warn',
    'ai-guard/no-unsanitized-html': 'warn',
    // Warn on upgrade: existing phantom dependencies should not break CI on day one.
    'ai-guard/no-undeclared-import': 'warn',

    // ── AI Patterns ────────────────────────────────────────────────────────────
    // Warn: useful signal, but may fire in intentional dead-code removal flows.
    'ai-guard/no-dead-branch': 'warn',
    'ai-guard/no-placeholder-implementation': 'warn',
    // Test integrity: tests that cannot fail, and code that special-cases tests.
    'ai-guard/no-tautological-assertion': 'warn',
    'ai-guard/no-assertionless-test': 'warn',
    'ai-guard/no-test-env-branch': 'warn',

    // Off in recommended — contextual rules for teams opting into stricter checks.
    'ai-guard/no-console-in-handler': 'off',
    'ai-guard/no-duplicate-logic-block': 'off',
  },
};

export default recommended;
