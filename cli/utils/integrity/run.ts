/**
 * Run integrity analysis for CLI commands (`integrity`, `changed --integrity`)
 * and turn every failure into an IntegrityEnvelope error instead of a crash or
 * a silently empty (falsely clean) report.
 */

import { loadIntegrityAcceptances, resolveBaselinePath } from '../baseline.js';
import { analyzeIntegrity } from './engine.js';
import { IntegrityGitError } from './git.js';
import type { IntegrityEnvelope, IntegrityMode } from './types.js';

export type IntegrityOption = 'off' | IntegrityMode;

export function isIntegrityOption(value: unknown): value is IntegrityOption {
  return value === 'off' || value === 'report' || value === 'enforce';
}

export interface CliIntegrityOptions {
  cwd: string;
  mode: IntegrityMode;
  /** Branch/ref to compare with (PR mode): merge-base(HEAD, ref), `origin/<ref>` preferred. */
  base?: string;
  /** Compare the index instead of the working tree (with HEAD as base). */
  staged?: boolean;
  /** Baseline file holding explicit acceptances; defaults to .ai-guard-baseline.json in cwd. */
  baselinePath?: string;
}

export async function runCliIntegrity(options: CliIntegrityOptions): Promise<IntegrityEnvelope> {
  const baselinePath = resolveBaselinePath(options.cwd, options.baselinePath);
  const acceptances = loadIntegrityAcceptances(baselinePath);
  if (acceptances.status === 'invalid') {
    return { mode: options.mode, error: { code: 'BASELINE_INVALID', message: `Baseline file ${baselinePath} is invalid: ${acceptances.reason}` } };
  }
  try {
    const report = await analyzeIntegrity({
      cwd: options.cwd,
      base: options.base,
      mergeBase: options.base !== undefined,
      preferRemote: options.base !== undefined,
      staged: options.staged,
      acceptedFingerprints: acceptances.accepted.map((a) => a.fingerprint),
    });
    return { mode: options.mode, report };
  } catch (err) {
    const code = err instanceof IntegrityGitError ? err.code : 'ANALYSIS_FAILED';
    return { mode: options.mode, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}
