/**
 * tests/cli/github-summary.test.ts — Tests for GitHub step summary generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildGitHubSummaryMarkdown } from '../../cli/utils/github-summary.js';
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
    durationMs: 1234,
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
    ...overrides,
  } as RunResult;
}

function makeResultWithIssue(ruleId: string, severity: 1 | 2 = 2): RunResult {
  return makeResult({
    totalErrors: severity === 2 ? 1 : 0,
    totalWarnings: severity === 1 ? 1 : 0,
    totalIssues: 1,
    files: [{
      filePath: 'src/api/payment.ts',
      errorCount: severity === 2 ? 1 : 0,
      warningCount: severity === 1 ? 1 : 0,
      issues: [{
        ruleId,
        severity,
        message: 'Promise is not awaited or error-handled',
        line: 45,
        column: 5,
      }],
    }],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildGitHubSummaryMarkdown', () => {
  describe('clean results', () => {
    it('shows success message when no issues', () => {
      const md = buildGitHubSummaryMarkdown(makeResult(), {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('No issues found');
      expect(md).toContain('## AI Guard');
    });

    it('includes file count and duration', () => {
      const md = buildGitHubSummaryMarkdown(makeResult(), {
        preset: 'recommended',
        scanMode: 'changed',
      });
      expect(md).toContain('Files scanned:** 10');
      expect(md).toContain('1234ms');
    });

    it('shows "Changed files only" for changed scan mode', () => {
      const md = buildGitHubSummaryMarkdown(makeResult(), {
        preset: 'recommended',
        scanMode: 'changed',
      });
      expect(md).toContain('Changed files only');
    });

    it('shows "Staged files" for staged scan mode', () => {
      const md = buildGitHubSummaryMarkdown(makeResult(), {
        preset: 'recommended',
        scanMode: 'staged',
      });
      expect(md).toContain('Staged files');
    });

    it('shows "Full scan" for full scan mode', () => {
      const md = buildGitHubSummaryMarkdown(makeResult(), {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('Full scan');
    });
  });

  describe('high-confidence findings', () => {
    it('shows high-confidence count heading', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'changed',
      });
      expect(md).toContain('high-confidence');
      expect(md).not.toContain('No issues found');
    });

    it('includes top findings table', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'changed',
      });
      expect(md).toContain('Top Findings');
      expect(md).toContain('no-floating-promise');
      expect(md).toContain('45');  // line number
    });

    it('includes rule category in breakdown table', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('Async Reliability');
    });

    it('includes emoji confidence indicator', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('🔴');  // high confidence
    });
  });

  describe('informational findings', () => {
    it('collapses informational hints in details element', () => {
      const result = makeResultWithIssue('ai-guard/no-async-without-await', 1);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('<details>');
      expect(md).toContain('informational hint');
    });

    it('shows info message for informational-only results', () => {
      const result = makeResultWithIssue('ai-guard/no-async-without-await', 1);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'full',
      });
      // Should not show "high-confidence" heading
      expect(md).not.toContain('high-confidence issue');
    });
  });

  describe('ecosystem issues', () => {
    it('shows ecosystem issues in a separate collapsed section', () => {
      const result = makeResult({
        // ecosystem issues need actual issues to show the section
        // OR we need to ensure the early-exit clean path shows them too
        // The summary shows ecosystem issues only when there are findings.
        // Test with both ai-guard issue AND ecosystem issue:
        totalErrors: 1,
        totalIssues: 1,
        files: [{
          filePath: 'src/api.ts',
          errorCount: 1,
          warningCount: 0,
          issues: [{
            ruleId: 'ai-guard/no-floating-promise',
            severity: 2,
            message: 'Floating promise',
            line: 1,
            column: 1,
          }],
        }],
        ecosystemIssues: [{
          type: 'missing-rule',
          ruleId: 'react-hooks/exhaustive-deps',
          message: 'Definition for rule react-hooks/exhaustive-deps was not found.',
          filePath: 'src/App.tsx',
          line: 1,
          column: 1,
        }],
      });
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('ESLint config issue');
      expect(md).toContain('<details>');
    });
  });

  describe('changedFilesCount option', () => {
    it('shows changed files count when provided', () => {
      const md = buildGitHubSummaryMarkdown(makeResult(), {
        preset: 'recommended',
        scanMode: 'changed',
        changedFilesCount: 5,
      });
      expect(md).toContain('5 changed');
    });
  });

  describe('next steps', () => {
    it('includes ai-guard commands in next steps', () => {
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('ai-guard baseline');
      // Note: ai-guard report is not in the step summary next steps (by design)
      // to keep it concise. Only baseline is recommended from CI.
      expect(md).toContain('ai-guard run --verbose');
    });

    it('includes link to repo in findings output', () => {
      // The link is only shown when there are issues (in the powered-by line)
      const result = makeResultWithIssue('ai-guard/no-floating-promise', 2);
      const md = buildGitHubSummaryMarkdown(result, {
        preset: 'recommended',
        scanMode: 'full',
      });
      expect(md).toContain('eslint-plugin-ai-guard');
    });
  });
});
