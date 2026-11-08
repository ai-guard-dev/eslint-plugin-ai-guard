import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { createUnifiedDiff } from '../../cli/utils/unified-diff';

/** Applies a unified diff with `git apply` to prove it is valid, then returns the result. */
function applyWithGit(oldText: string, diff: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-diff-'));
  try {
    fs.writeFileSync(path.join(dir, 'f.js'), oldText);
    fs.writeFileSync(path.join(dir, 'p.diff'), diff);
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--unidiff-zero', 'p.diff'], { cwd: dir, stdio: 'pipe' });
    return fs.readFileSync(path.join(dir, 'f.js'), 'utf8').replace(/\r\n/g, '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('createUnifiedDiff', () => {
  it('returns an empty string for identical text or line-ending-only changes', () => {
    expect(createUnifiedDiff('a\nb\n', 'a\nb\n', 'f.js')).toBe('');
    expect(createUnifiedDiff('a\nb\n', 'a\r\nb\r\n', 'f.js')).toBe('');
  });

  it('produces separate hunks for distant edits, with context', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = before.replace('line 3\n', 'line three\n').replace('line 35\n', 'line 35\nadded\n');
    const diff = createUnifiedDiff(before, after, 'f.js');
    expect(diff.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,6 +1,6 @@', '@@ -33,6 +33,7 @@']);
    expect(applyWithGit(before, diff)).toBe(after);
  });

  it('handles additions to an empty file and deletion of everything', () => {
    expect(applyWithGit('a\n', createUnifiedDiff('a\n', 'a\nb\nc\n', 'f.js'))).toBe('a\nb\nc\n');
    const diff = createUnifiedDiff('x\ny\n', 'y\n', 'f.js');
    expect(diff).toContain('-x');
    expect(applyWithGit('x\ny\n', diff)).toBe('y\n');
  });

  it('matches what an autofix produces (void-prefixed floating promise)', () => {
    const before = 'async function run() {\n  save();\n  return 1;\n}\n';
    const after = 'async function run() {\n  void save();\n  return 1;\n}\n';
    expect(createUnifiedDiff(before, after, 'src/run.js')).toBe(
      '--- a/src/run.js\n+++ b/src/run.js\n@@ -1,4 +1,4 @@\n async function run() {\n-  save();\n+  void save();\n   return 1;\n }\n',
    );
  });
});
