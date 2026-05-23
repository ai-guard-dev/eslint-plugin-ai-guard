import { describe, it, expect } from 'vitest';
import { getRunExitCode } from '../../cli/commands/run';
import type { RunResult } from '../../cli/utils/eslint-runner';

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    files: [],
    totalErrors: 0,
    totalWarnings: 0,
    totalIssues: 0,
    filesScanned: 0,
    ruleBreakdown: new Map(),
    topFiles: [],
    durationMs: 0,
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
    ...overrides,
  };
}

describe('cli run exit code', () => {
  it('returns 1 when there are errors', () => {
    const result = makeResult({ totalErrors: 1, totalIssues: 1 });
    expect(getRunExitCode(result)).toBe(1);
  });

  it('returns 1 when warnings exceed max-warnings', () => {
    const result = makeResult({ totalWarnings: 3, totalIssues: 3 });
    expect(getRunExitCode(result, 2)).toBe(1);
  });

  it('returns 0 when warnings equal max-warnings', () => {
    const result = makeResult({ totalWarnings: 2, totalIssues: 2 });
    expect(getRunExitCode(result, 2)).toBe(0);
  });

  it('returns 0 when there are only warnings and no max-warnings limit', () => {
    const result = makeResult({ totalWarnings: 5, totalIssues: 5 });
    expect(getRunExitCode(result)).toBe(0);
  });
});
