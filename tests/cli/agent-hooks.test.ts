/**
 * Hooks for Cursor and Codex: payload translation (pure) and end-to-end runs
 * through the real engine in temporary Git repositories. Payload shapes follow
 * each vendor's documentation (cursor.com/docs/hooks, Codex hooks docs).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canSkipQuickly, normalizeHookInput, patchedFiles, translateHookOutput, CURSOR_SHELL_MATCHER } from '../../cli/utils/hooks/agents';
import { runAgentHook, type HookOptions } from '../../cli/commands/claude-hook';
import { detectAgents, hookCommand, mergeCodexHooks, mergeCursorHooks, parseAgentList } from '../../cli/commands/init-hooks';
import { RegistryClient } from '../../cli/utils/deps/registry';
import { established, NOW, startFakeRegistry, type FakeRegistry } from '../helpers/fake-registry';

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.js',
  '@@',
  '-old',
  '+new',
  '*** Add File: src/b.ts',
  '+export const b = 1;',
  '*** Update File: src/old.js',
  '*** Move to: src/new.js',
  '*** Delete File: src/gone.js',
  '*** End Patch',
].join('\n');

describe('patchedFiles', () => {
  it('lists added, updated and moved files, not deleted ones', () => {
    expect(patchedFiles(PATCH)).toEqual(['src/a.js', 'src/b.ts', 'src/new.js']);
  });
});

describe('canSkipQuickly', () => {
  it('skips shell commands that name no package manager, Git or AI Guard', () => {
    expect(canSkipQuickly('codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la src' } })).toBe(true);
    expect(canSkipQuickly('cursor', { hook_event_name: 'beforeShellExecution', command: 'cat README.md' })).toBe(true);
    expect(canSkipQuickly('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } })).toBe(true);
  });

  it('never skips relevant commands or other events', () => {
    for (const command of ['npm i lodash', 'git commit --no-verify -m x', 'HUSKY=0 git push', 'npx create-vite', 'bun add zod', 'npx ai-guard integrity --accept all']) {
      expect(canSkipQuickly('codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })).toBe(false);
      expect(new RegExp(CURSOR_SHELL_MATCHER, 'i').test(command)).toBe(true);
    }
    expect(canSkipQuickly('codex', { hook_event_name: 'Stop' })).toBe(false);
    expect(canSkipQuickly('codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: PATCH } })).toBe(false);
    expect(canSkipQuickly('cursor', { hook_event_name: 'stop', status: 'completed' })).toBe(false);
  });
});

describe('normalizeHookInput', () => {
  it('Codex: shell commands become Bash PreToolUse; patches become one edit per file', () => {
    expect(normalizeHookInput('codex', { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r', tool_name: 'exec_command', tool_input: { command: 'npm i x' } }).inputs)
      .toEqual([{ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r', tool_name: 'Bash', tool_input: { command: 'npm i x' } }]);
    const post = normalizeHookInput('codex', { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/r', tool_name: 'apply_patch', tool_input: { command: PATCH } });
    expect(post.inputs.map((i) => i.tool_input?.file_path)).toEqual(['src/a.js', 'src/b.ts', 'src/new.js']);
    expect(normalizeHookInput('codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: PATCH } }).inputs).toEqual([]);
  });

  it('Cursor: maps events, uses the conversation as the session, and respects aborted turns', () => {
    const shell = normalizeHookInput('cursor', { hook_event_name: 'beforeShellExecution', conversation_id: 'c1', command: 'npm i x', cwd: '/r/web', workspace_roots: ['/r'] });
    expect(shell.inputs[0]).toMatchObject({ hook_event_name: 'PreToolUse', session_id: 'c1', cwd: '/r/web', tool_name: 'Bash', tool_input: { command: 'npm i x' } });
    expect(normalizeHookInput('cursor', { hook_event_name: 'stop', conversation_id: 'c1', status: 'completed', loop_count: 0, workspace_roots: ['/r'] }).inputs[0])
      .toMatchObject({ hook_event_name: 'Stop', session_id: 'c1', cwd: '/r', stop_hook_active: false });
    expect(normalizeHookInput('cursor', { hook_event_name: 'stop', conversation_id: 'c1', status: 'completed', loop_count: 1 }).inputs[0].stop_hook_active).toBe(true);
    expect(normalizeHookInput('cursor', { hook_event_name: 'stop', status: 'aborted' }).inputs).toEqual([]);
    expect(normalizeHookInput('cursor', { hook_event_name: 'afterFileEdit', file_path: 'x.js' }).event).toBeNull();
  });
});

describe('translateHookOutput', () => {
  const ask = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Risky.', additionalContext: 'Why.' } };
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Missing.' } };
  const warn = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Deprecated.' } };

  it('Cursor: permission fields; nothing at all when there is no decision', () => {
    expect(translateHookOutput('cursor', 'PreToolUse', [ask])).toEqual({ permission: 'ask', user_message: 'Risky.', agent_message: 'Risky.\n\nWhy.' });
    expect(translateHookOutput('cursor', 'PreToolUse', [deny])).toEqual({ permission: 'deny', user_message: 'Missing.', agent_message: 'Missing.' });
    expect(translateHookOutput('cursor', 'PreToolUse', [warn])).toBeNull();
    expect(translateHookOutput('cursor', 'PreToolUse', [null])).toBeNull();
  });

  it('Cursor: a finish gate becomes a follow-up message; a note for the user has no channel', () => {
    expect(translateHookOutput('cursor', 'Stop', [{ decision: 'block', reason: 'Fix it.' }])).toEqual({ followup_message: 'Fix it.' });
    expect(translateHookOutput('cursor', 'Stop', [{ systemMessage: 'Still open.' }])).toBeNull();
    expect(translateHookOutput('cursor', 'SessionStart', [{}])).toBeNull();
  });

  it('Codex: ask becomes a deny that tells the agent to ask; edit findings go to additionalContext', () => {
    const asked = translateHookOutput('codex', 'PreToolUse', [ask]) as { hookSpecificOutput: Record<string, string> };
    expect(asked.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(asked.hookSpecificOutput.permissionDecisionReason).toMatch(/^This command needs the user's confirmation.*Ask the user/s);
    expect(asked.hookSpecificOutput.additionalContext).toBe('Why.');
    expect(translateHookOutput('codex', 'PreToolUse', [warn])).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Deprecated.' } });

    const post = translateHookOutput('codex', 'PostToolUse', [
      { decision: 'block', reason: 'eval in a.js' },
      null,
      { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'advisory in b.ts' } },
    ]) as { decision?: string; hookSpecificOutput: { additionalContext: string } };
    expect(post.decision).toBeUndefined();
    expect(post.hookSpecificOutput.additionalContext).toBe('Fix before you continue:\neval in a.js\n\nadvisory in b.ts');
    expect(translateHookOutput('codex', 'Stop', [{ decision: 'block', reason: 'r' }])).toEqual({ decision: 'block', reason: 'r' });
    expect(translateHookOutput('codex', 'SessionStart', [{}])).toBeNull();
  });
});

describe('end to end through the engine', () => {
  let repo: string;
  let stateDir: string;
  let registry: FakeRegistry;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };
  const opts = (): HookOptions => ({
    stateDir, bashGuard: 'ask', isolated: true, checkInstalls: true,
    installGuard: { client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, now: () => NOW }), registryConfig: { publicDefault: true, customScopes: new Set(), sources: [] }, confirmRegistry: () => true },
  });

  beforeEach(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-agents-')));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-agents-state-'));
    registry = await startFakeRegistry({ lodash: established() });
    git('init', '-q');
    write('package.json', '{"name":"demo","type":"module"}');
    write('src/app.js', 'export const ok = () => 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
  }, 60_000);
  afterEach(async () => {
    await registry.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('Codex: an edit that adds eval() comes back as context; a missing package is denied', async () => {
    write('src/run.js', 'export function run(input) {\n  return eval(input);\n}\n');
    const patch = '*** Begin Patch\n*** Add File: src/run.js\n+export function run(input) {\n+  return eval(input);\n+}\n*** End Patch';
    const post = await runAgentHook('codex', JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'x1', cwd: repo, tool_name: 'apply_patch', tool_input: { command: patch } }), opts()) as { hookSpecificOutput: { additionalContext: string } };
    expect(post.hookSpecificOutput.additionalContext).toContain('no-eval-dynamic');

    const pre = await runAgentHook('codex', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'x1', cwd: repo, tool_name: 'Bash', tool_input: { command: 'npm install ghost-pkg-xyz' } }), opts()) as { hookSpecificOutput: Record<string, string> };
    expect(pre.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(pre.hookSpecificOutput.permissionDecisionReason).toContain('ghost-pkg-xyz');
  }, 60_000);

  it('Cursor: placeholder code gets one follow-up at the finish, then the agent may stop', async () => {
    const base = { conversation_id: 'conv-1', workspace_roots: [repo] };
    expect(await runAgentHook('cursor', JSON.stringify({ ...base, hook_event_name: 'sessionStart', session_id: 'conv-1' }), opts())).toBeNull();
    write('src/email.js', 'export function sendEmail(to) {\n  // TODO: integrate email provider\n  return true;\n}\n');
    const first = await runAgentHook('cursor', JSON.stringify({ ...base, hook_event_name: 'stop', status: 'completed', loop_count: 0 }), opts()) as { followup_message: string };
    expect(first.followup_message).toContain('no-placeholder-implementation');
    expect(await runAgentHook('cursor', JSON.stringify({ ...base, hook_event_name: 'stop', status: 'completed', loop_count: 1 }), opts())).toBeNull();
  }, 60_000);

  it('accepts a payload with a byte-order mark (Windows PowerShell adds one)', async () => {
    const payload = JSON.stringify({ conversation_id: 'conv-3', workspace_roots: [repo], cwd: repo, hook_event_name: 'beforeShellExecution', command: 'git commit --no-verify -m x' });
    const out = await runAgentHook('cursor', String.fromCharCode(0xfeff) + payload, opts()) as Record<string, string>;
    expect(out.permission).toBe('ask');
  }, 60_000);

  it('Cursor: skipping Git hooks asks the user; a clean install says nothing', async () => {
    const base = { conversation_id: 'conv-2', workspace_roots: [repo], cwd: repo };
    const bypass = await runAgentHook('cursor', JSON.stringify({ ...base, hook_event_name: 'beforeShellExecution', command: 'git commit --no-verify -m wip' }), opts()) as Record<string, string>;
    expect(bypass.permission).toBe('ask');
    expect(bypass.user_message).toContain('bypasses Git hooks');
    expect(await runAgentHook('cursor', JSON.stringify({ ...base, hook_event_name: 'beforeShellExecution', command: 'npm i lodash' }), opts())).toBeNull();
  }, 60_000);
});

describe('init-hooks', () => {
  it('writes Cursor hooks with a command matcher, keeping existing hooks', () => {
    const existing = { version: 1, hooks: { stop: [{ command: './my-audit.sh' }] } };
    const { config, added } = mergeCursorHooks(existing);
    expect(added).toEqual(['sessionStart', 'stop', 'beforeShellExecution']);
    expect(config.hooks!.stop).toEqual([{ command: './my-audit.sh' }, { command: hookCommand('cursor'), timeout: 120 }]);
    expect(config.hooks!.beforeShellExecution[0]).toMatchObject({ command: 'node node_modules/eslint-plugin-ai-guard/dist/cli/hook.js --agent cursor', matcher: CURSOR_SHELL_MATCHER });
    expect(mergeCursorHooks(config).changed).toBe(false);
  });

  it('writes Codex hooks for edits, shell commands, session start and finish', () => {
    const { config, added } = mergeCodexHooks({});
    expect(added.sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
    expect(config.hooks!.PostToolUse[0].matcher).toBe('apply_patch|Edit|Write');
    expect(config.hooks!.PreToolUse[0]).toMatchObject({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('codex') }] });
    expect(mergeCodexHooks(config).changed).toBe(false);
  });

  it('turns on the package check in an existing setup, once', () => {
    const cursor = mergeCursorHooks(mergeCursorHooks({}).config, { checkInstalls: true });
    expect(cursor.added).toEqual(['beforeShellExecution']);
    expect(cursor.config.hooks!.beforeShellExecution[0].command).toMatch(/--agent cursor --check-installs$/);
    const codex = mergeCodexHooks(mergeCodexHooks({}).config, { checkInstalls: true });
    expect(codex.config.hooks!.PreToolUse[0].hooks![0].command).toMatch(/--check-installs$/);
    expect(mergeCodexHooks(codex.config, { checkInstalls: true }).changed).toBe(false);
  });

  it('respects --no-stop-hook and --no-bash-guard', () => {
    const { config } = mergeCursorHooks({}, { stopHook: false, bashGuard: false });
    expect(Object.keys(config.hooks!)).toEqual([]);
    const codex = mergeCodexHooks({}, { stopHook: false, bashGuard: false });
    expect(Object.keys(codex.config.hooks!)).toEqual(['PostToolUse']);
  });

  it('detects agents from their folders and parses --agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-detect-'));
    try {
      fs.mkdirSync(path.join(dir, '.cursor'));
      fs.mkdirSync(path.join(dir, '.codex'));
      expect(detectAgents(dir)).toEqual(['codex', 'cursor']);
      expect(parseAgentList('all', dir)).toEqual(['claude', 'codex', 'cursor']);
      expect(parseAgentList('cursor, codex', dir)).toEqual(['cursor', 'codex']);
      expect(parseAgentList('windsurf', dir)).toMatch(/Unknown agent 'windsurf'/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
