/**
 * baseline.ts — shared baseline file format and matching.
 *
 * Used by `ai-guard baseline` (save/check) and `ai-guard changed --baseline`
 * (report only findings that are not already recorded in the baseline).
 *
 * Matching is count-based: a baseline entry suppresses exactly one current
 * finding with the same key. In `stable` mode the key is
 * `file::rule::message`, so two identical findings in one file need two
 * baseline entries — a second empty catch added next to a baselined one is
 * reported as new instead of being hidden by the first.
 */

import fs from 'fs';
import path from 'path';
import type { Preset, RunResult } from './eslint-runner.js';

export const BASELINE_FILE = '.ai-guard-baseline.json';

/**
 * Baseline file format version. Files without `version` were written before
 * versioning and are read as version 1; a newer version is rejected rather
 * than misread.
 */
export const BASELINE_VERSION = 1;

export interface BaselineIssue {
  ruleId: string;
  message: string;
  line: number;
  column: number;
}

export type BaselineMode = 'strict' | 'stable';

export interface BaselineEntry {
  filePath: string;
  issues: BaselineIssue[];
}

/** An integrity finding a team accepted explicitly with `ai-guard integrity --accept`. */
export interface IntegrityAcceptance {
  fingerprint: string;
  ruleId: string;
  file: string;
  message: string;
  acceptedAt: string;
}

export interface BaselineFile {
  /** File format version (see BASELINE_VERSION); absent in older files. */
  version?: number;
  createdAt: string;
  preset: Preset;
  mode: BaselineMode;
  totalIssues: number;
  entries: BaselineEntry[];
  /**
   * Explicit integrity acceptances. Never written by `baseline --save`, which
   * only preserves an existing section; see `ai-guard integrity --accept`.
   */
  integrity?: { accepted: IntegrityAcceptance[] };
}

export type LoadBaselineResult =
  | { status: 'missing' }
  /** `newerVersion`: written by a newer ai-guard — must not be overwritten. */
  | { status: 'invalid'; reason: string; newerVersion?: true }
  | { status: 'ok'; baseline: BaselineFile };

export interface BaselineFilterResult {
  /** The scan result with baselined findings removed (totals recomputed). */
  result: RunResult;
  /** Number of current findings matched by a baseline entry. */
  suppressed: number;
  /** Of those, findings matched to a baseline entry recorded under a file path that no longer exists (moved/renamed file). */
  movedMatches: number;
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

export function buildBaseline(result: RunResult, preset: Preset, mode: BaselineMode): BaselineFile {
  return {
    version: BASELINE_VERSION,
    createdAt: new Date().toISOString(),
    preset,
    mode,
    totalIssues: result.totalIssues,
    entries: result.files.map((f) => ({
      filePath: normalizePath(f.filePath),
      issues: f.issues.map((i) => ({
        ruleId: i.ruleId,
        message: i.message,
        line: i.line,
        column: i.column,
      })),
    })),
  };
}

export function writeBaseline(baselinePath: string, baseline: BaselineFile): void {
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
}

/**
 * Load and validate a baseline file. A file that exists but cannot be parsed
 * is reported as `invalid` — never treated as missing — so callers do not
 * silently overwrite it or fall back to reporting every finding.
 */
export function loadBaseline(baselinePath: string): LoadBaselineResult {
  if (!fs.existsSync(baselinePath)) return { status: 'missing' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  } catch (err) {
    return { status: 'invalid', reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }

  const reason = validateBaselineShape(parsed);
  if (reason) {
    const version = (parsed as { version?: unknown } | null)?.version;
    const newerVersion = typeof version === 'number' && Number.isInteger(version) && version > BASELINE_VERSION;
    return { status: 'invalid', reason, ...(newerVersion ? { newerVersion: true as const } : {}) };
  }

  const baseline = parsed as BaselineFile;
  // Baselines written before `mode` existed used exact (strict) matching.
  return { status: 'ok', baseline: { ...baseline, mode: baseline.mode ?? 'strict' } };
}

function validateBaselineShape(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'expected a JSON object';
  const { entries, mode, version, preset } = value as { entries?: unknown; mode?: unknown; version?: unknown; preset?: unknown };
  if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
    return `unknown "version" ${JSON.stringify(version)}`;
  }
  if (typeof version === 'number' && version > BASELINE_VERSION) {
    return `baseline format version ${version} is newer than this ai-guard supports (${BASELINE_VERSION}); upgrade eslint-plugin-ai-guard or re-create the baseline`;
  }
  if (preset !== undefined && !['recommended', 'strict', 'security', 'agent'].includes(preset as string)) {
    return `unknown preset ${JSON.stringify(preset)} (expected recommended, strict, security or agent)`;
  }
  if (mode !== undefined && mode !== 'strict' && mode !== 'stable') {
    return `unknown mode ${JSON.stringify(mode)} (expected "strict" or "stable")`;
  }
  if (!Array.isArray(entries)) return 'missing "entries" array';
  const integrity = (value as { integrity?: unknown }).integrity;
  if (integrity !== undefined) {
    const accepted = (integrity as { accepted?: unknown } | null)?.accepted;
    if (!Array.isArray(accepted)) return '"integrity.accepted" must be an array';
    for (const a of accepted as unknown[]) {
      const x = a as Partial<IntegrityAcceptance> | null;
      if (!x || typeof x.fingerprint !== 'string' || typeof x.ruleId !== 'string' || typeof x.file !== 'string') {
        return 'each "integrity.accepted" entry needs string "fingerprint", "ruleId" and "file"';
      }
    }
  }
  for (const entry of entries as unknown[]) {
    const e = entry as { filePath?: unknown; issues?: unknown };
    if (!e || typeof e.filePath !== 'string' || !Array.isArray(e.issues)) {
      return 'each entry needs a string "filePath" and an "issues" array';
    }
    for (const issue of e.issues as unknown[]) {
      const i = issue as Partial<BaselineIssue>;
      if (!i || typeof i.ruleId !== 'string' || typeof i.message !== 'string') {
        return `issue in ${e.filePath} needs string "ruleId" and "message"`;
      }
    }
  }
  return null;
}

export function resolveBaselinePath(cwd: string, file?: string): string {
  return path.resolve(cwd, file ?? BASELINE_FILE);
}

/**
 * Integrity acceptances from a baseline file. A missing file means no
 * acceptances; an invalid file is an error so acceptances are never silently
 * dropped (which would surface accepted findings) or invented.
 */
export function loadIntegrityAcceptances(baselinePath: string): { status: 'ok'; accepted: IntegrityAcceptance[] } | { status: 'invalid'; reason: string } {
  const loaded = loadBaseline(baselinePath);
  if (loaded.status === 'missing') return { status: 'ok', accepted: [] };
  if (loaded.status === 'invalid') return loaded;
  return { status: 'ok', accepted: loaded.baseline.integrity?.accepted ?? [] };
}

/**
 * Add acceptances to a baseline file (creating a minimal one if needed).
 * Returns how many fingerprints were newly added.
 */
export function addIntegrityAcceptances(
  baselinePath: string,
  findings: Array<{ fingerprint: string; ruleId: string; file: string; message: string }>,
  now: Date = new Date(),
): { added: number; total: number } {
  const loaded = loadBaseline(baselinePath);
  if (loaded.status === 'invalid') throw new Error(`Baseline file is invalid: ${loaded.reason}`);
  const baseline: BaselineFile = loaded.status === 'ok'
    ? loaded.baseline
    : { createdAt: now.toISOString(), preset: 'recommended', mode: 'stable', totalIssues: 0, entries: [] };
  const accepted = [...(baseline.integrity?.accepted ?? [])];
  const known = new Set(accepted.map((a) => a.fingerprint));
  let added = 0;
  for (const f of findings) {
    // The record of an acceptance can never be accepted, so it cannot be hidden.
    if (f.ruleId === 'ai-guard/integrity-acceptance-added') continue;
    if (known.has(f.fingerprint)) continue;
    known.add(f.fingerprint);
    accepted.push({ fingerprint: f.fingerprint, ruleId: f.ruleId, file: f.file, message: f.message, acceptedAt: now.toISOString() });
    added++;
  }
  accepted.sort((a, b) => a.file.localeCompare(b.file) || a.ruleId.localeCompare(b.ruleId) || a.fingerprint.localeCompare(b.fingerprint));
  writeBaseline(baselinePath, { ...baseline, integrity: { accepted } });
  return { added, total: accepted.length };
}

// ─── Matching ─────────────────────────────────────────────────────────────────

function normalizePath(filePath: string): string {
  // Forward slashes and no leading ./ so baselines written on Windows match
  // scans on Linux CI runners and vice versa.
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function issueKey(mode: BaselineMode, filePath: string, issue: BaselineIssue): string {
  const file = normalizePath(filePath);
  return mode === 'stable'
    ? `${file}::${issue.ruleId}::${issue.message}`
    : `${file}::${issue.ruleId}::${issue.line}::${issue.column}::${issue.message}`;
}

/** `fileName::rule::message` key used to re-match findings of a moved file. */
function movedKey(filePath: string, issue: BaselineIssue): string {
  return `${path.posix.basename(normalizePath(filePath))}::${issue.ruleId}::${issue.message}`;
}

export interface FilterOptions {
  /**
   * Whether a baseline file path still exists (paths are relative to the
   * scan's cwd). Entries of files that no longer exist can match findings in
   * other files by rule and message, so moving or renaming a file does not
   * turn its existing findings into new ones. Defaults to checking the disk.
   */
  fileExists?: (filePath: string) => boolean;
}

/**
 * Remove findings already recorded in the baseline. Each baseline entry
 * matches at most one current finding; surplus findings are new.
 *
 * Pass 1 matches by file + rule + message (+ line/column in strict mode).
 * Pass 2 lets the still-unused entries of files that no longer exist match
 * remaining findings by rule + message only (moved/renamed files).
 */
export function filterBaselinedIssues(
  result: RunResult,
  baseline: BaselineFile,
  options: FilterOptions = {},
): BaselineFilterResult {
  const mode = baseline.mode;
  const fileExists = options.fileExists ?? ((f: string) => fs.existsSync(path.resolve(f)));
  const remaining = new Map<string, number>();
  for (const entry of baseline.entries) {
    for (const issue of entry.issues) {
      const key = issueKey(mode, entry.filePath, issue);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
  }

  let suppressed = 0;
  const pending: Array<{ file: RunResult['files'][number]; unmatched: RunResult['files'][number]['issues'] }> = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  const ruleBreakdown = new Map<string, number>();
  const files: RunResult['files'] = [];

  for (const file of result.files) {
    // Match in source order so the outcome is deterministic; keep the
    // runner's output order for the findings that remain.
    const matched = new Set<(typeof file.issues)[number]>();
    const ordered = [...file.issues].sort((a, b) => a.line - b.line || a.column - b.column);
    for (const issue of ordered) {
      const key = issueKey(mode, file.filePath, issue);
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
        matched.add(issue);
      }
    }
    suppressed += matched.size;
    const unmatched = file.issues.filter((issue) => !matched.has(issue));
    if (unmatched.length > 0) pending.push({ file, unmatched });
  }

  // Pass 2: entries left over from files that no longer exist (moved files).
  // To never hide a genuinely new finding, a leftover entry may only match a
  // finding in a file whose path is NOT recorded in the baseline and whose
  // file name equals the vanished file's name (a move to another directory).
  // Findings in files the baseline already knows are never re-matched here.
  const orphaned = new Map<string, number>();
  const scanned = new Set(result.files.map((f) => normalizePath(f.filePath)));
  const baselinePaths = new Set(baseline.entries.map((e) => normalizePath(e.filePath)));
  for (const entry of baseline.entries) {
    if (scanned.has(normalizePath(entry.filePath)) || fileExists(entry.filePath)) continue;
    for (const issue of entry.issues) {
      const key = issueKey(mode, entry.filePath, issue);
      const left = remaining.get(key) ?? 0;
      if (left === 0) continue;
      remaining.set(key, left - 1);
      const mk = movedKey(entry.filePath, issue);
      orphaned.set(mk, (orphaned.get(mk) ?? 0) + 1);
    }
  }
  let movedMatches = 0;

  // Deterministic one-to-one matching: files by path, issues by position.
  pending.sort((a, b) => normalizePath(a.file.filePath).localeCompare(normalizePath(b.file.filePath)));
  for (const { file, unmatched } of pending) {
    const eligible = !baselinePaths.has(normalizePath(file.filePath));
    const ordered = [...unmatched].sort((a, b) => a.line - b.line || a.column - b.column);
    const movedHere = new Set<(typeof unmatched)[number]>();
    if (eligible) {
      for (const issue of ordered) {
        const mk = movedKey(file.filePath, issue);
        const count = orphaned.get(mk) ?? 0;
        if (count === 0) continue;
        orphaned.set(mk, count - 1);
        movedHere.add(issue);
      }
    }
    movedMatches += movedHere.size;
    const newIssues = unmatched.filter((issue) => !movedHere.has(issue));
    suppressed += unmatched.length - newIssues.length;
    if (newIssues.length === 0) continue;

    const errorCount = newIssues.filter((i) => i.severity === 2).length;
    const warningCount = newIssues.filter((i) => i.severity === 1).length;
    totalErrors += errorCount;
    totalWarnings += warningCount;
    for (const issue of newIssues) {
      ruleBreakdown.set(issue.ruleId, (ruleBreakdown.get(issue.ruleId) ?? 0) + 1);
    }
    files.push({ ...file, issues: newIssues, errorCount, warningCount });
  }

  const topFiles = [...files]
    .sort((a, b) => b.issues.length - a.issues.length)
    .slice(0, 10)
    .map((f) => ({ path: f.filePath, count: f.issues.length }));

  return {
    result: {
      ...result,
      files,
      totalErrors,
      totalWarnings,
      totalIssues: totalErrors + totalWarnings,
      ruleBreakdown,
      topFiles,
    },
    suppressed,
    movedMatches,
  };
}
