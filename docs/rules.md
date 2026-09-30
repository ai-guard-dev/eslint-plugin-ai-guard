# Rules

`eslint-plugin-ai-guard` currently ships 18 rules across four categories:

- Error handling
- Async correctness
- Security
- Code quality / logic

Recent improvements:

- Safe autofix support is available for selected high-confidence rules (see per-rule docs).
- `no-sql-string-concat` is now context-aware for known query builders to reduce false positives.

Use the full reference for per-rule severity, examples, and fix guidance:

- [Full Rules Reference](./rules/README.md)

Quick links:

- [Error Handling Rules](./rules/README.md#-error-handling)
- [Async Correctness Rules](./rules/README.md#-async-correctness)
- [Security Rules](./rules/README.md#-security)
- [Code Quality Rules](./rules/README.md#-code-quality)

Preset summary:

- `recommended`: adoption-first, low-noise defaults
- `strict`: all rules at `error`
- `security`: security-only profile
