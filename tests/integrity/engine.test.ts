/**
 * Check-weakening (integrity) engine: realistic before/after changes in
 * temporary Git repositories. Each case asserts both the weakening that must
 * be reported and the safe look-alike that must not.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTempRepo, type TempRepo } from '../helpers/git-repo';
import { analyzeIntegrity, type AnalyzeOptions } from '../../cli/utils/integrity/engine';
import { IntegrityGitError } from '../../cli/utils/integrity/git';
import type { IntegrityFinding } from '../../cli/utils/integrity/types';

let repo: TempRepo | null = null;
afterEach(() => { repo?.cleanup(); repo = null; });

function setup(files: Record<string, string>): TempRepo {
  repo = createTempRepo(files);
  return repo;
}

async function analyze(r: TempRepo, opts: Partial<AnalyzeOptions> = {}): Promise<IntegrityFinding[]> {
  const report = await analyzeIntegrity({ cwd: r.dir, ...opts });
  return report.findings;
}

const ids = (fs: IntegrityFinding[]): string[] => fs.map((f) => `${f.tier}:${f.ruleId.replace('ai-guard/integrity-', '')}`).sort();

const TESTS = `describe('cart', () => {
  it('adds items', () => { expect(add(1, 2)).toBe(3); });
  it('removes items', () => { expect(remove([1], 1)).toEqual([]); });
  it('totals', () => { expect(total([1, 2])).toBe(3); });
});
`;

describe('suppressions', () => {
  it('reports newly added directives, not pre-existing or moved ones', async () => {
    const r = setup({
      'src/a.ts': '// eslint-disable-next-line no-console\nconsole.log(1);\nexport const a = 1;\n',
    });
    // Move the existing directive and add new ones.
    r.write('src/a.ts', [
      'export const a = 1;',
      '// eslint-disable-next-line no-console',
      'console.log(1);',
      '/* eslint-disable */',
      'try { run(); } catch (e) {} // eslint-disable-line ai-guard/no-empty-catch',
      '// eslint-disable-next-line no-alert -- legacy kiosk mode',
      'alert(1);',
      '',
    ].join('\n'));
    const findings = (await analyze(r)).filter((f) => f.ruleId.endsWith('lint-suppression'));
    expect(findings.map((f) => [f.tier, f.line])).toEqual([[ 'high', 4 ], [ 'high', 5 ], [ 'advisory', 6 ]]);
    expect(findings[0].message).toContain('all ESLint rules (including AI Guard rules) until the end of the file');
    expect(findings[1].message).toContain('ai-guard/no-empty-catch');
    expect(findings[2].message).toContain('legacy kiosk mode');
  });

  it('treats an unjustified directive for an unrelated rule as advisory', async () => {
    const r = setup({ 'src/a.js': 'export const a = 1;\n' });
    r.write('src/a.js', 'export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(a);\n');
    expect(ids(await analyze(r))).toEqual(['advisory:lint-suppression']);
  });

  it('reports broadened directives', async () => {
    const r = setup({ 'src/a.js': '// eslint-disable-next-line no-console\nconsole.log(1);\n' });
    r.write('src/a.js', '// eslint-disable-next-line\nconsole.log(1);\n');
    const [f] = await analyze(r);
    expect(f).toMatchObject({ tier: 'high', line: 1 });
    expect(f.message).toContain('all ESLint rules');
  });

  it('reports TypeScript suppressions by kind', async () => {
    const r = setup({ 'src/t.ts': 'export const n: number = 1;\n' });
    r.write('src/t.ts', '// @ts-nocheck\n// @ts-ignore\nexport const n: number = "x" as any;\n// @ts-expect-error -- upstream typing bug #12\nconst m: string = 1;\n');
    expect(ids(await analyze(r))).toEqual([
      'advisory:ts-suppression', 'advisory:unsafe-type-escape', 'high:ts-suppression', 'high:ts-suppression',
    ]);
  });

  it('ignores directive look-alikes in strings', async () => {
    const r = setup({ 'src/a.js': 'export const a = 1;\n' });
    r.write('src/a.js', 'export const a = "/* eslint-disable */ // @ts-ignore";\n');
    expect(await analyze(r)).toEqual([]);
  });
});

describe('tests', () => {
  it('reports skipped, focused and conditionally skipped tests', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', `describe('cart', () => {
  it.skip('adds items', () => { expect(add(1, 2)).toBe(3); });
  it.only('removes items', () => { expect(remove([1], 1)).toEqual([]); });
  it.skipIf(process.env.CI)('totals', () => { expect(total([1, 2])).toBe(3); });
});
`);
    const findings = await analyze(r);
    expect(ids(findings)).toEqual(['advisory:test-skipped', 'high:test-focused', 'high:test-skipped']);
    expect(findings.find((f) => f.ruleId.endsWith('test-skipped') && f.tier === 'high')!.message).toContain('"cart > adds items"');
  });

  it('supports xit/xdescribe/fit aliases and reports a skipped suite with its test count', async () => {
    const r = setup({ 'test/cart.spec.js': TESTS });
    r.write('test/cart.spec.js', TESTS.replace("describe('cart'", "xdescribe('cart'"));
    const [f] = await analyze(r);
    expect(f).toMatchObject({ ruleId: 'ai-guard/integrity-test-skipped', tier: 'high' });
    expect(f.message).toContain('suite "cart" (3 tests)');
  });

  it('ignores test calls in comments and strings, and nested suites count once', async () => {
    const r = setup({ 'src/n.test.js': `describe('outer', () => {\n  describe('inner', () => {\n    it('works', () => expect(1).toBe(1));\n  });\n});\n` });
    r.write('src/n.test.js', `describe('outer', () => {\n  // it.only('commented', () => {})\n  const s = "it.skip('string')";\n  describe('inner', () => {\n    it('works', () => expect(1).toBe(1));\n  });\n});\n`);
    expect(await analyze(r)).toEqual([]);
  });

  it('reports removed tests with before/after counts', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', TESTS.replace("  it('totals', () => { expect(total([1, 2])).toBe(3); });\n", ''));
    const findings = await analyze(r);
    const reduced = findings.find((f) => f.ruleId.endsWith('test-count-reduced'))!;
    expect(reduced).toMatchObject({ tier: 'high', before: '3', after: '2' });
    expect(reduced.message).toContain('"cart > totals"');
  });

  it('does not report tests moved to another file in the same change', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', TESTS.replace("  it('totals', () => { expect(total([1, 2])).toBe(3); });\n", ''));
    r.write('src/totals.test.ts', `describe('cart', () => {\n  it('totals', () => { expect(total([1, 2])).toBe(3); });\n});\n`);
    expect((await analyze(r)).filter((f) => f.category === 'tests')).toEqual([]);
  });

  it('reports a deleted test file, but not a renamed or relocated one', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS, 'src/other.test.ts': TESTS.replace(/cart/g, 'other') });
    r.remove('src/cart.test.ts');
    r.rename('src/other.test.ts', 'test/other.test.ts');
    const findings = await analyze(r);
    expect(ids(findings)).toEqual(['high:test-file-deleted']);
    expect(findings[0]).toMatchObject({ file: 'src/cart.test.ts', before: '3 tests', after: 'deleted' });
  });

  it('treats consolidation into parameterized tests as advisory', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', `describe('cart', () => {\n  it.each([[1, 2, 3]])('adds %i + %i', (a, b, c) => { expect(add(a, b)).toBe(c); });\n});\n`);
    const reduced = (await analyze(r)).find((f) => f.ruleId.endsWith('test-count-reduced'))!;
    expect(reduced.tier).toBe('advisory');
    expect(reduced.message).toContain('parameterized');
  });

  it('a new test added in a skipped state is advisory; an existing test turned todo counts as removed', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', TESTS
      .replace("  it('totals', () => { expect(total([1, 2])).toBe(3); });", "  it.todo('totals');")
      .replace('});\n', "  it.skip('discounts', () => {});\n});\n"));
    // The todo also dropped that test's assertion.
    expect(ids(await analyze(r))).toEqual(['advisory:assertions-reduced', 'advisory:test-skipped', 'high:test-count-reduced']);
  });

  it('reports weaker assertions as advisory only', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', TESTS
      .replace('expect(add(1, 2)).toBe(3)', 'expect(add(1, 2)).toBeTruthy()')
      .replace('expect(remove([1], 1)).toEqual([])', 'expect(remove([1], 1)).toEqual(expect.anything())')
      .replace(' expect(total([1, 2])).toBe(3); ', ' total([1, 2]); '));
    const findings = await analyze(r);
    expect(ids(findings)).toEqual(['advisory:assertion-loosened', 'advisory:assertions-reduced']);
    expect(findings.every((f) => !f.blocking)).toBe(true);
  });
});

describe('configuration', () => {
  it('coverage thresholds lowered or removed (package.json jest, vitest config, .nycrc)', async () => {
    const r = setup({
      'package.json': JSON.stringify({ name: 'x', jest: { coverageThreshold: { global: { lines: 90, branches: 80 } } } }, null, 2),
      'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { coverage: { thresholds: { lines: 85, functions: 85 } } } });\n",
      '.nycrc.json': JSON.stringify({ 'check-coverage': true, lines: 80 }),
    });
    r.write('package.json', JSON.stringify({ name: 'x', jest: { coverageThreshold: { global: { lines: 70 } } } }, null, 2));
    r.write('vitest.config.ts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { coverage: { thresholds: { lines: 90, functions: 60 } } } });\n");
    r.write('.nycrc.json', JSON.stringify({ 'check-coverage': false, lines: 80 }));
    const msgs = (await analyze(r)).map((f) => `${f.tier} ${f.file}: ${f.message}`);
    expect(msgs).toEqual([
      'high .nycrc.json: `check-coverage` turned off; coverage thresholds are no longer enforced.',
      'high package.json: Lowered coverage threshold `coverageThreshold.global.lines` from 90 to 70.',
      'high package.json: Removed coverage threshold `coverageThreshold.global.branches` (was 80).',
      'high vitest.config.ts: Lowered coverage threshold `test.coverage.thresholds.functions` from 85 to 60.',
    ]);
  });

  it('raising a threshold or reformatting the file is not reported', async () => {
    const r = setup({ 'jest.config.json': JSON.stringify({ coverageThreshold: { global: { lines: 80 } } }) });
    r.write('jest.config.json', JSON.stringify({ coverageThreshold: { global: { lines: 85 } } }, null, 4));
    expect(await analyze(r)).toEqual([]);
  });

  it('ESLint flat config: downgrades, AI Guard removal, explicit disables', async () => {
    const r = setup({
      'eslint.config.js': "import aiGuard from 'eslint-plugin-ai-guard';\nexport default [aiGuard.configs.recommended, { rules: { 'no-console': 'error', eqeqeq: ['error', 'always'] } }];\n",
    });
    r.write('eslint.config.js', "export default [{ rules: { 'no-console': 'warn', eqeqeq: ['error', 'smart'], 'no-debugger': 'off' } }];\n");
    expect((await analyze(r)).map((f) => `${f.tier} ${f.message}`)).toEqual([
      'high Lowered ESLint rule `no-console` from "error" to "warn".',
      'high Removed AI Guard (eslint-plugin-ai-guard) from this ESLint configuration.',
      'advisory Explicitly turned off ESLint rule `no-debugger`.',
    ]);
  });

  it('legacy .eslintrc.json with comments: AI Guard rule turned off and new ignore patterns', async () => {
    const r = setup({ '.eslintrc.json': '{\n  // shared\n  "plugins": ["ai-guard"],\n  "extends": ["plugin:ai-guard/recommended"],\n  "rules": {}\n}\n' });
    r.write('.eslintrc.json', '{\n  "plugins": ["ai-guard"],\n  "extends": ["plugin:ai-guard/recommended"],\n  "ignorePatterns": ["src/legacy/**"],\n  "rules": { "ai-guard/no-floating-promise": "off" },\n}\n');
    expect(ids(await analyze(r))).toEqual(['advisory:eslint-config-weakened', 'high:eslint-config-weakened']);
  });

  it('tsconfig: strict disabled, inherited values are advisory, tightening is silent', async () => {
    const r = setup({
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }',
      'packages/a/tsconfig.json': '{ "extends": "../../tsconfig.json", "compilerOptions": { "strict": true } }',
      'packages/b/tsconfig.json': '{ "compilerOptions": { "strict": false } }',
    });
    r.write('tsconfig.json', '{\n  // relaxed\n  "compilerOptions": { "strict": false, "noUncheckedIndexedAccess": true, },\n}');
    r.write('packages/a/tsconfig.json', '{ "extends": "../../tsconfig.json", "compilerOptions": {} }');
    r.write('packages/b/tsconfig.json', '{ "compilerOptions": { "strict": true } }');
    expect((await analyze(r)).map((f) => `${f.tier} ${f.file} ${f.before}->${f.after}`)).toEqual([
      'high tsconfig.json true->false',
      'advisory packages/a/tsconfig.json true->(inherited)',
    ]);
  });

  it('package.json scripts: exit masking, removed checks, removed test script, hook bypass', async () => {
    const r = setup({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run', ci: 'npm run lint && npm run typecheck && npm test', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'tsup' } }, null, 2) });
    r.write('package.json', JSON.stringify({ scripts: { ci: 'npm run lint && npm test', lint: 'eslint . || true', typecheck: 'tsc --noEmit', build: 'tsup', release: 'HUSKY=0 git push' } }, null, 2));
    expect((await analyze(r)).map((f) => `${f.ruleId.replace('ai-guard/integrity-', '')} ${f.message}`)).toEqual([
      'git-hook-bypass New script `release`: `HUSKY=0` disables Git hooks.',
      'verification-script-weakened Removed the `test` script (was `vitest run`).',
      'verification-script-weakened Script `ci`: removed `npm run typecheck`.',
      'verification-script-weakened Script `lint`: `|| true` makes the command succeed even when the check fails.',
    ]);
  });

  it('GitHub workflow: removed step, continue-on-error, if: false, removed trigger', async () => {
    const base = `on:\n  pull_request:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Lint\n        run: npm run lint\n      - name: Test\n        run: npm test\n      - name: Types\n        run: npx tsc --noEmit\n`;
    const r = setup({ '.github/workflows/ci.yml': base });
    r.write('.github/workflows/ci.yml', `on:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Test\n        run: npm test\n        continue-on-error: true\n      - name: Types\n        if: false\n        run: npx tsc --noEmit\n`);
    expect((await analyze(r)).map((f) => f.message)).toEqual([
      'Removed the `pull_request` trigger from a workflow that runs verification steps.',
      'Step "Lint" in job `test` was removed (ran `npm run lint`).',
      'Step "Test" in job `test` now sets `continue-on-error: true`; a failing check no longer fails the job.',
      'Step "Types" in job `test` is disabled with `if: false`.',
    ]);
  });

  it('GitHub workflow: moving a check to another job or workflow is not reported', async () => {
    const r = setup({ '.github/workflows/ci.yml': `on: [pull_request]\njobs:\n  all:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n      - run: npm test\n` });
    r.write('.github/workflows/ci.yml', `on: [pull_request]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n`);
    r.write('.github/workflows/test.yml', `on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
    expect(await analyze(r)).toEqual([]);
  });

  it('husky hooks: deleted hook and early exit', async () => {
    const r = setup({ '.husky/pre-commit': 'npx lint-staged\n', '.husky/pre-push': 'npm test\n' });
    r.remove('.husky/pre-push');
    r.write('.husky/pre-commit', 'exit 0\nnpx lint-staged\n');
    expect((await analyze(r)).map((f) => f.message)).toEqual([
      'Git hook `.husky/pre-commit` now exits before running its checks (`exit 0`).',
      'Deleted Git hook `.husky/pre-push` (ran `npm test`).',
    ]);
  });

  it('snapshot rewrites are advisory', async () => {
    const snap = (v: string) => ['a', 'b', 'c'].map((k) => `exports[\`${k} 1\`] = \`"${v}${k}"\`;\n`).join('\n');
    const r = setup({ 'src/__snapshots__/x.test.ts.snap': snap('old') });
    r.write('src/__snapshots__/x.test.ts.snap', snap('new'));
    expect(ids(await analyze(r))).toEqual(['advisory:snapshot-update']);
  });
});

describe('precision on real-world change shapes', () => {
  it('a CI test step moved to another job with new arguments is not a removal (sindresorhus/ky d93adf8)', async () => {
    const r = setup({ '.github/workflows/main.yml': `on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install\n      - run: npx playwright install --with-deps\n      - run: npm test\n` });
    r.write('.github/workflows/main.yml', `on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install\n      - run: npx ava 'test/**' '!test/browser.ts'\n  browser:\n    runs-on: macos-latest\n    steps:\n      - run: npm install\n      - run: npx playwright install --with-deps\n      - run: npm test -- test/browser.ts\n` );
    expect((await analyze(r)).filter((f) => f.tier === 'high')).toEqual([]);
  });

  it('changed arguments of a verification script are advisory; a removed command stays high', async () => {
    const r = setup({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run', ci: 'npm run lint && npm test' } }) });
    r.write('package.json', JSON.stringify({ scripts: { test: 'vitest run src/core', ci: 'npm test' } }));
    expect((await analyze(r)).map((f) => `${f.tier} ${f.message}`)).toEqual([
      'high Script `ci`: removed `npm run lint`.',
      'advisory Script `test`: arguments of `vitest run` changed; check that the same tests or files are still covered.',
    ]);
  });

  it('removing a duplicate test whose title still runs is advisory (expressjs/express 9c85a25)', async () => {
    const dup = `describe('res', () => {\n  it('keeps type', () => { expect(1).toBe(1); });\n  it('sends body', () => { expect(2).toBe(2); });\n  it('keeps type', () => { expect(1).toBe(1); });\n});\n`;
    const r = setup({ 'test/res.test.js': dup });
    r.write('test/res.test.js', dup.replace("  it('keeps type', () => { expect(1).toBe(1); });\n});", '});'));
    const [f] = (await analyze(r)).filter((x) => x.ruleId.endsWith('test-count-reduced'));
    expect(f).toMatchObject({ tier: 'advisory' });
    expect(f.message).toContain('duplicate');
  });
});

describe('base handling, acceptances and determinism', () => {
  it('compares against a branch merge-base and ignores conditions already on the base', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS.replace("it('totals'", "it.skip('totals'") });
    r.git('checkout', '-q', '-b', 'feature');
    r.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'").replace("it('adds items'", "it.skip('adds items'"));
    r.commit('feature');
    const findings = await analyze(r, { base: 'master', mergeBase: true });
    expect(findings.map((f) => f.message)).toEqual(['Skipped the existing test "cart > adds items"; it no longer runs.']);
  });

  it('staged mode compares the index, not unstaged edits', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'"));
    r.git('add', 'src/cart.test.ts');
    r.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'").replace("it('adds items'", "it.only('adds items'"));
    expect(ids(await analyze(r, { staged: true }))).toEqual(['high:test-skipped']);
    expect(ids(await analyze(r))).toEqual(['high:test-focused', 'high:test-skipped']);
  });

  it('handles paths with spaces and untracked files', async () => {
    const r = setup({ 'my dir/cart.test.ts': TESTS });
    r.write('my dir/cart.test.ts', TESTS.replace("it('totals'", "xit('totals'"));
    r.write('new dir/extra file.test.js', "it.only('x', () => {});\n");
    expect((await analyze(r)).map((f) => f.file).sort()).toEqual(['my dir/cart.test.ts', 'new dir/extra file.test.js']);
  });

  it('applies explicit acceptances by fingerprint and counts them', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'"));
    const [first] = await analyze(r);
    // Line shifts do not change the fingerprint.
    r.write('src/cart.test.ts', `// header\n${TESTS.replace("it('totals'", "it.skip('totals'")}`);
    const report = await analyzeIntegrity({ cwd: r.dir, acceptedFingerprints: [first.fingerprint] });
    expect(report.findings).toEqual([]);
    expect(report.accepted).toBe(1);
  });

  it('reports newly added acceptances in the baseline file as advisory', async () => {
    const r = setup({ '.ai-guard-baseline.json': JSON.stringify({ createdAt: 'x', preset: 'recommended', mode: 'stable', totalIssues: 0, entries: [] }) });
    r.write('.ai-guard-baseline.json', JSON.stringify({ createdAt: 'x', preset: 'recommended', mode: 'stable', totalIssues: 0, entries: [],
      integrity: { accepted: [{ fingerprint: 'abc', ruleId: 'ai-guard/integrity-test-skipped', file: 'a', message: 'm', acceptedAt: 'x' }] } }));
    expect(ids(await analyze(r))).toEqual(['advisory:acceptance-added']);
  });

  it('is deterministic', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS, 'src/a.js': 'export const a = 1;\n' });
    r.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'").replace("it('adds items'", "it.only('adds items'"));
    r.write('src/a.js', '/* eslint-disable */\nexport const a = 1;\n');
    const a = await analyzeIntegrity({ cwd: r.dir });
    const b = await analyzeIntegrity({ cwd: r.dir });
    expect(b).toEqual(a);
  });

  it('empty diff, unsupported files and a repository without commits', async () => {
    const r = setup({ 'README.md': '# x\n', 'src/a.js': 'export const a = 1;\n' });
    expect(await analyze(r)).toEqual([]);
    r.write('README.md', '# changed\nit.only("x")\n');
    r.write('image.png', 'not really');
    expect(await analyze(r)).toEqual([]);

    const empty = createTempRepo({ 'src/a.test.js': "it.only('x', () => {});\n" }, { commit: false });
    try {
      const report = await analyzeIntegrity({ cwd: empty.dir });
      expect(report.base).toMatchObject({ ref: '(empty tree)', commit: null });
      expect(ids(report.findings)).toEqual(['high:test-focused']);
    } finally {
      empty.cleanup();
    }
  });

  it('reports unparseable files as analysis errors instead of guessing', async () => {
    const r = setup({ 'src/a.test.js': TESTS });
    r.write('src/a.test.js', 'describe("x", () => { it.skip(');
    const report = await analyzeIntegrity({ cwd: r.dir });
    expect(report.findings).toEqual([]);
    expect(report.errors).toEqual([expect.objectContaining({ code: 'PARSE_ERROR', file: 'src/a.test.js' })]);
  });

  it('throws actionable errors for invalid refs, missing bases and non-repositories', async () => {
    const r = setup({ 'a.js': 'x\n' });
    await expect(analyzeIntegrity({ cwd: r.dir, base: '--upload-pack=evil' })).rejects.toMatchObject({ code: 'INVALID_REF' });
    await expect(analyzeIntegrity({ cwd: r.dir, base: 'no-such-branch', mergeBase: true })).rejects.toMatchObject({ code: 'BASE_NOT_FOUND' });
    const outside = createTempRepo();
    outside.git('init', '-q');
    try {
      const notRepo = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ai-guard-norepo-'));
      await expect(analyzeIntegrity({ cwd: notRepo })).rejects.toBeInstanceOf(IntegrityGitError);
      require('fs').rmSync(notRepo, { recursive: true, force: true });
    } finally {
      outside.cleanup();
    }
  });

  it('per-file mode (paths) reports test-count reductions as advisory', async () => {
    const r = setup({ 'src/cart.test.ts': TESTS });
    r.write('src/cart.test.ts', TESTS.replace("  it('totals', () => { expect(total([1, 2])).toBe(3); });\n", ''));
    const findings = await analyze(r, { paths: ['src/cart.test.ts'] });
    expect(findings.find((f) => f.ruleId.endsWith('test-count-reduced'))!.tier).toBe('advisory');
  });
});
