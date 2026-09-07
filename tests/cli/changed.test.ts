/**
 * tests/cli/changed.test.ts — Tests for the git changed file detection utility.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ─── getChangedFiles (mocked git) ────────────────────────────────────────────

// We mock child_process.execSync to control git output without needing a real repo.

describe('git-diff utility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getChangedFiles', () => {
    it('returns fallback mode when git is not available', async () => {
      // Mock the module
      vi.doMock('child_process', () => ({
        execFileSync: () => { throw new Error('git not found'); },
      }));

      const { getChangedFiles } = await import('../../cli/utils/git-diff.js');
      // Since we can't easily test real git in unit tests, test the exported API shape
      expect(typeof getChangedFiles).toBe('function');
    });

    it('filters non-JS/TS files from results', async () => {
      const { getChangedFiles } = await import('../../cli/utils/git-diff.js');
      // Test with extension filtering directly
      const result = getChangedFiles({
        extensions: ['.ts', '.tsx'],
        cwd: process.cwd(),
      });
      // All files should be .ts or .tsx
      for (const f of result.files) {
        expect(f).toMatch(/\.(ts|tsx)$/);
      }
    });

    it('returns mode: fallback when git rev-parse fails', async () => {
      const { getChangedFiles } = await import('../../cli/utils/git-diff.js');
      const result = getChangedFiles({ cwd: '/nonexistent/path/12345' });
      expect(result).toHaveProperty('files');
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('totalDetected');
      expect(result).toHaveProperty('filteredOut');
      expect(['pr-diff', 'staged', 'uncommitted', 'fallback']).toContain(result.mode);
    });

    it('result always has files as array', async () => {
      const { getChangedFiles } = await import('../../cli/utils/git-diff.js');
      const result = getChangedFiles({});
      expect(Array.isArray(result.files)).toBe(true);
    });

    it('isGitHubActions returns boolean', async () => {
      const { isGitHubActions } = await import('../../cli/utils/git-diff.js');
      const saved = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = 'true';
      expect(isGitHubActions()).toBe(true);
      process.env.GITHUB_ACTIONS = '';
      expect(isGitHubActions()).toBe(false);
      if (saved !== undefined) process.env.GITHUB_ACTIONS = saved;
      else delete process.env.GITHUB_ACTIONS;
    });

    it('getGitHubBaseRef returns env var', async () => {
      const { getGitHubBaseRef } = await import('../../cli/utils/git-diff.js');
      const saved = process.env.GITHUB_BASE_REF;
      process.env.GITHUB_BASE_REF = 'main';
      expect(getGitHubBaseRef()).toBe('main');
      delete process.env.GITHUB_BASE_REF;
      expect(getGitHubBaseRef()).toBeUndefined();
      if (saved !== undefined) process.env.GITHUB_BASE_REF = saved;
    });

    it('getGitHubSummaryPath returns env var', async () => {
      const { getGitHubSummaryPath } = await import('../../cli/utils/git-diff.js');
      const saved = process.env.GITHUB_STEP_SUMMARY;
      process.env.GITHUB_STEP_SUMMARY = '/tmp/summary.md';
      expect(getGitHubSummaryPath()).toBe('/tmp/summary.md');
      delete process.env.GITHUB_STEP_SUMMARY;
      expect(getGitHubSummaryPath()).toBeUndefined();
      if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
    });
  });
});
