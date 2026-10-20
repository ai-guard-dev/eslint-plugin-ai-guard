/**
 * With GITHUB_ACTIONS=true, stdout must stay valid JSON/SARIF when it carries
 * machine-readable output. Annotations then go to stderr (the runner parses
 * workflow commands from both streams); human mode keeps them on stdout.
 * Step summary and GITHUB_OUTPUT are written in every mode.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { emitGitHubAnnotations } from '../../cli/utils/github-summary';
import type { RunResult } from '../../cli/utils/eslint-runner';

const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');
const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'gha-output');
const fixture = path.join(fixtureDir, 'bad.js');
const ANNOTATION = /^::error file=.*no-empty-catch/m;

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-gha-'));
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(fixture, 'try { run(); } catch (e) {}\n', 'utf8');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string; summary: string; outputs: string } {
  const summaryFile = path.join(tmp, 'summary.md');
  const outputFile = path.join(tmp, 'output.txt');
  fs.writeFileSync(summaryFile, '');
  fs.writeFileSync(outputFile, '');
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_BASE_REF: '',
    },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    summary: fs.readFileSync(summaryFile, 'utf8'),
    outputs: fs.readFileSync(outputFile, 'utf8'),
  };
}

function expectGitHubIntegrations(r: ReturnType<typeof runCli>): void {
  expect(r.stderr).toMatch(ANNOTATION);
  expect(r.stdout).not.toContain('::error');
  expect(r.summary).toContain('AI Guard');
  expect(r.outputs).toMatch(/^issues-found=[1-9]/m);
}

describe('emitGitHubAnnotations stream', () => {
  const result = {
    files: [{
      filePath: 'src\\a.js',
      errorCount: 1,
      warningCount: 0,
      issues: [{ ruleId: 'ai-guard/no-empty-catch', severity: 2, message: 'Empty catch', line: 3, column: 1 }],
    }],
  } as unknown as RunResult;

  it('writes to the given stream and defaults to stdout', () => {
    const prev = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      const chunks: string[] = [];
      emitGitHubAnnotations(result, { write: (c: string | Uint8Array) => { chunks.push(String(c)); return true; } });
      expect(chunks).toEqual(['::error file=src/a.js,line=3,col=1,title=ai-guard/no-empty-catch::Empty catch\n']);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prev;
    }
  });
});

describe('GITHUB_ACTIONS=true machine-readable stdout', () => {
  const target = path.relative(process.cwd(), fixture);

  it('run --json: stdout is valid JSON, annotations on stderr', () => {
    const r = runCli(['run', '--path', target, '--json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).totalIssues).toBeGreaterThan(0);
    expectGitHubIntegrations(r);
  }, 60000);

  it('run --sarif: stdout is valid SARIF, annotations on stderr', () => {
    const r = runCli(['run', '--path', target, '--sarif']);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.length).toBeGreaterThan(0);
    expectGitHubIntegrations(r);
  }, 60000);

  it('run --sarif-output <file>: stdout is free, so annotations stay on stdout', () => {
    const sarifFile = path.join(tmp, 'out.sarif');
    const r = runCli(['run', '--path', target, '--sarif-output', sarifFile]);
    expect(r.stdout).toMatch(ANNOTATION);
    expect(JSON.parse(fs.readFileSync(sarifFile, 'utf8')).version).toBe('2.1.0');
    expect(r.summary).toContain('AI Guard');
  }, 60000);

  it('changed --json: stdout is valid JSON, annotations on stderr', () => {
    const r = runCli(['changed', '--json']);
    expect(JSON.parse(r.stdout).totalIssues).toBeGreaterThan(0);
    expectGitHubIntegrations(r);
  }, 60000);

  it('changed --sarif --sarif-stdout: stdout is valid SARIF, annotations on stderr', () => {
    const r = runCli(['changed', '--sarif', '--sarif-stdout']);
    expect(JSON.parse(r.stdout).version).toBe('2.1.0');
    expectGitHubIntegrations(r);
  }, 60000);
});

describe('GITHUB_ACTIONS=true human mode', () => {
  it('run keeps annotations on stdout and still writes summary/outputs', () => {
    const r = runCli(['run', '--path', path.relative(process.cwd(), fixture)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(ANNOTATION);
    expect(r.summary).toContain('AI Guard');
    expect(r.outputs).toMatch(/^issues-found=[1-9]/m);
  }, 60000);
});
