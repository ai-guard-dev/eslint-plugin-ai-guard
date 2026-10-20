---
name: verify-changes
description: Verify JavaScript/TypeScript changes with AI Guard before calling work done — scan, understand each finding, fix the code, and rescan until the scan is complete and clean. Use after writing or editing JS/TS code, before committing, or when asked to check code for floating promises, empty catches, hardcoded secrets, SQL injection, or other AI-generated-code bugs.
argument-hint: "[file-or-directory] [preset]"
allowed-tools:
  - mcp__plugin_ai-guard_ai-guard__ai_guard_scan_diff
  - mcp__plugin_ai-guard_ai-guard__ai_guard_scan_file
  - mcp__plugin_ai-guard_ai-guard__ai_guard_scan_project
  - mcp__plugin_ai-guard_ai-guard__ai_guard_rules
---

# Verify changes with AI Guard

AI Guard is a deterministic, read-only analyzer. Its tools report findings; **you** make the fixes with your normal editing tools. Never claim code is clean unless a scan says so.

Arguments: `$ARGUMENTS` (optional path, optional preset).

## 1. Choose the scan

| Situation | Tool and arguments |
| --- | --- |
| Default: verify everything changed (staged, unstaged, untracked JS/TS) | `ai_guard_scan_diff` `{}` |
| Changes on a branch | `ai_guard_scan_diff` `{"base": "main"}` (use the exact local ref) |
| One file was given or just written | `ai_guard_scan_file` `{"path": "<file>"}` |
| A directory was given, or a baseline is needed | `ai_guard_scan_project` `{"path": "<dir>"}` |

If a path argument was given, scan that file or directory. Preset defaults to `agent` (high-confidence rules). Use `recommended`, `strict`, or `security` only when asked. Keep the same tool, scope, and preset for every rescan.

## 2. Read the result before the findings

| Result | Meaning | What to do |
| --- | --- | --- |
| `status: "complete"`, `clean: true` | Every selected file was analyzed; no findings | Report it as clean and stop |
| `status: "complete"`, `clean: false` | Analysis finished; `issues` lists findings | Fix them (step 3) |
| `status: "partial"` | Not a clean result. See `errors[].code`: `PARSE_ERROR`, `PARSER_UNAVAILABLE`, `INCOMPLETE_SCAN`, `ANALYSIS_ERROR`, or `RESULT_LIMIT` (more findings than returned; `totalIssues` has the real count) | Fix returned findings; report every non-`RESULT_LIMIT` error to the user |
| `status: "failed"` | The scan did not run (`OUTSIDE_WORKSPACE`, `FILE_EXCLUDED`, `GIT_FAILED`, `INVALID_GIT_REF`, `RESOURCE_LIMIT`, `SERVER_BUSY`, …) | Report `errors[].code` and `message`. Retry `SERVER_BUSY` once. Never treat it as clean |

If the AI Guard tools are not available (the MCP server failed to start or is disabled), say so plainly, point the user to `/mcp`, and do not state or imply the code was verified.

## 3. Fix each finding

For every issue: open `file` at `line`, read the surrounding code, and fix the root cause using its `remediation`. If the rule is unclear, call `ai_guard_rules` with `{"rules": ["<ruleId>"]}` for its description, fix, and docs link.

- Make the smallest correct change. Do not suppress findings with disable comments; inline directives are ignored by AI Guard's MCP scans anyway.
- If a finding is a genuine false positive, leave the code, and tell the user which finding and why.
- If a fix needs a product decision (for example, which auth middleware to add), ask instead of guessing.

## 4. Rescan

Rescan with the same arguments. Repeat steps 2–4 at most 3 times. If findings remain after that, stop and report them.

## 5. Report

End with one line: findings fixed, findings remaining, and the final `status`/`clean` values. Say "clean" only when the last scan returned `status: "complete"` and `clean: true`.
