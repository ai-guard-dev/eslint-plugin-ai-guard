/**
 * verify-deps.ts — check npm dependencies against the registry: the ones a
 * change added (default), every declared dependency (--all), or packages named
 * directly. Shared by the CLI command and tests.
 */

import childProcess from 'child_process';
import path from 'path';
import { getChangeSet } from '../change-set.js';
import { assessPackages, type PackageAssessment, type DepFinding, type PackageFacts, type Verdict } from './assess.js';
import { addedDependencies, allDependencies, listManifests, localPackageNames, type DependencyEntry } from './dependencies.js';
import { parsePackageArg, type PackageRequest } from './package-spec.js';
import { readRegistryConfig } from './registry-config.js';
import { cooldownTip, detectPackageManager, readReleaseCooldown, type ReleaseCooldown } from './cooldown.js';
import type { PackageManager } from './install-command.js';
import { RegistryClient } from './registry.js';
import type { RunResult, FileResult } from '../eslint-runner.js';

export interface DepsReportItem {
  /** package.json the dependency was added to; null for packages named on the command line. */
  manifest: string | null;
  field: string | null;
  line: number | null;
  name: string;
  spec: string | null;
  verdict: Verdict;
  reason?: string;
  findings: DepFinding[];
  facts?: PackageFacts;
  similarTo?: string;
}

export interface DepsReport {
  success: boolean;
  root: string;
  mode: 'added' | 'all' | 'packages';
  /** What the change was compared with (added mode). */
  base: string | null;
  packages: DepsReportItem[];
  checked: number;
  blocked: number;
  warnings: number;
  skipped: number;
  unchecked: number;
  errors: Array<{ code: string; message: string; file?: string }>;
  /** The project's package manager, from package.json or its lockfile; null when unknown. */
  packageManager: PackageManager | null;
  /** Release cooldown that package manager enforces, if any. */
  cooldown: ReleaseCooldown | null;
  /** How to turn a cooldown on, when none is in effect. */
  cooldownTip: string | null;
  durationMs: number;
}

export interface VerifyDepsOptions {
  cwd: string;
  base?: string;
  staged?: boolean;
  all?: boolean;
  /** Check these package arguments instead of package.json files. */
  packages?: string[];
  minAgeDays?: number;
  minWeeklyDownloads?: number;
  /** Fresh-release window in hours (default 24; 0 turns the check off). */
  freshHours?: number;
  client?: RegistryClient;
  confirmRegistry?: (cwd: string, name: string) => boolean;
  now?: () => number;
}

function gitRoot(cwd: string): string {
  try {
    return path.resolve(childProcess.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return path.resolve(cwd);
  }
}

function emptyReport(root: string, mode: DepsReport['mode'], start: number): DepsReport {
  return { success: true, root, mode, base: null, packages: [], checked: 0, blocked: 0, warnings: 0, skipped: 0, unchecked: 0, errors: [], packageManager: null, cooldown: null, cooldownTip: null, durationMs: Date.now() - start };
}

function toItem(a: PackageAssessment, entry: DependencyEntry | null): DepsReportItem {
  return {
    manifest: entry?.manifest ?? null,
    field: entry?.field ?? null,
    line: entry?.line ?? null,
    name: a.request.name,
    spec: a.request.spec,
    verdict: a.verdict,
    ...(a.reason ? { reason: a.reason } : {}),
    findings: a.findings,
    ...(a.facts ? { facts: a.facts } : {}),
    ...(a.similarTo ? { similarTo: a.similarTo } : {}),
  };
}

export async function verifyDeps(options: VerifyDepsOptions): Promise<DepsReport> {
  const start = Date.now();
  const mode: DepsReport['mode'] = options.packages && options.packages.length > 0 ? 'packages' : options.all ? 'all' : 'added';
  let root = gitRoot(options.cwd);
  const report = emptyReport(root, mode, start);
  const requests: Array<{ request: PackageRequest; entry: DependencyEntry | null }> = [];

  if (mode === 'packages') {
    root = path.resolve(options.cwd);
    report.root = root;
    for (const arg of options.packages ?? []) {
      const request = parsePackageArg(arg);
      if (request) requests.push({ request, entry: null });
      else report.errors.push({ code: 'NOT_A_REGISTRY_PACKAGE', message: `"${arg}" is not an npm registry package name` });
    }
  } else {
    const manifests = listManifests(root);
    const local = localPackageNames(root, manifests);
    if (mode === 'all') {
      const { entries, errors } = allDependencies(root, manifests, local);
      report.errors.push(...errors.map((e) => ({ code: 'INVALID_MANIFEST', ...e })));
      requests.push(...entries.map((entry) => ({ request: entry.request, entry })));
    } else {
      try {
        const changeSet = getChangeSet({ cwd: options.cwd, base: options.base, staged: options.staged });
        report.base = changeSet.baseLabel;
        const { entries, errors } = addedDependencies(changeSet, local);
        report.errors.push(...errors.map((e) => ({ code: 'INVALID_MANIFEST', ...e })));
        requests.push(...entries.map((entry) => ({ request: entry.request, entry })));
      } catch (error) {
        report.success = false;
        report.errors.push({ code: 'GIT_FAILED', message: error instanceof Error ? error.message : String(error) });
        report.durationMs = Date.now() - start;
        return report;
      }
    }
  }

  report.packageManager = detectPackageManager(root);
  report.cooldown = report.packageManager ? readReleaseCooldown(root, report.packageManager) : null;
  report.cooldownTip = report.cooldown && report.cooldown.minutes > 0 ? null : cooldownTip(report.packageManager);

  const assessments = await assessPackages(requests.map((r) => r.request), {
    client: options.client ?? new RegistryClient(),
    registryConfig: readRegistryConfig(root),
    cwd: root,
    minAgeDays: options.minAgeDays,
    minWeeklyDownloads: options.minWeeklyDownloads,
    confirmRegistry: options.confirmRegistry,
    now: options.now,
    freshHours: options.freshHours,
    cooldown: report.cooldown,
  });
  report.packages = assessments.map((a, i) => toItem(a, requests[i].entry));
  for (const item of report.packages) {
    if (item.verdict === 'skipped') report.skipped++;
    else if (item.verdict === 'unchecked') report.unchecked++;
    else report.checked++;
    if (item.verdict === 'block') report.blocked++;
    if (item.verdict === 'warning') report.warnings++;
  }
  report.durationMs = Date.now() - start;
  return report;
}

const WARNING_LEVELS = new Set(['warning', 'warnings', 'any']);

/**
 * 0: nothing at the --fail-on level. 1: findings at that level.
 * 2: some packages could not be checked (network) or Git failed — never a silent pass.
 */
export function depsExitCode(report: DepsReport, failOn: string): number {
  if (!report.success) return 2;
  if (failOn === 'none') return 0;
  const failing = WARNING_LEVELS.has(failOn) ? report.blocked + report.warnings : report.blocked;
  if (failing > 0) return 1;
  return report.unchecked > 0 ? 2 : 0;
}

/** Findings as a RunResult, for SARIF and GitHub annotations. Only entries with a package.json location. */
export function depsToRunResult(report: DepsReport): RunResult {
  const byFile = new Map<string, FileResult>();
  const ruleBreakdown = new Map<string, number>();
  let errors = 0;
  let warnings = 0;
  for (const item of report.packages) {
    if (!item.manifest || item.line === null) continue;
    const filePath = path.join(report.root, item.manifest);
    let file = byFile.get(filePath);
    for (const f of item.findings) {
      if (!file) {
        file = { filePath, issues: [], errorCount: 0, warningCount: 0 };
        byFile.set(filePath, file);
      }
      const severity = f.severity === 'error' ? 2 : 1;
      const ruleId = `ai-guard/deps/${f.check}`;
      file.issues.push({ ruleId, severity, message: f.message, line: item.line, column: 1 });
      if (severity === 2) { file.errorCount++; errors++; } else { file.warningCount++; warnings++; }
      ruleBreakdown.set(ruleId, (ruleBreakdown.get(ruleId) ?? 0) + 1);
    }
  }
  const files = [...byFile.values()];
  return {
    files,
    totalErrors: errors,
    totalWarnings: warnings,
    totalIssues: errors + warnings,
    filesScanned: new Set(report.packages.map((p) => p.manifest).filter(Boolean)).size,
    ruleBreakdown,
    topFiles: files.map((f) => ({ path: f.filePath, count: f.issues.length })).sort((a, b) => b.count - a.count).slice(0, 5),
    durationMs: report.durationMs,
    ecosystemIssues: [],
    parserErrors: [],
    ignoredFiles: [],
    tsParserAvailable: true,
  };
}
