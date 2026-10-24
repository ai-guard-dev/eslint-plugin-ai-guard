/**
 * Claude Code hook protocol (https://code.claude.com/docs/en/hooks):
 * the hook always exits 0 and communicates through a JSON object on stdout.
 * Plain stdout from an exit-0 hook is never shown to Claude.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempRepo, type TempRepo } from '../helpers/git-repo';
import { handleHookInput, parseHookInput, type HookOptions } from '../../cli/commands/claude-hook';
import type { RunResult } from '../../cli/utils/eslint-runner';

const TESTS = `describe('cart', () => {\n  it('adds', () => { expect(1).toBe(1); });\n  it('totals', () => { expect(2).toBe(2); });\n});\n`;

let repo: TempRepo;
let stateDir: string;

function cleanLint(): Promise<RunResult> {
  return Promise.resolve({
    files: [], totalErrors: 0, totalWarnings: 0, totalIssues: 0, filesScanned: 1, ruleBreakdown: new Map(),
    topFiles: [], durationMs: 1, ecosystemIssues: [], parserErrors: [], ignoredFiles: [], tsParserAvailable: true,
  });
}

function opts(extra: Partial<HookOptions> = {}): HookOptions {
  return { stateDir, bashGuard: 'ask', lint: cleanLint, ...extra };
}

beforeEach(() => {
  repo = createTempRepo({ 'src/cart.test.ts': TESTS, 'src/a.js': 'export const a = 1;\n' });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-hook-state-'));
});

afterEach(() => {
  repo.cleanup();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const post = (file: string, session = 's1') => ({
  hook_event_name: 'PostToolUse', session_id: session, cwd: repo.dir, tool_name: 'Edit',
  tool_input: { file_path: path.join(repo.dir, file) },
});
const stop = (session = 's1', active = false) => ({ hook_event_name: 'Stop', session_id: session, cwd: repo.dir, stop_hook_active: active });

describe('parseHookInput', () => {
  it('rejects empty, invalid and non-object payloads', () => {
    expect(parseHookInput('').input).toBeNull();
    expect(parseHookInput('{not json').error).toBe('Invalid JSON on stdin');
    expect(parseHookInput('[1]').error).toBe('Hook payload is not a JSON object');
    expect(parseHookInput('{"hook_event_name":"Stop"}').input).toEqual({ hook_event_name: 'Stop' });
  });
});

describe('PostToolUse', () => {
  it('returns nothing when the edit is clean', async () => {
    repo.write('src/a.js', 'export const a = 2;\n');
    expect(await handleHookInput(post('src/a.js'), opts())).toBeNull();
  });

  it('sends lint findings to Claude with decision "block" and a reason', async () => {
    repo.write('src/a.js', 'try { run(); } catch (e) {}\n');
    const out = await handleHookInput(post('src/a.js'), opts({ lint: undefined }));
    expect(out).toMatchObject({ decision: 'block' });
    expect(out!.reason).toContain('ai-guard/no-empty-catch');
    expect(out!.reason).toContain('Fix:');
  }, 30000);

  it('reports a weakening introduced by the edit in that file', async () => {
    repo.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'"));
    const out = await handleHookInput(post('src/cart.test.ts'), opts());
    expect(out!.decision).toBe('block');
    expect(out!.reason).toContain('Skipped the existing test "cart > totals"');
  });

  it('sends advisories as additionalContext without blocking, once per session', async () => {
    repo.write('src/a.js', 'export const a = 1;\n// eslint-disable-next-line no-console -- debug output\nconsole.log(a);\n');
    const first = await handleHookInput(post('src/a.js'), opts());
    expect(first).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('advisory') } });
    expect(await handleHookInput(post('src/a.js'), opts())).toBeNull();
  });

  it('works outside a Git repository (lint feedback only) and ignores non-file tools', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-nogit-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.js'), 'export const x = 1;\n');
      expect(await handleHookInput({ hook_event_name: 'PostToolUse', cwd: dir, tool_input: { file_path: path.join(dir, 'x.js') } }, opts())).toBeNull();
      expect(await handleHookInput({ hook_event_name: 'PostToolUse', cwd: dir, tool_input: { command: 'ls' } }, opts())).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Stop', () => {
  it('allows stopping when nothing was weakened', async () => {
    repo.write('src/a.js', 'export const a = 3;\n');
    expect(await handleHookInput(stop(), opts())).toBeNull();
  });

  it('blocks once per unique finding set, then only informs the user (no loop)', async () => {
    repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.only('adds'"));
    const first = await handleHookInput(stop(), opts());
    expect(first).toMatchObject({ decision: 'block' });
    expect(first!.reason).toContain('Focused test "cart > adds"');
    expect(first!.reason).toContain('npx ai-guard integrity --accept');

    const again = await handleHookInput(stop('s1', true), opts());
    expect(again).toEqual({ systemMessage: expect.stringContaining('remain unresolved') });

    // A different (new) finding set blocks again.
    repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.only('adds'").replace("it('totals'", "it.skip('totals'"));
    expect(await handleHookInput(stop('s1', true), opts())).toMatchObject({ decision: 'block' });
  });

  it('without a session id, never blocks when stop_hook_active is set', async () => {
    repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.only('adds'"));
    const input = { hook_event_name: 'Stop', cwd: repo.dir };
    expect(await handleHookInput(input, opts())).toMatchObject({ decision: 'block' });
    expect(await handleHookInput({ ...input, stop_hook_active: true }, opts())).toEqual({ systemMessage: expect.any(String) });
  });

  it('advisory-only findings never block; they are shown to the user once', async () => {
    repo.write('src/cart.test.ts', TESTS.replace('expect(1).toBe(1)', 'expect(1).toBeTruthy()').replace('expect(2).toBe(2)', 'expect(2).toBeDefined()'));
    expect(await handleHookInput(stop(), opts())).toEqual({ systemMessage: expect.stringContaining('advisory') });
    expect(await handleHookInput(stop(), opts())).toBeNull();
  });

  it('SessionStart snapshots the working tree so earlier user changes are not attributed to the agent', async () => {
    // The user had already skipped a test before the session started.
    repo.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'"));
    expect(await handleHookInput({ hook_event_name: 'SessionStart', session_id: 's2', cwd: repo.dir, source: 'startup' }, opts())).toBeNull();
    expect(repo.git('status', '--porcelain')).toContain('src/cart.test.ts'); // user files untouched
    expect(await handleHookInput(stop('s2'), opts())).toBeNull();
    // The agent then focuses another test.
    repo.write('src/cart.test.ts', TESTS.replace("it('totals'", "it.skip('totals'").replace("it('adds'", "it.only('adds'"));
    const out = await handleHookInput(stop('s2'), opts());
    expect(out!.reason).toContain('Focused test');
    expect(out!.reason).not.toContain('Skipped');
  });

  it('respects explicit acceptances in the baseline file', async () => {
    repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.only('adds'"));
    const blocked = await handleHookInput(stop('s3'), opts());
    expect(blocked!.decision).toBe('block');
    const { analyzeIntegrity } = await import('../../cli/utils/integrity/engine');
    const { addIntegrityAcceptances } = await import('../../cli/utils/baseline');
    const report = await analyzeIntegrity({ cwd: repo.dir });
    addIntegrityAcceptances(path.join(repo.dir, '.ai-guard-baseline.json'), report.findings);
    // The acceptance itself is an advisory finding for reviewers; nothing blocks.
    expect(await handleHookInput(stop('s4'), opts())).toEqual({ systemMessage: expect.stringContaining('accepts 1 integrity finding') });
  });
});

describe('acceptances written by the agent', () => {
  it('an agent editing the baseline file to accept its own weakening is blocked at edit time and at Stop', async () => {
    repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.only('adds'"));
    const { analyzeIntegrity } = await import('../../cli/utils/integrity/engine');
    const report = await analyzeIntegrity({ cwd: repo.dir });
    const accepted = report.findings.map((f) => ({ fingerprint: f.fingerprint, ruleId: f.ruleId, file: f.file, message: f.message, acceptedAt: 'x' }));
    // The agent writes the acceptance with its Write tool.
    repo.write('.ai-guard-baseline.json', JSON.stringify({ createdAt: 'x', preset: 'recommended', mode: 'stable', totalIssues: 0, entries: [], integrity: { accepted } }));
    const edit = await handleHookInput(post('.ai-guard-baseline.json', 's5'), opts());
    expect(edit).toMatchObject({ decision: 'block', reason: expect.stringContaining('accepts 1 integrity finding') });
    const stopped = await handleHookInput(stop('s5'), opts());
    expect(stopped).toMatchObject({ decision: 'block', reason: expect.stringContaining('accepts 1 integrity finding') });
  });
});

describe('PreToolUse (Bash guard)', () => {
  const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo.dir, tool_input: { command } });

  it('asks before commands that skip Git hooks', async () => {
    for (const cmd of ['git commit --no-verify -m "x"', 'git commit -nm wip', 'HUSKY=0 git commit -m x', 'git push --no-verify origin main']) {
      expect(await handleHookInput(bash(cmd), opts())).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: expect.stringContaining('bypasses Git hooks') },
      });
    }
  });

  it('allows normal commands and look-alikes', async () => {
    for (const cmd of ['git commit -m "mention --no-verify in docs"', 'git push -n origin main', 'git commit --amend -m x', 'npm test']) {
      expect(await handleHookInput(bash(cmd), opts())).toBeNull();
    }
  });

  it('asks before the agent accepts integrity findings itself', async () => {
    for (const cmd of ['npx ai-guard integrity --accept all', 'node_modules/.bin/ai-guard integrity --base main --accept 1a2b3c4d']) {
      const out = await handleHookInput(bash(cmd), opts());
      expect(out!.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask', permissionDecisionReason: expect.stringContaining('Only the user should accept') });
    }
    expect(await handleHookInput(bash('npx ai-guard integrity --json'), opts())).toBeNull();
    expect(await handleHookInput(bash('echo "ai-guard integrity --accept all"'), opts())).toBeNull();
  });

  it('supports deny and off', async () => {
    expect((await handleHookInput(bash('git commit --no-verify'), opts({ bashGuard: 'deny' })))!.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(await handleHookInput(bash('git commit --no-verify'), opts({ bashGuard: 'off' }))).toBeNull();
  });

  it('ignores other tools and unsupported events', async () => {
    expect(await handleHookInput({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { command: 'git commit --no-verify' } }, opts())).toBeNull();
    expect(await handleHookInput({ hook_event_name: 'Notification', cwd: repo.dir }, opts())).toBeNull();
  });
});

describe('built CLI: claude-hook', () => {
  const cli = path.join(process.cwd(), 'dist', 'cli', 'index.js');
  const run = (payload: string) => spawnSync(process.execPath, [cli, 'claude-hook'], {
    input: payload, encoding: 'utf8', cwd: repo.dir, env: { ...process.env, AI_GUARD_STATE_DIR: stateDir, NO_COLOR: '1' },
  });

  it('prints one JSON object and exits 0 for each event, and nothing for no findings or bad input', () => {
    repo.write('src/cart.test.ts', TESTS.replace("it('adds'", "it.only('adds'"));
    const stopped = run(JSON.stringify(stop('cli')));
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ decision: 'block' });

    const bypass = run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit --no-verify' } }));
    expect(JSON.parse(bypass.stdout).hookSpecificOutput.permissionDecision).toBe('ask');

    for (const bad of ['', '{oops', JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'cli2', cwd: repo.dir })]) {
      const r = run(bad);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  }, 60000);
});
