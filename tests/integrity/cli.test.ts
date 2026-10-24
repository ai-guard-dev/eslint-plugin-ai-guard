/**
 * End-to-end: the built CLI (`ai-guard integrity`, `ai-guard changed
 * --integrity`) against temporary Git repositories. One finding set must drive
 * every output and the exit code.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { createTempRepo, type TempRepo } from '../helpers/git-repo';

const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');
const TESTS = `describe('cart', () => {\n  it('adds', () => { expect(1).toBe(1); });\n  it('totals', () => { expect(2).toBe(2); });\n});\n`;

let repo: TempRepo | null = null;
afterEach(() => { repo?.cleanup(); repo = null; });

interface Run { status: number | null; stdout: string; stderr: string; summary: string; outputs: string }

function runCli(r: TempRepo, args: string[], gha = false): Run {
  const summary = path.join(r.dir, '.git', 'summary.md');
  const outputs = path.join(r.dir, '.git', 'outputs.txt');
  fs.writeFileSync(summary, '');
  fs.writeFileSync(outputs, '');
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: r.dir, encoding: 'utf8',
    env: {
      ...process.env, NO_COLOR: '1', GITHUB_BASE_REF: '', CI: '',
      GITHUB_ACTIONS: gha ? 'true' : '', GITHUB_STEP_SUMMARY: gha ? summary : '', GITHUB_OUTPUT: gha ? outputs : '',
    },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, summary: fs.readFileSync(summary, 'utf8'), outputs: fs.readFileSync(outputs, 'utf8') };
}

function weakened(): TempRepo {
  repo = createTempRepo({ 'src/cart.test.ts': TESTS, 'src/util.js': 'export const a = 1;\n' });
  repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.skip('adds'"));
  repo.write('src/util.js', 'export const a = 1;\n// eslint-disable-next-line no-console -- debug\nconsole.log(a);\n');
  return repo;
}

describe('ai-guard integrity', () => {
  it('report mode: lists findings and exits 0', () => {
    const r = runCli(weakened(), ['integrity']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 high-confidence, 1 advisory');
    expect(r.stdout).toContain('Skipped the existing test "cart > adds"');
  }, 60000);

  it('enforce mode: exits 1 on a high-confidence finding, 0 when only advisories remain', () => {
    const r = weakened();
    expect(runCli(r, ['integrity', '--enforce']).status).toBe(1);
    r.write('src/cart.test.ts', TESTS);
    expect(runCli(r, ['integrity', '--enforce']).status).toBe(0);
  }, 60000);

  it('JSON, SARIF, annotations, summary and outputs carry the same findings', () => {
    const r = weakened();
    const json = JSON.parse(runCli(r, ['integrity', '--json']).stdout);
    expect(json).toMatchObject({ mode: 'report', highCount: 1, advisoryCount: 1, blocking: false });
    const fingerprints = json.findings.map((f: { ruleId: string }) => f.ruleId).sort();

    const sarifRun = runCli(r, ['integrity', '--sarif', '--enforce'], true);
    expect(sarifRun.status).toBe(1);
    const sarif = JSON.parse(sarifRun.stdout);
    const results = sarif.runs[0].results;
    expect(results.map((x: { ruleId: string }) => x.ruleId).sort()).toEqual(fingerprints);
    expect(results.map((x: { level: string }) => x.level).sort()).toEqual(['error', 'note']);
    expect(results.every((x: { properties: { aiGuardIntegrity: boolean } }) => x.properties.aiGuardIntegrity)).toBe(true);
    expect(results[0].partialFingerprints['ai-guard/v1']).toMatch(/^[0-9a-f]{64}$/);
    expect(sarif.runs[0].automationDetails.id).toBe('ai-guard');
    expect(results.every((x: { properties: Record<string, unknown> }) => !('security-severity' in x.properties))).toBe(true);

    // Annotations go to stderr because stdout carries SARIF.
    expect(sarifRun.stderr.match(/^::(error|notice) /gm)).toHaveLength(2);
    expect(sarifRun.summary).toContain('### Check integrity');
    expect(sarifRun.summary).toContain('Skipped the existing test');
    expect(sarifRun.outputs).toContain('integrity-high-count=1');
    expect(sarifRun.outputs).toContain('integrity-advisory-count=1');
  }, 60000);

  it('--accept records findings explicitly, is refused in CI, and accepted findings stop failing', () => {
    const r = weakened();
    const refused = spawnSync(process.execPath, [cli, 'integrity', '--accept', 'all'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } });
    expect(refused.status).toBe(2);
    expect(fs.existsSync(path.join(r.dir, '.ai-guard-baseline.json'))).toBe(false);

    // A bare --accept accepts nothing: a selection is required.
    expect(runCli(r, ['integrity', '--accept']).status).not.toBe(0);
    expect(fs.existsSync(path.join(r.dir, '.ai-guard-baseline.json'))).toBe(false);

    const accepted = runCli(r, ['integrity', '--accept', 'all']);
    expect(accepted.status).toBe(0);
    const baseline = JSON.parse(fs.readFileSync(path.join(r.dir, '.ai-guard-baseline.json'), 'utf8'));
    expect(baseline.integrity.accepted).toHaveLength(2);

    const after = JSON.parse(runCli(r, ['integrity', '--json', '--enforce']).stdout);
    // The skip is accepted; the new acceptance itself is reported for reviewers (advisory).
    expect(after.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(['ai-guard/integrity-acceptance-added']);
    expect(after.accepted).toBe(2);
    expect(runCli(r, ['integrity', '--enforce']).status).toBe(0);
  }, 60000);

  it('exits 2 with an actionable message when the base is missing or the directory is not a repository', () => {
    const r = weakened();
    const missing = runCli(r, ['integrity', '--base', 'does-not-exist']);
    expect(missing.status).toBe(2);
    expect(missing.stdout + missing.stderr).toContain('fetch-depth: 0');
    const json = JSON.parse(runCli(r, ['integrity', '--base', '--bad', '--json']).stdout);
    expect(json.error.code).toBe('INVALID_REF');
  }, 60000);
});

describe('ai-guard changed --integrity', () => {
  it('human mode renders lint findings and check integrity (regression: log.summary crash)', () => {
    const r = weakened();
    r.write('src/util.js', 'try { run(); } catch (e) {}\n');
    const out = runCli(r, ['changed', '--integrity', 'report']);
    expect(out.stderr).not.toContain('is not a function');
    expect(out.stdout).toContain('Check Integrity');
    expect(out.stdout).toContain('Skipped the existing test');
    expect(out.status).toBe(1); // lint error (no-empty-catch) under the default fail-on
  }, 60000);

  it('without --integrity the output and exit code are unchanged', () => {
    const r = weakened();
    const json = JSON.parse(runCli(r, ['changed', '--json']).stdout);
    expect(json.integrity).toBeUndefined();
    expect(runCli(r, ['changed']).status).toBe(0);
  }, 60000);

  it('report never changes the exit code; enforce fails on high-confidence findings', () => {
    const r = weakened();
    const report = runCli(r, ['changed', '--json', '--integrity', 'report', '--fail-on', 'none']);
    expect(report.status).toBe(0);
    expect(JSON.parse(report.stdout).integrity).toMatchObject({ mode: 'report', highCount: 1 });
    const enforce = runCli(r, ['changed', '--json', '--integrity', 'enforce', '--fail-on', 'none']);
    expect(enforce.status).toBe(1);
    expect(JSON.parse(enforce.stdout).integrity.blocking).toBe(true);
  }, 60000);

  it('analyzes config-only changes even when no JS/TS file changed', () => {
    repo = createTempRepo({ 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' });
    repo.write('tsconfig.json', '{ "compilerOptions": { "strict": false } }');
    const out = runCli(repo, ['changed', '--json', '--integrity', 'enforce']);
    expect(out.status).toBe(1);
    expect(JSON.parse(out.stdout).integrity.findings[0]).toMatchObject({ ruleId: 'ai-guard/integrity-tsconfig-weakened', file: 'tsconfig.json' });
  }, 60000);

  it('SARIF from changed contains lint and integrity results, counted separately in run properties', () => {
    const r = weakened();
    r.write('src/util.js', 'try { run(); } catch (e) {}\n');
    const sarif = JSON.parse(runCli(r, ['changed', '--sarif', '--integrity', 'report']).stdout);
    const results = sarif.runs[0].results;
    expect(results.filter((x: { properties?: { aiGuardIntegrity?: boolean } }) => x.properties?.aiGuardIntegrity)).toHaveLength(1);
    expect(results.filter((x: { ruleId: string }) => x.ruleId === 'ai-guard/no-empty-catch')).toHaveLength(1);
    expect(sarif.runs[0].properties).toMatchObject({ integrityMode: 'report', integrityFindingsCount: 1 });
  }, 60000);

  it('enforce exits 2 when integrity cannot run (unknown PR base)', () => {
    const r = weakened();
    const out = runCli(r, ['changed', '--json', '--base', 'no-such-branch', '--integrity', 'enforce', '--fail-on', 'none']);
    expect(out.status).toBe(2);
    expect(JSON.parse(out.stdout).integrity.error.code).toBe('BASE_NOT_FOUND');
    // Report mode warns but keeps the lint exit code.
    expect(runCli(r, ['changed', '--json', '--base', 'no-such-branch', '--integrity', 'report', '--fail-on', 'none']).status).toBe(0);
  }, 60000);

  it('rejects unknown modes', () => {
    const r = weakened();
    expect(runCli(r, ['changed', '--integrity', 'strict']).status).toBe(1);
    expect(runCli(r, ['changed', '--inline-suppressions', 'never']).status).toBe(1);
  }, 60000);
});

describe('suppression and acceptance audit', () => {
  it('allow-mode lint hides a new suppressed finding, but integrity enforce still fails on the new directive', () => {
    repo = createTempRepo({ 'src/a.js': 'export const a = 1;\n' });
    repo.write('src/a.js', '// eslint-disable-next-line ai-guard/no-empty-catch\ntry { run(); } catch (e) {}\n');
    const lintOnly = runCli(repo, ['changed', '--json', '--fail-on', 'any']);
    expect(lintOnly.status).toBe(0);
    expect(JSON.parse(lintOnly.stdout).suppressedIssues).toHaveLength(1);
    const enforced = runCli(repo, ['changed', '--json', '--fail-on', 'any', '--integrity', 'enforce']);
    expect(enforced.status).toBe(1);
    expect(JSON.parse(enforced.stdout).integrity.findings[0]).toMatchObject({ ruleId: 'ai-guard/integrity-lint-suppression', tier: 'high' });
  }, 60000);

  it('a directive with a reason is reported but advisory (documented trade-off)', () => {
    repo = createTempRepo({ 'src/a.js': 'export const a = 1;\n' });
    repo.write('src/a.js', '// eslint-disable-next-line ai-guard/no-empty-catch -- optional cleanup\ntry { run(); } catch (e) {}\n');
    const out = runCli(repo, ['changed', '--json', '--integrity', 'enforce']);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).integrity.findings[0]).toMatchObject({ tier: 'advisory' });
  }, 60000);

  it('--accept selects by fingerprint or rule ID, rejects unknown selections, and never accepts the acceptance record', () => {
    const r = weakened();
    const json = JSON.parse(runCli(r, ['integrity', '--json']).stdout);
    const skip = json.findings.find((f: { ruleId: string }) => f.ruleId.endsWith('test-skipped'));
    expect(runCli(r, ['integrity', '--accept', 'deadbeefdeadbeef']).status).toBe(2);
    expect(runCli(r, ['integrity', '--accept', 'not-a-selection']).status).toBe(2);
    const one = runCli(r, ['integrity', '--accept', `#${skip.fingerprint.slice(0, 10)}`]);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain('accepted #');
    const after = JSON.parse(runCli(r, ['integrity', '--json']).stdout);
    expect(after.findings.map((f: { ruleId: string }) => f.ruleId).sort()).toEqual(['ai-guard/integrity-acceptance-added', 'ai-guard/integrity-lint-suppression']);
    // "all" does not include the acceptance record, so it stays visible.
    runCli(r, ['integrity', '--accept', 'all']);
    const final = JSON.parse(runCli(r, ['integrity', '--json']).stdout);
    expect(final.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(['ai-guard/integrity-acceptance-added']);
    expect(runCli(r, ['integrity', '--accept', 'integrity-acceptance-added']).status).toBe(2);
  }, 90000);
});
