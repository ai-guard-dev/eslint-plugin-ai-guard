/**
 * verify.ts — one verdict for "is this change done?".
 *
 * Combines, for the files a change touched:
 *  - lint findings the change introduced (on added or edited lines)
 *  - test-integrity findings (focused, skipped, removed or weakened tests)
 *  - agent-config findings the change introduced (CLAUDE.md, .mcp.json, ...)
 *
 * and classifies each as `blocking` (pass = false) or a `disclosure` (the agent
 * must tell the user, but the change can stand). Pre-existing problems in touched
 * files are counted, never blocking: an agent should not be forced to fix
 * legacy code it did not write.
 *
 * Used by `ai-guard verify`, the Claude Code Stop hook and the MCP
 * `ai_guard_verify_change` tool.
 */

import path from 'path';
import { createHash } from 'crypto';
import { runEslint, DEFAULT_IGNORE_PATTERNS, type Preset, type IssueDetail } from './eslint-runner.js';
import { getChangeSet, getLineChanges, readBefore, readAfter, scopeChangeSet, type ChangeSet, type ChangeSetOptions } from './change-set.js';
import { analyzeChangeSet } from './test-integrity.js';
import { classifyAgentConfigPath, scanAgentConfigText, type AgentConfigFinding } from './agent-config.js';
import { AGENT_RULES } from '../../src/configs/agent.js';
import recommendedConfig from '../../src/configs/recommended.js';
import strictConfig from '../../src/configs/strict.js';
import securityConfig from '../../src/configs/security.js';

type RuleLevel = 'error' | 'warn';

/**
 * Rules `verify` always runs at least at this level, whatever the preset: unfinished
 * code and weakened tests are what "the agent says it is done but it is not" looks like.
 */
export const VERIFY_RULE_FLOOR: Record<string, RuleLevel> = {
  'ai-guard/no-placeholder-implementation': 'error',
  'ai-guard/no-tautological-assertion': 'error',
  'ai-guard/no-test-env-branch': 'error',
  'ai-guard/no-assertionless-test': 'warn',
  'ai-guard/no-silent-fallback': 'warn',
  'ai-guard/no-unsanitized-html': 'warn',
};

const JS_TS = /\.(?:[cm]?[jt]sx?)$/i;
export const MAX_VERIFY_FILES = 300;

export interface VerifyFinding {
  /** Stable identity, used to report each finding once per agent session. */
  id: string;
  source: 'lint' | 'test-integrity' | 'agent-config';
  /** Rule ID or virtual rule ID, e.g. ai-guard/test-integrity/focused-test. */
  check: string;
  severity: 'error' | 'warning';
  blocking: boolean;
  file: string;
  line: number;
  message: string;
  remediation?: string;
  details?: string[];
}

export interface VerifyReport {
  /** False when verification itself could not run (Git error, unreadable files). */
  success: boolean;
  /** True when the whole change was analyzed and has no blocking findings. */
  pass: boolean;
  /** Absolute repository root; finding paths are relative to it. */
  root: string;
  base: string;
  mode: string;
  changedFiles: number;
  lintedFiles: number;
  testFilesAnalyzed: number;
  agentConfigFiles: number;
  blocking: VerifyFinding[];
  disclosures: VerifyFinding[];
  /** Findings in touched files that the change did not introduce. */
  preExisting: number;
  errors: Array<{ code: string; message: string; file?: string }>;
  durationMs: number;
}

export interface VerifyOptions extends ChangeSetOptions {
  preset?: Preset;
  /** Use the packaged plugin and parser only (MCP). */
  isolated?: boolean;
  /** Only consider changed files inside this absolute directory (an MCP workspace). */
  scope?: string;
  /** Compare tests before and after the change. Default true. */
  testIntegrity?: boolean;
}

function presetRules(preset: Preset): Record<string, unknown> {
  if (preset === 'agent') return AGENT_RULES;
  if (preset === 'strict') return strictConfig.rules ?? {};
  if (preset === 'security') return securityConfig.rules ?? {};
  return recommendedConfig.rules ?? {};
}

/** The preset's levels, raised to the verify floor. */
export function verifyRuleLevels(preset: Preset): Record<string, RuleLevel> {
  const out: Record<string, RuleLevel> = {};
  for (const [id, level] of Object.entries(presetRules(preset))) {
    if (level === 'error' || level === 'warn') out[id] = level;
  }
  for (const [id, floor] of Object.entries(VERIFY_RULE_FLOOR)) {
    if (out[id] !== 'error') out[id] = floor === 'error' ? 'error' : (out[id] ?? floor);
  }
  return out;
}

function isDefaultIgnored(relPath: string): boolean {
  const normalized = '/' + relPath.replace(/\\/g, '/') + '/';
  return DEFAULT_IGNORE_PATTERNS.some((pattern) => {
    const segment = pattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    return segment === '.pnp.*' ? normalized.split('/').some((p) => p.startsWith('.pnp.')) : normalized.includes('/' + segment + '/');
  });
}

function fingerprint(parts: Array<string | number | undefined>): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000'), 'utf8').digest('hex').slice(0, 16);
}

function emptyReport(start: number, base: string, mode: string): VerifyReport {
  return {
    success: true, pass: true, root: '', base, mode, changedFiles: 0, lintedFiles: 0, testFilesAnalyzed: 0, agentConfigFiles: 0,
    blocking: [], disclosures: [], preExisting: 0, errors: [], durationMs: Date.now() - start,
  };
}

function agentFindingKey(f: AgentConfigFinding): string {
  return `${f.check}\u0000${f.message}\u0000${f.excerpt ?? ''}`;
}

export async function verifyChange(options: VerifyOptions): Promise<VerifyReport> {
  const start = Date.now();
  const preset: Preset = options.preset ?? 'agent';
  let changeSet: ChangeSet;
  try {
    changeSet = getChangeSet(options);
  } catch (error) {
    const report = emptyReport(start, options.base ?? 'HEAD', 'error');
    report.success = false;
    report.pass = false;
    report.errors.push({ code: 'GIT_FAILED', message: error instanceof Error ? error.message : String(error) });
    return report;
  }

  if (options.scope) changeSet = scopeChangeSet(changeSet, options.scope);

  const report = emptyReport(start, changeSet.baseLabel, changeSet.mode);
  report.root = changeSet.root;
  report.changedFiles = changeSet.files.length;
  if (changeSet.files.length === 0) return report;
  const root = changeSet.root;

  // ── Lint the changed JS/TS files ──────────────────────────────────────────
  const lintable = changeSet.files.filter((f) => f.status !== 'deleted' && JS_TS.test(f.path) && !isDefaultIgnored(f.path));
  if (lintable.length > MAX_VERIFY_FILES) {
    report.errors.push({ code: 'TOO_MANY_FILES', message: `Only the first ${MAX_VERIFY_FILES} of ${lintable.length} changed JS/TS files were linted` });
  }
  const toLint = lintable.slice(0, MAX_VERIFY_FILES);
  if (toLint.length > 0) {
    const lineChanges = getLineChanges(changeSet, toLint.map((f) => f.path));
    try {
      const result = await runEslint({
        preset,
        targetPath: root,
        files: toLint.map((f) => path.join(root, f.path)),
        rules: verifyRuleLevels(preset),
        isolated: options.isolated,
      });
      report.lintedFiles = result.filesScanned;
      for (const parserError of result.parserErrors) {
        report.errors.push({ code: 'PARSE_ERROR', message: parserError.message, file: parserError.filePath.replace(/\\/g, '/') });
      }
      // The runner reports paths relative to its working directory: the target (root)
      // in isolated mode, the process directory otherwise.
      const runnerCwd = options.isolated ? root : process.cwd();
      for (const file of result.files) {
        const rel = path.relative(root, path.resolve(runnerCwd, file.filePath)).replace(/\\/g, '/');
        const changes = lineChanges.get(rel);
        const sourceLines = (readAfter(changeSet, rel) ?? '').split('\n');
        for (const issue of file.issues) {
          if (!isIntroduced(issue, changes?.touched ?? 'all')) {
            report.preExisting++;
            continue;
          }
          const lineText = (sourceLines[issue.line - 1] ?? '').trim();
          const blocking = issue.severity === 2;
          (blocking ? report.blocking : report.disclosures).push({
            id: fingerprint(['lint', issue.ruleId, rel, issue.message, lineText]),
            source: 'lint',
            check: issue.ruleId,
            severity: blocking ? 'error' : 'warning',
            blocking,
            file: rel,
            line: issue.line,
            message: issue.message,
            remediation: issue.remediation,
          });
        }
      }
    } catch (error) {
      report.success = false;
      report.errors.push({ code: 'LINT_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  }

  // ── Test integrity ─────────────────────────────────────────────────────────
  try {
    const integrity = options.testIntegrity === false
      ? { testFilesAnalyzed: 0, errors: [] as Array<{ file: string; message: string }>, findings: [] as Awaited<ReturnType<typeof analyzeChangeSet>>['findings'] }
      : await analyzeChangeSet(changeSet);
    report.testFilesAnalyzed = integrity.testFilesAnalyzed;
    for (const e of integrity.errors) report.errors.push({ code: 'PARSE_ERROR', message: e.message, file: e.file });
    for (const f of integrity.findings) {
      const blocking = f.severity === 'error';
      (blocking ? report.blocking : report.disclosures).push({
        id: fingerprint(['test-integrity', f.check, f.file, f.message, (f.details ?? []).join('|')]),
        source: 'test-integrity',
        check: `ai-guard/test-integrity/${f.check}`,
        severity: f.severity,
        blocking,
        file: f.file,
        line: f.line,
        message: f.message,
        details: f.details,
      });
    }
  } catch (error) {
    report.success = false;
    report.errors.push({ code: 'TEST_INTEGRITY_FAILED', message: error instanceof Error ? error.message : String(error) });
  }

  // ── Agent config files the change touched ─────────────────────────────────
  for (const file of changeSet.files) {
    if (file.status === 'deleted') continue;
    const kind = classifyAgentConfigPath(file.path, root);
    if (!kind) continue;
    report.agentConfigFiles++;
    const after = readAfter(changeSet, file.path);
    if (after === null) continue;
    const before = file.status === 'added' || file.status === 'untracked' ? null : readBefore(changeSet, file.oldPath);
    const existing = new Map<string, number>();
    if (before !== null) {
      for (const f of scanAgentConfigText(file.oldPath, before, kind).findings) {
        const key = agentFindingKey(f);
        existing.set(key, (existing.get(key) ?? 0) + 1);
      }
    }
    for (const f of scanAgentConfigText(file.path, after, kind).findings) {
      const key = agentFindingKey(f);
      const remaining = existing.get(key) ?? 0;
      if (remaining > 0) {
        existing.set(key, remaining - 1);
        report.preExisting++;
        continue;
      }
      const blocking = f.severity === 'error';
      (blocking ? report.blocking : report.disclosures).push({
        id: fingerprint(['agent-config', f.check, file.path, f.message, f.excerpt]),
        source: 'agent-config',
        check: `ai-guard/agent-config/${f.check}`,
        severity: f.severity,
        blocking,
        file: file.path,
        line: f.line,
        message: f.excerpt ? `${f.message} (${f.excerpt})` : f.message,
      });
    }
  }

  // A file that could not be analyzed has not been verified.
  report.pass = report.success && report.blocking.length === 0 && report.errors.length === 0;
  report.durationMs = Date.now() - start;
  return report;
}

/** True when the finding's lines intersect lines the change added or deleted next to. */
export function isIntroduced(issue: Pick<IssueDetail, 'line' | 'endLine'>, touched: Set<number> | 'all'): boolean {
  if (touched === 'all') return true;
  const end = issue.endLine ?? issue.line;
  // Long spans (a whole function) only count when they start on a touched line.
  if (end - issue.line > 20) return touched.has(issue.line);
  for (let line = issue.line; line <= end; line++) if (touched.has(line)) return true;
  return false;
}

// ─── Text for agents and people ───────────────────────────────────────────────

function shortCheck(check: string): string {
  return check.replace(/^ai-guard\//, '');
}

function describe(finding: VerifyFinding): string {
  const details = finding.details?.length ? ` (${finding.details.join('; ')})` : '';
  return `${finding.file}:${finding.line} ${shortCheck(finding.check)}: ${finding.message}${details}`;
}

const LIST_LIMIT = 12;

/**
 * Instructions for an agent: what to fix and what to tell the user. `only` limits
 * the output to findings not yet reported (Stop hook).
 */
export function formatVerifyForAgent(report: VerifyReport, only?: Set<string>): string {
  const pick = (list: VerifyFinding[]): VerifyFinding[] => (only ? list.filter((f) => only.has(f.id)) : list);
  const blocking = pick(report.blocking);
  const disclosures = pick(report.disclosures);
  const lines: string[] = [];
  const scope = `${report.changedFiles} changed file${report.changedFiles === 1 ? '' : 's'} vs ${report.base}`;
  lines.push(`AI Guard verified this change (${scope}): ${blocking.length} issue${blocking.length === 1 ? '' : 's'} to fix, ${disclosures.length} to disclose.`);

  if (blocking.length > 0) {
    lines.push('', 'Fix before finishing:');
    blocking.slice(0, LIST_LIMIT).forEach((f, i) => {
      lines.push(`${i + 1}. ${describe(f)}`);
      if (f.remediation) lines.push(`   Fix: ${f.remediation}`);
    });
    if (blocking.length > LIST_LIMIT) lines.push(`... and ${blocking.length - LIST_LIMIT} more (run \`ai-guard verify\`).`);
  }
  if (disclosures.length > 0) {
    lines.push('', 'Tell the user about these in your final reply, or undo them:');
    for (const f of disclosures.slice(0, LIST_LIMIT)) lines.push(`- ${describe(f)}`);
    if (disclosures.length > LIST_LIMIT) lines.push(`- ... and ${disclosures.length - LIST_LIMIT} more`);
  }
  lines.push('', 'Fix the code rather than the tests. If a finding is a false positive, say which one and why in your reply instead of suppressing it.');
  return lines.join('\n');
}

/** One line for a person: what is still wrong with the change. */
export function formatVerifyForUser(report: VerifyReport, ids?: Set<string>): string {
  const items = [...report.blocking, ...report.disclosures].filter((f) => !ids || ids.has(f.id));
  const shown = items.slice(0, 4).map((f) => `${f.file}:${f.line} ${shortCheck(f.check)}`);
  const more = items.length > shown.length ? ` and ${items.length - shown.length} more` : '';
  return `AI Guard: the agent finished with ${items.length} unresolved issue${items.length === 1 ? '' : 's'} in this change: ${shown.join('; ')}${more}. Run \`ai-guard verify\` for details.`;
}
