import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { runEslint } from '../../cli/utils/eslint-runner';

function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-baseline-'));
}

type Issue = {
  filePath: string;
  ruleId: string;
  message: string;
  line: number;
  column: number;
};

type BaselineLike = {
  entries: Array<{
    filePath: string;
    issues: Array<{
      ruleId: string;
      message: string;
      line: number;
      column: number;
    }>;
  }>;
};

function toStrictKey(filePath: string, issue: Issue): string {
  return `${filePath}::${issue.ruleId}::${issue.line}::${issue.column}::${issue.message}`;
}

function toStableKey(filePath: string, issue: Issue): string {
  return `${filePath}::${issue.ruleId}::${issue.message}`;
}

function buildBaselineSet(baseline: BaselineLike, mode: 'strict' | 'stable'): Set<string> {
  const keyFn = mode === 'stable' ? toStableKey : toStrictKey;
  const set = new Set<string>();

  for (const entry of baseline.entries) {
    for (const issue of entry.issues) {
      set.add(
        keyFn(entry.filePath, {
          filePath: entry.filePath,
          ruleId: issue.ruleId,
          message: issue.message,
          line: issue.line,
          column: issue.column,
        }),
      );
    }
  }

  return set;
}

describe('baseline matching modes', () => {
  it('stable mode ignores line shifts but strict mode does not', async () => {
    const dir = createTempProject();

    try {
      const filePath = path.join(dir, 'a.ts');
      fs.writeFileSync(
        filePath,
        `
async function f() {
  return fetch('https://example.com');
}

try {
  boom();
} catch (e) {}
`,
        'utf8',
      );

      const first = await runEslint({
        preset: 'recommended',
        targetPath: dir,
      });

      const baseline: BaselineLike = {
        entries: first.files.map((f) => ({
          filePath: f.filePath,
          issues: f.issues.map((i) => ({
            ruleId: i.ruleId,
            message: i.message,
            line: i.line,
            column: i.column,
          })),
        })),
      };

      fs.writeFileSync(
        filePath,
        `
// line shift
async function f() {
  return fetch('https://example.com');
}

try {
  boom();
} catch (e) {}
`,
        'utf8',
      );

      const second = await runEslint({
        preset: 'recommended',
        targetPath: dir,
      });

      const strictSet = buildBaselineSet(baseline, 'strict');
      const stableSet = buildBaselineSet(baseline, 'stable');

      const strictMisses = second.files
        .flatMap((f) => f.issues.map((i) => toStrictKey(f.filePath, { ...i, filePath: f.filePath })))
        .filter((k) => !strictSet.has(k));

      const stableMisses = second.files
        .flatMap((f) => f.issues.map((i) => toStableKey(f.filePath, { ...i, filePath: f.filePath })))
        .filter((k) => !stableSet.has(k));

      expect(strictMisses.length).toBeGreaterThan(0);
      expect(stableMisses.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
