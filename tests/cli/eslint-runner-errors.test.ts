import { describe, it, expect, vi } from 'vitest';
import { ESLint } from 'eslint';
import { runEslint } from '../../cli/utils/eslint-runner';

describe('cli eslint-runner errors', () => {
  it('propagates unexpected per-pattern failures instead of returning a successful subset', async () => {
    const lint = vi.spyOn(ESLint.prototype, 'lintFiles')
      .mockRejectedValueOnce(new Error('No files matching pattern'))
      .mockRejectedValueOnce(new Error('Rule crashed'))
      .mockResolvedValue([]);
    try {
      await expect(runEslint({ preset: 'agent', targetPath: process.cwd() })).rejects.toThrow('Rule crashed');
    } finally {
      lint.mockRestore();
    }
  });
  it('throws a clear error when target path does not exist', async () => {
    await expect(
      runEslint({
        preset: 'recommended',
        targetPath: 'definitely-does-not-exist-12345.js',
      }),
    ).rejects.toThrow('Path not found: definitely-does-not-exist-12345.js');
  });
});
