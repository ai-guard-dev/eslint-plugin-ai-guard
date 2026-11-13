# Roadmap

This document outlines the planned evolution of `eslint-plugin-ai-guard`.

---

## ✅ Done (v1.0–v1.4)

- **18 production rules** across 4 categories: Security, Reliability, Async Stability, AI Patterns
- **Zero-config CLI** (`npx ai-guard run`) — no ESLint setup required
- **3 presets**: `recommended`, `strict`, `security`
- **HTML report** (`ai-guard report`) with score, category breakdown, and top-rule charts
- **Baseline mode** (`ai-guard baseline`) for tracking only new regressions
- **AI agent context files** (`ai-guard init-context`) for Claude Code, Cursor, Copilot
- **Autofixes** for `no-hardcoded-secret`, `no-await-in-loop`, `no-async-without-await` (`no-empty-catch` and `no-floating-promise` deliberately offer editor suggestions only, so `--fix` cannot hide them)
- **Intent-aware heuristics** — `no-await-in-loop` respects retry/fallback/sequential patterns
- **Self-scan CI** — the plugin scans its own source code in every CI run
- **Shared test helper** — rule tests use `tests/helpers/rule-tester.ts`
- **SARIF 2.1.0 output** (`--sarif`) for GitHub Code Scanning, GitHub Action, MCP server (v1.2–v1.4)
- **Baseline-aware PR scans** — `ai-guard changed --baseline` and the Action `baseline` input report only findings not in the committed baseline (1.4.3)
- **Check integrity** — `ai-guard integrity`, `changed --integrity`, the Action `integrity` input, the Claude Code Stop hook and the MCP `ai_guard_check_integrity` tool detect changes that weaken checks (suppressions, skipped/removed tests, config downgrades, removed CI steps) (1.4.3)
- **Claude Code hook protocol** — findings reach Claude via documented JSON output; inline directives never hide AI Guard findings silently (1.4.3)
- **Agent safety** — `ai-guard verify`, `scan-agent-config`, test-integrity checks and nine new rules (27 total), the `agent` preset (1.4.4)
- **Supply chain** — `ai-guard verify-deps`, the opt-in pre-install hook and the `ai_guard_check_package` MCP tool: invented names, typosquats, npm security placeholders, install scripts (1.4.5)
- **Every agent, every commit** — hooks for Cursor and Codex (`init-hooks`), the pre-commit gate (`init-git-hook`), Oxlint support with CI parity, the official MCP Registry listing (1.4.5)
- **Fresh-release check** — versions published in the last day, aware of npm/pnpm/Yarn/Bun release cooldowns (1.4.6)

---

## 🚧 In Progress / Near Term

### False positive hardening (ongoing)

> **Goal:** Reduce false positives across all rules by auditing real-world codebases.

- [ ] Community false-positive report review (open issues)
- [ ] `no-hardcoded-secret` — improve entropy scoring to reduce test-value false positives
- [ ] `no-await-in-loop` — improve database migration pattern recognition
- [x] `require-auth-middleware` — support Fastify `preHandler` and `onRequest` hooks (route options and `addHook`), segment-exact public routes, prefix-scoped `router.use` (1.4.3)
- [ ] Per-rule `options` schemas for all configurable rules
- [ ] Validate against 3 popular open-source Express/Fastify projects

### Rule candidates

Carefully selected, high-precision candidates:

| Rule | Category | Rationale |
|------|----------|-----------|
| `no-typeof-in-condition` | AI Patterns | AI often generates `typeof x === 'undefined'` instead of `x == null` |
| `no-mutation-in-derived-state` | Reliability | AI generates React state mutations inside derived renders |
| `no-promise-in-useEffect-without-cleanup` | Reliability | AI-generated React async effects without cleanup functions |
| `require-input-validation` | Security | Express/Fastify routes accepting `req.body` without validation |
| `no-unguarded-process-exit` | Reliability | `process.exit()` without proper error handling or cleanup |

---

### Check integrity — next steps

- [ ] GitLab CI, CircleCI and Azure Pipelines workflow analysis (GitHub Actions only today)
- [ ] Follow reusable workflows and composite actions
- [ ] Recognize custom test wrappers (`test.extend`, re-exported `it`)
- [ ] Biome / oxlint suppression comments and configuration
- [ ] Validate precision on public agent-authored PRs before enabling enforcement by default anywhere

## 🔮 Future (v2.x)

### Smarter Analysis

- **Type-aware mode** — opt-in TypeScript type checker integration for higher precision on `no-floating-promise` and `no-await-in-loop`
- **Cross-file analysis** — detect auth/validation gaps across route + handler boundaries (e.g. a router mounted behind auth in another file: `app.use('/admin', requireAuth, adminRouter)`)
- **Fastify encapsulation** — scope `addHook` auth to the plugin function it is registered in; check `fastify.route({ ... })` declarations
- **Call-graph aware** — understand when a function called inside a route already contains auth logic

### New Output Targets

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
