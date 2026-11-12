/**
 * init-git-hook.ts — ai-guard init-git-hook: a pre-commit gate that runs
 * `ai-guard verify --staged`.
 *
 * Works with every coding agent and with people: whoever commits, the staged
 * change is checked for placeholder code, weakened or focused tests, leaked
 * secrets and agent-config issues introduced by the commit. Pre-existing
 * problems never block. The agent hooks already flag `git commit --no-verify`,
 * so an agent cannot quietly skip the gate.
 *
 * Uses the project's hook manager when there is one (husky, lefthook,
 * simple-git-hooks); with the pre-commit framework it prints the config to
 * add; otherwise it writes the repository's own Git hook (local only).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { PKG_VERSION } from '../utils/version.js';

export type HookManager = 'husky' | 'lefthook' | 'simple-git-hooks' | 'pre-commit' | 'git';

export interface GitHookOptions {
  /** Also check npm dependencies the commit adds (network). */
  checkDeps?: boolean;
}

const MARKER = 'ai-guard verify';

export function gitHookCommand(opts: GitHookOptions = {}): string {
  const verify = 'npx --no ai-guard verify --staged --allow-unverified';
  return opts.checkDeps ? `${verify} && npx --no ai-guard verify-deps --staged` : verify;
}

const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'];

export function detectHookManager(cwd: string): HookManager {
  if (LEFTHOOK_FILES.some((f) => fs.existsSync(path.join(cwd, f)))) return 'lefthook';
  if (fs.existsSync(path.join(cwd, '.husky'))) return 'husky';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
    if (pkg['simple-git-hooks']) return 'simple-git-hooks';
    const deps = { ...(pkg.devDependencies as Record<string, string> | undefined), ...(pkg.dependencies as Record<string, string> | undefined) };
    if (deps.husky) return 'husky';
    if (deps.lefthook) return 'lefthook';
  } catch { /* no package.json */ }
  if (fs.existsSync(path.join(cwd, '.pre-commit-config.yaml'))) return 'pre-commit';
  return 'git';
}

/** A shell hook script with the command appended, or null when it is already there. */
export function addToShellHook(existing: string | null, command: string): string | null {
  if (existing !== null && existing.includes(MARKER)) return null;
  if (existing === null || existing.trim() === '') return `#!/bin/sh\n${command}\n`;
  return `${existing.replace(/\s*$/, '')}\n${command}\n`;
}

/**
 * lefthook.yml with an ai-guard pre-commit command. Appends a new pre-commit
 * section when there is none; editing an existing section safely needs a YAML
 * parser, so then the snippet is returned for the user to add.
 */
export function addToLefthook(existing: string, command: string): { content: string } | { snippet: string } | null {
  if (existing.includes(MARKER)) return null;
  const snippet = `pre-commit:\n  commands:\n    ai-guard:\n      run: ${command}\n`;
  if (/^pre-commit:/m.test(existing)) return { snippet: `    ai-guard:\n      run: ${command}\n` };
  return { content: `${existing.replace(/\s*$/, '')}${existing.trim() === '' ? '' : '\n\n'}${snippet}` };
}

/** package.json with the command added to simple-git-hooks' pre-commit, or null when present. */
export function addToSimpleGitHooks(pkg: Record<string, unknown>, command: string): Record<string, unknown> | null {
  const hooks = { ...(pkg['simple-git-hooks'] as Record<string, string> | undefined) };
  const current = hooks['pre-commit'];
  if (typeof current === 'string' && current.includes(MARKER)) return null;
  hooks['pre-commit'] = current ? `${current} && ${command}` : command;
  return { ...pkg, 'simple-git-hooks': hooks };
}

export function preCommitSnippet(version = PKG_VERSION): string {
  return `  - repo: https://github.com/ai-guard-dev/eslint-plugin-ai-guard\n    rev: v${version}\n    hooks:\n      - id: ai-guard-verify\n`;
}

function gitHooksDir(cwd: string): string | null {
  try {
    const dir = childProcess.execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(cwd, dir);
  } catch {
    return null;
  }
}

export function registerInitGitHookCommand(program: Command): void {
  program
    .command('init-git-hook')
    .description('Add a pre-commit gate that runs `ai-guard verify --staged`: blocks commits that add placeholder code, weakened tests, secrets or agent-config issues, whoever wrote them')
    .option('--manager <name>', 'husky | lefthook | simple-git-hooks | pre-commit | git (default: detected)')
    .option('--check-deps', 'Also check npm dependencies the commit adds (uses the npm registry)')
    .option('--dry-run', 'Show what would change without writing files')
    .action((opts: { manager?: string; checkDeps?: boolean; dryRun?: boolean }) => {
      const cwd = process.cwd();
      log.banner('AI GUARD × GIT');
      const managers: HookManager[] = ['husky', 'lefthook', 'simple-git-hooks', 'pre-commit', 'git'];
      if (opts.manager !== undefined && !managers.includes(opts.manager as HookManager)) {
        log.error(`Unknown --manager '${opts.manager}'. Use ${managers.join(', ')}.`);
        process.exit(2);
        return;
      }
      const manager = (opts.manager as HookManager | undefined) ?? detectHookManager(cwd);
      const command = gitHookCommand({ checkDeps: opts.checkDeps });
      const write = (file: string, content: string, executable = false): void => {
        if (opts.dryRun) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        if (executable) fs.chmodSync(file, 0o755);
      };
      const done = (what: string): void => {
        log.success(`${opts.dryRun ? 'Would update' : 'Updated'} ${what}`);
        log.info(`Every commit now runs: ${chalk.cyan(command)}`);
        log.info('Only problems the commit introduces block it. People can still skip it with git commit --no-verify; the AI Guard agent hooks flag agents that try.');
      };

      if (manager === 'husky' || manager === 'git') {
        const dir = manager === 'husky' ? path.join(cwd, '.husky') : gitHooksDir(cwd);
        if (!dir) {
          log.error('Not a Git repository.');
          process.exit(2);
          return;
        }
        const file = path.join(dir, 'pre-commit');
        const next = addToShellHook(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, command);
        if (next === null) {
          log.success(`Already configured (${path.relative(cwd, file).replace(/\\/g, '/')})`);
        } else {
          write(file, next, true);
          done(path.relative(cwd, file).replace(/\\/g, '/'));
          if (manager === 'git') log.warn('.git/hooks is not shared with your team. Use husky or lefthook to commit the hook with the repository.');
        }
      } else if (manager === 'lefthook') {
        const name = LEFTHOOK_FILES.find((f) => fs.existsSync(path.join(cwd, f))) ?? 'lefthook.yml';
        const file = path.join(cwd, name);
        const result = addToLefthook(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', command);
        if (result === null) log.success(`Already configured (${name})`);
        else if ('content' in result) {
          write(file, result.content);
          done(name);
          log.info(`Run ${chalk.cyan('npx lefthook install')} if lefthook is not installed in Git yet.`);
        } else {
          log.warn(`${name} already has a pre-commit section. Add this under its commands:`);
          log.print(chalk.cyan(result.snippet));
        }
      } else if (manager === 'simple-git-hooks') {
        const file = path.join(cwd, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        const next = addToSimpleGitHooks(pkg, command);
        if (next === null) log.success('Already configured (package.json)');
        else {
          write(file, `${JSON.stringify(next, null, 2)}\n`);
          done('package.json (simple-git-hooks)');
          log.info(`Run ${chalk.cyan('npx simple-git-hooks')} to apply it.`);
        }
      } else {
        log.info('Add this to the repos list in .pre-commit-config.yaml:');
        log.print(chalk.cyan(preCommitSnippet()));
        log.info('It runs the AI Guard installed in the project (npm install --save-dev eslint-plugin-ai-guard).');
      }
      if (opts.dryRun) log.print(`  ${chalk.yellow('Dry run: no files written.')}`);
      log.blank();
    });
}
