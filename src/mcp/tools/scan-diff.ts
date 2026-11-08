import path from 'path';
import { getStrictChangedFiles } from '../../../cli/utils/git-diff.js';
import { analyzeTestIntegrity } from '../../../cli/utils/test-integrity.js';
import { getWorkspaceRoot, sanitizeGitRef } from '../utils/workspace.js';
import { failure, isExcluded, scanFiles } from '../utils/scan.js';
import type { ScanDiffResult } from '../types.js';

export async function scanDiff(
  input: { base?: string; preset?: string; staged?: boolean; maxIssues?: number; testIntegrity?: boolean },
  workspace = getWorkspaceRoot(),
): Promise<ScanDiffResult> {
  const preset = input.preset ?? 'agent';
  const fail = (code: string, message: string): ScanDiffResult => ({
    ...failure(preset, code, message), changedFiles: 0, scanMode: 'error', base: input.base,
  });
  if (input.base !== undefined && !sanitizeGitRef(input.base)) return fail('INVALID_GIT_REF', 'Expected a single Git ref, without options or revision ranges');
  if (input.base !== undefined && input.staged) return fail('INVALID_INPUT', 'base and staged cannot be combined');
  let result: ScanDiffResult;
  try {
    const changed = getStrictChangedFiles({ base: input.base, staged: input.staged, cwd: workspace });
    const files = changed.files.filter(file => !isExcluded(path.relative(workspace, file)));
    result = { ...await scanFiles(files, preset, workspace, input.maxIssues), changedFiles: files.length, scanMode: changed.mode, base: changed.base };
  } catch (error) {
    return fail('GIT_FAILED', error instanceof Error ? error.message : String(error));
  }
  if (input.testIntegrity === false || !result.success) return result;

  try {
    const integrity = await analyzeTestIntegrity({ cwd: workspace, base: input.base, staged: input.staged, scope: workspace });
    result.testIntegrity = {
      findings: integrity.findings,
      testFilesAnalyzed: integrity.testFilesAnalyzed,
      errors: integrity.errors,
    };
    // A focused test silently disables the rest of the file: the diff is not clean.
    if (integrity.findings.some(f => f.severity === 'error')) result.clean = false;
  } catch (error) {
    result.status = 'partial';
    result.clean = false;
    result.errors.push({ code: 'TEST_INTEGRITY_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
  return result;
}
