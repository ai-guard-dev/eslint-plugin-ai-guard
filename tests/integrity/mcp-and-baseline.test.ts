import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { createTempRepo, type TempRepo } from '../helpers/git-repo';
import { checkIntegrity } from '../../src/mcp/tools/check-integrity';
import { addIntegrityAcceptances, loadBaseline, loadIntegrityAcceptances } from '../../cli/utils/baseline';

const TESTS = `describe('cart', () => {\n  it('adds', () => { expect(1).toBe(1); });\n});\n`;

let repo: TempRepo | null = null;
afterEach(() => { repo?.cleanup(); repo = null; });

describe('MCP ai_guard_check_integrity', () => {
  it('returns the shared finding model with tiers and a blocking flag', async () => {
    repo = createTempRepo({ 'src/cart.test.ts': TESTS, 'src/a.js': 'export const a = 1;\n' });
    repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.only('adds'"));
    repo.write('src/a.js', 'export const a = 1;\n// eslint-disable-next-line no-console -- debug\nconsole.log(a);\n');
    const result = await checkIntegrity({}, repo.dir);
    expect(result).toMatchObject({
      success: true, status: 'complete', clean: false, hasBlockingFindings: true, highCount: 1, advisoryCount: 1,
      base: { ref: 'HEAD', head: 'working-tree' },
    });
    expect(result.findings[0]).toMatchObject({ ruleId: 'ai-guard/integrity-test-focused', tier: 'high', blocking: true, file: 'src/cart.test.ts', line: 2 });
  }, 60000);

  it('is clean for an unchanged repository and stays inside the workspace directory', async () => {
    repo = createTempRepo({ 'pkg/a.test.js': TESTS, 'other/b.test.js': TESTS });
    expect(await checkIntegrity({}, repo.dir)).toMatchObject({ success: true, clean: true, totalFindings: 0 });
    repo.write('other/b.test.js', TESTS.replace("it('adds'", "it.skip('adds'"));
    const scoped = await checkIntegrity({}, fs.realpathSync(path.join(repo.dir, 'pkg')));
    expect(scoped).toMatchObject({ success: true, clean: true });
    expect((await checkIntegrity({}, repo.dir)).totalFindings).toBe(1);
  }, 60000);

  it('validates input and reports Git problems as structured failures', async () => {
    repo = createTempRepo({ 'a.js': 'x\n' });
    expect(await checkIntegrity({ base: '--output=x' }, repo.dir)).toMatchObject({ success: false, status: 'failed', errors: [{ code: 'INVALID_GIT_REF' }] });
    expect(await checkIntegrity({ base: 'main', staged: true }, repo.dir)).toMatchObject({ errors: [{ code: 'INVALID_INPUT' }] });
    expect(await checkIntegrity({ base: 'missing-branch' }, repo.dir)).toMatchObject({ success: false, errors: [{ code: 'BASE_NOT_FOUND' }] });
    expect(await checkIntegrity({ maxFindings: 0 }, repo.dir)).toMatchObject({ errors: [{ code: 'INVALID_INPUT' }] });
    fs.writeFileSync(path.join(repo.dir, '.ai-guard-baseline.json'), '{ broken');
    expect(await checkIntegrity({}, repo.dir)).toMatchObject({ success: false, errors: [{ code: 'BASELINE_INVALID' }] });
  }, 60000);

  it('truncation is partial, never clean', async () => {
    repo = createTempRepo({ 'a.test.js': TESTS, 'b.test.js': TESTS });
    repo.write('a.test.js', TESTS.replace("it('adds'", "it.only('adds'"));
    repo.write('b.test.js', TESTS.replace("it('adds'", "it.only('adds'"));
    const result = await checkIntegrity({ maxFindings: 1 }, repo.dir);
    expect(result).toMatchObject({ success: true, status: 'partial', clean: false, truncated: true, totalFindings: 2 });
    expect(result.findings).toHaveLength(1);
  }, 60000);
});

describe('baseline file and integrity acceptances', () => {
  it('baseline --save preserves acceptances but never creates them', () => {
    repo = createTempRepo({ 'src/a.js': 'try { run(); } catch (e) {}\n' });
    const file = path.join(repo.dir, '.ai-guard-baseline.json');
    const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');
    const save = () => spawnSync(process.execPath, [cli, 'baseline', '--save'], { cwd: repo!.dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    expect(save().status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).integrity).toBeUndefined();

    addIntegrityAcceptances(file, [{ fingerprint: 'f1', ruleId: 'ai-guard/integrity-test-skipped', file: 'x.test.js', message: 'm' }], new Date('2026-01-01T00:00:00Z'));
    expect(save().status).toBe(0);
    const loaded = loadBaseline(file);
    expect(loaded.status === 'ok' && loaded.baseline.integrity?.accepted.map((a) => a.fingerprint)).toEqual(['f1']);
    expect(loaded.status === 'ok' && loaded.baseline.entries.length).toBe(1);
  }, 60000);

  it('addIntegrityAcceptances de-duplicates and validates the section on load', () => {
    repo = createTempRepo();
    const file = path.join(repo.dir, 'b.json');
    const f = { fingerprint: 'f1', ruleId: 'r', file: 'a', message: 'm' };
    expect(addIntegrityAcceptances(file, [f, f])).toEqual({ added: 1, total: 1 });
    expect(addIntegrityAcceptances(file, [f])).toEqual({ added: 0, total: 1 });
    expect(loadIntegrityAcceptances(file)).toMatchObject({ status: 'ok', accepted: [{ fingerprint: 'f1' }] });
    fs.writeFileSync(file, JSON.stringify({ entries: [], integrity: { accepted: [{ ruleId: 'r' }] } }));
    expect(loadIntegrityAcceptances(file).status).toBe('invalid');
    expect(loadIntegrityAcceptances(path.join(repo.dir, 'missing.json'))).toEqual({ status: 'ok', accepted: [] });
  });
});
