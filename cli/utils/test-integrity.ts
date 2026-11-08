/**
 * test-integrity.ts — did a change weaken the tests?
 *
 * AI agents asked to make failing tests pass sometimes edit the tests instead
 * of the code (ImpossibleBench: frontier models exploited tests in most
 * "impossible" tasks, usually by editing test files directly). This module
 * compares each changed test file before and after a change, test by test:
 *
 *  - focused tests (.only, fit, fdescribe) that silently skip the rest  [error]
 *  - deleted test files, removed tests, newly skipped tests             [warning]
 *  - assertions removed from, or weakened in, tests that still exist    [warning]
 *  - rewritten or deleted snapshots                                     [warning]
 *  - changed `test` scripts and test configs that gained exclusions     [warning]
 *
 * Warnings are disclosures, not verdicts: refactors legitimately change tests,
 * so the goal is that a person sees it, not that the change is blocked.
 */

import path from 'path';
import type { TSESTree } from '@typescript-eslint/utils';
import { TEST_INTEGRITY_CHECKS, type TestIntegrityCheck } from './check-catalog.js';
import { getChangeSet, readBefore, readAfter, getLineChanges, scopeChangeSet, type ChangeSet, type ChangeSetOptions, type ChangedPath } from './change-set.js';
import { isTestFile } from '../../src/utils/file-context.js';
import {
  getTestCall,
  getAssertionKind,
  collectAssertionBindings,
  getExpectMatcher,
  getMatcherStrength,
  type TestModifier,
  type AssertionContext,
} from '../../src/utils/test-patterns.js';

export { TEST_INTEGRITY_CHECKS, type TestIntegrityCheck };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestIntegrityFinding {
  check: TestIntegrityCheck;
  severity: 'error' | 'warning';
  /** Repository-relative POSIX path (the old path for deleted files). */
  file: string;
  line: number;
  message: string;
  /** Up to 5 affected tests, snapshots or lines. */
  details?: string[];
  /** True when the file no longer exists after the change. */
  deleted?: boolean;
}

export interface TestIntegrityReport {
  base: string;
  findings: TestIntegrityFinding[];
  testFilesAnalyzed: number;
  /** Files that could not be analyzed (parse errors), reported instead of skipped silently. */
  errors: Array<{ file: string; message: string }>;
}

export interface TestCaseSummary {
  key: string;
  title: string;
  line: number;
  skipped: boolean;
  focused: boolean;
  todo: boolean;
  assertions: number;
  strong: number;
  weak: number;
}

export interface TestFileSummary {
  tests: TestCaseSummary[];
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

interface LinterLike {
  verify(code: string, config: unknown, options: { filename: string }): Array<{ fatal?: boolean; message: string; line?: number }>;
}

let parserCache: { createLinter: () => LinterLike; tsParser: unknown } | null = null;

async function loadParser(): Promise<{ createLinter: () => LinterLike; tsParser: unknown }> {
  if (parserCache) return parserCache;
  const eslint = (await import('eslint')) as unknown as { Linter: new (options: { configType: 'flat' }) => LinterLike };
  let tsParser: unknown = null;
  try {
    tsParser = require('@typescript-eslint/parser');
  } catch {
    tsParser = null;
  }
  parserCache = { createLinter: () => new eslint.Linter({ configType: 'flat' }), tsParser };
  return parserCache;
}

const STRONG_ASSERT_METHODS = new Set([
  'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual', 'notDeepEqual',
  'notDeepStrictEqual', 'throws', 'rejects', 'match', 'doesNotMatch', 'include', 'lengthOf', 'sameMembers',
  'propertyVal', 'is', 'deepEqual', 'like', 'same', 'strictSame', 'snapshot', 'regex', 'calledWith', 'calledOnceWith',
]);
const WEAK_ASSERT_METHODS = new Set(['ok', 'isOk', 'exists', 'isDefined', 'isNotNull', 'isNotUndefined', 'truthy', 'pass', 'called']);

function forEachCall(root: TSESTree.Node, visit: (node: TSESTree.CallExpression) => void): void {
  const stack: TSESTree.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TSESTree.Node;
    if (node.type === 'CallExpression') visit(node);
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child === 'object' && 'type' in child) stack.push(child as TSESTree.Node);
      }
    }
  }
}

function makeSummarizer(out: { summary: TestFileSummary | null }): unknown {
  return {
    meta: { type: 'problem', schema: [] },
    create() {
      const suites: Array<{ node: TSESTree.CallExpression; title: string; modifiers: Set<TestModifier> }> = [];
      const tests: TestCaseSummary[] = [];
      const keys = new Map<string, number>();
      let bindings = new Set<string>();

      return {
        Program(node: TSESTree.Program): void {
          bindings = collectAssertionBindings(node);
        },
        CallExpression(node: TSESTree.CallExpression): void {
          const call = getTestCall(node);
          if (!call) return;
          if (call.kind === 'suite') {
            suites.push({ node, title: call.title, modifiers: call.modifiers });
            return;
          }
          const inherited = (m: TestModifier): boolean => call.modifiers.has(m) || suites.some((s) => s.modifiers.has(m));
          const baseKey = [...suites.map((s) => s.title), call.title].join(' > ');
          const seen = keys.get(baseKey) ?? 0;
          keys.set(baseKey, seen + 1);
          const key = seen === 0 ? baseKey : `${baseKey} #${seen + 1}`;

          let assertions = 0;
          let strong = 0;
          let weak = 0;
          if (call.callback) {
            const ctx: AssertionContext = {
              bindings,
              testContextNames: new Set(call.callback.params.filter((p): p is TSESTree.Identifier => p.type === 'Identifier').map((p) => p.name)),
            };
            forEachCall(call.callback.body, (n) => {
              if (getAssertionKind(n, ctx) !== 'value') return;
              assertions++;
              if (n.callee.type === 'Identifier' && (n.callee.name === 'expect' || bindings.has(n.callee.name))) {
                const matcher = getExpectMatcher(n);
                const strength = matcher ? getMatcherStrength(matcher) : 'unknown';
                if (strength === 'strong') strong++;
                if (strength === 'weak') weak++;
              } else if (n.callee.type === 'MemberExpression' && n.callee.property.type === 'Identifier') {
                if (STRONG_ASSERT_METHODS.has(n.callee.property.name)) strong++;
                if (WEAK_ASSERT_METHODS.has(n.callee.property.name)) weak++;
              }
            });
          }
          tests.push({
            key,
            title: call.title,
            line: node.loc.start.line,
            skipped: inherited('skip'),
            focused: inherited('only'),
            todo: call.modifiers.has('todo'),
            assertions,
            strong,
            weak,
          });
        },
        'CallExpression:exit'(node: TSESTree.CallExpression): void {
          if (suites.length > 0 && suites[suites.length - 1].node === node) suites.pop();
        },
        'Program:exit'(): void {
          out.summary = { tests };
        },
      };
    },
  };
}

/** Summarizes the tests in a source file; returns null when it does not parse. */
export async function summarizeTestSource(code: string, filename: string): Promise<TestFileSummary | null> {
  const { createLinter, tsParser } = await loadParser();
  const isTs = /\.[cm]?tsx?$/i.test(filename);
  for (const sourceType of ['module', 'script'] as const) {
    const out: { summary: TestFileSummary | null } = { summary: null };
    const config = [{
      // Explicit extensions: flat config does not apply `**/*` to .ts/.tsx files.
      files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      plugins: { integrity: { rules: { summarize: makeSummarizer(out) } } },
      rules: { 'integrity/summarize': 'error' },
      // eslint-disable comments for rules we do not run would otherwise produce warnings.
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType,
        ...(isTs && tsParser ? { parser: tsParser } : {}),
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    }];
    const messages = createLinter().verify(code, config, { filename: `file${path.extname(filename) || '.js'}` });
    // A parse error or "no matching configuration" means the file was not analyzed; an
    // empty summary would hide deleted tests. Inline-directive noise (unknown rules in
    // eslint-disable comments) does not affect the analysis and is ignored.
    const failed = messages.some((m) => m.fatal || (!(m as { ruleId?: string | null }).ruleId && /configuration/i.test(m.message)));
    if (!failed && out.summary) return out.summary;
    if (isTs) break; // the TS parser has no script mode to fall back to
  }
  return null;
}

// ─── Comparisons ──────────────────────────────────────────────────────────────

const DETAIL_LIMIT = 5;

function finding(check: TestIntegrityCheck, file: string, line: number, message: string, details?: string[], deleted?: boolean): TestIntegrityFinding {
  const shown = details?.slice(0, DETAIL_LIMIT);
  if (details && details.length > DETAIL_LIMIT) shown!.push(`and ${details.length - DETAIL_LIMIT} more`);
  return { check, severity: TEST_INTEGRITY_CHECKS[check].severity, file, line, message, ...(shown ? { details: shown } : {}), ...(deleted ? { deleted } : {}) };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Findings for one test file, given its summaries before and after the change.
 * `movedTitles` holds titles of tests that appeared elsewhere in the same change:
 * a test that moved to another file or suite has not been removed.
 */
export function compareTestFiles(
  file: string,
  before: TestFileSummary | null,
  after: TestFileSummary | null,
  movedTitles: ReadonlySet<string> = new Set(),
): TestIntegrityFinding[] {
  const out: TestIntegrityFinding[] = [];
  if (!after) {
    // Helpers, fixtures and e2e site files under test folders contain no tests.
    const gone = (before?.tests ?? []).filter((t) => !movedTitles.has(t.title));
    if (gone.length > 0) {
      const moved = before!.tests.length - gone.length;
      out.push(finding('test-file-deleted', file, 1, `Test file deleted, with ${plural(gone.length, 'test')}${moved ? ` (${moved} more moved to other files)` : ''}. Confirm the code they covered was removed too.`, gone.map((t) => t.key), true));
    }
    return out;
  }

  const beforeByKey = new Map((before?.tests ?? []).map((t) => [t.key, t]));
  const afterByKey = new Map(after.tests.map((t) => [t.key, t]));

  const newlyFocused = after.tests.filter((t) => t.focused && !beforeByKey.get(t.key)?.focused);
  if (newlyFocused.length > 0) {
    out.push(finding('focused-test', file, newlyFocused[0].line,
      `${plural(newlyFocused.length, 'test')} focused with .only/fit/fdescribe. Every other test in this file stops running, so the suite can pass while they fail.`,
      newlyFocused.map((t) => t.key)));
  }
  if (!before) return out;

  const isActive = (t: TestCaseSummary): boolean => !t.skipped && !t.todo;

  const newlySkipped = after.tests.filter((t) => t.skipped && beforeByKey.has(t.key) && isActive(beforeByKey.get(t.key)!));
  if (newlySkipped.length > 0) {
    out.push(finding('test-skipped', file, newlySkipped[0].line, `${plural(newlySkipped.length, 'existing test')} now skipped.`, newlySkipped.map((t) => t.key)));
  }

  const activeBefore = before.tests.filter(isActive);
  const activeAfter = after.tests.filter(isActive);
  const removed = activeBefore.filter((t) => !afterByKey.has(t.key) && !movedTitles.has(t.title));
  const netRemoved = activeBefore.length - activeAfter.length - newlySkipped.length;
  if (netRemoved > 0 && removed.length > 0) {
    const count = Math.min(netRemoved, removed.length);
    const counts = count === netRemoved ? ` (${activeBefore.length} -> ${activeAfter.length + newlySkipped.length})` : '';
    out.push(finding('tests-removed', file, 1, `${plural(count, 'test')} removed${counts}.`, removed.map((t) => t.key)));
  }

  const lessAsserted: string[] = [];
  const weakened: string[] = [];
  let firstLine = 0;
  for (const test of activeAfter) {
    const old = beforeByKey.get(test.key);
    if (!old || !isActive(old)) continue;
    if (test.assertions < old.assertions) {
      lessAsserted.push(`${test.key} (${old.assertions} -> ${test.assertions}${test.assertions === 0 ? ', now asserts nothing' : ''})`);
      firstLine ||= test.line;
    } else if (test.strong < old.strong && test.weak > old.weak) {
      weakened.push(`${test.key} (${old.strong - test.strong} exact assertion${old.strong - test.strong === 1 ? '' : 's'} replaced)`);
      firstLine ||= test.line;
    }
  }
  if (lessAsserted.length > 0) {
    out.push(finding('assertions-removed', file, firstLine, `Assertions removed from ${plural(lessAsserted.length, 'test')} that still exist${lessAsserted.length === 1 ? 's' : ''}. A test that checks less can pass while the code is broken.`, lessAsserted));
  }
  if (weakened.length > 0) {
    out.push(finding('assertions-weakened', file, firstLine, `Exact assertions replaced with weaker ones (toBeDefined, toBeTruthy, ...) in ${plural(weakened.length, 'test')}.`, weakened));
  }
  return out;
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

const SNAPSHOT_ENTRY = /^exports\[`((?:[^`\\]|\\[\s\S])*)`\] = (`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*");?\s*$/gm;

export function parseSnapshots(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const match of text.matchAll(SNAPSHOT_ENTRY)) entries.set(match[1], match[2]);
  return entries;
}

export function compareSnapshots(file: string, before: string | null, after: string | null): TestIntegrityFinding[] {
  if (before === null) return [];
  const old = parseSnapshots(before);
  if (old.size === 0) return [];
  if (after === null) {
    return [finding('snapshots-rewritten', file, 1, `Snapshot file deleted (${plural(old.size, 'snapshot')}). The next run records new snapshots, so changed output passes unnoticed.`, [...old.keys()], true)];
  }
  const now = parseSnapshots(after);
  const changed = [...old.keys()].filter((k) => now.has(k) && now.get(k) !== old.get(k));
  const removed = [...old.keys()].filter((k) => !now.has(k));
  if (changed.length + removed.length === 0) return [];
  const parts = [changed.length ? `${changed.length} of ${old.size} rewritten` : '', removed.length ? `${removed.length} removed` : ''].filter(Boolean);
  return [finding('snapshots-rewritten', file, 1, `Existing snapshots changed: ${parts.join(', ')}. Updating snapshots to match new output hides regressions; review each one.`, [...changed, ...removed])];
}

// ─── Test scripts and config ──────────────────────────────────────────────────

const TEST_SCRIPT = /^(?:test|tests|test:.+|pretest|posttest|ci|verify)$/;
/** Scripts that run tests (not test:lint = eslint or test:format = prettier). */
const TEST_RUNNER = /\b(?:vitest|jest|mocha|ava|tap|playwright|cypress|karma|uvu|jasmine|c8|nyc|wdio)\b|\bnode\b[^&|;]*--test\b|\b(?:bun|deno) test\b/;
/** Additions that make a test command pass without running everything. */
const NEUTRALIZER = /\|\|\s*(?:true|:|exit 0)(?:\s|$)|;\s*exit\s+0\b|--passWithNoTests|--pass-with-no-tests|--testPathIgnorePatterns|--exclude\b|--testNamePattern|--grep\b|--onlyChanged|--findRelatedTests|\bexit 0\b/;

const normalizeCommand = (value: unknown): string => String(value).replace(/'/g, '"').replace(/\s+/g, ' ').trim();

export function compareTestScripts(file: string, before: string | null, after: string | null): TestIntegrityFinding[] {
  const parse = (text: string | null): Record<string, unknown> | null => {
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as { scripts?: unknown };
      return value && typeof value.scripts === 'object' && value.scripts !== null ? (value.scripts as Record<string, unknown>) : {};
    } catch {
      return null;
    }
  };
  const old = parse(before);
  const now = parse(after);
  if (!old || !now) return [];
  const changes: string[] = [];
  for (const key of Object.keys(old)) {
    if (!TEST_SCRIPT.test(key) || !TEST_RUNNER.test(String(old[key]))) continue;
    if (!(key in now)) {
      changes.push(`scripts.${key} removed (was \`${old[key]}\`)`);
      continue;
    }
    const before = normalizeCommand(old[key]);
    const after = normalizeCommand(now[key]);
    if (before === after) continue; // quoting or whitespace only
    if (!TEST_RUNNER.test(after)) {
      changes.push(`scripts.${key} no longer runs a test runner: \`${old[key]}\` -> \`${now[key]}\``);
    } else if (NEUTRALIZER.test(after) && !NEUTRALIZER.test(before)) {
      changes.push(`scripts.${key}: \`${old[key]}\` -> \`${now[key]}\``);
    }
    // Other edits (config paths, reporters, coverage, env vars) do not weaken the run.
  }
  if (changes.length === 0) return [];
  return [finding('test-script-changed', file, 1, 'The test command changed so that it can pass without running every test. Confirm the change is intended.', changes)];
}

const TEST_CONFIG_FILE = /^(?:vitest|jest|playwright|cypress|karma|ava|mocha|wdio)\.config\.[cm]?[jt]s$|^vitest\.workspace\.[cm]?[jt]s$|^jest\.config\.json$|^\.mocharc(?:\.[a-z]+)?$/i;
const VITE_CONFIG_FILE = /^vite\.config\.[cm]?[jt]s$/i;
const RELAXING_KEYWORDS = /\b(?:exclude|testPathIgnorePatterns|modulePathIgnorePatterns|testIgnore|passWithNoTests|bail|coverageThreshold|thresholds?|skip|grep|testMatch|testNamePattern|retries|onlyChanged)\b/;
const VITE_TEST_KEYWORDS = /\b(?:passWithNoTests|coverageThreshold|thresholds|testNamePattern|bail)\b|\bexclude\b.*\b(?:test|spec)\b/;

export function compareTestConfig(file: string, addedText: string[], removedText: string[]): TestIntegrityFinding[] {
  const base = path.posix.basename(file);
  const pattern = TEST_CONFIG_FILE.test(base) ? RELAXING_KEYWORDS : VITE_CONFIG_FILE.test(base) ? VITE_TEST_KEYWORDS : null;
  if (!pattern) return [];
  const added = addedText.filter((l) => pattern.test(l)).map((l) => `+ ${l.trim()}`);
  const removed = removedText.filter((l) => /\b(?:coverageThreshold|thresholds?|branches|functions|lines|statements)\b/.test(l) && /\d/.test(l)).map((l) => `- ${l.trim()}`);
  if (added.length + removed.length === 0) return [];
  return [finding('test-config-changed', file, 1, 'Test configuration changed in a way that can exclude tests or relax thresholds.', [...added, ...removed])];
}

// ─── Entry points ─────────────────────────────────────────────────────────────

const TEST_SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const SNAPSHOT_FILE = /\.snap$/i;

function isTestSource(file: string): boolean {
  return TEST_SOURCE.test(file) && isTestFile(file);
}

/** Analyzes a computed change set. */
export async function analyzeChangeSet(changeSet: ChangeSet): Promise<TestIntegrityReport> {
  const findings: TestIntegrityFinding[] = [];
  const errors: TestIntegrityReport['errors'] = [];
  let analyzed = 0;

  const relevant = changeSet.files.filter((f) =>
    isTestSource(f.path) || isTestSource(f.oldPath) || SNAPSHOT_FILE.test(f.path) ||
    path.posix.basename(f.path) === 'package.json' || TEST_CONFIG_FILE.test(path.posix.basename(f.path)) || VITE_CONFIG_FILE.test(path.posix.basename(f.path)));
  const configFiles = relevant.filter((f) => TEST_CONFIG_FILE.test(path.posix.basename(f.path)) || VITE_CONFIG_FILE.test(path.posix.basename(f.path)));
  const lineChanges = configFiles.length > 0 ? getLineChanges(changeSet, configFiles.map((f) => f.path)) : new Map();

  // First pass: summarize every test file, so tests that moved between files can be told
  // apart from tests that are gone.
  const summaries = new Map<ChangedPath, { before: TestFileSummary | null; after: TestFileSummary | null }>();
  const newTitles = new Set<string>();
  for (const file of relevant) {
    if (!isTestSource(file.path) && !isTestSource(file.oldPath)) continue;
    analyzed++;
    const existed = file.status !== 'added' && file.status !== 'untracked';
    const beforeText = existed ? readBefore(changeSet, file.oldPath) : null;
    const afterText = file.status === 'deleted' ? null : readAfter(changeSet, file.path);
    const before = beforeText !== null ? await summarizeTestSource(beforeText, file.oldPath) : null;
    const after = afterText !== null ? await summarizeTestSource(afterText, file.path) : null;
    if (afterText !== null && after === null) {
      errors.push({ file: file.path, message: 'Could not parse the test file after the change' });
      continue;
    }
    summaries.set(file, { before, after });
    const beforeKeys = new Set((before?.tests ?? []).map((t) => t.key));
    for (const test of after?.tests ?? []) if (!beforeKeys.has(test.key)) newTitles.add(test.title);
  }

  for (const file of relevant) {
    const deleted = file.status === 'deleted';

    if (isTestSource(file.path) || isTestSource(file.oldPath)) {
      const summary = summaries.get(file);
      if (summary) findings.push(...compareTestFiles(deleted ? file.oldPath : file.path, summary.before, summary.after, newTitles));
      continue;
    }

    const existedBefore = file.status !== 'added' && file.status !== 'untracked';
    const beforeText = existedBefore ? readBefore(changeSet, file.oldPath) : null;
    const afterText = deleted ? null : readAfter(changeSet, file.path);

    if (SNAPSHOT_FILE.test(file.path)) {
      findings.push(...compareSnapshots(file.path, beforeText, afterText));
    } else if (path.posix.basename(file.path) === 'package.json') {
      findings.push(...compareTestScripts(file.path, beforeText, afterText));
    } else {
      const lines = lineChanges.get(file.path);
      if (lines) {
        const added = lines.added === 'all' ? (afterText ?? '').split('\n') : [...lines.addedText.values()];
        findings.push(...compareTestConfig(file.path, added, lines.removedText));
      }
    }
  }

  // A deleted snapshot next to a deleted test file is part of the same deletion.
  const deletedTests = new Set(findings.filter((f) => f.check === 'test-file-deleted').map((f) => path.posix.basename(f.file)));
  const filtered = findings.filter((f) => !(f.check === 'snapshots-rewritten' && f.deleted && deletedTests.has(path.posix.basename(f.file).replace(/\.snap$/i, ''))));

  filtered.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || a.file.localeCompare(b.file) || a.line - b.line);
  return { base: changeSet.baseLabel, findings: filtered, testFilesAnalyzed: analyzed, errors };
}

/** Computes the change set and analyzes it. Throws on Git errors. */
export async function analyzeTestIntegrity(options: ChangeSetOptions & { scope?: string }): Promise<TestIntegrityReport> {
  const changeSet = getChangeSet(options);
  const report = await analyzeChangeSet(options.scope ? scopeChangeSet(changeSet, options.scope) : changeSet);
  return report;
}

/** Files considered by the analyzer, for callers that report what was checked. */
export function isTestIntegrityPath(file: ChangedPath): boolean {
  const base = path.posix.basename(file.path);
  return isTestSource(file.path) || isTestSource(file.oldPath) || SNAPSHOT_FILE.test(file.path) || base === 'package.json' || TEST_CONFIG_FILE.test(base) || VITE_CONFIG_FILE.test(base);
}
