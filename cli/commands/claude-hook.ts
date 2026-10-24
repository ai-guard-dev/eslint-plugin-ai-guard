/**
 * claude-hook.ts — Claude Code hook entry point (`ai-guard claude-hook`).
 *
 * One command handles every registered event, following the documented hook
 * protocol (https://code.claude.com/docs/en/hooks): it always exits 0 and
 * writes a JSON object on stdout when Claude or the user should see something.
 * Plain stdout from a hook that exits 0 is never shown to Claude, which is why
 * earlier versions' findings did not reach the agent.
 *
 *  PostToolUse (Edit|MultiEdit|Write)
 *    Lints the edited JS/TS file and checks that file for newly weakened checks
 *    (added suppressions, skipped/focused tests, downgraded config). The tool
 *    has already run, so `decision: "block"` only puts the `reason` next to the
 *    tool result; advisories go to `additionalContext`.
 *  Stop
 *    Runs check-integrity analysis on everything changed since the session
 *    started. High-confidence findings block stopping once per unique finding
 *    set per session (`decision: "block"`); after that, or for advisories, the
 *    user is informed with `systemMessage` so Claude is never trapped in a loop.
 *  PreToolUse (Bash)
 *    Asks for confirmation before commands that skip Git hooks
 *    (`git commit --no-verify`, `HUSKY=0 …`).
 *  SessionStart
 *    Snapshots the working tree as the session's integrity base, so changes
 *    the user had already made before the session are not attributed to the
 *    agent. Without it, the first hook event records HEAD instead.
 */

import type { Command } from 'commander';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runEslint, ISSUE_REMEDIATION, ISSUE_CONFIDENCE, type RunResult } from '../utils/eslint-runner.js';
import { loadIntegrityAcceptances, resolveBaselinePath } from '../utils/baseline.js';
import { analyzeWithBase } from '../utils/integrity/engine.js';
import { IntegrityGitError, baseFromCommit, headCommit, repoRootOf, resolveBase, snapshotWorkingTree, type ResolvedBase } from '../utils/integrity/git.js';
import { blankQuotes, detectHookBypass, describeWeakener } from '../utils/integrity/commands.js';
import { formatFindingsForAgent } from '../utils/integrity/report.js';
import type { IntegrityFinding, IntegrityReport } from '../utils/integrity/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolInput {
  file_path?: string;
  path?: string;
  notebook_path?: string;
  command?: string;
  [key: string]: unknown;
}

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: ToolInput;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

export type BashGuardMode = 'ask' | 'deny' | 'off';

export interface HookOptions {
  /** Directory for per-session state (default: <tmp>/ai-guard/claude-sessions). */
  stateDir: string;
  /** Compare with merge-base(HEAD, base) instead of the session's starting commit. */
  base?: string;
  bashGuard: BashGuardMode;
  /** Lint function (injectable for tests). */
  lint?: (file: string) => Promise<RunResult>;
}

interface SessionState {
  version: 1;
  /** Commit or tree SHA the session is compared with; null = empty tree. */
  baseTreeish: string | null;
  /** Human label for the base ("session start", "HEAD at first edit"). */
  baseLabel: string;
  /** Finding sets (sorted fingerprints) that already blocked a Stop. */
  blockedSets: string[];
  /** Advisory fingerprints already shown in this session. */
  shownAdvisories: string[];
  /** Acceptance findings caused by the agent editing the baseline file itself. */
  agentAcceptances?: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
]);

export const DEFAULT_STATE_DIR = path.join(os.tmpdir(), 'ai-guard', 'claude-sessions');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read all of stdin as a string.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', reject);

    // If stdin is a TTY (run manually), resolve immediately with empty
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/** Parse hook JSON from stdin. */
export function parseHookInput(raw: string): { input: HookInput | null; error?: string } {
  if (!raw || raw.trim() === '') return { input: null, error: 'Empty stdin — no hook payload received' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { input: null, error: 'Hook payload is not a JSON object' };
    return { input: parsed as HookInput };
  } catch {
    return { input: null, error: 'Invalid JSON on stdin' };
  }
}

/**
 * Parse the PostToolUse payload and extract the file path.
 */
export function parsePayload(raw: string): { filePath: string | null; error?: string } {
  const { input, error } = parseHookInput(raw);
  if (!input) return { filePath: null, error };
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') {
    return { filePath: null, error: 'Missing tool_input in payload' };
  }
  const rawPath = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path;
  if (!rawPath || typeof rawPath !== 'string') {
    return { filePath: null, error: 'No file path found in tool_input' };
  }
  return { filePath: rawPath };
}

/**
 * Normalize the file path to an absolute path, handling Windows/Unix differences.
 */
export function resolveFilePath(rawPath: string, cwd: string): string {
  // Handle both forward and back slashes
  const normalized = rawPath.replace(/\\/g, '/');

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }

  return path.resolve(cwd, normalized);
}

/**
 * Check if a file extension is a JS/TS file that AI Guard can scan.
 */
export function isScannableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return JS_TS_EXTENSIONS.has(ext);
}

/**
 * Format a single finding as agent-friendly diagnostic text.
 */
function formatFinding(
  ruleId: string,
  filePath: string,
  line: number,
  column: number,
  message: string,
): string {
  const relPath = path.relative(process.cwd(), filePath);
  const confidence = ISSUE_CONFIDENCE[ruleId];
  const remediation = ISSUE_REMEDIATION[ruleId];

  const parts: string[] = [
    ruleId,
    `${relPath}:${line}:${column}`,
    '',
    message,
  ];

  if (remediation) {
    parts.push(remediation);
  }

  if (confidence) {
    parts.push(`Confidence: ${confidence}`);
  }

  return parts.join('\n');
}

function formatLintForAgent(result: RunResult, max = 10): string {
  const lines: string[] = [];
  const issues = result.files.flatMap((f) => f.issues.map((i) => ({ f, i })));
  for (const { f, i } of issues.slice(0, max)) {
    lines.push(`- ${f.filePath.replace(/\\/g, '/')}:${i.line}:${i.column} [${i.ruleId}] ${i.message}`);
    if (i.suppression) lines.push(`  Note: \`${i.suppression.text}\` does not hide this finding (${i.suppression.reason === 'missing-justification' ? 'add `-- <reason>` if the suppression is intended' : 'directives are ignored'}).`);
    const fix = ISSUE_REMEDIATION[i.ruleId];
    if (fix) lines.push(`  Fix: ${fix}`);
  }
  if (issues.length > max) lines.push(`- …and ${issues.length - max} more.`);
  return lines.join('\n');
}

// ─── Session state ────────────────────────────────────────────────────────────

function stateFile(stateDir: string, sessionId: string, repoRoot: string): string {
  const id = crypto.createHash('sha256').update(`${sessionId}\0${repoRoot}`).digest('hex').slice(0, 32);
  return path.join(stateDir, `${id}.json`);
}

function loadState(file: string | null): SessionState | null {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.blockedSets) && Array.isArray(parsed.shownAdvisories)
      && typeof parsed.baseLabel === 'string') return parsed;
  } catch { /* missing or corrupt: start fresh */ }
  return null;
}

function saveState(file: string | null, state: SessionState): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf-8');
  } catch { /* state is an optimization against repeated blocks; never fail the hook */ }
}

interface Session {
  repoRoot: string;
  file: string | null;
  state: SessionState;
}

/**
 * Open (or start) the session. A new session records its integrity base: a
 * snapshot of the working tree at SessionStart, otherwise HEAD.
 */
function openSession(input: HookInput, cwd: string, opts: HookOptions, snapshot = false): Session {
  const repoRoot = repoRootOf(cwd);
  const file = input.session_id ? stateFile(opts.stateDir, input.session_id, repoRoot) : null;
  const existing = loadState(file);
  if (existing) return { repoRoot, file, state: existing };
  let baseTreeish: string | null = null;
  let baseLabel = 'HEAD at the first edit';
  if (snapshot) {
    try { baseTreeish = snapshotWorkingTree(repoRoot); baseLabel = 'the working tree at session start'; } catch { baseTreeish = null; }
  }
  if (baseTreeish === null) baseTreeish = headCommit(repoRoot);
  const state: SessionState = { version: 1, baseTreeish, baseLabel, blockedSets: [], shownAdvisories: [] };
  saveState(file, state);
  return { repoRoot, file, state };
}

function sessionBase(session: Session, cwd: string, opts: HookOptions): ResolvedBase {
  if (opts.base) return resolveBase({ cwd, base: opts.base, mergeBase: true });
  return baseFromCommit(cwd, session.state.baseTreeish, session.state.baseLabel);
}

function acceptedFingerprints(repoRoot: string): string[] {
  const loaded = loadIntegrityAcceptances(resolveBaselinePath(repoRoot));
  return loaded.status === 'ok' ? loaded.accepted.map((a) => a.fingerprint) : [];
}

// ─── Event handlers ───────────────────────────────────────────────────────────

type HookOutput = Record<string, unknown>;

async function onPostToolUse(input: HookInput, cwd: string, opts: HookOptions): Promise<HookOutput | null> {
  const toolInput = input.tool_input ?? {};
  const rawPath = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path;
  if (typeof rawPath !== 'string' || rawPath === '') return null;
  const target = resolveFilePath(rawPath, cwd);

  const blocking: string[] = [];
  const advisory: string[] = [];

  if (isScannableFile(target) && fs.existsSync(target)) {
    const lint = opts.lint ?? ((file: string) => runEslint({
      preset: 'agent',
      targetPath: path.dirname(file),
      files: [file],
      inlineSuppressions: 'require-reason',
    }));
    const result = await lint(target);
    if (result.totalIssues > 0) {
      blocking.push(`AI Guard found ${result.totalIssues} issue${result.totalIssues !== 1 ? 's' : ''} in the edited file:\n${formatLintForAgent(result)}`);
    }
  }

  let session: Session | null = null;
  try {
    session = openSession(input, cwd, opts);
  } catch {
    session = null; // not a Git repository: lint feedback only
  }
  if (session) {
    try {
      const report = await analyzeWithBase(sessionBase(session, cwd, opts), {
        cwd, paths: [target], acceptedFingerprints: acceptedFingerprints(session.repoRoot),
      });
      // The agent edited the baseline file itself: its acceptances are not a human decision.
      const agentAccepted = report.findings.filter((f) => f.ruleId === ACCEPTANCE_RULE);
      if (agentAccepted.length > 0) {
        session.state.agentAcceptances = [...new Set([...(session.state.agentAcceptances ?? []), ...agentAccepted.map((f) => f.fingerprint)])];
        saveState(session.file, session.state);
      }
      const state = session.state;
      const high = report.findings.filter((f) => blocksAgent(f, state));
      const shown = new Set(state.shownAdvisories);
      const newAdvisories = report.findings.filter((f) => !blocksAgent(f, state) && !shown.has(f.fingerprint));
      if (high.length > 0) {
        blocking.push(`This edit weakens checks the project relies on:\n${formatFindingsForAgent(high)}\nRestore the check and fix the code instead. If the change is intended, tell the user why.`);
      }
      if (newAdvisories.length > 0) {
        advisory.push(`AI Guard advisory (needs judgment, does not block):\n${formatFindingsForAgent(newAdvisories)}`);
        session.state.shownAdvisories.push(...newAdvisories.map((f) => f.fingerprint));
        saveState(session.file, session.state);
      }
    } catch (err) {
      if (process.env.AI_GUARD_DEBUG === '1') process.stderr.write(`[ai-guard] integrity: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (blocking.length === 0 && advisory.length === 0) return null;
  const output: HookOutput = {};
  if (blocking.length > 0) {
    output.decision = 'block';
    output.reason = blocking.join('\n\n');
  }
  if (advisory.length > 0) {
    output.hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: advisory.join('\n\n') };
  }
  return output;
}

const ACCEPTANCE_RULE = 'ai-guard/integrity-acceptance-added';

/**
 * Findings that block the agent: high-confidence weakenings, and integrity
 * acceptances the agent wrote into the baseline file with an edit tool. (In
 * CI, and when the user accepts, acceptances are advisory; `--accept` run
 * through Bash goes through the PreToolUse guard instead.)
 */
function blocksAgent(f: IntegrityFinding, state: SessionState): boolean {
  return f.tier === 'high' || (f.ruleId === ACCEPTANCE_RULE && (state.agentAcceptances ?? []).includes(f.fingerprint));
}

function summarizeForUser(findings: IntegrityFinding[], max = 5): string {
  const lines = findings.slice(0, max).map((f) => `• ${f.line ? `${f.file}:${f.line}` : f.file} — ${f.message}`);
  if (findings.length > max) lines.push(`• …and ${findings.length - max} more (run \`npx ai-guard integrity\`)`);
  return lines.join('\n');
}

async function onStop(input: HookInput, cwd: string, opts: HookOptions): Promise<HookOutput | null> {
  let session: Session;
  let report: IntegrityReport;
  try {
    session = openSession(input, cwd, opts);
    report = await analyzeWithBase(sessionBase(session, cwd, opts), {
      cwd, acceptedFingerprints: acceptedFingerprints(session.repoRoot),
    });
  } catch (err) {
    if (err instanceof IntegrityGitError && (err.code === 'NOT_A_REPO' || err.code === 'GIT_UNAVAILABLE')) return null;
    // Never claim the change is clean when the check could not run.
    return { systemMessage: `AI Guard check-integrity analysis did not run: ${err instanceof Error ? err.message : String(err)}` };
  }

  const state = session.state;
  const high = report.findings.filter((f) => blocksAgent(f, state));
  if (high.length > 0) {
    const setKey = high.map((f) => f.fingerprint).sort().join(',');
    const alreadyBlocked = session.state.blockedSets.includes(setKey);
    const cannotTrack = session.file === null && input.stop_hook_active === true;
    if (!alreadyBlocked && !cannotTrack) {
      session.state.blockedSets.push(setKey);
      saveState(session.file, session.state);
      return {
        decision: 'block',
        reason: `Before finishing: your changes weaken checks the project relies on (compared with ${report.base.ref}).\n${formatFindingsForAgent(high)}\nRestore these checks and fix the underlying code. If a weakening is intended, explain it to the user instead of continuing to change code; the user can accept a specific finding with \`npx ai-guard integrity --accept <fingerprint>\` (${high.map((f) => `#${f.fingerprint.slice(0, 12)}`).join(', ')}).`,
      };
    }
    return { systemMessage: `AI Guard: ${high.length} check-weakening finding(s) remain unresolved:\n${summarizeForUser(high)}` };
  }

  const shown = new Set(session.state.shownAdvisories);
  const advisories = report.findings.filter((f) => !blocksAgent(f, state) && !shown.has(f.fingerprint));
  if (advisories.length > 0) {
    session.state.shownAdvisories.push(...advisories.map((f) => f.fingerprint));
    saveState(session.file, session.state);
    return { systemMessage: `AI Guard advisory — review before merging:\n${summarizeForUser(advisories)}` };
  }
  return null;
}

/** `ai-guard integrity --accept …` run by the agent: accepting a weakening is a human decision. */
export function isAcceptCommand(command: string): boolean {
  return /\bai-guard\b[^\n;&|]*\bintegrity\b[^\n;&|]*--accept\b/.test(blankQuotes(command));
}

function onPreToolUseBash(input: HookInput, opts: HookOptions): HookOutput | null {
  if (opts.bashGuard === 'off') return null;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const hits = detectHookBypass(command);
  const accepting = isAcceptCommand(command);
  if (hits.length === 0 && !accepting) return null;
  const reasons: string[] = [];
  if (hits.length > 0) reasons.push(`this command bypasses Git hooks (${hits.map(describeWeakener).join('; ')}). Run the hooks and fix what they report instead`);
  if (accepting) reasons.push('this command accepts check-integrity findings, which hides them from enforcement. Only the user should accept a weakened check');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: opts.bashGuard,
      permissionDecisionReason: `AI Guard: ${reasons.join('; ')}.`,
    },
  };
}

/**
 * Handle one hook invocation. Returns the JSON object to print on stdout, or
 * null for no output. Never throws for expected conditions.
 */
export function handleHookInput(input: HookInput, opts: HookOptions): Promise<HookOutput | null> {
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const event = input.hook_event_name ?? (input.tool_input ? 'PostToolUse' : undefined);
  switch (event) {
    case 'PostToolUse': return onPostToolUse(input, cwd, opts);
    case 'Stop': return onStop(input, cwd, opts);
    case 'PreToolUse': return Promise.resolve(input.tool_name === 'Bash' ? onPreToolUseBash(input, opts) : null);
    case 'SessionStart':
      // Plain stdout on SessionStart is added to Claude's context, so print nothing.
      try { openSession(input, cwd, opts, true); } catch { /* not a Git repository */ }
      return Promise.resolve(null);
    default: return Promise.resolve(null);
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerClaudeHookCommand(program: Command): void {
  program
    .command('claude-hook')
    .description('Internal: Claude Code hook entry point (SessionStart, PostToolUse, Stop, PreToolUse:Bash — reads JSON from stdin)')
    .option('--file <path>', 'Override: lint this file and print findings as text (for debugging)')
    .option('--base <ref>', 'Compare integrity with merge-base(HEAD, <ref>) instead of the session start')
    .option('--bash-guard <mode>', 'Commands that skip Git hooks: ask (default) | deny | off', 'ask')
    .action(async (opts: { file?: string; base?: string; bashGuard: string }) => {
      const cwd = process.cwd();

      if (opts.file) {
        // Debug mode: human-readable lint output for one file.
        const targetFile = resolveFilePath(opts.file, cwd);
        if (!isScannableFile(targetFile) || !fs.existsSync(targetFile)) { process.exit(0); return; }
        try {
          const result = await runEslint({ preset: 'agent', targetPath: path.dirname(targetFile), files: [targetFile], inlineSuppressions: 'require-reason' });
          if (result.totalIssues === 0) { process.exit(0); return; }
          const findings = result.files.flatMap((file) => file.issues.map((issue) => formatFinding(issue.ruleId, file.filePath, issue.line, issue.column, issue.message)));
          const header = `AI Guard found ${findings.length} issue${findings.length !== 1 ? 's' : ''}.`;
          process.stdout.write([header, '', ...findings.join('\n\n---\n\n').split('\n')].join('\n') + '\n');
        } catch (err) {
          if (process.env.AI_GUARD_DEBUG === '1') process.stderr.write(`[ai-guard] Hook error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        process.exit(0);
        return;
      }

      const bashGuard: BashGuardMode = opts.bashGuard === 'deny' || opts.bashGuard === 'off' ? opts.bashGuard : 'ask';
      const { input, error } = parseHookInput(await readStdin());
      if (!input) {
        if (error && process.env.AI_GUARD_DEBUG === '1') process.stderr.write(`[ai-guard] ${error}\n`);
        process.exit(0);
        return;
      }
      try {
        const output = await handleHookInput(input, {
          stateDir: process.env.AI_GUARD_STATE_DIR || DEFAULT_STATE_DIR,
          base: opts.base,
          bashGuard,
        });
        if (output) process.stdout.write(JSON.stringify(output) + '\n');
      } catch (err) {
        // Never crash Claude's workflow — report on stderr in debug mode only.
        if (process.env.AI_GUARD_DEBUG === '1') {
          process.stderr.write(`[ai-guard] Hook error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      process.exit(0);
    });
}
