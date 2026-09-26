# Future: Resident Type-Aware Worker

> **Status: NOT IMPLEMENTED — Architecture documentation only.**
>
> This document describes a possible future optimization for the Claude Code
> integration. Do NOT implement this until the basic PostToolUse hook has been
> validated in production.

## Problem

The current `ai-guard claude-hook` command cold-starts a new Node.js process on
every PostToolUse event. This adds ~200ms of overhead per file edit (module
loading, ESLint initialization, plugin resolution, parser startup).

For most workflows this is acceptable (total latency ~50-200ms), but in rapid
editing sessions where Claude Code makes many consecutive edits, the cumulative
latency adds up.

## Proposed Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Claude Code                        │
│                                                      │
│  PostToolUse hook fires ──► ai-guard claude-hook     │
│                                    │                 │
│                            ┌───────▼────────┐        │
│                            │ Named Pipe /   │        │
│                            │ Unix Socket    │        │
│                            └───────┬────────┘        │
│                                    │                 │
│                            ┌───────▼────────┐        │
│                            │  AI Guard      │        │
│                            │  Worker        │        │
│                            │  (resident)    │        │
│                            │                │        │
│                            │  Pre-loaded:   │        │
│                            │  - ESLint      │        │
│                            │  - Plugin      │        │
│                            │  - TS Parser   │        │
│                            └───────┬────────┘        │
│                                    │                 │
│                            Diagnostics → stdout      │
└─────────────────────────────────────────────────────┘
```

### Worker Lifecycle

1. **First invocation:** `claude-hook` detects no running worker → starts one
   as a background daemon via `child_process.fork()` or `spawn({ detached: true })`
2. **Worker startup:** Pre-loads ESLint engine, AI Guard plugin, TypeScript parser.
   Writes PID file to `.claude/.ai-guard-worker.pid`
3. **Subsequent invocations:** `claude-hook` connects to the worker via named pipe,
   sends the file path, receives diagnostics. Total latency: **~5-10ms**
4. **Idle timeout:** Worker auto-exits after 5 minutes of inactivity
5. **Crash recovery:** Worker writes crash log. Next invocation falls back to
   cold-start mode and restarts the worker

### Protocol

```jsonc
// Request (claude-hook → worker)
{ "type": "scan", "file": "/abs/path/to/file.ts" }

// Response (worker → claude-hook)
{
  "type": "result",
  "issues": [
    {
      "ruleId": "ai-guard/no-empty-catch",
      "file": "src/api.ts",
      "line": 42,
      "column": 7,
      "message": "Empty catch block",
      "remediation": "Add error handling...",
      "confidence": "high"
    }
  ]
}
```

### Implementation Constraints

- **No npm dependencies** beyond what AI Guard already uses
- **No HTTP servers** — use named pipes (Windows) or Unix domain sockets (macOS/Linux)
- **Graceful fallback** — if worker is unavailable, fall back to cold-start
- **No global state mutation** — worker must be safe for concurrent requests
- **PID file cleanup** on normal exit and on crash (signal handlers)

### Performance Target

| Metric | Cold Start | Warm Worker |
|--------|-----------|-------------|
| Startup | ~200ms | 0ms |
| Analysis | ~50ms | ~5-10ms |
| Total | ~250ms | ~5-10ms |
| Memory | ~50MB transient | ~80MB resident |

### Risks

1. **Zombie processes** — Worker may not exit cleanly on crash
2. **File handle leaks** — Named pipe must be cleaned up
3. **Stale cache** — Worker may use outdated plugin rules if package is updated
4. **Platform differences** — Named pipes work differently on Windows vs Unix

### Decision Criteria

Implement this when:
- User feedback indicates latency is a problem in rapid editing sessions
- Benchmark data shows cold-start overhead exceeds 300ms
- Claude Code supports long-running worker hooks natively
