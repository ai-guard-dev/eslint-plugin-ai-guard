<p align="center">
  <img src="./assets/logo.png" alt="AI Guard Logo" width="80" />
  <h1 align="center">eslint-plugin-ai-guard</h1>
  <p align="center">
    <strong>🛡️ The ESLint plugin built for the age of AI-generated code.</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/eslint-plugin-ai-guard"><img src="https://img.shields.io/npm/v/eslint-plugin-ai-guard.svg?style=flat-square&color=7c3aed" alt="npm version"></a>
    <a href="https://github.com/YashJadhav21/eslint-plugin-ai-guard/actions"><img src="https://img.shields.io/github/actions/workflow/status/YashJadhav21/eslint-plugin-ai-guard/ci.yml?style=flat-square&label=CI&color=10b981" alt="CI"></a>
    <a href="https://www.npmjs.com/package/eslint-plugin-ai-guard"><img src="https://img.shields.io/npm/dm/eslint-plugin-ai-guard.svg?style=flat-square&color=3b82f6" alt="downloads"></a>
    <a href="https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/eslint-plugin-ai-guard.svg?style=flat-square&color=64748b" alt="license"></a>
  </p>
</p>

---

## The Problem

AI coding assistants generate code that **looks correct but isn't.** Research shows AI-generated code has **1.7× more bugs** and **2.74× more security vulnerabilities** than human-written code.

The patterns they get wrong are consistent and predictable:

| Pattern | Why AI Gets It Wrong |
|---------|---------------------|
| `try {} catch (e) {}` | AI adds catch blocks without thinking about error handling |
| `array.map(async ...)` | AI generates async callbacks that return `Promise[]`, not values |
| `fetch(url)` (no await) | AI forgets to await or handle promise rejection |
| `const apiKey = 'sk-...'` | AI uses placeholder credentials that get committed |
| `eval(userInput)` | AI generates dynamic evaluation without security awareness |
| `if (true) { ... }` | AI leaves dead scaffolding branches in generated code |

**Existing linters don't catch these** because they're designed for human coding patterns.

`ai-guard` is purpose-built to catch what AI tools consistently get wrong.

---

## Install

```bash
npm install --save-dev eslint-plugin-ai-guard
```

Requires: **Node.js ≥ 18**, **ESLint ≥ 8**

---

## Quick Start — Zero Config Required

```bash
# Scan your project immediately (no ESLint config needed)
npx ai-guard run

# Security-focused scan
npx ai-guard run --security

# Strict mode — all rules at error
npx ai-guard run --strict

# Scan a specific directory
npx ai-guard run --path src/api
```

**That's it.** No configuration, no setup.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `ai-guard run` | Scan your project with the recommended preset |
| `ai-guard run --strict` | All rules at error — for CI enforcement |
| `ai-guard run --security` | Security rules only |
| `ai-guard run --json` | Output results as JSON (CI-friendly) |
| `ai-guard run --max-warnings 0` | Fail CI on any warning |
| `ai-guard init` | Auto-configure ESLint for your project |
| `ai-guard init-context` | Generate AI agent rules (CLAUDE.md, .cursorrules, etc.) |
| `ai-guard doctor` | Diagnose your ESLint setup |
| `ai-guard baseline` | Save current issues, track only new ones |
| `ai-guard report` | Generate a shareable HTML report |
| `ai-guard ignore` | Add patterns to suppress noise |

### Terminal Output

```
  AI GUARD

  Files scanned:  142  ·  Issues in:  7 files  ·  Duration:  312ms  ·  Preset:  recommended

  ── Summary by Category ──

  🔴  Security            3 errors
  🟠  Reliability         2 errors
  🟡  Async Stability     2 warnings

  Total: 5 errors · 2 warnings

  ── By Rule ──
    • no-hardcoded-secret: 3
    • no-empty-catch: 2
    • no-floating-promise: 2

  ── Next Steps ──
  ℹ  Run ai-guard baseline to save these issues and track only new ones
  ℹ  Run ai-guard report   to generate a shareable HTML report
```

---

## Rules

### 🔴 Security

| Rule | Default | What it catches |
|------|---------|-----------------|
| `no-hardcoded-secret` | **error** | API keys, passwords, tokens in source code. Autofix: replaces with `process.env.*` |
| `no-eval-dynamic` | **error** | `eval()` / `new Function()` with non-literal arguments |
| `no-sql-string-concat` | warn | SQL queries built by string concatenation or interpolation |
| `no-unsafe-deserialize` | warn | `JSON.parse(req.body)` without validation |
| `require-auth-middleware` | warn | Express/Fastify routes without authentication middleware |
| `require-authz-check` | warn | Resource access without ownership checks |

### 🟠 Reliability

| Rule | Default | What it catches |
|------|---------|-----------------|
| `no-empty-catch` | **error** | `catch (e) {}` — errors vanish silently. Autofix: inserts `/* TODO: handle error */` |
| `no-broad-exception` | warn | `catch (e: any)` that hides the real error type |
| `no-catch-log-rethrow` | off* | Catch blocks that only `console.log` + rethrow |
| `no-catch-without-use` | off* | Catching an error and never using it |

*Enabled at `error` in `strict` preset.

### 🟡 Async Stability

| Rule | Default | What it catches |
|------|---------|-----------------|
| `no-floating-promise` | **error** | Async calls with no `await`, return, or `.catch()`. Autofix: adds `void` |
| `no-async-array-callback` | warn | `array.map(async ...)` returning `Promise[]` instead of values |
| `no-await-in-loop` | warn | Sequential `await` in loops (use `Promise.all`). Autofix available for simple cases |
| `no-async-without-await` | warn | `async` function that never uses `await` |
| `no-redundant-await` | off* | `return await` outside try/catch |

*Enabled at `error` in `strict` preset.

### 🔵 AI Patterns

| Rule | Default | What it catches |
|------|---------|-----------------|
| `no-dead-branch` | warn | `if (true)`, `if (false)`, `x && !x`, `x === x` — scaffolding leftovers |
| `no-duplicate-logic-block` | off* | Consecutive duplicate code that should be extracted |
| `no-console-in-handler` | off* | `console.log` in route handlers (use a proper logger) |

*Enabled at `error` in `strict` preset.

---

## Presets

| Preset | Purpose | Recommended For |
|--------|---------|-----------------|
| `recommended` | Low-noise, adoption-first — critical issues at `error`, context-sensitive at `warn` | All teams on day one |
| `strict` | All 18 rules at `error` | CI enforcement in mature codebases |
| `security` | Security rules only | Security-focused scanning |

### ESLint Config (Flat Config)

```javascript
// eslint.config.mjs
import aiGuard from 'eslint-plugin-ai-guard';

export default [
  {
    plugins: { 'ai-guard': aiGuard },
    rules: { ...aiGuard.configs.recommended.rules },
  },
];
```

```javascript
// Strict preset
export default [
  {
    plugins: { 'ai-guard': aiGuard },
    rules: { ...aiGuard.configs.strict.rules },
  },
];
```

---

## CI Integration

### GitHub Actions

```yaml
# .github/workflows/ai-guard.yml
name: AI Guard

on: [pull_request]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npx ai-guard run --max-warnings 0
```

See [`examples/ci/`](./examples/ci/) for more templates (GitLab CI, baseline mode, JSON output).

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | No issues (or only warnings below `--max-warnings` threshold) |
| `1` | Errors found, or warnings exceed `--max-warnings` |

---

## AI Agent Rules

Generate instruction files so **Claude Code, Cursor, and GitHub Copilot** automatically avoid the 18 most common AI-generated anti-patterns:

```bash
npx ai-guard init-context
```

This writes:
- `CLAUDE.md` — read automatically by Claude Code
- `.cursorrules` — read automatically by Cursor
- `.github/copilot-instructions.md` — read automatically by GitHub Copilot

Your AI tools will now avoid these patterns **before** you even run the linter.

---

## Real-World Example

```typescript
// ❌ Common AI-generated code — 4 issues in one function
async function processUserOrders(userId: string) {
  const apiKey = 'sk-prod-1234567890abcdef';  // no-hardcoded-secret
  
  const orders = await db.query('SELECT * FROM orders WHERE id = ' + userId);  // no-sql-string-concat
  
  for (const order of orders) {
    await sendEmail(order.email);  // no-await-in-loop
  }
  
  updateAnalytics(userId);  // no-floating-promise
}

// ✅ After ai-guard fixes
async function processUserOrders(userId: string) {
  const apiKey = process.env.API_KEY;

  const orders = await db.query('SELECT * FROM orders WHERE id = $1', [userId]);

  await Promise.all(orders.map(async (order) => sendEmail(order.email)));

  void updateAnalytics(userId);
}
```

---

## Autofix Support

Run autofixes via ESLint:

```bash
npx eslint src --fix
```

Rules with autofix:

| Rule | Fix |
|------|-----|
| `no-hardcoded-secret` | Replaces literal with `process.env.VAR_NAME` |
| `no-empty-catch` | Inserts `/* TODO: handle error */` |
| `no-floating-promise` | Marks with `void` |
| `no-await-in-loop` | Rewrites simple loops to `Promise.all(...)` |
| `no-async-without-await` | Removes unnecessary `async` keyword |

---

## Philosophy

- **Precision over recall** — we'd rather miss a bug than create noise
- **Low false positives** — if a warning fires too often on valid code, we disable it in `recommended`
- **Gradual adoption** — `recommended` is the safe default; `strict` is opt-in
- **Self-validating** — `ai-guard` scans its own source code in CI

---

## Development

```bash
git clone https://github.com/YashJadhav21/eslint-plugin-ai-guard.git
cd eslint-plugin-ai-guard
npm install
npm run test         # Run all 436+ tests
npm run build        # Build CJS + ESM bundles
npm run typecheck    # TypeScript check
npm run lint:self    # Scan own source with ai-guard
```

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Rule requests:** Open an issue — describe the AI anti-pattern and why it's common.

**False positive reports:** We take these seriously. Open an issue with a minimal code example.

See the [Roadmap](ROADMAP.md) for planned features.

---

## License

[MIT](LICENSE) — free forever. No rules behind a paywall.

---

<p align="center">
  Built to make AI-assisted development safer and more trustworthy. ⚡
</p>
