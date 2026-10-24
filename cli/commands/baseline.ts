import type { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { runEslint, type Preset, type RunResult } from '../utils/eslint-runner.js';
import { log } from '../utils/logger.js';
import {
  BASELINE_FILE,
  buildBaseline,
  filterBaselinedIssues,
  loadBaseline,
  resolveBaselinePath,
  writeBaseline,
  type BaselineMode,
} from '../utils/baseline.js';

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerBaselineCommand(program: Command): void {
  program
    .command('baseline [action]')
    .description('Save current issues as baseline; future runs show only new issues (save | check)')
    .option('--save', 'Save current state as the new baseline')
    .option('--check', 'Show only issues introduced since the last baseline')
    .option('--mode <name>', 'Baseline match mode: strict | stable', 'stable')
    .option('--path <dir>', 'Directory to scan', '.')
    .option('--preset <name>', 'Preset: recommended (default for --save) | strict | security | agent. --check defaults to the preset stored in the baseline')
    .action(async (action: string | undefined, opts: {
      save?: boolean;
      check?: boolean;
      mode?: string;
      path: string;
      preset?: string;
    }) => {
      const cwd = process.cwd();
      const mode = (opts.mode as BaselineMode) ?? 'stable';

      const isSaveAction = action === 'save' || opts.save === true;
      const isCheckAction = action === 'check' || opts.check === true;

      if (mode !== 'strict' && mode !== 'stable') {
        log.error('Invalid --mode. Use strict or stable.');
        process.exit(1);
      }

      log.banner('AI GUARD BASELINE');
      log.blank();

      const baselinePath = resolveBaselinePath(cwd);
      const loaded = loadBaseline(baselinePath);
      if (loaded.status === 'invalid' && !isSaveAction) {
        // Never silently re-baseline over a corrupt file: that would hide every
        // finding introduced since the original baseline was written.
        log.error(`Baseline file ${chalk.white(BASELINE_FILE)} is invalid: ${loaded.reason}`);
        log.info(`Fix the file, or run ${chalk.cyan('ai-guard baseline --save')} to overwrite it.`);
        process.exit(1);
      }
      const existingBaseline = loaded.status === 'ok' ? loaded.baseline : null;

      // --check compares against the preset the baseline was recorded with
      // unless --preset overrides it; otherwise extra strict-only findings
      // would all show up as "new".
      const preset = (opts.preset as Preset | undefined)
        ?? (isSaveAction ? undefined : existingBaseline?.preset)
        ?? 'recommended';

      // If neither flag/action provided, default to save if no baseline exists, else check
      const doSave = isSaveAction || (!action && !opts.save && !opts.check && !existingBaseline);
      const doCheck = isCheckAction || (!action && !opts.save && !opts.check && existingBaseline !== null);

      if (doSave) {
        log.info('Scanning project to save baseline…');
        const spinner = ora({ text: 'Running analysis…', color: 'cyan' }).start();

        let result: RunResult | undefined;
        try {
          result = await runEslint({ preset, targetPath: opts.path });
          spinner.stop();
        } catch (err: unknown) {
          spinner.stop();
          log.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        // Keep explicit integrity acceptances; `--save` never creates or changes them.
        const keptIntegrity = existingBaseline?.integrity;
        writeBaseline(baselinePath, {
          ...buildBaseline(result!, preset, mode),
          ...(keptIntegrity ? { integrity: keptIntegrity } : {}),
        });
        log.success(
          `Baseline saved → ${chalk.white(path.relative(cwd, baselinePath))}`,
        );
        log.info(`  ${result!.totalIssues} issues recorded (${result!.totalErrors} errors, ${result!.totalWarnings} warnings)`);
        log.info(`  Preset: ${chalk.cyan(preset)}`);
        log.info(`  Mode: ${chalk.cyan(mode)}`);
        log.blank();
        log.info('Future runs of ' + chalk.cyan('ai-guard baseline --check') + ' will show only NEW issues.');
        log.info('Add ' + chalk.white(BASELINE_FILE) + ' to your git repository to share baseline with your team.');
        log.blank();
        return;
      }

      if (doCheck) {
        if (!existingBaseline) {
          log.error(`No baseline found at ${chalk.white(BASELINE_FILE)}`);
          log.info(`Run ${chalk.cyan('ai-guard baseline --save')} first to create one.`);
          process.exit(1);
        }

        const baselineDate = new Date(existingBaseline.createdAt).toLocaleString();
        log.info(`Baseline from: ${chalk.gray(baselineDate)}`);
        log.info(`Baseline preset: ${chalk.cyan(existingBaseline.preset)}`);
        log.info(`Baseline mode: ${chalk.cyan(existingBaseline.mode)}`);
        log.info(`Baseline issues: ${chalk.gray(existingBaseline.totalIssues)}`);
        log.blank();

        const spinner = ora({ text: 'Scanning for new issues…', color: 'cyan' }).start();

        let result: RunResult | undefined;
        try {
          result = await runEslint({ preset, targetPath: opts.path });
          spinner.stop();
        } catch (err: unknown) {
          spinner.stop();
          log.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        const { result: newResult } = filterBaselinedIssues(result!, existingBaseline);

        if (newResult.totalIssues === 0) {
          log.success('No new issues since baseline! ✨');
          log.info(
            `Total in codebase: ${result!.totalIssues} (all existing, none new)`,
          );
          log.blank();
          process.exit(0);
          return;
        }

        log.print(
          chalk.bold.red(`  ✖  ${newResult.totalIssues} new issue${newResult.totalIssues !== 1 ? 's' : ''} since baseline`),
        );
        log.blank();

        // By rule breakdown
        if (newResult.ruleBreakdown.size > 0) {
          log.section('New Issues by Rule');
          for (const [rule, count] of [...newResult.ruleBreakdown.entries()].sort(
            (a, b) => b[1] - a[1],
          )) {
            log.rule(rule, count);
          }
        }

        // Per-file breakdown
        if (newResult.files.length > 0) {
          log.section('New Issues by File');
          log.blank();
          for (const file of newResult.files) {
            log.print(
              `  ${chalk.bold.white(file.filePath)} ` +
                chalk.gray(`(${file.issues.length} new)`),
            );
            for (const issue of file.issues) {
              log.issue(issue.message, issue.severity, issue.line, issue.column);
            }
          }
        }

        log.blank();
        log.divider();
        log.blank();
        log.error(
          `${newResult.totalIssues} new issue${newResult.totalIssues !== 1 ? 's' : ''} introduced since baseline.`,
        );
        log.info(`Run ${chalk.cyan('ai-guard baseline --save')} to update the baseline after fixing them.`);
        log.blank();
        process.exit(1);
      }
    });
}
