/**
 * tests/ci/entrypoint-security.test.ts
 *
 * Security and correctness regression tests for action/entrypoint.js.
 *
 * Covers:
 * - C2: No shell injection via GitHub Action inputs (shell:false, structured argv)
 * - H9: Action outputs (high-confidence-count, medium-confidence-count, files-scanned)
 *       reflect actual scan results instead of always being 0
 * - H10: Signal-killed process (null status) reports failure, not success
 * - H11: Paths containing spaces are preserved as single arguments
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function interceptSpawnSync() {
  const calls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];

  vi.spyOn(require('child_process'), 'spawnSync').mockImplementation(
    (cmd: string, args: string[], options?: Record<string, unknown>) => {
      calls.push({ cmd, args: args ?? [], options: options ?? {} });
      return { status: 0, signal: null, stdout: '', stderr: '' };
    },
  );

  return calls;
}

async function runEntrypoint(env: Record<string, string>): Promise<{
  calls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }>;
  exitCode: number | null;
}> {
  const calls = interceptSpawnSync();

  const exitCode = { value: null as number | null };
  const originalExit = process.exit;
  (process as any).exit = (code?: number) => {
    exitCode.value = code ?? 0;
  };

  const savedEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  if (!env.GITHUB_OUTPUT) delete process.env.GITHUB_OUTPUT;
  if (!env.GITHUB_BASE_REF) delete process.env.GITHUB_BASE_REF;

  try {
    const entrypointPath = path.resolve(__dirname, '../../action/entrypoint.js');
    delete require.cache[entrypointPath];

    await new Promise<void>((resolve) => {
      require(entrypointPath);
      setTimeout(resolve, 100);
    });
  } finally {
    process.env = savedEnv;
    (process as any).exit = originalExit;
  }

  return { calls, exitCode: exitCode.value };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('C2: No shell injection in action/entrypoint.js', () => {
  beforeEach(() => {
    vi.spyOn(require('child_process'), 'execSync').mockImplementation(() => '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses shell: false for spawnSync', async () => {
    const { calls } = await runEntrypoint({
      INPUT_PATH: 'src',
      INPUT_FAIL_ON: 'high',
      INPUT_CHANGED_ONLY: 'false',
      INPUT_INSTALL_DEPS: 'false',
    });

    expect(calls.length).toBeGreaterThan(0);
    const aiGuardCall = calls.find((c) => c.args.includes('ai-guard'));
    expect(aiGuardCall).toBeDefined();
    expect(aiGuardCall!.options.shell).toBe(false);
  });

  it('passes path with shell metacharacters as a single argument', async () => {
    const maliciousPath = 'src;echo PWNED';
    const { calls } = await runEntrypoint({
      INPUT_PATH: maliciousPath,
      INPUT_FAIL_ON: 'high',
      INPUT_CHANGED_ONLY: 'false',
      INPUT_INSTALL_DEPS: 'false',
    });

    const aiGuardCall = calls.find((c) => c.args.includes('ai-guard'));
    expect(aiGuardCall).toBeDefined();

    const pathIdx = aiGuardCall!.args.indexOf('--path');
    expect(pathIdx).toBeGreaterThan(-1);
    expect(aiGuardCall!.args[pathIdx + 1]).toBe(maliciousPath);
  });

  it('passes path with spaces as a single argument', async () => {
    const pathWithSpaces = 'my project/src';
    const { calls } = await runEntrypoint({
      INPUT_PATH: pathWithSpaces,
      INPUT_FAIL_ON: 'high',
      INPUT_CHANGED_ONLY: 'false',
      INPUT_INSTALL_DEPS: 'false',
    });

    const aiGuardCall = calls.find((c) => c.args.includes('ai-guard'));
    expect(aiGuardCall).toBeDefined();

    const pathIdx = aiGuardCall!.args.indexOf('--path');
    expect(aiGuardCall!.args[pathIdx + 1]).toBe(pathWithSpaces);
  });

  it('does not join arguments into a shell string', async () => {
    const { calls } = await runEntrypoint({
      INPUT_PATH: 'src',
      INPUT_FAIL_ON: 'high',
      INPUT_CHANGED_ONLY: 'false',
      INPUT_INSTALL_DEPS: 'false',
    });

    const aiGuardCall = calls.find((c) => c.args.includes('ai-guard'));
    expect(aiGuardCall).toBeDefined();
    expect(aiGuardCall!.cmd).toBe('npx');
  });
});

describe('H10: Signal-killed process reports failure', () => {
  beforeEach(() => {
    vi.spyOn(require('child_process'), 'execSync').mockImplementation(() => '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports failure when status is null (signal kill)', async () => {
    vi.spyOn(require('child_process'), 'spawnSync').mockImplementation(() => ({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
    }));

    const exitCode = { value: null as number | null };
    const originalExit = process.exit;
    (process as any).exit = (code?: number) => {
      exitCode.value = code ?? 0;
    };

    const savedEnv = { ...process.env };
    process.env.INPUT_PATH = 'src';
    process.env.INPUT_FAIL_ON = 'high';
    process.env.INPUT_CHANGED_ONLY = 'false';
    process.env.INPUT_INSTALL_DEPS = 'false';
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_BASE_REF;

    try {
      const entrypointPath = path.resolve(__dirname, '../../action/entrypoint.js');
      delete require.cache[entrypointPath];
      await new Promise<void>((resolve) => {
        require(entrypointPath);
        setTimeout(resolve, 100);
      });

      expect(exitCode.value).not.toBe(0);
      expect(exitCode.value).not.toBe(null);
    } finally {
      process.env = savedEnv;
      (process as any).exit = originalExit;
    }
  });

  it('reports success when status is 0', async () => {
    vi.spyOn(require('child_process'), 'spawnSync').mockImplementation(() => ({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
    }));

    const exitCode = { value: null as number | null };
    const originalExit = process.exit;
    (process as any).exit = (code?: number) => {
      exitCode.value = code ?? 0;
    };

    const savedEnv = { ...process.env };
    process.env.INPUT_PATH = 'src';
    process.env.INPUT_FAIL_ON = 'high';
    process.env.INPUT_CHANGED_ONLY = 'false';
    process.env.INPUT_INSTALL_DEPS = 'false';
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_BASE_REF;

    try {
      const entrypointPath = path.resolve(__dirname, '../../action/entrypoint.js');
      delete require.cache[entrypointPath];
      await new Promise<void>((resolve) => {
        require(entrypointPath);
        setTimeout(resolve, 100);
      });

      expect(exitCode.value).toBe(0);
    } finally {
      process.env = savedEnv;
      (process as any).exit = originalExit;
    }
  });
});

describe('H9: Action outputs reflect actual scan results', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses SARIF results to populate confidence counts and files-scanned', async () => {
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-guard-test-'));
    const sarifPath = path.join(tmpDir, 'results.sarif');

    const mockSarif = {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'ai-guard', version: '1.3.0' } },
        automationDetails: { id: 'ai-guard' },
        results: [
          { ruleId: 'ai-guard/no-hardcoded-secret', level: 'error', properties: { precision: 'high' } },
          { ruleId: 'ai-guard/no-eval-dynamic', level: 'error', properties: { precision: 'high' } },
          { ruleId: 'ai-guard/no-await-in-loop', level: 'warning', properties: { precision: 'medium' } },
          { ruleId: 'ai-guard/no-empty-catch', level: 'error', properties: { precision: 'high' } },
        ],
        properties: {
          filesScanned: 42,
          durationMs: 1234,
        },
      }],
    };

    fs.writeFileSync(sarifPath, JSON.stringify(mockSarif));

    vi.spyOn(require('child_process'), 'spawnSync').mockImplementation(() => ({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
    }));

    vi.spyOn(require('child_process'), 'execSync').mockImplementation(() => '');

    const outputs: Record<string, string> = {};
    const outputFile = path.join(tmpDir, 'github-output');
    process.env.GITHUB_OUTPUT = outputFile;

    const exitCode = { value: null as number | null };
    const originalExit = process.exit;
    (process as any).exit = (code?: number) => {
      exitCode.value = code ?? 0;
    };

    const savedEnv = { ...process.env };
    process.env.INPUT_PATH = 'src';
    process.env.INPUT_FAIL_ON = 'high';
    process.env.INPUT_CHANGED_ONLY = 'false';
    process.env.INPUT_INSTALL_DEPS = 'false';
    process.env.INPUT_SARIF_OUTPUT = sarifPath;
    delete process.env.GITHUB_BASE_REF;

    try {
      const entrypointPath = path.resolve(__dirname, '../../action/entrypoint.js');
      delete require.cache[entrypointPath];
      await new Promise<void>((resolve) => {
        require(entrypointPath);
        setTimeout(resolve, 200);
      });

      if (fs.existsSync(outputFile)) {
        const content = fs.readFileSync(outputFile, 'utf-8');
        for (const line of content.split('\n')) {
          const match = line.match(/^(\w+)=(.+)$/);
          if (match) {
            outputs[match[1]] = match[2];
          }
        }
      }

      expect(outputs['issues-found']).toBe('4');
      expect(outputs['high-confidence-count']).toBe('3');
      expect(outputs['medium-confidence-count']).toBe('1');
      expect(outputs['files-scanned']).toBe('42');
      expect(outputs['duration-ms']).toBe('1234');
    } finally {
      process.env = savedEnv;
      (process as any).exit = originalExit;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('produces zero counts when SARIF has no results', async () => {
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-guard-test-'));
    const sarifPath = path.join(tmpDir, 'results.sarif');

    const mockSarif = {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'ai-guard', version: '1.3.0' } },
        results: [],
        properties: { filesScanned: 5, durationMs: 100 },
      }],
    };

    fs.writeFileSync(sarifPath, JSON.stringify(mockSarif));

    vi.spyOn(require('child_process'), 'spawnSync').mockImplementation(() => ({
      status: 0, signal: null, stdout: '', stderr: '',
    }));
    vi.spyOn(require('child_process'), 'execSync').mockImplementation(() => '');

    const outputs: Record<string, string> = {};
    const outputFile = path.join(tmpDir, 'github-output');
    process.env.GITHUB_OUTPUT = outputFile;

    const exitCode = { value: null as number | null };
    const originalExit = process.exit;
    (process as any).exit = (code?: number) => {
      exitCode.value = code ?? 0;
    };

    const savedEnv = { ...process.env };
    process.env.INPUT_PATH = 'src';
    process.env.INPUT_FAIL_ON = 'high';
    process.env.INPUT_CHANGED_ONLY = 'false';
    process.env.INPUT_INSTALL_DEPS = 'false';
    process.env.INPUT_SARIF_OUTPUT = sarifPath;
    delete process.env.GITHUB_BASE_REF;

    try {
      const entrypointPath = path.resolve(__dirname, '../../action/entrypoint.js');
      delete require.cache[entrypointPath];
      await new Promise<void>((resolve) => {
        require(entrypointPath);
        setTimeout(resolve, 200);
      });

      if (fs.existsSync(outputFile)) {
        const content = fs.readFileSync(outputFile, 'utf-8');
        for (const line of content.split('\n')) {
          const match = line.match(/^(\w+)=(.+)$/);
          if (match) outputs[match[1]] = match[2];
        }
      }

      expect(outputs['issues-found']).toBe('0');
      expect(outputs['high-confidence-count']).toBe('0');
      expect(outputs['medium-confidence-count']).toBe('0');
      expect(outputs['files-scanned']).toBe('5');
    } finally {
      process.env = savedEnv;
      (process as any).exit = originalExit;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});