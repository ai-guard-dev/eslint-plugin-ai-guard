# ai-guard doctor

Diagnose your `ai-guard` setup and print actionable fixes for any issues found.

---

## Usage

```bash
ai-guard doctor
```

## What It Checks

| Check | What it verifies |
|---|---|
| ESLint installed | `eslint` is resolvable from your project |
| Plugin installed | `eslint-plugin-ai-guard` is resolvable from your project |
| Config present | At least one `eslint.config.*` or `.eslintrc.*` file exists |
| Plugin wired | Your config references `ai-guard` or `eslint-plugin-ai-guard` |
| Version compatible | ESLint version is ≥ 8.0.0 |
| Config format matches | Flat config with ESLint v9, legacy with v8 |

## Example Output

### All checks pass:

```
  AI GUARD DOCTOR

  ── Diagnostics ──

  ✔  ESLint installed
       ESLint 9.1.0

  ✔  eslint-plugin-ai-guard installed
       Found in node_modules

  ✔  ESLint config present
       eslint.config.mjs (flat-mjs)

  ✔  Plugin wired in config
       ai-guard plugin found in config

  ✔  ESLint version compatible
       v9 ✔ (requires ≥ v8)

  ✔  Config format matches ESLint version
       Flat config + ESLint v9 ✔

  ────────────────────────────────────────────────

  ✔  All checks passed! Your setup looks great.
  ℹ  Run ai-guard run to start scanning.
```

### Some checks fail:

```
  ✖  eslint-plugin-ai-guard installed
       Not found in node_modules
       → Fix: npm install --save-dev eslint-plugin-ai-guard

  ✖  ESLint config present
       No eslint.config.* or .eslintrc.* found
       → Fix: ai-guard init

  ────────────────────────────────────────────────

  ✖  Some checks failed. Follow the fixes above.
  ℹ  Run ai-guard init to fix most issues automatically.
```

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | All required checks passed. Recommendations, such as adding a GitHub Actions workflow, are shown with `!` and do not fail the run. |
| `1` | One or more required checks failed |

This makes `doctor` usable in CI to verify environment setup:

```yaml
- run: npx ai-guard doctor
```
