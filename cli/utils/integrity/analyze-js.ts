/**
 * Integrity analyzers for JavaScript/TypeScript sources: suppression comments,
 * `as any` casts, skipped/focused/removed tests and assertion signals.
 *
 * Comparisons are multiset-based (per signature, base count vs head count), so
 * a suppression or skip that was merely moved or reformatted is not reported
 * as new. When a signature gained occurrences, the occurrences on lines the
 * change added are reported first.
 */

import {
  affectsAiGuard,
  disablesUntilEndOfFile,
  rulesSuppressedBy,
  type EslintDirective,
} from '../directives.js';
import { activeTests, type JsFacts, type TestDecl } from './js-facts.js';
import type { FindingDraft } from './types.js';

export interface JsFilePair {
  /** Head path (or the deleted path). */
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'T';
  base: JsFacts | null;
  head: JsFacts | null;
  /** Head lines added by the change; null means "treat every line as added". */
  added: Set<number> | null;
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

/** Head items whose signature occurs more often than in the base, preferring added lines. */
function surplus<T extends { line: number }>(base: T[], head: T[], sig: (t: T) => string, added: Set<number> | null): Array<{ item: T; ordinal: number }> {
  const baseCounts = countBy(base, sig);
  const groups = new Map<string, T[]>();
  for (const h of head) {
    const k = sig(h);
    const list = groups.get(k) ?? [];
    list.push(h);
    groups.set(k, list);
  }
  const out: Array<{ item: T; ordinal: number }> = [];
  for (const [k, list] of groups) {
    const extra = list.length - (baseCounts.get(k) ?? 0);
    if (extra <= 0) continue;
    const onAdded = added ? list.filter((t) => added.has(t.line)) : list;
    const rest = list.filter((t) => !onAdded.includes(t)).reverse();
    const picked = [...onAdded, ...rest].slice(0, extra).sort((a, b) => a.line - b.line);
    picked.forEach((item, ordinal) => out.push({ item, ordinal }));
  }
  return out;
}

// ─── Suppressions ─────────────────────────────────────────────────────────────

function directiveSignature(d: EslintDirective): string {
  const rules = rulesSuppressedBy(d);
  return `${d.kind}|${rules === null ? '*' : [...rules].sort().join(',')}`;
}

function describeScope(d: EslintDirective, all: EslintDirective[]): string {
  const rules = rulesSuppressedBy(d);
  const what = rules === null ? 'all ESLint rules (including AI Guard rules)' : rules.join(', ');
  switch (d.kind) {
    case 'disable-line': return `${what} on line ${d.line}`;
    case 'disable-next-line': return `${what} on line ${d.endLine + 1}`;
    case 'inline-config': return `${what} for the whole file`;
    default: return disablesUntilEndOfFile(all, d) ? `${what} until the end of the file` : `${what} for a block of code`;
  }
}

export function analyzeSuppressions(pair: JsFilePair): FindingDraft[] {
  if (!pair.head) return [];
  const drafts: FindingDraft[] = [];
  const isSuppressing = (d: EslintDirective): boolean => {
    if (d.kind === 'enable') return false;
    const rules = rulesSuppressedBy(d);
    return rules === null || rules.length > 0;
  };
  const baseEslint = (pair.base?.eslintDirectives ?? []).filter(isSuppressing);
  const headAll = pair.head.eslintDirectives;
  const headEslint = headAll.filter(isSuppressing);

  for (const { item: d, ordinal } of surplus(baseEslint, headEslint, directiveSignature, pair.added)) {
    const rules = rulesSuppressedBy(d);
    const broad = rules === null || d.kind === 'inline-config' || (d.kind === 'disable' && disablesUntilEndOfFile(headAll, d));
    const ai = affectsAiGuard(rules);
    const high = !d.justification && (broad || ai);
    const reason = d.justification ? ` with reason "${d.justification}"` : ' without a reason';
    drafts.push({
      ruleId: 'ai-guard/integrity-lint-suppression',
      tier: high ? 'high' : 'advisory',
      file: pair.path,
      line: d.line,
      message: `Added \`${d.text}\`, which disables ${describeScope(d, headAll)},${reason}.`,
      after: d.text,
      key: `${directiveSignature(d)}#${d.justification ?? ''}#${ordinal}`,
    });
  }

  const baseTs = (pair.base?.tsDirectives ?? []).filter((d) => d.kind !== 'check');
  const headTs = pair.head.tsDirectives.filter((d) => d.kind !== 'check');
  for (const { item: d, ordinal } of surplus(baseTs, headTs, (t) => t.kind, pair.added)) {
    const high = d.kind === 'nocheck' || (d.kind === 'ignore' && d.description.length < 3);
    const what = d.kind === 'nocheck'
      ? 'turns off type checking for the whole file'
      : d.kind === 'ignore' ? `hides any type error on line ${d.line + 1}` : `expects and hides a type error on line ${d.line + 1}`;
    drafts.push({
      ruleId: 'ai-guard/integrity-ts-suppression',
      tier: high ? 'high' : 'advisory',
      file: pair.path,
      line: d.line,
      message: `Added \`${d.text}\`, which ${what}${d.description ? ` (reason: "${d.description}")` : ', without a reason'}.`,
      after: d.text,
      key: `${d.kind}#${d.description}#${ordinal}`,
    });
  }

  const baseChecks = (pair.base?.tsDirectives ?? []).filter((d) => d.kind === 'check').length;
  const headChecks = pair.head.tsDirectives.filter((d) => d.kind === 'check').length;
  if (pair.base && headChecks < baseChecks) {
    drafts.push({
      ruleId: 'ai-guard/integrity-ts-suppression',
      tier: 'advisory',
      file: pair.path,
      message: 'Removed `// @ts-check`; this JavaScript file is no longer type-checked.',
      before: '// @ts-check',
      key: 'ts-check-removed',
    });
  }

  const baseCasts = pair.base?.anyCasts.length ?? 0;
  const headCasts = pair.head.anyCasts.length;
  if (headCasts > baseCasts) {
    const newLine = pair.head.anyCasts.find((l) => !pair.added || pair.added.has(l)) ?? pair.head.anyCasts[0];
    drafts.push({
      ruleId: 'ai-guard/integrity-unsafe-type-escape',
      tier: 'advisory',
      file: pair.path,
      line: newLine,
      message: `\`as any\` casts went from ${baseCasts} to ${headCasts} in this file.`,
      before: String(baseCasts),
      after: String(headCasts),
      key: 'any-casts',
    });
  }
  return drafts;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const declSig = (t: TestDecl): string => `${t.kind}|${t.path}`;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function listTitles(titles: string[]): string {
  const shown = titles.slice(0, 5).map((t) => `"${t}"`).join(', ');
  return titles.length > 5 ? `${shown} and ${titles.length - 5} more` : shown;
}

/**
 * Analyze test files of one change together.
 * @param changeWide true when `pairs` covers every changed test file, so moves
 *        between files can be recognized; per-file runs (Claude PostToolUse)
 *        report count reductions as advisory only.
 */
export function analyzeTests(pairs: JsFilePair[], changeWide: boolean): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  let totalBase = 0;
  let totalHead = 0;
  // Tests that are new in their own file can be the moved copy of a removed
  // test. Tests that already existed there cannot, so they never "absorb" one.
  const pool = new Map<string, number>();
  const take = (key: string): boolean => {
    const n = pool.get(key) ?? 0;
    if (n === 0) return false;
    pool.set(key, n - 1);
    return true;
  };
  const innerPath = (t: TestDecl): string => t.path.split(' > ').slice(1).join(' > ') || t.title;
  for (const p of pairs) {
    const baseActive = p.base ? activeTests(p.base) : [];
    const headActive = p.head ? activeTests(p.head) : [];
    totalBase += baseActive.length;
    totalHead += headActive.length;
    const existing = countBy(baseActive, (t) => t.path);
    for (const t of headActive) {
      const n = existing.get(t.path) ?? 0;
      if (n > 0) { existing.set(t.path, n - 1); continue; }
      pool.set(`path:${t.path}`, (pool.get(`path:${t.path}`) ?? 0) + 1);
      pool.set(`inner:${innerPath(t)}`, (pool.get(`inner:${innerPath(t)}`) ?? 0) + 1);
    }
  }
  const suiteShrank = changeWide && totalHead < totalBase;
  // Same full path, or same path below a renamed top-level suite.
  const foundElsewhere = (t: TestDecl): boolean => take(`path:${t.path}`) || take(`inner:${innerPath(t)}`);

  for (const p of pairs) {
    const base = p.base;
    const head = p.head;

    if (head) {
      // Newly skipped tests and suites.
      const baseSkipped = (base?.tests ?? []).filter((t) => t.skipped);
      const headSkipped = head.tests.filter((t) => t.skipped);
      for (const { item: t, ordinal } of surplus(baseSkipped, headSkipped, declSig, p.added)) {
        const existed = base?.tests.some((b) => b.kind === t.kind && b.path === t.path && !b.skipped) ?? false;
        const affected = t.kind === 'suite' && base
          ? activeTests(base).filter((b) => b.path.startsWith(`${t.path} > `)).length
          : 0;
        const subject = t.kind === 'suite' ? `suite "${t.path}"${affected ? ` (${plural(affected, 'test')})` : ''}` : `test "${t.path}"`;
        drafts.push({
          ruleId: 'ai-guard/integrity-test-skipped',
          tier: existed ? 'high' : 'advisory',
          file: p.path,
          line: t.line,
          message: existed
            ? `Skipped the existing ${subject}; it no longer runs.`
            : `Added the ${subject} in a skipped state.`,
          before: existed ? 'runs' : undefined,
          after: 'skipped',
          key: `${declSig(t)}#${ordinal}`,
        });
      }

      // Conditionally skipped (skipIf/runIf) — advisory.
      const baseCond = (base?.tests ?? []).filter((t) => t.conditional);
      for (const { item: t, ordinal } of surplus(baseCond, head.tests.filter((t) => t.conditional), declSig, p.added)) {
        drafts.push({
          ruleId: 'ai-guard/integrity-test-skipped',
          tier: 'advisory',
          file: p.path,
          line: t.line,
          message: `"${t.path}" now runs only under a condition (skipIf/runIf).`,
          key: `conditional#${declSig(t)}#${ordinal}`,
        });
      }

      // Focused tests stop every other test in the file.
      const baseFocused = (base?.tests ?? []).filter((t) => t.focused);
      for (const { item: t, ordinal } of surplus(baseFocused, head.tests.filter((t) => t.focused), declSig, p.added)) {
        drafts.push({
          ruleId: 'ai-guard/integrity-test-focused',
          tier: 'high',
          file: p.path,
          line: t.line,
          message: `Focused ${t.kind} "${t.path}" (.only/fit/fdescribe): other tests in this file stop running.`,
          after: 'focused',
          key: `${declSig(t)}#${ordinal}`,
        });
      }
    }

    if (!base) continue;
    const baseActive = activeTests(base);
    if (baseActive.length === 0) continue;

    if (!head) {
      const missing = baseActive.filter((t) => !foundElsewhere(t));
      if (missing.length === 0) continue; // tests moved to other files in this change
      drafts.push({
        ruleId: 'ai-guard/integrity-test-file-deleted',
        tier: suiteShrank ? 'high' : 'advisory',
        file: p.path,
        message: `Deleted a test file with ${plural(baseActive.length, 'active test')}; ${plural(missing.length, 'test')} are not found elsewhere in this change (${listTitles(missing.map((t) => t.path))}).`,
        before: plural(baseActive.length, 'test'),
        after: 'deleted',
        key: 'deleted',
      });
      continue;
    }

    const headActive = activeTests(head);
    if (headActive.length < baseActive.length) {
      const headPaths = countBy(headActive, (t) => t.path);
      const skippedNow = new Set(head.tests.filter((t) => t.effectiveSkipped).map((t) => t.path));
      const missing: TestDecl[] = [];
      for (const t of baseActive) {
        const n = headPaths.get(t.path) ?? 0;
        if (n > 0) { headPaths.set(t.path, n - 1); continue; }
        if (skippedNow.has(t.path)) continue; // reported as a skip
        if (foundElsewhere(t)) continue;
        missing.push(t);
      }
      if (missing.length > 0) {
        const consolidated = head.tests.some((t) => t.parameterized && !(base.tests.some((b) => b.parameterized && b.path === t.path)));
        // A removed copy of a test whose exact title still runs is a duplicate removal.
        const stillRuns = new Set(headActive.map((t) => t.path));
        const onlyDuplicates = missing.every((t) => stillRuns.has(t.path));
        drafts.push({
          ruleId: 'ai-guard/integrity-test-count-reduced',
          tier: suiteShrank && !consolidated && !onlyDuplicates ? 'high' : 'advisory',
          file: p.path,
          message: onlyDuplicates
            ? `Active tests in this file went from ${baseActive.length} to ${headActive.length}; removed duplicate(s) of ${listTitles(missing.map((t) => t.path))}, which still run.`
            : `Active tests in this file went from ${baseActive.length} to ${headActive.length}; no longer found: ${listTitles(missing.filter((t) => !stillRuns.has(t.path)).map((t) => t.path))}.${consolidated ? ' New parameterized tests (.each) may cover them.' : ''}`,
          before: String(baseActive.length),
          after: String(headActive.length),
          key: `count#${missing.map((t) => t.path).sort().join('|')}`,
        });
      }
    }

    if (head.assertions.total < base.assertions.total) {
      drafts.push({
        ruleId: 'ai-guard/integrity-assertions-reduced',
        tier: 'advisory',
        file: p.path,
        message: `Assertions in this file went from ${base.assertions.total} to ${head.assertions.total}.`,
        before: String(base.assertions.total),
        after: String(head.assertions.total),
        key: 'assertions',
      });
    }
    if (head.assertions.loose > base.assertions.loose && head.assertions.strict < base.assertions.strict) {
      drafts.push({
        ruleId: 'ai-guard/integrity-assertion-loosened',
        tier: 'advisory',
        file: p.path,
        message: `Specific assertions went from ${base.assertions.strict} to ${head.assertions.strict} while generic ones (toBeTruthy, toBeDefined, expect.anything, …) went from ${base.assertions.loose} to ${head.assertions.loose}.`,
        before: `${base.assertions.strict} specific / ${base.assertions.loose} generic`,
        after: `${head.assertions.strict} specific / ${head.assertions.loose} generic`,
        key: 'loosened',
      });
    }
  }
  return drafts;
}
