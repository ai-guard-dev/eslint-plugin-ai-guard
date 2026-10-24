/**
 * Shell-command analysis shared by package.json scripts, CI `run:` steps,
 * Git hook files and the Claude Code Bash guard.
 *
 * This is pattern matching on command text, not shell evaluation. Quoted
 * strings are blanked first so a commit message such as `-m "mention -n"` is
 * not mistaken for a flag.
 */

export type WeakenerKind =
  | 'exit-masking'
  | 'no-verify'
  | 'hooks-disabled'
  | 'pass-with-no-tests'
  | 'tests-excluded'
  | 'coverage-disabled';

export interface Weakener {
  kind: WeakenerKind;
  /** The matched text, for display. */
  token: string;
  /** Precise enough to block when enforced. */
  high: boolean;
}

/** Commands that run a test, lint or type check. */
const VERIFY_TOOL = new RegExp([
  String.raw`\b(?:jest|vitest|mocha|ava|tap|c8|nyc|karma|jasmine)\b`,
  String.raw`\bplaywright\s+test\b`,
  String.raw`\bcypress\s+run\b`,
  String.raw`\b(?:eslint|oxlint|tsc|vue-tsc|ai-guard|stylelint)\b`,
  String.raw`\bbiome\s+(?:check|lint|ci)\b`,
  String.raw`\bprettier\b[^;&|]*--check\b`,
  String.raw`\bnode\s+--test\b`,
  String.raw`\b(?:bun|deno)\s+test\b`,
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|types|check|verify|validate|ci|e2e|coverage)(?::[\w:-]+)?\b`,
  String.raw`\bnpm\s+t\b`,
  String.raw`\bnpx\s+(?:--yes\s+)?(?:jest|vitest|mocha|eslint|tsc|playwright|ai-guard|lint-staged)\b`,
  String.raw`\blint-staged\b`,
].join('|'));

export function blankQuotes(cmd: string): string {
  return cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => `${m[0]}${' '.repeat(Math.max(0, m.length - 2))}${m[m.length - 1]}`);
}

export function isVerificationCommand(cmd: string): boolean {
  return VERIFY_TOOL.test(blankQuotes(cmd));
}

/** Split a command line into `&&`, `||`, `;` and newline separated segments, normalized. */
export function commandSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\r?\n/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s !== '' && !s.startsWith('#'));
}

export function verificationSegments(cmd: string): string[] {
  return commandSegments(cmd).filter(isVerificationCommand);
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SUBCOMMAND_TOOLS = new Set(['playwright', 'cypress', 'biome', 'node']);

/**
 * The tool invocation a verification command runs, without its arguments:
 * `npm test -- test/browser.ts` and `pnpm run test` → `npm test`;
 * `npx --yes vitest run --coverage` → `vitest`; `tsc --noEmit` → `tsc`.
 * A command whose key is still present was changed, not removed: whether new
 * arguments cover the same checks cannot be decided statically.
 */
export function verificationKey(segment: string): string {
  const tokens = blankQuotes(segment).trim().split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  let i = 0;
  if (tokens[i] === 'npx' || tokens[i] === 'pnpx' || (tokens[i] === 'pnpm' && tokens[i + 1] === 'exec') || (tokens[i] === 'yarn' && tokens[i + 1] === 'dlx')) {
    i += tokens[i] === 'npx' || tokens[i] === 'pnpx' ? 1 : 2;
    while (tokens[i]?.startsWith('-')) i += tokens[i] === '-p' || tokens[i] === '--package' ? 2 : 1;
    const tool = tokens[i] ?? '';
    return SUBCOMMAND_TOOLS.has(tool) && tokens[i + 1] ? `${tool} ${tokens[i + 1]}` : tool;
  }
  if (PACKAGE_MANAGERS.has(tokens[0] ?? '')) {
    const sub = tokens[1] === 'run' || tokens[1] === 'run-script' ? tokens[2] : tokens[1];
    const script = sub === 't' || sub === 'tst' ? 'test' : sub;
    return script === 'test' ? 'npm test' : `npm run ${script ?? ''}`.trim();
  }
  const tool = tokens[0] ?? '';
  return SUBCOMMAND_TOOLS.has(tool) && tokens[1] ? `${tool} ${tokens[1]}` : tool;
}

const PATTERNS: Array<{ kind: WeakenerKind; re: RegExp; high: boolean }> = [
  { kind: 'exit-masking', re: /\|\|\s*(?:true|:|exit\s+0)\b/, high: true },
  { kind: 'exit-masking', re: /;\s*(?:exit\s+0|true)\s*$/m, high: true },
  { kind: 'exit-masking', re: /^\s*(?:exit\s+0|true)\s*(?:$|;|&&)/m, high: true },
  { kind: 'exit-masking', re: /\bset\s+\+e\b/, high: true },
  { kind: 'no-verify', re: /\bgit\b[^\n;&|]*\bcommit\b[^\n;&|]*(?:--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)/, high: true },
  { kind: 'no-verify', re: /\bgit\b[^\n;&|]*\b(?:push|merge|am|rebase|cherry-pick|revert)\b[^\n;&|]*--no-verify\b/, high: true },
  { kind: 'hooks-disabled', re: /\b(?:HUSKY=0|HUSKY_SKIP_HOOKS=1|SKIP_SIMPLE_GIT_HOOKS=1|LEFTHOOK=0)\b/, high: true },
  { kind: 'hooks-disabled', re: /core\.hooksPath[=\s]+(?:\/dev\/null|NUL|''|"")(?:\s|$)/, high: true },
  { kind: 'pass-with-no-tests', re: /--pass(?:WithNoTests|-with-no-tests)\b/, high: false },
  { kind: 'tests-excluded', re: /--(?:testPathIgnorePatterns|testPathIgnore|exclude)\b/, high: false },
  { kind: 'coverage-disabled', re: /--no-coverage\b|--coverage(?:\.enabled)?=false\b/, high: false },
];

/** Every weakening construct present in a command. */
export function detectWeakeners(cmd: string): Weakener[] {
  const text = blankQuotes(cmd);
  const out: Weakener[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) out.push({ kind: p.kind, token: m[0].trim(), high: p.high });
  }
  return out;
}

/** Weakeners present in `after` but not in `before`, by kind. */
export function addedWeakeners(before: string | null, after: string): Weakener[] {
  const had = new Set((before === null ? [] : detectWeakeners(before)).map((w) => w.kind));
  return detectWeakeners(after).filter((w) => !had.has(w.kind));
}

export function describeWeakener(w: Weakener): string {
  switch (w.kind) {
    case 'exit-masking': return `\`${w.token}\` makes the command succeed even when the check fails`;
    case 'no-verify': return `\`${w.token}\` skips Git hooks`;
    case 'hooks-disabled': return `\`${w.token}\` disables Git hooks`;
    case 'pass-with-no-tests': return `\`${w.token}\` lets the run pass when no tests are found`;
    case 'tests-excluded': return `\`${w.token}\` excludes tests from the run`;
    case 'coverage-disabled': return `\`${w.token}\` disables coverage collection`;
  }
}

/** Bypass of Git hooks in a command an agent is about to run (Bash guard). */
export function detectHookBypass(cmd: string): Weakener[] {
  return detectWeakeners(cmd).filter((w) => w.kind === 'no-verify' || w.kind === 'hooks-disabled');
}
