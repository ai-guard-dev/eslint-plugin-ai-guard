# Cursor, Codex and Claude Code hooks

AI Guard plugs into the agent's own loop, so problems are caught while the agent works instead of in review. One command sets it up for every agent a project uses:

```bash
npm install --save-dev eslint-plugin-ai-guard
npx ai-guard init-hooks                    # agents detected from .claude/, .cursor/, .codex/
npx ai-guard init-hooks --agent cursor,codex
npx ai-guard init-hooks --agent all --check-installs
```

| Option | Description |
|---|---|
| `--agent <list>` | `claude`, `cursor`, `codex`, or `all`. Default: the agents whose folder exists |
| `--check-installs` | Also check npm packages before install commands run (uses the npm registry). See [verify-deps](../cli/verify-deps.md) |
| `--no-stop-hook` | Skip the session-start snapshot and the finish gate |
| `--no-bash-guard` | Skip the guard on `git commit --no-verify` and `HUSKY=0` |
| `--dry-run` | Show what would change |

Existing hooks are kept, and running the command again changes nothing. `init-claude` still works and is the same as `--agent claude`.

## What each agent gets

The same engine runs for every agent. What it can do depends on what each agent's hook system allows:

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Lint and weakened checks fed back after each edit | Yes | Yes (`apply_patch`) | At the finish gate instead¹ |
| Finish gate: weakened checks and problems the session introduced, raised once | Yes | Yes | Yes (follow-up message) |
| Session-start snapshot, so earlier work is not blamed on the agent | Yes | Yes | Yes |
| Guard on `git commit --no-verify` and `HUSKY=0` | Asks you | Denied; the agent is told to ask you² | Asks you |
| Package check before installs (opt-in) | Deny or ask | Deny² | Deny or ask |

¹ Cursor's `afterFileEdit` hook cannot send anything back to the agent, so edit findings arrive when the agent finishes. The finish gate covers everything the session introduced.<br>
² Codex hooks cannot ask the user, so a command that needs your confirmation is denied with a message telling the agent to ask you first.

## Configuration it writes

**Cursor** (`.cursor/hooks.json`):

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "node node_modules/eslint-plugin-ai-guard/dist/cli/hook.js --agent cursor", "timeout": 30 }],
    "stop": [{ "command": "node node_modules/eslint-plugin-ai-guard/dist/cli/hook.js --agent cursor", "timeout": 120 }],
    "beforeShellExecution": [{
      "command": "node node_modules/eslint-plugin-ai-guard/dist/cli/hook.js --agent cursor",
      "matcher": "\\b(?:npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack|git|ai-guard)\\b|HUSKY\\s*=",
      "timeout": 30
    }]
  }
}
```

The matcher means Cursor does not start the hook for commands it does not need to see. When the hook has nothing to say it prints nothing, which lets the command run under your normal approval settings. It never answers `allow`.

**Codex** (`.codex/hooks.json`): `SessionStart`, `PreToolUse` (matcher `Bash`), `PostToolUse` (matcher `apply_patch|Edit|Write`) and `Stop`, each running `node node_modules/eslint-plugin-ai-guard/dist/cli/hook.js --agent codex`.

- **Trust the hooks once.** Codex runs new project hooks only after you review them: start Codex and run `/hooks`.
- **Start Codex from the project root**, where `node_modules` is. The hook command is relative to the folder Codex runs in.

**Claude Code** (`.claude/settings.json`): see [Claude Code integration](claude-code.md).

## Speed

Agents call hooks often; Codex calls `PreToolUse` before every shell command. The hook entry point (`ai-guard-hook`, `dist/cli/hook.js`) reads the payload first and exits in about 0.15 s when a command names no package manager, Git or AI Guard. Only then does it load the engine (about 0.9 s).

## Check it works

1. In Cursor or Codex, ask the agent to run `git commit --no-verify -m test`. Cursor should ask you; Codex should refuse and tell the agent to ask you.
2. Ask it to add a function whose body is `// TODO: implement` and `return true`, then finish. The agent should get one message about the placeholder and fix it.
3. With `--check-installs`, ask it to run `npm install ai-guard-demo-no-such-package`. A name that does not exist on npm is refused before it runs. (A look-alike that does exist, such as `expresss`, is only flagged when it is new or rarely downloaded; older ones get a warning passed to the agent.)
4. Debug output: `AI_GUARD_DEBUG=1` prints hook errors to stderr.
