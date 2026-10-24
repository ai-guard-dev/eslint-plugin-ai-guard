---
title: Claude Code Integration
description: Configure AI Guard hooks in Claude Code — edit feedback, a final check-integrity gate, and a Git-hook bypass guard
---

# Claude Code Integration

AI Guard integrates with [Claude Code](https://code.claude.com/docs/en/hooks) through hooks:

| Event | What AI Guard does |
|---|---|
| **PostToolUse** (`Edit\|MultiEdit\|Write`) | Lints the edited JS/TS file and checks that file for newly weakened checks. Findings are sent back to Claude. |
| **SessionStart** | Records the working tree as the session's [check-integrity](../integrity.md) base. |
| **Stop** | Before Claude finishes, runs check integrity on everything changed since the session started. High-confidence weakenings block stopping **once**. |
| **PreToolUse** (`Bash`) | Asks for confirmation before commands that skip Git hooks (`git commit --no-verify`, `HUSKY=0 git …`). |

## Quick Setup

```bash
# Install AI Guard as a dev dependency
npm install --save-dev eslint-plugin-ai-guard

# Configure the Claude Code hooks
npx ai-guard init-claude
```

## How feedback reaches Claude

Claude Code only shows a hook's output to Claude when the hook uses the documented protocol. Plain text written to stdout by a hook that exits 0 goes to the debug log, and Claude never sees it. **AI Guard 1.4.2 and earlier printed findings this way, so they did not reach Claude.** Since 1.4.3 the hook always exits 0 and prints one JSON object:

**PostToolUse** — findings in the edited file:

```json
{
  "decision": "block",
  "reason": "AI Guard found 1 issue in the edited file:\n- src/api.ts:42:7 [ai-guard/no-empty-catch] Empty catch block …\n  Fix: Add error handling in the catch block, or at minimum log the error.",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "AI Guard advisory (needs judgment, does not block): …"
  }
}
```

The edit has already happened when PostToolUse runs, so `"decision": "block"` does not undo it. It places the `reason` next to the tool result so Claude fixes the code in its next step. Lint findings and high-confidence weakenings use `reason`. Advisory signals use `additionalContext` only and are shown once per session.

**Stop** — the final gate:

```json
{
  "decision": "block",
  "reason": "Before finishing: your changes weaken checks the project relies on (compared with the working tree at session start).\n- src/cart.test.ts:14 [integrity-test-skipped] Skipped the existing test \"cart > applies the discount\"; it no longer runs.\n  Fix: Remove `.skip`/`x` and fix the code or the test …"
}
```

To avoid trapping Claude in a loop:

- Each unique set of high-confidence findings blocks **once per session**. If the same findings are still present at the next Stop, AI Guard lets Claude stop and shows the user a `systemMessage` instead. A new finding blocks again.
- Without a `session_id`, AI Guard never blocks when `stop_hook_active` is true.
- Advisory findings never block. They are shown to the user once as a `systemMessage`.
- Claude Code also caps consecutive Stop-hook continuations (8 by default).

If the analysis cannot run (for example, the recorded base no longer exists), the user sees a `systemMessage` saying so. AI Guard never reports a clean result it did not compute. Outside a Git repository, only lint feedback is given.

**PreToolUse (Bash)**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "AI Guard: this command bypasses Git hooks (`--no-verify` skips Git hooks). Run the hooks and fix what they report instead."
  }
}
```

## Session base

At **SessionStart**, AI Guard snapshots the working tree (tracked and untracked files, honouring `.gitignore`) as a Git tree object. It writes through a temporary index file, so your index, stash and files are not modified. Changes you made before the session are therefore not attributed to Claude. If the SessionStart hook is not registered, the first hook event records `HEAD` instead.

Session state (base, finding sets that already blocked, advisories already shown) is stored under `<os tmpdir>/ai-guard/claude-sessions/`, keyed by a hash of the session ID and repository. Set `AI_GUARD_STATE_DIR` to change the location.

Use `--base <ref>` on the hook command to compare with a branch instead (for example `node_modules/.bin/ai-guard claude-hook --base main`).

## Accepting an intended weakening

If a weakening is intended (for example, a test is quarantined while an upstream bug is fixed), the user accepts it explicitly:

```bash
npx ai-guard integrity --accept <fingerprint>   # the #… value shown in the finding
```

A bare `--accept` accepts nothing; `--accept all` must be spelled out. When Claude tries to run `--accept` itself, the PreToolUse guard asks you first, and acceptances Claude writes into the baseline file with an edit tool block the Stop gate. This writes the finding's fingerprint to `.ai-guard-baseline.json`. Accepted findings no longer block, and the acceptance is visible in review. `--accept` is refused in CI.

## What gets checked on each edit

The `agent` preset (high-precision lint rules):

| Rule | Category | Confidence |
|------|----------|------------|
| `no-hardcoded-secret` | Security | High |
| `no-eval-dynamic` | Security | High |
| `no-empty-catch` | Reliability | High |
| `no-sql-string-concat` | Security | Medium |
| `no-floating-promise` | Async | High |

Inline directives use the `require-reason` policy in the hook. `// eslint-disable-next-line ai-guard/no-empty-catch -- <reason>` hides a finding, but a directive without a reason does not, and Claude is told why.

The per-edit integrity check covers the edited file: new suppressions, skipped or focused tests, removed tests (advisory per file, because moves to other files can only be judged at Stop), and downgraded settings when the edited file is a config file (`tsconfig.json`, ESLint/Jest/Vitest config, `package.json`, a workflow, a husky hook).

## Commands

### `ai-guard init-claude`

```bash
npx ai-guard init-claude                  # all hooks
npx ai-guard init-claude --dry-run        # preview
npx ai-guard init-claude --local          # .claude/settings.local.json
npx ai-guard init-claude --no-stop-hook   # skip SessionStart + Stop
npx ai-guard init-claude --no-bash-guard  # skip the PreToolUse Bash guard
```

- Preserves existing settings and hooks, and is idempotent.
- An existing AI Guard hook under any matcher (including the legacy `Edit|Write` matcher) is kept. Running `init-claude` again on an older setup only adds the missing events.

**Generated configuration:**

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|MultiEdit|Write", "hooks": [{ "type": "command", "command": "node_modules/.bin/ai-guard claude-hook" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node_modules/.bin/ai-guard claude-hook" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node_modules/.bin/ai-guard claude-hook" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node_modules/.bin/ai-guard claude-hook" }] }
    ]
  }
}
```

### `ai-guard claude-hook`

> Internal command — invoked by Claude Code with the hook JSON on stdin.

| Option | Description |
|---|---|
| `--base <ref>` | Compare check integrity with `merge-base(HEAD, ref)` instead of the session start |
| `--bash-guard <ask\|deny\|off>` | Behaviour for commands that skip Git hooks (default `ask`) |
| `--file <path>` | Debug: lint one file and print findings as text |

- Always exits 0. Invalid or empty input and unsupported events produce no output.
- Debug logging goes to stderr with `AI_GUARD_DEBUG=1`.

## Verification status

The JSON output for every event is covered by automated protocol tests, including the built CLI over stdin/stdout. Behaviour inside a live Claude Code session (how the transcript displays `reason`, `additionalContext` and `systemMessage`, and the continuation cap) follows the [hooks reference](https://code.claude.com/docs/en/hooks) but is not exercised by the test suite. Verify it manually after upgrading:

1. Run `npx ai-guard init-claude`, start a session, and ask Claude to add an empty `catch {}`. Claude should receive the finding and fix it.
2. Ask Claude to make a failing test pass by adding `.skip`. When it tries to finish, the Stop hook should block once with the skip finding.
3. Ask Claude to commit with `--no-verify`. You should be asked to confirm.

## Removing the Hooks

Delete the AI Guard entries (`node_modules/.bin/ai-guard claude-hook`) from `.claude/settings.json`.

## Troubleshooting

### Hook not running

1. Verify the binary exists: `ls node_modules/.bin/ai-guard`
2. Check the settings file: `cat .claude/settings.json`
3. Run the hook manually: `echo '{"hook_event_name":"Stop","session_id":"t","cwd":"'"$PWD"'"}' | npx ai-guard claude-hook`
4. Enable debug logging: `AI_GUARD_DEBUG=1`

### Performance

Measured end-to-end (process start to exit) in a small repository on Windows 11 with Node 22: PostToolUse took about 2.1 s, of which lint alone (`--file`) was about 1.5 s, mostly Node/ESLint/parser startup. The integrity check of the edited file adds about 0.6 s. Stop took about 1.2 s. The Stop check reads only the files changed since the session base, so its cost grows with the size of the change, not the repository.

A resident worker that removes the per-invocation startup cost is planned; see [claude-code-worker-future.md](claude-code-worker-future.md).
