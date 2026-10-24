/**
 * integrity.ts — ai-guard integrity command.
 *
 * Detects changes that weaken the project's own checks (new suppressions,
 * skipped/focused/removed tests, downgraded ESLint/TypeScript/coverage
 * settings, removed CI steps, Git hook bypasses) relative to a base revision.
 *
 * Usage:
 *   ai-guard integrity                 # uncommitted + untracked changes vs HEAD
 *   ai-guard integrity --base main     # branch changes vs merge-base with main
 *   ai-guard integrity --staged        # staged changes vs HEAD
 *   ai-guard integrity --enforce       # exit 1 on high-confidence findings
 *   ai-guard integrity --accept 1a2b3c4d  # explicitly accept one finding (or a rule ID, or "all")
 *
 * `ai-guard changed --integrity <report|enforce>` runs the same analysis
 * alongside the changed-file lint scan; this command runs it on its own.
 */

import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { addIntegrityAcceptances, resolveBaselinePath } from '../utils/baseline.js';
import { buildSarifLog, sarifToJson } from '../utils/sarif.js';
import { getGitHubBaseRef, isGitHubActions } from '../utils/git-diff.js';
import { runCliIntegrity } from '../utils/integrity/run.js';
import { integrityExitCode, type IntegrityEnvelope, type IntegrityFinding } from '../utils/integrity/types.js';
import { counts, emitIntegrityAnnotations, integrityJson, integrityMarkdown, integrityTextLines } from '../utils/integrity/report.js';
import type { RunResult } from '../utils/eslint-runner.js';

interface IntegrityCommandOptions {
  base?: string;
  pr?: boolean;
  staged?: boolean;
  enforce?: boolean;
  json?: boolean;
  sarif?: boolean;
  sarifOutput?: string;
  baseline?: string;
  accept?: string;
  githubSummary?: boolean;
}

/** A RunResult carrying only integrity findings, so the shared SARIF builder can render it. */
export function integrityOnlyResult(envelope: IntegrityEnvelope): RunResult {
  return {
    files: [], totalErrors: 0, totalWarnings: 0, totalIssues: 0, filesScanned: 0,
    ruleBreakdown: new Map(), topFiles: [], durationMs: 0, ecosystemIssues: [], parserErrors: [],
    ignoredFiles: [], tsParserAvailable: true, integrity: envelope,
  };
}

function writeSummary(envelope: IntegrityEnvelope): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, `## AI Guard — Check Integrity\n\n${integrityMarkdown(envelope)}\n`, 'utf-8');
  } catch (err) {
    process.stderr.write(`[ai-guard] Could not write GITHUB_STEP_SUMMARY: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function writeOutputs(envelope: IntegrityEnvelope): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath || !envelope.report) return;
  const { high, advisory } = counts(envelope.report);
  try {
    fs.appendFileSync(outputPath, `integrity-high-count=${high}\nintegrity-advisory-count=${advisory}\n`, 'utf-8');
  } catch { /* non-fatal */ }
}

export function registerIntegrityCommand(program: Command): void {
  program
    .command('integrity')
    .description('Detect changes that weaken checks (new suppressions, skipped or removed tests, downgraded configs, removed CI steps) vs a base revision')
    .option('--base <ref>', 'Compare with the merge-base of HEAD and <ref> (origin/<ref> preferred). Default: HEAD')
    .option('--pr', 'Use the pull request base branch (GITHUB_BASE_REF) as --base')
    .option('--staged', 'Compare staged changes (the index) with HEAD')
    .option('--enforce', 'Exit 1 when a high-confidence finding exists (default: report only)')
    .option('--json', 'Output results as JSON')
    .option('--sarif', 'Output results as SARIF 2.1.0')
    .option('--sarif-output <file>', 'Write SARIF to this file')
    .option('--baseline <file>', 'Baseline file holding accepted findings (default: .ai-guard-baseline.json)')
    .option('--accept <selection>', 'Accept findings explicitly in the baseline file: comma-separated fingerprints (8+ hex chars, shown as #… in the output), rule IDs, or "all"')
    .option('--github-summary', 'Write a GitHub step summary (auto-enabled in GitHub Actions)')
    .action(async (opts: IntegrityCommandOptions) => {
      const cwd = process.cwd();
      const machineStdout = Boolean(opts.json) || (Boolean(opts.sarif) && !opts.sarifOutput);
      if (opts.staged && (opts.base || opts.pr)) {
        log.error('--staged compares the index with HEAD and cannot be combined with --base or --pr.');
        process.exit(2);
        return;
      }
      const base = opts.base ?? (opts.pr ? getGitHubBaseRef() : undefined);
      if (opts.pr && !base) {
        log.error('--pr needs GITHUB_BASE_REF (set by GitHub Actions on pull_request events), or pass --base <branch>.');
        process.exit(2);
        return;
      }
      const envelope = await runCliIntegrity({
        cwd,
        mode: opts.enforce ? 'enforce' : 'report',
        base,
        staged: opts.staged,
        baselinePath: opts.baseline,
      });

      if (opts.accept) {
        if (process.env.CI === 'true' || isGitHubActions()) {
          log.error('--accept is disabled in CI: accepting findings must be a reviewed local change to the baseline file.');
          process.exit(2);
          return;
        }
        if (!envelope.report) {
          log.error(`Cannot accept findings: ${envelope.error?.message ?? 'analysis did not run'}`);
          process.exit(2);
          return;
        }
        const selection = selectForAcceptance(envelope.report.findings, opts.accept);
        if ('error' in selection) {
          log.error(selection.error);
          for (const f of acceptable(envelope.report.findings)) log.print(`  #${f.fingerprint.slice(0, 12)}  ${f.ruleId}  ${f.file}${f.line ? `:${f.line}` : ''}`);
          process.exit(2);
          return;
        }
        const baselinePath = resolveBaselinePath(cwd, opts.baseline);
        const { added, total } = addIntegrityAcceptances(baselinePath, selection.findings);
        for (const f of selection.findings) log.print(`  accepted #${f.fingerprint.slice(0, 12)}  ${f.tier}  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.message}`);
        log.success(`Accepted ${added} finding(s) in ${path.relative(cwd, baselinePath) || baselinePath} (${total} accepted in total).`);
        log.info('Commit the baseline file so reviewers can see what was accepted; the change itself is reported as an advisory finding.');
        process.exit(0);
        return;
      }

      if (isGitHubActions() || opts.githubSummary) {
        writeSummary(envelope);
        writeOutputs(envelope);
        emitIntegrityAnnotations(envelope, machineStdout ? process.stderr : process.stdout);
      }

      const exitCode = envelope.error ? 2 : integrityExitCode(envelope);

      if (opts.sarif || opts.sarifOutput) {
        const json = sarifToJson(buildSarifLog(integrityOnlyResult(envelope), undefined, process.env.GITHUB_WORKSPACE ?? undefined));
        if (opts.sarifOutput) fs.writeFileSync(opts.sarifOutput, json, 'utf-8');
        else console.log(json);
        if (!opts.json && opts.sarifOutput) printHuman(envelope);
        if (envelope.error) process.stderr.write(`[ai-guard] ${envelope.error.message}\n`);
        process.exit(exitCode);
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(integrityJson(envelope), null, 2));
        process.exit(exitCode);
        return;
      }
      printHuman(envelope);
      process.exit(exitCode);
    });
}

/** Findings that may be accepted: never the record of an acceptance itself. */
function acceptable(findings: IntegrityFinding[]): IntegrityFinding[] {
  return findings.filter((f) => f.ruleId !== 'ai-guard/integrity-acceptance-added');
}

/**
 * Resolve an explicit --accept selection. A bare "accept everything" is only
 * possible with the literal `all`, so nothing is accepted by accident.
 */
export function selectForAcceptance(findings: IntegrityFinding[], selection: string | undefined): { findings: IntegrityFinding[] } | { error: string } {
  const candidates = acceptable(findings);
  const tokens = (selection ?? '').split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
  if (tokens.length === 0) return { error: 'Specify what to accept: fingerprints (from the #… column), rule IDs, or "all".' };
  if (candidates.length === 0) return { error: 'There are no findings to accept.' };
  if (tokens.length === 1 && tokens[0] === 'all') return { findings: candidates };
  const picked = new Set<IntegrityFinding>();
  for (const token of tokens) {
    let matches: IntegrityFinding[];
    if (/^[0-9a-f]{8,}$/i.test(token)) matches = candidates.filter((f) => f.fingerprint.startsWith(token.toLowerCase()));
    else if (token.includes('integrity-')) matches = candidates.filter((f) => f.ruleId === token || f.ruleId === `ai-guard/${token}`);
    else return { error: `"${token}" is not a fingerprint (8+ hex characters), an integrity rule ID, or "all".` };
    if (matches.length === 0) return { error: `"${token}" matches no current finding.` };
    matches.forEach((m) => picked.add(m));
  }
  return { findings: [...picked] };
}

function printHuman(envelope: IntegrityEnvelope): void {
  log.banner('AI GUARD — CHECK INTEGRITY');
  log.blank();
  if (envelope.error) {
    log.error(envelope.error.message);
    log.blank();
    return;
  }
  for (const line of integrityTextLines(envelope)) {
    if (line.startsWith('  HIGH')) log.print(chalk.red(line));
    else if (line.startsWith('  advisory')) log.print(chalk.yellow(line));
    else if (line.startsWith('            ')) log.print(line);
    else log.print(`  ${line}`);
  }
  log.blank();
  const report = envelope.report!;
  if (report.findings.length > 0) {
    log.info(`Fix the weakened checks, or accept an intended one explicitly: ${chalk.cyan('ai-guard integrity --accept <#fingerprint>')}`);
    log.blank();
  }
}
