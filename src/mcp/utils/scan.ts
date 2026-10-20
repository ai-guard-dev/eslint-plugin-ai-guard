import fs from 'fs';
import path from 'path';
import { DEFAULT_IGNORE_PATTERNS, runEslint } from '../../../cli/utils/eslint-runner.js';
import { toMcpIssue, type ScanResult } from '../types.js';
import { isSupportedExtension, isValidPreset, validatePath } from './workspace.js';

export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_ISSUES = 50;
export const MAX_ISSUES_LIMIT = 1000;

export function failure(preset: string, code: string, message: string): ScanResult {
  return { success: false, status: 'failed', clean: false, errors: [{ code, message }],
    filesScanned: 0, durationMs: 0, issues: [], totalIssues: 0, truncated: false, totalErrors: 0, totalWarnings: 0, preset };
}

/** Match the runner's default exclusions before handing it explicit files. */
export function isExcluded(relative: string): boolean {
  const normalized = '/' + relative.replace(/\\/g, '/') + '/';
  return DEFAULT_IGNORE_PATTERNS.some(pattern => {
    const segment = pattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    return segment === '.pnp.*'
      ? normalized.split('/').some(part => part.startsWith('.pnp.'))
      : normalized.includes('/' + segment + '/');
  });
}

export async function scanFiles(
  files: string[], preset: string, workspace: string, maxIssues: number = DEFAULT_MAX_ISSUES,
): Promise<ScanResult> {
  const start = Date.now();
  if (!isValidPreset(preset)) return failure(preset, 'INVALID_PRESET', 'Unknown preset');
  if (!Number.isInteger(maxIssues) || maxIssues < 1 || maxIssues > MAX_ISSUES_LIMIT) {
    return failure(preset, 'INVALID_INPUT', 'maxIssues must be an integer from 1 to ' + MAX_ISSUES_LIMIT);
  }
  if (files.length > MAX_FILES) return failure(preset, 'RESOURCE_LIMIT', 'Scan at most 500 files; choose a smaller directory');
  try {
    let bytes = 0;
    const safeFiles: string[] = [];
    for (const file of files) {
      const checked = validatePath(file, workspace);
      if (!checked.valid) return failure(preset, checked.code!, checked.error!);
      const real = checked.resolvedPath;
      if (!isSupportedExtension(file) || !isSupportedExtension(real)) return failure(preset, 'UNSUPPORTED_FILE', 'Only JavaScript/TypeScript files are supported');
      const stat = fs.statSync(real);
      if (!stat.isFile()) return failure(preset, 'NOT_A_FILE', 'Expected a regular file: ' + file);
      const lexical = path.resolve(workspace, file.replace(/\\/g, '/'));
      if (isExcluded(path.relative(workspace, lexical)) || isExcluded(path.relative(workspace, real))) return failure(preset, 'FILE_EXCLUDED', 'File is excluded by the runner: ' + file);
      bytes += stat.size;
      if (stat.size > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) return failure(preset, 'RESOURCE_LIMIT', 'Scan exceeds 1 MiB per file or 20 MiB total');
      safeFiles.push(real);
    }
    if (!files.length) return { success: true, status: 'complete', clean: true, errors: [], filesScanned: 0,
      durationMs: Date.now() - start, issues: [], totalIssues: 0, truncated: false, totalErrors: 0, totalWarnings: 0, preset };
    const result = await runEslint({ preset, targetPath: workspace, files: [...new Set(safeFiles)], isolated: true });
    const errors: ScanResult['errors'] = [
      ...result.parserErrors.map(e => ({ code: 'PARSE_ERROR', message: e.message, file: e.filePath.replace(/\\/g, '/'), line: e.line })),
      ...result.ecosystemIssues.map(e => ({ code: 'ANALYSIS_ERROR', message: e.message, file: e.filePath.replace(/\\/g, '/'), line: e.line })),
    ];
    if (!result.tsParserAvailable && files.some(f => /\.(?:ts|tsx|mts|cts)$/i.test(f))) {
      errors.push({ code: 'PARSER_UNAVAILABLE', message: 'Install @typescript-eslint/parser alongside AI Guard to analyze TypeScript' });
    }
    if (result.filesScanned !== new Set(safeFiles).size) errors.push({ code: 'INCOMPLETE_SCAN', message: 'Not all requested files were analyzed' });
    // Errors first so truncation keeps the most important findings.
    const issues = result.files.flatMap(f => f.issues.map(i => toMcpIssue(i, f.filePath.replace(/\\/g, '/'))))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)
        || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    // Analysis errors mean the scan itself is incomplete (success=false). A response
    // limit only truncates the list: never "complete", but not a tool failure.
    const analysisFailed = errors.length > 0;
    const truncated = issues.length > maxIssues;
    if (truncated) errors.push({ code: 'RESULT_LIMIT', message: 'Only the first ' + maxIssues + ' of ' + issues.length + ' findings are returned (errors first); fix them and rescan, or raise maxIssues' });
    return { success: !analysisFailed, status: errors.length ? 'partial' : 'complete',
      clean: errors.length === 0 && result.totalIssues === 0, errors,
      filesScanned: result.filesScanned, durationMs: Date.now() - start,
      issues: issues.slice(0, maxIssues), totalIssues: issues.length, truncated,
      totalErrors: result.totalErrors, totalWarnings: result.totalWarnings, preset };
  } catch (error) {
    return { ...failure(preset, 'SCAN_FAILED', error instanceof Error ? error.message : String(error)), durationMs: Date.now() - start };
  }
}
