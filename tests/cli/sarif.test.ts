import { describe, it, expect } from 'vitest';
import { buildSarifLog, sarifToJson } from '../../cli/utils/sarif';
import type { RunResult } from '../../cli/utils/eslint-runner';

function makeSarifResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    files: [
      {
        filePath: 'src/auth.ts',
        errorCount: 1,
        warningCount: 0,
        issues: [
          {
            ruleId: 'ai-guard/no-hardcoded-secret',
            severity: 2,
            message: 'Hardcoded secret detected',
            line: 5,
            column: 3,
            endLine: 5,
            endColumn: 25,
          },
        ],
      },
    ],
    totalErrors: 1,
    totalWarnings: 0,
    totalIssues: 1,
    filesScanned: 1,
    ruleBreakdown: new Map([['ai-guard/no-hardcoded-secret', 1]]),
    topFiles: [{ path: 'src/auth.ts', count: 1 }],
    durationMs: 50,
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
    ...overrides,
  };
}

describe('SARIF output', () => {
  it('produces valid SARIF 2.1.0 structure', () => {
    const result = makeSarifResult();
    const sarif = buildSarifLog(result);

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-2.1.0');
    expect(sarif.runs).toHaveLength(1);
  });

  it('includes tool driver with correct name', () => {
    const sarif = buildSarifLog(makeSarifResult());
    const driver = sarif.runs[0].tool.driver;

    expect(driver.name).toBe('ai-guard');
    expect(driver.informationUri).toContain('github.com');
    expect(driver.rules.length).toBeGreaterThan(0);
  });

  it('maps findings to SARIF results with correct severity', () => {
    const sarif = buildSarifLog(makeSarifResult());
    const results = sarif.runs[0].results;

    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('ai-guard/no-hardcoded-secret');
    expect(results[0].level).toBe('error');
    expect(results[0].message.text).toBe('Hardcoded secret detected');
  });

  it('includes physical location with line and column', () => {
    const sarif = buildSarifLog(makeSarifResult());
    const location = sarif.runs[0].results[0].locations[0].physicalLocation;

    expect(location.region.startLine).toBe(5);
    expect(location.region.startColumn).toBe(3);
    expect(location.region.endLine).toBe(5);
    expect(location.region.endColumn).toBe(25);
    // uriBaseId MUST be absent — GitHub Code Scanning cannot resolve custom base IDs.
    // Presence of %SRCROOT% causes GitHub to silently drop all findings from Code Scanning.
    expect((location.artifactLocation as Record<string, unknown>).uriBaseId).toBeUndefined();
  });

  it('maps warnings to SARIF warning level', () => {
    const result = makeSarifResult({
      files: [
        {
          filePath: 'src/utils.ts',
          errorCount: 0,
          warningCount: 1,
          issues: [
            {
              ruleId: 'ai-guard/no-await-in-loop',
              severity: 1,
              message: 'Sequential await in loop',
              line: 10,
              column: 5,
            },
          ],
        },
      ],
      totalErrors: 0,
      totalWarnings: 1,
      totalIssues: 1,
      ruleBreakdown: new Map([['ai-guard/no-await-in-loop', 1]]),
    });

    const sarif = buildSarifLog(result);
    expect(sarif.runs[0].results[0].level).toBe('warning');
  });

  it('excludes ecosystem issues and parser errors from SARIF', () => {
    const result = makeSarifResult({
      ecosystemIssues: [
        {
          type: 'missing-rule',
          ruleId: 'react-hooks/exhaustive-deps',
          message: 'Definition for rule not found',
          filePath: 'src/App.tsx',
          line: 5,
          column: 1,
        },
      ],
      parserErrors: [
        { filePath: 'src/broken.ts', message: 'Parsing error', line: 1 },
      ],
    });

    const sarif = buildSarifLog(result);
    // Only the 1 ai-guard finding, not the ecosystem or parser issues
    expect(sarif.runs[0].results).toHaveLength(1);
  });

  it('produces valid JSON output via sarifToJson', () => {
    const sarif = buildSarifLog(makeSarifResult());
    const json = sarifToJson(sarif);

    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as { version: string };
    expect(parsed.version).toBe('2.1.0');
  });

  it('handles empty results gracefully', () => {
    const result = makeSarifResult({
      files: [],
      totalErrors: 0,
      totalWarnings: 0,
      totalIssues: 0,
      ruleBreakdown: new Map(),
      topFiles: [],
    });

    const sarif = buildSarifLog(result);
    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
  });

  it('generates unique rule descriptors for each used rule', () => {
    const result = makeSarifResult({
      files: [
        {
          filePath: 'src/api.ts',
          errorCount: 2,
          warningCount: 0,
          issues: [
            { ruleId: 'ai-guard/no-hardcoded-secret', severity: 2, message: 'Secret', line: 1, column: 1 },
            { ruleId: 'ai-guard/no-empty-catch', severity: 2, message: 'Empty catch', line: 5, column: 1 },
          ],
        },
      ],
      ruleBreakdown: new Map([
        ['ai-guard/no-hardcoded-secret', 1],
        ['ai-guard/no-empty-catch', 1],
      ]),
    });

    const sarif = buildSarifLog(result);
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r) => r.id);
    expect(ruleIds).toHaveLength(2);
    expect(ruleIds).toContain('ai-guard/no-hardcoded-secret');
    expect(ruleIds).toContain('ai-guard/no-empty-catch');
  });

  it('includes helpUri pointing to rule docs', () => {
    const sarif = buildSarifLog(makeSarifResult());
    const rule = sarif.runs[0].tool.driver.rules[0];
    expect(rule.helpUri).toContain('no-hardcoded-secret');
  });

  it('file paths use forward slashes in URIs', () => {
    const result = makeSarifResult({
      files: [
        {
          filePath: 'src\\windows\\path\\auth.ts',
          errorCount: 1,
          warningCount: 0,
          issues: [
            { ruleId: 'ai-guard/no-hardcoded-secret', severity: 2, message: 'Secret', line: 1, column: 1 },
          ],
        },
      ],
    });

    const sarif = buildSarifLog(result);
    const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).not.toContain('\\');
    expect(uri).toContain('/');
  });
});
