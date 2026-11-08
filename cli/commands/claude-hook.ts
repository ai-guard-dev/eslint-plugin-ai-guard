/**
 * claude-hook.ts — Claude Code hook entrypoint (reads the hook payload on stdin).
 *
 *  PostToolUse   Scan the file Claude just edited (agent preset) and hand the
 *                findings to Claude as additionalContext.
 *  SessionStart  Record the commit the session started from.
 *  Stop          Verify everything the session changed. New blocking findings or
 *                weakened tests go back to Claude once; if Claude still finishes
 *                with them, the user gets a one-line warning instead of a loop.
 *
 * Output contract (https://code.claude.com/docs/en/hooks): exit 0 with JSON on stdout.
 * Plain stdout from PostToolUse/Stop is not shown to Claude, so findings always go
 * through hookSpecificOutput.additionalContext. The hook never fails the session:
 * every error exits 0 silently (set AI_GUARD_DEBUG=1 to see it on stderr).
 */

import type { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { runEslint, ISSUE_REMEDIATION, ISSUE_CONFIDENCE } from '../utils/eslint-runner.js';
import { verifyChange, formatVerifyForAgent, formatVerifyForUser } from '../utils/verify.js';
import { isValidSessionId, loadSession, saveSession, startSession, usableBaseCommit, type SessionState } from '../utils/agent-session.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolInput {
  file_path?: string;
  path?: string;
  [key: string]: unknown;
}

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  source?: string;
  tool_name?: string;
  tool_input?: ToolInput;
  [key: string]: unknown;
}

export interface HookOutput {
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
}

export interface HookOptions {
  /** Use the packaged rules instead of the project's installed plugin (tests). */
  isolated?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function debug(message: string): void {
  if (process.env.AI_GUARD_DEBUG === '1') process.stderr.write(`[ai-guard] ${message}\n`);
}

/** Parses the hook payload; null for empty or invalid input. */
export function parseHookPayload(raw: string): HookPayload | null {
  if (!raw || raw.trim() === '') return null;
  try {
    const payload = JSON.parse(raw) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as HookPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Parse the PostToolUse payload and extract the file path.
 */
export function parsePayload(raw: string): { filePath: string | null; error?: string } {
  if (!raw || raw.trim() === '') {
    return { filePath: null, error: 'Empty stdin — no PostToolUse payload received' };
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return { filePath: null, error: 'Invalid JSON on stdin' };
  }

  const input = payload.tool_input;
  if (!input || typeof input !== 'object') {
    return { filePath: null, error: 'Missing tool_input in payload' };
  }

  const rawPath = input.file_path ?? input.path;
  if (!rawPath || typeof rawPath !== 'string') {
    return { filePath: null, error: 'No file path found in tool_input' };
  }

  return { filePath: rawPath };
}

/**
 * Normalize the file path to an absolute path, handling Windows/Unix differences.
 */
export function resolveFilePath(rawPath: string, cwd: string): string {
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

function formatFinding(ruleId: string, filePath: string, line: number, column: number, message: string, cwd: string): string {
  const relPath = path.relative(cwd, filePath);
  const parts: string[] = [ruleId, `${relPath}:${line}:${column}`, '', message];
  const remediation = ISSUE_REMEDIATION[ruleId];
  if (remediation) parts.push(remediation);
  const confidence = ISSUE_CONFIDENCE[ruleId];
  if (confidence) parts.push(`Confidence: ${confidence}`);
  return parts.join('\n');
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/** PostToolUse: scan the edited file; findings go to Claude as additionalContext. */
export async function handlePostToolUse(targetFile: string, cwd: string, options: HookOptions = {}): Promise<HookOutput | null> {
  if (!isScannableFile(targetFile) || !fs.existsSync(targetFile)) return null;
  // Isolated runs resolve ignore patterns against the target, so use the project root:
  // from the file's own directory, dist/x.js would look like x.js and escape **/dist/**.
  const relative = path.relative(cwd, targetFile);
  const inProject = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const targetPath = options.isolated && inProject ? cwd : path.dirname(targetFile);
  const result = await runEslint({ preset: 'agent', targetPath, files: [targetFile], isolated: options.isolated });
  if (result.totalIssues === 0) return null;

  // One file was linted, so every finding belongs to it.
  const findings = result.files.flatMap((file) =>
    file.issues.map((issue) => formatFinding(issue.ruleId, targetFile, issue.line, issue.column, issue.message, cwd)));
  const count = findings.length;
  const text = [`AI Guard found ${count} issue${count !== 1 ? 's' : ''} in the file you just edited. Fix them before moving on.`, '', findings.join('\n\n---\n\n')].join('\n');
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
}

/** SessionStart: record the starting commit. Prints nothing: SessionStart stdout becomes Claude context. */
export function handleSessionStart(payload: HookPayload, cwd: string): null {
  if (isValidSessionId(payload.session_id)) startSession(cwd, payload.session_id);
  return null;
}

/**
 * Stop: verify the session's changes.
 *  - New findings (not reported earlier in this session) go to Claude once, as
 *    additionalContext, which keeps the turn going.
 *  - When Claude stops again with findings it was already told about, the stop is
 *    allowed and the user sees a one-line systemMessage. No loops.
 */
export async function handleStop(payload: HookPayload, cwd: string, options: HookOptions = {}): Promise<HookOutput | null> {
  const sessionId = isValidSessionId(payload.session_id) ? payload.session_id : null;
  let state: SessionState | null = sessionId ? loadSession(cwd, sessionId) : null;
  const baseCommit = usableBaseCommit(cwd, state);

  const report = await verifyChange({ cwd, baseCommit, isolated: options.isolated });
  if (!report.success) {
    // Not a Git repository: nothing to verify. Other failures: tell the user once, never block.
    if (report.errors.some((e) => e.code === 'GIT_FAILED')) return null;
    return payload.stop_hook_active ? null : { systemMessage: `AI Guard could not verify this change: ${report.errors.map((e) => e.message).join('; ')}` };
  }

  const items = [...report.blocking, ...report.disclosures];
  if (items.length === 0) {
    // A file that does not parse was not verified; say so rather than implying it was.
    const unparsed = report.errors.filter((e) => e.code === 'PARSE_ERROR' && e.file).map((e) => e.file);
    return unparsed.length > 0 && !payload.stop_hook_active ? { systemMessage: `AI Guard could not parse ${unparsed.join(', ')}, so this change was not fully verified.` } : null;
  }

  const reported = new Set(state?.reported ?? []);
  const fresh = items.filter((item) => !reported.has(item.id));

  // Without a session id nothing is remembered between stops, so a second stop in the
  // same sequence must not block again (it would loop until the continuation cap).
  if (fresh.length > 0 && (sessionId || !payload.stop_hook_active)) {
    if (sessionId) {
      const now = new Date().toISOString();
      state = state ?? { version: 1, baseCommit: baseCommit ?? null, reported: [], createdAt: now, updatedAt: now };
      saveSession(cwd, sessionId, { ...state, reported: [...state.reported, ...fresh.map((i) => i.id)] });
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: formatVerifyForAgent(report, new Set(fresh.map((i) => i.id))),
      },
    };
  }

  // Claude already had its chance to act on these findings in this stop sequence.
  return payload.stop_hook_active ? { systemMessage: formatVerifyForUser(report) } : null;
}

/** Routes a payload to its handler. Unknown events are ignored. */
export async function dispatchHook(payload: HookPayload, cwd: string, options: HookOptions = {}): Promise<HookOutput | null> {
  const event = payload.hook_event_name ?? (payload.tool_input ? 'PostToolUse' : undefined);
  let output: HookOutput | null = null;
  if (event === 'Stop') {
    output = await handleStop(payload, cwd, options);
  } else if (event === 'SessionStart') {
    output = handleSessionStart(payload, cwd);
  } else if (event === 'PostToolUse') {
    const raw = payload.tool_input?.file_path ?? payload.tool_input?.path;
    if (typeof raw === 'string' && raw) output = await handlePostToolUse(resolveFilePath(raw, cwd), cwd, options);
  }
  return output;
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerClaudeHookCommand(program: Command): void {
  program
    .command('claude-hook')
    .description('Internal: Claude Code hook entrypoint for PostToolUse, Stop and SessionStart (reads JSON from stdin)')
    .option('--file <path>', 'Override: scan this file instead of reading stdin (for testing)')
    .option('--isolated', 'Use the rules bundled with this CLI, for projects without AI Guard installed (Claude Code plugin)')
    .action(async (opts: { file?: string; isolated?: boolean }) => {
      const options: HookOptions = { isolated: opts.isolated };
      try {
        let output: HookOutput | null;
        if (opts.file) {
          output = await handlePostToolUse(resolveFilePath(opts.file, process.cwd()), process.cwd(), options);
        } else {
          const payload = parseHookPayload(await readStdin());
          if (!payload) {
            debug('Empty or invalid hook payload');
            process.exit(0);
            return;
          }
          const cwd = typeof payload.cwd === 'string' && payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : process.cwd();
          output = await dispatchHook(payload, cwd, options);
        }
        if (output) process.stdout.write(JSON.stringify(output) + '\n');
      } catch (err) {
        // Never break Claude's session over an AI Guard failure.
        debug(`Hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(0);
    });
}
