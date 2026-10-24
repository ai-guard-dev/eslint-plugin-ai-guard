/**
 * `ai-guard changed --baseline` — PR scans report only findings that are not
 * already recorded in the committed baseline. Runs the built CLI against a
 * throwaway git repository.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execFileSync } from 'child_process';

const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');

let repo: string;

function runCli(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '', ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

const LEGACY = 'export function legacy() {\n  try { run(); } catch (e) {}\n}\n';

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-changed-baseline-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'legacy.js'), LEGACY, 'utf8');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  // Record the existing empty catch in the baseline.
  const saved = runCli(['baseline', '--save']);
  expect(saved.status).toBe(0);

  // The "PR": a second, identical empty catch in the same legacy file.
  fs.writeFileSync(
    path.join(repo, 'src', 'legacy.js'),
    `${LEGACY}export function added() {\n  try { run(); } catch (e) {}\n}\n`,
    'utf8',
  );
}, 60000);

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('changed --baseline', () => {
  it('without --baseline, reports every finding in the changed file', () => {
    const r = runCli(['changed', '--json']);
    const out = JSON.parse(r.stdout);
    expect(out.totalIssues).toBe(2);
    expect(out.baseline).toBeUndefined();
  }, 60000);

  it('reports only the new finding and counts the suppressed one', () => {
    const r = runCli(['changed', '--json', '--baseline']);
    const out = JSON.parse(r.stdout);
    expect(out.totalIssues).toBe(1);
    expect(out.files[0].issues[0].line).toBe(5);
    expect(out.baseline).toEqual({ path: '.ai-guard-baseline.json', mode: 'stable', preset: 'recommended', suppressed: 1 });
    expect(r.status).toBe(1);
  }, 60000);

  it('filters SARIF output the same way', () => {
    const r = runCli(['changed', '--sarif', '--baseline']);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(5);
  }, 60000);

  it('passes once the new finding is gone', () => {
    const file = path.join(repo, 'src', 'legacy.js');
    const withNew = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${LEGACY}export function added() {\n  return run();\n}\n`, 'utf8');
    try {
      const r = runCli(['changed', '--json', '--baseline']);
      const out = JSON.parse(r.stdout);
      expect(out.totalIssues).toBe(0);
      expect(out.baseline.suppressed).toBe(1);
      expect(r.status).toBe(0);
    } finally {
      fs.writeFileSync(file, withNew, 'utf8');
    }
  }, 60000);

  it('exits 2 with a clear error when the baseline file is missing', () => {
    const r = runCli(['changed', '--json', '--baseline', 'missing-baseline.json']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('missing-baseline.json: file not found');
    expect(r.stderr).toContain('ai-guard baseline --save');
  }, 60000);

  it('exits 2 when the baseline file is corrupt instead of reporting everything', () => {
    fs.writeFileSync(path.join(repo, 'broken-baseline.json'), '{ nope', 'utf8');
    const r = runCli(['changed', '--json', '--baseline', 'broken-baseline.json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not valid JSON');
  }, 60000);

  it('notes the baseline in the GitHub step summary', () => {
    const summary = path.join(repo, 'summary.md');
    fs.writeFileSync(summary, '');
    runCli(['changed', '--json', '--baseline'], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: path.join(repo, 'out.txt') });
    expect(fs.readFileSync(summary, 'utf8')).toContain('1 existing finding matched the baseline and is not shown');
  }, 60000);
});
