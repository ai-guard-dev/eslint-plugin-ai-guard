# AI Guard MCP server

AI Guard exposes its existing ESLint runner through a local STDIO MCP server. It does not edit files, execute agent-supplied commands, or send telemetry.

This page describes the current source checkout, including changes not yet published to npm. Build this checkout to test the behavior below; installing an older published version does not provide the new project tool or status contract.

## Setup

For this checkout:

```sh
npm ci
npm run build
node dist/mcp/server.js
```

The process waits for MCP messages on stdin. stdout contains protocol messages only; diagnostics go to stderr. Set `AI_GUARD_WORKSPACE` to an **absolute existing directory**. If omitted, the process working directory is used.

For an installed package, install ESLint and the optional TypeScript parser alongside AI Guard:

```sh
npm install --save-dev eslint-plugin-ai-guard eslint@^9 @typescript-eslint/parser@^8
node node_modules/eslint-plugin-ai-guard/dist/mcp/server.js
```

The executable belongs to the `eslint-plugin-ai-guard` package. When explicitly selecting a published package through npm, the command is `npx --yes --package eslint-plugin-ai-guard ai-guard-mcp`. That command uses the published version, not this checkout. Prefer the direct Node entrypoint for client setup, especially on Windows, where npm command shims need special handling.

### Client configuration templates

**Verified locally:** MCP SDK Client with linked in-memory transport and a real STDIO child process running the built entrypoint, including discovery, scans, errors, and shutdown. The test host was Windows with Node 22 and ESLint 9.

**Verified with Claude Code CLI 2.1.304 (headless, `-p --mcp-config`, packed tarball install):** connection, discovery of all four tools and the `verify_changes` prompt, JSON parsing of every response, `complete`/`partial`/`failed` statuses, `RESULT_LIMIT` truncation, rule lookup, and `isError` on failures. On success Claude Code passes `structuredContent` to the model; on errors it passes the (identical) JSON text.

**Not verified:** the interactive Claude Code UI, a committed `.mcp.json`, Claude Desktop, and other agent UIs. Their templates below follow documented configuration formats; they are not claims of end-to-end client certification.

For Claude Code, put this in the project-root `.mcp.json` (see [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)):

```json
{
  "mcpServers": {
    "ai-guard": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ai-guard/dist/mcp/server.js"],
      "env": {
        "AI_GUARD_WORKSPACE": "/absolute/path/to/project"
      }
    }
  }
}
```

For Claude Desktop, open Settings → Developer → Edit Config and use the following `mcpServers` entry (see the [official local-server setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers)):

```json
{
  "mcpServers": {
    "ai-guard": {
      "command": "node",
      "args": ["/absolute/path/to/ai-guard/dist/mcp/server.js"],
      "env": {
        "AI_GUARD_WORKSPACE": "/absolute/path/to/project"
      }
    }
  }
}
```

Replace both paths. For an npm installation, the server path ends in `node_modules/eslint-plugin-ai-guard/dist/mcp/server.js`. On Windows, JSON paths such as `C:/work/project` work without backslash escaping. If the client cannot find Node, use the absolute path to `node.exe` or `node`. Do not launch the platform-dependent `node_modules/.bin` shim with Node.

Restart/reconnect the client and confirm that `tools/list` discovers all four tools. The automated equivalent is:

```sh
npm run build
npm exec vitest run tests/cli/mcp-server.test.ts tests/cli/mcp-protocol.test.ts tests/cli/mcp-reliability.test.ts
```

## Choosing a tool

All scan tools accept `preset`: `agent` (default), `recommended`, `strict`, or `security`, and `maxIssues` (1–1000, default 50).

| Tool | Use | Example arguments |
| --- | --- | --- |
| `ai_guard_scan_file` | Immediately after creating/editing one JS/TS file | `{"path":"src/api.ts","preset":"agent"}` |
| `ai_guard_scan_diff` | Verify all relevant Git changes before completing a task | `{"preset":"agent"}` |
| `ai_guard_scan_project` | Establish a baseline of findings or check a bounded directory, including outside Git | `{"path":"src","preset":"security","maxFiles":200}` |
| `ai_guard_rules` | Inspect available rules, severities, and remediation | `{"preset":"agent"}` |
| `ai_guard_rules` | Look up the rule behind a finding (description, remediation, docs link) | `{"rules":["no-floating-promise"]}` |

`ai_guard_rules` returns the rule catalog; selecting a preset additionally returns its enabled `presetRules` IDs. With `rules` (1–25 IDs, `ai-guard/` prefix optional) it returns only those rules, each with `docsUrl`; unknown IDs are listed in `unknownRules` and the call fails.

### Diff semantics

Without a base, scan staged and unstaged changed paths plus untracked supported files. With `{"staged":true}`, select only staged paths. **All modes analyze current on-disk contents**, not the index or historical blobs. Deleted paths are not analysis targets; a selected path that disappears before scanning produces an error.

With `{"base":"HEAD~1"}`, compare the merge base of that exact locally available ref and HEAD against the working tree, including untracked files. Fetch the intended remote ref first if needed, and pass `origin/main` explicitly to select it. There is no network fetch, fallback to HEAD~1, or implicit `GITHUB_BASE_REF`. Invalid/missing refs and Git failures are errors. `base` and `staged:true` cannot be combined.

Git output is NUL-delimited to preserve whitespace and Unicode filenames. A workspace inside a repository selects only paths within that workspace.

### Project semantics and limits

`path` defaults to `.` and must resolve to a workspace directory. Project discovery reuses the runner's default exclusion list: dependency, build, generated, cache, and coverage directories are excluded, including nested matches.

Limits apply before analysis: at most 500 files (lower with `maxFiles`), 1 MiB per file, 20 MiB total source, 20,000 visited directory entries, and 64 directory levels. Discovery stops with `RESOURCE_LIMIT` rather than returning a successful subset. Empty eligible directories return a complete scan of zero files.

Project traversal refuses encountered symlinks with `SYMLINK_IN_PROJECT` rather than silently omitting linked source or following cycles. Narrow the directory or scan a linked file individually; file scans validate its canonical target. One tool call runs at a time per server; overlapping calls receive `SERVER_BUSY` and can be retried. At most `maxIssues` findings are returned (default 50, max 1,000), errors first. When more exist, `truncated:true`, `totalIssues` keeps the full count, and the result is `partial` with `RESULT_LIMIT`.

These are input/output bounds, not a hard wall-clock or process-memory sandbox. Git commands have a 15-second timeout and a 1 MiB output cap per invocation.

## Results and errors

Every tool declares an MCP `outputSchema` and returns the same object in `structuredContent` and, as compact JSON, in a single text content block (`JSON.parse(content[0].text)` equals `structuredContent`):

```json
{
  "success": true,
  "status": "complete",
  "clean": true,
  "errors": [],
  "filesScanned": 1,
  "durationMs": 25,
  "issues": [],
  "totalIssues": 0,
  "truncated": false,
  "totalErrors": 0,
  "totalWarnings": 0,
  "preset": "agent"
}
```

This example is a clean scan. Findings in `issues` contain rule ID, severity, file, line/column, message, confidence/category/remediation where available, and `fixable:false` because MCP offers no automatic fix operation. Paths are workspace-relative with forward slashes. Diff results additionally include `changedFiles`, `scanMode`, and optional `base`.

- `success:true` means analysis completed; findings can still exist.
- `status:"complete", clean:true` means no findings or scan errors in the selected scope.
- `status:"partial"` preserves findings but indicates parsing, parser availability, analysis, result truncation, or coverage problems.
- `status:"failed"` means selection/validation/analysis could not complete.
- Partial and failed results always have `clean:false` and nonempty `errors`. They have `success:false` and MCP `isError:true`, except a result whose only error is `RESULT_LIMIT`: analysis completed, so `success` stays `true` and the agent can keep fixing the returned findings.
- Schema-invalid arguments are rejected by the MCP SDK with its native validation error result, before scanning.

Each scan error has `code`, `message`, and optional `file`/`line`. Codes include `INVALID_PATH`, `OUTSIDE_WORKSPACE`, `PATH_NOT_FOUND`, `PATH_UNREADABLE`, `UNSUPPORTED_FILE`, `NOT_A_FILE`, `NOT_A_DIRECTORY`, `FILE_EXCLUDED`, `INVALID_INPUT`, `INVALID_PRESET`, `INVALID_GIT_REF`, `GIT_FAILED`, `PARSE_ERROR`, `PARSER_UNAVAILABLE`, `ANALYSIS_ERROR`, `INCOMPLETE_SCAN`, `SCAN_FAILED`, `RESOURCE_LIMIT`, `RESULT_LIMIT`, `SYMLINK_IN_PROJECT`, `SERVER_BUSY`, and `INTERNAL_ERROR`.

`filesScanned` counts analyzed files, including files with parser errors; files skipped by the runner's ignore patterns are not counted (and raise `INCOMPLETE_SCAN`). It is not proof of complete analysis: always check `status` and `errors`.

## Recommended scan → fix → rescan workflow

1. Call `ai_guard_rules` if you need to select a preset.
2. Scan the edited file, Git changes, or relevant project directory.
3. Resolve scan errors first. An empty findings array on a failed/partial response is not a clean result.
4. Review findings and apply targeted fixes with the agent's normal editor.
5. Rescan the same scope and preset. Report completion only when `status:"complete"` and `clean:true`; explain any intentionally unresolved findings.

The server also ships this loop as the MCP prompt `verify_changes` (optional `path` and `preset` arguments). In Claude Code it appears as `/mcp__ai-guard__verify_changes`.

MCP uses bundled rules and the installed parser, not plugin modules or ESLint configuration from the scanned workspace. Inline ESLint directives are disabled for MCP scans. CLI baseline files, custom ignore files, and user ESLint configuration are not applied; this is a preset scan, not an exact reproduction of a customized CLI or editor run. No type-aware TypeScript project is constructed.

Containment checks compare canonical paths and fail closed on resolution errors. They are not an OS sandbox: concurrent filesystem mutation between validation and ESLint reads remains a limitation. Run on trusted local workspaces and dependencies. The existing post-edit hook remains independent of on-demand MCP scans.
