/**
 * verify-deps.ts — ai-guard verify-deps command.
 *
 * Checks npm packages against the registry before they are installed: the
 * dependencies a change adds to package.json (default), every declared
 * dependency (--all), or packages named on the command line. Contacts
 * registry.npmjs.org and api.npmjs.org; packages from private registries are
 * skipped.
 *
 * Usage:
 *   ai-guard verify-deps                 # dependencies added since HEAD
 *   ai-guard verify-deps --base main     # dependencies this branch adds
 *   ai-guard verify-deps lodash expresss # check named packages
 *   ai-guard verify-deps --all           # every dependency
 */

import type { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { buildSarifLog, sarifToJson } from '../utils/sarif.js';
import { emitGitHubAnnotations } from '../utils/github-summary.js';
import { isGitHubActions } from '../utils/git-diff.js';
import { PKG_VERSION } from '../utils/version.js';
import { depsExitCode, depsToRunResult, verifyDeps, type DepsReport, type DepsReportItem } from '../utils/deps/verify-deps.js';
import { DEFAULT_FRESH_HOURS, DEFAULT_MIN_AGE_DAYS, DEFAULT_MIN_WEEKLY_DOWNLOADS } from '../utils/deps/assess.js';

/** Code Scanning slot for this scan, separate from the main "ai-guard" slot. */
export const DEPS_AUTOMATION_ID = 'ai-guard-deps';

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function heading(report: DepsReport): string {
  const what = report.mode === 'added' ? 'added dependency' : report.mode === 'all' ? 'dependency' : 'package';
  const total = report.packages.length;
  const parts = [
    `${chalk.bold('Dependencies')}  ${chalk.gray('·')}  ${count(total, what)}${report.mode === 'added' && report.base ? ` vs ${report.base}` : ''}`,
    report.blocked > 0 ? chalk.red(`${report.blocked} blocked`) : chalk.green('0 blocked'),
    report.warnings > 0 ? chalk.yellow(count(report.warnings, 'warning')) : '0 warnings',
  ];
  if (report.skipped > 0) parts.push(chalk.gray(`${report.skipped} skipped`));
  if (report.unchecked > 0) parts.push(chalk.red(`${report.unchecked} not checked`));
  return `  ${parts.join(`  ${chalk.gray('·')}  `)}`;
}

function printItem(item: DepsReportItem): void {
  const label = item.spec ? `${item.name}@${item.spec}` : item.name;
  const where = chalk.gray(String(item.line ?? '').padEnd(5));
  if (item.verdict === 'skipped' || item.verdict === 'unchecked') {
    const tag = item.verdict === 'skipped' ? chalk.gray('skip ') : chalk.red('fail ');
    log.print(`    ${where} ${tag}  ${chalk.white(label)}  ${chalk.gray(item.reason ?? '')}`);
    return;
  }
  for (const f of item.findings) {
    const level = f.severity === 'error' ? chalk.red('error') : chalk.yellow('warn ');
    log.print(`    ${where} ${level}  ${chalk.white(label)}  ${f.message} ${chalk.gray(f.check)}`);
  }
}

function printReport(report: DepsReport): void {
  log.print(heading(report));
  log.blank();
  if (report.packages.length === 0) {
    log.info(report.mode === 'added' ? 'No npm dependencies were added.' : 'No npm dependencies to check.');
  } else {
    const noisy = report.packages.filter((p) => p.findings.length > 0 || p.verdict === 'skipped' || p.verdict === 'unchecked');
    let current: string | null | undefined;
    for (const item of noisy) {
      if (item.manifest !== current) {
        current = item.manifest;
        log.blank();
        log.print(`  ${chalk.white.underline(current ?? 'command line')}`);
      }
      printItem(item);
    }
    if (noisy.length === 0) log.success(`${count(report.checked, 'package')} checked, nothing to report`);
  }
  for (const e of report.errors) log.warn(e.message);
  // The cooldown tip is shown when it is relevant: a fresh release was found, or every dependency was checked.
  const fresh = report.packages.some((p) => p.findings.some((f) => f.check === 'fresh-release'));
  if (report.cooldownTip && (fresh || report.mode === 'all')) {
    log.blank();
    log.info(`No release cooldown is configured. To have the package manager wait a day before installing new releases, ${report.cooldownTip}.`);
  }
  log.blank();
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more`);
  return n;
}

export function registerVerifyDepsCommand(program: Command): void {
  program
    .command('verify-deps [packages...]')
    .description('Check npm packages before they are installed: the dependencies a change adds, or packages you name. Flags names that do not exist, look-alikes of popular packages, new or rarely used packages, install scripts, deprecations and releases published in the last day. Uses the npm registry.')
    .option('--base <ref>', 'Check dependencies added since the merge-base with this ref')
    .option('--staged', 'Check dependencies added in staged changes')
    .option('--all', 'Check every dependency in the repository, not only added ones')
    .option('--json', 'Output the report as JSON')
    .option('--sarif', `Output SARIF 2.1.0 (automationDetails.id "${DEPS_AUTOMATION_ID}")`)
    .option('--sarif-output <file>', 'Write SARIF to this file')
    .option('--fail-on <level>', 'Exit 1 on: error (default) | warning | none', 'error')
    .option('--min-age <days>', `Packages first published fewer days ago count as new (default ${DEFAULT_MIN_AGE_DAYS})`)
    .option('--min-downloads <count>', `Fewer weekly downloads count as rarely used (default ${DEFAULT_MIN_WEEKLY_DOWNLOADS})`)
    .option('--fresh-hours <hours>', `Versions published fewer hours ago are fresh releases (default ${DEFAULT_FRESH_HOURS}; 0 turns the check off)`)
    .action(async (packages: string[], opts: { base?: string; staged?: boolean; all?: boolean; json?: boolean; sarif?: boolean; sarifOutput?: string; failOn: string; minAge?: string; minDownloads?: string; freshHours?: string }) => {
      if (!['error', 'errors', 'warning', 'warnings', 'any', 'none'].includes(opts.failOn)) {
        log.error(`Unknown --fail-on level '${opts.failOn}'. Use error, warning or none.`);
        process.exit(2);
        return;
      }
      if (opts.base !== undefined && opts.staged) {
        log.error('--base and --staged cannot be combined.');
        process.exit(2);
        return;
      }
      let minAgeDays: number | undefined;
      let minWeeklyDownloads: number | undefined;
      let freshHours: number | undefined;
      try {
        if (opts.minAge !== undefined) minAgeDays = positiveInt(opts.minAge, '--min-age');
        if (opts.minDownloads !== undefined) minWeeklyDownloads = positiveInt(opts.minDownloads, '--min-downloads');
        if (opts.freshHours !== undefined) freshHours = positiveInt(opts.freshHours, '--fresh-hours');
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
        return;
      }

      const report = await verifyDeps({ cwd: process.cwd(), base: opts.base, staged: opts.staged, all: opts.all, packages, minAgeDays, minWeeklyDownloads, freshHours });
      const exitCode = depsExitCode(report, opts.failOn);
      const machineOutput = opts.json || (opts.sarif && !opts.sarifOutput);

      if (isGitHubActions()) emitGitHubAnnotations(depsToRunResult(report), machineOutput ? process.stderr : process.stdout);

      if (opts.sarif) {
        const sarif = sarifToJson(buildSarifLog(depsToRunResult(report), PKG_VERSION, process.env.GITHUB_WORKSPACE ?? report.root, DEPS_AUTOMATION_ID));
        if (opts.sarifOutput) fs.writeFileSync(opts.sarifOutput, sarif, 'utf8');
        else process.stdout.write(sarif + '\n');
        if (!opts.json) {
          process.exit(exitCode);
          return;
        }
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify({ version: PKG_VERSION, ...report }, null, 2) + '\n');
        process.exit(exitCode);
        return;
      }

      log.banner('AI GUARD');
      printReport(report);
      process.exit(exitCode);
    });
}
