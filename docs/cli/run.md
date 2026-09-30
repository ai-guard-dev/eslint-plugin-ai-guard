# ai-guard run

Scan your project for AI-generated code patterns. This is the most important command — it works with **zero ESLint configuration.**

---

## Usage

```bash
ai-guard run [options]
```

## Options

| Option | Default | Description |
|---|---|---|
| `--path <target>` | `.` (current directory) | Directory or file to scan |
| `--strict` | off | Use the strict preset — all 18 rules at `error` |
| `--security` | off | Use the security-only preset |
| `--json` | off | Output results as machine-readable JSON |
| `--max-warnings <n>` | none | Exit with code 1 if warnings exceed `n` |
| `--help` | — | Show help |

## Examples

```bash
# Scan everything in the current directory
ai-guard run

# Scan a specific folder
ai-guard run --path src/api

# Scan one file directly
ai-guard run --path src/api/users.ts

# Strict mode — all rules at error
ai-guard run --strict

# Security rules only
ai-guard run --security

# CI mode — JSON output, fail on any warning
ai-guard run --json --max-warnings 0

# Combine: scan a path, strict mode, JSON output
ai-guard run --path src --strict --json
```

## Notes

- If `--path` points to a file, only that file is scanned.
- If `--path` does not exist, the command exits with an error.
- If both `--strict` and `--security` are passed, `--strict` takes precedence.

## Output Format

### When issues are found:

```
  AI GUARD RESULTS

  ✔ Scanned:  src/
  ✔ Duration: 843ms

  Total Issues: 12 errors · 8 warnings

  ── By Rule ──

    • no-floating-promise:      7
    • no-empty-catch:           4
    • no-sql-string-concat:     3
    • require-auth-middleware:  3

  ── Top Files ──

    • src/api/users.ts  (6)
    • src/utils/db.ts   (4)

  ── Issues by File ──

  src/api/users.ts (3 errors, 2 warnings)
    12:5  error  Possible hardcoded secret...   no-hardcoded-secret
    28:3  error  Async call not awaited...       no-floating-promise
    45:1   warn  Async callback in .map()...     no-async-array-callback
```

### When no issues are found:

```
  ✔ No AI issues found — your code looks clean
```

## JSON Output (--json)

When using `--json`, output is written to stdout:

```json
{
  "preset": "recommended",
  "scannedPath": "src/",
  "totalErrors": 12,
  "totalWarnings": 8,
  "totalIssues": 20,
  "durationMs": 843,
  "ruleBreakdown": {
    "ai-guard/no-floating-promise": 7,
    "ai-guard/no-empty-catch": 4
  },
  "topFiles": [
    { "path": "src/api/users.ts", "count": 6 }
  ],
  "files": [
    {
      "filePath": "src/api/users.ts",
      "errorCount": 3,
      "warningCount": 2,
      "issues": [
        {
          "ruleId": "ai-guard/no-floating-promise",
          "severity": 2,
          "message": "...",
          "line": 28,
          "column": 3
        }
      ]
    }
  ]
}
```

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success — no errors (warnings may exist unless `--max-warnings` is set) |
| `1` | Errors found, or `--max-warnings` exceeded |

## Presets

| Flag | Rules enabled | Severity |
|---|---|---|
| (none) | recommended (12 rules) | balanced |
| `--strict` | all 18 rules | all `error` |
| `--security` | 6 security rules | `error`/`warn` |
