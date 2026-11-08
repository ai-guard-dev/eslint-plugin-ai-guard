/**
 * agent-session.ts — per-session state for the Claude Code hooks.
 *
 * SessionStart records the commit the session started from, so the Stop hook
 * verifies everything the agent did, including work it already committed. The
 * Stop hook records which findings it has reported, so each one is raised once
 * per session instead of at the end of every later turn.
 *
 * State lives inside the Git directory (`.git/ai-guard/sessions/`): it is never
 * committed and never shows up as an untracked file.
 */

import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

export interface SessionState {
  version: 1;
  /** HEAD when the session started, or null in a repository without commits. */
  baseCommit: string | null;
  /** Finding ids already reported to the agent in this session. */
  reported: string[];
  createdAt: string;
  updatedAt: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REPORTED = 2000;

function git(args: string[], cwd: string): string | null {
  try {
    return childProcess.execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, shell: false }).trim();
  } catch {
    return null;
  }
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id);
}

/** Directory for session files, or null outside a Git repository. */
export function sessionDir(cwd: string): string | null {
  const dir = git(['rev-parse', '--git-path', 'ai-guard/sessions'], cwd);
  if (!dir) return null;
  return path.resolve(cwd, dir);
}

function sessionFile(cwd: string, id: string): string | null {
  if (!isValidSessionId(id)) return null;
  const dir = sessionDir(cwd);
  return dir ? path.join(dir, `${id}.json`) : null;
}

export function loadSession(cwd: string, id: string): SessionState | null {
  const file = sessionFile(cwd, id);
  if (!file) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionState;
    return state && state.version === 1 && Array.isArray(state.reported) ? state : null;
  } catch {
    return null;
  }
}

export function saveSession(cwd: string, id: string, state: SessionState): void {
  const file = sessionFile(cwd, id);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const trimmed: SessionState = { ...state, reported: state.reported.slice(-MAX_REPORTED), updatedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trimmed) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** Records the session's starting commit. A resumed session keeps its original base. */
export function startSession(cwd: string, id: string): SessionState | null {
  if (!isValidSessionId(id)) return null;
  const existing = loadSession(cwd, id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const state: SessionState = {
    version: 1,
    baseCommit: git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd) || null,
    reported: [],
    createdAt: now,
    updatedAt: now,
  };
  saveSession(cwd, id, state);
  pruneSessions(cwd);
  return state;
}

/** The recorded base, if it is still an ancestor of HEAD (not lost to a reset or rebase). */
export function usableBaseCommit(cwd: string, state: SessionState | null): string | undefined {
  const base = state?.baseCommit;
  if (!base) return undefined;
  try {
    childProcess.execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd, stdio: 'ignore', timeout: 10000, shell: false });
    return base;
  } catch {
    return undefined;
  }
}

/** Deletes session files older than 14 days. */
export function pruneSessions(cwd: string): void {
  const dir = sessionDir(cwd);
  if (!dir) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Another process may have removed it.
    }
  }
}
