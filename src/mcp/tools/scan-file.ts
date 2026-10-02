/**
 * ai_guard_scan_file — MCP tool handler.
 *
 * Scans a single JS/TS file using the existing AI Guard eslint runner.
 * Thin adapter: validates path → calls runEslint → normalizes to McpIssue[].
 */

import path from 'path';
import fs from 'fs';
import { runEslint } from '../../../cli/utils/eslint-runner.js';
import type { Preset } from '../../../cli/utils/eslint-runner.js';
import { validatePath, isSupportedExtension, isValidPreset, getWorkspaceRoot } from '../utils/workspace.js';
import { toMcpIssue } from '../types.js';
import type { ScanResult } from '../types.js';

export interface ScanFileInput {
  path: string;
  preset?: string;
}

export async function scanFile(input: ScanFileInput): Promise<ScanResult> {
  const preset: Preset = (input.preset && isValidPreset(input.preset))
    ? input.preset
    : 'agent';

  // Validate path
  const validation = validatePath(input.path);
  if (!validation.valid) {
    return {
      success: false,
      filesScanned: 0,
      durationMs: 0,
      issues: [],
      totalErrors: 0,
      totalWarnings: 0,
      preset,
    };
  }

  const filePath = validation.resolvedPath;

  // Check extension
  if (!isSupportedExtension(filePath)) {
    return {
      success: false,
      filesScanned: 0,
      durationMs: 0,
      issues: [],
      totalErrors: 0,
      totalWarnings: 0,
      preset,
    };
  }

  // Check file exists
  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      filesScanned: 0,
      durationMs: 0,
      issues: [],
      totalErrors: 0,
      totalWarnings: 0,
      preset,
    };
  }

  // Run scan using existing runner — single file mode
  const result = await runEslint({
    preset,
    targetPath: path.dirname(filePath),
    files: [filePath],
  });

  // Convert findings to MCP format
  const workspace = getWorkspaceRoot();
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
  };
}
