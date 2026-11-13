/**
 * `ai-guard baseline create | check` end to end, against the built CLI in a
 * throwaway project.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, afterEach, vi } from 'vitest';

// These tests run real Git processes; the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createTempRepo, type TempRepo } from '../helpers/git-repo';

const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');
const EMPTY_CATCH = 'export function legacy() {\n  try { run(); } catch (e) {}\n}\n';

let repo: TempRepo | null = null;
afterEach(() => { repo?.cleanup(); repo = null; });

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, 'baseline', ...args], {
    cwd: repo!.dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const baselineFile = (): string => path.join(repo!.dir, '.ai-guard-baseline.json');

describe('ai-guard baseline', () => {
  it('create records existing findings in a versioned file', () => {
    repo = createTempRepo({ 'src/legacy.js': EMPTY_CATCH });
    const r = run(['create', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'create', version: 1, preset: 'recommended', mode: 'stable', totalIssues: 1 });
    const saved = JSON.parse(fs.readFileSync(baselineFile(), 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.entries).toEqual([
      { filePath: 'src/legacy.js', issues: [expect.objectContaining({ ruleId: 'ai-guard/no-empty-catch', line: 2 })] },
    ]);
  }, 60000);

  it('check passes when nothing new was introduced, including after a file is moved', () => {
    repo = createTempRepo({ 'src/legacy.js': EMPTY_CATCH });
    expect(run(['create']).status).toBe(0);
    const clean = run(['check', '--json']);
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ action: 'check', newIssues: 0, matched: 1, movedMatches: 0 });

    repo.rename('src/legacy.js', 'lib/legacy.js');
    const moved = run(['check', '--json']);
    expect(moved.status).toBe(0);
    expect(JSON.parse(moved.stdout)).toMatchObject({ newIssues: 0, movedMatches: 1 });
  }, 60000);

  it('check reports a newly introduced finding with its severity and fails', () => {
    repo = createTempRepo({ 'src/legacy.js': EMPTY_CATCH });
    expect(run(['create']).status).toBe(0);
    repo.write('src/added.js', 'eval(userInput);\n');

    const json = run(['check', '--json']);
    expect(json.status).toBe(1);
    const out = JSON.parse(json.stdout);
    expect(out).toMatchObject({ newIssues: 1, newErrors: 1, matched: 1 });
    expect(out.files).toEqual([
      expect.objectContaining({ filePath: expect.stringMatching(/^src[\\/]added\.js$/), issues: [expect.objectContaining({ ruleId: 'ai-guard/no-eval-dynamic', severity: 2 })] }),
    ]);

    const human = run(['check']);
    expect(human.status).toBe(1);
    expect(human.stdout).toContain('1 new issue since baseline');
    expect(human.stdout).toContain('ai-guard/no-eval-dynamic');

    // --fail-on applies the normal failure policy to new findings only.
    expect(run(['check', '--fail-on', 'none']).status).toBe(0);
  }, 60000);

  it('check uses the preset stored in the baseline unless --preset overrides it', () => {
    repo = createTempRepo({ 'src/legacy.js': EMPTY_CATCH });
    expect(run(['create', '--preset', 'security']).status).toBe(0);
    expect(JSON.parse(run(['check', '--json']).stdout)).toMatchObject({ preset: 'security', baseline: { preset: 'security' } });
    expect(JSON.parse(run(['check', '--json', '--preset', 'strict']).stdout)).toMatchObject({ preset: 'strict' });
  }, 60000);

  it('keeps save, --save, --check and plain `baseline` working', () => {
    repo = createTempRepo({ 'src/legacy.js': EMPTY_CATCH });
    expect(run([]).stdout).toContain('Baseline saved');            // no baseline → create
    expect(run([]).stdout).toContain('No new issues since baseline'); // baseline → check
    expect(run(['save']).stdout).toContain('Baseline saved');
    expect(run(['--save']).stdout).toContain('Baseline saved');
    expect(run(['--check']).status).toBe(0);
    repo.write('src/added.js', 'eval(userInput);\n');
    expect(run(['--check']).status).toBe(1);
    expect(run(['bogus']).status).toBe(1);
  }, 90000);

  it('handles a missing, malformed or incompatible baseline', () => {
    repo = createTempRepo({ 'src/legacy.js': EMPTY_CATCH });
    const missing = run(['check', '--json']);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).error.code).toBe('BASELINE_MISSING');

    fs.writeFileSync(baselineFile(), '{ not json');
    const malformed = run(['check', '--json']);
    expect(malformed.status).toBe(1);
    expect(JSON.parse(malformed.stdout).error).toMatchObject({ code: 'BASELINE_INVALID', message: expect.stringContaining('not valid JSON') });

    fs.writeFileSync(baselineFile(), JSON.stringify({ version: 99, createdAt: 'x', preset: 'recommended', mode: 'stable', totalIssues: 0, entries: [] }));
    const incompatible = run(['check']);
    expect(incompatible.status).toBe(1);
    expect(incompatible.stderr).toContain('version 99 is newer than this ai-guard supports');
    // A file this version cannot read is never overwritten, not even by an explicit create.
    expect(run([]).status).toBe(1);
    const refused = run(['create', '--json']);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe('BASELINE_INCOMPATIBLE');
    expect(JSON.parse(fs.readFileSync(baselineFile(), 'utf8')).version).toBe(99);

    // A malformed file is never overwritten implicitly (plain `baseline` or check).
    fs.writeFileSync(baselineFile(), '{ not json');
    expect(run([]).status).toBe(1);
    expect(fs.readFileSync(baselineFile(), 'utf8')).toBe('{ not json');
    fs.writeFileSync(baselineFile(), JSON.stringify({ createdAt: 'x', preset: 'bogus', mode: 'stable', totalIssues: 0, entries: [] }));
    expect(JSON.parse(run(['check', '--json']).stdout).error.message).toContain('unknown preset');
  }, 60000);
});
