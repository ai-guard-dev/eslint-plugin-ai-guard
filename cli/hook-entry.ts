/**
 * hook-entry.ts — fast entry point for agent hooks (bin: ai-guard-hook).
 *
 * Agents run hooks very often: Codex calls PreToolUse before every shell
 * command. The full CLI takes close to a second to start, so this entry point
 * reads the payload first and exits at once when there is nothing to check
 * (a shell command that names no package manager, Git or AI Guard). Only then
 * does it load the hook engine.
 *
 *   ai-guard-hook --agent claude|codex|cursor [--check-installs] [--bash-guard ask|deny|off] [--isolated] [--base <ref>]
 *
 * Always exits 0: a hook must never break the agent's workflow.
 */

import { canSkipQuickly, isAgentName } from './utils/hooks/agents.js';

function option(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i !== -1) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

const flag = (name: string): boolean => process.argv.slice(2).includes(name);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

const debug = (message: string): void => {
  if (process.env.AI_GUARD_DEBUG === '1') process.stderr.write(`[ai-guard] ${message}\n`);
};

async function main(): Promise<void> {
  const agent = option('--agent') ?? 'claude';
  if (!isAgentName(agent)) {
    debug(`Unknown --agent '${agent}'`);
    return;
  }
  const text = await readStdin();
  // Windows PowerShell (Cursor's shell on Windows) prefixes piped text with a byte-order mark.
  const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    debug('Hook payload is not JSON');
    return;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  if (canSkipQuickly(agent, payload as Record<string, unknown>)) return;

  const { runAgentHook, DEFAULT_STATE_DIR } = await import('./commands/claude-hook.js');
  const guard = option('--bash-guard');
  const output = await runAgentHook(agent, raw, {
    stateDir: process.env.AI_GUARD_STATE_DIR || DEFAULT_STATE_DIR,
    base: option('--base'),
    bashGuard: guard === 'deny' || guard === 'off' ? guard : 'ask',
    isolated: flag('--isolated'),
    checkInstalls: flag('--check-installs'),
  });
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main()
  .catch((error: unknown) => debug(`Hook error: ${error instanceof Error ? error.message : String(error)}`))
  .finally(() => process.exit(0));
