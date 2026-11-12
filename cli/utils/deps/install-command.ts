/**
 * install-command.ts — finds the npm packages a shell command will install or run.
 *
 * Understands npm, npx, pnpm, pnpx, yarn, bun, bunx and corepack, chained
 * commands (&&, ||, ;, |), environment prefixes, sudo, `sh -c "..."`, quoting
 * and redirections. This is a reading of the command text, not a shell: when a
 * package argument depends on a variable or command substitution it is left out
 * rather than guessed.
 *
 * Precision matters more than coverage here. A flag value misread as a package
 * name (`npm i --workspace web lodash`) would get a valid command blocked, so
 * value-taking flags are listed per package manager.
 */

import { initializerPackage, parsePackageArg, type PackageRequest } from './package-spec.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface InstallIntent {
  manager: PackageManager;
  /** add: saved to the project or installed globally; run: downloaded and executed now (npx, dlx, create). */
  kind: 'add' | 'run';
  packages: PackageRequest[];
  /** For run intents: the command the package provides, which may already be installed locally. */
  bin?: string;
  /** The command names a registry (--registry or npm_config_registry), so lookups here would be wrong. */
  customRegistry: boolean;
}

interface Token {
  value: string;
  /** Contains an unquoted or double-quoted $ or backtick: the value is only known at run time. */
  dynamic: boolean;
}

/** Split into command segments of tokens. Separators: newline ; | & ( ). */
function tokenize(command: string): Token[][] {
  const segments: Token[][] = [];
  let tokens: Token[] = [];
  let current = '';
  let started = false;
  let dynamic = false;

  const endToken = (): void => {
    if (started) tokens.push({ value: current, dynamic });
    current = '';
    started = false;
    dynamic = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') { i++; continue; }
      current += command[++i];
      started = true;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      current += end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      i = end === -1 ? command.length : end;
      started = true;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) { current += command[j + 1]; j += 2; continue; }
        if (command[j] === '$' || command[j] === '`') dynamic = true;
        current += command[j++];
      }
      i = j;
      started = true;
      continue;
    }
    if (c === '$' || c === '`') {
      dynamic = true;
      current += c;
      started = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endToken(); continue; }
    if (c === '&' && (current.endsWith('>') || current.endsWith('<'))) { current += c; started = true; continue; } // 2>&1
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { endSegment(); continue; }
    if (c === '#' && !started) {
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? command.length : nl - 1;
      continue;
    }
    current += c;
    started = true;
  }
  endSegment();
  return segments;
}

/** Drop redirections such as `> log.txt`, `2>&1`, `<input`. */
function withoutRedirections(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (/^\d*(?:>>?|<<?|&>)/.test(v)) {
      if (/^\d*(?:>>?|<<?|&>)&?$/.test(v)) i++; // the target is the next token
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REGISTRY_ENV = /^(?:npm_config_registry|yarn_npm_registry_server|yarn_registry|bun_config_registry)=/i;

/** Value-taking options. Anything else starting with "-" is treated as a boolean flag. */
const VALUE_FLAGS: Record<PackageManager, Set<string>> = {
  npm: new Set(['--prefix', '-C', '--registry', '--cache', '--userconfig', '--globalconfig', '--workspace', '-w', '--tag', '--omit', '--include',
    '--install-strategy', '--loglevel', '--before', '--otp', '--fetch-retries', '--fetch-timeout', '--script-shell', '--lockfile-version',
    '--node-options', '--package', '-p', '--call', '-c', '--scope']),
  pnpm: new Set(['--filter', '-F', '--dir', '-C', '--registry', '--store-dir', '--reporter', '--package', '--allow-build', '--config',
    '--virtual-store-dir', '--modules-dir', '--lockfile-dir', '--loglevel', '--workspace-concurrency', '--network-concurrency', '--child-concurrency']),
  yarn: new Set(['--cwd', '--registry', '--network-timeout', '--mutex', '--modules-folder', '--cache-folder', '--global-folder', '--link-folder',
    '--network-concurrency', '--package', '-p', '--use-yarnrc']),
  bun: new Set(['--cwd', '--registry', '--backend', '--cache-dir', '--config', '-c', '--filter', '-F', '--package', '-p', '--omit', '--network-concurrency']),
};

const NPM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'install-test', 'it']);

interface Parsed {
  positionals: Token[];
  /** Values of --package / -p. */
  packageFlags: string[];
  customRegistry: boolean;
  /** Command-string option (npx -c, npm exec --call): the package comes only from --package. */
  hasCall: boolean;
}

/**
 * Read options and positionals. With `stopAtFirstPositional`, everything after
 * the first positional belongs to the command being run (npx pkg --flag).
 */
function parseArgs(tokens: Token[], manager: PackageManager, stopAtFirstPositional: boolean): Parsed {
  const values = VALUE_FLAGS[manager];
  const out: Parsed = { positionals: [], packageFlags: [], customRegistry: false, hasCall: false };
  for (let i = 0; i < tokens.length; i++) {
    const { value } = tokens[i];
    if (value === '--') {
      if (stopAtFirstPositional && i + 1 < tokens.length) out.positionals.push(tokens[i + 1]);
      else out.positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (value.startsWith('-') && value.length > 1) {
      const eq = value.indexOf('=');
      const flag = eq === -1 ? value : value.slice(0, eq);
      let flagValue: string | undefined;
      if (eq !== -1) flagValue = value.slice(eq + 1);
      else if (values.has(flag) && i + 1 < tokens.length) flagValue = tokens[++i].value;
      if (flag === '--registry') out.customRegistry = true;
      if ((flag === '--package' || (flag === '-p' && manager !== 'pnpm')) && flagValue !== undefined) out.packageFlags.push(flagValue);
      if ((flag === '--call' || (flag === '-c' && manager === 'npm')) && flagValue !== undefined) out.hasCall = true;
      continue;
    }
    out.positionals.push(tokens[i]);
    if (stopAtFirstPositional) break;
  }
  return out;
}

function packagesFrom(tokens: Token[]): PackageRequest[] {
  return tokens.filter((t) => !t.dynamic).map((t) => parsePackageArg(t.value)).filter((p): p is PackageRequest => p !== null);
}

function binOf(name: string): string {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
}

/** npx-style: `<runner> [flags] <pkg> [args]`. */
function runIntent(manager: PackageManager, tokens: Token[]): InstallIntent | null {
  const args = parseArgs(tokens, manager, true);
  const first = args.positionals[0];
  if (args.packageFlags.length > 0) {
    const packages = args.packageFlags.map((p) => parsePackageArg(p)).filter((p): p is PackageRequest => p !== null);
    return { manager, kind: 'run', packages, bin: first && !first.dynamic ? binOf(first.value) : undefined, customRegistry: args.customRegistry };
  }
  if (args.hasCall || !first || first.dynamic) return null;
  const pkg = parsePackageArg(first.value);
  if (!pkg) return null;
  return { manager, kind: 'run', packages: [pkg], bin: binOf(pkg.name), customRegistry: args.customRegistry };
}

function initIntent(manager: PackageManager, tokens: Token[], customRegistry: boolean): InstallIntent | null {
  const args = parseArgs(tokens, manager, true);
  const first = args.positionals[0];
  if (!first || first.dynamic) return null;
  const pkg = initializerPackage(first.value);
  return pkg ? { manager, kind: 'run', packages: [pkg], customRegistry: customRegistry || args.customRegistry } : null;
}

function addIntent(manager: PackageManager, tokens: Token[], customRegistry: boolean): InstallIntent | null {
  const args = parseArgs(tokens, manager, false);
  const packages = packagesFrom(args.positionals);
  return packages.length > 0 ? { manager, kind: 'add', packages, customRegistry: customRegistry || args.customRegistry } : null;
}

/** Leading options before the subcommand (`npm --prefix web i x`, `pnpm -C web add x`). */
function subcommandAt(tokens: Token[], manager: PackageManager): { index: number; customRegistry: boolean } {
  const values = VALUE_FLAGS[manager];
  let customRegistry = false;
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (!v.startsWith('-')) return { index: i, customRegistry };
    const flag = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
    if (flag === '--registry') customRegistry = true;
    if (!v.includes('=') && values.has(flag)) i++;
  }
  return { index: tokens.length, customRegistry };
}

function npmIntent(rest: Token[]): InstallIntent | null {
  const { index, customRegistry } = subcommandAt(rest, 'npm');
  const sub = rest[index]?.value;
  const after = rest.slice(index + 1);
  if (sub === undefined) return null;
  if (NPM_INSTALL.has(sub)) return addIntent('npm', after, customRegistry);
  if (sub === 'exec' || sub === 'x') {
    const intent = runIntent('npm', after);
    return intent ? { ...intent, customRegistry: intent.customRegistry || customRegistry } : null;
  }
  if (sub === 'init' || sub === 'create' || sub === 'innit') return initIntent('npm', after, customRegistry);
  return null;
}

function pnpmIntent(rest: Token[]): InstallIntent | null {
  const { index, customRegistry } = subcommandAt(rest, 'pnpm');
  const sub = rest[index]?.value;
  const after = rest.slice(index + 1);
  if (sub === 'add' || sub === 'install' || sub === 'i') return addIntent('pnpm', after, customRegistry);
  if (sub === 'dlx') {
    const intent = runIntent('pnpm', after);
    return intent ? { ...intent, customRegistry: intent.customRegistry || customRegistry } : null;
  }
  if (sub === 'create') return initIntent('pnpm', after, customRegistry);
  return null;
}

function yarnIntent(rest: Token[]): InstallIntent | null {
  const { index, customRegistry } = subcommandAt(rest, 'yarn');
  const sub = rest[index]?.value;
  const after = rest.slice(index + 1);
  if (sub === 'add') return addIntent('yarn', after, customRegistry);
  if (sub === 'global' && after[0]?.value === 'add') return addIntent('yarn', after.slice(1), customRegistry);
  // `yarn workspace <name> add <pkgs>`: the workspace name is not a package.
  if (sub === 'workspace' && after.length >= 2) return yarnIntent(after.slice(1));
  if (sub === 'dlx') {
    const intent = runIntent('yarn', after);
    return intent ? { ...intent, customRegistry: intent.customRegistry || customRegistry } : null;
  }
  if (sub === 'create') return initIntent('yarn', after, customRegistry);
  return null;
}

function bunIntent(rest: Token[]): InstallIntent | null {
  const { index, customRegistry } = subcommandAt(rest, 'bun');
  const sub = rest[index]?.value;
  const after = rest.slice(index + 1);
  if (sub === 'add' || sub === 'a' || sub === 'install' || sub === 'i') return addIntent('bun', after, customRegistry);
  if (sub === 'x') {
    const intent = runIntent('bun', after);
    return intent ? { ...intent, customRegistry: intent.customRegistry || customRegistry } : null;
  }
  if (sub === 'create') return initIntent('bun', after, customRegistry);
  return null;
}

function executable(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token;
  return base.toLowerCase().replace(/\.(?:cmd|exe|ps1|bat)$/, '');
}

const PREFIX_COMMANDS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'doas']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function segmentIntents(raw: Token[], depth: number): InstallIntent[] {
  let tokens = withoutRedirections(raw);
  let registryFromEnv = false;
  // Environment assignments and wrappers in front of the real command.
  for (;;) {
    const first = tokens[0];
    if (!first) return [];
    if (ENV_ASSIGNMENT.test(first.value)) {
      if (REGISTRY_ENV.test(first.value)) registryFromEnv = true;
      tokens = tokens.slice(1);
      continue;
    }
    const exe = executable(first.value);
    if (PREFIX_COMMANDS.has(exe)) {
      tokens = tokens.slice(1);
      // Wrapper options, e.g. `sudo -E`, `sudo -u user`, `env -i`.
      while (tokens[0]?.value.startsWith('-')) {
        const opt = tokens[0].value;
        tokens = tokens.slice(1);
        if ((exe === 'sudo' || exe === 'doas') && (opt === '-u' || opt === '-g' || opt === '-C')) tokens = tokens.slice(1);
        if (exe === 'nice' && opt === '-n') tokens = tokens.slice(1);
      }
      continue;
    }
    break;
  }

  const exe = executable(tokens[0].value);
  let rest = tokens.slice(1);

  if (SHELLS.has(exe)) {
    const flagIndex = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t.value));
    const script = flagIndex === -1 ? undefined : rest[flagIndex + 1];
    return script && !script.dynamic && depth < 3 ? parseIntents(script.value, depth + 1) : [];
  }

  let manager = exe;
  if (manager === 'corepack' && rest.length > 0) {
    manager = executable(rest[0].value);
    rest = rest.slice(1);
  }

  let intent: InstallIntent | null = null;
  if (manager === 'npm') intent = npmIntent(rest);
  else if (manager === 'npx') intent = runIntent('npm', rest);
  else if (manager === 'pnpm') intent = pnpmIntent(rest);
  else if (manager === 'pnpx') intent = runIntent('pnpm', rest);
  else if (manager === 'yarn') intent = yarnIntent(rest);
  else if (manager === 'bun') intent = bunIntent(rest);
  else if (manager === 'bunx') intent = runIntent('bun', rest);

  if (!intent || intent.packages.length === 0) return [];
  return [{ ...intent, customRegistry: intent.customRegistry || registryFromEnv }];
}

function parseIntents(command: string, depth: number): InstallIntent[] {
  return tokenize(command).flatMap((segment) => segmentIntents(segment, depth));
}

/** Package installs and package runs in a shell command, in order. */
export function parseInstallCommands(command: string): InstallIntent[] {
  return parseIntents(command, 0);
}
