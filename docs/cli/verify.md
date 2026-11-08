# verify

One verdict for the current change, for an agent to check before calling work done, or a person before merging.

```bash
ai-guard verify                # uncommitted changes vs HEAD
ai-guard verify --base main    # everything on this branch
ai-guard verify --json         # machine-readable verdict
```

| Option | Description |
|---|---|
| `--base <ref>` | Compare through the merge-base with this ref |
| `--staged` | Verify staged changes only |
| `--preset <name>` | Lint preset: `agent` (default), `recommended`, `strict`, `security` |
| `--strict` | Also fail on findings to disclose |
| `--json` | Output the verdict as JSON |

**Exit codes:** `0` pass, `1` blocking findings, `2` the change couldn't be fully verified (Git failure, or a file that doesn't parse).

## What it checks

| Source | Blocking | To disclose |
|---|---|---|
| **Lint**, on lines the change added or edited | Errors in the preset, plus `no-placeholder-implementation`, `no-tautological-assertion`, `no-test-env-branch` | `no-assertionless-test`, `no-silent-fallback`, `no-unsanitized-html` |
| **[Test integrity](test-integrity.md)** | Focused tests | Deleted, skipped, removed or weakened tests |
| **[Agent config](scan-agent-config.md)** the change touched | Hidden text, inline secrets, exfiltration | Unpinned MCP servers and other warnings |

**Only what the change introduced counts.** Problems already in a touched file are counted but never block, so an agent isn't pushed into fixing legacy code it didn't write. Deleted lines count too: emptying a `catch` body is attributed to the change even though the `catch` line itself didn't change.

**Disclosures** don't fail the verdict. Tests sometimes should change, so the requirement is that the user gets told.

## In Claude Code

`ai-guard init-claude` and the AI Guard plugin run this automatically when Claude finishes. See [Claude Code integration](../integrations/claude-code.md).
