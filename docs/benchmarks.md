# Benchmarks

> Honest comparison of ai-guard against other ESLint-based tools.
> Last updated: v1.2.8.

---

## What ai-guard catches that ESLint core does not

| Pattern | ai-guard Rule | ESLint Core | @typescript-eslint |
|---|---|---|---|
| Floating promises (async call without await) | `no-floating-promise` | ❌ None | `@typescript-eslint/no-floating-promises` (requires type info) |
| Async array callbacks (`.map(async ...)`) | `no-async-array-callback` | ❌ None | Partial: `@typescript-eslint/no-misused-promises` |
| Empty catch blocks | `no-empty-catch` | `no-empty` (weaker) | ❌ None |
| Hardcoded secrets/API keys | `no-hardcoded-secret` | ❌ None | ❌ None |
| SQL string concatenation | `no-sql-string-concat` | ❌ None | ❌ None |
| Missing auth middleware on routes | `require-auth-middleware` | ❌ None | ❌ None |
| Missing authz checks on routes | `require-authz-check` | ❌ None | ❌ None |
| `eval()` with dynamic input | `no-eval-dynamic` | `no-eval` (blanket ban) | ❌ None |
| `JSON.parse(req.body)` without validation | `no-unsafe-deserialize` | ❌ None | ❌ None |
| Async without await | `no-async-without-await` | ❌ None | `@typescript-eslint/require-await` |
| Await in loops | `no-await-in-loop` | `no-await-in-loop` (no autofix) | ❌ None |
| Dead branches (`if (true)`) | `no-dead-branch` | ❌ None | ❌ None |
| Catch-log-rethrow pattern | `no-catch-log-rethrow` | ❌ None | ❌ None |
| Duplicate logic blocks | `no-duplicate-logic-block` | ❌ None | ❌ None |
| Console in route handlers | `no-console-in-handler` | `no-console` (blanket ban) | ❌ None |

### Key Differentiators

1. **No type information required.** ai-guard works with plain JavaScript and TypeScript
   without needing `parserOptions.project`. This is a major DX advantage — type-aware
   rules in `@typescript-eslint` require a `tsconfig.json` reference, which slows down
   linting significantly and adds configuration complexity.

2. **AI-specific heuristics.** ai-guard rules are tuned for patterns that AI coding tools
   specifically generate. For example, `no-floating-promise` uses call-site naming heuristics
   (functions named `send*`, `save*`, `update*`, `delete*` are more likely to be async)
   rather than requiring full type information.

3. **Autofix support.** Several ai-guard rules provide automatic fixes:
   - `no-hardcoded-secret` → `process.env.*`
   - `no-empty-catch` → inserts TODO comment
   - `no-floating-promise` → adds `void`
   - `no-async-without-await` → adds `await` wrapper

4. **SARIF-native.** ai-guard generates SARIF 2.1.0 that integrates directly with GitHub
   Code Scanning. ESLint core has no built-in SARIF output.

---

## What ai-guard does NOT replace

| Tool | What it does | ai-guard overlap |
|---|---|---|
| ESLint core rules | Syntax, style, best practices | Minimal — ai-guard focuses on AI-specific patterns |
| @typescript-eslint | Type-aware linting | `no-floating-promises` and `require-await` overlap; ai-guard is simpler to set up |
| CodeQL | Deep semantic security analysis | None — CodeQL operates at a different level |
| Semgrep | Pattern-based security scanning | Minimal — ai-guard's security rules are narrower and AI-focused |
| Prettier | Code formatting | None |

ai-guard is designed to **complement** these tools, not replace them.

---

## Runtime Performance

Benchmark: scanning 196 TypeScript/JavaScript files (algorithm-automata-simulator).

| Tool | Time | Notes |
|---|---|---|
| `ai-guard run --strict` | ~1.8s | 18 rules, no type info needed |
| `eslint .` (recommended) | ~2.5s | Depends on config complexity |
| `eslint .` (with @typescript-eslint type-aware) | ~8–12s | Requires tsconfig.json, full type checking |

ai-guard is consistently faster than type-aware linting because it uses AST heuristics
instead of TypeScript's type checker.

---

## False Positive Rates

Audited across 4 real-world repositories (378 files total, strict preset):

| Category | Findings | True Positives | FP Rate |
|---|---|---|---|
| Security | 15 | 15 | 0% |
| Reliability (error handling) | 53 | 53 | 0% |
| Async stability | 43 | ~40 | ~7% |
| AI patterns (console, duplicate) | 58 | 43 | 26%* |

*Console-in-handler is the noisiest rule. As of v1.2.8+, `console.warn` and `console.error`
are allowed by default, and structured loggers (winston, pino, bunyan) are automatically
whitelisted. This reduces the AI patterns FP rate significantly.

---

## Methodology

- All benchmarks run on the same machine (Windows 11, Node.js 20, 16GB RAM)
- Each scan repeated 3 times, median taken
- "True positive" means the finding identifies a real issue or a pattern that should
  be addressed (even if the developer might intentionally keep it)
- "False positive" means the finding fires on valid, idiomatic code
- All comparisons use the latest stable versions of each tool
- No exaggeration — if another tool does something better, we say so
