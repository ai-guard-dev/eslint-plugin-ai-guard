import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { runEslint } from '../../cli/utils/eslint-runner';

function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-file-target-'));
}

describe('cli eslint-runner file target', () => {
  it('reports issues when targetPath points to a single file', async () => {
    const dir = createTempProject();

    try {
      const filePath = path.join(dir, 'bad.js');
      fs.writeFileSync(
        filePath,
        `
async function onlyWarning() {
  fetch('https://example.com');
}

try {
  maybeFails();
} catch (e) {}
`,
        'utf8',
      );

      const result = await runEslint({
        preset: 'recommended',
        targetPath: filePath,
      });

      const ruleIds = result.files.flatMap((f) => f.issues.map((i) => i.ruleId));

      expect(result.totalIssues).toBeGreaterThan(0);
      expect(ruleIds).toContain('ai-guard/no-empty-catch');
      expect(ruleIds).toContain('ai-guard/no-floating-promise');
      expect(ruleIds).toContain('ai-guard/no-async-without-await');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('supports .mts files in single-file mode', async () => {
    const dir = createTempProject();

    try {
      const filePath = path.join(dir, 'bad.mts');
      fs.writeFileSync(
        filePath,
        `
async function onlyWarning() {
  fetch('https://example.com');
}
`,
        'utf8',
      );

      const result = await runEslint({
        preset: 'recommended',
        targetPath: filePath,
      });

      const ruleIds = result.files.flatMap((f) => f.issues.map((i) => i.ruleId));
      expect(ruleIds).toContain('ai-guard/no-floating-promise');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
