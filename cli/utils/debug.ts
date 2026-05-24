/**
 * debug.ts — Debug output helpers for --debug-git and --debug-ci flags.
 *
 * Centralized debug formatting ensures consistent output across commands.
 * All debug output goes to stderr to avoid polluting stdout (SARIF/JSON).
 */

import chalk from 'chalk';
import type { GitDiffDebugInfo, ChangedFilesResult } from './git-diff.js';

// ─── Debug output ─────────────────────────────────────────────────────────────

const DIM = chalk.dim;
const LABEL = chalk.cyan.bold;
const OK = chalk.green('✔');
const WARN = chalk.yellow('⚠');
const ERR = chalk.red('✖');
const ARROW = chalk.dim('→');

/** Write a debug line to stderr. Never pollutes stdout. */
export function debugLog(message: string): void {
  process.stderr.write(`${DIM('[debug]')} ${message}\n`);
}

// ─── Git debug ────────────────────────────────────────────────────────────────

/**
 * Print a full git resolution trace after getChangedFiles() runs.
 * Used by --debug-git flag.
 */
export function printGitDebug(result: ChangedFilesResult): void {
  const d = result.debugInfo;

  process.stderr.write('\n');
  process.stderr.write(`${LABEL('  Git Resolution Trace')}\n`);
  process.stderr.write(`${DIM('  ─────────────────────────────────────────────────────')}\n`);

  // Mode
  process.stderr.write(`  ${DIM('Mode:')}          ${chalk.white(result.mode)}\n`);

  // Base branch
  if (d.resolvedBase) {
    process.stderr.write(`  ${DIM('Base branch:')}   ${chalk.white(d.resolvedBase)}\n`);
  } else {
    process.stderr.write(`  ${DIM('Base branch:')}   ${chalk.dim('(none — uncommitted mode)')}\n`);
  }

  // Merge base
  if (d.mergeBase) {
    process.stderr.write(`  ${DIM('Merge base:')}    ${chalk.white(d.mergeBase.slice(0, 12))}…\n`);
  }

  // Clone state
  if (d.isShallowClone) {
    process.stderr.write(`  ${WARN} ${chalk.yellow('Shallow clone detected')} — use fetch-depth: 0 in workflow\n`);
  }
  if (d.isDetachedHead) {
    process.stderr.write(`  ${WARN} ${chalk.yellow('Detached HEAD')} — branch context unavailable\n`);
  }

  // Strategies
  process.stderr.write('\n');
  process.stderr.write(`  ${DIM('Strategies attempted:')}\n`);
  for (const strategy of d.strategiesAttempted) {
    const succeeded = strategy === d.strategySucceeded;
    const icon = succeeded ? OK : ERR;
    const label = succeeded ? chalk.green(strategy) : chalk.dim(strategy);
    process.stderr.write(`    ${icon} ${label}\n`);
  }

  if (d.strategySucceeded) {
    process.stderr.write(`\n  ${OK} ${chalk.green('Succeeded:')} ${d.strategySucceeded}\n`);
  } else {
    process.stderr.write(`\n  ${ERR} ${chalk.red('All strategies failed')}\n`);
  }

  // File counts
  process.stderr.write('\n');
  process.stderr.write(`  ${DIM('Files:')}\n`);
  process.stderr.write(`    ${ARROW} Detected raw:       ${chalk.white(d.rawFileCount)}\n`);
  process.stderr.write(`    ${ARROW} Kept:               ${chalk.green(result.files.length)}\n`);
  if (d.droppedByExtension > 0) {
    process.stderr.write(`    ${ARROW} Dropped (ext):      ${chalk.dim(d.droppedByExtension)}\n`);
  }
  if (d.droppedByIgnore > 0) {
    process.stderr.write(`    ${ARROW} Dropped (ignored):  ${chalk.dim(d.droppedByIgnore)}\n`);
  }
  if (d.droppedByWorkingDir > 0) {
    process.stderr.write(`    ${ARROW} Dropped (dir):      ${chalk.dim(d.droppedByWorkingDir)}\n`);
  }
  if (d.droppedMissing > 0) {
    process.stderr.write(`    ${ARROW} Dropped (missing):  ${chalk.dim(d.droppedMissing)}\n`);
  }

  // Zero-files reason
  if (result.zeroFilesReason) {
    process.stderr.write('\n');
    process.stderr.write(`  ${WARN} ${chalk.yellow('Zero files reason:')}\n`);
    process.stderr.write(`    ${chalk.dim(result.zeroFilesReason)}\n`);
  }

  // Changed files list
  if (result.files.length > 0) {
    process.stderr.write('\n');
    process.stderr.write(`  ${DIM('Changed files (first 20):')}\n`);
    for (const f of result.files.slice(0, 20)) {
      process.stderr.write(`    ${chalk.dim('·')} ${chalk.white(f)}\n`);
    }
    if (result.files.length > 20) {
      process.stderr.write(`    ${chalk.dim(`… and ${result.files.length - 20} more`)}\n`);
    }
  }

  process.stderr.write('\n');
}

// ─── CI debug ────────────────────────────────────────────────────────────────

export interface CIDebugInfo {
  isGitHubActions: boolean;
  githubBaseRef?: string;
  githubSha?: string;
  githubRef?: string;
  githubRepository?: string;
  githubWorkflow?: string;
  githubRunId?: string;
  githubEventName?: string;
  githubStepSummary?: string;
  githubOutput?: string;
  sarifOutputPath?: string;
  preset: string;
  failOn: string;
  scanMode: string;
}

/**
 * Print CI environment state for --debug-ci flag.
 */
export function printCIDebug(info: CIDebugInfo): void {
  process.stderr.write('\n');
  process.stderr.write(`${LABEL('  CI Environment')}\n`);
  process.stderr.write(`${DIM('  ─────────────────────────────────────────────────────')}\n`);

  const env = (name: string, value: string | undefined): void => {
    const val = value ? chalk.white(value) : chalk.dim('(not set)');
    process.stderr.write(`  ${DIM(name.padEnd(26))} ${val}\n`);
  };

  env('GITHUB_ACTIONS:', info.isGitHubActions ? 'true' : 'false');
  env('GITHUB_BASE_REF:', info.githubBaseRef);
  env('GITHUB_SHA:', info.githubSha);
  env('GITHUB_REF:', info.githubRef);
  env('GITHUB_REPOSITORY:', info.githubRepository);
  env('GITHUB_WORKFLOW:', info.githubWorkflow);
  env('GITHUB_RUN_ID:', info.githubRunId);
  env('GITHUB_EVENT_NAME:', info.githubEventName);

  process.stderr.write('\n');
  env('GITHUB_STEP_SUMMARY:', info.githubStepSummary);
  env('GITHUB_OUTPUT:', info.githubOutput);

  process.stderr.write('\n');
  env('Scan preset:', info.preset);
  env('Fail on:', info.failOn);
  env('Scan mode:', info.scanMode);
  if (info.sarifOutputPath) {
    env('SARIF output:', info.sarifOutputPath);
  }

  process.stderr.write('\n');
}
