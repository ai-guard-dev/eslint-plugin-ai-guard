/**
 * AI Guard MCP Server — STDIO transport.
 *
 * Exposes the existing AI Guard deterministic analysis engine to MCP-capable
 * AI clients (Claude Code, Claude Desktop, etc.) via three tools:
 *
 *   - ai_guard_scan_file  — scan a single JS/TS file
 *   - ai_guard_scan_diff  — scan changed files (git diff)
 *   - ai_guard_rules      — list available rules and presets
 *
 * Architecture: thin adapter over existing runEslint() and getChangedFiles().
 * No duplicate analysis engine.
 *
 * STDOUT is reserved for MCP protocol traffic.
 * All diagnostics go to STDERR.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { setWorkspaceRoot } from './utils/workspace.js';
import { scanFile } from './tools/scan-file.js';
import { scanDiff } from './tools/scan-diff.js';
import { getRules } from './tools/rules.js';

// ─── Workspace root ──────────────────────────────────────────────────────────

const workspaceRoot = process.env.AI_GUARD_WORKSPACE ?? process.cwd();
setWorkspaceRoot(workspaceRoot);
// Ensure process.cwd() matches workspace — runEslint uses cwd to locate the plugin
process.chdir(workspaceRoot);

// ─── Logging (stderr only — stdout is MCP protocol) ──────────────────────────

function log(msg: string): void {
  process.stderr.write(`[ai-guard-mcp] ${msg}\n`);
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer(
  {
    name: 'ai-guard',
    version: '1.4.0',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      'Use AI Guard to verify JavaScript/TypeScript changes before considering implementation complete. Prefer ai_guard_scan_diff after edits and ai_guard_scan_file for a specific file.',
  },
);

// ─── Tool: ai_guard_scan_file ─────────────────────────────────────────────────

server.tool(
  'ai_guard_scan_file',
  'Scan a single JavaScript/TypeScript file with AI Guard deterministic static analysis. Use for one specific file, such as immediately after creating a new file. Does not scan the repository.',
  {
    path: z.string().describe('Relative or absolute path to the JS/TS file to scan'),
    preset: z.enum(['recommended', 'strict', 'security', 'agent']).default('agent')
      .describe('Rule preset to use. Defaults to "agent" (high-confidence rules only)'),
  },
  async (args) => {
    try {
      const result = await scanFile({ path: args.path, preset: args.preset });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`scan_file error: ${message}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: message,
              filesScanned: 0,
              durationMs: 0,
              issues: [],
              totalErrors: 0,
              totalWarnings: 0,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Tool: ai_guard_scan_diff ─────────────────────────────────────────────────

server.tool(
  'ai_guard_scan_diff',
  'Scan current relevant Git changes (including newly created untracked JS/TS files) with AI Guard. Use after modifying code to verify changes before completing tasks.',
  {
    base: z.string().optional()
      .describe('Git ref to diff against (e.g., "HEAD~1", "main"). Defaults to uncommitted changes'),
    preset: z.enum(['recommended', 'strict', 'security', 'agent']).default('agent')
      .describe('Rule preset to use. Defaults to "agent" (high-confidence rules only)'),
    staged: z.boolean().optional().default(false)
      .describe('If true, scan only staged files'),
  },
  async (args) => {
    try {
      const result = await scanDiff({
        base: args.base,
        preset: args.preset,
        staged: args.staged,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`scan_diff error: ${message}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: message,
              filesScanned: 0,
              durationMs: 0,
              issues: [],
              totalErrors: 0,
              totalWarnings: 0,
              changedFiles: 0,
              scanMode: 'error',
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Tool: ai_guard_rules ─────────────────────────────────────────────────────

server.tool(
  'ai_guard_rules',
  'List available AI Guard rules and presets. Use to inspect available rules, categories, and severities.',
  {
    preset: z.enum(['recommended', 'strict', 'security', 'agent']).optional()
      .describe('Optional: filter to show rules in a specific preset'),
  },
  (args) => {
    try {
      const result = getRules({ preset: args.preset });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`rules error: ${message}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: message,
              totalRules: 0,
              presets: [],
              rules: [],
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Server started (workspace: ${workspaceRoot})`);
}

main().catch((err: unknown) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
