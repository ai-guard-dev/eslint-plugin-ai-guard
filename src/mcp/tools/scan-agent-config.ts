/**
 * ai_guard_scan_agent_config: scan agent instructions and MCP/agent config.
 * Read-only: compares against the MCP lock file if present, never writes it.
 */
import fs from 'fs';
import path from 'path';
import { scanAgentConfig } from '../../../cli/utils/agent-config.js';
import { getWorkspaceRoot, validatePath } from '../utils/workspace.js';
import type { ScanAgentConfigResult } from '../types.js';

export const DEFAULT_MAX_FINDINGS = 100;

function failure(code: string, message: string): ScanAgentConfigResult {
  return {
    success: false, status: 'failed', clean: false, filesScanned: 0, errorCount: 0, warningCount: 0,
    findings: [], totalFindings: 0, truncated: false, servers: [], errors: [{ code, message }],
  };
}

export function scanAgentConfigTool(
  input: { path?: string; maxFindings?: number },
  workspace = getWorkspaceRoot(),
): ScanAgentConfigResult {
  const checked = validatePath(input.path ?? '.', workspace);
  if (!checked.valid) return failure(checked.code!, checked.error!);
  if (!fs.statSync(checked.resolvedPath).isDirectory()) return failure('NOT_A_DIRECTORY', 'Path must be a directory');

  const report = scanAgentConfig({ root: checked.resolvedPath });
  const prefix = path.relative(workspace, checked.resolvedPath).replace(/\\/g, '/');
  const relative = (file: string): string => (prefix ? `${prefix}/${file}` : file);
  const limit = input.maxFindings ?? DEFAULT_MAX_FINDINGS;
  // Errors first, so truncation keeps the most important findings.
  const ordered = [...report.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));

  return {
    success: true,
    status: 'complete',
    clean: report.findings.length === 0,
    filesScanned: report.files.length,
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    findings: ordered.slice(0, limit).map((f) => ({ ...f, file: relative(f.file) })),
    totalFindings: report.findings.length,
    truncated: report.findings.length > limit,
    servers: report.servers.map((s) => ({ ...s, file: relative(s.file) })),
    errors: [],
  };
}
