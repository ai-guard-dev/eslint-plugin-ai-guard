/**
 * The opt-in PreToolUse install check: packages in install commands are looked
 * up before the command runs (fake registry, real HTTP client).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHookInput, installCheckEnabled, type HookOptions } from '../../cli/commands/claude-hook';
import { mergeAiGuardHook } from '../../cli/commands/init-claude';
import { RegistryClient } from '../../cli/utils/deps/registry';
import type { RegistryConfig } from '../../cli/utils/deps/registry-config';
import { checkPackageTool } from '../../src/mcp/tools/check-package';
import { closedEndpoint, daysAgo, established, NOW, startFakeRegistry, type FakeRegistry } from '../helpers/fake-registry';

const PUBLIC: RegistryConfig = { publicDefault: true, customScopes: new Set(), sources: [] };
let registry: FakeRegistry;
let dir: string;

beforeEach(async () => {
  registry = await startFakeRegistry({
    lodash: established(),
    react: established(),
    eslint: established(),
    request: established(1e6, { deprecated: 'request has been deprecated' }),
    expresss: { created: daysAgo(2), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: 7 },
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-install-hook-'));
});
afterEach(async () => {
  await registry.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function opts(extra: Partial<HookOptions> = {}): HookOptions {
  return {
    stateDir: path.join(dir, '.state'),
    bashGuard: 'ask',
    checkInstalls: true,
    installGuard: {
      client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, now: () => NOW }),
      registryConfig: PUBLIC,
      confirmRegistry: () => true,
      now: () => NOW,
    },
    ...extra,
  };
}

const pre = (command: string, tool = 'Bash') => ({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: dir, tool_input: { command } });
type Out = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } } | null;
const run = async (command: string, o: HookOptions = opts(), tool = 'Bash'): Promise<Out> => (await handleHookInput(pre(command, tool), o)) as Out;

describe('PreToolUse install check', () => {
  it('denies an install of a package that does not exist; Claude sees why', async () => {
    const out = await run('npm install ghost-pkg-xyz');
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain('"ghost-pkg-xyz" does not exist on npm');
  });

  it('asks the user about a likely typosquat and tells Claude', async () => {
    const out = await run('npm i expresss');
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain('express');
    expect(out?.hookSpecificOutput?.additionalContext).toContain('If the user declines');
  });

  it('passes warnings to Claude without asking anyone', async () => {
    const out = await run('npm i request');
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out?.hookSpecificOutput?.additionalContext).toContain('deprecated');
  });

  it('is silent for clean installs and for commands that install nothing', async () => {
    expect(await run('npm i lodash react')).toBeNull();
    expect(await run('npm ci && npm test')).toBeNull();
    expect(await run('git status')).toBeNull();
    expect(registry.requests.filter((r) => !r.endsWith('/latest'))).toEqual([]);
  });

  it('does nothing unless it was switched on', async () => {
    expect(await run('npm install ghost-pkg-xyz', opts({ checkInstalls: false }))).toBeNull();
    expect(registry.requests).toEqual([]);
  });

  it('skips npx for a package that is already installed locally', async () => {
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'ghost-cli'), '');
    expect(await run('npx ghost-cli --version')).toBeNull();
    expect((await run('npx other-ghost-cli'))?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('checks PowerShell commands too', async () => {
    expect((await run('npm install ghost-pkg-xyz', opts(), 'PowerShell'))?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('lets the command run when the registry cannot be reached', async () => {
    const offline = opts({ installGuard: { client: new RegistryClient({ endpoints: await closedEndpoint(), cacheDir: null }), registryConfig: PUBLIC, confirmRegistry: () => true } });
    expect(await run('npm install ghost-pkg-xyz', offline)).toBeNull();
  });

  it('skips commands that name another registry', async () => {
    expect(await run('npm i --registry https://npm.acme.dev ghost-pkg-xyz')).toBeNull();
  });

  it('combines with the Git-hook bypass guard; deny wins', async () => {
    const out = await run('npm i ghost-pkg-xyz && git commit --no-verify -m x');
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain('bypasses Git hooks');
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain('ghost-pkg-xyz');
  });

  it('is switched on by flag, AI_GUARD_CHECK_INSTALLS or the plugin option', () => {
    expect(installCheckEnabled(true, {})).toBe(true);
    expect(installCheckEnabled(undefined, {})).toBe(false);
    expect(installCheckEnabled(undefined, { AI_GUARD_CHECK_INSTALLS: '1' })).toBe(true);
    expect(installCheckEnabled(undefined, { CLAUDE_PLUGIN_OPTION_CHECK_INSTALLS: 'true' })).toBe(true);
    expect(installCheckEnabled(undefined, { CLAUDE_PLUGIN_OPTION_CHECK_INSTALLS: 'false' })).toBe(false);
  });
});

describe('init-claude --check-installs', () => {
  it('adds the flag to a new PreToolUse hook covering Bash and PowerShell', () => {
    const { settings } = mergeAiGuardHook({}, { checkInstalls: true });
    expect(settings.hooks!.PreToolUse).toEqual([{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node_modules/.bin/ai-guard claude-hook --check-installs' }] }]);
  });

  it('turns it on in an existing setup, once', () => {
    const first = mergeAiGuardHook({}).settings;
    const upgraded = mergeAiGuardHook(first, { checkInstalls: true });
    expect(upgraded.changed).toBe(true);
    expect(upgraded.settings.hooks!.PreToolUse![0].hooks[0].command).toBe('node_modules/.bin/ai-guard claude-hook --check-installs');
    expect(mergeAiGuardHook(upgraded.settings, { checkInstalls: true }).changed).toBe(false);
  });

  it('keeps the bypass guard off when asked', () => {
    const { settings } = mergeAiGuardHook({}, { bashGuard: false, checkInstalls: true });
    expect(settings.hooks!.PreToolUse![0].hooks[0].command).toBe('node_modules/.bin/ai-guard claude-hook --bash-guard off --check-installs');
  });
});

describe('ai_guard_check_package', () => {
  it('returns a verdict per package and safeToInstall', async () => {
    const client = new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, now: () => NOW });
    const result = await checkPackageTool({ packages: ['lodash', 'expresss', 'git+https://github.com/a/b.git'] }, dir, client);
    expect(result.status).toBe('complete');
    expect(result.safeToInstall).toBe(false);
    expect(result.packages.map((p) => [p.input, p.verdict])).toEqual([
      ['git+https://github.com/a/b.git', 'skipped'],
      ['lodash', 'ok'],
      ['expresss', 'block'],
    ]);
    expect(result.packages.find((p) => p.name === 'expresss')?.similarTo).toBe('express');
  });

  it('is never "safe" when a package could not be checked', async () => {
    const client = new RegistryClient({ endpoints: await closedEndpoint(), cacheDir: null });
    const result = await checkPackageTool({ packages: ['some-lib-xyz'] }, dir, client);
    expect(result).toMatchObject({ status: 'partial', safeToInstall: false });
    expect(result.errors[0].code).toBe('REGISTRY_UNAVAILABLE');
  });
});
