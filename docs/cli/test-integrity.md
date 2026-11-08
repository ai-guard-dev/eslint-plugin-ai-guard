# Test integrity

Linters check one version of a file. Test integrity compares each changed test file before and after a change, test by test, to answer: did this change weaken the tests?

```bash
ai-guard changed --test-integrity              # uncommitted changes
ai-guard changed --pr --test-integrity         # this PR, against its base branch
```

It's also part of [`ai-guard verify`](verify.md), the Claude Code Stop hook, and the MCP tools `ai_guard_scan_diff` and `ai_guard_verify_change`.

Findings appear with the other issues in terminal, JSON (plus a `testIntegrity` object), SARIF and PR annotations. Deleted files are left out of SARIF, since Code Scanning can't anchor an alert to a file that no longer exists.

Comparing against a branch needs its history, so use `fetch-depth: 0` in GitHub Actions.

## Checks

Refactors legitimately change tests, so most findings are warnings: the point is that a person sees them. They fail CI only with `--fail-on medium` or `any`.

### focused-test

**Error.** `.only`, `fit` or `fdescribe` was added. Every other test in the file stops running, so the suite can pass while they fail.

### test-file-deleted

A file containing tests was deleted. Helpers and fixtures under test folders aren't reported.

### tests-removed

The number of active tests in a file went down. Renamed tests aren't reported.

### test-skipped

An existing test is now skipped (`.skip`, `xit`, `skipIf(true)`).

### assertions-removed

A test that still exists has fewer assertions than before, including tests that now assert nothing.

### assertions-weakened

Exact assertions (`toBe`, `toEqual`) were replaced with ones that pass for almost anything (`toBeDefined`, `toBeTruthy`).

### snapshots-rewritten

Existing snapshot entries changed or were removed, or a snapshot file was deleted. New snapshots aren't reported.

### test-script-changed

A `package.json` script that runs a test runner was removed, no longer runs a test runner, or gained something that lets it pass without running everything (`|| true`, `--passWithNoTests`, `--grep`). Reporter, config-path and quoting changes aren't reported.

### test-config-changed

A test config (`vitest`, `jest`, `playwright`, `mocha`, ...) gained exclusions or relaxed settings, or lost coverage thresholds.

## Moved tests

A test that reappears under another file or suite in the same change counts as moved, not removed. Only tests that are actually gone are listed.

## GitHub Action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: ai-guard-dev/eslint-plugin-ai-guard@main
  with:
    test-integrity: 'true'
```
