import path from 'path';
import { BASELINE_FILE, loadIntegrityAcceptances } from '../../../cli/utils/baseline.js';
import { analyzeIntegrity } from '../../../cli/utils/integrity/engine.js';
import { IntegrityGitError } from '../../../cli/utils/integrity/git.js';
import type { IntegrityFinding } from '../../../cli/utils/integrity/types.js';
import { getWorkspaceRoot, sanitizeGitRef } from '../utils/workspace.js';

export const DEFAULT_MAX_FINDINGS = 50;
export const MAX_FINDINGS_LIMIT = 500;

export interface IntegrityToolResult {
  success: boolean;
  status: 'complete' | 'partial' | 'failed';
  /** True only for a complete analysis with no findings at all. */
  clean: boolean;
  /** True when a high-confidence finding exists — the change should not be considered done. */
  hasBlockingFindings: boolean;
  base?: { ref: string; commit: string | null; head: 'working-tree' | 'index' };
  filesAnalyzed: number;
  findings: IntegrityFinding[];
  totalFindings: number;
  highCount: number;
  advisoryCount: number;
  truncated: boolean;
  accepted: number;
  errors: Array<{ code: string; message: string; file?: string }>;
}

function failed(code: string, message: string): IntegrityToolResult {
  return { success: false, status: 'failed', clean: false, hasBlockingFindings: false, filesAnalyzed: 0,
    findings: [], totalFindings: 0, highCount: 0, advisoryCount: 0, truncated: false, accepted: 0, errors: [{ code, message }] };
}

/**
 * Check-integrity analysis for MCP clients: the same engine and finding
 * semantics as `ai-guard integrity`, limited to the workspace directory and
 * using the packaged parser only. `base` is used exactly as given (like
 * ai_guard_scan_diff): merge-base(HEAD, base); no origin/ guessing.
 */
export async function checkIntegrity(
  input: { base?: string; staged?: boolean; maxFindings?: number },
  workspace = getWorkspaceRoot(),
): Promise<IntegrityToolResult> {
  if (input.base !== undefined && !sanitizeGitRef(input.base)) return failed('INVALID_GIT_REF', 'Expected a single Git ref, without options or revision ranges');
  if (input.base !== undefined && input.staged) return failed('INVALID_INPUT', 'base and staged cannot be combined');
  const maxFindings = input.maxFindings ?? DEFAULT_MAX_FINDINGS;
  if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > MAX_FINDINGS_LIMIT) {
    return failed('INVALID_INPUT', `maxFindings must be an integer from 1 to ${MAX_FINDINGS_LIMIT}`);
  }
  const acceptances = loadIntegrityAcceptances(path.join(workspace, BASELINE_FILE));
  if (acceptances.status === 'invalid') return failed('BASELINE_INVALID', `${BASELINE_FILE} is invalid: ${acceptances.reason}`);
  try {
    const report = await analyzeIntegrity({
      cwd: workspace,
      scope: workspace,
      base: input.base,
      mergeBase: input.base !== undefined,
      staged: input.staged,
      isolated: true,
      maxFiles: 500,
      acceptedFingerprints: acceptances.accepted.map((a) => a.fingerprint),
    });
    const highCount = report.findings.filter((f) => f.tier === 'high').length;
    const truncated = report.findings.length > maxFindings;
    const errors = [...report.errors];
    if (truncated) errors.push({ code: 'RESULT_LIMIT', message: `Only the first ${maxFindings} of ${report.findings.length} findings are returned (high-confidence first)` });
    const status = errors.length > 0 ? 'partial' : 'complete';
    return {
      success: true,
      status,
      clean: status === 'complete' && report.findings.length === 0,
      hasBlockingFindings: highCount > 0,
      base: report.base,
      filesAnalyzed: report.filesAnalyzed,
      findings: report.findings.slice(0, maxFindings),
      totalFindings: report.findings.length,
      highCount,
      advisoryCount: report.findings.length - highCount,
      truncated,
      accepted: report.accepted,
      errors,
    };
  } catch (error) {
    if (error instanceof IntegrityGitError) return failed(error.code, error.message);
    return failed('ANALYSIS_FAILED', error instanceof Error ? error.message : String(error));
  }
}
