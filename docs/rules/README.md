# Rules Reference

All 18 rules provided by `eslint-plugin-ai-guard`, organized by category.

---

## 🟠 Reliability

| Rule | Recommended | Strict | Description |
|---|---|---|---|
| [no-empty-catch](no-empty-catch.md) | `error` | `error` | Empty catch blocks silently discard errors (safe autofix available) |
| [no-broad-exception](no-broad-exception.md) | `warn` | `error` | `catch (e: any)` loses all type information |
| [no-catch-log-rethrow](no-catch-log-rethrow.md) | `off` | `error` | Log-then-rethrow adds noise, no recovery |
| [no-catch-without-use](no-catch-without-use.md) | `off` | `error` | Catch parameter declared but never used |

## 🟡 Async Stability

| Rule | Recommended | Strict | Description |
|---|---|---|---|
| [no-floating-promise](no-floating-promise.md) | `error` | `error` | Async call without `await` or `.catch()` (safe autofix adds `void`) |
| [no-async-array-callback](no-async-array-callback.md) | `warn` | `error` | `array.map(async ...)` returns `Promise[]`, not values |
| [no-await-in-loop](no-await-in-loop.md) | `warn` | `error` | Independent sequential `await` in loops — intent-aware with safe autofix for simple cases |
| [no-async-without-await](no-async-without-await.md) | `warn` | `error` | `async` function that never uses `await` (safe autofix for simple bodies) |
| [no-redundant-await](no-redundant-await.md) | `off` | `error` | `return await` outside try/catch is redundant |

## 🔴 Security

| Rule | Recommended | Security | Strict | Description |
|---|---|---|---|---|
| [no-hardcoded-secret](no-hardcoded-secret.md) | `error` | `error` | `error` | API keys / passwords in source code (safe autofix to `process.env`) |
| [no-eval-dynamic](no-eval-dynamic.md) | `error` | `error` | `error` | `eval()` or `new Function()` with dynamic content |
| [no-sql-string-concat](no-sql-string-concat.md) | `warn` | `error` | `error` | SQL queries built with string concatenation (builder-aware to reduce false positives) |
| [no-unsafe-deserialize](no-unsafe-deserialize.md) | `warn` | `warn` | `error` | `JSON.parse()` on untrusted input without validation |
| [require-auth-middleware](require-auth-middleware.md) | `warn` | `warn` | `error` | Express/Fastify routes without auth middleware |
| [require-authz-check](require-authz-check.md) | `warn` | `warn` | `error` | No ownership check when accessing resources by ID |

## 🔵 AI Patterns

| Rule | Recommended | Strict | Description |
|---|---|---|---|
| [no-dead-branch](no-dead-branch.md) | `warn` | `error` | `if (true)`, `x===x`, `x&&!x` — AI scaffolding leftovers that create dead code |
| [no-duplicate-logic-block](no-duplicate-logic-block.md) | `off` | `error` | Copy-pasted logic blocks that should be extracted |
| [no-console-in-handler](no-console-in-handler.md) | `off` | `error` | `console.*` inside HTTP route handlers |

---

## Preset Comparison

| Preset | Use Case | All 18 Rules? |
|---|---|---|
| `recommended` | Start here — low noise, high-value rules enabled | No — off/warn for noisy rules |
| `strict` | Maximum enforcement — mature codebase | Yes — all at `error` |
| `security` | Security audit focus | Security rules only |
