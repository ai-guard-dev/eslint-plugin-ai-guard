# Architecture Guide

> How ai-guard is built — the CLI flow, ESLint integration, SARIF generation, GitHub Actions
> integration, and PR validation pipeline.

This document is intended for contributors and AI agents working on the codebase.

---

## Repository Structure

```
eslint-plugin-ai-guard/
├── src/
│   ├── rules/
│   │   ├── async/           Async reliability rules (no-floating-promise, etc.)
│   │   ├── reliability/     Error handling rules (no-empty-catch, etc.)
│   │   ├── security/        Security rules (no-hardcoded-secret, etc.)
│   │   └── ai-patterns/     AI-specific patterns (no-dead-branch, etc.)
│   ├── configs/
│   │   ├── recommended.ts   Low-noise default preset
│   │   ├── strict.ts        All rules at error
│   │   └── security.ts      Security rules only
│   └── index.ts             ESLint plugin export
│
├── cli/
│   ├── commands/
│   │   ├── run.ts           Full project scan command
│   │   ├── changed.ts       PR-aware changed-file scan command
│   │   ├── init.ts          ESLint config auto-generator
│   │   ├── init-context.ts  AI agent instruction file generator
│   │   ├── baseline.ts      Baseline save/compare
│   │   ├── report.ts        HTML report generator
│   │   ├── doctor.ts        Setup diagnostics
│   │   └── ignore.ts        Ignore pattern manager
│   └── utils/
│       ├── eslint-runner.ts   Core ESLint execution and result normalization
│       ├── sarif.ts           SARIF 2.1.0 generation and GitHub persistence
│       ├── github-env.ts      GitHub Actions environment detection
│       ├── github-summary.ts  PR step summary writer
│       ├── git-diff.ts        Changed-file detection via git diff
│       ├── logger.ts          CLI output formatting
│       ├── fail-on.ts         Exit code resolution
│       └── version.ts         Package version constant
│
├── tests/
│   ├── rules/               Rule-level unit tests (valid/invalid cases)
│   ├── cli/                 CLI command integration tests
│   ├── ci/                  SARIF schema, persistence, GitHub environment tests
│   └── integration/         End-to-end tests (Express app, Next.js, etc.)
│
└── docs/
    ├── rules/               Per-rule documentation
    ├── github-actions.md    GitHub Actions integration guide
    ├── ai-agents.md         AI agent integration guide
    └── architecture.md      This file
```

---

## CLI Flow

### `ai-guard run`

```
1. Parse CLI options (commander)
2. Determine preset (recommended | strict | security)
3. Resolve target path
4. Run ESLint via eslint-runner.ts
   ├── Load flat config with ai-guard rules
   ├── Glob for TypeScript/JavaScript files
   ├── Execute ESLint with preset rules
   └── Normalize results (separate ai-guard issues from ecosystem issues)
5. Apply fail-on strategy → resolve exit code
6. If --sarif: generate SARIF via sarif.ts → write to file or stdout
7. If --json: serialize RunResult as JSON
8. If terminal: format and print human-readable output via logger.ts
```

### `ai-guard changed`

```
1. Parse CLI options
2. Detect GitHub Actions environment (GITHUB_ACTIONS, GITHUB_WORKSPACE, etc.)
3. Get changed files:
   ├── --pr mode: git diff HEAD..origin/<GITHUB_BASE_REF> --name-only
   ├── --staged mode: git diff --cached --name-only
   └── --base <ref>: git diff HEAD..<ref> --name-only
4. Filter to TypeScript/JavaScript files
5. If no changed files: exit 0 (nothing to scan)
6. Run ESLint on changed files only (files array mode)
7. If in CI: write GitHub step summary and outputs
8. If --sarif: generate SARIF and write to SARIF_RESULTS_PATH or --sarif-output
9. Apply fail-on strategy → resolve exit code
```

---

## ESLint Integration

The ESLint runner (`cli/utils/eslint-runner.ts`) operates independently of any user ESLint config:

- Creates an in-memory ESLint instance with flat config
- Loads only ai-guard rules — no user plugin interference
- Separates ai-guard findings from ecosystem issues (missing rules, foreign plugins)
- Ecosystem issues are displayed separately and never count toward the score
- Parser errors are collected but don't block the scan

**Key design decision:** ai-guard never fails because of a missing user plugin. If `react-hooks`
is not installed, its rules are silently ignored. ai-guard's own rules always run.

---

## SARIF Generation

`cli/utils/sarif.ts` generates SARIF 2.1.0. Key design requirements:

### Path Resolution

GitHub Code Scanning expects repository-relative POSIX paths:
- ✅ `src/handler.ts`
- ❌ `/home/runner/work/repo/src/handler.ts` (absolute runner path)
- ❌ `C:\Users\dev\project\src\handler.ts` (Windows absolute path)
- ❌ `./src/handler.ts` (leading `./ `)

`normalizeSarifPath(filePath, repoRoot?)` handles all conversions. When `GITHUB_WORKSPACE` is
set (always true in GitHub Actions), it strips the runner-absolute prefix automatically.

### Alert Persistence

For findings to persist in `Security → Code scanning` (not just transient PR annotations),
SARIF must include three stable identity anchors:

1. **`automationDetails.id: "ai-guard"`** — must never change; groups all uploads together
2. **`partialFingerprints["ai-guard/v1"]`** — SHA-256(ruleId:uri:line:message) per finding
3. **`category: ai-guard`** in the `upload-sarif` workflow step

Changing `automationDetails.id` or the fingerprint key will orphan all existing GitHub alerts.

### Schema Compliance

GitHub validates SARIF against the 2.1.0 schema. Key constraints enforced by ai-guard:
- `properties.tags`: must be unique (no duplicates)
- `region.startLine`: minimum 1 (never 0)
- `level`: must be `"error" | "warning" | "note" | "none"`
- `kind`: must be `"fail" | "open" | "informational"` (or omitted)

---

## GitHub Actions Integration

`cli/utils/github-env.ts` detects the GitHub Actions environment:
- `isGitHubActions()` — checks `GITHUB_ACTIONS === 'true'`
- `getGitHubBaseRef()` — reads `GITHUB_BASE_REF` for PR diff base
- Reads `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` paths for output writing

`cli/utils/github-summary.ts` writes the PR step summary in GitHub's markdown format.

`cli/utils/git-diff.ts` resolves changed files:
- Runs `git merge-base` to find the common ancestor
- Runs `git diff <merge-base>..HEAD --name-only` to list changed files
- Handles `origin/` prefix normalization automatically

---

## PR Validation Flow

```
PR opened/updated
    │
    ├── GitHub Actions triggers workflow
    │
    ├── actions/checkout@v4 (fetch-depth: 0 for git history)
    │
    ├── ai-guard changed --pr --strict --sarif
    │   ├── git diff to find changed .ts/.js files
    │   ├── ESLint runs on changed files only
    │   ├── Results normalized and categorized
    │   ├── SARIF generated with stable fingerprints
    │   └── GitHub step summary written
    │
    ├── github/codeql-action/upload-sarif
    │   ├── SARIF validated by GitHub
    │   ├── Findings matched to existing alerts via partialFingerprints
    │   ├── New alerts created in Security → Code scanning
    │   └── Inline PR annotations posted
    │
    └── PR check status set (pass/fail based on --fail-on strategy)
```

---

## Testing Architecture

| Test Directory | What it Tests |
|---------------|---------------|
| `tests/rules/` | Rule-level valid/invalid cases via `@typescript-eslint/rule-tester` |
| `tests/cli/` | CLI commands, SARIF output, fail-on logic, JSON output |
| `tests/ci/` | SARIF schema compliance, persistence, GitHub environment detection |
| `tests/integration/` | End-to-end scans of Express and Next.js example apps |

All tests use Vitest. The shared `tests/helpers/rule-tester.ts` sets up `RuleTester` with
vitest hooks — never re-declare it in individual test files.

**Test counts:** 667 tests across 39 files (as of v1.2.7).
