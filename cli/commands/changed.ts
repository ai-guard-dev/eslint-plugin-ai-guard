/**
 * changed.ts — ai-guard changed command.
 *
 * Scans only the files that have changed in a PR or working tree,
 * instead of the full project. This is the primary CI/CD scan mode.
 *
 * Usage:
 *   ai-guard changed                  # Uncommitted changes + staged
 *   ai-guard changed --pr             # PR diff vs base branch (auto-detects GITHUB_BASE_REF)
 *   ai-guard changed --staged         # Staged files only
 *   ai-guard changed --base main      # Diff vs specific branch
 *   ai-guard changed --path packages/web  # Filter to subdirectory (monorepo)
 */

import type { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import ora from 'ora';
import chalk from 'chalk';
import { runEslint, type Preset, type EcosystemIssue, ISSUE_CONFIDENCE } from '../utils/eslint-runner.js';
import { log, CONFIDENCE_TIER, RULE_CATEGORY, CATEGORY_ICONS, CATEGORY_ORDER, type ConfidenceTier, isCollapsedByDefault } from '../utils/logger.js';
import { buildSarifLog, sarifToJson, buildSarifDebugInfo } from '../utils/sarif.js';
import {
  getChangedFiles,
  isGitHubActions,
  getGitHubBaseRef,
} from '../utils/git-diff.js';
import {
  emitGitHubAnnotations,
  writeGitHubSummary,
  writeGitHubOutputs,
  buildGitHubSummaryMarkdown,
} from '../utils/github-summary.js';
import { printGitDebug, printCIDebug } from '../utils/debug.js';
import { PKG_VERSION } from '../utils/version.js';
import { getRunExitCode, formatIssueCount, renderIssuesByFile, partitionByTier, buildSignalSummary, resolveExitCode } from './run.js';
import type { RunResult } from '../utils/eslint-runner.js';

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerChangedCommand(program: Command): void {
  program
    .command('changed')
    .description('Scan only changed files in the current PR or working tree (fastest CI mode)')
    .option('--pr', 'Scan files changed vs base branch (auto-detects GITHUB_BASE_REF in CI)')
    .option('--staged', 'Scan only staged (git add\'d) files')
    .option('--base <branch>', 'Base branch to diff against (raw name: main, develop — not origin/main)')
    .option('--path <dir>', 'Root path / working directory for scanning', '.')
    .option('--strict', 'Use the strict rule preset (all rules at error)')
    .option('--security', 'Use the security-only rule preset')
    .option('--fail-on <level>', 'Fail CI on: high | medium | any | errors | none', 'high')
    .option('--json', 'Output results as JSON')
    .option('--sarif', 'Output results as SARIF 2.1.0 (for GitHub Code Scanning)')
    .option('--sarif-output <file>', 'Write SARIF to this file path')
    .option('--sarif-stdout', 'Force SARIF to stdout even in CI (overrides auto-file behavior)')
    .option('--github-summary', 'Write GitHub step summary (auto-enabled in GitHub Actions)')
    .option('--max-warnings <n>', 'Fail if warnings exceed this count',
      (v: string) => Number.parseInt(v, 10))
    .option('--verbose', 'Expand all findings (disable grouping)')
    .option('--quiet', 'Show errors only')
    .option('--debug-timing', 'Print per-phase timing diagnostics')
    .option('--debug-git', 'Print full git resolution trace (useful for diagnosing zero-file issues)')
    .option('--debug-ci', 'Print CI environment state (GITHUB_* vars, SARIF path, summary path)')
    .option('--debug-sarif', 'Print SARIF tag normalization trace — diagnose duplicate-tag schema issues')
    .action(async (opts: {
      pr?: boolean;
      staged?: boolean;
      base?: string;
      path: string;
      strict?: boolean;
      security?: boolean;
      failOn: string;
      json?: boolean;
      sarif?: boolean;
      sarifOutput?: string;
      sarifStdout?: boolean;
      githubSummary?: boolean;
      maxWarnings?: number;
      verbose?: boolean;
      quiet?: boolean;
      debugTiming?: boolean;
      debugGit?: boolean;
      debugCi?: boolean;
      debugSarif?: boolean;
    }) => {
      const preset: Preset = opts.strict ? 'strict' : opts.security ? 'security' : 'recommended';
      const inCI = isGitHubActions();
      // FIX: Pass raw branch name — getChangedFiles owns all ref normalization.
      // Previously, changed.ts prepended origin/ here AND git-diff.ts did it again
      // → git merge-base HEAD origin/origin/main — always fails.
      const baseRef = opts.base ?? (opts.pr || inCI ? getGitHubBaseRef() : undefined);

      // Resolve SARIF output path:
      // - CI: default to file output (predictable for upload-sarif)
      // - local: stdout unless --sarif-output specified
      // - --sarif-stdout: force stdout in any environment
      const sarifToFile = opts.sarif && !opts.sarifStdout && (opts.sarifOutput || inCI);
      const resolvedSarifPath = opts.sarifOutput ?? (sarifToFile ? 'ai-guard-results.sarif' : undefined);

      if (!opts.json && !opts.sarif) {
        log.banner('AI GUARD');
      }

      // ── Debug CI ────────────────────────────────────────────────────────────
      if (opts.debugCi) {
        const { printCIDebug } = await import('../utils/debug.js');
        printCIDebug({
          isGitHubActions: inCI,
          githubBaseRef: process.env.GITHUB_BASE_REF,
          githubSha: process.env.GITHUB_SHA,
          githubRef: process.env.GITHUB_REF,
          githubRepository: process.env.GITHUB_REPOSITORY,
          githubWorkflow: process.env.GITHUB_WORKFLOW,
          githubRunId: process.env.GITHUB_RUN_ID,
          githubEventName: process.env.GITHUB_EVENT_NAME,
          githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
          githubOutput: process.env.GITHUB_OUTPUT,
          sarifOutputPath: resolvedSarifPath,
          preset,
          failOn: opts.failOn,
          scanMode: opts.staged ? 'staged' : baseRef ? 'pr-diff' : 'uncommitted',
        });
      }

      // ── Detect changed files ─────────────────────────────────────────────────
      const cwd = process.cwd();
      const resolvedPath = path.resolve(opts.path);
      const workingDirectory = opts.path !== '.' ? opts.path : undefined;

      const spinner = opts.json || opts.sarif
        ? null
        : ora({ text: chalk.dim('Detecting changed files…'), color: 'cyan' }).start();

      const changedResult = getChangedFiles({
        staged: opts.staged ?? false,
        base: baseRef,
        cwd,
        workingDirectory,
        debug: opts.debugGit,
      });

      // ── Debug git output ─────────────────────────────────────────────────────
      if (opts.debugGit) {
        const { printGitDebug } = await import('../utils/debug.js');
        printGitDebug(changedResult);
      }

      if (changedResult.files.length === 0) {
        spinner?.stop();

        if (changedResult.mode === 'fallback') {
          // Git not available — fall back to full scan
          if (!opts.json && !opts.sarif) {
            log.warn('Git not available. Falling back to full scan.');
            log.blank();
          }
          // Delegate to full scan
          const result = await runEslint({
            preset,
            targetPath: resolvedPath.toString(),
            debugTiming: opts.debugTiming,
          });
          handleResults(result, opts, preset, 'full', 0, inCI, resolvedSarifPath);
          return;
        }

        // Explicit warning when zero files — never silent
        if (!opts.json && !opts.sarif) {
          log.blank();
          log.print(`  ${chalk.yellow('⚠')}  No changed JS/TS files detected — nothing to scan`);
          if (changedResult.zeroFilesReason) {
            log.print(chalk.dim(`     ${changedResult.zeroFilesReason}`));
          }
          if (changedResult.filteredOut > 0) {
            log.print(chalk.dim(`     (${changedResult.filteredOut} file${changedResult.filteredOut !== 1 ? 's' : ''} filtered out)`));
          }
          if (!opts.debugGit) {
            log.print(chalk.dim('     Run with --debug-git for full git resolution trace.'));
          }
          log.blank();
        } else if (opts.json) {
          console.log(JSON.stringify({
            version: PKG_VERSION,
            preset,
            scanMode: changedResult.mode,
            changedFiles: 0,
            filesScanned: 0,
            totalIssues: 0,
            totalErrors: 0,
            totalWarnings: 0,
            zeroFilesReason: changedResult.zeroFilesReason,
            debugInfo: opts.debugGit ? changedResult.debugInfo : undefined,
            signalSummary: { high: 0, medium: 0, low: 0, informational: 0, ecosystemIssues: 0, parserErrors: 0 },
          }, null, 2));
        }
        process.exit(0);
        return;
      }

      // ── Scan changed files ─────────────────────────────────────────────────
      if (spinner) {
        spinner.text = chalk.dim(`Scanning ${changedResult.files.length} changed file${changedResult.files.length !== 1 ? 's' : ''}…`);
      }

      const result = await runEslint({
        preset,
        targetPath: resolvedPath.toString(),
        files: changedResult.files,
        debugTiming: opts.debugTiming,
      });

      spinner?.stop();

      const scanMode: 'full' | 'changed' | 'staged' =
        changedResult.mode === 'staged' ? 'staged' : 'changed';
      handleResults(result, opts, preset, scanMode, changedResult.files.length, inCI, resolvedSarifPath);
    });
}

// ─── Shared result handler ────────────────────────────────────────────────────

function handleResults(
  result: RunResult,
  opts: {
    failOn: string;
    json?: boolean;
    sarif?: boolean;
    sarifOutput?: string;
    sarifStdout?: boolean;
    githubSummary?: boolean;
    maxWarnings?: number;
    verbose?: boolean;
    quiet?: boolean;
    path: string;
    preset?: string;
    debugGit?: boolean;
    debugSarif?: boolean;
  },
  preset: string,
  scanMode: 'full' | 'changed' | 'staged',
  changedFilesCount: number,
  inCI: boolean,
  resolvedSarifPath?: string,
): Promise<void> {
  // ── GitHub integrations ────────────────────────────────────────────────────
  if (inCI || opts.githubSummary) {
    writeGitHubSummary(result, { preset, scanMode, changedFilesCount });
    writeGitHubOutputs(result, opts.sarifOutput);
    emitGitHubAnnotations(result);
  }

  // ── SARIF mode ─────────────────────────────────────────────────────────────
  if (opts.sarif) {
    const sarifLog = buildSarifLog(result);
    const sarifJson = sarifToJson(sarifLog);

    // --debug-sarif: print SARIF metadata and tag trace to stderr
    if (opts.debugSarif) {
      const debugInfo = buildSarifDebugInfo(result);
      process.stderr.write('\n[debug-sarif] SARIF GitHub Compatibility Trace\n');
      process.stderr.write('[debug-sarif] ─────────────────────────────────────────\n');
      process.stderr.write('[debug-sarif] Rules Emitted:\n');
      for (const r of debugInfo.rulesEmitted) {
        process.stderr.write(`[debug-sarif]   - ${r.id}:\n`);
        process.stderr.write(`[debug-sarif]     confidence:        ${r.confidence}\n`);
        process.stderr.write(`[debug-sarif]     level:             ${r.level}\n`);
        process.stderr.write(`[debug-sarif]     security-severity: ${r.securitySeverity}\n`);
        process.stderr.write(`[debug-sarif]     precision:         ${r.precision}\n`);
        process.stderr.write(`[debug-sarif]     raw tags:          ${JSON.stringify(r.rawTags)}\n`);
        process.stderr.write(`[debug-sarif]     normalized tags:   ${JSON.stringify(r.sanitizedTags)}\n`);
        if (r.hasDuplicatesInRaw) {
          process.stderr.write(`[debug-sarif]     ⚠ had duplicates — deduplicated\n`);
        }
      }
      process.stderr.write('\n[debug-sarif] Results Emitted:\n');
      if (debugInfo.resultsEmitted.length === 0) {
        process.stderr.write('[debug-sarif]   (none)\n');
      } else {
        for (const res of debugInfo.resultsEmitted) {
          process.stderr.write(`[debug-sarif]   - ${res.ruleId} (${res.filePath}:${res.line}):\n`);
          process.stderr.write(`[debug-sarif]     level:             ${res.level}\n`);
          process.stderr.write(`[debug-sarif]     kind:              ${res.kind}\n`);
          process.stderr.write(`[debug-sarif]     security-severity: ${res.securitySeverity}\n`);
          process.stderr.write(`[debug-sarif]     precision:         ${res.precision}\n`);
        }
      }
      process.stderr.write('[debug-sarif] ─────────────────────────────────────────\n\n');
    }

    // Write to file if a path was resolved (CI default or explicit --sarif-output)
    if (resolvedSarifPath) {
      fs.writeFileSync(resolvedSarifPath, sarifJson, 'utf-8');
      if (opts.debugSarif) {
        process.stderr.write(`[debug-sarif] SARIF written to: ${resolvedSarifPath}\n`);
      }
    } else {
      // stdout mode: local usage or --sarif-stdout
      console.log(sarifJson);
    }
    process.exit(getFailOnExitCode(result, opts.failOn, opts.maxWarnings));
    return;
  }

  // ── JSON mode ──────────────────────────────────────────────────────────────
  if (opts.json) {
    const signalSummary = buildSignalSummary(result);
    const jsonOutput = {
      version: PKG_VERSION,
      preset,
      scanMode,
      scannedPath: opts.path,
      filesScanned: result.filesScanned,
      changedFilesCount,
      totalErrors: result.totalErrors,
      totalWarnings: result.totalWarnings,
      totalIssues: result.totalIssues,
      durationMs: result.durationMs,
      signalSummary,
      ruleBreakdown: Object.fromEntries(result.ruleBreakdown),
      topFiles: result.topFiles,
      files: result.files,
      ecosystemIssues: result.ecosystemIssues,
      parserErrors: result.parserErrors,
      tsParserAvailable: result.tsParserAvailable,
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    process.exit(getFailOnExitCode(result, opts.failOn, opts.maxWarnings));
    return;
  }

  // ── Human-readable output ──────────────────────────────────────────────────
  const scanModeLabel = scanMode === 'changed'
    ? 'Changed files'
    : scanMode === 'staged'
    ? 'Staged files'
    : 'Full scan';

  const modeTag = changedFilesCount > 0
    ? `${changedFilesCount} changed`
    : '';

  log.summary(
    result.filesScanned,
    result.totalIssues,
    result.files.filter((f) => f.issues.length > 0).length,
    result.durationMs,
    `${preset} · ${scanModeLabel}${modeTag ? ` (${modeTag})` : ''}` as string,
  );

  if (result.totalIssues === 0) {
    log.blank();
    log.success(`No AI issues found — ${result.filesScanned} file${result.filesScanned !== 1 ? 's' : ''} scanned, all clean`);
    log.blank();
  } else {
    const verbose = opts.verbose ?? false;
    const quiet = opts.quiet ?? false;
    const { actionableFiles, informationalFiles } = partitionByTier(result, quiet);

    // Category summary
    log.section('Summary by Category');
    const categoryErrors: Record<string, number> = {};
    const categoryWarnings: Record<string, number> = {};
    for (const file of actionableFiles) {
      for (const issue of file.issues) {
        const cat = RULE_CATEGORY[issue.ruleId] ?? 'Other';
        if (issue.severity === 2) categoryErrors[cat] = (categoryErrors[cat] ?? 0) + 1;
        else categoryWarnings[cat] = (categoryWarnings[cat] ?? 0) + 1;
      }
    }
    const allCategories = new Set([...CATEGORY_ORDER, ...Object.keys(categoryErrors), ...Object.keys(categoryWarnings)]);
    const sortedCats = [...allCategories].filter((c) => (categoryErrors[c] ?? 0) + (categoryWarnings[c] ?? 0) > 0)
      .sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a), bi = CATEGORY_ORDER.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
    for (const cat of sortedCats) {
      const icon = CATEGORY_ICONS[cat] ?? '⚪';
      log.category(icon, cat, categoryErrors[cat] ?? 0, categoryWarnings[cat] ?? 0);
    }
    log.blank();
    log.print(`  ${chalk.bold('Total:')} ${formatIssueCount(result.totalErrors, result.totalWarnings)}`);
    log.blank();

    if (actionableFiles.length > 0) {
      log.section('Issues by File');
      log.blank();
      renderIssuesByFile({ ...result, files: actionableFiles }, verbose, quiet);
    }

    const totalInfoCount = informationalFiles.reduce((n, f) => n + f.issues.length, 0);
    if (totalInfoCount > 0 && !quiet) {
      if (verbose) {
        log.section('Informational Hints');
        log.print(chalk.dim('  Stylistic hints with higher false-positive rate — review before acting.'));
        log.blank();
        renderIssuesByFile({ ...result, files: informationalFiles }, true, false);
      } else {
        log.blank();
        log.print(`  ${chalk.gray('▸')}  ${chalk.gray(`${totalInfoCount} informational hint${totalInfoCount !== 1 ? 's' : ''} — run with ${chalk.cyan('--verbose')} to expand`)}`);
      }
    }
  }

  // Ecosystem issues
  if (result.ecosystemIssues.length > 0) {
    log.ecosystemSection('ESLint Config Issues');
    log.print(chalk.dim('  These issues come from your project\'s ESLint config, not from ai-guard.'));
    log.blank();
    const seen = new Map<string, { issue: EcosystemIssue; count: number }>();
    for (const issue of result.ecosystemIssues) {
      const key = `${issue.ruleId ?? 'null'}::${issue.message}`;
      const existing = seen.get(key);
      if (existing) { existing.count++; } else { seen.set(key, { issue, count: 1 }); }
    }
    for (const { issue, count } of seen.values()) {
      log.ecosystemIssue(issue, count);
    }
    log.blank();
  }

  log.divider();
  log.blank();
  log.section('Next Steps');
  if (result.totalIssues > 0) {
    log.info(`Run ${chalk.cyan('ai-guard baseline')} to save these issues and track only new ones`);
    log.info(`Run ${chalk.cyan('ai-guard report')}   to generate a shareable HTML report`);
  }
  if (result.ecosystemIssues.length > 0) {
    log.info(`Run ${chalk.cyan('ai-guard doctor')}   to diagnose ESLint config issues`);
  }
  log.blank();

  process.exit(getFailOnExitCode(result, opts.failOn, opts.maxWarnings));
}

// ─── Fail-on exit code logic ──────────────────────────────────────────────────

/**
 * Determine exit code based on --fail-on level.
 * Uses ISSUE_CONFIDENCE lookup (statically imported) for tier resolution.
 */
export function getFailOnExitCode(
  result: RunResult,
  failOn: string,
  maxWarnings?: number,
): number {
  return resolveExitCode(result, failOn, maxWarnings);
}
