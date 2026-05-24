/**
 * tests/ci/github-env.test.ts — GitHub Actions environment hardening tests.
 *
 * Tests that GitHub summary and output writing never crashes CI,
 * gracefully degrades when env vars are missing or malformed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeGitHubSummary,
  writeGitHubOutputs,
  buildGitHubSummaryMarkdown,
  isGitHubSummaryAvailable,
  isGitHubOutputAvailable,
} from '../../cli/utils/github-summary.js';
import type { RunResult } from '../../cli/utils/eslint-runner.js';

// ─── Test fixture ─────────────────────────────────────────────────────────────

function makeEmptyResult(): RunResult {
  return {
    files: [],
    filesScanned: 10,
    totalErrors: 0,
    totalWarnings: 0,
    totalIssues: 0,
    durationMs: 150,
    ruleBreakdown: new Map(),
    topFiles: [],
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
  };
}

function makeResultWithIssues(): RunResult {
  return {
    files: [
      {
        filePath: '/project/src/api/handler.ts',
        issues: [
          {
            ruleId: 'ai-guard/no-floating-promise',
            message: 'Floating promise detected',
            severity: 2,
            line: 42,
            column: 5,
            endLine: 42,
            endColumn: 30,
          },
          {
            ruleId: 'ai-guard/no-empty-catch',
            message: 'Empty catch block',
            severity: 1,
            line: 88,
            column: 3,
          },
        ],
      },
    ],
    filesScanned: 20,
    totalErrors: 1,
    totalWarnings: 1,
    totalIssues: 2,
    durationMs: 500,
    ruleBreakdown: new Map([['ai-guard/no-floating-promise', 1], ['ai-guard/no-empty-catch', 1]]),
    topFiles: [{ filePath: '/project/src/api/handler.ts', issueCount: 2 }],
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
  };
}

// ─── isGitHubSummaryAvailable ─────────────────────────────────────────────────

describe('isGitHubSummaryAvailable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when GITHUB_STEP_SUMMARY is not set', () => {
    const saved = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    expect(isGitHubSummaryAvailable()).toBe(false);
    if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
  });

  it('returns true when GITHUB_STEP_SUMMARY points to a writable file', () => {
    const tmpFile = path.join(os.tmpdir(), `ai-guard-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '', 'utf-8');
    const saved = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = tmpFile;
    expect(isGitHubSummaryAvailable()).toBe(true);
    fs.unlinkSync(tmpFile);
    if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
    else delete process.env.GITHUB_STEP_SUMMARY;
  });

  it('returns false when GITHUB_STEP_SUMMARY points to a non-existent directory', () => {
    const saved = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = '/nonexistent/path/summary.md';
    expect(isGitHubSummaryAvailable()).toBe(false);
    if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
    else delete process.env.GITHUB_STEP_SUMMARY;
  });
});

// ─── isGitHubOutputAvailable ──────────────────────────────────────────────────

describe('isGitHubOutputAvailable', () => {
  it('returns false when GITHUB_OUTPUT is not set', () => {
    const saved = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;
    expect(isGitHubOutputAvailable()).toBe(false);
    if (saved !== undefined) process.env.GITHUB_OUTPUT = saved;
  });
});

// ─── writeGitHubSummary — never crashes ──────────────────────────────────────

describe('writeGitHubSummary — resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no-ops gracefully when GITHUB_STEP_SUMMARY is not set', () => {
    const saved = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;

    // Should not throw
    expect(() => {
      writeGitHubSummary(makeEmptyResult(), { preset: 'recommended', scanMode: 'full' });
    }).not.toThrow();

    if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
  });

  it('writes summary to file when GITHUB_STEP_SUMMARY is set', () => {
    const tmpFile = path.join(os.tmpdir(), `ai-guard-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '', 'utf-8');
    const saved = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = tmpFile;

    writeGitHubSummary(makeResultWithIssues(), { preset: 'recommended', scanMode: 'changed' });

    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('AI Guard');

    fs.unlinkSync(tmpFile);
    if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
    else delete process.env.GITHUB_STEP_SUMMARY;
  });

  it('warns to stderr (not stdout) when path is not writable', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const saved = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = '/nonexistent/path/summary.md';

    // Should not throw even with bad path
    expect(() => {
      writeGitHubSummary(makeEmptyResult(), { preset: 'recommended', scanMode: 'full' });
    }).not.toThrow();

    // Should have warned to stderr
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.some((m) => m.includes('GITHUB_STEP_SUMMARY'))).toBe(true);

    stderrSpy.mockRestore();
    if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
    else delete process.env.GITHUB_STEP_SUMMARY;
  });

  it('does NOT write to stdout (never pollutes SARIF/JSON output)', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const saved = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;

    writeGitHubSummary(makeEmptyResult(), { preset: 'recommended', scanMode: 'full' });

    expect(stdoutSpy).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
    if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
  });
});

// ─── writeGitHubOutputs — never crashes ──────────────────────────────────────

describe('writeGitHubOutputs — resilience', () => {
  it('no-ops when GITHUB_OUTPUT is not set', () => {
    const saved = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;

    expect(() => {
      writeGitHubOutputs(makeEmptyResult());
    }).not.toThrow();

    if (saved !== undefined) process.env.GITHUB_OUTPUT = saved;
  });

  it('writes correct output format to GITHUB_OUTPUT file', () => {
    const tmpFile = path.join(os.tmpdir(), `ai-guard-output-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, '', 'utf-8');
    const saved = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = tmpFile;

    writeGitHubOutputs(makeResultWithIssues(), 'ai-guard-results.sarif');

    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('issues-found=2');
    expect(content).toContain('high-confidence-count=');
    expect(content).toContain('files-scanned=20');
    expect(content).toContain('duration-ms=500');
    expect(content).toContain('sarif-file=ai-guard-results.sarif');

    fs.unlinkSync(tmpFile);
    if (saved !== undefined) process.env.GITHUB_OUTPUT = saved;
    else delete process.env.GITHUB_OUTPUT;
  });

  it('writes output without sarif-file when no sarif path given', () => {
    const tmpFile = path.join(os.tmpdir(), `ai-guard-output-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, '', 'utf-8');
    const saved = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = tmpFile;

    writeGitHubOutputs(makeEmptyResult());

    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).not.toContain('sarif-file=');

    fs.unlinkSync(tmpFile);
    if (saved !== undefined) process.env.GITHUB_OUTPUT = saved;
    else delete process.env.GITHUB_OUTPUT;
  });

  it('warns to stderr when GITHUB_OUTPUT path is not writable', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const saved = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = '/nonexistent/path/output.txt';

    expect(() => {
      writeGitHubOutputs(makeEmptyResult());
    }).not.toThrow();

    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.some((m) => m.includes('GITHUB_OUTPUT'))).toBe(true);

    stderrSpy.mockRestore();
    if (saved !== undefined) process.env.GITHUB_OUTPUT = saved;
    else delete process.env.GITHUB_OUTPUT;
  });
});

// ─── GitHub annotation format ─────────────────────────────────────────────────

describe('GitHub annotation commands', () => {
  it('buildGitHubSummaryMarkdown returns valid markdown with issues', () => {
    const md = buildGitHubSummaryMarkdown(makeResultWithIssues(), {
      preset: 'recommended',
      scanMode: 'changed',
      changedFilesCount: 5,
    });
    expect(md).toContain('AI Guard');
    expect(md).toContain('Files scanned');
    expect(md).toContain('20');
  });

  it('buildGitHubSummaryMarkdown returns clean markdown with zero issues', () => {
    const md = buildGitHubSummaryMarkdown(makeEmptyResult(), {
      preset: 'recommended',
      scanMode: 'full',
    });
    expect(md).toContain('No issues found');
    expect(md).toContain('AI Guard');
  });

  it('buildGitHubSummaryMarkdown does not throw for any input', () => {
    const inputs: Array<RunResult> = [
      makeEmptyResult(),
      makeResultWithIssues(),
      { ...makeEmptyResult(), filesScanned: 0 },
    ];

    for (const input of inputs) {
      expect(() => buildGitHubSummaryMarkdown(input, {
        preset: 'strict',
        scanMode: 'staged',
      })).not.toThrow();
    }
  });
});
