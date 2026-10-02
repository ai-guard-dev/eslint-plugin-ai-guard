/**
 * ai_guard_scan_diff — MCP tool handler.
 *
 * Scans changed files using the existing git-diff detection + eslint runner.
 * Reuses getChangedFiles() and runEslint() — no second git or lint engine.
 */

import path from 'path';
import { runEslint } from '../../../cli/utils/eslint-runner.js';
import type { Preset } from '../../../cli/utils/eslint-runner.js';
import { getChangedFiles } from '../../../cli/utils/git-diff.js';
import { isValidPreset, sanitizeGitRef, getWorkspaceRoot } from '../utils/workspace.js';
import { toMcpIssue } from '../types.js';
import type { ScanDiffResult } from '../types.js';

export interface ScanDiffInput {
  base?: string;
  preset?: string;
  staged?: boolean;
}

export async function scanDiff(input: ScanDiffInput): Promise<ScanDiffResult> {
  const preset: Preset = (input.preset && isValidPreset(input.preset))
    ? input.preset
    : 'agent';

  const workspace = getWorkspaceRoot();

  // Sanitize base ref if provided
  let base: string | undefined;
  if (input.base) {
    const sanitized = sanitizeGitRef(input.base);
    if (!sanitized) {
      return {
        success: false,
        filesScanned: 0,
        durationMs: 0,
        issues: [],
        totalErrors: 0,
        totalWarnings: 0,
        preset,
        changedFiles: 0,
        scanMode: 'error',
        base: input.base,
      };
    }
    base = sanitized;
  }

  // Use existing getChangedFiles — same logic as `ai-guard changed`
  const changedResult = getChangedFiles({
    staged: input.staged ?? false,
    base,
    cwd: workspace,
  });

  if (changedResult.files.length === 0) {
    return {
      success: true,
      filesScanned: 0,
      durationMs: 0,
      issues: [],
      totalErrors: 0,
      totalWarnings: 0,
      preset,
      changedFiles: 0,
      scanMode: changedResult.mode,
      base: changedResult.base,
    };
  }

  // Scan changed files using existing runner
  const result = await runEslint({
    preset,
    targetPath: workspace,
    files: changedResult.files,
  });

  // Convert findings to MCP format
  const issues = result.files.flatMap(f =>
    f.issues.map(issue => toMcpIssue(issue, path.relative(workspace, f.filePath)))
  );

  return {
    success: true,
    filesScanned: result.filesScanned,
    durationMs: result.durationMs,
    issues,
    totalErrors: result.totalErrors,
    totalWarnings: result.totalWarnings,
    preset,
    changedFiles: changedResult.files.length,
    scanMode: changedResult.mode,
    base: changedResult.base,
  };
}
