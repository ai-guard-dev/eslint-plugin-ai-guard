---
title: Check integrity
description: Detect changes that weaken the checks a codebase relies on — new suppressions, skipped or removed tests, downgraded configs, removed CI steps.
---

# Check integrity

Coding agents sometimes make a build pass by weakening the checks instead of fixing the code: they skip a failing test, add `eslint-disable`, lower a coverage threshold, or mark a CI step `continue-on-error`. **Check integrity** compares a change with a base revision and reports exactly which safeguards it weakened, where, and what changed.

- **Deterministic.** Static analysis of Git diffs, ASTs and config files. No network access, no model calls.
- **Change-only.** Only weakenings introduced by the change are reported. Anything already present at the base is ignored.
- **Objective.** Findings describe what changed. They never claim intent.

```bash
npx ai-guard integrity                    # uncommitted + untracked changes vs HEAD
npx ai-guard integrity --base main        # this branch vs its merge-base with main
npx ai-guard changed --pr --integrity enforce   # PR scan + fail on weakened checks
```

---

## Example

A change skips a failing test and relaxes the coverage gate:

```diff
- it('applies the discount', () => {
+ it.skip('applies the discount', () => {
```

```diff
-  coverageThreshold: { global: { lines: 90 } },
+  coverageThreshold: { global: { lines: 70 } },
```

```text
$ npx ai-guard integrity --base main
Compared origin/main (3f9c2a1b7e4d) → working tree · 2 relevant file(s) · mode: report
2 high-confidence, 0 advisory finding(s)
  HIGH      jest.config.js  integrity-coverage-weakened
            Lowered coverage threshold `coverageThreshold.global.lines` from 90 to 70.
  HIGH      src/cart.test.ts:14  integrity-test-skipped
            Skipped the existing test "cart > applies the discount"; it no longer runs.
```

To resolve a finding, restore the check and fix the code. If a weakening is intended (for example, a test is quarantined while an upstream bug is fixed), accept it **explicitly**:

```bash
npx ai-guard integrity --base main --accept 3c9e1f20a7b4   # the #… fingerprint shown with the finding
# or several: --accept 3c9e1f20a7b4,9d02e4c1b6aa · a rule: --accept integrity-test-skipped · everything: --accept all
git add .ai-guard-baseline.json
```

Accepted findings are no longer reported. The acceptance itself appears to reviewers as an advisory finding (`integrity-acceptance-added`) in the PR that adds it, so it cannot be hidden.

---

## Tiers and enforcement

| Tier | Meaning | Effect |
|---|---|---|
| **high** | A precise, observable weakening: a new `.skip`, a rule changed from `error` to `off`, a removed CI step | Fails the check in `enforce` mode |
| **advisory** | A signal that needs judgment: fewer assertions, broader matchers, an unjustified `eslint-disable-next-line` for a non-AI-Guard rule | Never fails a check |

Enforcement is opt-in, so existing workflows are unchanged:

| Where | Report only | Enforce |
|---|---|---|
| CLI | `ai-guard integrity` (exit 0) | `ai-guard integrity --enforce` (exit 1 on a high finding) |
| Changed scans | `ai-guard changed --integrity report` | `ai-guard changed --integrity enforce` |
| GitHub Action | `integrity: report` | `integrity: enforce` |
| Claude Code | PostToolUse feedback | Stop hook blocks once per finding set (see [Claude Code](integrations/claude-code.md)) |

Exit codes: `0` no blocking finding (or report mode), `1` a high-confidence finding in enforce mode, `2` the analysis could not run (no Git repository, unknown base, shallow clone without a merge base, invalid baseline file). Check integrity never treats "could not run" as clean.

---

## Supported signals

Rule IDs are stable and appear in JSON, SARIF (`ruleId`), annotations and the step summary.

### Suppressions

| Rule | High when | Advisory when |
|---|---|---|
| `ai-guard/integrity-lint-suppression` | A new `eslint-disable*` directive or inline `/* eslint rule: "off" */` with **no `-- reason`** that disables all rules, covers the rest of the file, or targets an `ai-guard/*` rule | Targeted directives for other rules, or any directive with a reason |
| `ai-guard/integrity-ts-suppression` | New `@ts-nocheck`; new `@ts-ignore` without a description | `@ts-expect-error`; `@ts-ignore` with a description; removed `// @ts-check` |
| `ai-guard/integrity-unsafe-type-escape` | — | More `as any` / `<any>` casts in a file |

Directives are compared as a multiset per file (kind and rules), so moving or reformatting an existing directive is not reported. Broadening one (for example `eslint-disable-next-line no-console` → `eslint-disable-next-line`) is reported.

### Tests (Jest, Vitest, Mocha, Playwright syntax)

| Rule | High when | Advisory when |
|---|---|---|
| `ai-guard/integrity-test-skipped` | An existing test or suite gets `.skip`, `xit`, `xtest`, `xdescribe` or `.fixme` | A new test added already skipped; new `skipIf`/`runIf` conditions |
| `ai-guard/integrity-test-focused` | New `.only`, `fit`, `fdescribe` (other tests in the file stop running) | — |
| `ai-guard/integrity-test-file-deleted` | A test file with active tests is deleted, its tests are not found elsewhere in the change, and the change runs fewer tests overall | The same, when total test count did not drop |
| `ai-guard/integrity-test-count-reduced` | Active tests in a file drop, the removed titles are not found elsewhere in the change, and the change runs fewer tests overall | Consolidation into `.each`/parameterized tests; per-file analysis (Claude PostToolUse) |

Tests are recognized from the AST, never by text search, so tests inside comments and strings don't count. Nested `describe` blocks give each test a path (`cart > totals`) used for matching. Tests moved to another file, or renamed with `git mv`, are matched by path and not reported. A test only counts as "moved" if it is new in its destination file, so tests that already existed elsewhere cannot hide a deletion.

### Assertions (advisory only)

| Rule | Signal |
|---|---|
| `ai-guard/integrity-assertions-reduced` | Fewer `expect(...).matcher()` / `assert.*` calls in a modified test file |
| `ai-guard/integrity-assertion-loosened` | Specific matchers (`toEqual`, `toHaveBeenCalledWith`, …) decreased while generic ones (`toBeTruthy`, `toBeDefined`, `expect.anything()`, …) increased |
| `ai-guard/integrity-snapshot-update` | A Jest snapshot file had snapshots removed, or 3 or more rewritten |

### Configuration

| Rule | Files | High when |
|---|---|---|
| `ai-guard/integrity-eslint-config-weakened` | `eslint.config.*`, `.eslintrc*`, `package.json#eslintConfig`, `.eslintignore` | A rule's strongest severity drops (`error` → `warn`/`off`); AI Guard removed from the config; an `ai-guard/*` rule turned `off` in a config that uses AI Guard. *Advisory:* a rule turned off in an added block, a rule no longer configured, new ignore patterns |
| `ai-guard/integrity-tsconfig-weakened` | `tsconfig*.json`, `jsconfig.json` (comments and trailing commas allowed) | `strict` or a strict-family option, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `checkJs`, `noEmitOnError` goes from true to false (or unset with no `extends`). *Advisory:* the value now comes from `extends`, `skipLibCheck` turned on, new `exclude` entries |
| `ai-guard/integrity-coverage-weakened` | `jest.config.*`, `package.json#jest`, `vitest.config.*`, `vite.config.*`, `.nycrc*`, `.c8rc*`, `package.json#nyc`/`#c8` | A threshold (`lines`, `branches`, `functions`, `statements`) is lowered or removed; `check-coverage` turned off. *Advisory:* `collectCoverage`/`coverage.enabled` off, a config file with thresholds deleted |
| `ai-guard/integrity-test-config-weakened` | Same files | *Advisory only:* `passWithNoTests` turned on; new `testPathIgnorePatterns` / `test.exclude` entries |
| `ai-guard/integrity-verification-script-weakened` | `package.json` scripts | A `test`/`lint`/`typecheck`/`check`/`ci`… script removed, a verification command removed from it, or failures masked (`|| true`, `|| exit 0`, `; exit 0`, `set +e`). *Advisory:* `--passWithNoTests`, `--no-coverage`, new excludes |
| `ai-guard/integrity-ci-check-weakened` | `.github/workflows/*.yml` | A step or job that ran tests/lint/type checks removed (and not moved to another job or workflow in the change), `continue-on-error: true`, `if: false`, exit masking added, `pull_request`/`push`/`merge_group` trigger removed. *Advisory:* other new `if:` conditions, new `paths-ignore`/`branches-ignore` filters |
| `ai-guard/integrity-git-hook-bypass` | `package.json` scripts, `husky.hooks`, `simple-git-hooks`, `.husky/*` | `HUSKY=0`, `--no-verify`, `git commit -n` introduced; a hook removed, emptied of its checks, or made to `exit 0` first. *Advisory:* `lint-staged` config removed; `prepare` no longer installs husky |
| `ai-guard/integrity-acceptance-added` | `.ai-guard-baseline.json` | *Advisory only:* the change accepts integrity findings |

Verification commands are compared by tool invocation, not exact text: `npm test`, `npm run lint`, `vitest`, `tsc`, `npx ava`. A command that still runs with different arguments (`npm test` → `npm test -- test/browser.ts`), in the same script or anywhere in the workflow, is an **advisory** argument change, not a removal, because whether the new arguments cover the same tests cannot be decided statically. Removing a duplicate test whose exact title still runs is likewise advisory.

Config files are never executed. JavaScript configs are parsed and only literal values inside object literals are read. When a value is computed or inherited (`extends`, shared presets), the finding is advisory rather than a confirmed weakening.

---

## Base revision

| Command | Base | Head |
|---|---|---|
| `ai-guard integrity` | `HEAD` | working tree, including untracked files (respecting `.gitignore`) |
| `ai-guard integrity --staged` | `HEAD` | the index (staged content only) |
| `ai-guard integrity --base main` | merge-base of `HEAD` and `origin/main` (or `main` if there is no remote branch) | working tree |
| `ai-guard integrity --pr` | as `--base $GITHUB_BASE_REF` | working tree |
| `ai-guard changed --integrity …` | the same base `changed` uses: PR base, `HEAD`, or the index with `--staged` | |
| MCP `ai_guard_check_integrity` | `base` used exactly as given (no `origin/` guessing, like `ai_guard_scan_diff`) | |
| Claude Code hooks | the working tree at session start (SessionStart snapshot), otherwise `HEAD` at the first edit | |

Renamed files are compared with their previous version. In GitHub Actions, check out full history (`actions/checkout` with `fetch-depth: 0`), otherwise there is no merge base and the analysis exits with code 2.

---

## Output

- **Terminal:** a "Check Integrity" section listing high and advisory findings.
- **JSON:** `integrity: { mode, base, highCount, advisoryCount, blocking, accepted, findings[], errors[] }`. Each finding has `ruleId`, `tier`, `blocking`, `category`, `file`, `line?`, `message`, `before?`, `after?`, `remediation` and `fingerprint`.
- **SARIF:** results in the same `ai-guard` run with `properties.aiGuardIntegrity: true` and `integrityTier`. High findings are `warning` in report mode and `error` in enforce mode; advisories are `note` / `kind: informational`. No `security-severity` is set, because these are not vulnerabilities.
- **GitHub:** annotations (`::warning`/`::error` for high, `::notice` for advisory), a "Check integrity" step-summary section, and outputs `integrity-high-count` / `integrity-advisory-count`.

The `fingerprint` excludes line numbers, so acceptances survive unrelated edits. SARIF `partialFingerprints["ai-guard/v1"]` uses the same formula as lint results.

---

## Baselines

The lint baseline (`ai-guard baseline --save`) and integrity acceptances live in the same file but never mix:

- `baseline --save` records lint findings only. It keeps an existing `integrity.accepted` section but never adds to it, so saving a baseline can't silently accept a weakening.
- `ai-guard integrity --accept <selection>` is the only way to add acceptances. The selection is required (fingerprints, integrity rule IDs, or the literal `all`), so nothing is accepted by accident, and each accepted finding is printed. It is refused in CI (`CI=true` or `GITHUB_ACTIONS=true`).
- The record of an acceptance (`integrity-acceptance-added`) can never be accepted itself, so a PR that accepts findings always shows it.
- In Claude Code, an agent running `--accept` triggers the PreToolUse guard (the user is asked), and acceptances the agent writes into the baseline file with an edit tool block the Stop gate.
- Protect `.ai-guard-baseline.json` with CODEOWNERS if acceptances need a specific reviewer: in CI the acceptance finding is advisory, so enforcement relies on review of that file.
- Acceptances apply wherever integrity runs (CLI, Action, Claude Code, MCP). A corrupt baseline file is an error, never "no acceptances".
- `changed --baseline` filters lint findings only. Integrity findings are always computed against the base revision.

---

## Limitations

- JavaScript/TypeScript tests only. Test helpers that wrap `it`/`describe` under other names (`const myTest = test.extend(...)`) are not recognized.
- Parameterized tests (`it.each`) count as one declaration on both sides.
- Assertion signals count calls. They cannot judge whether a new assertion is as strong as the one it replaced, which is why they are advisory.
- Workflow analysis covers GitHub Actions only (not GitLab CI, CircleCI, Azure Pipelines). Reusable workflows and composite actions are not followed.
- ESLint config analysis reads literal rule entries. Severity coming from spread presets cannot be compared, so such changes are advisory.
- Prettier, Biome and oxlint configuration files are not analyzed (their `biome-ignore`/`oxlint-disable` comments are not either).
- Files larger than 2 MiB, and more than 1,000 relevant changed files, are skipped and reported as analysis errors.
- A file that cannot be parsed on either side is skipped and listed in `errors`, never guessed.
