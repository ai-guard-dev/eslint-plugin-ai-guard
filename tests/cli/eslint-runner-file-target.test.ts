import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

// Default ignore globs (e.g. **/generated/**) must resolve against the project
// root (process.cwd()), not the file's own directory.
describe('cli eslint-runner ignore handling for explicit files', () => {
  const root = path.join(process.cwd(), 'tests', 'fixtures', 'runner-ignore');
  const ignored = path.join(root, 'generated', 'ignored.js');
  const nested = path.join(root, 'nested', 'deep', 'nested.js');
  const normal = path.join(root, 'normal.js');
  // Directory with one clean analyzed file and one ignored file that has findings
  const mixedDir = path.join(root, 'mixed');
  const cleanFile = path.join(mixedDir, 'clean.js');
  const mixedIgnored = path.join(mixedDir, 'generated', 'bad.js');
  const leakySource = 'try { maybeFails(); } catch (e) {}\n';
  const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');

  beforeAll(() => {
    fs.mkdirSync(mixedDir, { recursive: true });
    fs.writeFileSync(cleanFile, 'export const x = 1;\n', 'utf8');
    for (const f of [ignored, nested, normal, mixedIgnored]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, leakySource, 'utf8');
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('single-file target matching a default ignore is reported as ignored, not scanned', async () => {
    const result = await runEslint({ preset: 'recommended', targetPath: ignored });
    expect(result.filesScanned).toBe(0);
    expect(result.totalIssues).toBe(0);
    expect(result.ignoredFiles).toEqual([path.relative(process.cwd(), ignored)]);
    expect(result.ecosystemIssues).toEqual([]);
  });

  it('explicit files with a directory target (hook style) honor default ignores', async () => {
    const result = await runEslint({
      preset: 'recommended',
      targetPath: path.dirname(ignored),
      files: [ignored, normal],
    });
    expect(result.filesScanned).toBe(1);
    expect(result.ignoredFiles).toEqual([path.relative(process.cwd(), ignored)]);
    expect(result.files.map((f) => f.filePath)).toEqual([path.relative(process.cwd(), normal)]);
  });

  it('nested and normal single-file targets are still analyzed', async () => {
    for (const f of [nested, normal]) {
      const result = await runEslint({ preset: 'recommended', targetPath: f });
      expect(result.filesScanned).toBe(1);
      expect(result.ignoredFiles).toEqual([]);
      expect(result.files[0].issues.map((i) => i.ruleId)).toContain('ai-guard/no-empty-catch');
    }
  });

  describe('`ai-guard run` exit codes and output', () => {
    const run = (target: string, json = false): { status: number | null; stdout: string } => {
      const args = [cli, 'run', '--path', path.relative(process.cwd(), target), ...(json ? ['--json'] : [])];
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
      return { status: r.status, stdout: r.stdout };
    };

    it('ignored-only file: scan did not run, exit 2', () => {
      const human = run(ignored);
      expect(human.status).toBe(2);
      expect(human.stdout).toContain('1 file not analyzed');
      expect(human.stdout).toContain('Scan did not run');
      expect(human.stdout).not.toContain('all clean');

      const json = run(ignored, true);
      expect(json.status).toBe(2);
      const out = JSON.parse(json.stdout);
      expect(out.scanRan).toBe(false);
      expect(out.filesScanned).toBe(0);
      expect(out.ignoredFiles).toHaveLength(1);
    }, 60000);

    it('directory with analyzed and ignored files: ignored files excluded silently, exit by findings', () => {
      const human = run(mixedDir);
      expect(human.status).toBe(0);
      expect(human.stdout).toContain('1 file scanned, all clean');
      expect(human.stdout).not.toContain('not analyzed');

      const json = run(mixedDir, true);
      expect(json.status).toBe(0);
      const out = JSON.parse(json.stdout);
      expect(out.scanRan).toBe(true);
      expect(out.filesScanned).toBe(1);
      expect(out.totalIssues).toBe(0);
    }, 60000);

    it('clean file: exit 0', () => {
      const human = run(cleanFile);
      expect(human.status).toBe(0);
      expect(human.stdout).toContain('all clean');

      const json = run(cleanFile, true);
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ scanRan: true, filesScanned: 1, totalIssues: 0, ignoredFiles: [] });
    }, 60000);

    it('file with findings: exit 1 (unchanged)', () => {
      const human = run(normal);
      expect(human.status).toBe(1);
      expect(human.stdout).toContain('no-empty-catch');

      const json = run(normal, true);
      expect(json.status).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ scanRan: true, filesScanned: 1, totalErrors: 1 });
    }, 60000);
  });
});
