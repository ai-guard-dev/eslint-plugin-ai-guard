/**
 * git-diff.ts — Production-grade changed-file detection for PR/staged scanning.
 *
 * Priority order for changed-file detection:
 *  1. GITHUB_BASE_REF / --base set → multi-strategy PR diff (see tryPrDiff)
 *  2. --staged → git diff --cached
 *  3. Default → uncommitted changes (staged + unstaged vs HEAD)
 *  4. Fallback → git unavailable or no changes (caller falls back to full scan)
 *
 * === BUG HISTORY ===
 * Phase 2A had two stacked bugs that caused PR diff to silently return 0 files:
 *
 * Bug 1 — Operator precedence:
 *   const effectiveBase = base ?? env ? `origin/${env}` : undefined;
 *   Parsed as: (base ?? env) ? `origin/${env}` : undefined
 *   → When base="origin/main" was passed in, effectiveBase became "origin/"
 *
 * Bug 2 — Double origin/ prefix:
 *   changed.ts prepended `origin/` to baseRef, then git-diff.ts also added `origin/`
 *   → git merge-base HEAD origin/origin/main → always fails silently
 *
 * Both are fixed in Phase 2B.
 */

// Use require for child_process so vi.spyOn(require('child_process'), 'execFileSync') works in tests
const childProcess = require('child_process');
import path from 'path';
import fs from 'fs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChangedFilesOptions {
  /** Scan only staged (git add'd) files */
  staged?: boolean;
  /** Base branch name to diff against — raw name like "main" or "develop".
   *  Do NOT pre-prefix with "origin/". This function handles normalization. */
  base?: string;
  /** Working directory for git commands */
  cwd?: string;
  /** Only return files matching these extensions */
  extensions?: string[];
  /** Filter to files under this subdirectory (monorepo support) */
  workingDirectory?: string;
  /** Enable verbose git debug output */
  debug?: boolean;
}

export interface GitDiffDebugInfo {
  /** The raw base ref used (after normalization) */
  resolvedBase?: string;
  /** The merge-base commit SHA (if resolved) */
  mergeBase?: string;
  /** Strategies attempted in order */
  strategiesAttempted: string[];
  /** Which strategy succeeded (or null if none) */
  strategySucceeded: string | null;
  /** Whether the repo is a shallow clone */
  isShallowClone: boolean;
  /** Whether HEAD is detached */
  isDetachedHead: boolean;
  /** Raw file count before filtering */
  rawFileCount: number;
  /** Files dropped by extension filter */
  droppedByExtension: number;
  /** Files dropped by ignore-prefix filter */
  droppedByIgnore: number;
  /** Files dropped because they don't exist on disk */
  droppedMissing: number;
  /** Files dropped by working-directory filter */
  droppedByWorkingDir: number;
}

export interface ChangedFilesResult {
  files: string[];
  mode: 'pr-diff' | 'staged' | 'uncommitted' | 'fallback';
  base?: string;
  totalDetected: number;
  filteredOut: number;
  /** Diagnostic information — always present, useful for --debug-git */
  debugInfo: GitDiffDebugInfo;
  /** Human-readable reason when files.length === 0 and mode !== 'fallback' */
  zeroFilesReason?: string;
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

// ─── Low-level git runner ─────────────────────────────────────────────────────

function runGit(args: readonly string[], cwd: string): string | null {
  try {
    return childProcess.execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      shell: false,
    }).trim();
  } catch {
    return null;
  }
}

function isGitAvailable(cwd: string): boolean {
  return runGit(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
}

function isShallowClone(cwd: string): boolean {
  return runGit(['rev-parse', '--is-shallow-repository'], cwd) === 'true';
}

function isDetachedHead(cwd: string): boolean {
  const result = runGit(['symbolic-ref', '--quiet', 'HEAD'], cwd);
  return result === null;
}

/**
 * Detect the default upstream branch (e.g., "main", "master", "develop").
 * Used when no base branch is specified or detectable.
 */
function detectDefaultBranch(cwd: string): string | null {
  // Try origin/HEAD (most reliable)
  const symbolic = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
  if (symbolic) {
    const match = /refs\/remotes\/origin\/(.+)$/.exec(symbolic);
    if (match) return match[1];
  }

  // Try common branch names
  for (const candidate of ['main', 'master', 'develop', 'development']) {
    const check = runGit(['rev-parse', '--verify', `origin/${candidate}`], cwd);
    if (check) return candidate;
    const checkLocal = runGit(['rev-parse', '--verify', candidate], cwd);
    if (checkLocal) return candidate;
  }

  return null;
}

// ─── Ref normalization ────────────────────────────────────────────────────────

/**
 * Normalize a base branch name to a form usable in git diff.
 * Strips leading "origin/" — the caller decides whether to use local or remote ref.
 * Returns the raw branch name (e.g. "main", "develop").
 */
function normalizeBranchName(ref: string): string {
  return ref.replace(/^origin\//, '').trim();
}

// ─── PR diff strategies ───────────────────────────────────────────────────────

interface DiffResult {
  output: string;
  strategy: string;
  mergeBase?: string;
}

/**
 * Try multiple strategies to get the PR diff.
 * Returns on first success. Never throws.
 *
 * Strategy order:
 *  1. merge-base with origin/branch (most accurate for GitHub Actions)
 *  2. merge-base with local branch ref (works locally)
 *  3. Direct diff with origin/branch (fallback for detached HEAD)
 *  4. Direct diff with local branch (further fallback)
 *  5. HEAD~1 (last-commit fallback — shallow clones, initial PRs)
 */
function tryPrDiff(
  branch: string,
  cwd: string,
  debugInfo: GitDiffDebugInfo,
): DiffResult | null {
  const rawBranch = normalizeBranchName(branch);

  // Strategy 1: merge-base with origin/branch
  {
    const strategy = `merge-base HEAD origin/${rawBranch}`;
    debugInfo.strategiesAttempted.push(strategy);
    const mergeBase = runGit(['merge-base', 'HEAD', `origin/${rawBranch}`], cwd);
    if (mergeBase) {
      debugInfo.mergeBase = mergeBase;
      const out = runGit(['diff', '--name-only', '--diff-filter=ACMRT', mergeBase], cwd);
      if (out !== null) {
        debugInfo.strategySucceeded = strategy;
        return { output: out, strategy, mergeBase };
      }
    }
  }

  // Strategy 2: merge-base with local branch
  {
    const strategy = `merge-base HEAD ${rawBranch}`;
    debugInfo.strategiesAttempted.push(strategy);
    const mergeBase = runGit(['merge-base', 'HEAD', rawBranch], cwd);
    if (mergeBase) {
      if (!debugInfo.mergeBase) debugInfo.mergeBase = mergeBase;
      const out = runGit(`diff --name-only --diff-filter=ACMRT ${mergeBase}`, cwd);
      if (out !== null) {
        debugInfo.strategySucceeded = strategy;
        return { output: out, strategy, mergeBase };
      }
    }
  }

  // Strategy 3: direct diff with origin/branch
  {
    const strategy = `diff origin/${rawBranch}...HEAD`;
    debugInfo.strategiesAttempted.push(strategy);
    const out = runGit(['diff', '--name-only', '--diff-filter=ACMRT', `origin/${rawBranch}...HEAD`], cwd);
    if (out !== null) {
      debugInfo.strategySucceeded = strategy;
      return { output: out, strategy };
    }
  }

  // Strategy 4: direct diff with local branch
  {
    const strategy = `diff ${rawBranch}...HEAD`;
    debugInfo.strategiesAttempted.push(strategy);
    const out = runGit(['diff', '--name-only', '--diff-filter=ACMRT', `${rawBranch}...HEAD`], cwd);
    if (out !== null) {
      debugInfo.strategySucceeded = strategy;
      return { output: out, strategy };
    }
  }

  // Strategy 5: HEAD~1 (last commit only — shallow clone safety net)
  {
    const strategy = 'diff HEAD~1 (shallow fallback)';
    debugInfo.strategiesAttempted.push(strategy);
    const out = runGit(['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD~1'], cwd);
    if (out !== null) {
      debugInfo.strategySucceeded = strategy;
      return { output: out, strategy };
    }
  }

  debugInfo.strategySucceeded = null;
  return null;
}

// ─── File filtering ───────────────────────────────────────────────────────────

function filterFiles(
  rawFiles: string[],
  extensions: string[],
  workingDirectory: string | undefined,
  cwd: string,
  debugInfo: GitDiffDebugInfo,
): string[] {
  const kept: string[] = [];

  for (const rel of rawFiles) {
    // Normalize to POSIX separators for consistent matching
    const normalized = rel.replace(/\\/g, '/').trim();
    if (!normalized) continue;

    // Extension filter
    const ext = path.extname(normalized).toLowerCase();
    if (!extensions.includes(ext)) {
      debugInfo.droppedByExtension++;
      continue;
    }

    // Ignore prefix filter
    if (IGNORE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      debugInfo.droppedByIgnore++;
      continue;
    }

    // Working directory filter (monorepo subdirectory scoping)
    if (workingDirectory) {
      const wdNorm = workingDirectory.replace(/\\/g, '/').replace(/\/$/, '');
      if (!normalized.startsWith(wdNorm + '/') && normalized !== wdNorm) {
        debugInfo.droppedByWorkingDir++;
        continue;
      }
    }

    // Ensure file still exists on disk (may have been deleted in the PR)
    const abs = path.resolve(cwd, normalized);
    if (!fs.existsSync(abs)) {
      debugInfo.droppedMissing++;
      continue;
    }

    kept.push(abs);
  }

  return kept;
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
 * Returns absolute paths to scannable files. When files is empty:
 * - Check mode: 'fallback' means git was unavailable → caller should do full scan
 * - Check zeroFilesReason for a human-readable explanation
 * - Check debugInfo.strategiesAttempted to see what was tried
 *
 * IMPORTANT: Pass raw branch names (e.g., "main"), NOT pre-prefixed refs.
 * This function handles all ref normalization internally.
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
    debug = false,
  } = options;

  const debugInfo: GitDiffDebugInfo = {
    strategiesAttempted: [],
    strategySucceeded: null,
    isShallowClone: false,
    isDetachedHead: false,
    rawFileCount: 0,
    droppedByExtension: 0,
    droppedByIgnore: 0,
    droppedMissing: 0,
    droppedByWorkingDir: 0,
  };

  if (!isGitAvailable(cwd)) {
    return {
      files: [],
      mode: 'fallback',
      totalDetected: 0,
      filteredOut: 0,
      debugInfo,
      zeroFilesReason: 'Git is not available in this directory. Run inside a git repository.',
    };
  }

  // Populate git state diagnostics
  debugInfo.isShallowClone = isShallowClone(cwd);
  debugInfo.isDetachedHead = isDetachedHead(cwd);

  // ── Resolve base branch ───────────────────────────────────────────────────
  // FIX: Explicitly separate env-based base from option-based base.
  // Never concatenate them — that was the source of the double-prefix bug.
  const envBase = process.env.GITHUB_BASE_REF
    ? normalizeBranchName(process.env.GITHUB_BASE_REF)
    : undefined;

  // Option `base` takes priority over env, then env, then auto-detect
  const resolvedBranch: string | undefined = base
    ? normalizeBranchName(base)
    : envBase;

  debugInfo.resolvedBase = resolvedBranch;

  let rawOutput: string | null = null;
  let mode: ChangedFilesResult['mode'];
  let usedBase: string | undefined;
  let zeroFilesReason: string | undefined;

  if (staged) {
    // ── Staged mode ─────────────────────────────────────────────────────────
    rawOutput = runGit(['diff', '--name-only', '--cached', '--diff-filter=ACMRT'], cwd);
    mode = 'staged';
    debugInfo.strategiesAttempted.push('git diff --cached');
    if (rawOutput !== null) debugInfo.strategySucceeded = 'git diff --cached';
    if (!rawOutput) {
      zeroFilesReason = 'No staged files found. Run `git add <files>` before using --staged.';
    }
  } else if (resolvedBranch) {
    // ── PR diff mode ─────────────────────────────────────────────────────────
    mode = 'pr-diff';
    usedBase = resolvedBranch;

    const diffResult = tryPrDiff(resolvedBranch, cwd, debugInfo);

    if (diffResult) {
      rawOutput = diffResult.output;
    } else {
      // All strategies failed
      const shallow = debugInfo.isShallowClone
        ? ' Shallow clone detected — try fetch-depth: 0 in your workflow.'
        : '';
      const detached = debugInfo.isDetachedHead
        ? ' HEAD is detached — ensure checkout fetches the branch.'
        : '';
      zeroFilesReason =
        `PR diff failed against "${resolvedBranch}". ` +
        `Tried: ${debugInfo.strategiesAttempted.join(', ')}.${shallow}${detached} ` +
        `Run with --debug-git for full diagnosis.`;
    }
  } else {
    // ── Uncommitted changes mode ─────────────────────────────────────────────
    mode = 'uncommitted';
    const staged_ = runGit(['diff', '--name-only', '--cached', '--diff-filter=ACMRT'], cwd) ?? '';
    const unstaged = runGit(['diff', '--name-only', '--diff-filter=ACMRT'], cwd) ?? '';
    debugInfo.strategiesAttempted.push('git diff --cached', 'git diff (unstaged)');
    const combined = new Set([...parseFileList(staged_), ...parseFileList(unstaged)]);
    rawOutput = [...combined].join('\n');
    if (rawOutput) debugInfo.strategySucceeded = 'uncommitted changes';
    if (!rawOutput) {
      zeroFilesReason =
        'No uncommitted changes found. ' +
        'Use --pr to scan PR changes, or --staged for staged files.';
    }
  }

  if (!rawOutput) {
    return {
      files: [],
      mode,
      base: usedBase,
      totalDetected: 0,
      filteredOut: 0,
      debugInfo,
      zeroFilesReason,
    };
  }

  const rawFiles = parseFileList(rawOutput);
  debugInfo.rawFileCount = rawFiles.length;

  const kept = filterFiles(rawFiles, extensions, workingDirectory, cwd, debugInfo);
  const dropped =
    debugInfo.droppedByExtension +
    debugInfo.droppedByIgnore +
    debugInfo.droppedByWorkingDir +
    debugInfo.droppedMissing;

  if (kept.length === 0 && rawFiles.length > 0) {
    zeroFilesReason =
      `${rawFiles.length} changed file${rawFiles.length !== 1 ? 's' : ''} detected but all filtered out. ` +
      `Extension filter: ${debugInfo.droppedByExtension}, ` +
      `ignored paths: ${debugInfo.droppedByIgnore}, ` +
      `missing from disk: ${debugInfo.droppedMissing}.`;
  }

  return {
    files: kept,
    mode,
    base: usedBase,
    totalDetected: rawFiles.length,
    filteredOut: dropped,
    debugInfo,
    zeroFilesReason: kept.length === 0 ? zeroFilesReason : undefined,
  };
}

// ─── Environment helpers ──────────────────────────────────────────────────────

/** Returns true if running in GitHub Actions environment. */
export function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

/** Returns the GitHub base ref for PR scanning, if available (e.g. "main"). */
export function getGitHubBaseRef(): string | undefined {
  return process.env.GITHUB_BASE_REF || undefined;
}

/** Returns the GitHub step summary file path, if available. */
export function getGitHubSummaryPath(): string | undefined {
  return process.env.GITHUB_STEP_SUMMARY || undefined;
}

/** Returns the GitHub output file path, if available. */
export function getGitHubOutputPath(): string | undefined {
  return process.env.GITHUB_OUTPUT || undefined;
}