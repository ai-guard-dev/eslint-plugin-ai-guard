import { describe, it, expect, afterEach } from 'vitest';
import { buildSarifLog } from '../../cli/utils/sarif';
import { buildGitHubSummaryMarkdown, emitGitHubAnnotations } from '../../cli/utils/github-summary';
import { getFailOnExitCode } from '../../cli/commands/changed';
import { integrityJson, integrityTextLines } from '../../cli/utils/integrity/report';
import { finalizeFinding, integrityExitCode, type IntegrityEnvelope } from '../../cli/utils/integrity/types';
import type { RunResult } from '../../cli/utils/eslint-runner';

const findings = [
  finalizeFinding({ ruleId: 'ai-guard/integrity-test-skipped', tier: 'high', file: 'src/a.test.ts', line: 4, message: 'Skipped the existing test "a > b"; it no longer runs.', before: 'runs', after: 'skipped', key: 'a' }),
  finalizeFinding({ ruleId: 'ai-guard/integrity-coverage-weakened', tier: 'high', file: 'jest.config.js', message: 'Lowered coverage threshold `coverageThreshold.global.lines` from 80 to 60.', before: '80', after: '60', key: 'b' }),
  finalizeFinding({ ruleId: 'ai-guard/integrity-assertions-reduced', tier: 'advisory', file: 'src/a.test.ts', message: 'Assertions in this file went from 3 to 2.', key: 'c' }),
];

function envelope(mode: 'report' | 'enforce', list = findings): IntegrityEnvelope {
  return { mode, report: { base: { ref: 'main', commit: 'abc123', head: 'working-tree' }, filesAnalyzed: 2, findings: list, accepted: 0, errors: [] } };
}

function result(env?: IntegrityEnvelope, lintErrors = 0): RunResult {
  const issues = Array.from({ length: lintErrors }, (_, i) => ({ ruleId: 'ai-guard/no-empty-catch', severity: 2 as const, message: 'Empty catch', line: i + 1, column: 1 }));
  return {
    files: issues.length ? [{ filePath: 'src/x.js', issues, errorCount: issues.length, warningCount: 0 }] : [],
    totalErrors: lintErrors, totalWarnings: 0, totalIssues: lintErrors, filesScanned: 1, ruleBreakdown: new Map(), topFiles: [],
    durationMs: 1, ecosystemIssues: [], parserErrors: [], ignoredFiles: [], tsParserAvailable: true, integrity: env,
  };
}

const prev = process.env.GITHUB_ACTIONS;
afterEach(() => { if (prev === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prev; });

describe('one finding set drives every output', () => {
  it('SARIF, annotations, Markdown, JSON and text list the same findings', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const env = envelope('enforce');
    const r = result(env);
    const sarif = buildSarifLog(r);
    const sarifIds = sarif.runs[0].results.map((x) => `${x.ruleId}:${x.locations[0].physicalLocation.region.startLine}`);
    expect(sarifIds).toEqual(findings.map((f) => `${f.ruleId}:${f.line ?? 1}`));
    expect(sarif.runs[0].results.map((x) => x.level)).toEqual(['error', 'error', 'note']);
    expect(sarif.runs[0].tool.driver.rules.map((x) => x.id).sort()).toEqual([...new Set(findings.map((f) => f.ruleId))].sort());

    const lines: string[] = [];
    emitGitHubAnnotations(r, { write: (c: string | Uint8Array) => { lines.push(String(c)); return true; } });
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['::error', '::error', '::notice']);
    expect(lines[0]).toContain('file=src/a.test.ts,line=4,title=ai-guard/integrity-test-skipped');

    const md = buildGitHubSummaryMarkdown(r, { preset: 'recommended', scanMode: 'changed' });
    for (const f of findings) expect(md).toContain(f.message.replace(/\|/g, '\\|'));
    expect(md).toContain('high-confidence findings fail this check');

    const json = integrityJson(env);
    expect(json).toMatchObject({ highCount: 2, advisoryCount: 1, blocking: true });
    expect(integrityTextLines(env).filter((l) => /^\s+(HIGH|advisory)/.test(l))).toHaveLength(3);
  });

  it('report mode annotates high findings as warnings and never fails', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const r = result(envelope('report'));
    const lines: string[] = [];
    emitGitHubAnnotations(r, { write: (c: string | Uint8Array) => { lines.push(String(c)); return true; } });
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['::warning', '::warning', '::notice']);
    expect(getFailOnExitCode(r, 'any')).toBe(0);
  });

  it('exit codes: lint follows --fail-on, integrity only in enforce mode', () => {
    expect(getFailOnExitCode(result(envelope('enforce')), 'none')).toBe(1);
    expect(getFailOnExitCode(result(envelope('enforce', findings.filter((f) => f.tier === 'advisory'))), 'none')).toBe(0);
    expect(getFailOnExitCode(result(undefined, 1), 'errors')).toBe(1);
    expect(getFailOnExitCode(result(envelope('report'), 1), 'none')).toBe(0);
    expect(integrityExitCode({ mode: 'enforce', error: { code: 'BASE_NOT_FOUND', message: 'x' } })).toBe(2);
    expect(integrityExitCode({ mode: 'report', error: { code: 'BASE_NOT_FOUND', message: 'x' } })).toBe(0);
  });

  it('an error envelope is reported, never presented as clean', () => {
    const env: IntegrityEnvelope = { mode: 'report', error: { code: 'NO_MERGE_BASE', message: 'No merge base; use fetch-depth: 0' } };
    expect(buildGitHubSummaryMarkdown(result(env), { preset: 'recommended', scanMode: 'changed' })).toContain('Could not run: No merge base');
    expect(integrityTextLines(env)[0]).toContain('could not run');
    expect(buildSarifLog(result(env)).runs[0].properties).toMatchObject({ integrityMode: 'report', integrityError: 'No merge base; use fetch-depth: 0' });
  });
});
