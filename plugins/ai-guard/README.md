# AI Guard for Claude Code

![AI Guard](icon.png)

AI Guard adds deterministic static analysis for JavaScript and TypeScript to Claude Code. It catches bugs that AI-generated code often contains: floating promises, async callbacks passed to array methods, empty catch blocks, hardcoded secrets, SQL built by string concatenation, dynamic `eval`, unsafe deserialization, and missing auth middleware. Claude scans your changes, fixes each finding with its normal editing tools, and rescans until the scan is complete and clean.

The analysis runs on your machine using the open-source [`eslint-plugin-ai-guard`](https://github.com/ai-guard-dev/eslint-plugin-ai-guard) engine (MIT). AI Guard's tools only read code and report findings; they never modify files.

## What's included

- **MCP server** `ai-guard`: the `ai-guard-mcp` server from `eslint-plugin-ai-guard@1.4.2`, started over local STDIO for the current project.
- **Skill** `/ai-guard:verify-changes [file-or-directory] [preset]`: the scan → fix → rescan workflow. Claude can also invoke it on its own after editing JS/TS code.

| Tool | Use |
| --- | --- |
| `ai_guard_scan_diff` | Scan changed files: staged, unstaged and untracked JS/TS, or changes since a `base` ref |
| `ai_guard_scan_file` | Scan one file |
| `ai_guard_scan_project` | Scan a directory (up to 500 files) |
| `ai_guard_rules` | List rules and presets, or look up a rule's description, fix and docs link |

Presets: `agent` (default, 5 high-confidence rules), `recommended`, `strict`, `security`.

## Requirements

- Claude Code with plugin support
- Node.js 20 or later, with `npx` on your `PATH`
- Git, for `ai_guard_scan_diff`
- Network access to the npm registry the first time the server starts

You don't need ESLint or AI Guard installed in your project. Your project's ESLint configuration is not used.

## Install

Load the plugin from a clone of the repository for one session:

```bash
git clone https://github.com/ai-guard-dev/eslint-plugin-ai-guard.git
claude --plugin-dir ./eslint-plugin-ai-guard/plugins/ai-guard
```

On first use, `npx` downloads about 110 packages (~45 MB). That usually takes 15–25 seconds but can exceed Claude Code's default 30-second MCP startup timeout on a slow connection or a slow disk. To avoid a failed first start, download them once beforehand:

```bash
npx --yes --package=eslint-plugin-ai-guard@1.4.2 --package=eslint@9.39.5 --package=@typescript-eslint/parser@8.72.0 ai-guard --version
```

or raise the startup timeout for that session, for example `MCP_TIMEOUT=120000 claude --plugin-dir …`.

Run `/mcp` and check that `plugin:ai-guard:ai-guard` shows as connected.

## Usage

Ask Claude to "check my changes with AI Guard", or run:

```text
/ai-guard:verify-changes
/ai-guard:verify-changes src/api/users.ts
/ai-guard:verify-changes src security
```

Only a result with `status: "complete"` and `clean: true` counts as clean. A `partial` result (parse error, missing parser, more findings than returned) or a `failed` result (path outside the project, excluded file, Git error) is never reported as clean. If the AI Guard tools are unavailable, Claude says so instead of claiming the code was checked.

## What it runs and accesses

- **Downloads:** on first start, `npx` fetches `eslint-plugin-ai-guard@1.4.2`, `eslint@9.39.5`, `@typescript-eslint/parser@8.72.0` and their dependencies from your configured npm registry into the npm cache.
- **Runs:** a local Node.js process (`ai-guard-mcp`) that talks to Claude Code over STDIO. It runs read-only `git` commands (`rev-parse`, `diff`, `merge-base`, `ls-files`) for diff scans.
- **Reads:** JS/TS files inside the project directory (`AI_GUARD_WORKSPACE` is set to `${CLAUDE_PROJECT_DIR}`). Paths outside it, including through symlinks, are rejected.
- **Doesn't:** the AI Guard server makes no network requests, sends no telemetry, writes or modifies no files, loads no ESLint plugins or configuration from your project, and ignores inline `eslint-disable` comments.

Findings are returned to Claude Code like any other tool result, so they are part of your conversation with Claude.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/mcp` shows the server failed or timed out on first use | The first download exceeded the startup timeout. Run the `npx … --version` command above, or start Claude Code with `MCP_TIMEOUT=120000`. After a failure, Claude Code waits about 15 minutes before retrying the server on its own; reconnect it from `/mcp` once the download has finished |
| `npx: command not found` | Install Node.js 20+ and restart your terminal so `npx` is on `PATH` |
| `PARSE_ERROR` | The file has a syntax error AI Guard can't parse; fix it and rescan |
| `FILE_EXCLUDED` | The file is in an excluded directory such as `node_modules/`, `dist/`, `build/`, `generated/` or `vendor/` |
| `OUTSIDE_WORKSPACE` | Use a path inside the project Claude Code was started in |
| `GIT_FAILED` or `INVALID_GIT_REF` | Run inside a Git repository and pass an existing local ref, such as `main` or `origin/main` |
| `SERVER_BUSY` | One scan runs at a time; retry when the current scan finishes |

More: [MCP server documentation](https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/mcp-server.md) · [rule reference](https://github.com/ai-guard-dev/eslint-plugin-ai-guard/tree/main/docs/rules) · [issues](https://github.com/ai-guard-dev/eslint-plugin-ai-guard/issues) · [getaiguard.dev](https://getaiguard.dev/)

## License

MIT. See [LICENSE](LICENSE).
