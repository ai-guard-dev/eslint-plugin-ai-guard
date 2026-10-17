import path from 'path';
import { getStrictChangedFiles } from '../../../cli/utils/git-diff.js';
import { getWorkspaceRoot, sanitizeGitRef } from '../utils/workspace.js';
import { failure, isExcluded, scanFiles } from '../utils/scan.js';
import type { ScanDiffResult } from '../types.js';

export async function scanDiff(input: { base?: string; preset?: string; staged?: boolean }, workspace = getWorkspaceRoot()): Promise<ScanDiffResult> {
  const preset = input.preset ?? 'agent';
  const fail = (code: string, message: string): ScanDiffResult => ({
    ...failure(preset, code, message), changedFiles: 0, scanMode: 'error', base: input.base,
  });
  if (input.base !== undefined && !sanitizeGitRef(input.base)) return fail('INVALID_GIT_REF', 'Expected a single Git ref, without options or revision ranges');
  if (input.base !== undefined && input.staged) return fail('INVALID_INPUT', 'base and staged cannot be combined');
  try {
    const changed = getStrictChangedFiles({ ...input, cwd: workspace });
    const files = changed.files.filter(file => !isExcluded(path.relative(workspace, file)));
    return { ...await scanFiles(files, preset, workspace), changedFiles: files.length, scanMode: changed.mode, base: changed.base };
  } catch (error) {
    return fail('GIT_FAILED', error instanceof Error ? error.message : String(error));
  }
}
