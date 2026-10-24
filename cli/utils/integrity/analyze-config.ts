/**
 * Integrity analyzers for configuration: ESLint, TypeScript, coverage and test
 * runners, package.json scripts and hooks, GitHub Actions workflows, husky
 * hook files, Jest snapshots and integrity acceptances.
 *
 * Only values that can be read statically are compared. When the effective
 * value cannot be established (computed values, `extends`, shared presets),
 * the finding is advisory rather than a confirmed weakening.
 */

import path from 'path';
import {
  addedWeakeners,
  describeWeakener,
  isVerificationCommand,
  verificationKey,
  verificationSegments,
} from './commands.js';
import {
  displayPath,
  entriesFromValue,
  formatScalar,
  pathKey,
  type PathEntry,
  type Scalar,
} from './config-values.js';
import type { FindingDraft } from './types.js';

export interface TextPair {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'T';
  baseText: string | null;
  headText: string | null;
}

// ─── File classification ──────────────────────────────────────────────────────

export type ConfigKind =
  | 'eslint-js' | 'eslint-data' | 'eslintignore'
  | 'tsconfig'
  | 'jest-js' | 'jest-json' | 'vitest-js' | 'coverage-data'
  | 'package-json'
  | 'workflow'
  | 'husky'
  | 'snapshot'
  | 'baseline';

export function classifyConfig(repoPath: string, baselineName = '.ai-guard-baseline.json'): ConfigKind | null {
  const p = repoPath.replace(/\\/g, '/');
  if (p.split('/').includes('node_modules')) return null;
  const base = path.posix.basename(p);
  if (/^eslint\.config\.[cm]?[jt]s$/.test(base) || /^\.eslintrc\.c?js$/.test(base)) return 'eslint-js';
  if (/^\.eslintrc(\.json|\.ya?ml)?$/.test(base)) return 'eslint-data';
  if (base === '.eslintignore') return 'eslintignore';
  if (/^[tj]sconfig(\..+)?\.json$/.test(base)) return 'tsconfig';
  if (/^jest\.config\.[cm]?[jt]s$/.test(base)) return 'jest-js';
  if (base === 'jest.config.json') return 'jest-json';
  if (/^(vitest|vite)\.config\.[cm]?[jt]s$/.test(base) || /^vitest\.workspace\.[cm]?[jt]s$/.test(base)) return 'vitest-js';
  if (/^\.(nycrc|c8rc)(\.json|\.ya?ml)?$/.test(base)) return 'coverage-data';
  if (base === 'package.json') return 'package-json';
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) return 'workflow';
  if (/^(.*\/)?\.husky\/[^/_.][^/]*$/.test(p)) return 'husky';
  if (/\/__snapshots__\/[^/]+\.snap$/.test(p) || /^__snapshots__\/[^/]+\.snap$/.test(p)) return 'snapshot';
  if (base === baselineName) return 'baseline';
  return null;
}

// ─── ESLint configuration ─────────────────────────────────────────────────────

type Severity = 0 | 1 | 2;
const SEVERITY_NAME = ['off', 'warn', 'error'] as const;

function severityOf(value: Scalar): Severity | null {
  if (value === 0 || value === 'off' || value === '0') return 0;
  if (value === 1 || value === 'warn' || value === '1') return 1;
  if (value === 2 || value === 'error' || value === '2') return 2;
  return null;
}

/** Rule → severities of each explicit rule entry (one per config block). */
export function ruleSeverities(entries: PathEntry[]): Map<string, Severity[]> {
  const out = new Map<string, Severity[]>();
  for (const e of entries) {
    const k = e.path.lastIndexOf('rules');
    if (k < 0 || k + 1 >= e.path.length) continue;
    const isScalar = e.path.length === k + 2;
    const isArrayHead = e.path.length === k + 3 && e.path[k + 2] === '[0]';
    if (!isScalar && !isArrayHead) continue;
    const sev = severityOf(e.value);
    if (sev === null) continue;
    const rule = e.path[k + 1];
    const list = out.get(rule) ?? [];
    list.push(sev);
    out.set(rule, list);
  }
  return out;
}

const AI_GUARD_REF = /eslint-plugin-ai-guard|plugin:ai-guard\/|["']ai-guard["']/;

function stringsUnder(entries: PathEntry[], keys: string[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const idx = e.path.findIndex((seg) => keys.includes(seg));
    if (idx >= 0 && e.path.length === idx + 2 && /^\[\d+\]$/.test(e.path[idx + 1]) && typeof e.value === 'string') out.add(e.value);
  }
  return out;
}

export function analyzeEslintConfig(file: string, base: PathEntry[] | null, head: PathEntry[] | null, baseText: string, headText: string | null): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  if (headText === null) {
    if (AI_GUARD_REF.test(baseText)) {
      drafts.push({ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: 'advisory', file,
        message: 'Deleted an ESLint config that enabled AI Guard; confirm the configuration moved elsewhere.', before: 'present', after: 'deleted', key: 'deleted' });
    }
    return drafts;
  }
  if (AI_GUARD_REF.test(baseText) && !AI_GUARD_REF.test(headText)) {
    drafts.push({ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: 'high', file,
      message: 'Removed AI Guard (eslint-plugin-ai-guard) from this ESLint configuration.', before: 'enabled', after: 'removed', key: 'ai-guard-removed' });
  }
  if (!base || !head) return drafts;

  const before = ruleSeverities(base);
  const after = ruleSeverities(head);
  const headUsesAiGuard = AI_GUARD_REF.test(headText);
  for (const rule of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(rule) ?? [];
    const h = after.get(rule) ?? [];
    const maxB = b.length ? Math.max(...b) : null;
    const maxH = h.length ? Math.max(...h) : null;
    if (maxB !== null && maxH !== null) {
      if (maxH < maxB) {
        drafts.push({ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: 'high', file,
          message: `Lowered ESLint rule \`${rule}\` from "${SEVERITY_NAME[maxB]}" to "${SEVERITY_NAME[maxH]}".`,
          before: SEVERITY_NAME[maxB], after: SEVERITY_NAME[maxH], key: `rule:${rule}` });
      } else {
        const weakerB = b.filter((s) => s < maxB).length;
        const weakerH = h.filter((s) => s < maxB).length;
        if (weakerH > weakerB) {
          drafts.push({ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: 'advisory', file,
            message: `Added a config block that sets \`${rule}\` to "${SEVERITY_NAME[Math.min(...h)]}" for some files (still "${SEVERITY_NAME[maxB]}" elsewhere).`,
            after: SEVERITY_NAME[Math.min(...h)], key: `rule-scoped:${rule}` });
        }
      }
    } else if (maxB !== null && maxB > 0 && maxH === null) {
      drafts.push({ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: 'advisory', file,
        message: `\`${rule}\` (was "${SEVERITY_NAME[maxB]}") is no longer configured in this file; its severity now comes from shared configs.`,
        before: SEVERITY_NAME[maxB], after: '(not set)', key: `rule-removed:${rule}` });
    } else if (maxB === null && h.includes(0)) {
      const knownOn = rule.startsWith('ai-guard/') && headUsesAiGuard;
      drafts.push({ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: knownOn ? 'high' : 'advisory', file,
        message: knownOn ? `Turned off AI Guard rule \`${rule}\`.` : `Explicitly turned off ESLint rule \`${rule}\`.`,
        after: 'off', key: `rule-off:${rule}` });
    }
  }

  const ignoresBefore = stringsUnder(base, ['ignores', 'ignorePatterns']);
  const newIgnores = [...stringsUnder(head, ['ignores', 'ignorePatterns'])].filter((p) => !ignoresBefore.has(p)).sort();
  if (newIgnores.length > 0) {
    drafts.push({ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: 'advisory', file,
      message: `Added ESLint ignore patterns: ${newIgnores.map((p) => `\`${p}\``).join(', ')}.`, after: newIgnores.join(', '), key: `ignores:${newIgnores.join('|')}` });
  }
  return drafts;
}

export function analyzeIgnoreFile(pair: TextPair): FindingDraft[] {
  if (pair.headText === null) return [];
  const lines = (t: string | null): Set<string> => new Set((t ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  const before = lines(pair.baseText);
  const added = [...lines(pair.headText)].filter((l) => !before.has(l)).sort();
  if (added.length === 0) return [];
  return [{ ruleId: 'ai-guard/integrity-eslint-config-weakened', tier: 'advisory', file: pair.path,
    message: `Added ${added.length} pattern(s) excluded from linting: ${added.slice(0, 5).map((p) => `\`${p}\``).join(', ')}.`, after: added.join(', '), key: `eslintignore:${added.join('|')}` }];
}

// ─── TypeScript configuration ─────────────────────────────────────────────────

const STRICT_FAMILY = ['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply',
  'strictPropertyInitialization', 'noImplicitThis', 'alwaysStrict', 'useUnknownInCatchVariables', 'strictBuiltinIteratorReturn'];
const STRICT_WHEN_TRUE = ['noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitReturns',
  'noFallthroughCasesInSwitch', 'noImplicitOverride', 'checkJs', 'noEmitOnError'];

type TriState = boolean | 'unknown';

function effectiveOption(opts: Record<string, unknown>, hasExtends: boolean, key: string): TriState {
  if (typeof opts[key] === 'boolean') return opts[key] as boolean;
  if (STRICT_FAMILY.includes(key) && typeof opts.strict === 'boolean') return opts.strict;
  return hasExtends ? 'unknown' : false;
}

export function analyzeTsconfig(file: string, base: unknown, head: unknown): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const b = asObj(base);
  const h = asObj(head);
  const bOpts = asObj(b.compilerOptions);
  const hOpts = asObj(h.compilerOptions);
  const bExt = b.extends !== undefined;
  const hExt = h.extends !== undefined;

  for (const key of ['strict', ...STRICT_FAMILY, ...STRICT_WHEN_TRUE]) {
    // Family members that only follow `strict` are reported once, via `strict`.
    if (STRICT_FAMILY.includes(key) && !(key in bOpts) && !(key in hOpts)) continue;
    const before = effectiveOption(bOpts, bExt, key);
    const after = effectiveOption(hOpts, hExt, key);
    if (before !== true) continue;
    if (after === false) {
      drafts.push({ ruleId: 'ai-guard/integrity-tsconfig-weakened', tier: 'high', file,
        message: `\`compilerOptions.${key}\` changed from true to ${key in hOpts ? 'false' : 'unset (defaults to false)'}.`,
        before: 'true', after: key in hOpts ? 'false' : '(unset)', key: `opt:${key}` });
    } else if (after === 'unknown') {
      drafts.push({ ruleId: 'ai-guard/integrity-tsconfig-weakened', tier: 'advisory', file,
        message: `\`compilerOptions.${key}\` is no longer set to true here; its value now comes from \`extends\`.`,
        before: 'true', after: '(inherited)', key: `opt-inherited:${key}` });
    }
  }
  if (bOpts.skipLibCheck !== true && hOpts.skipLibCheck === true) {
    drafts.push({ ruleId: 'ai-guard/integrity-tsconfig-weakened', tier: 'advisory', file,
      message: '`compilerOptions.skipLibCheck` turned on; declaration files are no longer type-checked.', before: String(bOpts.skipLibCheck ?? '(unset)'), after: 'true', key: 'opt:skipLibCheck' });
  }
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const newExcludes = list(h.exclude).filter((x) => !list(b.exclude).includes(x));
  if (newExcludes.length > 0 && Array.isArray(b.exclude)) {
    drafts.push({ ruleId: 'ai-guard/integrity-tsconfig-weakened', tier: 'advisory', file,
      message: `Added files excluded from type checking: ${newExcludes.map((x) => `\`${x}\``).join(', ')}.`, after: newExcludes.join(', '), key: `exclude:${newExcludes.join('|')}` });
  }
  const removedIncludes = [...list(b.include), ...list(b.files)].filter((x) => !list(h.include).includes(x) && !list(h.files).includes(x));
  if (removedIncludes.length > 0 && (Array.isArray(h.include) || Array.isArray(h.files))) {
    drafts.push({ ruleId: 'ai-guard/integrity-tsconfig-weakened', tier: 'advisory', file,
      message: `Removed paths from type checking: ${removedIncludes.map((x) => `\`${x}\``).join(', ')}.`, before: removedIncludes.join(', '), key: `include:${removedIncludes.join('|')}` });
  }
  return drafts;
}

// ─── Coverage and test-runner configuration ───────────────────────────────────

const METRICS = new Set(['lines', 'branches', 'functions', 'statements']);
const THRESHOLD_PARENTS = new Set(['coverageThreshold', 'thresholds', 'check-coverage', 'checkCoverage']);

function thresholdEntries(entries: PathEntry[], rootIsCoverageTool: boolean): Map<string, { path: string[]; value: number }> {
  const out = new Map<string, { path: string[]; value: number }>();
  for (const e of entries) {
    if (typeof e.value !== 'number') continue;
    const last = e.path[e.path.length - 1];
    if (!METRICS.has(last)) continue;
    const underThreshold = e.path.some((seg) => THRESHOLD_PARENTS.has(seg))
      || (e.path.includes('coverage') && !e.path.includes('thresholds') && e.path.length >= 2 && e.path[e.path.length - 2] === 'coverage')
      || (rootIsCoverageTool && e.path.length === 1)
      || (e.path.length === 2 && (e.path[0] === 'nyc' || e.path[0] === 'c8'));
    if (underThreshold) out.set(pathKey(e.path), { path: e.path, value: e.value });
  }
  return out;
}

function scalarAt(entries: PathEntry[], suffix: string[]): Scalar | undefined {
  for (const e of entries) {
    if (e.path.length >= suffix.length && suffix.every((s, i) => e.path[e.path.length - suffix.length + i] === s)) return e.value;
  }
  return undefined;
}

export function analyzeCoverageAndTestConfig(
  file: string,
  base: PathEntry[] | null,
  head: PathEntry[] | null,
  opts: { rootIsCoverageTool: boolean; fileDeleted: boolean },
): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  if (!base) return drafts;
  const before = thresholdEntries(base, opts.rootIsCoverageTool);
  if (opts.fileDeleted || !head) {
    if (before.size > 0) {
      drafts.push({ ruleId: 'ai-guard/integrity-coverage-weakened', tier: 'advisory', file,
        message: `Deleted a config file that enforced ${before.size} coverage threshold(s); confirm they moved elsewhere.`, before: `${before.size} threshold(s)`, after: 'deleted', key: 'deleted' });
    }
    return drafts;
  }
  const after = thresholdEntries(head, opts.rootIsCoverageTool);
  for (const [k, b] of before) {
    const label = displayPath(b.path);
    const h = after.get(k);
    if (!h) {
      drafts.push({ ruleId: 'ai-guard/integrity-coverage-weakened', tier: 'high', file,
        message: `Removed coverage threshold \`${label}\` (was ${b.value}).`, before: String(b.value), after: '(removed)', key: `threshold:${k}` });
    } else if (Math.sign(h.value) !== Math.sign(b.value) && b.value !== 0 && h.value !== 0) {
      drafts.push({ ruleId: 'ai-guard/integrity-coverage-weakened', tier: 'advisory', file,
        message: `Coverage threshold \`${label}\` changed meaning (${b.value} → ${h.value}); negative values count uncovered items.`, before: String(b.value), after: String(h.value), key: `threshold:${k}` });
    } else if (h.value < b.value) {
      drafts.push({ ruleId: 'ai-guard/integrity-coverage-weakened', tier: 'high', file,
        message: `Lowered coverage threshold \`${label}\` from ${b.value} to ${h.value}.`, before: String(b.value), after: String(h.value), key: `threshold:${k}` });
    }
  }

  const flag = (suffix: string[], fromValue: Scalar, toTest: (v: Scalar | undefined) => boolean, tier: 'high' | 'advisory', rule: string, message: string): void => {
    const b = scalarAt(base, suffix);
    const h = scalarAt(head, suffix);
    if (b === fromValue && toTest(h)) {
      drafts.push({ ruleId: rule, tier, file, message, before: formatScalar(b), after: formatScalar(h), key: `flag:${suffix.join('.')}` });
    }
  };
  flag(['check-coverage'], true, (h) => h !== true, 'high', 'ai-guard/integrity-coverage-weakened', '`check-coverage` turned off; coverage thresholds are no longer enforced.');
  flag(['checkCoverage'], true, (h) => h !== true, 'high', 'ai-guard/integrity-coverage-weakened', '`checkCoverage` turned off; coverage thresholds are no longer enforced.');
  flag(['collectCoverage'], true, (h) => h === false, 'advisory', 'ai-guard/integrity-coverage-weakened', '`collectCoverage` turned off; Jest thresholds only apply when coverage is collected.');
  flag(['coverage', 'enabled'], true, (h) => h === false, 'advisory', 'ai-guard/integrity-coverage-weakened', '`coverage.enabled` turned off.');
  const passB = scalarAt(base, ['passWithNoTests']);
  const passH = scalarAt(head, ['passWithNoTests']);
  if (passB !== true && passH === true) {
    drafts.push({ ruleId: 'ai-guard/integrity-test-config-weakened', tier: 'advisory', file,
      message: '`passWithNoTests` turned on; the test run now passes when no tests are found.', before: formatScalar(passB), after: 'true', key: 'passWithNoTests' });
  }
  const excludeKeys = ['testPathIgnorePatterns', 'modulePathIgnorePatterns', 'exclude'];
  const excludeOf = (entries: PathEntry[]): Set<string> => {
    const out = new Set<string>();
    for (const e of entries) {
      const idx = e.path.findIndex((seg) => excludeKeys.includes(seg));
      if (idx < 0 || typeof e.value !== 'string') continue;
      // vitest `test.exclude`/`coverage.exclude`: only test-file excludes matter here.
      if (e.path[idx] === 'exclude' && !(idx > 0 && e.path[idx - 1] === 'test')) continue;
      out.add(e.value);
    }
    return out;
  };
  const exB = excludeOf(base);
  const newEx = [...excludeOf(head)].filter((x) => !exB.has(x)).sort();
  if (newEx.length > 0) {
    drafts.push({ ruleId: 'ai-guard/integrity-test-config-weakened', tier: 'advisory', file,
      message: `Added test exclusions: ${newEx.map((x) => `\`${x}\``).join(', ')}.`, after: newEx.join(', '), key: `exclude:${newEx.join('|')}` });
  }
  return drafts;
}

// ─── package.json scripts and hooks ───────────────────────────────────────────

const VERIFY_SCRIPT_NAME = /^(test|tests|lint|typecheck|type-check|types|tsc|check|verify|validate|ci|pre-?commit|pre-?push|e2e|coverage)(:.*)?$/i;

function stringRecord(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

function compareCommands(file: string, label: string, keyPrefix: string, before: string, after: string, rule: string): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  for (const w of addedWeakeners(before, after)) {
    const isHookBypass = w.kind === 'no-verify' || w.kind === 'hooks-disabled';
    drafts.push({
      ruleId: isHookBypass ? 'ai-guard/integrity-git-hook-bypass' : rule,
      tier: w.high ? 'high' : 'advisory',
      file,
      message: `${label}: ${describeWeakener(w)}.`,
      before, after,
      key: `${keyPrefix}:${w.kind}`,
    });
  }
  const afterSegs = verificationSegments(after);
  const afterKeys = new Set(afterSegs.map(verificationKey));
  const beforeSegs = verificationSegments(before);
  const removed = beforeSegs.filter((s) => !afterKeys.has(verificationKey(s)));
  const changed = beforeSegs.filter((s) => afterKeys.has(verificationKey(s)) && !afterSegs.includes(s));
  if (removed.length > 0) {
    const nothingLeft = afterSegs.length === 0;
    drafts.push({
      ruleId: rule,
      tier: 'high',
      file,
      message: nothingLeft
        ? `${label} no longer runs a verification command (was \`${before}\`).`
        : `${label}: removed ${removed.map((s) => `\`${s}\``).join(', ')}.`,
      before, after,
      key: `${keyPrefix}:removed:${removed.map(verificationKey).join('|')}`,
    });
  }
  if (changed.length > 0) {
    drafts.push({
      ruleId: rule,
      tier: 'advisory',
      file,
      message: `${label}: arguments of ${changed.map((s) => `\`${s}\``).join(', ')} changed; check that the same tests or files are still covered.`,
      before, after,
      key: `${keyPrefix}:args:${changed.map(verificationKey).join('|')}`,
    });
  }
  return drafts;
}

export function analyzePackageJson(file: string, base: Record<string, unknown> | null, head: Record<string, unknown> | null): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  if (!base || !head) return drafts;
  const bScripts = stringRecord(base.scripts);
  const hScripts = stringRecord(head.scripts);
  const headValues = new Set(Object.values(hScripts));

  for (const [name, before] of Object.entries(bScripts)) {
    const after = hScripts[name];
    const isVerify = VERIFY_SCRIPT_NAME.test(name) || isVerificationCommand(before);
    if (after === undefined) {
      if (isVerify && !headValues.has(before)) {
        drafts.push({ ruleId: 'ai-guard/integrity-verification-script-weakened', tier: 'high', file,
          message: `Removed the \`${name}\` script (was \`${before}\`).`, before, after: '(removed)', key: `script-removed:${name}` });
      }
      continue;
    }
    if (after === before) continue;
    if (isVerify) {
      drafts.push(...compareCommands(file, `Script \`${name}\``, `script:${name}`, before, after, 'ai-guard/integrity-verification-script-weakened'));
    } else {
      // Non-verification scripts: only hook bypasses matter.
      drafts.push(...compareCommands(file, `Script \`${name}\``, `script:${name}`, before, after, 'ai-guard/integrity-verification-script-weakened')
        .filter((d) => d.ruleId === 'ai-guard/integrity-git-hook-bypass'));
    }
  }
  for (const [name, after] of Object.entries(hScripts)) {
    if (name in bScripts) continue;
    for (const w of addedWeakeners(null, after).filter((x) => x.kind === 'no-verify' || x.kind === 'hooks-disabled')) {
      drafts.push({ ruleId: 'ai-guard/integrity-git-hook-bypass', tier: 'high', file,
        message: `New script \`${name}\`: ${describeWeakener(w)}.`, after, key: `script-new:${name}:${w.kind}` });
    }
  }

  // husky v4 (`husky.hooks`) and simple-git-hooks.
  const hookMaps: Array<[string, Record<string, string>, Record<string, string>]> = [
    ['husky.hooks', stringRecord((base.husky as Record<string, unknown> | undefined)?.hooks), stringRecord((head.husky as Record<string, unknown> | undefined)?.hooks)],
    ['simple-git-hooks', stringRecord(base['simple-git-hooks']), stringRecord(head['simple-git-hooks'])],
  ];
  for (const [label, b, h] of hookMaps) {
    for (const [hook, before] of Object.entries(b)) {
      const after = h[hook];
      if (after === undefined) {
        drafts.push({ ruleId: 'ai-guard/integrity-git-hook-bypass', tier: 'high', file,
          message: `Removed the \`${hook}\` Git hook from \`${label}\` (was \`${before}\`).`, before, after: '(removed)', key: `hook-removed:${label}:${hook}` });
      } else if (after !== before) {
        drafts.push(...compareCommands(file, `Git hook \`${label}.${hook}\``, `hook:${label}:${hook}`, before, after, 'ai-guard/integrity-git-hook-bypass'));
      }
    }
  }
  if (base['lint-staged'] !== undefined && head['lint-staged'] === undefined) {
    drafts.push({ ruleId: 'ai-guard/integrity-git-hook-bypass', tier: 'advisory', file,
      message: 'Removed the `lint-staged` configuration; pre-commit checks may no longer run.', before: 'present', after: '(removed)', key: 'lint-staged-removed' });
  }
  const prepareB = bScripts.prepare ?? '';
  const prepareH = hScripts.prepare ?? '';
  if (/\bhusky\b/.test(prepareB) && !/\bhusky\b/.test(prepareH)) {
    drafts.push({ ruleId: 'ai-guard/integrity-git-hook-bypass', tier: 'advisory', file,
      message: 'The `prepare` script no longer installs husky Git hooks.', before: prepareB, after: prepareH || '(removed)', key: 'prepare-husky' });
  }
  return drafts;
}

/** Entries for a nested config key inside package.json (jest, eslintConfig, nyc, c8). */
export function packageJsonSection(pkg: Record<string, unknown> | null, key: string): PathEntry[] | null {
  if (!pkg || pkg[key] === undefined) return null;
  return entriesFromValue(pkg[key], key === 'nyc' || key === 'c8' ? [key] : []);
}

// ─── GitHub Actions workflows ─────────────────────────────────────────────────

interface Step { identity: string; run?: string; uses?: string; if?: unknown; coe?: unknown }
interface Job { if?: unknown; coe?: unknown; steps: Step[] }
interface Workflow { triggers: Set<string>; jobs: Map<string, Job>; on: Record<string, unknown> }

function normalizeWorkflow(doc: unknown): Workflow {
  const obj = typeof doc === 'object' && doc !== null ? doc as Record<string, unknown> : {};
  const on = obj.on ?? obj.true; // YAML 1.1 parsers may read `on` as true
  const triggers = new Set<string>();
  let onObj: Record<string, unknown> = {};
  if (typeof on === 'string') triggers.add(on);
  else if (Array.isArray(on)) on.forEach((t) => typeof t === 'string' && triggers.add(t));
  else if (typeof on === 'object' && on !== null) { onObj = on as Record<string, unknown>; Object.keys(onObj).forEach((t) => triggers.add(t)); }
  const jobs = new Map<string, Job>();
  const rawJobs = typeof obj.jobs === 'object' && obj.jobs !== null ? obj.jobs as Record<string, unknown> : {};
  for (const [id, raw] of Object.entries(rawJobs)) {
    const j = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const steps: Step[] = (Array.isArray(j.steps) ? j.steps : []).map((s: unknown, i: number) => {
      const st = typeof s === 'object' && s !== null ? s as Record<string, unknown> : {};
      const run = typeof st.run === 'string' ? st.run : undefined;
      const uses = typeof st.uses === 'string' ? st.uses : undefined;
      const identity = typeof st.id === 'string' ? `id:${st.id}` : typeof st.name === 'string' ? `name:${st.name}` : run ? `run:${run.split('\n')[0].trim()}` : uses ? `uses:${uses}` : `#${i}`;
      return { identity, run, uses, if: st.if, coe: st['continue-on-error'] };
    });
    jobs.set(id, { if: j.if, coe: j['continue-on-error'], steps });
  }
  return { triggers, jobs, on: onObj };
}

function isVerificationStep(s: Step): boolean {
  return (s.run !== undefined && isVerificationCommand(s.run)) || (s.uses !== undefined && /ai-guard|eslint|codeql-action\/analyze/i.test(s.uses));
}

/** Verification commands a step runs, as tool keys (arguments ignored; see verificationKey). */
function stepCommands(s: Step): string[] {
  return s.run ? [...new Set(verificationSegments(s.run).map(verificationKey))] : s.uses ? [`uses:${s.uses.replace(/@.*$/, '')}`] : [];
}

function isDisabledCondition(v: unknown): boolean {
  return v === false || (typeof v === 'string' && /^\s*(\$\{\{\s*)?false(\s*\}\})?\s*$/.test(v));
}

/** Verification commands per workflow head, so steps moved between jobs or files are not reported. */
export function workflowVerificationCommands(text: string | null, parse: (t: string) => unknown): Set<string> {
  const out = new Set<string>();
  if (text === null) return out;
  try {
    for (const job of normalizeWorkflow(parse(text)).jobs.values()) for (const s of job.steps) for (const c of stepCommands(s)) out.add(c);
  } catch { /* unparseable head: nothing to match against */ }
  return out;
}

export function analyzeWorkflow(file: string, baseDoc: unknown, headDoc: unknown | null, elsewhere: Set<string>): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  const b = normalizeWorkflow(baseDoc);
  const verifyJobs = [...b.jobs.entries()].filter(([, j]) => j.steps.some(isVerificationStep));
  if (verifyJobs.length === 0) return drafts;

  if (headDoc === null) {
    const missing = verifyJobs.flatMap(([, j]) => j.steps.filter(isVerificationStep).flatMap(stepCommands)).filter((c) => !elsewhere.has(c));
    if (missing.length > 0) {
      drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: 'high', file,
        message: `Deleted a workflow that ran ${[...new Set(missing)].map((c) => `\`${c}\``).join(', ')}.`, before: 'present', after: 'deleted', key: 'deleted' });
    }
    return drafts;
  }

  const h = normalizeWorkflow(headDoc);
  const headCommands = new Set<string>(elsewhere);
  for (const job of h.jobs.values()) for (const s of job.steps) for (const c of stepCommands(s)) headCommands.add(c);

  for (const trigger of ['pull_request', 'pull_request_target', 'push', 'merge_group']) {
    if (b.triggers.has(trigger) && !h.triggers.has(trigger)) {
      drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: 'high', file,
        message: `Removed the \`${trigger}\` trigger from a workflow that runs verification steps.`, before: trigger, after: '(removed)', key: `trigger:${trigger}` });
    }
  }
  for (const trigger of ['pull_request', 'push']) {
    const tb = (b.on[trigger] ?? {}) as Record<string, unknown>;
    const th = (h.on[trigger] ?? {}) as Record<string, unknown>;
    if (typeof th !== 'object' || th === null) continue;
    for (const filter of ['paths-ignore', 'branches-ignore', 'paths']) {
      const before = Array.isArray(tb?.[filter]) ? (tb[filter] as unknown[]).map(String) : [];
      const after = Array.isArray(th[filter]) ? (th[filter] as unknown[]).map(String) : [];
      const added = after.filter((x) => !before.includes(x));
      // Adding to an existing `paths` allow-list broadens runs; only a newly
      // introduced `paths` filter narrows them. Ignore lists narrow on every addition.
      if (added.length > 0 && (filter !== 'paths' || before.length === 0)) {
        drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: 'advisory', file,
          message: `\`on.${trigger}.${filter}\` now ${filter === 'paths' ? 'limits runs to' : 'skips'} ${added.map((x) => `\`${x}\``).join(', ')}.`, after: added.join(', '), key: `filter:${trigger}:${filter}:${added.join('|')}` });
      }
    }
  }

  for (const [id, bj] of verifyJobs) {
    const hj = h.jobs.get(id);
    const bCmds = bj.steps.filter(isVerificationStep).flatMap(stepCommands);
    if (!hj) {
      const missing = [...new Set(bCmds.filter((c) => !headCommands.has(c)))];
      if (missing.length > 0) {
        drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: 'high', file,
          message: `Removed job \`${id}\`, which ran ${missing.map((c) => `\`${c}\``).join(', ')}.`, before: id, after: '(removed)', key: `job-removed:${id}` });
      }
      continue;
    }
    if (bj.coe !== true && hj.coe !== undefined && hj.coe !== false && JSON.stringify(hj.coe) !== JSON.stringify(bj.coe)) {
      drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: hj.coe === true ? 'high' : 'advisory', file,
        message: `Job \`${id}\` now sets \`continue-on-error: ${String(hj.coe)}\`; its verification failures no longer fail the workflow.`, before: String(bj.coe ?? false), after: String(hj.coe), key: `job-coe:${id}` });
    }
    if (JSON.stringify(hj.if) !== JSON.stringify(bj.if) && hj.if !== undefined) {
      drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: isDisabledCondition(hj.if) ? 'high' : 'advisory', file,
        message: isDisabledCondition(hj.if) ? `Job \`${id}\` is disabled with \`if: ${String(hj.if)}\`.` : `Job \`${id}\` now runs only when \`${String(hj.if)}\`.`,
        before: bj.if === undefined ? '(always)' : String(bj.if), after: String(hj.if), key: `job-if:${id}` });
    }
    for (const bs of bj.steps.filter(isVerificationStep)) {
      const cmds = stepCommands(bs);
      const hs = hj.steps.find((s) => s.identity === bs.identity) ?? hj.steps.find((s) => stepCommands(s).some((c) => cmds.includes(c)));
      const label = `Step "${bs.identity.replace(/^(id|name|run|uses):/, '')}" in job \`${id}\``;
      if (!hs) {
        const missing = cmds.filter((c) => !headCommands.has(c));
        if (missing.length > 0) {
          drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: 'high', file,
            message: `${label} was removed (ran ${missing.map((c) => `\`${c}\``).join(', ')}).`, before: cmds.join('; '), after: '(removed)', key: `step-removed:${id}:${bs.identity}` });
        }
        continue;
      }
      if (bs.coe !== true && hs.coe !== undefined && hs.coe !== false && JSON.stringify(hs.coe) !== JSON.stringify(bs.coe)) {
        drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: hs.coe === true ? 'high' : 'advisory', file,
          message: `${label} now sets \`continue-on-error: ${String(hs.coe)}\`; a failing check no longer fails the job.`, before: String(bs.coe ?? false), after: String(hs.coe), key: `step-coe:${id}:${bs.identity}` });
      }
      if (JSON.stringify(hs.if) !== JSON.stringify(bs.if) && hs.if !== undefined) {
        drafts.push({ ruleId: 'ai-guard/integrity-ci-check-weakened', tier: isDisabledCondition(hs.if) ? 'high' : 'advisory', file,
          message: isDisabledCondition(hs.if) ? `${label} is disabled with \`if: ${String(hs.if)}\`.` : `${label} now runs only when \`${String(hs.if)}\`.`,
          before: bs.if === undefined ? '(always)' : String(bs.if), after: String(hs.if), key: `step-if:${id}:${bs.identity}` });
      }
      if (bs.run !== undefined && hs.run !== undefined && bs.run !== hs.run) {
        drafts.push(...compareCommands(file, label, `step-run:${id}:${bs.identity}`, bs.run, hs.run, 'ai-guard/integrity-ci-check-weakened')
          .filter((d) => !d.key.includes(':removed:') || verificationSegments(bs.run!).some((c) => !headCommands.has(verificationKey(c)))));
      }
    }
  }
  return drafts;
}

// ─── husky hook files ─────────────────────────────────────────────────────────

function effectiveHookLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#') && !/husky\.sh/.test(l));
}

export function analyzeHuskyHook(pair: TextPair): FindingDraft[] {
  if (pair.baseText === null) return [];
  const before = effectiveHookLines(pair.baseText);
  if (before.length === 0) return [];
  if (pair.headText === null) {
    return [{ ruleId: 'ai-guard/integrity-git-hook-bypass', tier: 'high', file: pair.path,
      message: `Deleted Git hook \`${pair.path}\` (ran ${before.map((l) => `\`${l}\``).join(', ')}).`, before: before.join('; '), after: 'deleted', key: 'deleted' }];
  }
  const after = effectiveHookLines(pair.headText);
  const drafts: FindingDraft[] = [];
  const earlyExit = after.length > 0 && /^(exit\s+0|true)\b/.test(after[0]) && !/^(exit\s+0|true)\b/.test(before[0]);
  if (earlyExit) {
    drafts.push({ ruleId: 'ai-guard/integrity-git-hook-bypass', tier: 'high', file: pair.path,
      message: `Git hook \`${pair.path}\` now exits before running its checks (\`${after[0]}\`).`, after: after[0], key: 'early-exit' });
  }
  const compared = compareCommands(pair.path, `Git hook \`${pair.path}\``, 'hook', before.join('\n'), after.join('\n'), 'ai-guard/integrity-git-hook-bypass');
  // The early exit is the same weakening as its exit-masking match; report it once.
  drafts.push(...(earlyExit ? compared.filter((d) => !d.key.endsWith(':exit-masking')) : compared));
  return drafts;
}

// ─── Jest snapshots ───────────────────────────────────────────────────────────

const SNAPSHOT_CHANGE_THRESHOLD = 3;

function snapshotEntries(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  const re = /^exports\[`((?:\\`|[^`])*)`\] = /gm;
  const marks: Array<{ name: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) marks.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
  marks.forEach((mk, i) => out.set(mk.name, text.slice(mk.bodyStart, i + 1 < marks.length ? marks[i + 1].start : text.length).trim()));
  return out;
}

export function analyzeSnapshot(pair: TextPair): FindingDraft[] {
  const before = snapshotEntries(pair.baseText);
  if (before.size === 0) return [];
  const after = snapshotEntries(pair.headText);
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k));
  if (removed.length === 0 && changed.length < SNAPSHOT_CHANGE_THRESHOLD) return [];
  return [{ ruleId: 'ai-guard/integrity-snapshot-update', tier: 'advisory', file: pair.path,
    message: `${changed.length} snapshot(s) rewritten and ${removed.length} removed (of ${before.size}).`,
    before: `${before.size} snapshots`, after: `${changed.length} changed, ${removed.length} removed`, key: 'snapshots' }];
}

// ─── Integrity acceptances in the baseline file ───────────────────────────────

function acceptedFingerprints(doc: unknown): Set<string> {
  const accepted = (doc as { integrity?: { accepted?: unknown } } | null)?.integrity?.accepted;
  const out = new Set<string>();
  if (Array.isArray(accepted)) for (const a of accepted) if (a && typeof (a as { fingerprint?: unknown }).fingerprint === 'string') out.add((a as { fingerprint: string }).fingerprint);
  return out;
}

export function analyzeAcceptances(file: string, baseDoc: unknown, headDoc: unknown): FindingDraft[] {
  const before = acceptedFingerprints(baseDoc);
  const added = [...acceptedFingerprints(headDoc)].filter((f) => !before.has(f)).sort();
  if (added.length === 0) return [];
  return [{ ruleId: 'ai-guard/integrity-acceptance-added', tier: 'advisory', file,
    message: `This change accepts ${added.length} integrity finding(s) in the baseline file; accepted findings are no longer reported.`,
    after: `${added.length} accepted`, key: `accepted:${added.join('|')}` }];
}

