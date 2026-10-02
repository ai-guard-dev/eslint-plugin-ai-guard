# AI Guard MCP Server

> Deterministic static-analysis guardrails available inside AI-agent workflows via the Model Context Protocol.

## What is this?

The AI Guard MCP Server exposes the existing AI Guard deterministic analysis engine to MCP-capable AI clients (Claude Code, Claude Desktop, and future MCP-compatible integrations).

It is a **thin adapter** — no duplicate analysis engine, no LLM calls, no cloud infrastructure.

```
                    ┌── CLI
                    │
AI Guard Rules ─────┼── GitHub Action
                    │
                    ├── Claude PostToolUse Hook
                    │
                    └── MCP Server ← NEW
                           │
                    MCP-capable clients
```

## Architecture

The MCP server uses **STDIO transport** and runs as a local process. It reuses:
- `runEslint()` — the existing AI Guard ESLint runner
- `getChangedFiles()` — the existing git diff detection
- Existing rule definitions, presets, and finding normalization

No new analysis engine is created.

## Installation

```bash
npm install eslint-plugin-ai-guard
```

## Running the MCP Server

```bash
npx ai-guard-mcp
```

Or directly:

```bash
node node_modules/.bin/ai-guard-mcp
```

## Client Configuration

### Claude Code

Add to `.claude/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "ai-guard": {
      "command": "npx",
      "args": ["ai-guard-mcp"],
      "env": {
        "AI_GUARD_WORKSPACE": "."
      }
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "ai-guard": {
      "command": "npx",
      "args": ["ai-guard-mcp"],
      "env": {
        "AI_GUARD_WORKSPACE": "/path/to/your/project"
      }
    }
  }
}
```

### Generic MCP Client

Any MCP-compatible client can connect via STDIO:

```bash
AI_GUARD_WORKSPACE=/path/to/project npx ai-guard-mcp
```

The server reads/writes JSON-RPC over stdin/stdout. Logs go to stderr.

## Available Tools

### `ai_guard_scan_file`

Scan a single JavaScript/TypeScript file.

**Input:**
```json
{
  "path": "src/api/users.ts",
  "preset": "agent"
}
```

**Presets:** `recommended`, `strict`, `security`, `agent` (default)

**Output:**
```json
{
  "success": true,
  "filesScanned": 1,
  "durationMs": 43,
  "issues": [
    {
      "ruleId": "ai-guard/no-floating-promise",
      "severity": "error",
      "confidence": "high",
      "file": "src/api/users.ts",
      "line": 42,
      "column": 5,
      "message": "Promise returned by fetch() is not awaited or caught",
      "category": "Async Reliability",
      "remediation": "Add `await` before the call, assign to a variable, or add `.catch()` to handle rejection.",
      "fixable": false
    }
  ],
  "totalErrors": 1,
  "totalWarnings": 0,
  "preset": "agent"
}
```

### `ai_guard_scan_diff`

Scan files changed in the current git working tree or against a base ref. Includes newly created untracked JS/TS files in the workspace automatically without requiring `git add`.

**When to use:**
- After modifying existing code or creating new files to verify all workspace changes.

**Input:**
```json
{
  "base": "HEAD~1",
  "preset": "agent",
  "staged": false
}
```

**Output:** Same structure as `scan_file`, plus:
```json
{
  "changedFiles": 3,
  "scanMode": "uncommitted",
  "base": "HEAD~1"
}
```

### `ai_guard_rules`

List available rules and presets.

**Input:**
```json
{
  "preset": "agent"
}
```

**Output:**
```json
{
  "success": true,
  "totalRules": 18,
  "presets": ["recommended", "strict", "security", "agent"],
  "rules": [
    {
      "ruleId": "ai-guard/no-hardcoded-secret",
      "category": "Security",
      "confidence": "high",
      "severity": {
        "recommended": "error",
        "strict": "error",
        "security": "error",
        "agent": "error"
      },
      "description": "Move credentials to environment variables",
      "remediation": "Move credentials to environment variables: `process.env.SECRET_KEY`."
    }
  ],
  "preset": "agent",
  "presetRules": [
    "ai-guard/no-hardcoded-secret",
    "ai-guard/no-eval-dynamic",
    "ai-guard/no-empty-catch",
    "ai-guard/no-sql-string-concat",
    "ai-guard/no-floating-promise"
  ]
}
```

## Security & Workspace Restrictions

1. **Workspace containment**: All paths resolve within the workspace root. Paths that escape via `../` traversal are rejected.
2. **Extension validation**: Only JS/TS file extensions are accepted (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`).
3. **Symlink resolution**: Paths are checked after symlink resolution to prevent workspace escapes.
4. **Git ref sanitization**: Git refs are validated against a safe character whitelist — shell injection is prevented.
5. **No shell execution**: Git operations use `execFileSync` with array arguments, not shell command strings.
6. **Protocol safety**: `stdout` is reserved for MCP protocol traffic. All logs go to `stderr`.

## Recommended Agent Workflows

### For a newly CREATED file:
Use `ai_guard_scan_file` to verify the single file immediately:
```
1. Agent creates new file        →  src/services/payment.ts
2. Agent calls ai_guard_scan_file →  { path: "src/services/payment.ts" }
3. AI Guard returns findings     →  hardcoded secret on line 12
4. Agent fixes the issue         →  uses process.env
5. Agent scans again             →  0 findings (clean)
```

### For MODIFIED / CREATED Git workspace changes:
Use `ai_guard_scan_diff` to verify all uncommitted changes across the workspace (automatically includes newly created untracked JS/TS files):
```
1. Agent edits multiple files or creates new files  →  working tree has changes
2. Agent calls ai_guard_scan_diff                   →  { preset: "agent" }
3. AI Guard detects modified + untracked files      →  returns structured findings
4. Agent applies targeted fixes
5. Agent calls ai_guard_scan_diff again             →  clean: true, ready to commit
```

## Relationship to Existing Integrations

The MCP server is **complementary** to the existing Claude PostToolUse hook.

- **PostToolUse hook**: Automatic, runs after every file edit. Best for real-time guardrails.
- **MCP server**: On-demand, agent-initiated. Best for explicit scan-before-commit workflows.

Both continue to work independently. No migration required.
