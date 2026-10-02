/**
 * MCP result types for AI Guard.
 *
 * These types define the structured response contract for MCP tool results.
 * They reuse IssueDetail from the existing eslint-runner for consistency.
 */

import type { IssueDetail } from '../../cli/utils/eslint-runner.js';

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
}

// ─── Tool result types ────────────────────────────────────────────────────────

export interface ScanResult {
  success: boolean;
  filesScanned: number;
  durationMs: number;
  issues: McpIssue[];
  totalErrors: number;
  totalWarnings: number;
  preset: string;
}

export interface ScanDiffResult extends ScanResult {
  changedFiles: number;
  scanMode: string;
  base?: string;
}

export interface RuleInfo {
  ruleId: string;
  category: string;
  confidence: string;
  severity: Record<string, 'error' | 'warn' | 'off'>;
  description: string;
  remediation: string;
}

export interface RulesResult {
  success: boolean;
  totalRules: number;
  presets: string[];
  rules: RuleInfo[];
  preset?: string;
  presetRules?: string[];
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
    fixable: false, // AI Guard rules are not auto-fixable
  };
}
