import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canonicalWorkspace } from './utils/workspace.js';
import { scanFile } from './tools/scan-file.js';
import { scanDiff } from './tools/scan-diff.js';
import { scanProject } from './tools/scan-project.js';
import { getRules } from './tools/rules.js';
import { failure } from './utils/scan.js';

export function createMcpServer(root: string): McpServer {
  const workspace = canonicalWorkspace(root);
  const server = new McpServer({ name: 'ai-guard', version: '1.4.0' }, {
    instructions: 'Scan edits, fix findings, then rescan. Only status=complete with clean=true is a clean scan. Use scan_file for one file, scan_diff for Git changes, scan_project for a bounded directory, and rules to inspect presets.',
  });
  const preset = z.enum(['recommended', 'strict', 'security', 'agent']);
  // Reject overlapping scans rather than allowing unbounded concurrent ESLint work.
  let busy = false;
  async function invoke(action: () => unknown | Promise<unknown>) {
    if (busy) return response(failure('agent', 'SERVER_BUSY', 'Another tool call is running; retry after it completes'));
    busy = true;
    try { return response(await action()); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write('[ai-guard-mcp] ' + message + '\n');
      return response(failure('agent', 'INTERNAL_ERROR', message));
    } finally { busy = false; }
  }
  function response(result: unknown) {
    const structuredContent = result as Record<string, unknown>;
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent, isError: structuredContent.success === false };
  }
  server.tool('ai_guard_scan_file', 'Scan one workspace JS/TS file. Does not modify source.', {
    path: z.string().min(1), preset: preset.default('agent'),
  }, args => invoke(() => scanFile(args, workspace)));
  server.tool('ai_guard_scan_diff', 'Scan current on-disk Git changes, including untracked files. staged selects paths, not index contents.', {
    base: z.string().min(1).max(256).optional(), preset: preset.default('agent'), staged: z.boolean().default(false),
  }, args => invoke(() => scanDiff(args, workspace)));
  server.tool('ai_guard_scan_project', 'Scan a workspace directory using existing presets and exclusions. Fails on resource limits instead of silently truncating.', {
    path: z.string().min(1).default('.'), preset: preset.default('agent'), maxFiles: z.number().int().min(1).max(500).default(500),
  }, args => invoke(() => scanProject(args, workspace)));
  server.tool('ai_guard_rules', 'List rules and preset severities. With preset, also return its enabled rule IDs.', {
    preset: preset.optional(),
  }, args => invoke(() => getRules(args)));
  return server;
}
