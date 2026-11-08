import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchHook, parseHookPayload, type HookPayload } from '../../cli/commands/claude-hook';
import { loadSession } from '../../cli/utils/agent-session';
import { mergeAiGuardHook, mergeAiGuardLifecycleHooks } from '../../cli/commands/init-claude';

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
const write = (rel: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const SESSION = 'session-123';
const hook = (payload: HookPayload) => dispatchHook({ session_id: SESSION, cwd: repo, ...payload }, repo, { isolated: true });
const stop = (active = false) => hook({ hook_event_name: 'Stop', stop_hook_active: active });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-hook-'));
  git('init', '-q', '-b', 'main');
  write('package.json', '{"name":"demo","type":"module"}');
  write('src/app.js', 'export const ok = () => 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('PostToolUse', () => {
  it('hands findings to Claude through additionalContext (plain stdout is not shown to Claude)', async () => {
    write('src/run.js', 'export function run(input) { return eval(input); }\n');
    const output = await hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src/run.js') } });
    expect(output?.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(output?.hookSpecificOutput?.additionalContext).toContain('ai-guard/no-eval-dynamic');
  });

  it('stays silent for clean files, non-JS files and payloads without a path', async () => {
    write('README.md', '# hi');
    expect(await hook({ hook_event_name: 'PostToolUse', tool_input: { file_path: path.join(repo, 'src/app.js') } })).toBeNull();
    expect(await hook({ hook_event_name: 'PostToolUse', tool_input: { file_path: path.join(repo, 'README.md') } })).toBeNull();
    expect(await hook({ hook_event_name: 'PostToolUse', tool_input: {} })).toBeNull();
  });

  it('accepts legacy payloads without hook_event_name', async () => {
    write('src/run.js', 'export function run(input) { return eval(input); }\n');
    const output = await dispatchHook({ tool_input: { file_path: path.join(repo, 'src/run.js') } }, repo, { isolated: true });
    expect(output?.hookSpecificOutput?.additionalContext).toContain('no-eval-dynamic');
  });
});

describe('SessionStart and Stop', () => {
  it('records the starting commit and prints nothing (SessionStart stdout becomes Claude context)', async () => {
    expect(await hook({ hook_event_name: 'SessionStart', source: 'startup' })).toBeNull();
    expect(loadSession(repo, SESSION)?.baseCommit).toBe(git('rev-parse', 'HEAD').trim());
  });

  it('allows a clean finish without output', async () => {
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    write('src/app.js', 'export const ok = () => 2;\n');
    expect(await stop()).toBeNull();
  });

  it('reports each finding once, then tells the user instead of looping', async () => {
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    // The agent commits unfinished work, then tries to finish.
    write('src/email.js', 'export function sendEmail(to) {\n  // TODO: integrate email provider\n  return true;\n}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'agent');

    const first = await stop();
    expect(first?.hookSpecificOutput?.hookEventName).toBe('Stop');
    expect(first?.hookSpecificOutput?.additionalContext).toContain('src/email.js:2 no-placeholder-implementation');
    expect(first?.systemMessage).toBeUndefined();

    // Claude tries to stop again without fixing it: allowed, and the user is told.
    const second = await stop(true);
    expect(second?.hookSpecificOutput).toBeUndefined();
    expect(second?.systemMessage).toContain('1 unresolved issue');

    // A later turn with the same unresolved finding stays quiet.
    expect(await stop(false)).toBeNull();

    // A new problem in a later turn is reported, alone.
    write('src/run.js', 'export function run(input) { return eval(input); }\n');
    const third = await stop(false);
    expect(third?.hookSpecificOutput?.additionalContext).toContain('no-eval-dynamic');
    expect(third?.hookSpecificOutput?.additionalContext).not.toContain('no-placeholder-implementation');
  });

  it('asks Claude to disclose weakened tests', async () => {
    write('src/app.test.js', "it('works', () => { expect(ok()).toBe(1); expect(ok()).not.toBe(2); });\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'tests');
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    write('src/app.test.js', "it('works', () => { expect(ok()).toBe(1); });\n");
    const output = await stop();
    expect(output?.hookSpecificOutput?.additionalContext).toContain('Tell the user about these');
    expect(output?.hookSpecificOutput?.additionalContext).toContain('assertions-removed');
  });

  it('never blocks twice in one stop sequence without a session id', async () => {
    write('src/email.js', 'export function sendEmail(to) {\n  // TODO: implement\n  return true;\n}\n');
    const payload = { hook_event_name: 'Stop', cwd: repo };
    expect((await dispatchHook({ ...payload, stop_hook_active: false }, repo, { isolated: true }))?.hookSpecificOutput).toBeDefined();
    const again = await dispatchHook({ ...payload, stop_hook_active: true }, repo, { isolated: true });
    expect(again?.hookSpecificOutput).toBeUndefined();
    expect(again?.systemMessage).toContain('unresolved');
  });

  it('does nothing outside a Git repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-hook-nogit-'));
    try {
      expect(await dispatchHook({ hook_event_name: 'Stop', session_id: SESSION, cwd: outside }, outside, { isolated: true })).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores session ids that could escape the state directory', async () => {
    await dispatchHook({ hook_event_name: 'SessionStart', session_id: '../../etc/passwd', cwd: repo }, repo);
    expect(fs.existsSync(path.join(repo, '.git', 'etc'))).toBe(false);
    expect(loadSession(repo, '../../etc/passwd')).toBeNull();
  });
});

describe('payload parsing', () => {
  it('returns null for empty, invalid or non-object payloads', () => {
    expect(parseHookPayload('')).toBeNull();
    expect(parseHookPayload('not json')).toBeNull();
    expect(parseHookPayload('[1]')).toBeNull();
    expect(parseHookPayload('{"hook_event_name":"Stop"}')).toEqual({ hook_event_name: 'Stop' });
  });
});

describe('init-claude lifecycle hooks', () => {
  it('adds Stop and SessionStart once and keeps other hooks', () => {
    const base = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    const { settings, changed } = mergeAiGuardLifecycleHooks(mergeAiGuardHook(base).settings);
    expect(changed).toBe(true);
    expect(settings.hooks!.Stop).toHaveLength(2);
    expect(settings.hooks!.SessionStart).toHaveLength(1);
    expect(settings.hooks!.PostToolUse).toHaveLength(1);
    const again = mergeAiGuardLifecycleHooks(settings);
    expect(again.changed).toBe(false);
    expect(again.settings).toEqual(settings);
  });
});
