/**
 * MCP result types for AI Guard.
 *
 * These types define the structured response contract for MCP tool results.
 * They reuse IssueDetail from the existing eslint-runner for consistency.
 */

import type { IssueDetail } from '../../cli/utils/eslint-runner.js';
import type { TestIntegrityFinding } from '../../cli/utils/test-integrity.js';
import type { VerifyFinding } from '../../cli/utils/verify.js';
import type { AgentConfigFinding, McpServerInfo } from '../../cli/utils/agent-config.js';
import type { DepFinding, PackageFacts, Verdict } from '../../cli/utils/deps/assess.js';

// ─── MCP Issue (subset of IssueDetail for MCP transport) ──────────────────────

export interface McpIssue {
  ruleId: string;
  severity: 'error' | 'warning';
  confidence?: 'high' | 'medium' | 'low' | 'informational';
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  category?: string;
  remediation?: string;
  fixable: boolean;
  /**
   * An inline eslint-disable directive covers this finding. MCP scans never let
   * directives hide findings (inline-suppressions mode "ignore").
   */
  inlineDirective?: { kind: string; line: number; text: string; justification?: string };
}

// ─── Tool result types ────────────────────────────────────────────────────────

export interface ScanResult {
  success: boolean;
  status: 'complete' | 'partial' | 'failed';
  clean: boolean;
  errors: Array<{ code: string; message: string; file?: string; line?: number }>;
  filesScanned: number;
  durationMs: number;
  /** At most maxIssues findings, errors first. */
  issues: McpIssue[];
  /** Every finding, even when issues is truncated. */
  totalIssues: number;
  truncated: boolean;
  totalErrors: number;
  totalWarnings: number;
  preset: string;
  /** Always "ignore" for MCP: inline directives never hide findings. */
  inlineSuppressions?: 'ignore';
}

export interface ScanDiffResult extends ScanResult {
  changedFiles: number;
  scanMode: string;
  base?: string;
  /** Tests the change weakened; absent when testIntegrity is false or the scan failed. */
  testIntegrity?: {
    findings: TestIntegrityFinding[];
    testFilesAnalyzed: number;
    errors: Array<{ file: string; message: string }>;
  };
}

type ToolError = { code: string; message: string; file?: string; line?: number };

export interface VerifyChangeResult {
  success: boolean;
  /** True when the whole change was analyzed and has no blocking findings. */
  pass: boolean;
  status: 'complete' | 'partial' | 'failed';
  /** What to fix and what to tell the user, ready to act on. */
  summary: string;
  base: string;
  changedFiles: number;
  blocking: VerifyFinding[];
  disclosures: VerifyFinding[];
  totalBlocking: number;
  totalDisclosures: number;
  /** Findings in touched files that this change did not introduce. */
  preExisting: number;
  truncated: boolean;
  errors: ToolError[];
}

export interface CheckedPackage {
  /** The argument as given. */
  input: string;
  name: string;
  spec: string | null;
  verdict: Verdict;
  reason?: string;
  findings: DepFinding[];
  facts?: PackageFacts;
  similarTo?: string;
}

export interface CheckPackageResult {
  success: boolean;
  status: 'complete' | 'partial' | 'failed';
  /** True only when every package was checked and none is blocked. */
  safeToInstall: boolean;
  packages: CheckedPackage[];
  errors: ToolError[];
}

export interface ScanAgentConfigResult {
  success: boolean;
  status: 'complete' | 'failed';
  clean: boolean;
  filesScanned: number;
  errorCount: number;
  warningCount: number;
  findings: AgentConfigFinding[];
  totalFindings: number;
  truncated: boolean;
  servers: McpServerInfo[];
  errors: ToolError[];
}

export interface FixResult {
  success: boolean;
  status: 'complete' | 'failed';
  file: string;
  changed: boolean;
  /** True only when apply was requested and the file was written. */
  applied: boolean;
  fixedRules: string[];
  fixedCount: number;
  /** Unified diff of the fixes. */
  diff: string;
  /** Findings that remain after fixing. */
  remaining: McpIssue[];
  errors: ToolError[];
}

export interface RuleInfo {
  ruleId: string;
  category: string;
  confidence: string;
  severity: Record<string, 'error' | 'warn' | 'off'>;
  description: string;
  remediation: string;
  docsUrl?: string;
}

export interface RulesResult {
  success: boolean;
  totalRules: number;
  presets: string[];
  rules: RuleInfo[];
  preset?: string;
  presetRules?: string[];
  unknownRules?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert an IssueDetail from the eslint runner to an McpIssue.
 * This is the single normalization point between internal ESLint findings
 * and MCP-facing structured output.
 */
export function toMcpIssue(issue: IssueDetail, filePath: string): McpIssue {
  return {
    ruleId: issue.ruleId,
    severity: issue.severity === 2 ? 'error' : 'warning',
    confidence: issue.confidence,
    file: filePath,
    line: issue.line,
    column: issue.column,
    endLine: issue.endLine,
    endColumn: issue.endColumn,
    message: issue.message,
    category: issue.category,
    remediation: issue.remediation,
    fixable: issue.fixable ?? false,
    ...(issue.suppression ? {
      inlineDirective: {
        kind: issue.suppression.kind,
        line: issue.suppression.line,
        text: issue.suppression.text,
        ...(issue.suppression.justification ? { justification: issue.suppression.justification } : {}),
      },
    } : {}),
  };
}
