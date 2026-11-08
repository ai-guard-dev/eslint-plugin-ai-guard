/**
 * ai_guard_verify_change: one pass/fail verdict for the current change.
 * Read-only. Runs with the packaged rules, never plugin code from the workspace.
 */
import path from 'path';
import { verifyChange, formatVerifyForAgent, type VerifyFinding } from '../../../cli/utils/verify.js';
import { getWorkspaceRoot, isValidPreset, sanitizeGitRef } from '../utils/workspace.js';
import type { VerifyChangeResult } from '../types.js';

export const DEFAULT_MAX_FINDINGS = 50;

function failure(code: string, message: string, base?: string): VerifyChangeResult {
  return {
    success: false, pass: false, status: 'failed', summary: message, base: base ?? 'HEAD', changedFiles: 0,
    blocking: [], disclosures: [], totalBlocking: 0, totalDisclosures: 0, preExisting: 0, truncated: false,
    errors: [{ code, message }],
  };
}

export async function verifyChangeTool(
  input: { base?: string; preset?: string; maxFindings?: number },
  workspace = getWorkspaceRoot(),
): Promise<VerifyChangeResult> {
  const preset = input.preset ?? 'agent';
  if (!isValidPreset(preset)) return failure('INVALID_PRESET', 'Unknown preset');
  if (input.base !== undefined && !sanitizeGitRef(input.base)) {
    return failure('INVALID_GIT_REF', 'Expected a single Git ref, without options or revision ranges');
  }

  const report = await verifyChange({ cwd: workspace, base: input.base, preset, isolated: true, scope: workspace });
  if (!report.success && report.root === '') {
    return failure(report.errors[0]?.code ?? 'GIT_FAILED', report.errors[0]?.message ?? 'Git failed', input.base);
  }

  // Paths are repository-relative in the report; MCP tools speak workspace-relative.
  const toWorkspace = (finding: VerifyFinding): VerifyFinding => ({
    ...finding,
    file: path.relative(workspace, path.join(report.root, finding.file)).replace(/\\/g, '/'),
  });
  const blocking = report.blocking.map(toWorkspace);
  const disclosures = report.disclosures.map(toWorkspace);
  const limit = input.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const scoped = { ...report, blocking, disclosures };
  const hasFindings = blocking.length + disclosures.length > 0;

  return {
    success: report.success,
    pass: report.pass,
    status: !report.success ? 'failed' : report.errors.length > 0 ? 'partial' : 'complete',
    summary: hasFindings ? formatVerifyForAgent(scoped) : report.pass ? 'No blocking issues in this change.' : 'This change was not fully verified; see errors.',
    base: report.base,
    changedFiles: report.changedFiles,
    blocking: blocking.slice(0, limit),
    disclosures: disclosures.slice(0, limit),
    totalBlocking: blocking.length,
    totalDisclosures: disclosures.length,
    preExisting: report.preExisting,
    truncated: blocking.length > limit || disclosures.length > limit,
    errors: report.errors,
  };
}
