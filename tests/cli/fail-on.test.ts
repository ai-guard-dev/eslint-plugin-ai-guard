/**
 * tests/cli/fail-on.test.ts — Tests for the --fail-on exit code strategy.
 */

import { describe, it, expect } from 'vitest';
import { resolveExitCode } from '../../cli/commands/run.js';
import type { RunResult } from '../../cli/utils/eslint-runner.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    files: [],
    totalErrors: 0,
    totalWarnings: 0,
    totalIssues: 0,
    filesScanned: 10,
    ruleBreakdown: new Map(),
    topFiles: [],
    durationMs: 100,
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
    signalSummary: { high: 0, medium: 0, low: 0, informational: 0, ecosystemIssues: 0, parserErrors: 0 },
    ...overrides,
  } as RunResult;
}

function makeResultWithIssue(ruleId: string, severity: 1 | 2 = 2): RunResult {
  return makeResult({
    totalErrors: severity === 2 ? 1 : 0,
    totalWarnings: severity === 1 ? 1 : 0,
    totalIssues: 1,
    files: [{
      filePath: 'src/test.ts',
      errorCount: severity === 2 ? 1 : 0,
      warningCount: severity === 1 ? 1 : 0,
      issues: [{
        ruleId,
        severity,
        message: 'test issue',
        line: 1,
        column: 1,
      }],
    }],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveExitCode (--fail-on)', () => {
  describe('fail-on: none', () => {
    it('always returns 0 even with high-confidence errors', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise');  // high confidence
      expect(resolveExitCode(result, 'none')).toBe(0);
    });

    it('returns 0 with no issues', () => {
      expect(resolveExitCode(makeResult(), 'none')).toBe(0);
    });
  });

  describe('fail-on: errors (default)', () => {
    it('returns 1 when there are errors', () => {
      const result = makeResult({ totalErrors: 2 });
      expect(resolveExitCode(result, 'errors')).toBe(1);
    });

    it('returns 0 when only warnings exist', () => {
      const result = makeResult({ totalErrors: 0, totalWarnings: 3 });
      expect(resolveExitCode(result, 'errors')).toBe(0);
    });

    it('returns 0 with no issues', () => {
      expect(resolveExitCode(makeResult(), 'errors')).toBe(0);
    });
  });

  describe('fail-on: high', () => {
    it('returns 1 for high-confidence no-floating-promise', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      expect(resolveExitCode(result, 'high')).toBe(1);
    });

    it('returns 1 for high-confidence no-hardcoded-secret', () => {
      const result = makeResultWithIssue('ai-guard/no-hardcoded-secret', 2);
      expect(resolveExitCode(result, 'high')).toBe(1);
    });

    it('returns 0 for medium-confidence no-sql-string-concat', () => {
      const result = makeResultWithIssue('ai-guard/no-sql-string-concat', 1);
      expect(resolveExitCode(result, 'high')).toBe(0);
    });

    it('returns 0 for low-confidence no-dead-branch', () => {
      const result = makeResultWithIssue('ai-guard/no-dead-branch', 1);
      expect(resolveExitCode(result, 'high')).toBe(0);
    });

    it('returns 0 for informational no-async-without-await', () => {
      const result = makeResultWithIssue('ai-guard/no-async-without-await', 1);
      expect(resolveExitCode(result, 'high')).toBe(0);
    });

    it('returns 0 with no issues', () => {
      expect(resolveExitCode(makeResult(), 'high')).toBe(0);
    });
  });

  describe('fail-on: medium', () => {
    it('returns 1 for high-confidence issue', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      expect(resolveExitCode(result, 'medium')).toBe(1);
    });

    it('returns 1 for medium-confidence no-await-in-loop', () => {
      const result = makeResultWithIssue('ai-guard/no-await-in-loop', 1);
      expect(resolveExitCode(result, 'medium')).toBe(1);
    });

    it('returns 1 for medium-confidence require-auth-middleware', () => {
      const result = makeResultWithIssue('ai-guard/require-auth-middleware', 1);
      expect(resolveExitCode(result, 'medium')).toBe(1);
    });

    it('returns 0 for low-confidence no-dead-branch', () => {
      const result = makeResultWithIssue('ai-guard/no-dead-branch', 1);
      expect(resolveExitCode(result, 'medium')).toBe(0);
    });

    it('returns 0 for informational no-async-without-await', () => {
      const result = makeResultWithIssue('ai-guard/no-async-without-await', 1);
      expect(resolveExitCode(result, 'medium')).toBe(0);
    });
  });

  describe('fail-on: any', () => {
    it('returns 1 for any non-informational issue', () => {
      const result = makeResultWithIssue('ai-guard/no-dead-branch', 1);  // low confidence
      expect(resolveExitCode(result, 'any')).toBe(1);
    });

    it('returns 1 for medium issue', () => {
      const result = makeResultWithIssue('ai-guard/no-await-in-loop', 1);
      expect(resolveExitCode(result, 'any')).toBe(1);
    });

    it('returns 0 for informational-only issues', () => {
      const result = makeResultWithIssue('ai-guard/no-async-without-await', 1);
      expect(resolveExitCode(result, 'any')).toBe(0);
    });

    it('returns 0 with no issues', () => {
      expect(resolveExitCode(makeResult(), 'any')).toBe(0);
    });
  });

  describe('max-warnings override', () => {
    it('always applies max-warnings regardless of fail-on', () => {
      const result = makeResult({ totalWarnings: 5 });
      expect(resolveExitCode(result, 'none', 3)).toBe(1);   // fail-on: none but max-warnings exceeded
      expect(resolveExitCode(result, 'high', 3)).toBe(1);   // fail-on: high, but max-warnings exceeded
    });

    it('does not fail when warnings are within threshold', () => {
      const result = makeResult({ totalWarnings: 2 });
      expect(resolveExitCode(result, 'none', 3)).toBe(0);
      expect(resolveExitCode(result, 'high', 3)).toBe(0);
    });

    it('handles undefined maxWarnings (no limit)', () => {
      const result = makeResult({ totalWarnings: 9999 });
      expect(resolveExitCode(result, 'none', undefined)).toBe(0);
    });
  });
});
