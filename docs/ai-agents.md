# AI Agent Integration Guide

> How **Claude Code**, **Cursor**, **GitHub Copilot**, and other AI coding assistants
> integrate with ai-guard to prevent reliability and security issues at generation time.

---

## Why AI Agents Need Guardrails

AI coding assistants generate code that looks correct but has consistent blind spots:

- **Async misuse**: Floating promises, sequential await in loops, async array callbacks
- **Silent error swallowing**: Empty catch blocks, catch-without-use
- **Security gaps**: Hardcoded secrets, SQL injection via string concatenation, missing auth middleware
- **Dead scaffolding**: `if (true)`, `if (false)`, duplicate logic blocks left from generation

These patterns are **not random bugs** — they are systematic outputs of how LLMs predict code.
ai-guard is purpose-built to catch them at the point where they matter: in your CI pipeline,
before they reach production.

---

## Agent Context Generation

Generate instruction files that teach your AI tools to avoid these patterns **before writing code**:

```bash
npx ai-guard init-context
```

This creates:

| File | Read by |
|------|---------|
| `CLAUDE.md` | Claude Code (loaded automatically from project root) |
| `.cursorrules` | Cursor (loaded automatically from project root) |
| `.github/copilot-instructions.md` | GitHub Copilot (loaded automatically) |

```bash
# Generate for a specific agent
npx ai-guard init-context --agent claude
npx ai-guard init-context --agent cursor
npx ai-guard init-context --agent copilot

# Generate for all agents
npx ai-guard init-context --all

# Regenerate after upgrading ai-guard
npx ai-guard init-context --force
```

---

## Claude Code

Claude Code automatically reads `CLAUDE.md` from the project root at the start of every session.

ai-guard's `CLAUDE.md` teaches Claude to:
- Never generate empty catch blocks
- Always await async calls or explicitly mark them `void`
- Use `Promise.all` instead of sequential await in loops
- Replace hardcoded secrets with `process.env.*`
- Add authentication middleware before route handlers
- Never build SQL with string concatenation

It also documents:
- The repository architecture (rule structure, CLI commands, test conventions)
- SARIF integration details (so Claude doesn't accidentally break the persistence logic)
- Suppression conventions (`// ai-guard-disable rule-name -- reason`)

---

## Cursor

Cursor reads `.cursorrules` from the project root. ai-guard generates a rule file that
encodes the same async reliability and security guardrails in Cursor's expected format.

The generated file is optimized to:
- Prevent the most common AI-generated async misuse patterns
- Enforce security best practices specific to LLM code generation
- Work alongside your existing `.cursorrules` if you have custom conventions

---

## GitHub Copilot

GitHub Copilot reads `.github/copilot-instructions.md` automatically in repositories where
it is enabled. ai-guard generates a Copilot instructions file that:

- Describes the project's coding standards
- Lists patterns to avoid (with examples)
- Documents the async reliability philosophy

---

## GitHub Actions Integration

For full CI/CD integration, see [`docs/github-actions.md`](./github-actions.md).

The short version for AI agent developers:

```yaml
# .github/workflows/ai-guard.yml
name: AI Guard

on: [pull_request]

permissions:
  security-events: write
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: npm ci
      - run: |
          npx ai-guard changed \
            --pr --strict \
            --sarif --sarif-output results.sarif \
            --fail-on high
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
          category: ai-guard
```

---

## SARIF and Code Scanning

ai-guard generates SARIF 2.1.0 that integrates with GitHub Advanced Security:

- **PR annotations** — inline at the exact line of each finding
- **GitHub Code Scanning** — persistent alerts in `Security → Code scanning`
- **GitHub Advanced Security** — summary in PR checks

The SARIF output includes:
- `automationDetails.id: "ai-guard"` — stable tool identifier for persistence
- `partialFingerprints["ai-guard/v1"]` — deterministic SHA-256 per finding
- `security-severity` — mapped from confidence tier to GitHub's severity scale
- `precision` — `high`, `medium`, or `low` based on rule confidence

---

## Async Reliability Philosophy

ai-guard's core focus is **async reliability** — the category where AI-generated code is
most systematically wrong:

### The Problem

LLMs predict code token-by-token without executing it. This means they:
- Add `async` to functions without thinking about whether `await` is needed
- Call async functions and forget to await them (floating promises)
- Use `array.map(async ...)` assuming it works like `await Promise.all()`
- Write sequential await loops without considering parallel execution

### The Fix

ai-guard detects these patterns at lint time, blocks them in CI, and teaches AI agents
to avoid them at generation time via the `init-context` instruction files.

The five core async reliability rules:
1. `no-floating-promise` — floating promises silently swallow errors
2. `no-async-array-callback` — async callbacks in `.map()` return `Promise[]`
3. `no-await-in-loop` — sequential await in loops has O(n) latency
4. `no-async-without-await` — `async` without `await` is misleading
5. `no-redundant-await` — `return await` outside try/catch adds unnecessary overhead

---

## Integration Checklist

For a production AI-assisted development workflow:

- [ ] Install: `npm install --save-dev eslint-plugin-ai-guard`
- [ ] Generate agent context: `npx ai-guard init-context --all`
- [ ] Add GitHub Actions workflow (see above)
- [ ] Configure GitHub Advanced Security (requires `security-events: write` permission)
- [ ] Set `category: ai-guard` on the `upload-sarif` step
- [ ] Verify findings appear in `Security → Code scanning` after first workflow run

---

## Supported Environments

| Environment | Integration | Status |
|-------------|-------------|--------|
| Claude Code | `CLAUDE.md` | ✅ Supported |
| Cursor | `.cursorrules` | ✅ Supported |
| GitHub Copilot | `copilot-instructions.md` | ✅ Supported |
| GitHub Actions | Workflow + SARIF | ✅ Supported |
| GitHub Code Scanning | SARIF upload | ✅ Supported |
| GitHub Advanced Security | PR annotations + alerts | ✅ Supported |
| GitLab CI | JSON output | ✅ Supported |
| Pre-commit hooks | `ai-guard changed --staged` | ✅ Supported |
| VS Code | ESLint extension | ✅ Via ESLint plugin |
