/**
 * init-hooks.ts — ai-guard init-hooks: install AI Guard's hooks for the coding
 * agents a project uses (Claude Code, Cursor, Codex).
 *
 *   ai-guard init-hooks                  # agents detected from .claude/, .cursor/, .codex/
 *   ai-guard init-hooks --agent cursor,codex
 *   ai-guard init-hooks --agent all --check-installs
 *
 * Every agent gets the same engine through the fast `ai-guard-hook` entry point:
 *
 *   before a shell command   Git-hook bypass guard, opt-in package check
 *   after an edit            lint + weakened checks fed back (Claude Code, Codex)
 *   before finishing         check integrity + problems the session introduced
 *   session start            snapshot so earlier work is not blamed on the agent
 *
 * Existing configuration is preserved; running the command again changes nothing.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { AGENTS, CURSOR_SHELL_MATCHER, isAgentName, type AgentName } from '../utils/hooks/agents.js';
import { mergeAiGuardHook, readClaudeSettings, writeClaudeSettings } from './init-claude.js';

export interface AgentHookOptions {
  /** Session start + finish gate. Default true. */
  stopHook?: boolean;
  /** Guard against `git commit --no-verify` / `HUSKY=0`. Default true. */
  bashGuard?: boolean;
  /** Check npm packages before installs (network). Default false. */
  checkInstalls?: boolean;
}

/** The fast hook entry point, relative to the project root. */
export const HOOK_SCRIPT = 'node_modules/eslint-plugin-ai-guard/dist/cli/hook.js';
const CHECK_INSTALLS = '--check-installs';

export function hookCommand(agent: AgentName, opts: AgentHookOptions = {}): string {
  const flags = `${opts.bashGuard === false ? ' --bash-guard off' : ''}${opts.checkInstalls ? ` ${CHECK_INSTALLS}` : ''}`;
  return `node ${HOOK_SCRIPT} --agent ${agent}${flags}`;
}

const isAiGuardCommand = (command: unknown): command is string =>
  typeof command === 'string' && /ai-guard/.test(command) && /(?:hook\.js|ai-guard-hook|claude-hook|\bhook\b)/.test(command);

// ─── Cursor ───────────────────────────────────────────────────────────────────

interface CursorHook {
  command?: string;
  [key: string]: unknown;
}

export interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHook[]>;
  [key: string]: unknown;
}

export interface MergeResult<T> {
  config: T;
  changed: boolean;
  /** Events added or updated. */
  added: string[];
}

export function mergeCursorHooks(existing: CursorHooksFile, opts: AgentHookOptions = {}): MergeResult<CursorHooksFile> {
  const config: CursorHooksFile = JSON.parse(JSON.stringify(existing)) as CursorHooksFile;
  config.version ??= 1;
  config.hooks ??= {};
  const hooks = config.hooks;
  const command = hookCommand('cursor', opts);
  const added: string[] = [];

  const wanted: Array<[string, CursorHook]> = [];
  if (opts.stopHook !== false) {
    wanted.push(['sessionStart', { command, timeout: 30 }]);
    wanted.push(['stop', { command, timeout: 120 }]);
  }
  if (opts.bashGuard !== false || opts.checkInstalls) {
    wanted.push(['beforeShellExecution', { command, matcher: CURSOR_SHELL_MATCHER, timeout: 30 }]);
  }

  for (const [event, entry] of wanted) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = list;
    const mine = list.find((h) => isAiGuardCommand(h.command));
    if (!mine) {
      list.push(entry);
      added.push(event);
    } else if (opts.checkInstalls && event === 'beforeShellExecution' && !mine.command!.includes(CHECK_INSTALLS)) {
      mine.command = `${mine.command} ${CHECK_INSTALLS}`;
      added.push(event);
    }
  }
  return { config, changed: added.length > 0, added };
}

// ─── Codex ────────────────────────────────────────────────────────────────────

interface CodexHandler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface CodexGroup {
  matcher?: string;
  hooks?: CodexHandler[];
  [key: string]: unknown;
}

export interface CodexHooksFile {
  hooks?: Record<string, CodexGroup[]>;
  [key: string]: unknown;
}

export function mergeCodexHooks(existing: CodexHooksFile, opts: AgentHookOptions = {}): MergeResult<CodexHooksFile> {
  const config: CodexHooksFile = JSON.parse(JSON.stringify(existing)) as CodexHooksFile;
  config.hooks ??= {};
  const hooks = config.hooks;
  const command = hookCommand('codex', opts);
  const handler = (timeout: number, statusMessage: string): CodexHandler => ({ type: 'command', command, timeout, statusMessage });
  const added: string[] = [];

  const wanted: Array<[string, CodexGroup]> = [
    ['PostToolUse', { matcher: 'apply_patch|Edit|Write', hooks: [handler(60, 'AI Guard: checking the edit')] }],
  ];
  if (opts.stopHook !== false) {
    wanted.push(['SessionStart', { hooks: [handler(30, 'AI Guard: recording the session start')] }]);
    wanted.push(['Stop', { hooks: [handler(120, 'AI Guard: verifying the change')] }]);
  }
  if (opts.bashGuard !== false || opts.checkInstalls) {
    wanted.push(['PreToolUse', { matcher: 'Bash', hooks: [handler(30, 'AI Guard: checking the command')] }]);
  }

  for (const [event, group] of wanted) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = list;
    const mine = list.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : [])).find((h) => isAiGuardCommand(h.command));
    if (!mine) {
      list.push(group);
      added.push(event);
    } else if (opts.checkInstalls && event === 'PreToolUse' && !mine.command!.includes(CHECK_INSTALLS)) {
      mine.command = `${mine.command} ${CHECK_INSTALLS}`;
      added.push(event);
    }
  }
  return { config, changed: added.length > 0, added };
}

// ─── Files ────────────────────────────────────────────────────────────────────

const AGENT_DIRS: Record<AgentName, string> = { claude: '.claude', cursor: '.cursor', codex: '.codex' };
const AGENT_LABELS: Record<AgentName, string> = { claude: 'Claude Code', cursor: 'Cursor', codex: 'Codex' };

export function detectAgents(cwd: string): AgentName[] {
  return AGENTS.filter((agent) => fs.existsSync(path.join(cwd, AGENT_DIRS[agent])));
}

export function parseAgentList(value: string | undefined, cwd: string): AgentName[] | string {
  if (value === undefined) return detectAgents(cwd);
  const names = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.includes('all')) return [...AGENTS];
  const unknown = names.filter((n) => !isAgentName(n));
  if (unknown.length > 0) return `Unknown agent '${unknown.join("', '")}'. Use ${AGENTS.join(', ')} or all.`;
  return [...new Set(names)] as AgentName[];
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text === '') return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}. Fix it or remove it, then run init-hooks again.`);
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface AgentPlan {
  agent: AgentName;
  file: string;
  changed: boolean;
  added: string[];
  write: () => void;
}

function planFor(agent: AgentName, cwd: string, opts: AgentHookOptions): AgentPlan {
  if (agent === 'claude') {
    const file = path.join(cwd, '.claude', 'settings.json');
    const { settings, changed, added } = mergeAiGuardHook(readClaudeSettings(file) ?? {}, opts);
    return { agent, file, changed, added, write: () => writeClaudeSettings(file, settings) };
  }
  if (agent === 'cursor') {
    const file = path.join(cwd, '.cursor', 'hooks.json');
    const { config, changed, added } = mergeCursorHooks(readJson<CursorHooksFile>(file) ?? {}, opts);
    return { agent, file, changed, added, write: () => writeJson(file, config) };
  }
  const file = path.join(cwd, '.codex', 'hooks.json');
  const { config, changed, added } = mergeCodexHooks(readJson<CodexHooksFile>(file) ?? {}, opts);
  return { agent, file, changed, added, write: () => writeJson(file, config) };
}

export function registerInitHooksCommand(program: Command): void {
  program
    .command('init-hooks')
    .description('Install AI Guard hooks for Claude Code, Cursor and Codex: findings after edits, a final check before the agent finishes, and a guard on risky shell commands')
    .option('--agent <list>', `Agents to configure: ${AGENTS.join(', ')}, or all (default: detected from .claude/, .cursor/, .codex/)`)
    .option('--dry-run', 'Show what would change without writing files')
    .option('--check-installs', 'Also check npm packages before install commands run (uses the npm registry)')
    .option('--no-stop-hook', 'Skip the session-start snapshot and the finish gate')
    .option('--no-bash-guard', 'Skip the guard on `git commit --no-verify` / `HUSKY=0`')
    .action((opts: { agent?: string; dryRun?: boolean; checkInstalls?: boolean; stopHook?: boolean; bashGuard?: boolean }) => {
      const cwd = process.cwd();
      log.banner('AI GUARD × AGENT HOOKS');

      const agents = parseAgentList(opts.agent, cwd);
      if (typeof agents === 'string') {
        log.error(agents);
        process.exit(2);
        return;
      }
      if (agents.length === 0) {
        log.warn('No agent folder found (.claude/, .cursor/ or .codex/).');
        log.print(`  Choose explicitly, for example: ${chalk.cyan('ai-guard init-hooks --agent cursor,codex')}`);
        log.blank();
        process.exit(2);
        return;
      }

      if (!fs.existsSync(path.join(cwd, HOOK_SCRIPT)) && !opts.dryRun) {
        log.warn('AI Guard is not installed in this project, and the hooks run it from node_modules.');
        log.print(`  Install it first: ${chalk.cyan('npm install --save-dev eslint-plugin-ai-guard')}`);
        log.blank();
        process.exit(1);
        return;
      }

      const hookOpts: AgentHookOptions = { stopHook: opts.stopHook !== false, bashGuard: opts.bashGuard !== false, checkInstalls: opts.checkInstalls === true };
      let plans: AgentPlan[];
      try {
        plans = agents.map((agent) => planFor(agent, cwd, hookOpts));
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
        return;
      }

      for (const plan of plans) {
        const rel = path.relative(cwd, plan.file).replace(/\\/g, '/');
        if (!plan.changed) {
          log.success(`${AGENT_LABELS[plan.agent]}: already configured (${rel})`);
          continue;
        }
        if (!opts.dryRun) plan.write();
        log.success(`${AGENT_LABELS[plan.agent]}: ${opts.dryRun ? 'would add' : 'added'} ${plan.added.join(', ')} → ${rel}`);
      }
      log.blank();

      if (agents.includes('codex') && plans.some((p) => p.agent === 'codex' && p.changed)) {
        log.info(`Codex runs new project hooks only after you trust them: start Codex and run ${chalk.cyan('/hooks')}.`);
        log.info('Start Codex from the project root, where node_modules is.');
      }
      if (agents.includes('cursor')) {
        log.info('Cursor: findings arrive when the agent finishes (Cursor does not let file-edit hooks talk to the agent).');
      }
      if (opts.checkInstalls) log.info('Package check on: install commands are checked on the npm registry first.');
      if (opts.dryRun) log.print(`  ${chalk.yellow('Dry run: no files written.')}`);
      log.blank();
    });
}
