# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] — agent safety (planned as 1.6.0)

### Added
- `ai-guard scan-agent-config`: scans agent instructions and MCP/agent config for hidden Unicode text (decoded), instructions hidden in HTML comments, pipe-to-shell installs, concealment phrases, credential reads, exfiltration, unpinned MCP servers, inline secrets, plain-HTTP remotes, and risky Claude settings. Per-server fingerprints with an optional lock file. SARIF uses its own `ai-guard-agent-config` slot.
- `ai-guard changed --test-integrity`: compares tests before and after a change. Focused tests are errors; deleted, removed, skipped or weakened tests, rewritten snapshots, and test commands or configs that can no longer fail are warnings. Tests that moved between files are not reported. GitHub Action input `test-integrity`.
- `ai-guard verify`: one verdict for a change. Only findings the change introduced count, including ones created by deleting lines.
- Claude Code `Stop` and `SessionStart` hooks, from `ai-guard init-claude` (opt out with `--no-stop-hook`) and the plugin. Each finding goes back to Claude once per session; what stays unresolved is shown to the user. No loops.
- MCP tools `ai_guard_verify_change`, `ai_guard_scan_agent_config`, `ai_guard_fix` (diff by default, writes only with `apply: true`). `ai_guard_scan_diff` also returns `testIntegrity`.
- Rules (27 total): `no-tautological-assertion`, `no-assertionless-test`, `no-test-env-branch`, at `warn` in recommended.

### Fixed
- The PostToolUse hook printed findings to stdout, which Claude Code does not show to Claude. Findings now use `additionalContext`, so the agent actually receives them.
- `ai-guard changed` crashed with `log.summary is not a function` in human-readable mode whenever files had changed.
- MCP findings now report `fixable` accurately.
- `no-async-without-await` no longer reports expression-bodied arrows whose `await` is nested, such as `async () => (await load()).items`.

---

## [Unreleased] — planned as 1.5.0

### Added — six rules (24 total)
- `no-client-exposed-secret` (Security, `error` in recommended): secret env vars behind public bundler prefixes (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `REACT_APP_`, …), server secrets read in `"use client"` files, and LLM SDK clients created with `dangerouslyAllowBrowser` and an app-owned key. Publishable, anon, site and public map keys are not flagged. Option: `allow`.
- `no-invisible-unicode` (Security, `error` in recommended): Trojan Source bidi controls, zero-width and Hangul-filler characters, Unicode tag characters and variation-selector runs. Hidden tag text is decoded into the message. Safe autofix: removal in comments, escape sequences in strings, templates and regexes. Emoji ZWJ sequences, Persian/Indic joiners and flag tag sequences are allowed.
- `no-placeholder-implementation` (AI Patterns, `warn`): elision comments that replace deleted code (`// ... rest of the code`), TODO-only stub bodies, whole-body `throw new Error('Not implemented')`, and mock data returned from production code. Abstract/base classes (including `@abstract` JSDoc), type declarations, tests, mocks, stories and seeds are excluded.
- `no-silent-fallback` (Reliability, `warn`): hardcoded fallbacks for secret env vars (`process.env.JWT_SECRET || 'secret'`) and `catch { return [] }` around awaited calls. Durations, `?? ''`, NODE_ENV-guarded dev values, safe-parse helpers and documented catches are excluded.
- `no-unsanitized-html` (Security, `warn`): dynamic values in `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `dangerouslySetInnerHTML`. Follows local constants, `+=` builders, `.map().join('')` and local helpers; allows sanitizers, escaping renderers, translations and numeric values. Specific messages for URL/request/storage/LLM input, markdown renderers, and `JSON.stringify` in script tags.
- `no-undeclared-import` (Security, `warn`): imports of packages missing from every package.json up to the repository root, distinguishing likely-hallucinated packages (not installed) from phantom dependencies (installed transitively). Understands built-ins, `@types/*`, tsconfig `paths`/`baseUrl` (including `extends`), common aliases and guarded optional `require`/`import()`. Offline; re-reads package.json when it changes. Option: `allow`.

### Changed
- `agent` preset: 5 → 8 rules. Adds `no-client-exposed-secret`, `no-invisible-unicode` and `no-undeclared-import` at `error`.
- `security` preset: 6 → 11 rules.
- The CLI's preset maps and the `ai-guard preset` summary are now derived from `src/configs/*` instead of hand-copied lists, so CLI, MCP and ESLint users always run the same rules.
- `ai-guard init-context` writes guidance for the new rules into CLAUDE.md, AGENTS.md, `.cursorrules` and Copilot instructions, and states the rule count from the registry.

### Tests
- A registry test now fails if a rule is missing CLI/SARIF metadata, a docs page, or its strict-preset entry. It documents one pre-existing mismatch: `no-empty-catch` is `high` confidence for `--fail-on` but `medium` in JSON/SARIF output.

---

## [1.4.2] — unreleased

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
