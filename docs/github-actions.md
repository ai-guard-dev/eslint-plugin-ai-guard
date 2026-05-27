# GitHub Actions Integration Guide

> **ai-guard** integrates natively with GitHub pull request workflows: detecting reliability and
> security issues in AI-generated code, generating SARIF reports for GitHub Code Scanning, and
> posting inline PR annotations at the exact line of each finding.

---

## Quick Start (5 minutes)

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
          fetch-depth: 0  # Required for changed-file detection

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - name: Scan changed files
        run: |
          npx ai-guard changed \
            --pr \
            --strict \
            --sarif \
            --sarif-output ai-guard-results.sarif \
            --fail-on high

      - name: Upload to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: ai-guard-results.sarif
          category: ai-guard
```

This produces:
- ✅ Inline PR annotations at the exact line of each finding
- ✅ GitHub Advanced Security summary in the PR check
- ✅ Persistent alerts in `Security → Code scanning`
- ✅ PR status check that blocks merges on high-severity findings

---

## Workflow Variants

### PR-only changed-file scan (recommended)

Scans only the files changed in the pull request. Fastest — scales to large monorepos.

```yaml
- name: Scan changed files
  run: |
    npx ai-guard changed \
      --pr \
      --strict \
      --sarif \
      --sarif-output results.sarif \
      --fail-on high
```

### Full project scan on push to main

```yaml
name: AI Guard Full Scan

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6am UTC

permissions:
  security-events: write
  contents: read

jobs:
  full-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci

      - name: Full project scan
        run: |
          npx ai-guard run \
            --path src \
            --strict \
            --sarif \
            --sarif-output results.sarif \
            --fail-on errors

      - name: Upload to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
          category: ai-guard
```

### Baseline mode (adopt incrementally)

Track only new issues introduced after a baseline snapshot. Useful for
onboarding ai-guard onto a codebase with existing issues.

```yaml
- name: Save baseline (run once to establish)
  run: npx ai-guard baseline save

- name: Scan against baseline
  run: |
    npx ai-guard run \
      --strict \
      --sarif \
      --sarif-output results.sarif
  # Only new issues (not in baseline) will appear
```

### Security-only scan

```yaml
- name: Security scan
  run: |
    npx ai-guard run \
      --security \
      --sarif \
      --sarif-output security.sarif \
      --fail-on errors
```

---

## Fail Strategies

| Flag | Behavior |
|------|----------|
| `--fail-on errors` | Fail on any error-level finding (default) |
| `--fail-on high` | Fail only on high-severity findings |
| `--fail-on warnings` | Fail on any finding including warnings |
| `--fail-on none` | Never fail — always continue workflow |
| `--max-warnings 0` | Fail on any warning |

---

## SARIF and GitHub Code Scanning

ai-guard generates SARIF 2.1.0 output that integrates directly with GitHub Advanced Security.

### Why findings persist across runs

ai-guard emits three stable identity anchors in every SARIF upload:

1. **`automationDetails.id: "ai-guard"`** — groups all uploads under one persistent analysis slot
2. **`partialFingerprints["ai-guard/v1"]`** — SHA-256 per finding for deduplication across reruns
3. **`category: ai-guard`** on the upload step — links to the persistent Code Scanning slot

Without these, GitHub treats every upload as a fresh snapshot, closes old alerts, and never
promotes findings to the repository-level alert tracker.

### Path resolution

Artifact URIs in SARIF must be repository-relative POSIX paths (e.g., `src/handler.ts`).
ai-guard automatically strips `GITHUB_WORKSPACE` from absolute runner paths, removes drive
letters (Windows), and converts backslashes to forward slashes.

### Required permissions

```yaml
permissions:
  security-events: write  # Required for upload-sarif
  contents: read          # Required for checkout
```

---

## Debug Flags

When findings don't appear in Code Scanning, use these flags to diagnose:

```bash
# Trace path normalization
npx ai-guard changed --sarif --debug-sarif-paths

# Trace SARIF persistence identity (fingerprints, automationDetails)
npx ai-guard changed --sarif --debug-sarif-persistence

# Trace SARIF tag and severity normalization
npx ai-guard changed --sarif --debug-sarif

# All debug output combined
npx ai-guard changed --sarif \
  --debug-sarif \
  --debug-sarif-paths \
  --debug-sarif-persistence
```

---

## Environment Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `GITHUB_WORKSPACE` | Path normalizer | Strip absolute runner paths from SARIF URIs |
| `GITHUB_BASE_REF` | Changed-file scanner | Base branch for PR diff |
| `GITHUB_HEAD_REF` | Changed-file scanner | Head branch for PR diff |
| `GITHUB_STEP_SUMMARY` | Summary writer | Write markdown summary to PR check |
| `GITHUB_OUTPUT` | Output writer | Emit `totalIssues` and `sarifPath` as step outputs |

These are all set automatically by GitHub Actions. No manual configuration needed.

---

## Example: Complete Production Workflow

```yaml
name: AI Guard

on:
  pull_request:
  push:
    branches: [main]

permissions:
  security-events: write
  contents: read

jobs:
  ai-guard:
    name: AI Guard Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - name: Scan (PR — changed files only)
        if: github.event_name == 'pull_request'
        run: |
          npx ai-guard changed \
            --pr \
            --strict \
            --sarif \
            --sarif-output ai-guard-results.sarif \
            --fail-on high

      - name: Scan (push — full project)
        if: github.event_name == 'push'
        run: |
          npx ai-guard run \
            --path src \
            --strict \
            --sarif \
            --sarif-output ai-guard-results.sarif \
            --fail-on errors

      - name: Upload to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: ai-guard-results.sarif
          category: ai-guard
```
