/**
 * ai_guard_fix: apply AI Guard's deterministic autofixes to one file.
 *
 * Returns a unified diff and writes nothing unless `apply: true`. Writes are
 * atomic and refused if the file changed after it was read.
 */
import fs from 'fs';
import path from 'path';
import { allRules } from '../../rules/index.js';
import { fixSourceText, type Preset } from '../../../cli/utils/eslint-runner.js';
import { createUnifiedDiff } from '../../../cli/utils/unified-diff.js';
import { getWorkspaceRoot, isSupportedExtension, isValidPreset, validatePath } from '../utils/workspace.js';
import { MAX_FILE_BYTES, isExcluded } from '../utils/scan.js';
import { toMcpIssue, type FixResult } from '../types.js';

function failure(code: string, message: string, file = ''): FixResult {
  return {
    success: false, status: 'failed', file, changed: false, applied: false, fixedRules: [], fixedCount: 0, diff: '',
    remaining: [], errors: [{ code, message }],
  };
}

export async function fixFile(
  input: { path: string; preset?: string; rules?: string[]; apply?: boolean },
  workspace = getWorkspaceRoot(),
): Promise<FixResult> {
  const preset = input.preset ?? 'agent';
  if (!isValidPreset(preset)) return failure('INVALID_PRESET', 'Unknown preset');

  const checked = validatePath(input.path, workspace);
  if (!checked.valid) return failure(checked.code!, checked.error!);
  const real = checked.resolvedPath;
  const relative = path.relative(workspace, real).replace(/\\/g, '/');
  if (!isSupportedExtension(real)) return failure('UNSUPPORTED_FILE', 'Only JavaScript/TypeScript files are supported', relative);
  if (isExcluded(relative)) return failure('FILE_EXCLUDED', 'File is excluded by the runner', relative);
  const stat = fs.statSync(real);
  if (!stat.isFile()) return failure('NOT_A_FILE', 'Expected a regular file', relative);
  if (stat.size > MAX_FILE_BYTES) return failure('RESOURCE_LIMIT', 'Fix supports files up to 1 MiB', relative);

  const known = new Set(Object.keys(allRules));
  const names = (input.rules ?? []).map((r) => r.trim().replace(/^ai-guard\//, ''));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) return failure('UNKNOWN_RULE', `Unknown rules: ${unknown.join(', ')}`, relative);

  const text = fs.readFileSync(real, 'utf8');
  const result = await fixSourceText({
    filePath: real,
    text,
    preset: preset as Preset,
    cwd: workspace,
    rules: names.map((n) => `ai-guard/${n}`),
    isolated: true,
  });
  if (result.parserError) return failure('PARSE_ERROR', result.parserError, relative);

  let applied = false;
  if (input.apply && result.changed) {
    if (fs.readFileSync(real, 'utf8') !== text) return failure('FILE_CHANGED', 'The file changed while it was being fixed; run the fix again', relative);
    const temp = `${real}.ai-guard-${process.pid}.tmp`;
    fs.writeFileSync(temp, result.output, { encoding: 'utf8', mode: stat.mode });
    fs.renameSync(temp, real);
    applied = true;
  }

  return {
    success: true,
    status: 'complete',
    file: relative,
    changed: result.changed,
    applied,
    fixedRules: result.fixedRuleIds,
    fixedCount: result.fixedCount,
    diff: createUnifiedDiff(text, result.output, relative),
    remaining: result.remaining.map((issue) => toMcpIssue(issue, relative)),
    errors: [],
  };
}
