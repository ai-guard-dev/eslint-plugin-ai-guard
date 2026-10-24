/**
 * Shared model for check-weakening (integrity) analysis.
 *
 * An integrity finding describes an observable change, relative to a base
 * revision, that weakens a check the project relies on: a new suppression, a
 * skipped or removed test, a downgraded config value, a removed CI step.
 * Findings never claim intent; they describe what changed.
 */

import crypto from 'crypto';

/** 'high': precise, observable weakening — may fail a check when enforced. */
export type IntegrityTier = 'high' | 'advisory';

export type IntegrityCategory =
  | 'suppression'
  | 'tests'
  | 'assertions'
  | 'config'
  | 'ci'
  | 'git-hooks'
  | 'acceptance';

export type IntegrityMode = 'report' | 'enforce';

export interface IntegrityFinding {
  /** Stable rule ID, e.g. `ai-guard/integrity-test-skipped`. */
  ruleId: string;
  tier: IntegrityTier;
  /** True only for high-tier findings: eligible to fail a check under enforcement. */
  blocking: boolean;
  category: IntegrityCategory;
  /** Repository-relative POSIX path (the head path; the old path for deletions). */
  file: string;
  line?: number;
  /** Objective description of the observed change. */
  message: string;
  before?: string;
  after?: string;
  remediation: string;
  /** Line-independent identity used for acceptances and de-duplication. */
  fingerprint: string;
}

export interface IntegrityError {
  code: string;
  message: string;
  file?: string;
}

export interface IntegrityBaseInfo {
  /** Ref as requested (e.g. `main`, `HEAD`), or `(empty tree)` for a repo without commits. */
  ref: string;
  /** Resolved commit SHA (or session-start tree SHA); null when comparing against the empty tree. */
  commit: string | null;
  /** What the base is compared with. */
  head: 'working-tree' | 'index';
}

export interface IntegrityReport {
  base: IntegrityBaseInfo;
  filesAnalyzed: number;
  /** Findings after explicit acceptances were applied, sorted deterministically. */
  findings: IntegrityFinding[];
  /** Number of findings matched by an explicit acceptance in the baseline file. */
  accepted: number;
  /** Non-fatal problems: files that could not be parsed or read. */
  errors: IntegrityError[];
}

/** Integrity analysis attached to a scan result. */
export interface IntegrityEnvelope {
  mode: IntegrityMode;
  /** Present when analysis ran. */
  report?: IntegrityReport;
  /** Present when analysis could not run (no Git, unknown base, …). */
  error?: IntegrityError;
}

export interface IntegrityRuleMeta {
  title: string;
  category: IntegrityCategory;
  remediation: string;
}

/** Catalog of integrity rules — the single source for titles, docs and remediation. */
export const INTEGRITY_RULES: Record<string, IntegrityRuleMeta> = {
  'ai-guard/integrity-lint-suppression': {
    title: 'ESLint suppression added',
    category: 'suppression',
    remediation: 'Fix the underlying finding instead of disabling the rule. If the suppression is intended, scope it to one rule and line and add a reason: `// eslint-disable-next-line <rule> -- <why>`.',
  },
  'ai-guard/integrity-ts-suppression': {
    title: 'TypeScript suppression added',
    category: 'suppression',
    remediation: 'Fix the type error. If a suppression is unavoidable, prefer `// @ts-expect-error <why>` on the single line instead of `@ts-ignore` or `@ts-nocheck`.',
  },
  'ai-guard/integrity-test-skipped': {
    title: 'Test skipped',
    category: 'tests',
    remediation: 'Remove `.skip`/`x` and fix the code or the test so it passes. If the skip is intended, link the tracking issue and accept it explicitly with `ai-guard integrity --accept`.',
  },
  'ai-guard/integrity-test-focused': {
    title: 'Focused test (.only) added',
    category: 'tests',
    remediation: 'Remove `.only`/`fit`/`fdescribe`: a focused test silently stops every other test in the file from running.',
  },
  'ai-guard/integrity-test-file-deleted': {
    title: 'Test file deleted',
    category: 'tests',
    remediation: 'Restore the test file, or move its tests to another file in the same change so they keep running.',
  },
  'ai-guard/integrity-test-count-reduced': {
    title: 'Fewer tests run',
    category: 'tests',
    remediation: 'Restore the removed tests or make the code satisfy them. If tests were intentionally removed, explain why in the PR and accept the finding explicitly.',
  },
  'ai-guard/integrity-assertions-reduced': {
    title: 'Fewer assertions (advisory)',
    category: 'assertions',
    remediation: 'Check that the remaining assertions still verify the behaviour the removed ones covered.',
  },
  'ai-guard/integrity-assertion-loosened': {
    title: 'Generic assertions replaced specific ones (advisory)',
    category: 'assertions',
    remediation: 'Prefer exact expectations (`toEqual(expected)`, `toHaveBeenCalledWith(...)`) over `toBeTruthy()`, `toBeDefined()` or `expect.anything()`.',
  },
  'ai-guard/integrity-snapshot-update': {
    title: 'Snapshots rewritten or removed (advisory)',
    category: 'assertions',
    remediation: 'Review the snapshot diff: confirm each changed snapshot reflects intended behaviour, not output that was accepted to make tests pass.',
  },
  'ai-guard/integrity-unsafe-type-escape': {
    title: 'More `as any` casts (advisory)',
    category: 'suppression',
    remediation: 'Replace `as any` with a precise type, a type guard, or schema validation.',
  },
  'ai-guard/integrity-eslint-config-weakened': {
    title: 'ESLint configuration weakened',
    category: 'config',
    remediation: 'Restore the previous rule severity or configuration. Fix the findings the rule reports instead of disabling it.',
  },
  'ai-guard/integrity-tsconfig-weakened': {
    title: 'TypeScript strictness reduced',
    category: 'config',
    remediation: 'Restore the compiler option and fix the type errors it reports.',
  },
  'ai-guard/integrity-coverage-weakened': {
    title: 'Coverage threshold lowered or removed',
    category: 'config',
    remediation: 'Restore the coverage threshold and add tests for the uncovered code.',
  },
  'ai-guard/integrity-test-config-weakened': {
    title: 'Test configuration excludes or relaxes tests',
    category: 'config',
    remediation: 'Restore the previous test configuration so the same tests run and failures still fail.',
  },
  'ai-guard/integrity-verification-script-weakened': {
    title: 'Verification script weakened',
    category: 'config',
    remediation: 'Restore the test/lint/typecheck command in package.json scripts and make sure failures still exit non-zero.',
  },
  'ai-guard/integrity-ci-check-weakened': {
    title: 'CI verification weakened',
    category: 'ci',
    remediation: 'Restore the CI step, remove `continue-on-error`/`if: false`, and make the check pass instead.',
  },
  'ai-guard/integrity-git-hook-bypass': {
    title: 'Git hook bypassed or weakened',
    category: 'git-hooks',
    remediation: 'Remove `--no-verify`/`HUSKY=0` and restore the hook commands; fix what the hook reports.',
  },
  'ai-guard/integrity-acceptance-added': {
    title: 'Integrity findings accepted (advisory)',
    category: 'acceptance',
    remediation: 'Reviewers: confirm each newly accepted finding in .ai-guard-baseline.json is intended.',
  },
};

export function isIntegrityRule(ruleId: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTEGRITY_RULES, ruleId);
}

/** Draft produced by an analyzer; the engine fills in metadata and fingerprint. */
export interface FindingDraft {
  ruleId: keyof typeof INTEGRITY_RULES | string;
  tier: IntegrityTier;
  file: string;
  line?: number;
  message: string;
  before?: string;
  after?: string;
  /** Stable, line-independent identity within (ruleId, file). */
  key: string;
}

export function fingerprintOf(ruleId: string, file: string, key: string): string {
  return crypto.createHash('sha256').update(`${ruleId}\0${file}\0${key}`).digest('hex').slice(0, 32);
}

export function finalizeFinding(draft: FindingDraft): IntegrityFinding {
  const meta = INTEGRITY_RULES[draft.ruleId];
  if (!meta) throw new Error(`Unknown integrity rule: ${draft.ruleId}`);
  return {
    ruleId: draft.ruleId,
    tier: draft.tier,
    blocking: draft.tier === 'high',
    category: meta.category,
    file: draft.file,
    ...(draft.line !== undefined ? { line: draft.line } : {}),
    message: draft.message,
    ...(draft.before !== undefined ? { before: draft.before } : {}),
    ...(draft.after !== undefined ? { after: draft.after } : {}),
    remediation: meta.remediation,
    fingerprint: fingerprintOf(draft.ruleId, draft.file, draft.key),
  };
}

export function compareFindings(a: IntegrityFinding, b: IntegrityFinding): number {
  if (a.tier !== b.tier) return a.tier === 'high' ? -1 : 1;
  return a.file.localeCompare(b.file)
    || (a.line ?? 0) - (b.line ?? 0)
    || a.ruleId.localeCompare(b.ruleId)
    || a.message.localeCompare(b.message);
}

/** Exit-code contribution: 1 only when enforcing and a blocking finding exists. */
export function integrityExitCode(envelope: IntegrityEnvelope | undefined): number {
  if (!envelope || envelope.mode !== 'enforce') return 0;
  if (envelope.error) return 2;
  return envelope.report?.findings.some((f) => f.blocking) ? 1 : 0;
}
