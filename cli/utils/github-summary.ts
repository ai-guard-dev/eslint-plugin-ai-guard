/**
 * github-summary.ts — Write GitHub step summaries and PR annotations.
 *
 * When running in GitHub Actions, this module:
 * 1. Writes a formatted Markdown table to $GITHUB_STEP_SUMMARY
 * 2. Emits ::error and ::warning annotation commands to stdout
 *    (these appear as inline PR code annotations)
 */

import fs from 'fs';
import type { RunResult, IssueDetail } from './eslint-runner.js';
import { CONFIDENCE_TIER, RULE_CATEGORY } from './logger.js';
import type { ConfidenceTier } from './logger.js';

// ─── Environment availability ─────────────────────────────────────────────────

/**
 * Returns true if GITHUB_STEP_SUMMARY is set and the path is writable.
 * Safe to call in any environment — never throws.
 */
export function isGitHubSummaryAvailable(): boolean {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return false;
  try {
    const fd = fs.openSync(summaryPath, 'a');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if GITHUB_OUTPUT is set and writable.
 */
export function isGitHubOutputAvailable(): boolean {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return false;
  try {
    const fd = fs.openSync(outputPath, 'a');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Soft-warn to stderr only — never stdout, never throws, never fails CI. */
function warnEnvIssue(name: string, filePath: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[ai-guard] Warning: Could not write to ${name}=${filePath}: ${msg}\n`,
  );
}


// ─── Types ────────────────────────────────────────────────────────────────────

export interface SummaryOptions {
  preset: string;
  scanMode: 'full' | 'changed' | 'staged';
  changedFilesCount?: number;
  failOn?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  return text.replace(/[|`*_[\]<>]/g, '\\$&');
}

function tierEmoji(tier: ConfidenceTier | undefined): string {
  switch (tier) {
    case 'high':          return '🔴';
    case 'medium':        return '🟡';
    case 'low':           return '🔵';
    case 'informational': return '⬜';
    default:              return '⬜';
  }
}

function tierLabel(tier: ConfidenceTier | undefined): string {
  switch (tier) {
    case 'high':          return 'High';
    case 'medium':        return 'Medium';
    case 'low':           return 'Low';
    case 'informational': return 'Info';
    default:              return 'Low';
  }
}

// ─── GitHub annotation commands ───────────────────────────────────────────────

/**
 * Emit GitHub Actions annotation commands.
 * These appear as inline code review comments on PRs.
 *
 * Format: ::error file=path,line=N,endLine=N,col=N,title=RuleId::Message
 */
export function emitGitHubAnnotations(result: RunResult): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return;

  for (const file of result.files) {
    for (const issue of file.issues) {
      const tier = CONFIDENCE_TIER[issue.ruleId] as ConfidenceTier | undefined;

      // Only emit annotations for high + medium confidence findings
      // Informational hints should never create PR noise
      if (tier === 'informational') continue;

      const level = issue.severity === 2 ? 'error' : 'warning';
      const filePath = file.filePath.replace(/\\/g, '/');
      const shortRule = issue.ruleId.replace('ai-guard/', '');

      const parts = [`file=${filePath}`, `line=${issue.line}`];
      if (issue.endLine) parts.push(`endLine=${issue.endLine}`);
      if (issue.column > 0) parts.push(`col=${issue.column}`);
      if (issue.endColumn) parts.push(`endColumn=${issue.endColumn}`);
      parts.push(`title=ai-guard/${shortRule}`);

      // Message is escaped — GitHub strips markdown in annotations
      const msg = issue.message.replace(/\n/g, ' ');
      process.stdout.write(`::${level} ${parts.join(',')}::${msg}\n`);
    }
  }
}

// ─── GitHub step summary ──────────────────────────────────────────────────────

/**
 * Build the Markdown summary for $GITHUB_STEP_SUMMARY.
 */
export function buildGitHubSummaryMarkdown(
  result: RunResult,
  options: SummaryOptions,
): string {
  const lines: string[] = [];

  // Header
  lines.push('## AI Guard — Async Reliability Report');
  lines.push('');
  lines.push(`> **Preset:** \`${options.preset}\` &nbsp;|&nbsp; **Mode:** ${options.scanMode === 'changed' ? 'Changed files only' : options.scanMode === 'staged' ? 'Staged files' : 'Full scan'}`);
  if (options.changedFilesCount !== undefined) {
    lines.push(`> **Files scanned:** ${result.filesScanned} (${options.changedFilesCount} changed)`);
  } else {
    lines.push(`> **Files scanned:** ${result.filesScanned}`);
  }
  lines.push(`> **Duration:** ${result.durationMs}ms`);
  lines.push('');

  // Status badge
  if (result.totalIssues === 0) {
    lines.push('### ✅ No issues found');
    lines.push('');
    lines.push('All scanned files passed AI Guard reliability checks.');
    lines.push('');
    return lines.join('\n');
  }

  // Signal summary table
  const { high = 0, medium = 0, low = 0, informational = 0 } = buildSignalCounts(result);

  if (high > 0) {
    lines.push(`### ⚠️ ${high} high-confidence issue${high !== 1 ? 's' : ''} found`);
  } else if (medium > 0) {
    lines.push(`### 🔵 ${medium} medium-confidence issue${medium !== 1 ? 's' : ''} found`);
  } else {
    lines.push('### ℹ️ Informational hints only');
  }
  lines.push('');

  // Category breakdown table
  lines.push('| Category | 🔴 High | 🟡 Medium | 🔵 Low | ⬜ Info |');
  lines.push('|----------|---------|----------|-------|--------|');

  const categoryBreakdown = buildCategoryBreakdown(result);
  for (const [cat, counts] of Object.entries(categoryBreakdown)) {
    if ((counts.high + counts.medium + counts.low + counts.informational) === 0) continue;
    lines.push(`| ${cat} | ${counts.high} | ${counts.medium} | ${counts.low} | ${counts.informational} |`);
  }
  lines.push('');

  // Top findings table (max 10)
  const allIssues = result.files.flatMap((f) =>
    f.issues.map((i) => ({ ...i, filePath: f.filePath })),
  );
  const actionableIssues = allIssues
    .filter((i) => {
      const tier = CONFIDENCE_TIER[i.ruleId] as ConfidenceTier | undefined;
      return tier !== 'informational';
    })
    .sort((a, b) => {
      const tierOrder = { high: 0, medium: 1, low: 2, informational: 3 };
      const ta = CONFIDENCE_TIER[a.ruleId] as ConfidenceTier | undefined;
      const tb = CONFIDENCE_TIER[b.ruleId] as ConfidenceTier | undefined;
      return (tierOrder[ta ?? 'low'] ?? 2) - (tierOrder[tb ?? 'low'] ?? 2);
    })
    .slice(0, 10);

  if (actionableIssues.length > 0) {
    lines.push('### Top Findings');
    lines.push('');
    lines.push('| File | Line | Rule | Confidence |');
    lines.push('|------|------|------|------------|');

    for (const issue of actionableIssues) {
      const tier = CONFIDENCE_TIER[issue.ruleId] as ConfidenceTier | undefined;
      const shortFile = issue.filePath.replace(/\\/g, '/').split('/').slice(-2).join('/');
      const shortRule = issue.ruleId.replace('ai-guard/', '');
      lines.push(
        `| \`${escapeMarkdown(shortFile)}\` | ${issue.line} | \`${shortRule}\` | ${tierEmoji(tier)} ${tierLabel(tier)} |`,
      );
    }
    lines.push('');
  }

  // Informational hints summary (collapsed)
  if (informational > 0) {
    lines.push('<details>');
    lines.push(`<summary>💡 ${informational} informational hint${informational !== 1 ? 's' : ''} (click to expand)</summary>`);
    lines.push('');
    lines.push('These are stylistic hints with higher false-positive rates in frameworks like Next.js and React. Review manually before acting.');
    lines.push('');

    const infoIssues = allIssues
      .filter((i) => {
        const tier = CONFIDENCE_TIER[i.ruleId] as ConfidenceTier | undefined;
        return tier === 'informational';
      })
      .slice(0, 20);

    lines.push('| File | Line | Rule |');
    lines.push('|------|------|------|');
    for (const issue of infoIssues) {
      const shortFile = issue.filePath.replace(/\\/g, '/').split('/').slice(-2).join('/');
      const shortRule = issue.ruleId.replace('ai-guard/', '');
      lines.push(`| \`${escapeMarkdown(shortFile)}\` | ${issue.line} | \`${shortRule}\` |`);
    }

    lines.push('</details>');
    lines.push('');
  }

  // Ecosystem issues (separated)
  if (result.ecosystemIssues.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>🔧 ${result.ecosystemIssues.length} ESLint config issue${result.ecosystemIssues.length !== 1 ? 's' : ''} (not ai-guard findings)</summary>`);
    lines.push('');
    lines.push('These are from your project\'s ESLint configuration, not from ai-guard rules. Run `ai-guard doctor` to diagnose.');
    lines.push('</details>');
    lines.push('');
  }

  // Next steps
  lines.push('---');
  lines.push('');
  lines.push('**Next steps:**');
  if (high > 0 || medium > 0) {
    lines.push('- Review high/medium confidence findings in the **Files changed** tab');
    lines.push('- Run `ai-guard run --verbose` locally to see full details');
  }
  if (informational > 0) {
    lines.push('- Run `ai-guard run --verbose` to expand informational hints');
  }
  lines.push('- Run `ai-guard baseline` to suppress known issues and track only new ones');
  lines.push('');
  lines.push('*Powered by [eslint-plugin-ai-guard](https://github.com/ai-guard-dev/eslint-plugin-ai-guard)*');

  return lines.join('\n');
}

function buildSignalCounts(result: RunResult): {
  high: number; medium: number; low: number; informational: number;
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
  return { high, medium, low, informational };
}

function buildCategoryBreakdown(result: RunResult): Record<string, {
  high: number; medium: number; low: number; informational: number;
}> {
  const breakdown: Record<string, { high: number; medium: number; low: number; informational: number }> = {};

  for (const file of result.files) {
    for (const issue of file.issues) {
      const cat = RULE_CATEGORY[issue.ruleId] ?? 'Other';
      const tier = CONFIDENCE_TIER[issue.ruleId] as ConfidenceTier | undefined;
      if (!breakdown[cat]) breakdown[cat] = { high: 0, medium: 0, low: 0, informational: 0 };
      if (tier === 'high') breakdown[cat].high++;
      else if (tier === 'medium') breakdown[cat].medium++;
      else if (tier === 'informational') breakdown[cat].informational++;
      else breakdown[cat].low++;
    }
  }

  return breakdown;
}

/**
 * Write the step summary to $GITHUB_STEP_SUMMARY file.
 *
 * Behavior:
 * - No-ops gracefully if GITHUB_STEP_SUMMARY is not set
 * - Soft-warns to stderr (never stdout) if the path is set but not writable
 * - Never throws — CI scan output is the primary feedback channel
 */
export function writeGitHubSummary(
  result: RunResult,
  options: SummaryOptions,
): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;  // Not in GitHub Actions — silently no-op

  try {
    const markdown = buildGitHubSummaryMarkdown(result, options);
    fs.appendFileSync(summaryPath, markdown + '\n', { encoding: 'utf-8' });
  } catch (err) {
    // Non-fatal — warn to stderr so it shows in CI logs but never fails the scan
    warnEnvIssue('GITHUB_STEP_SUMMARY', summaryPath, err);
  }
}

/**
 * Write output parameters to $GITHUB_OUTPUT.
 * Used by the GitHub Action to expose outputs to subsequent steps.
 *
 * Behavior:
 * - No-ops gracefully if GITHUB_OUTPUT is not set
 * - Soft-warns to stderr if the path is set but not writable
 * - Never throws
 */
export function writeGitHubOutputs(result: RunResult, sarifPath?: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;  // Not in GitHub Actions — silently no-op

  const { high, medium, low, informational } = buildSignalCounts(result);

  const outputs = [
    `issues-found=${result.totalIssues}`,
    `high-confidence-count=${high}`,
    `medium-confidence-count=${medium}`,
    `low-confidence-count=${low}`,
    `informational-count=${informational}`,
    `files-scanned=${result.filesScanned}`,
    `duration-ms=${result.durationMs}`,
    ...(sarifPath ? [`sarif-file=${sarifPath}`] : []),
  ];

  try {
    fs.appendFileSync(outputPath, outputs.join('\n') + '\n', { encoding: 'utf-8' });
  } catch (err) {
    warnEnvIssue('GITHUB_OUTPUT', outputPath, err);
  }
}
