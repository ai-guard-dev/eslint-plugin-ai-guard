import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { runEslint, type Preset, type EcosystemIssue } from '../utils/eslint-runner.js';
import { log, RULE_CATEGORY, CATEGORY_ICONS, CATEGORY_ORDER, CONFIDENCE_TIER, type ConfidenceTier, isCollapsedByDefault } from '../utils/logger.js';
import { buildSarifLog, sarifToJson } from '../utils/sarif.js';
import type { RunResult } from '../utils/eslint-runner.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run ai-guard rules on your project (zero ESLint config required)')
    .option('--path <dir>', 'Directory or file to scan', '.')
    .option('--strict', 'Use the strict rule preset (all rules at error)')
    .option('--security', 'Use the security-only rule preset')
    .option('--json', 'Output results as JSON (CI-friendly)')
    .option('--sarif', 'Output results as SARIF 2.1.0 (for GitHub Code Scanning)')
    .option(
      '--max-warnings <n>',
      'Fail with exit code 1 if warnings exceed this count',
      (value: string) => Number.parseInt(value, 10),
    )
    .option('--verbose', 'Show all issues — disable grouping of repeated warnings')
    .option('--quiet', 'Only show errors — suppress warnings and informational hints')
    .option('--debug-timing', 'Print per-phase timing diagnostics')
    .action(async (opts: {
      path: string;
      strict?: boolean;
      security?: boolean;
      json?: boolean;
      sarif?: boolean;
      maxWarnings?: number;
      verbose?: boolean;
      quiet?: boolean;
      debugTiming?: boolean;
    }) => {
      if (
        opts.maxWarnings !== undefined &&
        (!Number.isInteger(opts.maxWarnings) || opts.maxWarnings < 0)
      ) {
        log.blank();
        log.error('--max-warnings must be a non-negative integer.');
        log.blank();
        process.exit(1);
        return;
      }

      const preset: Preset = opts.strict
        ? 'strict'
        : opts.security
        ? 'security'
        : 'recommended';

      if (opts.strict && opts.security && !opts.json) {
        log.warn('Both --strict and --security were provided. Using --strict.');
        log.blank();
      }

      if (!opts.json) {
        log.banner('AI GUARD');
        log.blank();
      }

      const spinner = opts.json
        ? null
        : ora({ text: 'Scanning…', color: 'cyan' }).start();

      let result: RunResult;
      try {
        result = await runEslint({
          preset,
          targetPath: opts.path,
          debugTiming: opts.debugTiming,
        });
        spinner?.stop();
      } catch (err: unknown) {
        spinner?.stop();
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.toLowerCase().includes('typescript') && msg.toLowerCase().includes('parser')) {
          log.blank();
          log.error('TypeScript detected but parser not found.');
          log.blank();
          log.print(`  ${chalk.bold('Install the TypeScript parser:')}`);
          log.blank();
          log.print(`    ${chalk.cyan('npm install --save-dev @typescript-eslint/parser')}`);
          log.blank();
        } else {
          log.blank();
          log.error(msg);
          log.blank();
          log.print(`  ${chalk.bold('Fix:')} Run ${chalk.cyan('ai-guard doctor')} to diagnose your setup.`);
          log.blank();
        }
        process.exit(1);
        return;
      }

      // ─── SARIF mode ─────────────────────────────────────────────────────────────────

      if (opts.sarif) {
        const sarifLog = buildSarifLog(result);
        console.log(sarifToJson(sarifLog));
        process.exit(getRunExitCode(result, opts.maxWarnings));
        return;
      }

      // ─── JSON mode ─────────────────────────────────────────────────────────────────

      if (opts.json) {
        const signalSummary = buildSignalSummary(result);
        const jsonOutput = {
          preset,
          scannedPath: opts.path,
          filesScanned: result.filesScanned,
          totalErrors: result.totalErrors,
          totalWarnings: result.totalWarnings,
          totalIssues: result.totalIssues,
          durationMs: result.durationMs,
          timing: result.timing,
          signalSummary,
          ruleBreakdown: Object.fromEntries(result.ruleBreakdown),
          topFiles: result.topFiles,
          files: result.files,
          ecosystemIssues: result.ecosystemIssues,
          parserErrors: result.parserErrors,
          tsParserAvailable: result.tsParserAvailable,
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        process.exit(getRunExitCode(result, opts.maxWarnings));
        return;
      }

      // ─── Human output ────────────────────────────────────────────────────────

      // Scan stats header — note if TS parser missing
      log.scanStats(result.filesScanned, result.files.length, result.durationMs, preset);
      if (!result.tsParserAvailable) {
        log.print(
          chalk.dim(`  ℹ  TypeScript parser not found — .ts/.tsx files use espree fallback`) +
          chalk.dim(`  (install @typescript-eslint/parser for full TS support)`),
        );
      }
      log.blank();

      // ── Success state ─────────────────────────────────────────────────────────

      if (result.totalIssues === 0 && result.ecosystemIssues.length === 0 && result.parserErrors.length === 0) {
        log.print(
          `  ${chalk.green('✔')}  ${chalk.bold.green('No AI issues found')}  ${chalk.gray(`— ${result.filesScanned} file${result.filesScanned !== 1 ? 's' : ''} scanned, all clean`)}`,
        );
        log.blank();
        process.exit(0);
        return;
      }

      if (result.totalIssues === 0) {
        log.print(
          `  ${chalk.green('✔')}  ${chalk.bold.green('No AI issues found')}  ${chalk.gray(`— ${result.filesScanned} file${result.filesScanned !== 1 ? 's' : ''} scanned, all clean`)}`,
        );
        log.blank();
      }

      // ── AI Guard Findings ──────────────────────────────────────────────────

      if (result.totalIssues > 0) {
        const verbose = opts.verbose ?? false;
        const quiet = opts.quiet ?? false;

        // Separate informational from actionable findings
        const { actionableFiles, informationalFiles } = partitionByTier(result, quiet);

        // Category summary with icons
        log.section('Summary by Category');

        const categoryErrors: Record<string, number> = {};
        const categoryWarnings: Record<string, number> = {};

        // Only count actionable (non-informational) issues in category summary
        for (const file of actionableFiles) {
          for (const issue of file.issues) {
            const cat = RULE_CATEGORY[issue.ruleId] ?? 'Other';
            if (issue.severity === 2) {
              categoryErrors[cat] = (categoryErrors[cat] ?? 0) + 1;
            } else {
              categoryWarnings[cat] = (categoryWarnings[cat] ?? 0) + 1;
            }
          }
        }

        const allCategories = new Set([
          ...CATEGORY_ORDER,
          ...Object.keys(categoryErrors),
          ...Object.keys(categoryWarnings),
        ]);

        const sortedCategories = [...allCategories].filter(
          (cat) => (categoryErrors[cat] ?? 0) + (categoryWarnings[cat] ?? 0) > 0,
        );

        sortedCategories.sort((a, b) => {
          const ai = CATEGORY_ORDER.indexOf(a);
          const bi = CATEGORY_ORDER.indexOf(b);
          if (ai !== -1 && bi !== -1) return ai - bi;
          if (ai !== -1) return -1;
          if (bi !== -1) return 1;
          return a.localeCompare(b);
        });

        for (const cat of sortedCategories) {
          const icon = CATEGORY_ICONS[cat] ?? '⚪';
          log.category(icon, cat, categoryErrors[cat] ?? 0, categoryWarnings[cat] ?? 0);
        }

        log.blank();

        log.print(
          `  ${chalk.bold('Total:')} ${formatIssueCount(result.totalErrors, result.totalWarnings)}`,
        );
        log.blank();

        // By Rule — with confidence indicators
        if (result.ruleBreakdown.size > 0) {
          log.section('By Rule');

          const sorted = [...result.ruleBreakdown.entries()].sort(
            (a, b) => b[1] - a[1],
          );
          for (const [rule, count] of sorted) {
            const shortRule = rule.replace(/^ai-guard\//, '');
            const tier = CONFIDENCE_TIER[rule] as ConfidenceTier | undefined;
            const tierLabel = tier === 'high'
              ? chalk.red.dim('[high]')
              : tier === 'medium'
              ? chalk.yellow.dim('[medium]')
              : tier === 'informational'
              ? chalk.gray.dim('[info]')
              : chalk.gray.dim('[low]');
            if (quiet && tier === 'informational') continue;
            log.print(
              `    ${chalk.gray('\u2022')} ${chalk.yellow(shortRule)} ${tierLabel}${chalk.gray(':')} ${chalk.white(String(count))}`,
            );
          }
          log.blank();
        }

        // Top Files
        if (result.topFiles.length > 0) {
          log.section('Top Files');
          for (const { path: fp, count } of result.topFiles) {
            log.print(
              `    ${chalk.gray('\u2022')} ${chalk.white(fp)} ${chalk.gray(`(${count})`)}`,
            );
          }
          log.blank();
        }

        // Issues by File — actionable findings
        if (actionableFiles.length > 0) {
          log.section('Issues by File');
          log.blank();
          renderIssuesByFile({ ...result, files: actionableFiles }, verbose, quiet);
        }

        // Informational hints — collapsed by default
        const totalInfoCount = informationalFiles.reduce((n, f) => n + f.issues.length, 0);
        if (totalInfoCount > 0 && !quiet) {
          if (verbose) {
            log.section('Informational Hints');
            log.print(chalk.dim(`  Stylistic hints with higher false-positive rate — review before acting.`));
            log.blank();
            renderIssuesByFile({ ...result, files: informationalFiles }, true, false);
          } else {
            log.blank();
            log.print(
              `  ${chalk.gray('\u25b8')}  ${chalk.gray(`${totalInfoCount} informational hint${totalInfoCount !== 1 ? 's' : ''} — run with ${chalk.cyan('--verbose')} to expand`)}`,
            );
          }
        }
      }

      // ── ESLint Ecosystem Issues ───────────────────────────────────────────────
      // Shown SEPARATELY — these are NOT ai-guard findings

      if (result.ecosystemIssues.length > 0) {
        log.ecosystemSection('ESLint Config Issues');
        log.print(
          chalk.dim(`  These issues come from your project's ESLint config, not from ai-guard.`),
        );
        log.blank();

        // Group by ruleId + message to de-duplicate
        const seen = new Map<string, { issue: EcosystemIssue; count: number }>();
        for (const issue of result.ecosystemIssues) {
          const key = `${issue.ruleId ?? 'null'}::${issue.message}`;
          const existing = seen.get(key);
          if (existing) {
            existing.count++;
          } else {
            seen.set(key, { issue, count: 1 });
          }
        }

        for (const { issue, count } of seen.values()) {
          log.ecosystemIssue(issue, count);
        }

        log.blank();
      }

      // ── Parser Errors ─────────────────────────────────────────────────────────

      if (result.parserErrors.length > 0) {
        log.ecosystemSection('Parser Errors');
        log.print(
          chalk.dim(`  These files could not be parsed — not ai-guard findings.`),
        );
        log.blank();

        for (const pe of result.parserErrors) {
          log.parserError(pe);
        }

        if (!result.tsParserAvailable) {
          log.blank();
          log.print(
            `  ${chalk.cyan('→ Fix:')} ${chalk.yellow('npm install --save-dev @typescript-eslint/parser')}`,
          );
          log.print(
            chalk.dim(`  TypeScript parser resolves most .ts/.tsx parse failures.`),
          );
        }
        log.blank();
      }

      log.divider();
      log.blank();

      // ── Next steps ────────────────────────────────────────────────────────────

      log.section('Next Steps');
      if (result.totalIssues > 0) {
        log.info(`Run ${chalk.cyan('ai-guard baseline')} to save these issues and track only new ones`);
        log.info(`Run ${chalk.cyan('ai-guard report')}   to generate a shareable HTML report`);
        log.info(`Run ${chalk.cyan('ai-guard ignore')}   to suppress dist/build noise`);
      }
      if (result.ecosystemIssues.length > 0) {
        log.info(`Run ${chalk.cyan('ai-guard doctor')}   to diagnose ESLint config issues`);
      }
      if (!opts.verbose && hasGroupedWarnings(result)) {
        log.info(`Run with ${chalk.cyan('--verbose')} to expand grouped warnings`);
      }
      log.blank();

      process.exit(getRunExitCode(result, opts.maxWarnings));
    });
}

// ─── Issue rendering ──────────────────────────────────────────────────────────

const GROUP_THRESHOLD = 4; // Group if same rule appears >= this many times in a file

/** Partition files into actionable and informational based on confidence tier */
function partitionByTier(
  result: RunResult,
  quiet: boolean,
): { actionableFiles: RunResult['files']; informationalFiles: RunResult['files'] } {
  const actionableFiles: RunResult['files'] = [];
  const informationalFiles: RunResult['files'] = [];

  for (const file of result.files) {
    const actionableIssues = file.issues.filter((i) => {
      const tier = CONFIDENCE_TIER[i.ruleId] as ConfidenceTier | undefined;
      if (quiet && (tier === 'informational' || i.severity === 1)) return false;
      return tier !== 'informational';
    });
    const infoIssues = file.issues.filter((i) => {
      const tier = CONFIDENCE_TIER[i.ruleId] as ConfidenceTier | undefined;
      return tier === 'informational';
    });

    if (actionableIssues.length > 0) {
      actionableFiles.push({ ...file, issues: actionableIssues });
    }
    if (infoIssues.length > 0) {
      informationalFiles.push({ ...file, issues: infoIssues });
    }
  }

  return { actionableFiles, informationalFiles };
}

/** Build signal summary for JSON output — replaces misleading numeric score */
function buildSignalSummary(result: RunResult): {
  high: number; medium: number; low: number; informational: number;
  ecosystemIssues: number; parserErrors: number;
} {
  let high = 0, medium = 0, low = 0, informational = 0;
  for (const file of result.files) {
    for (const issue of file.issues) {
      const tier = CONFIDENCE_TIER[issue.ruleId] as ConfidenceTier | undefined;
      if (tier === 'high') high++;
      else if (tier === 'medium') medium++;
      else if (tier === 'informational') informational++;
      else low++;
    }
  }
  return {
    high, medium, low, informational,
    ecosystemIssues: result.ecosystemIssues.length,
    parserErrors: result.parserErrors.length,
  };
}

function hasGroupedWarnings(result: RunResult): boolean {
  for (const file of result.files) {
    const ruleCounts = new Map<string, number>();
    for (const issue of file.issues) {
      ruleCounts.set(issue.ruleId, (ruleCounts.get(issue.ruleId) ?? 0) + 1);
    }
    for (const count of ruleCounts.values()) {
      if (count >= GROUP_THRESHOLD) return true;
    }
  }
  return false;
}

function renderIssuesByFile(result: RunResult, verbose: boolean, quiet = false): void {
  for (const file of result.files) {
    log.print(
      `  ${chalk.bold.white(file.filePath)} ` +
        chalk.gray(
          `(${file.errorCount} error${file.errorCount !== 1 ? 's' : ''}, ` +
          `${file.warningCount} warning${file.warningCount !== 1 ? 's' : ''})`,
        ),
    );

    if (!verbose) {
      // Group repeated low-confidence warnings
      const ruleCounts = new Map<string, Array<typeof file.issues[0]>>();
      for (const issue of file.issues) {
        const arr = ruleCounts.get(issue.ruleId) ?? [];
        arr.push(issue);
        ruleCounts.set(issue.ruleId, arr);
      }

      for (const issues of ruleCounts.values()) {
        const tier = CONFIDENCE_TIER[issues[0].ruleId] ?? 'low';
        // Group low-confidence warnings if they repeat heavily
        if (tier === 'low' && issues.length >= GROUP_THRESHOLD) {
          const sev = issues[0].severity === 2 ? chalk.red('error') : chalk.yellow(' warn');
          const shortRule = chalk.gray(issues[0].ruleId.replace(/^ai-guard\//, ''));
          log.print(
            `    ${sev}  ${chalk.white(issues[0].message)}  ${shortRule}`,
          );
          log.print(
            chalk.dim(`           ↳ ${issues.length} occurrences — run with --verbose to expand`),
          );
        } else {
          for (const issue of issues) {
            renderSingleIssue(issue);
          }
        }
      }
    } else {
      for (const issue of file.issues) {
        renderSingleIssue(issue);
      }
    }

    log.blank();
  }
}

function renderSingleIssue(issue: { ruleId: string; severity: 1 | 2; message: string; line: number; column: number }): void {
  const sev = issue.severity === 2
    ? chalk.red('error')
    : chalk.yellow(' warn');
  const loc = chalk.gray(`${String(issue.line)}:${String(issue.column)}`).padEnd(12);
  const ruleShort = chalk.gray(issue.ruleId.replace(/^ai-guard\//, ''));
  const tier = CONFIDENCE_TIER[issue.ruleId] as ConfidenceTier | undefined;
  const tierTag = tier === 'informational'
    ? chalk.dim(' [info]')
    : '';
  log.print(
    `    ${loc} ${sev}  ${chalk.white(issue.message)}${tierTag}  ${ruleShort}`,
  );
}

// ─── Exit code ────────────────────────────────────────────────────────────────

export function getRunExitCode(result: RunResult, maxWarnings?: number): number {
  if (result.totalErrors > 0) return 1;
  if (maxWarnings !== undefined && result.totalWarnings > maxWarnings) return 1;
  return 0;
}

function formatIssueCount(errors: number, warnings: number): string {
  const parts: string[] = [];
  if (errors > 0) parts.push(chalk.red.bold(`${errors} error${errors !== 1 ? 's' : ''}`));
  if (warnings > 0) parts.push(chalk.yellow.bold(`${warnings} warning${warnings !== 1 ? 's' : ''}`));
  return parts.join(chalk.gray(' · '));
}
