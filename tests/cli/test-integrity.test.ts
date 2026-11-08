import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  summarizeTestSource,
  analyzeTestIntegrity,
  compareSnapshots,
  compareTestScripts,
  type TestIntegrityFinding,
} from '../../cli/utils/test-integrity';
import { getChangeSet, getLineChanges, readBefore } from '../../cli/utils/change-set';
import { mergeTestIntegrity, getFailOnExitCode } from '../../cli/commands/changed';
import type { RunResult } from '../../cli/utils/eslint-runner';

// ─── Summaries ─────────────────────────────────────────────────────────────────

describe('summarizeTestSource', () => {
  it('counts tests, assertions and modifiers, including suite inheritance', async () => {
    const summary = await summarizeTestSource(`
      describe('math', () => {
        it('adds', () => { expect(add(1, 2)).toBe(3); expect(add(0, 0)).toBe(0); });
        it.skip('subtracts', () => { expect(sub(2, 1)).toBe(1); });
        it.todo('divides');
        describe.only('focused', () => {
          test('multiplies', () => { expect(mul(2, 3)).toBeDefined(); });
        });
      });
      xit('legacy', () => {});
      it.each([1, 2])('handles %i', (n) => { assert.strictEqual(id(n), n); });
    `, 'math.test.js');
    expect(summary!.tests.map((t) => [t.key, t.assertions, t.strong, t.weak, t.skipped, t.focused, t.todo])).toEqual([
      ['math > adds', 2, 2, 0, false, false, false],
      ['math > subtracts', 1, 1, 0, true, false, false],
      ['math > divides', 0, 0, 0, false, false, true],
      ['math > focused > multiplies', 1, 0, 1, false, true, false],
      ['legacy', 0, 0, 0, true, false, false],
      ['handles %i', 1, 1, 0, false, false, false],
    ]);
  });

  it('keys duplicate titles separately and parses TypeScript and JSX', async () => {
    const summary = await summarizeTestSource(
      'it("renders", () => { const v: number = 1; expect(render(<A />)).toBeTruthy(); });\nit("renders", () => { expect(v).toBe(1); });',
      'a.test.tsx',
    );
    expect(summary!.tests.map((t) => t.key)).toEqual(['renders', 'renders #2']);
  });

  it('returns null for files that do not parse', async () => {
    expect(await summarizeTestSource('it("x", () => { expect(', 'broken.test.js')).toBeNull();
  });
});

// ─── Pure comparisons ──────────────────────────────────────────────────────────

describe('compareSnapshots', () => {
  const snap = (entries: Record<string, string>): string =>
    '// Jest Snapshot v1\n\n' + Object.entries(entries).map(([k, v]) => `exports[\`${k}\`] = \`${v}\`;\n`).join('\n');

  it('ignores added snapshots and reports rewritten or removed ones', () => {
    const before = snap({ 'App renders 1': '<div>Hi</div>', 'App renders 2': '<p/>' });
    expect(compareSnapshots('a.snap', before, snap({ 'App renders 1': '<div>Hi</div>', 'App renders 2': '<p/>', 'new 1': 'x' }))).toEqual([]);
    const [finding] = compareSnapshots('a.snap', before, snap({ 'App renders 1': '<div>Bye</div>' }));
    expect(finding).toMatchObject({ check: 'snapshots-rewritten', severity: 'warning' });
    expect(finding.message).toContain('1 of 2 rewritten, 1 removed');
  });
});

describe('compareTestScripts', () => {
  const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts });

  it('reports test commands that can now pass without running every test', () => {
    const [finding] = compareTestScripts('package.json', pkg({ test: 'vitest run' }), pkg({ test: 'vitest run --passWithNoTests || true' }));
    expect(finding.details).toEqual(['scripts.test: `vitest run` -> `vitest run --passWithNoTests || true`']);
    expect(compareTestScripts('package.json', pkg({ test: 'jest' }), pkg({ test: 'echo ok' }))[0].details![0]).toContain('no longer runs a test runner');
    expect(compareTestScripts('package.json', pkg({ test: 'mocha test/' }), pkg({}))[0].details![0]).toContain('removed');
  });

  it('ignores harmless script edits (shapes from pmndrs/zustand and vercel/swr history)', () => {
    // Quote style only
    expect(compareTestScripts('package.json', pkg({ test: "pnpm run '/^test:.*/' && vitest" }), pkg({ test: 'pnpm run "/^test:.*/" && vitest' }))).toEqual([]);
    // test:lint / test:format run linters, not tests
    expect(compareTestScripts('package.json', pkg({ 'test:lint': 'eslint --c .eslintrc.json src' }), pkg({ 'test:lint': 'eslint .' }))).toEqual([]);
    // Config paths, env vars and reporters do not weaken the run
    expect(compareTestScripts('package.json', pkg({ 'test:e2e': 'playwright test' }), pkg({ 'test:e2e': 'playwright test -c test/e2e/playwright.config.ts' }))).toEqual([]);
    expect(compareTestScripts('package.json', pkg({ 'test:build': 'jest --config a.js' }), pkg({ 'test:build': 'SWR_BUILD=1 jest --config a.js' }))).toEqual([]);
    expect(compareTestScripts('package.json', pkg({ test: 'vitest run', build: 'tsc' }), pkg({ test: 'vitest run', build: 'tsup' }))).toEqual([]);
  });
});

// ─── Real Git repositories ─────────────────────────────────────────────────────

const ADD_TEST = `import { add } from './add';
describe('add', () => {
  it('adds positives', () => {
    expect(add(2, 2)).toBe(4);
    expect(add(3, 4)).toBe(7);
  });
  it('adds negatives', () => {
    expect(add(-1, 1)).toBe(0);
  });
});
`;

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
const write = (rel: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commitAll = (message = 'commit'): void => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
};
const run = async (options: { base?: string; staged?: boolean } = {}): Promise<TestIntegrityFinding[]> =>
  (await analyzeTestIntegrity({ cwd: repo, ...options })).findings;
const checksOf = (findings: TestIntegrityFinding[]): string[] => findings.map((f) => f.check);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-integrity-'));
  git('init', '-q', '-b', 'main');
  write('src/add.js', 'export const add = (a, b) => a + b;\n');
  write('src/add.test.js', ADD_TEST);
  write('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }, null, 2));
  commitAll('initial');
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('test integrity: changes that keep the tests intact', () => {
  it('reports nothing for source-only changes', async () => {
    write('src/add.js', 'export const add = (a, b) => Number(a) + Number(b);\n');
    expect(await run()).toEqual([]);
  });

  it('reports nothing when tests are renamed or assertions are kept', async () => {
    write('src/add.test.js', ADD_TEST.replace("'adds positives'", "'adds two positive numbers'").replace('expect(add(3, 4)).toBe(7);', 'expect(add(3, 4)).toEqual(7);'));
    expect(await run()).toEqual([]);
  });

  it('reports nothing when tests and assertions are added', async () => {
    write('src/add.test.js', ADD_TEST.replace('});\n\n', "});\n").replace("describe('add', () => {", "describe('add', () => {\n  it('adds zero', () => { expect(add(0, 5)).toBe(5); });"));
    write('src/sub.test.js', "it('subtracts', () => { expect(1 - 1).toBe(0); });\n");
    expect(await run()).toEqual([]);
  });

  it('compares a renamed test file with its old version instead of reporting a deletion', async () => {
    git('mv', 'src/add.test.js', 'src/math.test.js');
    expect(await run()).toEqual([]);
  });

  it('ignores deleted files under test folders that contained no tests (shape from vercel/swr)', async () => {
    write('e2e/site/next.config.js', 'module.exports = {};\n');
    write('tests/helpers/server.js', 'export const start = () => listen(0);\n');
    commitAll('e2e site');
    fs.rmSync(path.join(repo, 'e2e/site/next.config.js'));
    fs.rmSync(path.join(repo, 'tests/helpers/server.js'));
    expect(await run()).toEqual([]);
  });

  it('analyzes test files that carry eslint-disable comments for unknown rules (shape from sindresorhus/ky)', async () => {
    write('src/retry.test.ts', '// eslint-disable-next-line @typescript-eslint/no-empty-function\nconst noop = (): void => {};\nit("retries", async () => {\n  // eslint-disable-next-line no-await-in-loop\n  expect(await retry(noop)).toBe(2);\n  expect(calls).toBe(2);\n});\n');
    commitAll('ts test');
    write('src/retry.test.ts', '// eslint-disable-next-line @typescript-eslint/no-empty-function\nconst noop = (): void => {};\nit("retries", async () => {\n  // eslint-disable-next-line no-await-in-loop\n  expect(await retry(noop)).toBe(2);\n});\n');
    const report = await analyzeTestIntegrity({ cwd: repo });
    expect(report.errors).toEqual([]);
    expect(report.findings.map((f) => f.check)).toEqual(['assertions-removed']);
  });

  it('treats tests moved to another file as moved, and reports only the ones that are gone', async () => {
    // Shape from sindresorhus/ky: small test files consolidated into a larger one.
    write('src/a.test.js', "it('keeps retries', () => { expect(a()).toBe(1); });\nit('old behaviour', () => { expect(b()).toBe(2); });\n");
    write('src/b.test.js', "it('existing', () => { expect(c()).toBe(3); });\n");
    commitAll('tests');
    fs.rmSync(path.join(repo, 'src/a.test.js'));
    write('src/b.test.js', "it('existing', () => { expect(c()).toBe(3); });\nit('keeps retries', () => { expect(a()).toBe(1); });\n");
    const [finding, ...rest] = await run();
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ check: 'test-file-deleted', file: 'src/a.test.js', details: ['old behaviour'] });
    expect(finding.message).toContain('with 1 test (1 more moved to other files)');
  });

  it('does not report a test moved between suites of the same file', async () => {
    write('src/m.test.js', "describe('a', () => { it('x', () => { expect(f()).toBe(1); }); });\ndescribe('b', () => { it('y', () => { expect(g()).toBe(1); }); });\n");
    commitAll('tests');
    write('src/m.test.js', "describe('b', () => { it('y', () => { expect(g()).toBe(1); });\n  it('x', () => { expect(f()).toBe(1); }); });\n");
    expect(await run()).toEqual([]);
  });

  it('handles repositories without commits', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-integrity-empty-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: fresh });
      fs.writeFileSync(path.join(fresh, 'a.test.js'), "it('a', () => { expect(1 + x).toBe(2); });\n");
      expect((await analyzeTestIntegrity({ cwd: fresh })).findings).toEqual([]);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('test integrity: weakening that must be disclosed', () => {
  it('reports removed assertions in a test that still exists', async () => {
    write('src/add.test.js', ADD_TEST.replace('    expect(add(3, 4)).toBe(7);\n', ''));
    const [finding] = await run();
    expect(finding).toMatchObject({ check: 'assertions-removed', severity: 'warning', file: 'src/add.test.js' });
    expect(finding.details).toEqual(['add > adds positives (2 -> 1)']);
  });

  it('reports exact assertions replaced with weak ones', async () => {
    write('src/add.test.js', ADD_TEST.replace('expect(add(-1, 1)).toBe(0);', 'expect(add(-1, 1)).toBeDefined();'));
    const [finding] = await run();
    expect(finding).toMatchObject({ check: 'assertions-weakened' });
    expect(finding.details).toEqual(['add > adds negatives (1 exact assertion replaced)']);
  });

  it('reports existing tests that are now skipped, without also calling them removed', async () => {
    write('src/add.test.js', ADD_TEST.replace("it('adds negatives'", "it.skip('adds negatives'"));
    const findings = await run();
    expect(checksOf(findings)).toEqual(['test-skipped']);
    expect(findings[0].details).toEqual(['add > adds negatives']);
  });

  it('reports removed tests', async () => {
    write('src/add.test.js', ADD_TEST.replace(/  it\('adds negatives'[\s\S]*?\n  \}\);\n/, ''));
    const findings = await run();
    expect(checksOf(findings)).toEqual(['tests-removed']);
    expect(findings[0].message).toContain('1 test removed (2 -> 1)');
  });

  it('reports a deleted test file with its test count', async () => {
    fs.rmSync(path.join(repo, 'src/add.test.js'));
    const [finding] = await run();
    expect(finding).toMatchObject({ check: 'test-file-deleted', file: 'src/add.test.js', deleted: true });
    expect(finding.message).toContain('with 2 tests');
  });

  it('reports deleted TypeScript/TSX test files with their test count', async () => {
    // Regression: TS files must be parsed, not silently summarized as "no tests".
    write('src/view.test.tsx', 'it("renders", () => { const n: number = 1; expect(render(<View n={n} />)).toBeTruthy(); });\n');
    commitAll('tsx test');
    fs.rmSync(path.join(repo, 'src/view.test.tsx'));
    const [finding] = await run();
    expect(finding).toMatchObject({ check: 'test-file-deleted', file: 'src/view.test.tsx' });
    expect(finding.message).toContain('with 1 test');
  });

  it('reports a changed test script', async () => {
    write('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run --passWithNoTests' } }, null, 2));
    expect(checksOf(await run())).toEqual(['test-script-changed']);
  });

  it('reports test configs that gain exclusions', async () => {
    write('vitest.config.ts', 'export default { test: { include: ["src/**/*.test.js"] } };\n');
    commitAll('config');
    write('vitest.config.ts', 'export default { test: { include: ["src/**/*.test.js"],\n  exclude: ["src/add.test.js"] } };\n');
    const [finding] = await run();
    expect(finding).toMatchObject({ check: 'test-config-changed' });
    expect(finding.details).toEqual(['+ exclude: ["src/add.test.js"] } };']);
  });

  it('reports rewritten snapshots', async () => {
    write('src/__snapshots__/add.test.js.snap', '// Jest Snapshot v1\n\nexports[`add renders 1`] = `"4"`;\n');
    commitAll('snap');
    write('src/__snapshots__/add.test.js.snap', '// Jest Snapshot v1\n\nexports[`add renders 1`] = `"5"`;\n');
    expect(checksOf(await run())).toEqual(['snapshots-rewritten']);
  });
});

describe('test integrity: focused tests are errors', () => {
  it('reports .only added to an existing test', async () => {
    write('src/add.test.js', ADD_TEST.replace("it('adds negatives'", "it.only('adds negatives'"));
    const [finding] = await run();
    expect(finding).toMatchObject({ check: 'focused-test', severity: 'error', line: 7 });
  });

  it('reports focused tests in brand-new test files', async () => {
    write('src/new.test.js', "fdescribe('new', () => { it('x', () => { expect(f()).toBe(1); }); });\n");
    expect(checksOf(await run())).toEqual(['focused-test']);
  });
});

describe('test integrity: comparison modes', () => {
  it('compares committed branch work through the merge-base', async () => {
    git('checkout', '-q', '-b', 'feature');
    write('src/add.test.js', ADD_TEST.replace('    expect(add(3, 4)).toBe(7);\n', ''));
    commitAll('weaken');
    expect(await run()).toEqual([]); // nothing uncommitted
    expect(checksOf(await run({ base: 'main' }))).toEqual(['assertions-removed']);
  });

  it('compares the index in staged mode', async () => {
    write('src/add.test.js', ADD_TEST.replace("it('adds negatives'", "it.skip('adds negatives'"));
    expect(await run({ staged: true })).toEqual([]);
    git('add', 'src/add.test.js');
    expect(checksOf(await run({ staged: true }))).toEqual(['test-skipped']);
  });

  it('rejects unsafe refs and unknown bases instead of comparing with something else', async () => {
    await expect(run({ base: '--output=/tmp/x' })).rejects.toThrow('Invalid Git ref');
    await expect(run({ base: 'no-such-branch' })).rejects.toThrow(/Cannot resolve/);
  });
});

describe('change set', () => {
  it('lists renames, deletions and untracked files with before/after content', () => {
    git('mv', 'src/add.js', 'src/sum.js');
    fs.rmSync(path.join(repo, 'package.json'));
    write('notes.md', 'hi');
    const cs = getChangeSet({ cwd: repo });
    expect(cs.files.map((f) => [f.status, f.oldPath, f.path]).sort()).toEqual([
      ['deleted', 'package.json', 'package.json'],
      ['renamed', 'src/add.js', 'src/sum.js'],
      ['untracked', 'notes.md', 'notes.md'],
    ]);
    expect(readBefore(cs, 'src/add.js')).toContain('a + b');
  });

  it('reports the line numbers a change added, even for lines starting with "++"', () => {
    write('src/add.js', 'export const add = (a, b) => a + b;\nlet i = 0;\n++ i;\n');
    const cs = getChangeSet({ cwd: repo });
    const changes = getLineChanges(cs).get('src/add.js')!;
    expect([...(changes.added as Set<number>)]).toEqual([2, 3]);
    expect(changes.addedText.get(3)).toBe('++ i;');
  });
});

describe('changed --test-integrity merge', () => {
  it('adds findings as virtual-rule issues with correct totals and fail-on behaviour', async () => {
    write('src/add.test.js', ADD_TEST.replace("it('adds negatives'", "it.only('adds negatives'"));
    fs.rmSync(path.join(repo, 'src/add.js'));
    const report = await analyzeTestIntegrity({ cwd: repo });
    const empty: RunResult = {
      files: [], totalErrors: 0, totalWarnings: 0, totalIssues: 0, filesScanned: 0, ruleBreakdown: new Map(),
      topFiles: [], durationMs: 0, ecosystemIssues: [], parserErrors: [], ignoredFiles: [], tsParserAvailable: true,
    };
    const merged = mergeTestIntegrity(empty, report, repo);
    expect(merged).toMatchObject({ totalErrors: 1, totalWarnings: 0, totalIssues: 1 });
    expect(merged.files[0].issues[0].ruleId).toBe('ai-guard/test-integrity/focused-test');
    expect(getFailOnExitCode(merged, 'high')).toBe(1);
    expect(getFailOnExitCode(merged, 'none')).toBe(0);
  });

  it('warnings do not fail the default gate but do fail --fail-on medium', async () => {
    write('src/add.test.js', ADD_TEST.replace("it('adds negatives'", "it.skip('adds negatives'"));
    const report = await analyzeTestIntegrity({ cwd: repo });
    const empty: RunResult = {
      files: [], totalErrors: 0, totalWarnings: 0, totalIssues: 0, filesScanned: 0, ruleBreakdown: new Map(),
      topFiles: [], durationMs: 0, ecosystemIssues: [], parserErrors: [], ignoredFiles: [], tsParserAvailable: true,
    };
    const merged = mergeTestIntegrity(empty, report, repo);
    expect(getFailOnExitCode(merged, 'high')).toBe(0);
    expect(getFailOnExitCode(merged, 'medium')).toBe(1);
  });
});
