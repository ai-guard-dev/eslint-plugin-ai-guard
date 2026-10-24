/**
 * The built CLI must find its own bundled plugin when the scanned project does
 * not install eslint-plugin-ai-guard (`npx eslint-plugin-ai-guard run`, the
 * GitHub Action's npx fallback). Regression: the CJS bundle replaced
 * `import.meta` with `{}`, so the self-resolution fallback threw and the CLI
 * exited with "eslint-plugin-ai-guard is not installed".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');

let project: string;

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-standalone-'));
  fs.writeFileSync(path.join(project, 'app.js'), 'try { run(); } catch (e) {}\n', 'utf8');
});

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('standalone CLI (plugin not installed in the scanned project)', () => {
  it('bundle does not stub out import.meta', () => {
    expect(fs.readFileSync(cli, 'utf8')).not.toMatch(/var import_meta\d* = \{\};/);
  });

  it('scans a project that has no node_modules', () => {
    const r = spawnSync(process.execPath, [cli, 'run', '--json'], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '' },
    });
    expect(r.stderr).not.toContain('is not installed');
    const out = JSON.parse(r.stdout);
    expect(out.filesScanned).toBe(1);
    expect(out.totalIssues).toBe(1);
  }, 60000);
});
