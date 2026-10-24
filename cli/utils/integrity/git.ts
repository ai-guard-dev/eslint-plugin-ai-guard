/**
 * Git access for integrity analysis.
 *
 * Every call uses execFileSync with an argument array (no shell), validated
 * refs, NUL-delimited path lists and bounded output, so file names with
 * spaces or shell metacharacters are safe and nothing is interpolated.
 */

// Use require so tests can spy on execFileSync like git-diff.ts does.
const childProcess = require('child_process');
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IntegrityBaseInfo } from './types.js';

export class IntegrityGitError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IntegrityGitError';
  }
}

/** Files larger than this are skipped (reported as an analysis error). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/~^@{}-]*$/;

export function isSafeRef(ref: string): boolean {
  return ref.length <= 256 && REF_PATTERN.test(ref) && !ref.includes('..') && !ref.startsWith('-');
}

function git(args: string[], cwd: string, opts: { input?: string; maxBuffer?: number } = {}): string {
  try {
    return childProcess.execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      input: opts.input,
      timeout: 30000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new IntegrityGitError('GIT_UNAVAILABLE', 'Git is not installed or not on PATH');
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim().split('\n')[0] : '';
    throw new IntegrityGitError('GIT_FAILED', stderr || e.message);
  }
}

function tryGit(args: string[], cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}

export interface ResolvedBase extends IntegrityBaseInfo {
  repoRoot: string;
  /** Tree-ish to diff against (commit SHA or the empty tree). */
  treeish: string;
}

export interface ResolveBaseOptions {
  cwd: string;
  /** Ref to compare with. Omit for HEAD (uncommitted changes). */
  base?: string;
  /** Compare with merge-base(HEAD, base) instead of base itself (PR semantics). */
  mergeBase?: boolean;
  /** Also try `origin/<base>` first, like `ai-guard changed` resolves branch names. */
  preferRemote?: boolean;
  /** Compare the index (staged content) instead of the working tree. */
  staged?: boolean;
}

export function repoRootOf(cwd: string): string {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd).trim();
  } catch (err) {
    if (err instanceof IntegrityGitError && err.code === 'GIT_UNAVAILABLE') throw err;
    throw new IntegrityGitError('NOT_A_REPO', 'Not inside a Git repository');
  }
}

function emptyTree(root: string): string {
  return git(['hash-object', '-t', 'tree', '--stdin'], root, { input: '' }).trim();
}

function verifyCommit(ref: string, root: string): string | null {
  const out = tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root);
  return out ? out.trim() : null;
}

/** Resolve the base revision to compare against. Throws IntegrityGitError with an actionable message. */
export function resolveBase(options: ResolveBaseOptions): ResolvedBase {
  const repoRoot = repoRootOf(options.cwd);
  const head = options.staged ? 'index' : 'working-tree';

  if (options.base === undefined || options.base === 'HEAD') {
    const commit = verifyCommit('HEAD', repoRoot);
    if (!commit) {
      if (options.base === 'HEAD') {
        throw new IntegrityGitError('BASE_NOT_FOUND', 'HEAD does not exist yet (no commits); omit --base to compare with the empty tree');
      }
      return { ref: '(empty tree)', commit: null, head, repoRoot, treeish: emptyTree(repoRoot) };
    }
    return { ref: 'HEAD', commit, head, repoRoot, treeish: commit };
  }

  if (!isSafeRef(options.base)) {
    throw new IntegrityGitError('INVALID_REF', `Invalid Git ref: ${JSON.stringify(options.base)} (expected a single ref, without options or ranges)`);
  }
  const candidates = options.preferRemote && !options.base.startsWith('origin/')
    ? [`origin/${options.base}`, options.base]
    : [options.base];
  let resolvedRef: string | null = null;
  let commit: string | null = null;
  for (const candidate of candidates) {
    commit = verifyCommit(candidate, repoRoot);
    if (commit) { resolvedRef = candidate; break; }
  }
  if (!commit || !resolvedRef) {
    throw new IntegrityGitError('BASE_NOT_FOUND',
      `Base revision ${JSON.stringify(options.base)} was not found. Fetch it first (e.g. \`git fetch origin ${options.base}\`; in GitHub Actions use actions/checkout with fetch-depth: 0).`);
  }
  if (options.mergeBase) {
    const mb = tryGit(['merge-base', 'HEAD', commit], repoRoot);
    if (!mb) {
      throw new IntegrityGitError('NO_MERGE_BASE',
        `No merge base between HEAD and ${resolvedRef}. The clone may be shallow — use actions/checkout with fetch-depth: 0.`);
    }
    commit = mb.trim();
  }
  return { ref: resolvedRef, commit, head, repoRoot, treeish: commit };
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'T';

export interface ChangedEntry {
  status: ChangeStatus;
  /** Repo-relative POSIX path in the head (old path for deletions). */
  path: string;
  /** Previous path for renames. */
  oldPath?: string;
}

/** Literal pathspecs (no glob interpretation) for repo-relative paths. */
function literalPathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(literal)${p}`);
}

/**
 * List files changed between the base and the head (working tree or index),
 * including untracked files. With `paths`, Git only looks at those paths
 * (per-file hook checks), which avoids a repository-wide untracked scan.
 */
export function listChanges(base: ResolvedBase, paths?: string[]): ChangedEntry[] {
  const args = ['diff', '--name-status', '-z', '-M', '--no-color', '--no-ext-diff'];
  if (base.head === 'index') args.push('--cached');
  args.push(base.treeish, '--');
  if (paths) {
    if (paths.length === 0) return [];
    args.push(...literalPathspecs(paths));
  }
  const out = git(args, base.repoRoot);
  const tokens = out.split('\0');
  const entries: ChangedEntry[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (code === 'R') entries.push({ status: 'R', path: newPath, oldPath });
      else entries.push({ status: 'A', path: newPath });
    } else {
      const p = tokens[i++];
      if (!p) continue;
      if (code === 'A' || code === 'M' || code === 'D' || code === 'T') entries.push({ status: code, path: p });
      else if (code === 'U') entries.push({ status: 'M', path: p });
    }
  }
  if (base.head === 'working-tree') {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', ...(paths ? ['--', ...literalPathspecs(paths)] : [])], base.repoRoot);
    const known = new Set(entries.map((e) => e.path));
    for (const p of untracked.split('\0')) {
      if (p && !known.has(p)) entries.push({ status: 'A', path: p });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export type BlobRead = { content: string } | { missing: true } | { error: IntegrityGitError };

/**
 * Read many `<rev>:<path>` blobs with two Git processes (`cat-file
 * --batch-check`, then `--batch` for the ones within the size limit) instead
 * of two processes per file.
 */
export function readBlobs(repoRoot: string, specs: string[]): Map<string, BlobRead> {
  const out = new Map<string, BlobRead>();
  const batchable = specs.filter((s) => !s.includes('\n') && !s.includes('\r'));
  for (const s of specs) if (!batchable.includes(s)) out.set(s, { missing: true });
  if (batchable.length === 0) return out;
  const check = git(['cat-file', '--batch-check'], repoRoot, { input: batchable.join('\n') + '\n' }).split('\n');
  const wanted: Array<{ spec: string; sha: string; size: number }> = [];
  batchable.forEach((spec, i) => {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(check[i] ?? '');
    if (!m || m[2] !== 'blob') { out.set(spec, { missing: true }); return; }
    const size = Number(m[3]);
    if (size > MAX_FILE_BYTES) {
      out.set(spec, { error: new IntegrityGitError('FILE_TOO_LARGE', `${spec.replace(/^[^:]*:/, '')} exceeds ${MAX_FILE_BYTES} bytes`) });
      return;
    }
    wanted.push({ spec, sha: m[1], size });
  });
  if (wanted.length === 0) return out;
  let raw: Buffer;
  try {
    raw = childProcess.execFileSync('git', ['-c', 'core.fsmonitor=false', 'cat-file', '--batch'], {
      cwd: repoRoot, input: wanted.map((w) => w.sha).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000, maxBuffer: wanted.reduce((n, w) => n + w.size + 128, 1024), shell: false, windowsHide: true,
    });
  } catch (err) {
    throw new IntegrityGitError('GIT_FAILED', err instanceof Error ? err.message : String(err));
  }
  let offset = 0;
  for (const w of wanted) {
    const headerEnd = raw.indexOf(0x0a, offset);
    offset = headerEnd + 1;
    out.set(w.spec, { content: raw.subarray(offset, offset + w.size).toString('utf-8') });
    offset += w.size + 1; // content is followed by a newline
  }
  return out;
}

/**
 * Head-side line numbers added by the change for many files, from one
 * `git diff -U0` (chunked to stay under command-line limits). Files missing
 * from the map could not be diffed; callers treat every line as added.
 */
export function addedLinesForAll(base: ResolvedBase, entries: ChangedEntry[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  const targets = entries.filter((e) => e.status !== 'A' && e.status !== 'D');
  for (const e of targets) result.set(e.path, new Set());
  const chunks: ChangedEntry[][] = [];
  let current: ChangedEntry[] = [];
  let length = 0;
  for (const e of targets) {
    const n = e.path.length + (e.oldPath?.length ?? 0) + 24;
    if (current.length > 0 && length + n > 16000) { chunks.push(current); current = []; length = 0; }
    current.push(e);
    length += n;
  }
  if (current.length > 0) chunks.push(current);
  for (const chunk of chunks) {
    const args = ['diff', '-U0', '--no-color', '--no-ext-diff', '-M'];
    if (base.head === 'index') args.push('--cached');
    args.push(base.treeish, '--', ...literalPathspecs(chunk.flatMap((e) => (e.oldPath ? [e.oldPath, e.path] : [e.path]))));
    const out = tryGit(args, base.repoRoot);
    if (out === null) { for (const e of chunk) result.delete(e.path); continue; }
    let file: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4).replace(/\t$/, '');
        file = target === '/dev/null' ? null : unquotePath(target).replace(/^b\//, '');
        continue;
      }
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m && file !== null) {
        const set = result.get(file) ?? new Set<number>();
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        for (let i = 0; i < count; i++) set.add(start + i);
        result.set(file, set);
      }
    }
  }
  return result;
}

/** Git C-style quoted path ("b/a\tb") → plain path. */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf-8')); continue; }
    const next = body[++i];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; continue; }
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
    bytes.push(...Buffer.from(map[next] ?? next, 'utf-8'));
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** Read a file in the head (working tree or index); null if it does not exist. */
export function readHeadFile(base: ResolvedBase, repoPath: string): string | null {
  if (base.head === 'index') {
    const size = tryGit(['cat-file', '-s', `:${repoPath}`], base.repoRoot);
    if (size === null) return null;
    if (Number(size.trim()) > MAX_FILE_BYTES) throw new IntegrityGitError('FILE_TOO_LARGE', `${repoPath} exceeds ${MAX_FILE_BYTES} bytes`);
    return git(['show', `:${repoPath}`], base.repoRoot);
  }
  const abs = path.join(base.repoRoot, repoPath);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(abs); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_BYTES) throw new IntegrityGitError('FILE_TOO_LARGE', `${repoPath} exceeds ${MAX_FILE_BYTES} bytes`);
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * Base for a commit or tree recorded earlier (Claude session start); null means
 * the empty tree.
 */
export function baseFromCommit(cwd: string, treeish: string | null, ref: string): ResolvedBase {
  const repoRoot = repoRootOf(cwd);
  if (treeish === null) return { ref: '(empty tree)', commit: null, head: 'working-tree', repoRoot, treeish: emptyTree(repoRoot) };
  if (!/^[0-9a-f]{40,64}$/.test(treeish) || tryGit(['rev-parse', '--verify', '--quiet', `${treeish}^{tree}`], repoRoot) === null) {
    throw new IntegrityGitError('BASE_NOT_FOUND', `Recorded base ${treeish.slice(0, 12)} no longer exists`);
  }
  return { ref, commit: treeish, head: 'working-tree', repoRoot, treeish };
}

/**
 * Snapshot the current working tree (tracked and untracked, honouring
 * .gitignore) as a Git tree object, using a temporary index file so the
 * user's index, stash and files are never modified. Returns the tree SHA.
 */
export function snapshotWorkingTree(cwd: string): string {
  const repoRoot = repoRootOf(cwd);
  const indexPath = path.resolve(repoRoot, git(['rev-parse', '--git-path', 'index'], repoRoot).trim());
  const tmpIndex = path.join(os.tmpdir(), `ai-guard-index-${process.pid}-${Date.now()}`);
  try {
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const run = (args: string[]): string => childProcess.execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true, env,
    });
    run(['add', '-A', '--', '.']);
    return run(['write-tree']).trim();
  } catch (err) {
    if (err instanceof IntegrityGitError) throw err;
    throw new IntegrityGitError('SNAPSHOT_FAILED', err instanceof Error ? err.message : String(err));
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/** HEAD commit SHA, or null for a repository without commits. */
export function headCommit(cwd: string): string | null {
  const out = tryGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd);
  return out ? out.trim() : null;
}
