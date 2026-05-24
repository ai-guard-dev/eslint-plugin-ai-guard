/**
 * git-diff.ts — detect changed files for PR/staged scanning.
 *
 * Priority order for changed-file detection:
 *  1. GITHUB_BASE_REF set (PR context) → git diff origin/$base...HEAD
 *  2. --staged flag → git diff --cached
 *  3. Default → git diff HEAD (uncommitted changes vs last commit)
 *  4. Fallback: git unavailable or no changes → returns [] (caller falls back to full scan)
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChangedFilesOptions {
  /** Scan only staged (git add'd) files */
  staged?: boolean;
  /** Compare against this base branch (e.g. "origin/main") — for PR diff */
  base?: string;
  /** Working directory for git commands */
  cwd?: string;
  /** Only return files matching these extensions */
  extensions?: string[];
  /** Filter to files under this subdirectory (monorepo support) */
  workingDirectory?: string;
}

export interface ChangedFilesResult {
  files: string[];
  mode: 'pr-diff' | 'staged' | 'uncommitted' | 'fallback';
  base?: string;
  totalDetected: number;
  filteredOut: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];

const IGNORE_PREFIXES = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'out/',
  'coverage/',
  '.cache/',
  '.turbo/',
  '.nx/',
  'vendor/',
  'tmp/',
  'temp/',
  '__generated__/',
  'generated/',
  'storybook-static/',
  '.expo/',
  '.svelte-kit/',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runGit(args: string, cwd: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function isGitAvailable(cwd: string): boolean {
  return runGit('rev-parse --is-inside-work-tree', cwd) === 'true';
}

function filterFiles(
  rawFiles: string[],
  extensions: string[],
  workingDirectory: string | undefined,
  cwd: string,
): { kept: string[]; dropped: number } {
  let dropped = 0;
  const kept: string[] = [];

  for (const rel of rawFiles) {
    // Extension filter
    const ext = path.extname(rel).toLowerCase();
    if (!extensions.includes(ext)) {
      dropped++;
      continue;
    }

    // Ignore prefix filter
    const normalized = rel.replace(/\\/g, '/');
    if (IGNORE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      dropped++;
      continue;
    }

    // Working directory filter (monorepo subdirectory scoping)
    if (workingDirectory) {
      const wdNorm = workingDirectory.replace(/\\/g, '/').replace(/\/$/, '');
      if (!normalized.startsWith(wdNorm + '/') && normalized !== wdNorm) {
        dropped++;
        continue;
      }
    }

    // Ensure file still exists (may have been deleted)
    const abs = path.resolve(cwd, rel);
    if (!fs.existsSync(abs)) {
      dropped++;
      continue;
    }

    kept.push(abs);
  }

  return { kept, dropped };
}

function parseFileList(output: string): string[] {
  return output
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

// ─── Core detection ───────────────────────────────────────────────────────────

/**
 * Detect changed files for targeted scanning.
 *
 * Returns absolute paths to scannable files. Empty array means:
 * - git not available, OR
 * - no relevant files changed → caller should fall back to full scan
 */
export function getChangedFiles(
  options: ChangedFilesOptions = {},
): ChangedFilesResult {
  const {
    staged = false,
    base,
    cwd = process.cwd(),
    extensions = DEFAULT_EXTENSIONS,
    workingDirectory,
  } = options;

  // Determine effective base from env (GitHub Actions) or option
  const effectiveBase = base ?? process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF ?? ''}`
    : undefined;

  if (!isGitAvailable(cwd)) {
    return { files: [], mode: 'fallback', totalDetected: 0, filteredOut: 0 };
  }

  let rawOutput: string | null = null;
  let mode: ChangedFilesResult['mode'];
  let usedBase: string | undefined;

  if (effectiveBase && !staged) {
    // PR diff: files changed between base branch and HEAD
    // Try merge-base first for cleaner diff (avoids including base branch commits)
    const mergeBase = runGit(`merge-base HEAD ${effectiveBase}`, cwd);
    if (mergeBase) {
      rawOutput = runGit(`diff --name-only --diff-filter=ACMRT ${mergeBase}...HEAD`, cwd);
    }
    if (!rawOutput) {
      rawOutput = runGit(`diff --name-only --diff-filter=ACMRT ${effectiveBase}`, cwd);
    }
    mode = 'pr-diff';
    usedBase = effectiveBase;
  } else if (staged) {
    // Only staged files
    rawOutput = runGit('diff --name-only --cached --diff-filter=ACMRT', cwd);
    mode = 'staged';
  } else {
    // Uncommitted working tree changes vs HEAD
    // Include both staged and unstaged
    const staged_ = runGit('diff --name-only --cached --diff-filter=ACMRT', cwd) ?? '';
    const unstaged = runGit('diff --name-only --diff-filter=ACMRT', cwd) ?? '';
    const combined = new Set([...parseFileList(staged_), ...parseFileList(unstaged)]);
    rawOutput = [...combined].join('\n');
    mode = 'uncommitted';
  }

  if (!rawOutput) {
    return { files: [], mode, base: usedBase, totalDetected: 0, filteredOut: 0 };
  }

  const rawFiles = parseFileList(rawOutput);
  const { kept, dropped } = filterFiles(rawFiles, extensions, workingDirectory, cwd);

  return {
    files: kept,
    mode,
    base: usedBase,
    totalDetected: rawFiles.length,
    filteredOut: dropped,
  };
}

/**
 * Returns true if running in GitHub Actions environment.
 */
export function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Returns the GitHub base ref for PR scanning, if available.
 * e.g. "main" or "develop"
 */
export function getGitHubBaseRef(): string | undefined {
  return process.env.GITHUB_BASE_REF || undefined;
}

/**
 * Returns the GitHub step summary file path, if available.
 */
export function getGitHubSummaryPath(): string | undefined {
  return process.env.GITHUB_STEP_SUMMARY || undefined;
}
