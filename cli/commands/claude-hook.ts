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
 *    started, then verifies the change itself (`ai-guard verify`: lint findings
 *    on lines the session added or edited, and agent-config issues). Blocking
 *    findings stop Claude once per unique finding (`decision: "block"`); after
 *    that, or for advisories, the user is informed with `systemMessage` so
 *    Claude is never trapped in a loop.
 *  PreToolUse (Bash, PowerShell)
 *    Asks for confirmation before commands that skip Git hooks
 *    (`git commit --no-verify`, `HUSKY=0 …`). With --check-installs (or
 *    AI_GUARD_CHECK_INSTALLS=1, or the plugin's check_installs option) it also
 *    checks the npm packages an install command would fetch: missing names are
 *    denied, suspicious packages ask the user, warnings go to Claude as context.
 *  SessionStart
 *    Snapshots the working tree as the session's integrity base, so changes
 *    the user had already made before the session are not attributed to the
 *    agent. Without it, the first hook event records HEAD instead.
 */

import type { Command } from 'commander';
import childProcess from 'child_process';
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
import { verifyChange, type VerifyFinding, type VerifyReport } from '../utils/verify.js';
import { guardInstallCommand, type InstallGuardOptions } from '../utils/deps/install-guard.js';
import type { IntegrityFinding, IntegrityReport } from '../utils/integrity/types.js';
import { isAgentName, normalizeHookInput, translateHookOutput, AGENTS, type AgentName, type EngineInput, type EngineOutput } from '../utils/hooks/agents.js';

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
  /** Use the rules bundled with this CLI instead of the project's own copy (Claude Code plugin). */
  isolated?: boolean;
  /** Lint function (injectable for tests). */
  lint?: (file: string) => Promise<RunResult>;
  /** Change verification (injectable for tests). */
  verify?: typeof verifyChange;
  /** Check the npm packages in install commands before they run (network; opt-in). */
  checkInstalls?: boolean;
  /** Registry client and timeouts for the install check (injectable for tests). */
  installGuard?: InstallGuardOptions;
}

/** The install check is opt-in: --check-installs, AI_GUARD_CHECK_INSTALLS, or the plugin option check_installs. */
export function installCheckEnabled(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag) return true;
  const truthy = (v: string | undefined): boolean => v !== undefined && /^(?:1|true|yes|on)$/i.test(v.trim());
  return truthy(env.AI_GUARD_CHECK_INSTALLS) || truthy(env.CLAUDE_PLUGIN_OPTION_CHECK_INSTALLS);
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
  /** HEAD when the session started; `verify` compares lint findings against it. */
  startCommit?: string | null;
  /** Ids of `verify` findings already reported in this session. */
  verifyReported?: string[];
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
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseHookInput(raw: string): { input: HookInput | null; error?: string } {
  if (!raw || raw.trim() === '') return { input: null, error: 'Empty stdin — no hook payload received' };
  try {
    // Windows PowerShell prefixes piped text with a byte-order mark.
    const parsed = JSON.parse(stripBom(raw)) as unknown;
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
  const state: SessionState = { version: 1, baseTreeish, baseLabel, blockedSets: [], shownAdvisories: [], startCommit: headCommit(repoRoot), verifyReported: [] };
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
    // Isolated runs resolve ignore patterns against the target, so use the project root:
    // from the file's own directory, dist/x.js would look like x.js and escape **/dist/**.
    const relative = path.relative(cwd, target);
    const inProject = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    const lint = opts.lint ?? ((file: string) => runEslint({
      preset: 'agent',
      targetPath: opts.isolated && inProject ? cwd : path.dirname(file),
      files: [file],
      inlineSuppressions: 'require-reason',
      isolated: opts.isolated,
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

  // Lint findings the session introduced, and agent-config issues. Test weakening is covered above.
  const step = await verifyStep(session, input, cwd, opts);
  if (step.block) return { decision: 'block', reason: step.block };

  const notes: string[] = [];
  const shown = new Set(session.state.shownAdvisories);
  const advisories = report.findings.filter((f) => !blocksAgent(f, state) && !shown.has(f.fingerprint));
  if (advisories.length > 0) {
    session.state.shownAdvisories.push(...advisories.map((f) => f.fingerprint));
    saveState(session.file, session.state);
    notes.push(`AI Guard advisory — review before merging:\n${summarizeForUser(advisories)}`);
  }
  if (step.user) notes.push(step.user);
  return notes.length > 0 ? { systemMessage: notes.join('\n\n') } : null;
}

interface VerifyStep {
  /** Reason to send back to Claude (blocks stopping). */
  block?: string;
  /** Text for the user (systemMessage). */
  user?: string;
}

/** True when the file's content differs from the session's starting snapshot (or it has none). */
function changedSinceBase(root: string, treeish: string | null, file: string): boolean {
  if (!treeish) return true;
  try {
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs)) return true;
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const run = (args: string[]): string => childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }).trim();
    return run(['hash-object', '--', abs]) !== run(['rev-parse', '--verify', '--quiet', `${treeish}:${rel}`]);
  } catch {
    return true; // not in the snapshot, or Git could not tell: treat as changed
  }
}

function describeVerifyItems(items: VerifyFinding[], max = 10): string {
  const lines = items.slice(0, max).map((f) => {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    return `- ${where} [${f.check.replace(/^ai-guard\//, '')}] ${f.message}${f.remediation ? `\n  Fix: ${f.remediation}` : ''}`;
  });
  if (items.length > max) lines.push(`- …and ${items.length - max} more (run \`ai-guard verify\`).`);
  return lines.join('\n');
}

async function verifyStep(session: Session, input: HookInput, cwd: string, opts: HookOptions): Promise<VerifyStep> {
  let report: VerifyReport;
  try {
    report = await (opts.verify ?? verifyChange)({
      cwd,
      baseCommit: session.state.startCommit ?? undefined,
      isolated: opts.isolated,
      testIntegrity: false, // the integrity engine above already covers weakened tests
    });
  } catch (err) {
    return { user: `AI Guard could not verify lint and agent-config changes: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!report.success) {
    if (report.errors.some((e) => e.code === 'GIT_FAILED')) return {};
    return { user: `AI Guard could not verify lint and agent-config changes: ${report.errors.map((e) => e.message).join('; ')}` };
  }

  // Ignore files the session did not touch: work the user left uncommitted before it started is theirs.
  const ours = (f: VerifyFinding): boolean => changedSinceBase(report.root || session.repoRoot, session.state.baseTreeish, f.file);
  const blocking = report.blocking.filter(ours);
  const reported = new Set(session.state.verifyReported ?? []);
  const fresh = blocking.filter((f) => !reported.has(f.id));

  // Without a session id nothing is remembered between stops, so a second stop in the
  // same sequence must not block again (it would loop until the continuation cap).
  const cannotTrack = session.file === null && input.stop_hook_active === true;
  if (fresh.length > 0 && !cannotTrack) {
    session.state.verifyReported = [...reported, ...fresh.map((f) => f.id)];
    saveState(session.file, session.state);
    return { block: `Before finishing: AI Guard found problems your changes introduced.\n${describeVerifyItems(fresh)}\nFix them. If one is intended, tell the user why instead of continuing to change code.` };
  }
  // Claude already had its chance in this stop sequence: tell the user once, and stay quiet on later turns.
  if (blocking.length > 0 && input.stop_hook_active === true) return { user: `AI Guard: ${blocking.length} issue(s) from this session remain unresolved:\n${summarizeVerifyForUser(blocking)}` };
  return {};
}

function summarizeVerifyForUser(items: VerifyFinding[], max = 5): string {
  const lines = items.slice(0, max).map((f) => `• ${f.line > 0 ? `${f.file}:${f.line}` : f.file} — ${f.message}`);
  if (items.length > max) lines.push(`• …and ${items.length - max} more (run \`ai-guard verify\`)`);
  return lines.join('\n');
}

/** `ai-guard integrity --accept …` run by the agent: accepting a weakening is a human decision. */
export function isAcceptCommand(command: string): boolean {
  return /\bai-guard\b[^\n;&|]*\bintegrity\b[^\n;&|]*--accept\b/.test(blankQuotes(command));
}

/** Commands that skip Git hooks or accept integrity findings. */
function bypassGuard(command: string, mode: BashGuardMode): { decision: 'ask' | 'deny'; reason: string } | null {
  if (mode === 'off') return null;
  const hits = detectHookBypass(command);
  const accepting = isAcceptCommand(command);
  if (hits.length === 0 && !accepting) return null;
  const reasons: string[] = [];
  if (hits.length > 0) reasons.push(`this command bypasses Git hooks (${hits.map(describeWeakener).join('; ')}). Run the hooks and fix what they report instead`);
  if (accepting) reasons.push('this command accepts check-integrity findings, which hides them from enforcement. Only the user should accept a weakened check');
  return { decision: mode, reason: `AI Guard: ${reasons.join('; ')}.` };
}

async function onPreToolUseCommand(input: HookInput, cwd: string, opts: HookOptions): Promise<HookOutput | null> {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const guard = input.tool_name === 'Bash' ? bypassGuard(command, opts.bashGuard) : null;
  let install: Awaited<ReturnType<typeof guardInstallCommand>> = null;
  if (installCheckEnabled(opts.checkInstalls)) {
    try {
      install = await guardInstallCommand(command, cwd, opts.installGuard);
    } catch (err) {
      // An install check that fails must never block the command.
      if (process.env.AI_GUARD_DEBUG === '1') process.stderr.write(`[ai-guard] install check: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (!guard && !install) return null;

  // Precedence matches Claude Code's: deny > ask > no decision.
  const decisions = [guard?.decision, install?.decision].filter((d): d is 'ask' | 'deny' => d === 'ask' || d === 'deny');
  const decision = decisions.includes('deny') ? 'deny' : decisions.includes('ask') ? 'ask' : undefined;
  const reasons = [guard?.reason, install?.decision ? install.reason : null].filter((r): r is string => Boolean(r));
  const output: Record<string, unknown> = { hookEventName: 'PreToolUse' };
  if (decision) {
    output.permissionDecision = decision;
    output.permissionDecisionReason = reasons.join('\n\n');
  }
  if (install?.context) output.additionalContext = install.context;
  return Object.keys(output).length > 1 ? { hookSpecificOutput: output } : null;
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
    case 'PreToolUse': return input.tool_name === 'Bash' || input.tool_name === 'PowerShell' ? onPreToolUseCommand(input, cwd, opts) : Promise.resolve(null);
    case 'SessionStart':
      // Plain stdout on SessionStart is added to Claude's context, so print nothing.
      try { openSession(input, cwd, opts, true); } catch { /* not a Git repository */ }
      return Promise.resolve(null);
    default: return Promise.resolve(null);
  }
}

async function runInOrder(inputs: EngineInput[], opts: HookOptions, index = 0, out: EngineOutput[] = []): Promise<EngineOutput[]> {
  if (index >= inputs.length) return out;
  // One at a time: the engine keeps per-session state on disk.
  out.push(await handleHookInput(inputs[index] as HookInput, opts));
  return runInOrder(inputs, opts, index + 1, out);
}

/**
 * Run one hook invocation for any supported agent: translate the agent's
 * payload for the engine, run it, and translate the answer back. Null: print
 * nothing.
 */
export async function runAgentHook(agent: AgentName, rawPayload: string, opts: HookOptions): Promise<Record<string, unknown> | null> {
  const { input } = parseHookInput(rawPayload);
  if (!input) return null;
  const { event, inputs } = normalizeHookInput(agent, input);
  return translateHookOutput(agent, event, await runInOrder(inputs, opts));
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerClaudeHookCommand(program: Command): void {
  program
    .command('claude-hook')
    .alias('hook')
    .description('Internal: Claude Code hook entry point (SessionStart, PostToolUse, Stop, PreToolUse:Bash — reads JSON from stdin)')
    .option('--file <path>', 'Override: lint this file and print findings as text (for debugging)')
    .option('--base <ref>', 'Compare integrity with merge-base(HEAD, <ref>) instead of the session start')
    .option('--bash-guard <mode>', 'Commands that skip Git hooks: ask (default) | deny | off', 'ask')
    .option('--isolated', 'Use the rules bundled with this CLI, for projects without AI Guard installed (Claude Code plugin)')
    .option('--check-installs', 'PreToolUse: check the npm packages in install commands against the npm registry before they run')
    .option('--agent <name>', `Hook protocol of the calling agent: ${AGENTS.join(' | ')}`, 'claude')
    .action(async (opts: { file?: string; base?: string; bashGuard: string; isolated?: boolean; checkInstalls?: boolean; agent: string }) => {
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
      if (!isAgentName(opts.agent)) {
        if (process.env.AI_GUARD_DEBUG === '1') process.stderr.write(`[ai-guard] Unknown --agent '${opts.agent}'\n`);
        process.exit(0);
        return;
      }
      const payload = await readStdin();
      try {
        const output = await runAgentHook(opts.agent, payload, {
          stateDir: process.env.AI_GUARD_STATE_DIR || DEFAULT_STATE_DIR,
          base: opts.base,
          bashGuard,
          isolated: opts.isolated,
          checkInstalls: opts.checkInstalls,
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
