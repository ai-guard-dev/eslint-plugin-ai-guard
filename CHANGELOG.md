# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] — 2026-05-23

### 🚀 Performance Hardening

- **Module-level ESLint instance cache**: `runEslint()` now caches the ESLint instance, plugin module, and TypeScript parser at module level keyed by `cwd::preset`. Eliminates 200-800ms of startup overhead on all warm calls within the same process.
- **Parallel initialization**: ESLint module, plugin, and TS parser now load concurrently via `Promise.all` instead of sequentially.
- **Expanded default ignore patterns**: Added `.cache/`, `.turbo/`, `.nx/`, `vendor/`, `tmp/`, `temp/`, `.yarn/`, `.expo/`, `.svelte-kit/`, `storybook-static/`, `generated/`, `__generated__/`, etc. Dramatically reduces file count for large monorepos.
- **New `TimingBreakdown.fromCache`**: Debug timing output now shows `warm cache` vs `cold start` label to validate caching behavior.

### 🔒 Context-Aware Security Rules (major false-positive reduction)

- **`require-auth-middleware`**: Now suppresses findings in Electron main/preload files, internal scripts (migrate, seed, debug, setup, scaffold), and dev-server files. Also expanded `PUBLIC_ROUTE_PATTERNS` to include `/debug`, `/diagnostics`, `/metrics`, `/swagger`, `/graphql`, `/ready`, `/live`. New schema options: `allowElectronApps` (default: true), `allowInternalScripts` (default: true), `internalPathPatterns`.
- **`require-authz-check`**: Added same Electron/internal file suppression.
- **`no-unsafe-deserialize`**: Suppressed in internal tooling files (scripts, migrations, seeds, fixtures, diagnostics). These commonly use `JSON.parse` on known-safe internal data.

### 🎯 4-Tier Confidence System

- **New `informational` tier** added to `CONFIDENCE_TIER`. Rules with high framework false-positive rates are now `informational` instead of `low`:
  - `no-async-without-await` → `informational` (heavy Next.js/React/framework FP source)
  - `no-redundant-await` → `informational` (mostly stylistic)
- **Informational findings are collapsed by default** in CLI output: `▸ 4 informational hints — run with --verbose to expand`
- **Category summary excludes informational findings** — only actionable issues are counted
- **`[info]` tag** shown in By Rule section for informational rules

### 📊 SARIF Output (GitHub Code Scanning)

- **New `--sarif` flag** on `ai-guard run`: outputs SARIF 2.1.0 JSON to stdout
- **New `cli/utils/sarif.ts`**: Full SARIF 2.1.0 generator. Includes rule descriptors, physical locations, helpUri, and severity mapping.
- **New `examples/ci/github-code-scanning.yml`**: Ready-to-use GitHub Actions workflow for Code Scanning PR annotations
- **`signalSummary` in `--json` output**: Replaces misleading numeric score with `{ high, medium, low, informational, ecosystemIssues, parserErrors }` counts
- **`IssueDetail` now includes `endLine`/`endColumn`** for precise code range highlighting in editors and SARIF viewers

### 🎨 DX Polish

- **New `--quiet` flag**: Only shows errors — suppresses warnings and informational hints. Ideal for strict CI gates.
- **Less alarmist rule messages**: Removed "AI tools frequently generate dangerous..." language from `require-auth-middleware`, `require-authz-check`, `no-unsafe-deserialize` messages.
- **Calmer message tone** across context-aware rules

### 🧪 Tests

- 11 new SARIF output tests (`tests/cli/sarif.test.ts`)
- Test fixtures: `tests/fixtures/electron-app/main.js`, `tests/fixtures/internal-tooling/migrate.js`
- **475 tests total** (up from 464)

---

## [1.2.0] — 2026-05-23

### Added
- Phase 1 hardening: ecosystem error separation, framework-aware async rules
- `--debug-timing` flag with per-phase timing breakdown
- `--verbose` flag for expanding grouped warnings
- Confidence tiers (high/medium/low) in CLI output
- `ai-guard doctor` command for ESLint config diagnostics
- `ai-guard report` HTML report generation
- `ai-guard baseline` for tracking new issues only
- `ai-guard ignore` for suppressing dist/build noise

---

## [1.1.0] — 2026-05-21

### Added
- Initial public release with 17 rules
- `no-empty-catch`, `no-broad-exception`, `no-catch-log-rethrow`, `no-catch-without-use`
- `no-floating-promise`, `no-await-in-loop`, `no-async-without-await`, `no-async-array-callback`, `no-redundant-await`
- `no-hardcoded-secret`, `no-eval-dynamic`, `no-sql-string-concat`, `no-unsafe-deserialize`
- `require-auth-middleware`, `require-authz-check`
- `no-console-in-handler`, `no-duplicate-logic-block`, `no-dead-branch`
- CLI with `run`, `baseline`, `report`, `doctor`, `ignore`, `init` commands
