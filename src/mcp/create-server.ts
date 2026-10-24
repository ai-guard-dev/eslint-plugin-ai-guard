import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canonicalWorkspace } from './utils/workspace.js';
import { scanFile } from './tools/scan-file.js';
import { scanDiff } from './tools/scan-diff.js';
import { scanProject } from './tools/scan-project.js';
import { getRules } from './tools/rules.js';
import { checkIntegrity, DEFAULT_MAX_FINDINGS, MAX_FINDINGS_LIMIT } from './tools/check-integrity.js';
import { DEFAULT_MAX_ISSUES, MAX_ISSUES_LIMIT, failure } from './utils/scan.js';

// ─── Output schemas (structuredContent is validated against these) ───────────

const issueSchema = z.object({
  ruleId: z.string(),
  severity: z.enum(['error', 'warning']),
  confidence: z.enum(['high', 'medium', 'low', 'informational']).optional(),
  file: z.string(),
  line: z.number(),
  column: z.number(),
  endLine: z.number().optional(),
  endColumn: z.number().optional(),
  message: z.string(),
  category: z.string().optional(),
  remediation: z.string().optional(),
  fixable: z.boolean(),
  inlineDirective: z.object({
    kind: z.string(), line: z.number(), text: z.string(), justification: z.string().optional(),
  }).optional(),
});

const scanOutput = {
  success: z.boolean(),
  status: z.enum(['complete', 'partial', 'failed']),
  clean: z.boolean(),
  errors: z.array(z.object({
    code: z.string(), message: z.string(), file: z.string().optional(), line: z.number().optional(),
  })),
  filesScanned: z.number(),
  durationMs: z.number(),
  issues: z.array(issueSchema),
  totalIssues: z.number(),
  truncated: z.boolean(),
  totalErrors: z.number(),
  totalWarnings: z.number(),
  preset: z.string(),
  inlineSuppressions: z.literal('ignore').optional(),
};

const integrityFindingSchema = z.object({
  ruleId: z.string(),
  tier: z.enum(['high', 'advisory']),
  blocking: z.boolean(),
  category: z.string(),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  remediation: z.string(),
  fingerprint: z.string(),
});

const integrityOutput = {
  success: z.boolean(),
  status: z.enum(['complete', 'partial', 'failed']),
  clean: z.boolean(),
  hasBlockingFindings: z.boolean(),
  base: z.object({ ref: z.string(), commit: z.string().nullable(), head: z.enum(['working-tree', 'index']) }).optional(),
  filesAnalyzed: z.number(),
  findings: z.array(integrityFindingSchema),
  totalFindings: z.number(),
  highCount: z.number(),
  advisoryCount: z.number(),
  truncated: z.boolean(),
  accepted: z.number(),
  errors: z.array(z.object({ code: z.string(), message: z.string(), file: z.string().optional() })),
};

const scanDiffOutput = {
  ...scanOutput,
  changedFiles: z.number(),
  scanMode: z.string(),
  base: z.string().optional(),
};

const level = z.enum(['error', 'warn', 'off']);
const rulesOutput = {
  success: z.boolean(),
  totalRules: z.number(),
  presets: z.array(z.string()),
  rules: z.array(z.object({
    ruleId: z.string(),
    category: z.string(),
    confidence: z.string(),
    severity: z.record(z.string(), level),
    description: z.string(),
    remediation: z.string(),
    docsUrl: z.string().optional(),
  })),
  preset: z.string().optional(),
  presetRules: z.array(z.string()).optional(),
  unknownRules: z.array(z.string()).optional(),
};

const readOnly = { readOnlyHint: true, openWorldHint: false };

export function createMcpServer(root: string): McpServer {
  const workspace = canonicalWorkspace(root);
  const server = new McpServer({ name: 'ai-guard', version: '1.4.3' }, {
    instructions: 'Scan edits, fix findings, then rescan. Only status=complete with clean=true is a clean scan. Use scan_file for one file, scan_diff for Git changes, scan_project for a bounded directory, check_integrity to find checks your change weakened (new suppressions, skipped or removed tests, downgraded configs, removed CI steps), and rules to inspect presets or look up a rule. Inline eslint-disable comments never hide findings here.',
  });
  const preset = z.enum(['recommended', 'strict', 'security', 'agent']);
  const maxIssues = z.number().int().min(1).max(MAX_ISSUES_LIMIT).default(DEFAULT_MAX_ISSUES)
    .describe('Max findings returned, errors first. Totals always count every finding; truncation is reported as RESULT_LIMIT.');
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
  // Text content is the same object as compact JSON (MCP spec recommendation),
  // so text-only clients and JSON.parse consumers see exactly structuredContent.
  function response(result: unknown) {
    const structuredContent = result as Record<string, unknown>;
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent, isError: structuredContent.success === false };
  }
  server.registerTool('ai_guard_scan_file', {
    description: 'Scan one workspace JS/TS file. Does not modify source.',
    inputSchema: { path: z.string().min(1), preset: preset.default('agent'), maxIssues },
    outputSchema: scanOutput,
    annotations: readOnly,
  }, args => invoke(() => scanFile(args, workspace)));
  server.registerTool('ai_guard_scan_diff', {
    description: 'Scan current on-disk Git changes, including untracked files. staged selects paths, not index contents.',
    inputSchema: {
      base: z.string().min(1).max(256).optional(), preset: preset.default('agent'), staged: z.boolean().default(false), maxIssues,
    },
    outputSchema: scanDiffOutput,
    annotations: readOnly,
  }, args => invoke(() => scanDiff(args, workspace)));
  server.registerTool('ai_guard_scan_project', {
    description: 'Scan a workspace directory using existing presets and exclusions. Fails on resource limits instead of silently truncating.',
    inputSchema: {
      path: z.string().min(1).default('.'), preset: preset.default('agent'), maxFiles: z.number().int().min(1).max(500).default(500), maxIssues,
    },
    outputSchema: scanOutput,
    annotations: readOnly,
  }, args => invoke(() => scanProject(args, workspace)));
  server.registerTool('ai_guard_check_integrity', {
    description: 'Report checks weakened by current Git changes compared with a base: new eslint-disable/@ts-ignore, skipped, focused or removed tests, lowered ESLint/TypeScript/coverage settings, removed or non-blocking CI steps, Git hook bypasses. tier "high" = precise weakening (hasBlockingFindings=true means the change should not be considered done until each is fixed or explained to the user); tier "advisory" needs judgment and never blocks. Read-only; does not modify files.',
    inputSchema: {
      base: z.string().min(1).max(256).optional().describe('Compare with merge-base(HEAD, base). Default: HEAD (uncommitted and untracked changes).'),
      staged: z.boolean().default(false).describe('Compare the index with HEAD instead of the working tree'),
      maxFindings: z.number().int().min(1).max(MAX_FINDINGS_LIMIT).default(DEFAULT_MAX_FINDINGS),
    },
    outputSchema: integrityOutput,
    annotations: readOnly,
  }, args => invoke(() => checkIntegrity(args, workspace)));
  server.registerTool('ai_guard_rules', {
    description: 'List rules and preset severities. With preset, also return its enabled rule IDs. With rules (e.g. a ruleId from a finding), return only those rules with description, remediation and docs link.',
    inputSchema: {
      preset: preset.optional(),
      rules: z.array(z.string().min(1).max(100)).min(1).max(25).optional(),
    },
    outputSchema: rulesOutput,
    annotations: readOnly,
  }, args => invoke(() => getRules(args)));

  server.registerPrompt('verify_changes', {
    title: 'AI Guard: scan → fix → rescan',
    description: 'Verify current JS/TS changes with AI Guard, fix findings by hand, and rescan until clean.',
    argsSchema: {
      path: z.string().optional().describe('Optional single file to verify instead of all Git changes'),
      preset: z.string().optional().describe('agent (default), recommended, strict or security'),
    },
  }, ({ path: file, preset: requested }) => {
    const p = requested && ['recommended', 'strict', 'security', 'agent'].includes(requested) ? requested : 'agent';
    const scan = file
      ? `ai_guard_scan_file with { "path": ${JSON.stringify(file)}, "preset": "${p}" }`
      : `ai_guard_scan_diff with { "preset": "${p}" }`;
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            'Verify my changes with AI Guard:',
            `1. Call ${scan}.`,
            '2. If status is "complete" and clean is true, report that and stop.',
            '3. If status is "failed", report errors[].code and message and stop — do not claim the code is clean.',
            '4. For each finding, edit the code to fix the root cause using its "remediation" (call ai_guard_rules with rules: ["<ruleId>"] if unclear). Do not add disable comments unless the finding is a confirmed false positive, and say so.',
            '5. Rescan with the same arguments. Repeat at most 3 times.',
            '6. If status is "partial", list errors[] (PARSE_ERROR, INCOMPLETE_SCAN, RESULT_LIMIT, …) — the scan is not clean.',
            'Finish with a one-line summary: findings fixed, findings remaining, final status.',
          ].join('\n'),
        },
      }],
    };
  });
  return server;
}
