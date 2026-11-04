import type { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { runEslint, type Preset, type RunResult } from '../utils/eslint-runner.js';
import { log } from '../utils/logger.js';
import {
  BASELINE_FILE,
  BASELINE_VERSION,
  buildBaseline,
  filterBaselinedIssues,
  loadBaseline,
  resolveBaselinePath,
  writeBaseline,
  type BaselineMode,
} from '../utils/baseline.js';
import { buildSignalSummary, resolveExitCode } from './run.js';

const FAIL_ON_LEVELS = ['errors', 'high', 'medium', 'any', 'none'];
const PRESETS: readonly Preset[] = ['recommended', 'strict', 'security', 'agent'];

interface BaselineOptions {
  save?: boolean;
  check?: boolean;
  mode?: string;
  path: string;
  preset?: string;
  json?: boolean;
  failOn?: string;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerBaselineCommand(program: Command): void {
  program
    .command('baseline [action]')
    .description('Record existing findings, then report only new ones (create | check; "save" is an alias of "create")')
    .option('--save', 'Same as `baseline create`')
    .option('--check', 'Same as `baseline check`')
    .option('--mode <name>', 'Baseline match mode: strict | stable', 'stable')
    .option('--path <dir>', 'Directory to scan', '.')
    .option('--preset <name>', 'Preset: recommended (default for create) | strict | security | agent. check defaults to the preset stored in the baseline')
    .option('--json', 'Output results as JSON')
    .option('--fail-on <level>', 'check: exit 1 when NEW findings reach this level: errors | high | medium | any | none (default: any new finding)')
    .action(async (action: string | undefined, opts: BaselineOptions) => {
      const cwd = process.cwd();
      const json = opts.json === true;
      const mode = (opts.mode as BaselineMode) ?? 'stable';

      // Errors: human text on stderr, plus a JSON object on stdout with --json.
      const fail = (code: string, message: string, hint?: string): never => {
        if (json) console.log(JSON.stringify({ error: { code, message } }, null, 2));
        log.error(message);
        if (hint && !json) log.info(hint);
        process.exit(1);
      };

      if (action !== undefined && !['create', 'save', 'check'].includes(action)) {
        fail('INVALID_ACTION', `Unknown baseline action '${action}'. Use create or check.`);
      }
      if (mode !== 'strict' && mode !== 'stable') {
        fail('INVALID_OPTION', 'Invalid --mode. Use strict or stable.');
      }
      if (opts.preset !== undefined && !PRESETS.includes(opts.preset as Preset)) {
        fail('INVALID_OPTION', `Unknown preset '${opts.preset}'. Valid presets: ${PRESETS.join(', ')}`);
      }
      if (opts.failOn !== undefined && !FAIL_ON_LEVELS.includes(opts.failOn)) {
        fail('INVALID_OPTION', `Invalid --fail-on '${opts.failOn}'. Use ${FAIL_ON_LEVELS.join(', ')}.`);
      }

      const isCreateAction = action === 'create' || action === 'save' || opts.save === true;
      const isCheckAction = action === 'check' || opts.check === true;

      if (!json) {
        log.banner('AI GUARD BASELINE');
        log.blank();
      }

      const baselinePath = resolveBaselinePath(cwd);
      const relBaseline = path.relative(cwd, baselinePath) || BASELINE_FILE;
      const loaded = loadBaseline(baselinePath);
      if (loaded.status === 'invalid' && loaded.newerVersion) {
        // Even `create` must not replace a file this version cannot read.
        fail('BASELINE_INCOMPATIBLE', `Baseline file ${relBaseline} is not supported: ${loaded.reason}`);
      }
      if (loaded.status === 'invalid' && !isCreateAction) {
        // Never silently re-baseline over a corrupt file: that would hide every
        // finding introduced since the original baseline was written.
        fail('BASELINE_INVALID', `Baseline file ${relBaseline} is invalid: ${loaded.reason}`,
          `Fix the file, or run ${chalk.cyan('ai-guard baseline create')} to overwrite it.`);
      }
      const existingBaseline = loaded.status === 'ok' ? loaded.baseline : null;

      // check compares against the preset the baseline was recorded with
      // unless --preset overrides it; otherwise extra strict-only findings
      // would all show up as "new".
      const preset = (opts.preset as Preset | undefined)
        ?? (isCreateAction ? undefined : existingBaseline?.preset)
        ?? 'recommended';

      // With no action: create if no baseline exists, else check.
      const doCreate = isCreateAction || (!isCheckAction && !existingBaseline);

      const scan = async (text: string): Promise<RunResult> => {
        const spinner = json ? null : ora({ text, color: 'cyan' }).start();
        try {
          const result = await runEslint({ preset, targetPath: opts.path });
          spinner?.stop();
          return result;
        } catch (err: unknown) {
          spinner?.stop();
          return fail('SCAN_FAILED', err instanceof Error ? err.message : String(err));
        }
      };

      if (doCreate) {
        const result = await scan('Running analysis…');
        // Keep explicit integrity acceptances; create never adds or changes them.
        const keptIntegrity = existingBaseline?.integrity;
        writeBaseline(baselinePath, {
          ...buildBaseline(result, preset, mode),
          ...(keptIntegrity ? { integrity: keptIntegrity } : {}),
        });

        if (json) {
          console.log(JSON.stringify({
            action: 'create',
            baselinePath: relBaseline.replace(/\\/g, '/'),
            version: BASELINE_VERSION,
            preset,
            mode,
            totalIssues: result.totalIssues,
            totalErrors: result.totalErrors,
            totalWarnings: result.totalWarnings,
          }, null, 2));
          return;
        }
        log.success(`Baseline saved → ${chalk.white(relBaseline)}`);
        log.info(`  ${result.totalIssues} issues recorded (${result.totalErrors} errors, ${result.totalWarnings} warnings)`);
        log.info(`  Preset: ${chalk.cyan(preset)}`);
        log.info(`  Mode: ${chalk.cyan(mode)}`);
        log.blank();
        log.info('Future runs of ' + chalk.cyan('ai-guard baseline check') + ' will show only NEW issues.');
        log.info('Add ' + chalk.white(BASELINE_FILE) + ' to your git repository to share baseline with your team.');
        log.blank();
        return;
      }

      // ── check ────────────────────────────────────────────────────────────
      if (!existingBaseline) {
        fail('BASELINE_MISSING', `No baseline found at ${relBaseline}`,
          `Run ${chalk.cyan('ai-guard baseline create')} first to create one.`);
        return;
      }

      if (!json) {
        log.info(`Baseline from: ${chalk.gray(new Date(existingBaseline.createdAt).toLocaleString())}`);
        log.info(`Baseline preset: ${chalk.cyan(existingBaseline.preset)}`);
        log.info(`Baseline mode: ${chalk.cyan(existingBaseline.mode)}`);
        log.info(`Baseline issues: ${chalk.gray(existingBaseline.totalIssues)}`);
        log.blank();
      }

      const result = await scan('Scanning for new issues…');
      const { result: newResult, suppressed, movedMatches } = filterBaselinedIssues(result, existingBaseline);

      // --fail-on applies the usual failure policy to NEW findings only;
      // without it, any new finding fails (the original behaviour).
      const exitCode = opts.failOn !== undefined
        ? resolveExitCode(newResult, opts.failOn)
        : newResult.totalIssues > 0 ? 1 : 0;

      if (json) {
        console.log(JSON.stringify({
          action: 'check',
          baselinePath: relBaseline.replace(/\\/g, '/'),
          baseline: {
            version: existingBaseline.version ?? 1,
            createdAt: existingBaseline.createdAt,
            preset: existingBaseline.preset,
            mode: existingBaseline.mode,
            totalIssues: existingBaseline.totalIssues,
          },
          preset,
          failOn: opts.failOn ?? null,
          totalIssues: result.totalIssues,
          matched: suppressed,
          movedMatches,
          newIssues: newResult.totalIssues,
          newErrors: newResult.totalErrors,
          newWarnings: newResult.totalWarnings,
          signalSummary: buildSignalSummary(newResult),
          ruleBreakdown: Object.fromEntries(newResult.ruleBreakdown),
          files: newResult.files,
        }, null, 2));
        process.exit(exitCode);
        return;
      }

      if (movedMatches > 0) {
        log.info(`${movedMatches} existing finding${movedMatches !== 1 ? 's' : ''} matched in moved or renamed files.`);
      }

      if (newResult.totalIssues === 0) {
        log.success('No new issues since baseline! ✨');
        log.info(`Total in codebase: ${result.totalIssues} (all existing, none new)`);
        log.blank();
        process.exit(0);
        return;
      }

      log.print(
        chalk.bold.red(`  ✖  ${newResult.totalIssues} new issue${newResult.totalIssues !== 1 ? 's' : ''} since baseline`) +
          chalk.gray(` (${newResult.totalErrors} errors, ${newResult.totalWarnings} warnings)`),
      );
      log.blank();

      if (newResult.ruleBreakdown.size > 0) {
        log.section('New Issues by Rule');
        for (const [rule, count] of [...newResult.ruleBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
          log.rule(rule, count);
        }
      }

      log.section('New Issues by File');
      log.blank();
      for (const file of newResult.files) {
        log.print(`  ${chalk.bold.white(file.filePath)} ` + chalk.gray(`(${file.issues.length} new)`));
        for (const issue of file.issues) {
          log.issue(`${issue.message} ${chalk.gray(`(${issue.ruleId})`)}`, issue.severity, issue.line, issue.column);
        }
      }

      log.blank();
      log.divider();
      log.blank();
      if (exitCode !== 0) {
        log.error(`${newResult.totalIssues} new issue${newResult.totalIssues !== 1 ? 's' : ''} introduced since baseline.`);
      } else {
        log.info(`New issues are below --fail-on ${opts.failOn}; not failing.`);
      }
      log.info(`Run ${chalk.cyan('ai-guard baseline create')} to update the baseline after fixing or accepting them.`);
      log.blank();
      process.exit(exitCode);
    });
}
