import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canonicalWorkspace } from './utils/workspace.js';
import { scanFile } from './tools/scan-file.js';
import { scanDiff } from './tools/scan-diff.js';
import { scanProject } from './tools/scan-project.js';
import { getRules } from './tools/rules.js';
import { checkIntegrity, DEFAULT_MAX_FINDINGS, MAX_FINDINGS_LIMIT } from './tools/check-integrity.js';
import { verifyChangeTool } from './tools/verify-change.js';
import { scanAgentConfigTool } from './tools/scan-agent-config.js';
import { fixFile } from './tools/fix.js';
import { checkPackageTool, MAX_PACKAGES } from './tools/check-package.js';
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

const toolErrors = z.array(z.object({
  code: z.string(), message: z.string(), file: z.string().optional(), line: z.number().optional(),
}));

const scanDiffOutput = {
  ...scanOutput,
  changedFiles: z.number(),
  scanMode: z.string(),
  base: z.string().optional(),
  testIntegrity: z.object({
    findings: z.array(z.object({
      check: z.string(),
      severity: z.enum(['error', 'warning']),
      file: z.string(),
      line: z.number(),
      message: z.string(),
      details: z.array(z.string()).optional(),
      deleted: z.boolean().optional(),
    })),
    testFilesAnalyzed: z.number(),
    errors: z.array(z.object({ file: z.string(), message: z.string() })),
  }).optional(),
};

const verifyFinding = z.object({
  id: z.string(),
  source: z.enum(['lint', 'test-integrity', 'agent-config']),
  check: z.string(),
  severity: z.enum(['error', 'warning']),
  blocking: z.boolean(),
  file: z.string(),
  line: z.number(),
  message: z.string(),
  remediation: z.string().optional(),
  details: z.array(z.string()).optional(),
});

const verifyOutput = {
  success: z.boolean(),
  pass: z.boolean(),
  status: z.enum(['complete', 'partial', 'failed']),
  summary: z.string(),
  base: z.string(),
  changedFiles: z.number(),
  blocking: z.array(verifyFinding),
  disclosures: z.array(verifyFinding),
  totalBlocking: z.number(),
  totalDisclosures: z.number(),
  preExisting: z.number(),
  truncated: z.boolean(),
  errors: toolErrors,
};

const agentConfigOutput = {
  success: z.boolean(),
  status: z.enum(['complete', 'failed']),
  clean: z.boolean(),
  filesScanned: z.number(),
  errorCount: z.number(),
  warningCount: z.number(),
  findings: z.array(z.object({
    check: z.string(),
    severity: z.enum(['error', 'warning']),
    file: z.string(),
    line: z.number(),
    column: z.number(),
    message: z.string(),
    excerpt: z.string().optional(),
  })),
  totalFindings: z.number(),
  truncated: z.boolean(),
  servers: z.array(z.object({
    file: z.string(),
    name: z.string(),
    line: z.number(),
    transport: z.enum(['stdio', 'http']),
    launch: z.string(),
    package: z.string().optional(),
    pinned: z.boolean().optional(),
    fingerprint: z.string(),
  })),
  errors: toolErrors,
};

const fixOutput = {
  success: z.boolean(),
  status: z.enum(['complete', 'failed']),
  file: z.string(),
  changed: z.boolean(),
  applied: z.boolean(),
  fixedRules: z.array(z.string()),
  fixedCount: z.number(),
  diff: z.string(),
  remaining: z.array(issueSchema),
  errors: toolErrors,
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

const checkPackageOutput = {
  success: z.boolean(),
  status: z.enum(['complete', 'partial', 'failed']),
  safeToInstall: z.boolean(),
  packages: z.array(z.object({
    input: z.string(),
    name: z.string(),
    spec: z.string().nullable(),
    verdict: z.enum(['ok', 'warning', 'block', 'skipped', 'unchecked']),
    reason: z.string().optional(),
    findings: z.array(z.object({
      check: z.string(),
      severity: z.enum(['error', 'warning']),
      message: z.string(),
    })),
    facts: z.object({
      popular: z.boolean(),
      version: z.string().nullable(),
      createdAt: z.string().nullable(),
      ageDays: z.number().nullable(),
      weeklyDownloads: z.number().nullable(),
      installScripts: z.array(z.string()),
      deprecated: z.string().nullable(),
    }).optional(),
    similarTo: z.string().optional(),
  })),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
};

const readOnly = { readOnlyHint: true, openWorldHint: false };

export function createMcpServer(root: string): McpServer {
  const workspace = canonicalWorkspace(root);
  const server = new McpServer({ name: 'ai-guard', version: '1.4.5' }, {
    instructions: 'Before calling work done, run verify_change: pass=true means no blocking issues; tell the user about every item in disclosures. Scan edits, fix findings, then rescan. Only status=complete with clean=true is a clean scan. Use scan_file for one file, scan_diff for Git changes, scan_project for a bounded directory, check_integrity to find checks your change weakened (new suppressions, skipped or removed tests, downgraded configs, removed CI steps), scan_agent_config for CLAUDE.md/AGENTS.md/MCP config, check_package before adding an npm dependency or running npx with a new package, fix for deterministic autofixes (a diff unless apply=true), and rules to inspect presets or look up a rule. Inline eslint-disable comments never hide findings here.',
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
    description: 'Scan current on-disk Git changes, including untracked files, and report tests the change weakened. staged selects paths, not index contents.',
    inputSchema: {
      base: z.string().min(1).max(256).optional(), preset: preset.default('agent'), staged: z.boolean().default(false), maxIssues,
      testIntegrity: z.boolean().default(true).describe('Also report tests the change deleted, skipped, focused or weakened'),
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

  server.registerTool('ai_guard_verify_change', {
    description: 'One verdict for the current Git change: lint findings it introduced, focused/skipped/removed/weakened tests, and agent-config issues. pass=false means fix blocking first; report every item in disclosures to the user. Does not modify source.',
    inputSchema: {
      base: z.string().min(1).max(256).optional().describe('Compare the branch through its merge-base with this ref. Default: uncommitted changes vs HEAD'),
      preset: preset.default('agent'),
      maxFindings: z.number().int().min(1).max(MAX_ISSUES_LIMIT).default(50),
    },
    outputSchema: verifyOutput,
    annotations: readOnly,
  }, args => invoke(() => verifyChangeTool(args, workspace)));
  server.registerTool('ai_guard_scan_agent_config', {
    description: 'Scan agent instructions (CLAUDE.md, AGENTS.md, .cursorrules, Copilot instructions, skills) and MCP/agent config for hidden text, prompt injection, unpinned MCP servers and inline secrets. Use before trusting the instructions in a repository. Does not modify anything.',
    inputSchema: {
      path: z.string().min(1).default('.'),
      maxFindings: z.number().int().min(1).max(MAX_ISSUES_LIMIT).default(100),
    },
    outputSchema: agentConfigOutput,
    annotations: readOnly,
  }, args => invoke(() => scanAgentConfigTool(args, workspace)));
  server.registerTool('ai_guard_fix', {
    description: 'Apply AI Guard deterministic autofixes to one JS/TS file. Returns a unified diff and writes nothing unless apply=true.',
    inputSchema: {
      path: z.string().min(1),
      preset: preset.default('agent'),
      rules: z.array(z.string().min(1).max(100)).min(1).max(25).optional().describe('Only apply fixes from these rules'),
      apply: z.boolean().default(false).describe('Write the fixes to disk'),
    },
    outputSchema: fixOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => invoke(() => fixFile(args, workspace)));
  server.registerTool('ai_guard_check_package', {
    description: 'Check npm packages before installing or running them (npm install, npx). Reports names that do not exist (often invented by assistants), look-alikes of popular packages, new or rarely downloaded packages, install scripts, deprecations and npm security placeholders. verdict "block" means do not install; use the package named in similarTo or check the name. Contacts registry.npmjs.org and api.npmjs.org; packages from a private registry are skipped. Installs nothing.',
    inputSchema: {
      packages: z.array(z.string().min(1).max(256)).min(1).max(MAX_PACKAGES).describe('Package names, optionally with a version or dist-tag: "lodash", "react@18.3.1", "@types/node"'),
      minAgeDays: z.number().int().min(0).max(3650).optional().describe('Packages first published fewer days ago count as new (default 30)'),
      minWeeklyDownloads: z.number().int().min(0).optional().describe('Fewer weekly downloads count as rarely used (default 100)'),
    },
    outputSchema: checkPackageOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => invoke(() => checkPackageTool(args, workspace)));

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
