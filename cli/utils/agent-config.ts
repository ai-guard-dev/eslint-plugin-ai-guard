/**
 * agent-config.ts — scanner for files that steer AI coding agents.
 *
 * Instruction files (CLAUDE.md, AGENTS.md, .cursorrules, Copilot instructions,
 * skills and commands) and agent configuration (MCP server configs, Claude
 * settings, plugin hooks) are executable in effect: an agent follows them. This
 * module finds the patterns behind documented attacks on them:
 *
 *  - invisible Unicode and hidden tag text ("Rules File Backdoor")
 *  - instructions hidden in HTML comments (invisible in rendered Markdown)
 *  - pipe-to-shell installs, external scripts, credential reads, exfiltration
 *  - phrases that tell the agent to hide what it did from the user
 *  - MCP servers started from unpinned packages, inline secrets, plain-HTTP remotes
 *  - Claude settings that auto-approve MCP servers or bypass permission prompts
 *
 * Deterministic and offline. Each check has a fixed severity: `error` for
 * patterns that are almost never legitimate in agent config, `warning` for
 * patterns a human should review.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { findRuns, decodeHiddenText, describeChars, hasInvisibleCandidates } from '../../src/utils/invisible-unicode.js';
import { tryParseJsonc } from '../../src/utils/jsonc.js';
import { isGenericSecretEnvName } from '../../src/utils/env-access.js';
import { isBrowserForbiddenName } from '../../src/rules/security/no-client-exposed-secret.js';
import { AGENT_CONFIG_CHECKS, type AgentConfigCheck } from './check-catalog.js';

export { AGENT_CONFIG_CHECKS, type AgentConfigCheck };

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentFileKind = 'instructions' | 'mcp-config' | 'claude-settings' | 'plugin-hooks';

export interface AgentConfigFinding {
  check: AgentConfigCheck;
  severity: 'error' | 'warning';
  /** Repository-relative POSIX path. */
  file: string;
  line: number;
  column: number;
  message: string;
  /** Short, printable excerpt of the matched text. */
  excerpt?: string;
}

export interface McpServerInfo {
  file: string;
  name: string;
  line: number;
  transport: 'stdio' | 'http';
  /** The launch command or URL, as written. */
  launch: string;
  /** Package spec for package-runner launches (npx, uvx, docker, ...). */
  package?: string;
  pinned?: boolean;
  /** First 12 hex chars of SHA-256 over the canonical server entry. */
  fingerprint: string;
}

export interface AgentConfigReport {
  root: string;
  files: string[];
  findings: AgentConfigFinding[];
  servers: McpServerInfo[];
  errorCount: number;
  warningCount: number;
  durationMs: number;
  lock: { file: string; status: 'not-found' | 'checked' | 'updated' };
}

// ─── File discovery ───────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', '.turbo', '.nx',
  'vendor', 'tmp', 'temp', '.venv', 'venv', '__pycache__', 'target', '.svelte-kit', '.expo', 'storybook-static',
  '.vercel', '.output', '.parcel-cache', '.yarn', 'bower_components',
]);

const INSTRUCTION_BASENAMES = new Set([
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENT.md', 'GEMINI.md', '.cursorrules', '.windsurfrules',
  '.clinerules', '.roorules', '.goosehints',
]);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIR_ENTRIES = 100000;
const MAX_DEPTH = 16;

/**
 * Classifies a repository-relative POSIX path, or returns null for unrelated files.
 * With `root`, `hooks/hooks.json` counts only inside a Claude plugin (next to `.claude-plugin/`).
 */
export function classifyAgentConfigPath(relPath: string, root?: string): AgentFileKind | null {
  const p = relPath.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? '';
  const inDir = (dir: string): boolean => p.startsWith(dir + '/') || p.includes('/' + dir + '/');

  if (base === '.mcp.json') return 'mcp-config';
  if (/(?:^|\/)\.(?:cursor|vscode|roo)\/mcp\.json$/.test(p)) return 'mcp-config';
  if (/(?:^|\/)\.windsurf\/mcp(?:_config)?\.json$/.test(p)) return 'mcp-config';
  if (/(?:^|\/)\.gemini\/settings\.json$/.test(p)) return 'mcp-config';
  if (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(p)) return 'claude-settings';
  const hooks = /^(?:(.*)\/)?hooks\/hooks\.json$/.exec(p);
  if (hooks && root && fs.existsSync(path.join(root, hooks[1] ?? '', '.claude-plugin'))) return 'plugin-hooks';

  if (INSTRUCTION_BASENAMES.has(base)) return 'instructions';
  if (/(?:^|\/)\.github\/copilot-instructions\.md$/.test(p)) return 'instructions';
  if (/(?:^|\/)\.github\/instructions\/.+\.instructions\.md$/.test(p)) return 'instructions';
  if (/(?:^|\/)\.github\/(?:prompts|chatmodes)\/.+\.(?:prompt|chatmode)\.md$/.test(p)) return 'instructions';
  if (!/\.(?:md|mdc|txt)$/i.test(base)) return null;
  if (inDir('.cursor/rules') || inDir('.windsurf/rules') || inDir('.clinerules') || inDir('.roo')) return 'instructions';
  if (inDir('.claude/commands') || inDir('.claude/agents') || inDir('.claude/skills')) return 'instructions';
  if (inDir('.agents') || inDir('.continue/rules')) return 'instructions';
  return null;
}

/** Plugin component files: <plugin>/{commands,agents,skills}/**.md next to .claude-plugin/. */
function isPluginComponent(relPath: string, pluginRoots: Set<string>): boolean {
  for (const root of pluginRoots) {
    const prefix = root === '' ? '' : root + '/';
    if (!relPath.startsWith(prefix)) continue;
    const rest = relPath.slice(prefix.length);
    if (/^(?:commands|agents|skills)\/.+\.md$/i.test(rest)) return true;
  }
  return false;
}

/** Finds agent instruction and config files under `root`, repository-relative and sorted. */
export function discoverAgentConfigFiles(root: string): string[] {
  const found: string[] = [];
  const pluginRoots = new Set<string>();
  const markdown: string[] = [];
  let entries = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let handle: fs.Dir;
    try {
      handle = fs.opendirSync(dir);
    } catch {
      return;
    }
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        if (++entries > MAX_DIR_ENTRIES) return;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          if (entry.name === '.claude-plugin') pluginRoots.add(rel);
          walk(path.join(dir, entry.name), childRel, depth + 1);
        } else if (entry.isFile()) {
          if (classifyAgentConfigPath(childRel, root)) found.push(childRel);
          else if (/\.md$/i.test(entry.name)) markdown.push(childRel);
        }
      }
    } finally {
      handle.closeSync();
    }
  };
  walk(root, '', 0);

  for (const rel of markdown) if (isPluginComponent(rel, pluginRoots)) found.push(rel);
  return [...new Set(found)].sort();
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function locate(starts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

const NON_PRINTABLE = /[^\x20-\x7E]/g;

function excerpt(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim().replace(NON_PRINTABLE, '?');
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

// ─── Instruction patterns ─────────────────────────────────────────────────────

interface PatternCheck {
  check: AgentConfigCheck;
  pattern: RegExp;
  message: string;
  /**
   * Report only when hidden (inside an HTML comment). Visible CDN <script> tags are
   * normal in web-development skills; the Rules File Backdoor hid its script tag.
   */
  hiddenOnly?: boolean;
  /** Skip matches preceded by a negation on the same line ("never read id_rsa" is a protection). */
  negatable?: boolean;
}

/** "Never ...", "do not ...", "avoid ..." shortly before the match, on the same line. */
function isNegated(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(Math.max(lineStart, index - 48), index);
  return /\b(?:never|not|don't|do not|avoid|skip|exclude|without|no|must not|should not|forbid(?:den)?)\b[^.!?]*$/i.test(before);
}

const REMOTE_CODE_PATTERNS: RegExp[] = [
  /\b(?:curl|wget)\b[^\n|`]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/i,
  /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]{0,200}\|\s*(?:iex|Invoke-Expression)\b/i,
  /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b/i,
  /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i,
  /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,200}\|\s*(?:ba|z)?sh\b/i,
];

/** Local secret stores: the things an exfiltration payload asks for. */
const SENSITIVE_LOCATION =
  '(?:\\.env(?:\\.\\w+)?\\b|~\\/\\.ssh|\\bid_(?:rsa|ed25519|ecdsa)\\b|\\.aws\\/credentials|\\bcredentials? files?\\b|\\benv(?:ironment)? (?:variables|vars)\\b|\\bprocess\\.env\\b|\\bkeychain\\b|\\bsecrets? (?:file|directory|folder)\\b)';

const INSTRUCTION_PATTERNS: PatternCheck[] = [
  ...REMOTE_CODE_PATTERNS.map((pattern) => ({
    check: 'remote-code-execution' as const,
    pattern,
    message: 'Tells the agent to pipe a downloaded script into a shell. Whoever controls that URL controls what runs on the developer machine.',
    negatable: true,
  })),
  {
    check: 'external-script',
    pattern: /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]+/i,
    message: 'Contains an external <script src> for the agent to add. This is the payload of the "Rules File Backdoor" attack on Cursor and Copilot rule files.',
    hiddenOnly: true,
    negatable: true,
  },
  {
    check: 'concealment',
    pattern: /\b(?:do not|don't|never)\s+(?:mention|reveal|disclose|acknowledge|reference|discuss|explain|report)\s+(?:this|these|that you|any of this|the following)\b/i,
    message: 'Asks the agent not to mention what it does. Legitimate project instructions never ask the agent to hide its actions from the user.',
  },
  {
    check: 'concealment',
    // "...tell the user about this / what you did", not "do not tell users their password is wrong" (UI copy)
    pattern: /\b(?:do not|don't|never)\s+(?:tell|inform)\s+(?:the\s+)?(?:user|human|developer|reviewer|operator)s?\s+(?:about|that you|what you|you|this|these|anything)\b/i,
    message: 'Asks the agent to keep something from the user.',
  },
  {
    check: 'concealment',
    pattern: /\bwithout\s+(?:telling|informing|notifying)\s+(?:the\s+)?(?:user|human|developer|reviewer)s?\b/i,
    message: 'Asks the agent to act without telling the user.',
  },
  {
    check: 'concealment',
    pattern: /\b(?:hide|conceal|obscure)\s+(?:this|these|the|any|all)\s+(?:change|changes|modification|modifications|step|steps|instruction|instructions|action|actions|edit|edits|line|lines|code)\s+from\s+(?:the\s+)?(?:user|human|developer|reviewer|review|summary|commit|diff|log|output)s?\b/i,
    message: 'Asks the agent to hide its changes from the user or the review.',
  },
  {
    check: 'concealment',
    pattern: /\b(?:omit|exclude|leave out)\s+(?:this|these|it|them)\s+from\s+(?:the\s+|your\s+)?(?:summary|commit message|response|reply|explanation|output|changelog)\b/i,
    message: 'Asks the agent to leave something out of what it reports.',
  },
  {
    check: 'instruction-override',
    pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system|original|other)\s+(?:instructions?|prompts?|rules?|directions?|messages?|guidelines?)\b/i,
    message: 'Tries to override earlier instructions, the signature of a prompt-injection payload.',
  },
  {
    check: 'credential-access',
    // A read/send action on a key or token file. Mentions alone ("never read id_rsa",
    // "credentials in ~/.aws/credentials") are documentation, and `id_rsa.pub` is public.
    pattern: /\b(?:read|cat|open|load|include|print|output|dump|send|upload|copy|attach|paste|pass|exfiltrate|base64)\b[^.\n]{0,60}?(?:(?:~|\$HOME|%USERPROFILE%)[\\/]\.(?:ssh[\\/](?:id_\w+|authorized_keys)|aws[\\/]credentials|kube[\\/]config|docker[\\/]config\.json|gnupg|npmrc|netrc|git-credentials|config[\\/]gcloud|cursor[\\/]mcp\.json|claude\.json)\b(?!\.pub)|\bid_(?:rsa|ed25519|ecdsa|dsa)\b(?!\.pub)|\.aws[\\/]credentials\b|\/etc\/shadow\b)/i,
    message: 'Points the agent at credential files (SSH keys, cloud credentials, agent configs). Poisoned MCP tools and rule files use this to steal keys.',
    negatable: true,
  },
  {
    check: 'exfiltration',
    pattern: new RegExp(`\\b(?:send|post|upload|exfiltrate|transmit|forward|leak|copy|pipe)\\b[^.\\n]{0,120}${SENSITIVE_LOCATION}[^.\\n]{0,120}https?:\\/\\/`, 'i'),
    message: 'Tells the agent to send local secrets to a URL.',
    negatable: true,
  },
  {
    check: 'exfiltration',
    pattern: new RegExp(`${SENSITIVE_LOCATION}[^.\\n]{0,120}\\b(?:to|into)\\s+https?:\\/\\/`, 'i'),
    message: 'Tells the agent to send local secrets to a URL.',
    negatable: true,
  },
];

/** Markers that make an HTML comment tooling metadata rather than hidden instructions. */
const TOOLING_COMMENT =
  /^\s*(?:generated|auto-?generated|do not edit|prettier-ignore|markdownlint|toc|end ?toc|cspell|vale|eslint|lint-|begin|end|region|endregion|ai-guard|omit in toc|no ?toc|copilot-instructions)/i;
/** Comments that address the AI explicitly. "You" alone is how docs talk to human editors. */
const AI_DIRECTED = /\b(?:assistant|ai|agent|claude|copilot|cursor|model|llm|gemini|codex|windsurf|cline)\b|\bwhen (?:generating|writing|editing|creating|modifying)\b/i;
const IMPERATIVE = /\b(?:always|never|must|do not|don't|ignore|instead|make sure|ensure|run|execute|install|insert|send|fetch|download|add|remove|delete|disable)\b/i;

function htmlCommentRanges(text: string): Array<{ start: number; end: number; body: string }> {
  const ranges: Array<{ start: number; end: number; body: string }> = [];
  const re = /<!--([\s\S]*?)(?:-->|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length, body: match[1] });
    if (match[0].length === 0) re.lastIndex++;
  }
  return ranges;
}

// ─── Invisible Unicode ────────────────────────────────────────────────────────

function scanInvisible(file: string, text: string, starts: number[], out: AgentConfigFinding[]): void {
  if (!hasInvisibleCandidates(text)) return;
  for (const run of findRuns(text)) {
    const { line, column } = locate(starts, run.start);
    const hidden = decodeHiddenText(run);
    if (hidden !== null) {
      out.push({
        check: 'hidden-text', severity: 'error', file, line, column,
        message: `Invisible Unicode characters encode hidden text: "${hidden}". Humans cannot see it, but AI tools read it as instructions.`,
        excerpt: hidden,
      });
    } else {
      const kind = run.kind === 'bidi' ? 'Bidirectional control character' : 'Invisible character';
      out.push({
        check: 'invisible-character', severity: 'error', file, line, column,
        message: `${kind} ${describeChars(run.codePoints)}. It changes what an AI reads without being visible in an editor or code review.`,
      });
    }
  }
}

// ─── Instruction files ────────────────────────────────────────────────────────

export function scanInstructionText(file: string, text: string): AgentConfigFinding[] {
  const findings: AgentConfigFinding[] = [];
  const starts = lineStarts(text);
  scanInvisible(file, text, starts, findings);

  const comments = htmlCommentRanges(text);
  const commentsWithFindings = new Set<number>();

  for (const { check, pattern, message, hiddenOnly, negatable } of INSTRUCTION_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
      const { line, column } = locate(starts, match.index);
      const hiddenIndex = comments.findIndex((c) => match!.index >= c.start && match!.index < c.end);
      if ((hiddenIndex < 0 && hiddenOnly) || (negatable && isNegated(text, match.index))) {
        if (match[0].length === 0) global.lastIndex++;
        continue;
      }
      if (hiddenIndex >= 0) {
        commentsWithFindings.add(hiddenIndex);
        findings.push({
          check: 'hidden-instructions', severity: 'error', file, line, column,
          message: `Hidden in an HTML comment, which rendered Markdown does not show: ${message}`,
          excerpt: excerpt(match[0]),
        });
      } else {
        findings.push({ check, severity: AGENT_CONFIG_CHECKS[check].severity, file, line, column, message, excerpt: excerpt(match[0]) });
      }
      if (match[0].length === 0) global.lastIndex++;
    }
  }

  // HTML comments that address the agent, without a more specific finding.
  comments.forEach((comment, index) => {
    if (commentsWithFindings.has(index)) return;
    const body = comment.body.trim();
    if (body.length < 20 || TOOLING_COMMENT.test(body)) return;
    if (!AI_DIRECTED.test(body) || !IMPERATIVE.test(body)) return;
    const { line, column } = locate(starts, comment.start);
    findings.push({
      check: 'hidden-comment', severity: 'warning', file, line, column,
      message: 'An HTML comment gives the agent instructions. Comments are invisible on GitHub and in rendered Markdown, so reviewers do not see what the agent is told.',
      excerpt: excerpt(body),
    });
  });

  return findings;
}

// ─── MCP servers ──────────────────────────────────────────────────────────────

const DIST_TAGS = new Set(['latest', 'next', 'beta', 'alpha', 'canary', 'rc', 'nightly', 'dev', 'experimental', 'insiders']);
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

interface PackageLaunch {
  runner: string;
  spec: string;
  pinned: boolean;
  reason?: string;
}

function isLocalSpec(spec: string): boolean {
  return /^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/]|file:|~[\\/])/i.test(spec) || /\.(?:m?js|cjs|ts|py|sh|exe)$/i.test(spec);
}

/** Parses an npm package spec: name@version, @scope/name@version, npm:name@version. */
function npmSpecPinned(rawSpec: string): { pinned: boolean; reason?: string } {
  const spec = rawSpec.replace(/^npm:/, '');
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:)/i.test(spec)) {
    return /#[0-9a-f]{40}$/i.test(spec) ? { pinned: true } : { pinned: false, reason: 'a Git or URL source without a commit hash' };
  }
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  if (at <= 0) return { pinned: false, reason: 'no version' };
  const version = spec.slice(at + 1);
  if (DIST_TAGS.has(version.toLowerCase())) return { pinned: false, reason: `the "${version}" tag` };
  if (EXACT_VERSION.test(version)) return { pinned: true };
  return { pinned: false, reason: `the version range "${version}"` };
}

const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '--prefix']);
const UVX_VALUE_FLAGS = new Set(['--from', '--with', '--with-requirements', '--python', '-p', '--index-url', '--extra-index-url', '--index', '--default-index', '--directory', '--project']);
const DOCKER_VALUE_FLAGS = new Set([
  '-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '--network', '--net', '--env-file', '-w', '--workdir',
  '--entrypoint', '--mount', '-u', '--user', '--platform', '--pull', '-l', '--label', '--cpus', '-m', '--memory', '--add-host',
  '--cap-add', '--cap-drop', '--security-opt', '--hostname', '-h', '--device', '--gpus', '--ulimit', '--restart',
]);

/** Recognizes package-runner launches and whether they pin what they run. */
export function analyzeLaunch(tokens: string[]): PackageLaunch | null {
  if (tokens.length === 0) return null;
  // Split on both separators: configs written on Windows use C:\...\npx.cmd on any OS.
  const runner = (tokens[0].split(/[\\/]/).pop() ?? '').replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase();
  let rest = tokens.slice(1);

  const firstPositional = (args: string[], valueFlags: Set<string>): { spec: string | null; flagValue: Map<string, string> } => {
    const flagValue = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') return { spec: args[i + 1] ?? null, flagValue };
      if (arg.startsWith('-')) {
        const [flag, inline] = arg.split('=', 2);
        if (valueFlags.has(flag)) {
          const value = inline ?? args[++i];
          if (value !== undefined) flagValue.set(flag, value);
        }
        continue;
      }
      return { spec: arg, flagValue };
    }
    return { spec: null, flagValue };
  };

  if (runner === 'pnpm' || runner === 'yarn') {
    if (rest[0] !== 'dlx') return null;
    rest = rest.slice(1);
  } else if (runner === 'npm') {
    if (rest[0] !== 'exec' && rest[0] !== 'x') return null;
    rest = rest.slice(1);
  }

  if (['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'npm'].includes(runner)) {
    const { spec, flagValue } = firstPositional(rest, NPX_VALUE_FLAGS);
    const pkg = flagValue.get('-p') ?? flagValue.get('--package') ?? spec;
    if (!pkg || isLocalSpec(pkg)) return null;
    const { pinned, reason } = npmSpecPinned(pkg);
    return { runner, spec: pkg, pinned, reason };
  }

  if (runner === 'uvx' || (runner === 'uv' && rest[0] === 'tool' && rest[1] === 'run') || (runner === 'pipx' && rest[0] === 'run')) {
    if (runner === 'uv') rest = rest.slice(2);
    if (runner === 'pipx') rest = rest.slice(1);
    const { spec, flagValue } = firstPositional(rest, UVX_VALUE_FLAGS);
    const pkg = flagValue.get('--from') ?? spec;
    if (!pkg || isLocalSpec(pkg)) return null;
    if (/^git\+/i.test(pkg)) {
      return /@[0-9a-f]{40}$/i.test(pkg) ? { runner, spec: pkg, pinned: true } : { runner, spec: pkg, pinned: false, reason: 'a Git source without a commit hash' };
    }
    const pinned = /==\s*\d|@\d/.test(pkg);
    return { runner, spec: pkg, pinned, reason: pinned ? undefined : 'no version' };
  }

  if (runner === 'docker' || runner === 'podman') {
    if (rest[0] !== 'run') return null;
    const { spec } = firstPositional(rest.slice(1), DOCKER_VALUE_FLAGS);
    if (!spec) return null;
    if (/@sha256:[0-9a-f]{64}$/i.test(spec)) return { runner, spec, pinned: true };
    const lastSegment = spec.split('/').pop() ?? spec;
    const tag = lastSegment.includes(':') ? lastSegment.split(':').pop() ?? '' : '';
    if (!tag || tag === 'latest') return { runner, spec, pinned: false, reason: tag ? 'the "latest" tag' : 'no tag' };
    return { runner, spec, pinned: true };
  }

  if (runner === 'deno') {
    const spec = rest.find((arg) => /^(?:npm|jsr):/.test(arg));
    if (!spec) return null;
    const { pinned, reason } = npmSpecPinned(spec.replace(/^jsr:/, ''));
    return { runner, spec, pinned, reason };
  }
  return null;
}

/** Values that are references, not secrets: ${VAR}, ${env:X}, ${input:x}, <your-key>, YOUR_API_KEY. */
const PLACEHOLDER =
  /^\s*(?:Bearer\s+|Token\s+|Basic\s+)?(?:\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|<[^>]+>|\{\{[^}]+\}\}|op:\/\/\S+|(?:your|my|insert|replace|enter|add)[-_ ].*|.*\b(?:YOUR|REPLACE|CHANGE_?ME|PLACEHOLDER|EXAMPLE|XXX+)\b.*|x{4,}|\*{3,}|\.{3})\s*$/i;

/** Credential formats with a distinctive prefix. Publishable keys (pk_live_) are public by design. */
const KNOWN_TOKEN =
  /\b(?:sk-(?:proj-|ant-(?:api\d{2}-)?|svcacct-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}|SG\.[\w-]{16,}\.[\w-]{16,}|hf_[A-Za-z0-9]{30,}|pplx-[A-Za-z0-9]{40,}|lin_api_[A-Za-z0-9]{30,}|sk_[a-f0-9]{48})\b/;

/**
 * Env names that hold credentials. Reuses the rule classifiers, which know that
 * AUTH_MODE, TOKEN_URL or API_KEY_HEADER describe settings rather than secrets.
 */
function isSecretKeyName(key: string): boolean {
  return isGenericSecretEnvName(key) || isBrowserForbiddenName(key);
}
const SECRET_HEADER = /^(?:authorization|x-api-key|api-key|x-auth-token|x-access-token|x-goog-api-key|cookie)$/i;
const SECRET_ARG_FLAG = /^--?(?:api[-_]?key|token|access[-_]?token|secret|password|auth|bearer)(?:=(.*))?$/i;

function redact(value: string): string {
  const v = value.trim();
  return v.length <= 8 ? '[redacted]' : `${v.slice(0, 4)}... (${v.length} chars)`;
}

function isSecretValue(value: string, keyLooksSecret: boolean): boolean {
  if (PLACEHOLDER.test(value)) return false;
  if (KNOWN_TOKEN.test(value)) return true;
  const bare = value.replace(/^\s*(?:Bearer|Token|Basic)\s+/i, '').trim();
  return keyLooksSecret && bare.length >= 12 && !/\s/.test(bare) && !/^(?:true|false|null|\d+)$/i.test(bare);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeServerFingerprint(entry: unknown): string {
  return createHash('sha256').update(canonicalJson(entry), 'utf8').digest('hex').slice(0, 12);
}

function keyLine(text: string, starts: number[], key: string, from = 0): { line: number; column: number; index: number } {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"${escaped}"\\s*:`, 'g');
  re.lastIndex = from;
  const match = re.exec(text);
  const index = match ? match.index : from;
  return { ...locate(starts, index), index };
}

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127\./.test(host) || host.endsWith('.local') || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

function checkHookCommand(
  command: string, file: string, at: { line: number; column: number }, findings: AgentConfigFinding[], label: string,
): void {
  for (const pattern of REMOTE_CODE_PATTERNS) {
    if (pattern.test(command)) {
      findings.push({
        check: 'hook-remote-code', severity: 'error', file, ...at,
        message: `${label} pipes a downloaded script into a shell. Hooks run automatically for everyone who opens the repository with the agent.`,
        excerpt: excerpt(command),
      });
      return;
    }
  }
  const credential = INSTRUCTION_PATTERNS.find((p) => p.check === 'credential-access')!;
  if (credential.pattern.test(command)) {
    findings.push({
      check: 'credential-access', severity: 'warning', file, ...at,
      message: `${label} reads credential files.`,
      excerpt: excerpt(command),
    });
  }
}

function scanServers(
  file: string, text: string, starts: number[], servers: Record<string, unknown>, searchFrom: number,
  findings: AgentConfigFinding[], infos: McpServerInfo[],
): void {
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry)) continue;
    const at = keyLine(text, starts, name, searchFrom);
    const pos = { line: at.line, column: at.column };
    const fingerprint = computeServerFingerprint(entry);
    const url = [entry.url, entry.serverUrl, entry.httpUrl].find((u): u is string => typeof u === 'string');
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
    const command = typeof entry.command === 'string' ? entry.command : '';
    const tokens = command.includes(' ') && args.length === 0 ? command.trim().split(/\s+/) : [command, ...args].filter(Boolean);

    let info: McpServerInfo;
    if (url && !command) {
      info = { file, name, line: at.line, transport: 'http', launch: url, fingerprint };
      if (/^http:\/\//i.test(url) && !isLocalHost(url)) {
        findings.push({
          check: 'insecure-transport', severity: 'warning', file, ...pos,
          message: `MCP server "${name}" connects to ${url} over plain HTTP, so tool calls and any credentials travel unencrypted.`,
        });
      }
      const query = /[?&](?:api[_-]?key|token|access_token|key|secret|auth)=([^&#\s]{8,})/i.exec(url);
      if ((query && !PLACEHOLDER.test(query[1])) || KNOWN_TOKEN.test(url)) {
        findings.push({
          check: 'inline-secret', severity: 'error', file, ...pos,
          message: `MCP server "${name}" has a credential in its URL. Committed config is readable by everyone with repository access.`,
        });
      }
    } else {
      const launch = analyzeLaunch(tokens);
      info = { file, name, line: at.line, transport: 'stdio', launch: tokens.join(' '), fingerprint };
      if (launch) {
        info.package = launch.spec;
        info.pinned = launch.pinned;
        if (!launch.pinned) {
          findings.push({
            check: 'unpinned-mcp-server', severity: 'warning', file, ...pos,
            message: `MCP server "${name}" runs \`${launch.runner} ${launch.spec}\` with ${launch.reason}, so each start can fetch a different release. A hijacked or malicious release runs with your privileges and sees every tool call. Pin an exact version.`,
          });
        }
      }
      // Secrets passed as arguments
      for (let i = 0; i < args.length; i++) {
        const flag = SECRET_ARG_FLAG.exec(args[i]);
        const value = flag ? (flag[1] ?? args[i + 1] ?? '') : args[i];
        if ((flag && value && isSecretValue(value, true)) || (!flag && KNOWN_TOKEN.test(args[i]))) {
          findings.push({
            check: 'inline-secret', severity: 'error', file, ...pos,
            message: `MCP server "${name}" passes a credential (${redact(value)}) on its command line. Committed config is readable by everyone with repository access.`,
          });
          break;
        }
      }
    }

    if (isRecord(entry.env)) {
      for (const [key, value] of Object.entries(entry.env)) {
        if (typeof value !== 'string') continue;
        const keyLooksSecret = isSecretKeyName(key);
        if (isSecretValue(value, keyLooksSecret)) {
          const keyAt = keyLine(text, starts, key, at.index);
          findings.push({
            check: 'inline-secret', severity: 'error', file, line: keyAt.line, column: keyAt.column,
            message: `MCP server "${name}" sets ${key} to a literal secret (${redact(value)}). Use a reference such as "\${env:${key}}" and rotate the key.`,
          });
        }
      }
    }
    if (isRecord(entry.headers)) {
      for (const [key, value] of Object.entries(entry.headers)) {
        if (typeof value !== 'string' || !SECRET_HEADER.test(key)) continue;
        if (isSecretValue(value, true)) {
          const keyAt = keyLine(text, starts, key, at.index);
          findings.push({
            check: 'inline-secret', severity: 'error', file, line: keyAt.line, column: keyAt.column,
            message: `MCP server "${name}" sends a literal ${key} header (${redact(value)}). Use an input or env reference and rotate the credential.`,
          });
        }
      }
    }
    infos.push(info);
  }
}

function scanHooks(file: string, text: string, starts: number[], hooks: unknown, findings: AgentConfigFinding[]): void {
  if (!isRecord(hooks)) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!isRecord(hook) || typeof hook.command !== 'string') continue;
        const args = Array.isArray(hook.args) ? hook.args.filter((a): a is string => typeof a === 'string') : [];
        const command = [hook.command, ...args].join(' ');
        const at = keyLine(text, starts, event);
        checkHookCommand(command, file, { line: at.line, column: at.column }, findings, `${event} hook`);
      }
    }
  }
}

function scanSecretsInEnv(file: string, text: string, starts: number[], env: unknown, findings: AgentConfigFinding[], label: string): void {
  if (!isRecord(env)) return;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (isSecretValue(value, isSecretKeyName(key))) {
      const at = keyLine(text, starts, key);
      findings.push({
        check: 'inline-secret', severity: 'error', file, line: at.line, column: at.column,
        message: `${label} sets ${key} to a literal secret (${redact(value)}). Committed settings are readable by everyone with repository access.`,
      });
    }
  }
}

/** Scans a JSON agent config (MCP config, Claude settings, plugin hooks). */
export function scanConfigText(file: string, text: string, kind: Exclude<AgentFileKind, 'instructions'>): { findings: AgentConfigFinding[]; servers: McpServerInfo[] } {
  const findings: AgentConfigFinding[] = [];
  const servers: McpServerInfo[] = [];
  const starts = lineStarts(text);
  scanInvisible(file, text, starts, findings);

  const config = tryParseJsonc(text);
  if (!isRecord(config)) {
    findings.push({
      check: 'invalid-config', severity: 'warning', file, line: 1, column: 1,
      message: 'This agent config file is not valid JSON, so it was not scanned. The agent may also fail to load it.',
    });
    return { findings, servers };
  }

  for (const key of ['mcpServers', 'servers']) {
    const block = config[key];
    if (isRecord(block)) scanServers(file, text, starts, block, keyLine(text, starts, key).index, findings, servers);
  }
  if (isRecord(config.mcp) && isRecord(config.mcp.servers)) {
    scanServers(file, text, starts, config.mcp.servers, keyLine(text, starts, 'mcp').index, findings, servers);
  }

  if (kind === 'claude-settings' || kind === 'plugin-hooks') scanHooks(file, text, starts, config.hooks, findings);

  if (kind === 'claude-settings') {
    if (config.enableAllProjectMcpServers === true) {
      const at = keyLine(text, starts, 'enableAllProjectMcpServers');
      findings.push({
        check: 'auto-approve-mcp', severity: 'warning', file, line: at.line, column: at.column,
        message: 'enableAllProjectMcpServers starts every server in .mcp.json without asking. A pull request can add a server that runs arbitrary code on each developer machine.',
      });
    }
    const permissions = isRecord(config.permissions) ? config.permissions : null;
    if (permissions?.defaultMode === 'bypassPermissions') {
      const at = keyLine(text, starts, 'defaultMode');
      findings.push({
        check: 'bypass-permissions', severity: 'warning', file, line: at.line, column: at.column,
        message: 'defaultMode "bypassPermissions" turns off permission prompts for everyone who uses these settings.',
      });
    }
    if (Array.isArray(permissions?.allow) && permissions!.allow.some((rule) => typeof rule === 'string' && /^Bash(?:\(\s*\*\s*(?::\s*\*\s*)?\))?$/.test(rule.trim()))) {
      const at = keyLine(text, starts, 'allow');
      findings.push({
        check: 'unrestricted-shell', severity: 'warning', file, line: at.line, column: at.column,
        message: 'permissions.allow grants the agent every shell command without a prompt.',
      });
    }
    scanSecretsInEnv(file, text, starts, config.env, findings, 'Claude settings');
    if (typeof config.apiKeyHelper === 'string') {
      const at = keyLine(text, starts, 'apiKeyHelper');
      checkHookCommand(config.apiKeyHelper, file, { line: at.line, column: at.column }, findings, 'apiKeyHelper');
    }
  }

  return { findings, servers };
}

// ─── Lock file ────────────────────────────────────────────────────────────────

export const DEFAULT_LOCK_FILE = '.ai-guard-mcp-lock.json';

interface LockFile {
  version: 1;
  servers: Record<string, string>;
}

function serverKey(server: McpServerInfo): string {
  return `${server.file}#${server.name}`;
}

function readLock(lockPath: string): LockFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockFile;
    return parsed && parsed.version === 1 && isRecord(parsed.servers) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLock(lockPath: string, servers: McpServerInfo[]): void {
  const lock: LockFile = { version: 1, servers: {} };
  for (const server of [...servers].sort((a, b) => serverKey(a).localeCompare(serverKey(b)))) {
    lock.servers[serverKey(server)] = server.fingerprint;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/** Scans one agent config file's text. `kind` defaults to classifying `file`. */
export function scanAgentConfigText(file: string, text: string, kind?: AgentFileKind): { findings: AgentConfigFinding[]; servers: McpServerInfo[] } {
  const resolved = kind ?? classifyAgentConfigPath(file) ?? 'instructions';
  if (resolved === 'instructions') return { findings: scanInstructionText(file, text), servers: [] };
  return scanConfigText(file, text, resolved);
}

export interface ScanAgentConfigOptions {
  /** Directory to scan (repository root or a subdirectory). */
  root: string;
  /** Explicit files, relative to root; skips discovery. */
  files?: string[];
  /** Lock file path relative to root. */
  lockFile?: string;
  /** Write the current server fingerprints to the lock file. */
  updateLock?: boolean;
}

export function scanAgentConfig(options: ScanAgentConfigOptions): AgentConfigReport {
  const start = Date.now();
  const root = path.resolve(options.root);
  const files = (options.files ?? discoverAgentConfigFiles(root)).map((f) => f.replace(/\\/g, '/'));
  const findings: AgentConfigFinding[] = [];
  const servers: McpServerInfo[] = [];
  const scanned: string[] = [];

  for (const file of files) {
    const abs = path.resolve(root, file);
    let text: string;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scanned.push(file);
    const result = scanAgentConfigText(file, text, classifyAgentConfigPath(file, root) ?? 'instructions');
    findings.push(...result.findings);
    servers.push(...result.servers);
  }

  const lockFile = options.lockFile ?? DEFAULT_LOCK_FILE;
  const lockPath = path.resolve(root, lockFile);
  let status: AgentConfigReport['lock']['status'] = 'not-found';
  if (options.updateLock) {
    writeLock(lockPath, servers);
    status = 'updated';
  } else {
    const lock = readLock(lockPath);
    if (lock) {
      status = 'checked';
      for (const server of servers) {
        const approved = lock.servers[serverKey(server)];
        const pos = { file: server.file, line: server.line, column: 1 };
        if (approved === undefined) {
          findings.push({ check: 'mcp-server-unapproved', severity: 'warning', ...pos, message: `MCP server "${server.name}" is not in ${lockFile}. Review what it runs, then run \`ai-guard scan-agent-config --update-lock\`.` });
        } else if (approved !== server.fingerprint) {
          findings.push({ check: 'mcp-server-changed', severity: 'warning', ...pos, message: `MCP server "${server.name}" changed since it was approved (fingerprint ${approved} -> ${server.fingerprint}). Review the change, then run \`ai-guard scan-agent-config --update-lock\`.` });
        }
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return {
    root,
    files: scanned,
    findings,
    servers,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    durationMs: Date.now() - start,
    lock: { file: lockFile, status },
  };
}
