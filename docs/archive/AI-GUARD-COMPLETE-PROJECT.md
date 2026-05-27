# ESLint Plugin AI Guard – Complete Project Overview

## Overview

**eslint-plugin-ai-guard** is an advanced ESLint plugin designed to catch code patterns that AI tools (like Copilot, Claude, Cursor) frequently get wrong. It focuses on security, async correctness, error handling, and code quality, providing actionable feedback for both human and AI-generated code.

- **Zero-config CLI**: `npx ai-guard run` (recommended, strict, security presets)
- **AI Agent Context**: `npx ai-guard init-context` auto-generates instruction files for Copilot, Claude, and Cursor to prevent anti-patterns before code is written.
- **Production-ready**: Designed for real-world adoption with low-noise defaults and full strict/security modes.

---

## Installation

```bash
npm install --save-dev eslint-plugin-ai-guard
```

---

## CLI Usage

- `npx ai-guard run` – Lint with recommended rules (low noise)
- `npx ai-guard run --strict` – All rules at error level
- `npx ai-guard run --security` – Security-focused rules only
- `npx ai-guard init` – Auto-create ESLint config
- `npx ai-guard init-context` – Generate agent instruction files (see below)
- `npx ai-guard doctor` – Diagnose setup issues
- `npx ai-guard baseline` – Track only new issues

---

## AI Agent Context Generation (`init-context`)

`ai-guard init-context` creates instruction files for:
- **Claude** (`CLAUDE.md`)
- **Cursor** (`.cursorrules`)
- **GitHub Copilot** (`.github/copilot-instructions.md`)

These files teach your AI tools to avoid the 17+ most common anti-patterns before code is even written. Use `--all` to generate for all agents, and `--force` to regenerate after upgrades.

---

## Rule Presets

### Recommended (default)
- High-confidence, high-impact rules at error
- Context-sensitive rules at warn/off
- Designed for easy adoption

### Strict
- All rules at error
- Maximum coverage for mature teams

### Security
- Only security rules, all at error or warn

---

## All Available Rules

### Error Handling
- **no-empty-catch**: Disallow empty catch blocks
- **no-broad-exception**: Disallow overly broad catch types (e.g., `any`)
- **no-catch-log-rethrow**: Disallow catch blocks that only log and rethrow
- **no-catch-without-use**: Disallow unused catch parameters

### Async Correctness
- **no-async-array-callback**: Disallow async callbacks in array methods
- **no-floating-promise**: Disallow unhandled Promises
- **no-await-in-loop**: Disallow `await` in loops when parallelism is possible
- **no-async-without-await**: Disallow async functions with no await
- **no-redundant-await**: Disallow `return await` outside try/catch

### Security
- **no-hardcoded-secret**: Disallow hardcoded secrets, API keys, tokens
- **no-eval-dynamic**: Disallow `eval()`/`new Function()` with dynamic input
- **no-sql-string-concat**: Disallow SQL queries built via string concat/interpolation
- **no-unsafe-deserialize**: Disallow `JSON.parse` on untrusted input
- **require-auth-middleware**: Require auth middleware on routes
- **require-authz-check**: Require authorization checks on sensitive routes

### Quality
- **no-console-in-handler**: Disallow `console.*` in handlers
- **no-duplicate-logic-block**: Disallow duplicate logic blocks

---

## Rule Configurations

### `recommended`
- Only high-confidence rules at error, context-sensitive at warn/off
- Example:
```js
{
  'ai-guard/no-empty-catch': 'error',
  'ai-guard/no-floating-promise': 'error',
  'ai-guard/no-hardcoded-secret': 'error',
  'ai-guard/no-eval-dynamic': 'error',
  'ai-guard/no-broad-exception': 'warn',
  'ai-guard/require-auth-middleware': 'warn',
  'ai-guard/no-await-in-loop': 'warn',
  'ai-guard/no-async-without-await': 'warn',
  'ai-guard/no-sql-string-concat': 'warn',
  'ai-guard/no-async-array-callback': 'warn',
  // ...others at warn/off
}
```

### `strict`
- All rules at error

### `security`
- Only security rules, all at error or warn

---

## How Each Rule Works (Summary)

- **no-empty-catch**: Flags empty catch blocks; suggests adding error handling or a comment.
- **no-broad-exception**: Flags `catch (e: any)` or `catch (e: unknown)` without narrowing.
- **no-catch-log-rethrow**: Flags catch blocks that only log and rethrow the same error.
- **no-catch-without-use**: Flags unused catch parameters.
- **no-async-array-callback**: Flags async callbacks in array methods (e.g., `map(async x => ...)`).
- **no-floating-promise**: Flags Promises not awaited or handled.
- **no-await-in-loop**: Flags `await` in loops when parallelism is possible.
- **no-async-without-await**: Flags async functions that never use await.
- **no-redundant-await**: Flags `return await` outside try/catch/finally.
- **no-hardcoded-secret**: Flags hardcoded secrets, API keys, tokens.
- **no-eval-dynamic**: Flags `eval()`/`new Function()` with non-literal input.
- **no-sql-string-concat**: Flags SQL queries built via string concat/interpolation.
- **no-unsafe-deserialize**: Flags `JSON.parse` on untrusted input.
- **require-auth-middleware**: Flags routes missing authentication middleware.
- **require-authz-check**: Flags routes missing authorization checks.
- **no-console-in-handler**: Flags `console.*` in handler code.
- **no-duplicate-logic-block**: Flags consecutive duplicate logic blocks.

---

## Project Structure

- `src/rules/` – All rule implementations
- `src/configs/` – Preset configs (recommended, strict, security)
- `cli/` – CLI commands and utilities
- `tests/` – Rule and CLI tests
- `README.md` – Main documentation

---

## Contributing

See `CONTRIBUTING.md` for guidelines. PRs and issues welcome!

---

## License

MIT

---

## Links

- [GitHub](https://github.com/YashJadhav21/eslint-plugin-ai-guard)
- [NPM](https://www.npmjs.com/package/eslint-plugin-ai-guard)
- [Rule Docs](https://github.com/YashJadhav21/eslint-plugin-ai-guard/tree/main/docs/rules)
