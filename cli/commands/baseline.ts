import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { runEslint, type Preset, type RunResult } from '../utils/eslint-runner.js';
import { log } from '../utils/logger.js';

const BASELINE_FILE = '.ai-guard-baseline.json';

// ─── Baseline format ──────────────────────────────────────────────────────────

interface BaselineIssue {
  ruleId: string;
  message: string;
  line: number;
  column: number;
}

type BaselineMode = 'strict' | 'stable';

interface BaselineEntry {
  filePath: string;
  issues: BaselineIssue[];
}

interface BaselineFile {
  createdAt: string;
  preset: Preset;
  mode: BaselineMode;
  totalIssues: number;
  entries: BaselineEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function saveBaseline(
  result: RunResult,
  preset: Preset,
  mode: BaselineMode,
  cwd: string,
): string {
  const entries: BaselineEntry[] = result.files.map((f) => ({
    filePath: f.filePath,
    issues: f.issues.map((i) => ({
      ruleId: i.ruleId,
      message: i.message,
      line: i.line,
      column: i.column,
    })),
  }));

  const baseline: BaselineFile = {
    createdAt: new Date().toISOString(),
    preset,
    mode,
    totalIssues: result.totalIssues,
    entries,
  };

  const baselinePath = path.join(cwd, BASELINE_FILE);
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
  return baselinePath;
}

function loadBaseline(cwd: string): BaselineFile | null {
  const baselinePath = path.join(cwd, BASELINE_FILE);
  if (!fs.existsSync(baselinePath)) return null;
  try {
    const raw = fs.readFileSync(baselinePath, 'utf-8');
    return JSON.parse(raw) as BaselineFile;
  } catch {
    return null;
  }
}

type IssueKey = string;

function issueKey(filePath: string, issue: BaselineIssue): IssueKey {
  // Normalize path separators to forward slashes for cross-platform compatibility (M11)
  const normalizedPath = filePath.replace(/\\/g, '/');
  return `${normalizedPath}::${issue.ruleId}::${issue.line}::${issue.column}::${issue.message}`;
}

function stableIssueKey(filePath: string, issue: BaselineIssue): IssueKey {
  // Normalize path separators to forward slashes for cross-platform compatibility (M11)
  const normalizedPath = filePath.replace(/\\/g, '/');
  return `${normalizedPath}::${issue.ruleId}::${issue.message}`;
}

function buildBaselineSet(baseline: BaselineFile, mode: BaselineMode): Set<IssueKey> {
  const toKey = mode === 'stable' ? stableIssueKey : issueKey;
  const set = new Set<IssueKey>();
  for (const entry of baseline.entries) {
    for (const issue of entry.issues) {
      set.add(toKey(entry.filePath, issue));
    }
  }
  return set;
}

function computeNewIssues(
  result: RunResult,
  baselineSet: Set<IssueKey>,
  mode: BaselineMode,
): RunResult {
  const toKey = mode === 'stable' ? stableIssueKey : issueKey;
  const newFiles: RunResult['files'] = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  const ruleBreakdown = new Map<string, number>();

  for (const file of result.files) {
    const newIssues = file.issues.filter(
      (i) => !baselineSet.has(toKey(file.filePath, i)),
    );
    if (newIssues.length === 0) continue;

    const errorCount = newIssues.filter((i) => i.severity === 2).length;
    const warningCount = newIssues.filter((i) => i.severity === 1).length;
    totalErrors += errorCount;
    totalWarnings += warningCount;

    for (const issue of newIssues) {
      ruleBreakdown.set(
        issue.ruleId,
        (ruleBreakdown.get(issue.ruleId) ?? 0) + 1,
      );
    }

    newFiles.push({ ...file, issues: newIssues, errorCount, warningCount });
  }

  const topFiles = [...newFiles]
    .sort((a, b) => b.issues.length - a.issues.length)
    .slice(0, 10)
    .map((f) => ({ path: f.filePath, count: f.issues.length }));

  return {
    files: newFiles,
    totalErrors,
    totalWarnings,
    totalIssues: totalErrors + totalWarnings,
    ruleBreakdown,
    topFiles,
    durationMs: result.durationMs,
  };
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerBaselineCommand(program: Command): void {
  program
    .command('baseline [action]')
    .description('Save current issues as baseline; future runs show only new issues (save | check)')
    .option('--save', 'Save current state as the new baseline')
    .option('--check', 'Show only issues introduced since the last baseline')
    .option('--mode <name>', 'Baseline match mode: strict | stable', 'stable')
    .option('--path <dir>', 'Directory to scan', '.')
    .option('--preset <name>', 'Preset: recommended | strict | security', 'recommended')
    .action(async (action: string | undefined, opts: {
      save?: boolean;
      check?: boolean;
      mode?: string;
      path: string;
      preset: string;
    }) => {
      const cwd = process.cwd();
      const preset = (opts.preset as Preset) ?? 'recommended';
      const mode = (opts.mode as BaselineMode) ?? 'stable';

      const isSaveAction = action === 'save' || opts.save === true;
      const isCheckAction = action === 'check' || opts.check === true;

      if (mode !== 'strict' && mode !== 'stable') {
        log.error('Invalid --mode. Use strict or stable.');
        process.exit(1);
      }

      log.banner('AI GUARD BASELINE');
      log.blank();

      // If neither flag/action provided, default to save if no baseline exists, else check
      const existingBaseline = loadBaseline(cwd);
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

        const baselinePath = saveBaseline(result!, preset, mode, cwd);
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
        log.info(`Baseline mode: ${chalk.cyan(existingBaseline.mode ?? 'strict')}`);
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

        const compareMode = existingBaseline.mode ?? 'strict';
        const baselineSet = buildBaselineSet(existingBaseline!, compareMode);
        const newResult = computeNewIssues(result!, baselineSet, compareMode);

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
