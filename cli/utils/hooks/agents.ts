/**
 * agents.ts — translate hook payloads between coding agents and AI Guard's
 * hook engine (which speaks Claude Code's protocol).
 *
 * Contracts, from each vendor's documentation:
 *
 *   Claude Code  PreToolUse / PostToolUse / Stop / SessionStart. The engine's
 *                native format; passed through unchanged.
 *   Codex        Same event names and nearly the same JSON. Differences:
 *                PreToolUse has no "ask" (it fails the hook), so ask becomes a
 *                deny that tells the agent to ask the user; edits arrive as
 *                apply_patch with the patch text in tool_input.command; a
 *                PostToolUse "block" replaces the tool result, so findings go
 *                in additionalContext instead.
 *   Cursor       beforeShellExecution {command, cwd} -> {permission, user_message,
 *                agent_message}; stop {status, loop_count} -> {followup_message};
 *                sessionStart is fire-and-forget. A permission hook that prints
 *                nothing lets the command run (only failClosed hooks block on
 *                missing output), so "no opinion" is no output, never "allow",
 *                which could skip the user's own approval settings.
 *
 * Dependency-free on purpose: the fast hook entry point imports it.
 */

export type AgentName = 'claude' | 'codex' | 'cursor';
export const AGENTS: readonly AgentName[] = ['claude', 'codex', 'cursor'];

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && (AGENTS as readonly string[]).includes(value);
}

export type EngineEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart';

/** What the engine receives (Claude Code's hook input). */
export interface EngineInput {
  hook_event_name: EngineEvent;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

export type EngineOutput = Record<string, unknown> | null;

export interface NormalizedHook {
  event: EngineEvent | null;
  inputs: EngineInput[];
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Files an apply_patch adds or updates (moves count under their new name; deletions are skipped). */
export function patchedFiles(patch: string): string[] {
  const files: string[] = [];
  let current: string | null = null;
  for (const line of patch.split(/\r?\n/)) {
    const added = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (added) {
      current = added[1].trim();
      files.push(current);
      continue;
    }
    const moved = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moved && current) {
      files[files.length - 1] = moved[1].trim();
      current = moved[1].trim();
    }
    if (/^\*\*\* Delete File: /.test(line)) current = null;
  }
  return [...new Set(files)];
}

/** Shell commands worth a full check: package managers, Git, AI Guard itself, HUSKY=0. */
const RELEVANT_COMMAND = /\b(?:npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack|git|ai-guard)\b|HUSKY\s*=/i;

/** Cursor matcher with the same meaning, so Cursor does not start the hook for other commands. */
export const CURSOR_SHELL_MATCHER = '\\b(?:npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack|git|ai-guard)\\b|HUSKY\\s*=';

function shellCommandOf(agent: AgentName, raw: Record<string, unknown>): string | undefined {
  if (agent === 'cursor') return str(raw.command);
  const input = raw.tool_input as Record<string, unknown> | undefined;
  return input ? str(input.command) : undefined;
}

/**
 * True when the payload certainly needs no work: a shell command that names
 * no package manager, Git or AI Guard. Lets the fast entry point exit without
 * loading the engine (most commands an agent runs).
 */
export function canSkipQuickly(agent: AgentName, raw: Record<string, unknown>): boolean {
  const event = str(raw.hook_event_name);
  const shellEvent = agent === 'cursor'
    ? event === 'beforeShellExecution'
    : event === 'PreToolUse' && str(raw.tool_name) !== 'apply_patch';
  if (!shellEvent) return false;
  const command = shellCommandOf(agent, raw);
  return command === undefined || !RELEVANT_COMMAND.test(command);
}

function cursorRoot(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): string | undefined {
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots.filter((r): r is string => typeof r === 'string' && r !== '') : [];
  return roots[0] ?? str(env.CURSOR_PROJECT_DIR) ?? str(env.CLAUDE_PROJECT_DIR);
}

/** Turn an agent's payload into engine inputs (several for a multi-file Codex patch). */
export function normalizeHookInput(agent: AgentName, raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): NormalizedHook {
  if (agent === 'claude') {
    const event = (str(raw.hook_event_name) ?? (raw.tool_input ? 'PostToolUse' : undefined)) as EngineEvent | undefined;
    return { event: event ?? null, inputs: event ? [{ ...raw, hook_event_name: event }] : [] };
  }

  if (agent === 'cursor') {
    const session_id = str(raw.conversation_id) ?? str(raw.session_id);
    const root = cursorRoot(raw, env);
    switch (str(raw.hook_event_name)) {
      case 'beforeShellExecution': {
        const command = str(raw.command);
        if (!command) return { event: 'PreToolUse', inputs: [] };
        return { event: 'PreToolUse', inputs: [{ hook_event_name: 'PreToolUse', session_id, cwd: str(raw.cwd) ?? root, tool_name: 'Bash', tool_input: { command } }] };
      }
      case 'stop':
        // An aborted or failed turn is the user's call; never push the agent to continue it.
        if (raw.status !== undefined && raw.status !== 'completed') return { event: 'Stop', inputs: [] };
        return { event: 'Stop', inputs: [{ hook_event_name: 'Stop', session_id, cwd: root, stop_hook_active: Number(raw.loop_count ?? 0) > 0 }] };
      case 'sessionStart':
        return { event: 'SessionStart', inputs: [{ hook_event_name: 'SessionStart', session_id, cwd: root, source: 'startup' }] };
      default:
        return { event: null, inputs: [] };
    }
  }

  // Codex
  const event = str(raw.hook_event_name) as EngineEvent | undefined;
  const base = { session_id: str(raw.session_id), cwd: str(raw.cwd) };
  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
  const toolName = str(raw.tool_name);
  switch (event) {
    case 'PreToolUse': {
      if (toolName === 'apply_patch' || toolName === 'Edit' || toolName === 'Write') return { event, inputs: [] };
      const command = str(toolInput.command);
      return { event, inputs: command ? [{ ...base, hook_event_name: event, tool_name: 'Bash', tool_input: { command } }] : [] };
    }
    case 'PostToolUse': {
      const direct = str(toolInput.file_path) ?? str(toolInput.path);
      const files = direct ? [direct] : toolName === 'apply_patch' || str(toolInput.command)?.includes('*** Begin Patch') ? patchedFiles(str(toolInput.command) ?? '') : [];
      return { event, inputs: files.map((file) => ({ ...base, hook_event_name: event, tool_name: 'Edit', tool_input: { file_path: file } })) };
    }
    case 'Stop':
      return { event, inputs: [{ ...base, hook_event_name: event, stop_hook_active: raw.stop_hook_active === true }] };
    case 'SessionStart':
      return { event, inputs: [{ ...base, hook_event_name: event, source: str(raw.source) ?? 'startup' }] };
    default:
      return { event: null, inputs: [] };
  }
}

interface PreToolUseOut {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  additionalContext?: string;
}

function preToolUseOf(output: EngineOutput): PreToolUseOut | null {
  const specific = output?.hookSpecificOutput as PreToolUseOut | undefined;
  return specific ?? null;
}

/** Turn engine outputs back into what the agent expects. Null: print nothing. */
export function translateHookOutput(agent: AgentName, event: EngineEvent | null, outputs: EngineOutput[]): Record<string, unknown> | null {
  const present = outputs.filter((o): o is Record<string, unknown> => o !== null);
  if (present.length === 0 || event === null) return null;
  if (agent === 'claude') return present[0];

  if (agent === 'cursor') {
    if (event === 'PreToolUse') {
      const out = preToolUseOf(present[0]);
      const decision = out?.permissionDecision;
      if (decision !== 'deny' && decision !== 'ask') return null; // warnings only: Cursor has no channel for them here
      const reason = out?.permissionDecisionReason ?? '';
      const agentMessage = [reason, out?.additionalContext].filter(Boolean).join('\n\n');
      return { permission: decision, user_message: reason, agent_message: agentMessage };
    }
    if (event === 'Stop') {
      const reason = str(present[0].reason);
      return present[0].decision === 'block' && reason ? { followup_message: reason } : null;
    }
    return null;
  }

  // Codex
  if (event === 'PreToolUse') {
    const out = preToolUseOf(present[0]);
    if (!out) return null;
    const result: PreToolUseOut & { hookEventName: string } = { hookEventName: 'PreToolUse' };
    if (out.permissionDecision === 'deny' || out.permissionDecision === 'ask') {
      result.permissionDecision = 'deny';
      result.permissionDecisionReason = out.permissionDecision === 'ask'
        ? `This command needs the user's confirmation, and this agent cannot ask for it here. Ask the user before running it.\n\n${out.permissionDecisionReason ?? ''}`.trim()
        : out.permissionDecisionReason;
    }
    if (out.additionalContext) result.additionalContext = out.additionalContext;
    return Object.keys(result).length > 1 ? { hookSpecificOutput: result } : null;
  }
  if (event === 'PostToolUse') {
    // A Codex PostToolUse "block" replaces the tool result, so everything goes in additionalContext.
    const parts: string[] = [];
    for (const o of present) {
      if (o.decision === 'block' && str(o.reason)) parts.push(`Fix before you continue:\n${o.reason as string}`);
      const context = str((o.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext);
      if (context) parts.push(context);
    }
    return parts.length > 0 ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n') } } : null;
  }
  if (event === 'Stop') return present[0];
  return null; // SessionStart: plain stdout would become context, so print nothing
}
