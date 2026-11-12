/**
 * install-guard.ts — check the packages in a shell command before it runs
 * (Claude Code PreToolUse hook, opt-in).
 *
 *   deny  the command cannot install what was intended: the package or
 *         version does not exist, or npm replaced it with a security
 *         placeholder. Claude sees the reason and can fix the name.
 *   ask   the package looks malicious (look-alike or install script on a new
 *         or obscure package), or the version was published in the last day
 *         and the package manager has no cooldown that covers it. The user
 *         decides; Claude is told why.
 *   none  warnings are passed to Claude as context; clean installs are silent.
 *
 * Anything uncertain lets the command through: network failures, private
 * registries, a check that runs out of time.
 */

import fs from 'fs';
import path from 'path';
import { parseInstallCommands } from './install-command.js';
import { ASK_DEP_CHECKS, assessPackages, FACT_DEP_CHECKS, type PackageAssessment } from './assess.js';
import { cooldownTip, readReleaseCooldown, type ReleaseCooldown } from './cooldown.js';
import { readRegistryConfig, type RegistryConfig } from './registry-config.js';
import { RegistryClient } from './registry.js';
import type { PackageRequest } from './package-spec.js';

export interface InstallGuardOptions {
  client?: RegistryClient;
  registryConfig?: RegistryConfig;
  confirmRegistry?: (cwd: string, name: string) => boolean;
  /** Give up and let the command run after this long. */
  timeoutMs?: number;
  now?: () => number;
  /** Fresh-release window in hours (default: AI_GUARD_FRESH_HOURS, else 24; 0 turns it off). */
  freshHours?: number;
  /** Release cooldown in effect; by default read from the command's package manager configuration. */
  cooldown?: ReleaseCooldown | null;
}

/** AI_GUARD_FRESH_HOURS, when it is a number of 0 or more. */
export function freshHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.AI_GUARD_FRESH_HOURS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface InstallGuardResult {
  decision: 'deny' | 'ask' | null;
  /** deny: shown to Claude. ask: shown to the user in the permission prompt. */
  reason: string | null;
  /** Shown to Claude next to the tool result. */
  context: string | null;
  assessments: PackageAssessment[];
}

/** npx and friends use a locally installed package instead of downloading one. */
export function isInstalledLocally(cwd: string, name: string, bin?: string): boolean {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const modules = path.join(dir, 'node_modules');
    if (fs.existsSync(path.join(modules, ...name.split('/'), 'package.json'))) return true;
    if (bin && ['', '.cmd', '.ps1'].some((ext) => fs.existsSync(path.join(modules, '.bin', `${bin}${ext}`)))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function label(req: PackageRequest): string {
  return req.spec ? `${req.name}@${req.spec}` : req.name;
}

function lines(items: PackageAssessment[], keep: (f: PackageAssessment['findings'][number]) => boolean = () => true): string {
  return items
    .flatMap((a) => a.findings.filter(keep).map((f) => `- ${label(a.request)}: ${f.message}`))
    .join('\n');
}

const isError = (f: PackageAssessment['findings'][number]): boolean => f.severity === 'error';
const isAsk = (f: PackageAssessment['findings'][number]): boolean => ASK_DEP_CHECKS.has(f.check);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Check the packages a command installs or runs. Null: nothing to say. */
export async function guardInstallCommand(command: string, cwd: string, options: InstallGuardOptions = {}): Promise<InstallGuardResult | null> {
  const intents = parseInstallCommands(command);
  if (intents.length === 0 || intents.some((i) => i.customRegistry)) return null;
  const requests = intents.flatMap((intent) => (intent.kind === 'run'
    ? intent.packages.filter((p) => !isInstalledLocally(cwd, p.name, intent.bin))
    : intent.packages));
  if (requests.length === 0) return null;

  // The cooldown of the package manager that runs the install. Downloads to run
  // (npx, dlx) are not assumed to honour it.
  const managers = new Set(intents.map((i) => i.manager));
  const manager = managers.size === 1 ? intents[0].manager : null;
  const cooldown = options.cooldown !== undefined
    ? options.cooldown
    : manager && intents.every((i) => i.kind === 'add') ? readReleaseCooldown(cwd, manager) : null;

  const assessments = await withTimeout(assessPackages(requests, {
    client: options.client ?? new RegistryClient({ timeoutMs: 4000 }),
    registryConfig: options.registryConfig ?? readRegistryConfig(cwd),
    cwd,
    confirmRegistry: options.confirmRegistry,
    now: options.now,
    freshHours: options.freshHours ?? freshHoursFromEnv(),
    cooldown,
  }), options.timeoutMs ?? 10_000);
  if (!assessments) return null;

  const facts = assessments.filter((a) => a.findings.some((f) => FACT_DEP_CHECKS.has(f.check)));
  const suspects = assessments.filter((a) => a.verdict === 'block' && !facts.includes(a));
  const fresh = assessments.filter((a) => !facts.includes(a) && a.findings.some(isAsk));
  const warned = assessments.filter((a) => a.verdict === 'warning' && !fresh.includes(a));

  if (facts.length > 0) {
    return {
      decision: 'deny',
      reason: `AI Guard checked the packages before this command ran. It would not install what you intended:\n${lines([...facts, ...suspects], isError)}\nFix the package name or version, then run the command again.`,
      context: null,
      assessments,
    };
  }
  if (suspects.length > 0 || fresh.length > 0) {
    const detail = [lines(suspects, isError), lines(fresh, isAsk)].filter((s) => s !== '').join('\n');
    const what = suspects.length > 0 ? 'a package that looks risky' : 'a release published in the last day';
    const tip = fresh.length > 0 ? `\nTo have the package manager wait for new releases on every install, ${cooldownTip(manager)}.` : '';
    const fallback = suspects.length > 0 ? 'use the package that was intended instead' : 'install the previous version (name@version) or wait';
    return {
      decision: 'ask',
      reason: `AI Guard: this command installs ${what}.\n${detail}${tip}\nRun it anyway?`,
      context: `AI Guard asked the user to confirm this command:\n${detail}\nIf the user declines, ${fallback}.`,
      assessments,
    };
  }
  if (warned.length > 0) {
    return {
      decision: null,
      reason: null,
      context: `AI Guard checked the packages in this command:\n${lines(warned)}\nMention these to the user if they matter for the task.`,
      assessments,
    };
  }
  return null;
}
