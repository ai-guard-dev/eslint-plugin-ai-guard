import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { runEslint, type RunResult, type IssueDetail } from '../../cli/utils/eslint-runner';
import {
  buildBaseline,
  filterBaselinedIssues,
  loadBaseline,
  writeBaseline,
  type BaselineFile,
} from '../../cli/utils/baseline';

function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-baseline-'));
}

function issue(ruleId: string, line: number, overrides: Partial<IssueDetail> = {}): IssueDetail {
  return { ruleId, severity: 2, message: `${ruleId} message`, line, column: 1, ...overrides };
}

function makeResult(files: Record<string, IssueDetail[]>): RunResult {
  const fileResults = Object.entries(files).map(([filePath, issues]) => ({
    filePath,
    issues,
    errorCount: issues.filter((i) => i.severity === 2).length,
    warningCount: issues.filter((i) => i.severity === 1).length,
  }));
  const all = fileResults.flatMap((f) => f.issues);
  const totalErrors = all.filter((i) => i.severity === 2).length;
  const totalWarnings = all.filter((i) => i.severity === 1).length;
  return {
    files: fileResults,
    totalErrors,
    totalWarnings,
    totalIssues: totalErrors + totalWarnings,
    filesScanned: 7,
    ruleBreakdown: new Map(),
    topFiles: [],
    durationMs: 1,
    ecosystemIssues: [],
    parserErrors: [],
    ignoredFiles: [],
    tsParserAvailable: true,
  };
}

describe('baseline matching modes', () => {
  it('stable mode ignores line shifts but strict mode does not', async () => {
    const dir = createTempProject();

    try {
      const filePath = path.join(dir, 'a.ts');
      fs.writeFileSync(
        filePath,
        `
async function f() {
  return fetch('https://example.com');
}

try {
  boom();
} catch (e) {}
`,
        'utf8',
      );

      const first = await runEslint({
        preset: 'recommended',
        targetPath: dir,
      });
      expect(first.totalIssues).toBeGreaterThan(0);

      fs.writeFileSync(
        filePath,
        `
// line shift
async function f() {
  return fetch('https://example.com');
}

try {
  boom();
} catch (e) {}
`,
        'utf8',
      );

      const second = await runEslint({
        preset: 'recommended',
        targetPath: dir,
      });

      const strict = filterBaselinedIssues(second, buildBaseline(first, 'recommended', 'strict'));
      const stable = filterBaselinedIssues(second, buildBaseline(first, 'recommended', 'stable'));

      expect(strict.result.totalIssues).toBeGreaterThan(0);
      expect(stable.result.totalIssues).toBe(0);
      expect(stable.suppressed).toBe(second.totalIssues);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

describe('filterBaselinedIssues', () => {
  it('reports a second identical finding in a baselined file as new (stable mode)', () => {
    const baseline = buildBaseline(
      makeResult({ 'src/a.ts': [issue('ai-guard/no-empty-catch', 10)] }),
      'recommended',
      'stable',
    );
    const current = makeResult({
      'src/a.ts': [issue('ai-guard/no-empty-catch', 12), issue('ai-guard/no-empty-catch', 40)],
    });

    const { result, suppressed } = filterBaselinedIssues(current, baseline);

    expect(suppressed).toBe(1);
    expect(result.totalIssues).toBe(1);
    // The earliest finding consumes the baseline entry; the later one is new.
    expect(result.files[0].issues.map((i) => i.line)).toEqual([40]);
  });

  it('suppresses as many findings as the baseline recorded, no more', () => {
    const recorded = [issue('ai-guard/no-empty-catch', 1), issue('ai-guard/no-empty-catch', 2)];
    const baseline = buildBaseline(makeResult({ 'a.ts': recorded }), 'recommended', 'stable');

    const same = filterBaselinedIssues(makeResult({ 'a.ts': recorded }), baseline);
    expect(same.result.totalIssues).toBe(0);
    expect(same.suppressed).toBe(2);

    const fewer = filterBaselinedIssues(makeResult({ 'a.ts': [issue('ai-guard/no-empty-catch', 5)] }), baseline);
    expect(fewer.result.totalIssues).toBe(0);
    expect(fewer.suppressed).toBe(1);
  });

  it('strict mode matches on line and column', () => {
    const baseline = buildBaseline(makeResult({ 'a.ts': [issue('r', 3)] }), 'recommended', 'strict');
    const { result } = filterBaselinedIssues(makeResult({ 'a.ts': [issue('r', 3), issue('r', 4)] }), baseline);
    expect(result.files[0].issues.map((i) => i.line)).toEqual([4]);
  });

  it('matches Windows-style baseline paths against POSIX scan paths', () => {
    const baseline = buildBaseline(makeResult({ 'src\\api\\users.ts': [issue('r', 1)] }), 'recommended', 'stable');
    expect(baseline.entries[0].filePath).toBe('src/api/users.ts');

    const { result } = filterBaselinedIssues(makeResult({ 'src/api/users.ts': [issue('r', 9)] }), baseline);
    expect(result.totalIssues).toBe(0);
  });

  it('does not match a finding with a different rule or file', () => {
    const baseline = buildBaseline(makeResult({ 'a.ts': [issue('r1', 1)] }), 'recommended', 'stable');
    const { result } = filterBaselinedIssues(
      makeResult({ 'a.ts': [issue('r2', 1)], 'b.ts': [issue('r1', 1)] }),
      baseline,
    );
    expect(result.totalIssues).toBe(2);
  });

  it('recomputes totals and breakdowns and keeps scan metadata', () => {
    const baseline = buildBaseline(makeResult({ 'a.ts': [issue('r1', 1)] }), 'recommended', 'stable');
    const current = makeResult({
      'a.ts': [issue('r1', 1), issue('r2', 2, { severity: 1 })],
      'b.ts': [issue('r1', 1)],
    });

    const { result } = filterBaselinedIssues(current, baseline);

    expect(result.totalErrors).toBe(1);
    expect(result.totalWarnings).toBe(1);
    expect(result.totalIssues).toBe(2);
    expect(Object.fromEntries(result.ruleBreakdown)).toEqual({ r1: 1, r2: 1 });
    expect(result.files.find((f) => f.filePath === 'a.ts')).toMatchObject({ errorCount: 0, warningCount: 1 });
    expect(result.filesScanned).toBe(7);
    expect(result.tsParserAvailable).toBe(true);
  });
});

describe('loadBaseline', () => {
  it('distinguishes missing, invalid and valid files', () => {
    const dir = createTempProject();
    try {
      const file = path.join(dir, '.ai-guard-baseline.json');
      expect(loadBaseline(file)).toEqual({ status: 'missing' });

      fs.writeFileSync(file, '{ not json', 'utf8');
      expect(loadBaseline(file).status).toBe('invalid');

      fs.writeFileSync(file, JSON.stringify({ entries: [{ filePath: 'a.ts' }] }), 'utf8');
      expect(loadBaseline(file)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('issues') });

      fs.writeFileSync(file, JSON.stringify({ mode: 'fuzzy', entries: [] }), 'utf8');
      expect(loadBaseline(file)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('fuzzy') });

      const baseline = buildBaseline(makeResult({ 'a.ts': [issue('r', 1)] }), 'strict', 'stable');
      writeBaseline(file, baseline);
      expect(loadBaseline(file)).toEqual({ status: 'ok', baseline });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats baselines written before `mode` existed as strict', () => {
    const dir = createTempProject();
    try {
      const file = path.join(dir, '.ai-guard-baseline.json');
      const legacy: Omit<BaselineFile, 'mode'> = {
        createdAt: '2026-01-01T00:00:00.000Z',
        preset: 'recommended',
        totalIssues: 0,
        entries: [],
      };
      fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
      const loaded = loadBaseline(file);
      expect(loaded.status === 'ok' && loaded.baseline.mode).toBe('strict');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
