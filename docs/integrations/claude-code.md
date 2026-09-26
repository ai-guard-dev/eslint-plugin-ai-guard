---
title: Claude Code Integration
description: Configure AI Guard as a PostToolUse hook in Claude Code
---

# Claude Code Integration

AI Guard integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a PostToolUse validation hook. Every time Claude Code edits or writes a file, AI Guard automatically scans it for common AI-generated code issues.

## Quick Setup

```bash
# Install AI Guard as a dev dependency
npm install --save-dev eslint-plugin-ai-guard

# Configure the Claude Code hook
npx ai-guard init-claude
```

That's it. AI Guard will now validate every file edit Claude Code makes.

## How It Works

```
Claude Code edits a file
        ↓
PostToolUse hook fires
        ↓
ai-guard claude-hook reads stdin
        ↓
Extracts edited file path
        ↓
Runs AI Guard (agent preset)
        ↓
Outputs findings to stdout
        ↓
Claude Code reads diagnostics
        ↓
Automatically fixes issues
```

1. Claude Code triggers a **PostToolUse** event after `Edit` or `Write` tool calls
2. The hook reads the event payload from stdin to identify the edited file
3. AI Guard scans **only the edited file** using the fast `agent` preset
4. Findings are output as concise, structured diagnostics
5. Claude Code reads the diagnostics and can fix issues automatically

## What Gets Checked

The `agent` preset is optimized for speed and precision with near-zero false positives:

| Rule | Category | Confidence |
|------|----------|------------|
| `no-hardcoded-secret` | Security | High |
| `no-eval-dynamic` | Security | High |
| `no-empty-catch` | Reliability | High |
| `no-sql-string-concat` | Security | Medium |
| `no-floating-promise` | Async | High |

Rules like `require-auth-middleware` and `no-await-in-loop` are intentionally excluded — they require cross-file context that's too noisy for per-edit feedback.

## Commands

### `ai-guard init-claude`

Configures the PostToolUse hook in `.claude/settings.json`.

```bash
# Standard setup
npx ai-guard init-claude

# Preview changes without writing
npx ai-guard init-claude --dry-run

# Use settings.local.json instead (gitignored, per-machine)
npx ai-guard init-claude --local
```

**What it does:**
- Creates/updates `.claude/settings.json`
- Adds a `PostToolUse` hook for `Edit|Write` tool calls
- Preserves all existing Claude Code settings
- Idempotent: safe to run multiple times

**Generated configuration:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node_modules/.bin/ai-guard claude-hook"
          }
        ]
      }
    ]
  }
}
```

### `ai-guard claude-hook`

> Internal command — invoked automatically by Claude Code.

Reads PostToolUse JSON from stdin, scans the edited file, and outputs diagnostics.

```bash
# For testing — scan a specific file directly:
npx ai-guard claude-hook --file src/api.ts
```

**Behavior:**
- Silent on success (no output when no issues found)
- Never exits with non-zero code (won't block Claude's workflow)
- Skips non-JS/TS files automatically
- Debug logging via `AI_GUARD_DEBUG=1`

## Diagnostics Format

When issues are found, the hook outputs structured text that Claude Code can parse:

```
AI Guard found 2 issue(s).

ai-guard/no-empty-catch
src/api.ts:42:7

Empty catch block — errors are silently swallowed.
Add error handling in the catch block, or at minimum log the error.
Confidence: high

---

ai-guard/no-hardcoded-secret
src/api.ts:15:20

Hardcoded secret detected in source code.
Move credentials to environment variables: `process.env.SECRET_KEY`.
Confidence: high
```

## Removing the Hook

To remove the integration, delete the AI Guard entry from `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": []
  }
}
```

Or delete `.claude/settings.json` entirely to reset all Claude Code settings.

## Troubleshooting

### Hook not running

1. Verify the binary exists:
   ```bash
   ls node_modules/.bin/ai-guard
   ```
2. Check settings file:
   ```bash
   cat .claude/settings.json
   ```
3. Enable debug logging:
   ```bash
   AI_GUARD_DEBUG=1 npx ai-guard claude-hook --file src/test.ts
   ```

### Too many findings

The `agent` preset is already minimal. If you're still getting noise, check that your project doesn't have patterns that commonly trigger:
- Test fixture files with intentional anti-patterns
- Template/scaffold files with placeholder secrets

### Performance

Typical hook latency: **50-200ms** per file edit (syntax-only analysis).

The agent preset disables type-aware rules to maintain low latency. For comprehensive type-aware analysis, use `ai-guard run --strict` separately.

## Future: Resident Worker

> **Not yet implemented.** Documented here for architectural planning.

A future optimization could keep AI Guard resident in memory as a background worker, eliminating cold-start overhead (~200ms) on each hook invocation. The worker would:
- Pre-load the ESLint engine, plugin, and parser at startup
- Accept file paths via IPC or named pipe
- Return diagnostics within 5-10ms per file
- Auto-restart on crashes with exponential backoff

This is tracked as a future enhancement.
