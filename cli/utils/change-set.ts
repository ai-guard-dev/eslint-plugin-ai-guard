/**
 * change-set.ts — what a change did, file by file, with before/after content.
 *
 * Shared by test-integrity analysis, `ai-guard verify`, the Claude Code Stop
 * hook and the MCP verify_change tool. Unlike git-diff.ts (which only lists
 * paths to lint), a change set keeps deletions and renames, can read each
 * file as it was at the base, and knows which lines the change added.
 *
 * Comparisons always run against the working tree (or the index with
 * `staged`), so uncommitted edits by an agent are included. Git failures
 * throw; callers never get a silently different base.
 */

import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedPath {
  /** Repository-relative POSIX path in the working tree (for deletions: the deleted path). */
  path: string;
  /** Path at the base (differs from `path` for renames). */
  oldPath: string;
  status: ChangeStatus;
}

export interface ChangeSet {
  /** Absolute repository root. */
  root: string;
  /** Commit compared against, or null when the repository has no commits yet. */
  baseCommit: string | null;
  /** Human-readable description of the base, e.g. "HEAD" or "main (merge-base 1a2b3c4)". */
  baseLabel: string;
  mode: 'uncommitted' | 'staged' | 'base';
  files: ChangedPath[];
}

export interface ChangeSetOptions {
  cwd: string;
  /** Branch or ref to compare with, through its merge-base with HEAD (PR mode). */
  base?: string;
  /** Exact commit to compare with (e.g. recorded when an agent session started). */
  baseCommit?: string;
  /** Compare the index instead of the working tree. */
  staged?: boolean;
}

/** SHA-1 of the empty tree, for repositories without commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/~^-]*$/;
const SAFE_COMMIT = /^[0-9a-f]{7,64}$/i;

function git(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string {
  return childProcess.execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer, shell: false,
  });
}

function tryGit(args: string[], cwd: string, maxBuffer?: number): string | null {
  try {
    return git(args, cwd, maxBuffer);
  } catch {
    return null;
  }
}

export function isSafeGitRef(ref: string): boolean {
  return ref.length <= 256 && SAFE_REF.test(ref) && !ref.includes('..') && !ref.includes('//');
}

function resolveCommit(ref: string, cwd: string): string | null {
  return tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd)?.trim() || null;
}

/** A tree object, such as the working-tree snapshot a session records at start. */
function resolveTree(ref: string, cwd: string): string | null {
  return tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{tree}`], cwd)?.trim() || null;
}

function parseNameStatus(output: string): ChangedPath[] {
  const tokens = output.split('\0');
  const files: ChangedPath[] = [];
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i];
    if (!status) {
      i++;
      continue;
    }
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      files.push({ path: newPath, oldPath: letter === 'R' ? oldPath : newPath, status: letter === 'R' ? 'renamed' : 'added' });
      i += 3;
      continue;
    }
    const file = tokens[i + 1];
    const mapped: ChangeStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    files.push({ path: file, oldPath: file, status: mapped });
    i += 2;
  }
  return files;
}

/** Computes the change set. Throws on Git errors or an unresolvable base. */
export function getChangeSet(options: ChangeSetOptions): ChangeSet {
  const root = path.resolve(git(['rev-parse', '--show-toplevel'], options.cwd).trim());
  const head = resolveCommit('HEAD', root);
  let baseCommit: string | null;
  let baseLabel: string;
  let mode: ChangeSet['mode'];

  if (options.base !== undefined && options.staged) throw new Error('base and staged cannot be combined');

  if (options.baseCommit !== undefined) {
    if (!SAFE_COMMIT.test(options.baseCommit)) throw new Error('Invalid commit');
    const commit = resolveCommit(options.baseCommit, root) ?? resolveTree(options.baseCommit, root);
    if (!commit) throw new Error(`Unknown commit ${options.baseCommit}`);
    baseCommit = commit;
    baseLabel = `session start (${commit.slice(0, 7)})`;
    mode = 'base';
  } else if (options.base !== undefined) {
    if (!isSafeGitRef(options.base)) throw new Error('Invalid Git ref');
    const candidates = options.base.includes('/') ? [options.base] : [`origin/${options.base}`, options.base];
    const commit = candidates.map((c) => resolveCommit(c, root)).find((c): c is string => c !== null);
    if (!commit) throw new Error(`Cannot resolve ${options.base}. In CI, fetch the base branch (fetch-depth: 0).`);
    if (!head) throw new Error('HEAD has no commits to compare');
    const mergeBase = tryGit(['merge-base', 'HEAD', commit], root)?.trim();
    if (!mergeBase) throw new Error(`No merge-base between HEAD and ${options.base}. A shallow clone needs fetch-depth: 0.`);
    baseCommit = mergeBase;
    baseLabel = `${options.base} (merge-base ${mergeBase.slice(0, 7)})`;
    mode = 'base';
  } else {
    baseCommit = head;
    baseLabel = head ? 'HEAD' : 'empty repository';
    mode = options.staged ? 'staged' : 'uncommitted';
  }

  const against = baseCommit ?? EMPTY_TREE;
  const diffArgs = ['diff', '--name-status', '-z', '-M', ...(options.staged ? ['--cached'] : []), against, '--'];
  const files = parseNameStatus(git(diffArgs, root));

  if (!options.staged) {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], root);
    for (const file of untracked.split('\0').filter(Boolean)) {
      files.push({ path: file, oldPath: file, status: 'untracked' });
    }
  }
  return { root, baseCommit, baseLabel, mode, files };
}

/** The same change set, limited to files inside `scope` (an absolute directory). */
export function scopeChangeSet(changeSet: ChangeSet, scope: string): ChangeSet {
  const dir = path.resolve(scope);
  return {
    ...changeSet,
    files: changeSet.files.filter((f) => {
      const relative = path.relative(dir, path.join(changeSet.root, f.path));
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    }),
  };
}

/** File content at the base, or null if it did not exist there. */
export function readBefore(changeSet: ChangeSet, oldPath: string): string | null {
  if (!changeSet.baseCommit) return null;
  return tryGit(['show', `${changeSet.baseCommit}:${oldPath}`], changeSet.root, 16 * 1024 * 1024);
}

/** File content after the change (working tree, or index for staged mode), or null if deleted. */
export function readAfter(changeSet: ChangeSet, file: string): string | null {
  if (changeSet.mode === 'staged') return tryGit(['show', `:${file}`], changeSet.root, 16 * 1024 * 1024);
  try {
    return fs.readFileSync(path.join(changeSet.root, file), 'utf8');
  } catch {
    return null;
  }
}

export interface LineChanges {
  /** Line numbers (in the new file) added or modified by the change; 'all' for new files. */
  added: Set<number> | 'all';
  /**
   * Added lines plus the lines next to deletions. Deleting the body of a catch block
   * leaves its `} catch (e) {` line unchanged, but the change created the empty catch.
   */
  touched: Set<number> | 'all';
  /** Text of added lines, keyed by line number (absent for 'all'). */
  addedText: Map<number, string>;
  /** Text of removed lines. */
  removedText: string[];
}

/**
 * Added and removed lines for every changed file, from one `git diff -U0`.
 * New and untracked files have `added: 'all'`.
 */
export function getLineChanges(changeSet: ChangeSet, paths?: string[]): Map<string, LineChanges> {
  const result = new Map<string, LineChanges>();
  const wanted = paths ? new Set(paths) : null;
  const tracked: ChangedPath[] = [];
  for (const file of changeSet.files) {
    if (wanted && !wanted.has(file.path)) continue;
    if (file.status === 'added' || file.status === 'untracked') {
      result.set(file.path, { added: 'all', touched: 'all', addedText: new Map(), removedText: [] });
    } else {
      tracked.push(file);
    }
  }
  if (tracked.length === 0) return result;

  const pathspecs = [...new Set(tracked.flatMap((f) => (f.status === 'renamed' ? [f.oldPath, f.path] : [f.path])))];
  const against = changeSet.baseCommit ?? EMPTY_TREE;
  const output = tryGit(
    ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', ...(changeSet.mode === 'staged' ? ['--cached'] : []), against, '--', ...pathspecs],
    changeSet.root,
  ) ?? '';

  let current: LineChanges | null = null;
  let newLine = 0;
  // File headers (---/+++) only appear between "diff --git" and the first hunk; inside
  // hunks, a line such as "+++ x" is an added line whose text starts with "++ ".
  let inHeader = false;
  for (const raw of output.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      current = null;
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4).replace(/^b\//, '');
        current = target === '/dev/null' ? null : { added: new Set<number>(), touched: new Set<number>(), addedText: new Map(), removedText: [] };
        if (current) result.set(target, current);
        continue;
      }
      if (!line.startsWith('@@')) continue;
      inHeader = false;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      // A pure deletion (+c,0) removed lines after new line c: mark both neighbours.
      if (current && hunk[2] === '0') {
        (current.touched as Set<number>).add(Math.max(1, newLine));
        (current.touched as Set<number>).add(newLine + 1);
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      (current.added as Set<number>).add(newLine);
      (current.touched as Set<number>).add(newLine);
      current.addedText.set(newLine, line.slice(1));
      newLine++;
    } else if (line.startsWith('-')) {
      current.removedText.push(line.slice(1));
    }
  }
  for (const file of tracked) {
    if (!result.has(file.path)) result.set(file.path, { added: new Set(), touched: new Set(), addedText: new Map(), removedText: [] });
  }
  return result;
}
