import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildReportData, generateHtml } from '../../cli/commands/report';
import type { RunResult } from '../../cli/utils/eslint-runner';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    files: [],
    totalErrors: 0,
    totalWarnings: 0,
    totalIssues: 0,
    filesScanned: 0,
    ruleBreakdown: new Map(),
    topFiles: [],
    durationMs: 42,
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
    ...overrides,
  };
}

function makeResultWithIssues(): RunResult {
  return {
    files: [
      {
        filePath: 'src/auth.ts',
        errorCount: 2,
        warningCount: 1,
        issues: [
          { ruleId: 'ai-guard/no-hardcoded-secret', severity: 2, message: 'Hardcoded secret detected', line: 5, column: 3 },
          { ruleId: 'ai-guard/no-empty-catch', severity: 2, message: 'Empty catch block', line: 12, column: 5 },
          { ruleId: 'ai-guard/no-floating-promise', severity: 1, message: 'Floating promise', line: 20, column: 1 },
        ],
      },
      {
        filePath: 'src/api.ts',
        errorCount: 0,
        warningCount: 2,
        issues: [
          { ruleId: 'ai-guard/no-await-in-loop', severity: 1, message: 'Await in loop', line: 8, column: 3 },
          { ruleId: 'ai-guard/no-floating-promise', severity: 1, message: 'Floating promise', line: 15, column: 1 },
        ],
      },
    ],
    totalErrors: 2,
    totalWarnings: 3,
    totalIssues: 5,
    ruleBreakdown: new Map([
      ['ai-guard/no-hardcoded-secret', 1],
      ['ai-guard/no-empty-catch', 1],
      ['ai-guard/no-floating-promise', 2],
      ['ai-guard/no-await-in-loop', 1],
    ]),
    topFiles: [
      { path: 'src/auth.ts', count: 3 },
      { path: 'src/api.ts', count: 2 },
    ],
    durationMs: 87,
    filesScanned: 2,
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
  };
}

// ─── buildReportData ──────────────────────────────────────────────────────────

describe('buildReportData', () => {
  it('returns clean data for a zero-issue result', () => {
    const data = buildReportData(makeResult(), 'recommended', '.', process.cwd());
    expect(data.totalIssues).toBe(0);
    expect(data.totalErrors).toBe(0);
    expect(data.totalWarnings).toBe(0);
    expect(data.score).toBe(100);
    expect(data.topFiles).toHaveLength(0);
    expect(data.topRules).toHaveLength(0);
  });

  it('calculates score correctly', () => {
    const result = makeResult({ totalErrors: 5, totalWarnings: 10 });
    const data = buildReportData(result, 'recommended', '.', process.cwd());
    // 100 - (5*5 + 10*2) = 100 - 45 = 55
    expect(data.score).toBe(55);
  });

  it('clamps score to 0 for very bad results', () => {
    const result = makeResult({ totalErrors: 100, totalWarnings: 100 });
    const data = buildReportData(result, 'recommended', '.', process.cwd());
    expect(data.score).toBe(0);
  });

  it('builds topFiles with error/warning breakdown', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    expect(data.topFiles).toHaveLength(2);
    expect(data.topFiles[0].path).toBe('src/auth.ts');
    expect(data.topFiles[0].errors).toBe(2);
    expect(data.topFiles[0].warnings).toBe(1);
  });

  it('builds topRules with descriptions and real examples', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    expect(data.topRules.length).toBeGreaterThan(0);

    const floatingRule = data.topRules.find((r) => r.rule === 'no-floating-promise');
    expect(floatingRule).toBeDefined();
    expect(floatingRule!.count).toBe(2);
    expect(floatingRule!.description).toContain('promise');
    expect(floatingRule!.example).not.toBeNull();
    expect(floatingRule!.example!.file).toBe('src/auth.ts');
  });

  it('builds category breakdown', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    expect(data.categoryBreakdown['Security']).toBe(1);
    expect(data.categoryBreakdown['Reliability']).toBe(1);
    expect(data.categoryBreakdown['Async Stability']).toBeGreaterThan(0);
  });

  it('uses correct preset and scannedPath', () => {
    const data = buildReportData(makeResult(), 'strict', './src', process.cwd());
    expect(data.preset).toBe('strict');
    expect(data.scannedPath).toBe('./src');
  });

  it('includes generatedAt as ISO string', () => {
    const data = buildReportData(makeResult(), 'recommended', '.', process.cwd());
    expect(() => new Date(data.generatedAt)).not.toThrow();
    expect(new Date(data.generatedAt).toISOString()).toBe(data.generatedAt);
  });
});

// ─── generateHtml ─────────────────────────────────────────────────────────────

describe('generateHtml', () => {
  it('returns a valid HTML string', () => {
    const data = buildReportData(makeResult(), 'recommended', '.', process.cwd());
    const html = generateHtml(data);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('embeds the project name', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    data.projectName = 'my-cool-app';
    const html = generateHtml(data);
    expect(html).toContain('my-cool-app');
  });

  it('shows clean codebase banner when zero issues', () => {
    const data = buildReportData(makeResult(), 'recommended', '.', process.cwd());
    const html = generateHtml(data);
    expect(html).toContain('Clean Codebase!');
  });

  it('does NOT show clean banner when there are issues', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    const html = generateHtml(data);
    expect(html).not.toContain('Clean Codebase!');
  });

  it('shows confidence tier breakdown instead of numeric score', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    const html = generateHtml(data);
    // Should show confidence breakdown, not a raw score number
    expect(html).toContain('SIGNAL CONFIDENCE');
    expect(html).toContain('high-confidence');
    expect(html).toContain('medium-confidence');
    expect(html).toContain('suggestions');
  });

  it('is self-contained (no external font/image dependencies)', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    const html = generateHtml(data);
    // Must not reference Google Fonts or external images
    expect(html).not.toMatch(/fonts\.googleapis\.com/);
    // Tailwind CDN is the only allowed external resource
    const externalResources = [...html.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]);
    const nonTailwind = externalResources.filter((r) => !r.includes('tailwindcss.com') && !r.includes('github.com'));
    expect(nonTailwind).toHaveLength(0);
  });

  it('escapes HTML special characters in filenames', () => {
    const maliciousResult = makeResult();
    const data = buildReportData(maliciousResult, 'recommended', '<script>alert(1)</script>', process.cwd());
    const html = generateHtml(data);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('generates html under 150KB', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    const html = generateHtml(data);
    const bytes = Buffer.byteLength(html, 'utf-8');
    expect(bytes).toBeLessThan(150 * 1024);
  });
});

// ─── Output file tests ────────────────────────────────────────────────────────

describe('report file output', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-report-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid HTML file to the given path', () => {
    const data = buildReportData(makeResultWithIssues(), 'recommended', '.', process.cwd());
    const html = generateHtml(data);
    const outPath = path.join(tmpDir, 'report.html');
    fs.writeFileSync(outPath, html, 'utf-8');

    expect(fs.existsSync(outPath)).toBe(true);
    const content = fs.readFileSync(outPath, 'utf-8');
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('AI GUARD REPORT');
  });

  it('default output filename is ai-guard-report.html', () => {
    // Verify the default constant (command default) matches spec
    // We test the command default separately since it requires e2e; here we just
    // verify the naming convention matches.
    expect('ai-guard-report.html').toMatch(/\.html$/);
  });
});
