# ai-guard baseline

Save current findings as a baseline and track only newly introduced issues.

---

## Usage

```bash
ai-guard baseline [options]
```

## Options

| Option | Default | Description |
|---|---|---|
| `--save` | auto | Save current issues to `.ai-guard-baseline.json` |
| `--check` | auto | Compare current scan with baseline and show only new issues |
| `--mode <name>` | `stable` | Match mode: `stable` (file+rule+message) or `strict` (includes line/column) |
| `--path <target>` | `.` | Directory or file to scan |
| `--preset <name>` | `recommended` for save; the baseline's preset for check | `recommended`, `strict`, `security`, or `agent` |

## Default mode behavior

If no baseline file exists:

- `ai-guard baseline` behaves like `--save`

If baseline file already exists:

- `ai-guard baseline` behaves like `--check`

## Common workflow

```bash
# 1. Save current state
npx ai-guard baseline --save

# 2. Commit baseline file
# git add .ai-guard-baseline.json && git commit -m "chore: add ai-guard baseline"

# 3. In CI, fail only on new issues
npx ai-guard baseline --check          # full project
npx ai-guard changed --pr --baseline   # PR changed files only

# Optional: strict mode if you want exact location matching
npx ai-guard baseline --save --mode strict
```

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | No new issues since baseline |
| `1` | New issues found, or command failed |

## Notes

- Baseline file path: `.ai-guard-baseline.json`
- Default mode `stable` is less noisy during refactors where line numbers move.
- Matching is count-based: each baseline entry absorbs one current finding. If a
  file had one `no-empty-catch` finding when the baseline was saved and now has
  two, the second one is reported as new — even in `stable` mode, where both
  findings share the same file, rule and message.
- An unreadable or malformed baseline file is an error (exit `1` for
  `baseline --check`, exit `2` for `changed --baseline`). `ai-guard baseline`
  without `--save` never overwrites it.
- Share this file in git if you want team-wide consistent baseline behavior.
- The file can also hold explicit check-integrity acceptances (`integrity.accepted`), written only by `ai-guard integrity --accept`. `baseline --save` preserves that section but never adds to it, so saving a baseline cannot accept a weakened check. See [Check integrity](../integrity.md#baselines).
- `ai-guard changed --baseline [file]` applies the same matching to PR scans;
  see [GitHub Actions → Baseline mode](../github-actions.md#baseline-mode-adopt-incrementally).
