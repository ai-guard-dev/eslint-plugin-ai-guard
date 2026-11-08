/**
 * verify.ts — ai-guard verify command.
 *
 * One verdict for the current change: lint findings it introduced, test-integrity
 * problems (focused, skipped, removed or weakened tests) and agent-config issues.
 * Exit 0 = pass, 1 = blocking findings (or disclosures with --strict), 2 = could not verify.
 *
 * Usage:
 *   ai-guard verify                 # uncommitted changes vs HEAD
 *   ai-guard verify --base main     # everything on this branch
 *   ai-guard verify --json          # machine-readable verdict
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { verifyChange, type VerifyFinding, type VerifyReport } from '../utils/verify.js';
import { isSafeGitRef } from '../utils/change-set.js';
import { PKG_VERSION } from '../utils/version.js';
import type { Preset } from '../utils/eslint-runner.js';

export function verifyExitCode(report: VerifyReport, strict: boolean): number {
  if (!report.success) return 2;
  if (report.blocking.length > 0) return 1;
  if (!report.pass) return 2; // part of the change could not be analyzed
  if (strict && report.disclosures.length > 0) return 1;
  return 0;
}

function printFinding(finding: VerifyFinding): void {
  const where = chalk.gray(`${finding.file}:${finding.line}`);
  const check = chalk.gray(finding.check.replace(/^ai-guard\//, ''));
  log.print(`    ${where}  ${check}`);
  log.print(`      ${finding.message}`);
  for (const detail of finding.details ?? []) log.print(chalk.gray(`        - ${detail}`));
}

function printReport(report: VerifyReport): void {
  const changed = `${report.changedFiles} changed file${report.changedFiles === 1 ? '' : 's'} vs ${report.base}`;
  log.print(`  ${chalk.bold('Verify')}  ${chalk.gray('·')}  ${changed}  ${chalk.gray('·')}  ` +
    `${report.blocking.length ? chalk.red(`${report.blocking.length} blocking`) : chalk.green('0 blocking')}  ${chalk.gray('·')}  ` +
    `${report.disclosures.length ? chalk.yellow(`${report.disclosures.length} to disclose`) : '0 to disclose'}`);
  if (report.preExisting > 0) {
    log.print(chalk.gray(`  ${report.preExisting} finding${report.preExisting === 1 ? '' : 's'} already present in touched files (not counted)`));
  }
  log.blank();

  if (report.blocking.length > 0) {
    log.section('Fix before merging');
    report.blocking.forEach(printFinding);
    log.blank();
  }
  if (report.disclosures.length > 0) {
    log.section('Review: changes that weaken tests or agent config');
    report.disclosures.forEach(printFinding);
    log.blank();
  }
  for (const error of report.errors) log.warn(`${error.code}: ${error.message}${error.file ? ` (${error.file})` : ''}`);

  if (!report.success || (report.blocking.length === 0 && !report.pass)) log.error('Verification did not complete. Do not treat this change as verified.');
  else if (report.blocking.length === 0) log.success(report.changedFiles === 0 ? 'No changes to verify' : 'No blocking issues in this change');
  log.blank();
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .description('Verify the current change: introduced lint findings, weakened or focused tests, and agent-config issues (exit 1 when blocking)')
    .option('--base <ref>', 'Compare the branch with this base (through the merge-base) instead of uncommitted changes')
    .option('--staged', 'Verify staged changes only')
    .option('--preset <name>', 'Lint preset: agent (default) | recommended | strict | security', 'agent')
    .option('--strict', 'Also fail when there are findings to disclose')
    .option('--json', 'Output the verdict as JSON')
    .action(async (opts: { base?: string; staged?: boolean; preset: string; strict?: boolean; json?: boolean }) => {
      if (!['agent', 'recommended', 'strict', 'security'].includes(opts.preset)) {
        log.error(`Unknown preset '${opts.preset}'. Valid presets: agent, recommended, strict, security`);
        process.exit(2);
        return;
      }
      if (opts.base !== undefined && !isSafeGitRef(opts.base)) {
        log.error('Invalid --base: expected a single Git ref');
        process.exit(2);
        return;
      }
      const report = await verifyChange({ cwd: process.cwd(), base: opts.base, staged: opts.staged, preset: opts.preset as Preset });
      const exitCode = verifyExitCode(report, opts.strict ?? false);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ version: PKG_VERSION, ...report }, null, 2) + '\n');
      } else {
        log.banner('AI GUARD');
        printReport(report);
      }
      process.exit(exitCode);
    });
}
