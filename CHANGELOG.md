# Changelog

All notable changes to this project will be documented in this file.

## [1.4.3] — unreleased

### Added — check integrity
- **`ai-guard integrity`** detects changes that weaken the checks a codebase relies on, relative to a base revision (`HEAD` by default, `--base <ref>` for a branch merge-base, `--staged` for the index). Only weakenings introduced by the change are reported. Covered:
  - new or broadened `eslint-disable` directives and inline `/* eslint rule: off */`
  - new `@ts-ignore`/`@ts-nocheck`
  - newly skipped (`.skip`, `xit`, `xdescribe`, `.fixme`) or focused (`.only`, `fit`, `fdescribe`) tests
  - deleted test files and fewer active tests (AST-based; tests moved to other files are recognized)
  - lowered or removed coverage thresholds (Jest, Vitest, nyc, c8)
  - ESLint rule downgrades and AI Guard removed from the config
  - TypeScript strict options disabled
  - verification scripts removed or masked (`|| true`)
  - GitHub Actions steps removed, `continue-on-error: true`, `if: false`, PR triggers removed
  - `HUSKY=0`/`--no-verify` and weakened husky hooks

  Advisory-only signals: fewer or looser assertions, snapshot rewrites, more `as any`. Findings have stable IDs (`ai-guard/integrity-*`), a `high`/`advisory` tier, before/after values, remediation, and a line-independent fingerprint. See [docs/integrity.md](docs/integrity.md).
- `ai-guard changed --integrity <off|report|enforce>` runs the same analysis next to the changed-file scan, against the same base. Findings appear in terminal output, JSON (`integrity`), SARIF (same run, `properties.aiGuardIntegrity`), GitHub annotations, the step summary and outputs (`integrity-high-count`, `integrity-advisory-count`). `enforce` exits 1 on a high-confidence finding and 2 when the analysis cannot run (for example, a shallow clone without a merge base). `report` never changes the exit code. Default `off`: output is unchanged.
- GitHub Action inputs `integrity` (`off` | `report` | `enforce`, needs `changed-only`) and `inline-suppressions`. With `integrity: enforce`, `fail-on: none` no longer swallows the failure. Integrity results are counted separately from `issues-found`.
- Explicit acceptances: `ai-guard integrity --accept <fingerprints|rule IDs|all>` records the selected findings' fingerprints in `.ai-guard-baseline.json` (`integrity.accepted`). A selection is required, each accepted finding is printed, and it is refused in CI. The acceptance record itself can never be accepted. In Claude Code, an agent running `--accept` triggers the Bash guard, and acceptances it writes into the baseline file with an edit tool block the Stop gate. A change that adds acceptances is itself reported as an advisory finding. `baseline --save` preserves acceptances but never creates them.
- MCP tool `ai_guard_check_integrity` (same engine and finding model; workspace-scoped; packaged parser only).
- Claude Code: `init-claude` also registers **SessionStart** (snapshots the working tree as the integrity base, using a temporary index so nothing is modified), **Stop** (blocks finishing once per unique set of high-confidence weakenings; repeated or advisory findings only produce a `systemMessage`, so there is no loop) and **PreToolUse** for `Bash` (asks before `git commit --no-verify` / `HUSKY=0`). `--no-stop-hook` and `--no-bash-guard` opt out. Existing legacy `Edit|Write` hooks are kept.
- `--inline-suppressions <allow|require-reason|ignore>` for `run` and `changed`.

### Fixed — integrations
- **Claude Code hook findings never reached Claude.** The PostToolUse hook printed plain text to stdout and exited 0, which Claude Code writes to its debug log without showing it to Claude. The hook now returns the documented JSON (`decision: "block"` + `reason` for findings, `hookSpecificOutput.additionalContext` for advisories).
- **Inline directives silently hid AI Guard findings.** In the CLI, the Action and the Claude hook, a bare `// eslint-disable-line`, a targeted `eslint-disable-next-line ai-guard/<rule>`, a file-wide `/* eslint-disable */` or `/* eslint ai-guard/<rule>: off */` removed findings with no trace. AI Guard's private ESLint instance now always disables inline configuration (it only runs AI Guard rules, so users' own `eslint .` is unaffected). AI Guard applies one shared directive policy instead:
  - **`allow`** (CLI default): directives still hide findings from totals and exit codes, but hidden findings are listed (terminal section, JSON `suppressedIssues`, step summary, SARIF `suppressedFindingsCount`).
  - **`require-reason`** (Claude hook): only directives with ` -- reason` hide findings.
  - **`ignore`** (MCP, unchanged behaviour): findings now carry `inlineDirective` so agents see that their comment did not suppress anything.

  Inline rule-option overrides (`/* eslint ai-guard/x: ["error", {…}] */`) are no longer applied by the CLI.
- **`ai-guard changed` crashed in its default human-readable mode** (`log.summary is not a function`) whenever changed files existed. Found via `tsconfig.cli.json`; the JSON and SARIF modes were unaffected.
- The documented suppression syntax `// ai-guard-disable <rule> -- reason` (CLAUDE.md, generated agent context files) only worked for `no-await-in-loop`. The guidance now uses `// eslint-disable-next-line ai-guard/<rule> -- <reason>`.
- `tsconfig.cli.json` type errors in `changed.ts` (`Promise<void>` on a synchronous function) and `sarif.ts` (`kind` widened to `string`) fixed. Unused imports elsewhere and the optional `import('open')` remain; they are not runtime defects.

### Changed — release-readiness hardening
- `ai-guard integrity --accept` requires an explicit selection (fingerprints shown as `#…` in the output, integrity rule IDs, or the literal `all`) and prints each accepted finding; a bare `--accept` accepts nothing. The record of an acceptance (`integrity-acceptance-added`) can never be accepted.
- Claude Code: the PreToolUse guard also asks before the agent runs `ai-guard integrity --accept`; acceptances the agent writes into `.ai-guard-baseline.json` with an edit tool block the Stop gate (acceptances made by the user only inform). The Stop reason names the exact fingerprints to accept.
- Faster integrity analysis: base contents are read with one `git cat-file --batch`, added lines come from one `git diff -U0`, per-file hook checks limit Git to the edited path, and non-test sources without suppression text are not parsed. A change-wide check of 56 files went from 9.3 s to 3.0 s; the per-file hook check from ~0.6 s to ~0.2 s (Windows 11, Node 22).
- Precision, from replaying 300 commits of expressjs/express, fastify/fastify and sindresorhus/ky:
  - Verification commands are matched by tool invocation, so a step or script that still runs `npm test` with new arguments (or in another job) is an advisory argument change, not a removed check.
  - Removing a duplicate test whose exact title still runs is advisory.
- `npm run typecheck` now also checks `tsconfig.cli.json`; its 14 remaining errors (unused declarations, missing types for the optional `open` import) are fixed.

### Changed
- `js-yaml` (MIT) is a bundled devDependency, used to parse GitHub Actions workflows. No new runtime dependency. `THIRD-PARTY-NOTICES.md` is regenerated and now also lists tsup's CJS shim.

### Added
- `ai-guard changed --baseline [file]` reports only findings that are not recorded in the baseline (default `.ai-guard-baseline.json`). Annotations, the step summary, SARIF, `--json` and the exit code all use the filtered findings; `--json` gains a `baseline: { path, mode, preset, suppressed }` field and the step summary notes how many existing findings were hidden. A missing or malformed baseline exits with code `2` instead of reporting everything. Output without `--baseline` is unchanged.
- GitHub Action input `baseline`: passes `--baseline <file>` to `changed` when `changed-only` is true (ignored, with a warning, for full scans).

### Fixed
- **CLI could not find its bundled plugin outside a project that installs it.** The CJS bundles stubbed `import.meta` as `{}`, so the "load from our own package" fallback threw and `ai-guard` exited with "eslint-plugin-ai-guard is not installed" whenever the scanned directory did not resolve the package itself (e.g. `npx -p eslint-plugin-ai-guard ai-guard run`, which the Action uses when the project has no local install). The CLI and MCP bundles are now built with tsup `shims: true`.
- **Baseline matching hid repeated findings.** Stable mode matched by `file::rule::message` in a set, so once a file had one baselined finding for a rule with a fixed message (e.g. `no-empty-catch`), every later finding of that rule in the file was treated as existing. Matching is now count-based: each baseline entry absorbs one current finding.
- `ai-guard baseline` no longer overwrites a corrupt `.ai-guard-baseline.json` when run without `--save` (it previously treated an unreadable file as "no baseline" and re-saved, recording all current findings). It now exits `1` with the parse error.
- `ai-guard baseline --check` compares with the preset stored in the baseline unless `--preset` is given (it previously always used `recommended`).
- `require-auth-middleware`:
  - Public routes are matched by exact first path segment after an optional `/api`, `/api/vN` or `/vN` prefix. Previously a prefix regex treated `/authors`, `/publications`, `/devices/:id`, `/livestreams` and `/statuses/:id` as public (missed findings) and flagged `/api/health`, `/api/v1/login` and `/v2/auth/refresh` (false positives).
  - `/debug`, `/diagnostics`, `/internal` and `/dev` routes are no longer treated as public. Internal-tooling *files* are still skipped.
  - Fastify routes on `fastify`/`server` receivers are now analyzed (previously only `app`/`router` names were, so most Fastify code was silently skipped and the existing Fastify test passed vacuously). Recognized: `{ onRequest | preParsing | preValidation | preHandler: … }` with identifiers, member references or arrays (`{ onRequest: [fastify.authenticate] }`), and `fastify.addHook('onRequest', fastify.authenticate)` as router-level auth.
  - Middleware arrays (`[requireAuth, validate]`) and member references (`auth.required`, `passport.authenticate`) are recognized; `auth.optional` is not.
  - `router.use('/admin', protect)` covers only routes under `/admin` instead of the whole router.
  - Receivers whose names end in `routes` (`userRoutes`) are analyzed; HTTP clients named `api`/`client` are not.
  - An invalid `internalPathPatterns` regex now fails with an error naming the rule, option and pattern.
  - Messages are unchanged, so SARIF fingerprints and baseline entries for existing findings stay stable. Expect some new findings on the routes listed above.
- `docs/github-actions.md` baseline example claimed `ai-guard run` reports only new issues after `baseline save`; `run` never read the baseline. The example now uses `changed --baseline` / the Action input.

## [1.4.2] — 2026-10-20

### Changed
- Runtime `dependencies` reduced from 8 packages to 1 (`@typescript-eslint/utils`). The MCP SDK, `zod`, `chalk`, `ora`, `commander` and `@inquirer/prompts` are now bundled into `dist/` and moved to `devDependencies`; the unused `tsx` dependency is removed. The CLI, MCP server and ESLint plugin behave as before. Tool results, rules and the CLI's output are unchanged.
- Installing the MCP server with `npx` (ai-guard + eslint + @typescript-eslint/parser) now pulls ~112 packages / ~44 MB instead of ~246 packages / ~69 MB. In our cold-cache tests (empty npm cache, same machine) the MCP server typically connected in 15–25 s, with occasional runs at about 30 s, versus 32–35 s in every run of 1.4.1 (Claude Code's default MCP startup timeout is 30 s). ESLint and TypeScript themselves account for most of the remaining time, so a very slow first download can still exceed the timeout.
- `THIRD-PARTY-NOTICES.md` is published with the package and lists the license texts of the bundled packages (`npm run notices` regenerates it from the bundles' source maps).
- The npm tarball is larger (~1.4 MB, up from ~0.5 MB) because those dependencies are now bundled.

---

## [1.4.1] — 2026-10-20

### Fixed
- `--json` and SARIF written to stdout stay valid machine-readable output when `GITHUB_ACTIONS=true`: workflow annotations (`::error`/`::warning`) go to stderr instead of being prepended to the payload. Human-readable mode still prints annotations to stdout; step summaries and `GITHUB_OUTPUT` are unchanged. Applies to `run` and `changed`.
- `ai-guard run --sarif` no longer prints the banner to stdout, so its output parses as SARIF.
- `ai_guard_scan_project` now detects Windows junctions on Node 20 (where `Dirent` reports them as directories) and refuses them with `SYMLINK_IN_PROJECT` like other symlinks.

### Changed (MCP)
- Result contract: `success`, `status` (`complete` | `partial` | `failed`), `clean`, and machine-readable `errors[{code, message, file?, line?}]`. Only `status:"complete"` with `clean:true` is a clean scan; parse errors, skipped files, Git failures and invalid input are never reported as clean.
- All tools declare an `outputSchema` and return `structuredContent`; the text content is the same object as compact JSON, so `JSON.parse(content[0].text)` consumers keep working.
- Scan tools accept `maxIssues` (default **50**, max 1000). Findings are sorted errors first; `totalIssues` counts every finding and `truncated` flags a cut list. Truncation yields `partial` + `RESULT_LIMIT` but keeps `success:true` (analysis completed).
- New `ai_guard_scan_project` tool for bounded directory scans (500 files, 1 MiB/file, 20 MiB total, no symlink traversal).
- `ai_guard_scan_diff` uses strict Git selection: no silent `HEAD~1` fallback, no implicit `GITHUB_BASE_REF`; `base` + `staged` is rejected.
- `ai_guard_rules` accepts `rules: [...]` for targeted lookup (description, remediation, `docsUrl`) and reports `unknownRules`.
- New `verify_changes` MCP prompt (scan → fix → rescan).
- MCP scans run isolated: bundled rules/parser only, no plugin code or inline ESLint directives from the scanned workspace. One tool call at a time (`SERVER_BUSY`).
- `zod` is now a declared dependency.

### Fixed (ignore handling)
- Explicit file scans (`ai-guard run --path <file>`, the Claude PostToolUse hook) bypassed the built-in ignore patterns because they were resolved against the file's own directory. They now resolve against the current directory; ignored files are reported in `RunResult.ignoredFiles` (and not counted in `filesScanned`) instead of as an ESLint config issue or as clean.
- `ai-guard run --path <file>` exits with code **2** and reports "Scan did not run" (`"scanRan": false` in `--json`) when the requested file is ignored and nothing is analyzed. Finding exit codes (`0`/`1`) are unchanged; directory scans and `ai-guard changed` are unaffected.
- Debug logging goes to stderr so `--json` / SARIF stdout stays parseable.

---

## [1.4.0] — 2026-10-02

### Added
- Local MCP server for AI-agent workflows (`ai-guard-mcp`)
- MCP tool `ai_guard_scan_file` — single-file deterministic AST analysis
- MCP tool `ai_guard_scan_diff` — differential Git working tree scanning
- MCP tool `ai_guard_rules` — list available rules, categories, and presets
- Public `ai-guard-mcp` binary in `package.json`

### Improved
- `ai_guard_scan_diff` now includes newly created untracked JS/TS files inside the workspace automatically
- Improved MCP agent-facing tool descriptions and documentation
- Ensured deterministic workspace root synchronization in MCP server

### Validation
- Added MCP integration test coverage (`tests/cli/mcp-server.test.ts`)
- Added untracked-file differential scanning test coverage

---

## [1.3.1] — 2026-09-30

### 📝 Documentation & Count Fixes

- Fixed all stale references from "17 rules" to "18 rules" across CLI messages, docs, and generated context files.
- Added missing `no-dead-branch` to the `RULE_CATEGORIES` in `init-context.ts` (root cause of the 17-rule undercount).
- Fixed `preset.ts` display: "5 more" → "6 more" for recommended preset breakdown.

### 🎯 Agent Preset — First-Class Public Export

- Promoted the internal `agent` preset to a public ESLint config export (`aiGuard.configs.agent`).
- Agent preset includes 5 high-signal rules at `error`: `no-hardcoded-secret`, `no-eval-dynamic`, `no-empty-catch`, `no-sql-string-concat`, `no-floating-promise`.
- Optimized for AI-agent editing workflows (PostToolUse hooks, real-time feedback loops).
- Added preset details to CLI `preset` command display.

### 📖 Type-Aware Accuracy

- Corrected documentation to accurately describe `no-floating-promise` as optionally type-aware (uses TypeScript parser services when available, with syntax/scope-based fallback).
- Replaced inaccurate "No type information required" claims with precise descriptions distinguishing syntax/scope-based analysis from optional type-aware analysis.
- Added explicit dual-mode test suite for `no-floating-promise` covering both syntax-only and type-aware execution paths.

### 🧪 Testing

- New `no-floating-promise-modes.test.ts`: explicit valid/invalid tests for both syntax-only and type-aware modes.
- New `agent-preset.test.ts`: verifies agent preset rule count, rule names, severity, and scan results against a fixture file.
- New `tests/fixtures/agent-patterns.js`: realistic AI-generated Express.js fixture with 5 intentional anti-patterns.
- Added plugin-meta test verifying agent config export with 5 rules.

---

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
