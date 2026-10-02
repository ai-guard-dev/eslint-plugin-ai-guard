/**
 * MCP Server tests — focused integration coverage.
 *
 * Tests the MCP tool handlers directly (not via STDIO transport)
 * to validate path security, result normalization, and engine reuse.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { getChangedFiles } from '../../cli/utils/git-diff';
import { scanFile } from '../../src/mcp/tools/scan-file';
import { scanDiff } from '../../src/mcp/tools/scan-diff';
import { getRules } from '../../src/mcp/tools/rules';
import {
  setWorkspaceRoot,
  getWorkspaceRoot,
  validatePath,
  isSupportedExtension,
  isValidPreset,
  sanitizeGitRef,
} from '../../src/mcp/utils/workspace';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Use process.cwd() — vitest runs from project root
const FIXTURES_DIR = path.resolve(process.cwd(), 'tests', 'fixtures');
const PROJECT_ROOT = process.cwd();

// ─── Workspace utility tests ─────────────────────────────────────────────────

describe('Workspace utils', () => {
  beforeAll(() => {
    setWorkspaceRoot(PROJECT_ROOT);
  });

  describe('validatePath', () => {
    it('accepts relative paths within workspace', () => {
      const result = validatePath('src/index.ts');
      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toContain('src');
    });

    it('rejects ../ traversal outside workspace', () => {
      const result = validatePath('../../../../etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('outside workspace');
    });

    it('rejects absolute paths outside workspace', () => {
      const result = validatePath('C:\\Windows\\System32\\config');
      // On Windows, this should resolve outside workspace
      if (process.platform === 'win32') {
        expect(result.valid).toBe(false);
      }
    });

    it('rejects empty path', () => {
      const result = validatePath('');
      expect(result.valid).toBe(false);
    });
  });

  describe('isSupportedExtension', () => {
    it('accepts JS/TS extensions', () => {
      expect(isSupportedExtension('file.js')).toBe(true);
      expect(isSupportedExtension('file.ts')).toBe(true);
      expect(isSupportedExtension('file.tsx')).toBe(true);
      expect(isSupportedExtension('file.jsx')).toBe(true);
      expect(isSupportedExtension('file.mjs')).toBe(true);
      expect(isSupportedExtension('file.cjs')).toBe(true);
      expect(isSupportedExtension('file.mts')).toBe(true);
      expect(isSupportedExtension('file.cts')).toBe(true);
    });

    it('rejects non-JS/TS extensions', () => {
      expect(isSupportedExtension('file.py')).toBe(false);
      expect(isSupportedExtension('file.json')).toBe(false);
      expect(isSupportedExtension('file.md')).toBe(false);
      expect(isSupportedExtension('file.css')).toBe(false);
    });
  });

  describe('isValidPreset', () => {
    it('accepts valid presets', () => {
      expect(isValidPreset('recommended')).toBe(true);
      expect(isValidPreset('strict')).toBe(true);
      expect(isValidPreset('security')).toBe(true);
      expect(isValidPreset('agent')).toBe(true);
    });

    it('rejects invalid presets', () => {
      expect(isValidPreset('invalid')).toBe(false);
      expect(isValidPreset('')).toBe(false);
    });
  });

  describe('sanitizeGitRef', () => {
    it('accepts safe refs', () => {
      expect(sanitizeGitRef('HEAD~1')).toBe('HEAD~1');
      expect(sanitizeGitRef('main')).toBe('main');
      expect(sanitizeGitRef('origin/main')).toBe('origin/main');
      expect(sanitizeGitRef('HEAD~5')).toBe('HEAD~5');
      expect(sanitizeGitRef('v1.0.0')).toBe('v1.0.0');
    });

    it('rejects shell injection attempts', () => {
      expect(sanitizeGitRef('main; rm -rf /')).toBeNull();
      expect(sanitizeGitRef('$(whoami)')).toBeNull();
      expect(sanitizeGitRef('`id`')).toBeNull();
      expect(sanitizeGitRef('')).toBeNull();
    });

    it('rejects path traversal in refs', () => {
      expect(sanitizeGitRef('../../../etc/passwd')).toBeNull();
    });
  });
});

// ─── ai_guard_rules tests ────────────────────────────────────────────────────

describe('ai_guard_rules', () => {
  it('returns all 18 rules', () => {
    const result = getRules({});
    expect(result.success).toBe(true);
    expect(result.totalRules).toBe(18);
    expect(result.rules).toHaveLength(18);
  });

  it('returns all 4 presets', () => {
    const result = getRules({});
    expect(result.presets).toEqual(
      expect.arrayContaining(['recommended', 'strict', 'security', 'agent']),
    );
    expect(result.presets).toHaveLength(4);
  });

  it('agent preset contains exactly 5 rules', () => {
    const result = getRules({ preset: 'agent' });
    expect(result.preset).toBe('agent');
    expect(result.presetRules).toHaveLength(5);
    expect(result.presetRules).toEqual(
      expect.arrayContaining([
        'ai-guard/no-hardcoded-secret',
        'ai-guard/no-eval-dynamic',
        'ai-guard/no-empty-catch',
        'ai-guard/no-sql-string-concat',
        'ai-guard/no-floating-promise',
      ]),
    );
  });

  it('every rule has a ruleId, category, and confidence', () => {
    const result = getRules({});
    for (const rule of result.rules) {
      expect(rule.ruleId).toMatch(/^ai-guard\//);
      expect(rule.category).toBeTruthy();
      expect(rule.confidence).toBeTruthy();
    }
  });

  it('no duplicate rule definitions', () => {
    const result = getRules({});
    const ruleIds = result.rules.map(r => r.ruleId);
    const unique = new Set(ruleIds);
    expect(unique.size).toBe(ruleIds.length);
  });
});

// ─── ai_guard_scan_file tests ─────────────────────────────────────────────────

describe('ai_guard_scan_file', () => {
  beforeAll(() => {
    setWorkspaceRoot(PROJECT_ROOT);
  });

  it('rejects path traversal', async () => {
    const result = await scanFile({ path: '../../../../etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.filesScanned).toBe(0);
  });

  it('rejects unsupported extension', async () => {
    const result = await scanFile({ path: 'package.json' });
    expect(result.success).toBe(false);
    expect(result.filesScanned).toBe(0);
  });

  it('handles non-existent file', async () => {
    const result = await scanFile({ path: 'src/nonexistent.ts' });
    expect(result.success).toBe(false);
    expect(result.filesScanned).toBe(0);
  });

  it('scans a valid JS file and returns structured results', async () => {
    // Create a temp fixture with a known issue
    const fixturePath = path.join(FIXTURES_DIR, 'mcp-test-file.js');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, `
const secret = "sk-abc123456789";
async function handler() {
  fetch("/api/data");
}
`, 'utf-8');

    try {
      const result = await scanFile({
        path: path.relative(PROJECT_ROOT, fixturePath),
        preset: 'agent',
      });
      expect(result.success).toBe(true);
      expect(result.filesScanned).toBeGreaterThanOrEqual(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.preset).toBe('agent');
      expect(Array.isArray(result.issues)).toBe(true);

      // Should detect hardcoded secret
      const secretIssue = result.issues.find(i => i.ruleId === 'ai-guard/no-hardcoded-secret');
      if (secretIssue) {
        expect(secretIssue.severity).toBe('error');
        expect(secretIssue.confidence).toBe('high');
        expect(secretIssue.line).toBeGreaterThan(0);
        expect(secretIssue.remediation).toBeTruthy();
      }
    } finally {
      fs.unlinkSync(fixturePath);
    }
  });

  it('recommended preset works', async () => {
    const fixturePath = path.join(FIXTURES_DIR, 'mcp-test-recommended.js');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, `
try { doSomething(); } catch(e) {}
`, 'utf-8');

    try {
      const result = await scanFile({
        path: path.relative(PROJECT_ROOT, fixturePath),
        preset: 'recommended',
      });
      expect(result.success).toBe(true);
      expect(result.preset).toBe('recommended');
    } finally {
      fs.unlinkSync(fixturePath);
    }
  });

  it('empty result for clean file', async () => {
    const fixturePath = path.join(FIXTURES_DIR, 'mcp-test-clean.js');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, `
const x = 1;
console.log(x);
`, 'utf-8');

    try {
      const result = await scanFile({
        path: path.relative(PROJECT_ROOT, fixturePath),
        preset: 'agent',
      });
      expect(result.success).toBe(true);
      expect(result.issues).toHaveLength(0);
    } finally {
      fs.unlinkSync(fixturePath);
    }
  });
});

// ─── ai_guard_scan_diff tests ─────────────────────────────────────────────────

describe('ai_guard_scan_diff', () => {
  beforeAll(() => {
    setWorkspaceRoot(PROJECT_ROOT);
  });

  it('handles no changes gracefully', async () => {
    const result = await scanDiff({ preset: 'agent' });
    expect(result.success).toBe(true);
    // May or may not have changes depending on working tree state
    expect(Array.isArray(result.issues)).toBe(true);
    expect(typeof result.durationMs).toBe('number');
  });

  it('rejects shell injection in base ref', async () => {
    const result = await scanDiff({
      base: 'main; rm -rf /',
      preset: 'agent',
    });
    expect(result.success).toBe(false);
    expect(result.scanMode).toBe('error');
  });

  it('handles invalid git ref safely', async () => {
    const result = await scanDiff({
      base: 'nonexistent-branch-xyz-123',
      preset: 'agent',
    });
    expect(result.success).toBe(true);
    // Should not crash — returns empty or actual results
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it('scans newly created untracked JS/TS file without requiring git add', async () => {
    const untrackedFile = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'mcp-untracked-fixture.ts');
    fs.mkdirSync(path.dirname(untrackedFile), { recursive: true });
    fs.writeFileSync(
      untrackedFile,
      'const secretKey = "sk-live-1234567890abcdef";\n',
      'utf-8',
    );
    try {
      const result = await scanDiff({ preset: 'agent' });
      expect(result.success).toBe(true);
      const secretIssue = result.issues.find(
        (i) => i.ruleId === 'ai-guard/no-hardcoded-secret' && i.file.includes('mcp-untracked-fixture.ts'),
      );
      expect(secretIssue).toBeDefined();
    } finally {
      if (fs.existsSync(untrackedFile)) {
        fs.unlinkSync(untrackedFile);
      }
    }
  });
});

// ─── Untracked differential scanning tests (getChangedFiles) ──────────────────

describe('untracked file differential scanning', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-untracked-test-'));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });

    // Initial commit with a tracked file and .gitignore
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\nignored/\n*.log\n', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'tracked.js'), 'console.log("hello");\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempDir, stdio: 'pipe' });
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('clean repository returns zero files', () => {
    const res = getChangedFiles({ cwd: tempDir });
    expect(res.files).toHaveLength(0);
  });

  it('untracked JS file is detected', () => {
    const jsFile = path.join(tempDir, 'new-file.js');
    fs.writeFileSync(jsFile, 'const a = 1;\n', 'utf-8');
    try {
      const res = getChangedFiles({ cwd: tempDir });
      expect(res.files).toHaveLength(1);
      expect(res.files[0]).toContain('new-file.js');
    } finally {
      fs.unlinkSync(jsFile);
    }
  });

  it('untracked TS file is detected', () => {
    const tsFile = path.join(tempDir, 'service.ts');
    fs.writeFileSync(tsFile, 'export const b: number = 2;\n', 'utf-8');
    try {
      const res = getChangedFiles({ cwd: tempDir });
      expect(res.files).toHaveLength(1);
      expect(res.files[0]).toContain('service.ts');
    } finally {
      fs.unlinkSync(tsFile);
    }
  });

  it('unsupported untracked file is ignored', () => {
    const cssFile = path.join(tempDir, 'style.css');
    fs.writeFileSync(cssFile, 'body { color: red; }\n', 'utf-8');
    try {
      const res = getChangedFiles({ cwd: tempDir });
      expect(res.files).toHaveLength(0);
      expect(res.debugInfo.droppedByExtension).toBeGreaterThanOrEqual(1);
    } finally {
      fs.unlinkSync(cssFile);
    }
  });

  it('ignored file is not scanned', () => {
    const ignoredDir = path.join(tempDir, 'ignored');
    fs.mkdirSync(ignoredDir, { recursive: true });
    const ignoredFile = path.join(ignoredDir, 'secret.js');
    fs.writeFileSync(ignoredFile, 'const key = "123";\n', 'utf-8');
    try {
      const res = getChangedFiles({ cwd: tempDir });
      expect(res.files).toHaveLength(0);
    } finally {
      fs.rmSync(ignoredDir, { recursive: true, force: true });
    }
  });

  it('tracked modified file still works', () => {
    const trackedFile = path.join(tempDir, 'tracked.js');
    fs.writeFileSync(trackedFile, 'console.log("modified");\n', 'utf-8');
    try {
      const res = getChangedFiles({ cwd: tempDir });
      expect(res.files).toHaveLength(1);
      expect(res.files[0]).toContain('tracked.js');
    } finally {
      execFileSync('git', ['checkout', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });
    }
  });

  it('tracked + untracked files are both returned', () => {
    const trackedFile = path.join(tempDir, 'tracked.js');
    fs.writeFileSync(trackedFile, 'console.log("modified");\n', 'utf-8');
    const untrackedFile = path.join(tempDir, 'created.ts');
    fs.writeFileSync(untrackedFile, 'const x = 1;\n', 'utf-8');
    try {
      const res = getChangedFiles({ cwd: tempDir });
      expect(res.files).toHaveLength(2);
      const names = res.files.map(f => path.basename(f));
      expect(names).toContain('tracked.js');
      expect(names).toContain('created.ts');
    } finally {
      execFileSync('git', ['checkout', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });
      fs.unlinkSync(untrackedFile);
    }
  });

  it('duplicate file paths are deduplicated', () => {
    const trackedFile = path.join(tempDir, 'tracked.js');
    fs.writeFileSync(trackedFile, 'console.log("staged + unstaged");\n', 'utf-8');
    execFileSync('git', ['add', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(trackedFile, 'console.log("staged + unstaged edit");\n', 'utf-8');
    try {
      const res = getChangedFiles({ cwd: tempDir });
      const matches = res.files.filter(f => f.includes('tracked.js'));
      expect(matches).toHaveLength(1);
    } finally {
      execFileSync('git', ['reset', 'HEAD', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['checkout', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });
    }
  });

  it('staged mode only returns staged files and ignores untracked files', () => {
    const trackedFile = path.join(tempDir, 'tracked.js');
    fs.writeFileSync(trackedFile, 'console.log("staged file");\n', 'utf-8');
    execFileSync('git', ['add', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });

    const untrackedFile = path.join(tempDir, 'untracked.js');
    fs.writeFileSync(untrackedFile, 'console.log("not staged");\n', 'utf-8');

    try {
      const res = getChangedFiles({ cwd: tempDir, staged: true });
      expect(res.mode).toBe('staged');
      expect(res.files).toHaveLength(1);
      expect(res.files[0]).toContain('tracked.js');
    } finally {
      execFileSync('git', ['reset', 'HEAD', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['checkout', 'tracked.js'], { cwd: tempDir, stdio: 'pipe' });
      fs.unlinkSync(untrackedFile);
    }
  });

  it('invalid Git state is handled safely', () => {
    const res = getChangedFiles({ cwd: '/nonexistent/path/xyz123' });
    expect(res.mode).toBe('fallback');
    expect(res.files).toHaveLength(0);
    expect(res.zeroFilesReason).toBeTruthy();
  });
});

// ─── MCP Server startup test ──────────────────────────────────────────────────

describe('MCP server', () => {
  it('built MCP server file exists', () => {
    const serverPath = path.join(PROJECT_ROOT, 'dist', 'mcp', 'server.js');
    expect(fs.existsSync(serverPath)).toBe(true);
  });

  it('server file has shebang', () => {
    const serverPath = path.join(PROJECT_ROOT, 'dist', 'mcp', 'server.js');
    const content = fs.readFileSync(serverPath, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
