# Roadmap

This document outlines the planned evolution of `eslint-plugin-ai-guard`.

---

## ✅ Done (v1.0–v1.1)

- **18 production rules** across 4 categories: Security, Reliability, Async Stability, AI Patterns
- **Zero-config CLI** (`npx ai-guard run`) — no ESLint setup required
- **3 presets**: `recommended`, `strict`, `security`
- **HTML report** (`ai-guard report`) with score, category breakdown, and top-rule charts
- **Baseline mode** (`ai-guard baseline`) for tracking only new regressions
- **AI agent context files** (`ai-guard init-context`) for Claude Code, Cursor, Copilot
- **Autofixes** for `no-hardcoded-secret`, `no-empty-catch`, `no-floating-promise`, `no-await-in-loop`, `no-async-without-await`
- **Intent-aware heuristics** — `no-await-in-loop` respects retry/fallback/sequential patterns
- **Self-scan CI** — the plugin scans its own source code in every CI run
- **Shared test helper** — all 436+ tests use `tests/helpers/rule-tester.ts`

---

## 🚧 In Progress / Near Term

### v1.2 — False Positive Hardening

> **Goal:** Reduce false positives across all rules by auditing real-world codebases.

- [ ] Community false-positive report review (open issues)
- [ ] `no-hardcoded-secret` — improve entropy scoring to reduce test-value false positives
- [ ] `no-await-in-loop` — improve database migration pattern recognition
- [ ] `require-auth-middleware` — support Fastify `preHandler` and `onRequest` hooks
- [ ] Per-rule `options` schemas for all configurable rules
- [ ] Validate against 3 popular open-source Express/Fastify projects

### v1.3 — New Rules

Carefully selected, high-precision candidates:

| Rule | Category | Rationale |
|------|----------|-----------|
| `no-typeof-in-condition` | AI Patterns | AI often generates `typeof x === 'undefined'` instead of `x == null` |
| `no-mutation-in-derived-state` | Reliability | AI generates React state mutations inside derived renders |
| `no-promise-in-useEffect-without-cleanup` | Reliability | AI-generated React async effects without cleanup functions |
| `require-input-validation` | Security | Express/Fastify routes accepting `req.body` without validation |
| `no-unguarded-process-exit` | Reliability | `process.exit()` without proper error handling or cleanup |

---

## 🔮 Future (v2.x)

### Smarter Analysis

- **Type-aware mode** — opt-in TypeScript type checker integration for higher precision on `no-floating-promise` and `no-await-in-loop`
- **Cross-file analysis** — detect auth/validation gaps across route + handler boundaries
- **Call-graph aware** — understand when a function called inside a route already contains auth logic

### New Output Targets

- **SARIF output** (`--sarif`) — for GitHub Code Scanning integration
- **VS Code extension** — inline warnings without running CLI
- **PR comment bot** — GitHub App that comments AI Guard results directly on PRs

### Ecosystem

- **`ai-guard-config-next`** — Next.js-specific preset (server actions, API routes, middleware)
- **`ai-guard-config-react`** — React-specific preset (hooks, effects, state patterns)
- **`ai-guard-config-node`** — Node.js backend preset (Express, Fastify, Hono)

---

## Non-Goals

- **We will NOT become a general-purpose security scanner.** There are better tools for that (Snyk, Semgrep, CodeQL).
- **We will NOT add rules just to increase count.** Every rule requires real-world evidence of AI generating it.
- **We will NOT compromise `recommended` preset quality** by enabling noisy rules.

---

## Contributing a New Rule

Before opening a PR with a new rule:

1. Document the AI-generated anti-pattern with a real example (paste from Copilot/Claude/Cursor)
2. Estimate the false-positive rate — rules with >10% FP rate don't belong in `recommended`
3. Write tests: minimum 8 valid + 8 invalid cases covering edge cases
4. Check if an existing rule from `@typescript-eslint/eslint-plugin` or `eslint-plugin-promise` already covers it

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full process.
