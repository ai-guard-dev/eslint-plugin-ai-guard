/**
 * cooldown.ts — the release cooldown a project's package manager enforces.
 *
 * npm, pnpm, Yarn and Bun can refuse versions published less than some time
 * ago. When the project's package manager already does that for the whole
 * fresh-release window, AI Guard's own fresh-release check would only repeat
 * it, so the check is skipped.
 *
 *   npm   min-release-age (days)            .npmrc, npm_config_min_release_age
 *         min-release-age-exclude           names or globs that skip the window
 *   pnpm  minimumReleaseAge (minutes)       pnpm-workspace.yaml, .npmrc minimum-release-age
 *         minimumReleaseAgeExclude          pnpm 11+ defaults to 1440 minutes
 *   yarn  npmMinimalAgeGate (minutes)       .yarnrc.yml, YARN_NPM_MINIMAL_AGE_GATE
 *         npmPreapprovedPackages
 *   bun   minimumReleaseAge (seconds)       bunfig.toml [install]
 *         minimumReleaseAgeExcludes
 *
 * Only settings that are written down count, plus pnpm 11's default when
 * package.json names pnpm 11 or later in "packageManager". The nearest file
 * wins, then the user's configuration. An unknown package manager means no
 * cooldown is assumed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PackageManager } from './install-command.js';

export interface ReleaseCooldown {
  manager: PackageManager;
  /** 0 means turned off. */
  minutes: number;
  /** Package names or globs the cooldown does not apply to. */
  exclude: string[];
  /** Where it was configured, for messages. */
  source: string;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function unquote(value: string): string {
  return value.trim().replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

function number(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(unquote(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Yarn accepts plain minutes and durations such as "1d", "12h", "90m". */
function yarnMinutes(value: string): number | null {
  const v = unquote(value);
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)?$/i.exec(v);
  if (!m) return null;
  const factor = { m: 1, h: 60, d: 1440, w: 10080 }[(m[2] ?? 'm').toLowerCase() as 'm' | 'h' | 'd' | 'w'];
  return Number(m[1]) * factor;
}

function list(value: string): string[] {
  const v = value.trim();
  const inner = v.startsWith('[') ? v.slice(1, v.lastIndexOf(']') === -1 ? undefined : v.lastIndexOf(']')) : v;
  return inner.split(',').map(unquote).filter((s) => s !== '');
}

/** key=value pairs of an .npmrc; `key[]=value` lines are collected into lists. */
function npmrc(text: string): { values: Map<string, string>; lists: Map<string, string[]> } {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.endsWith('[]')) lists.set(key.slice(0, -2), [...(lists.get(key.slice(0, -2)) ?? []), unquote(value)]);
    else values.set(key, value);
  }
  return { values, lists };
}

/** Top-level `key: value` and `key:` + `- item` lists of a simple YAML file. */
function yamlTop(text: string, key: string): { value: string | null; items: string[] } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[i]);
    if (!m) continue;
    const value = m[1].replace(/\s+#.*$/, '').trim();
    const items: string[] = [];
    if (value === '') {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '' || lines[j].trim().startsWith('#')) continue;
        const item = /^\s+-\s*(.+)$/.exec(lines[j]);
        if (!item) break;
        items.push(unquote(item[1]));
      }
    }
    return { value: value === '' ? null : value, items: value.startsWith('[') ? list(value) : items };
  }
  return null;
}

function npmCooldown(dirs: string[], env: NodeJS.ProcessEnv, home: string): ReleaseCooldown | null {
  const envDays = number(env.npm_config_min_release_age ?? env.NPM_CONFIG_MIN_RELEASE_AGE);
  if (envDays !== null) return { manager: 'npm', minutes: envDays * 1440, exclude: [], source: 'environment variable npm_config_min_release_age' };
  const files = [...dirs.map((d) => path.join(d, '.npmrc')), env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? path.join(home, '.npmrc')];
  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    const { values, lists } = npmrc(text);
    const days = number(values.get('min-release-age'));
    if (days === null) continue;
    const exclude = [...(lists.get('min-release-age-exclude') ?? []), ...list(values.get('min-release-age-exclude') ?? '')];
    return { manager: 'npm', minutes: days * 1440, exclude, source: file };
  }
  return null;
}

function pnpmMajor(dirs: string[]): number | null {
  for (const dir of dirs) {
    const text = read(path.join(dir, 'package.json'));
    if (text === null) continue;
    try {
      const pm = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
      if (typeof pm === 'string') {
        const m = /^pnpm@(\d+)\./.exec(pm);
        return m ? Number(m[1]) : null;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

function pnpmCooldown(dirs: string[], env: NodeJS.ProcessEnv, home: string): ReleaseCooldown | null {
  for (const dir of dirs) {
    const file = path.join(dir, 'pnpm-workspace.yaml');
    const text = read(file);
    if (text !== null) {
      const age = yamlTop(text, 'minimumReleaseAge');
      const minutes = age?.value ? number(age.value) : null;
      if (minutes !== null) {
        const ex = yamlTop(text, 'minimumReleaseAgeExclude');
        return { manager: 'pnpm', minutes, exclude: ex ? (ex.value ? list(ex.value) : ex.items) : [], source: file };
      }
    }
    const rc = read(path.join(dir, '.npmrc'));
    if (rc !== null) {
      const { values, lists } = npmrc(rc);
      const minutes = number(values.get('minimum-release-age'));
      if (minutes !== null) {
        const exclude = [...(lists.get('minimum-release-age-exclude') ?? []), ...list(values.get('minimum-release-age-exclude') ?? '')];
        return { manager: 'pnpm', minutes, exclude, source: path.join(dir, '.npmrc') };
      }
    }
  }
  const userRc = read(env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? path.join(home, '.npmrc'));
  const userMinutes = userRc === null ? null : number(npmrc(userRc).values.get('minimum-release-age'));
  if (userMinutes !== null) return { manager: 'pnpm', minutes: userMinutes, exclude: [], source: path.join(home, '.npmrc') };
  const major = pnpmMajor(dirs);
  if (major !== null && major >= 11) return { manager: 'pnpm', minutes: 1440, exclude: [], source: `pnpm ${major} default (package.json packageManager)` };
  return null;
}

function yarnCooldown(dirs: string[], env: NodeJS.ProcessEnv, home: string): ReleaseCooldown | null {
  const fromEnv = env.YARN_NPM_MINIMAL_AGE_GATE;
  if (fromEnv !== undefined) {
    const minutes = yarnMinutes(fromEnv);
    if (minutes !== null) return { manager: 'yarn', minutes, exclude: [], source: 'environment variable YARN_NPM_MINIMAL_AGE_GATE' };
  }
  for (const file of [...dirs.map((d) => path.join(d, '.yarnrc.yml')), path.join(home, '.yarnrc.yml')]) {
    const text = read(file);
    if (text === null) continue;
    const gate = yamlTop(text, 'npmMinimalAgeGate');
    const minutes = gate?.value ? yarnMinutes(gate.value) : null;
    if (minutes === null) continue;
    const ex = yamlTop(text, 'npmPreapprovedPackages');
    return { manager: 'yarn', minutes, exclude: ex ? (ex.value ? list(ex.value) : ex.items) : [], source: file };
  }
  return null;
}

function bunCooldown(dirs: string[], home: string): ReleaseCooldown | null {
  for (const file of [...dirs.map((d) => path.join(d, 'bunfig.toml')), path.join(home, '.bunfig.toml')]) {
    const text = read(file);
    if (text === null) continue;
    let section = '';
    let seconds: number | null = null;
    let exclude: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) { section = header[1].trim(); continue; }
      if (section !== 'install') continue;
      const age = /^minimumReleaseAge\s*=\s*(.+)$/.exec(line);
      if (age) seconds = number(age[1]);
      const ex = /^minimumReleaseAgeExcludes\s*=\s*(.+)$/.exec(line);
      if (ex) exclude = list(ex[1]);
    }
    if (seconds !== null) return { manager: 'bun', minutes: seconds / 60, exclude, source: file };
  }
  return null;
}

/** The release cooldown `manager` enforces for installs run in `cwd`, or null. */
export function readReleaseCooldown(cwd: string, manager: PackageManager, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): ReleaseCooldown | null {
  const dirs = projectDirs(cwd);
  if (manager === 'npm') return npmCooldown(dirs, env, home);
  if (manager === 'pnpm') return pnpmCooldown(dirs, env, home);
  if (manager === 'yarn') return yarnCooldown(dirs, env, home);
  return bunCooldown(dirs, home);
}

/** The project's package manager: package.json "packageManager", then lockfiles. Null when unknown. */
export function detectPackageManager(cwd: string): PackageManager | null {
  const dirs = projectDirs(cwd);
  for (const dir of dirs) {
    const text = read(path.join(dir, 'package.json'));
    if (text === null) continue;
    try {
      const pm = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
      const m = typeof pm === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(pm) : null;
      if (m) return m[1] as PackageManager;
    } catch { /* not JSON */ }
  }
  const locks: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'],
  ];
  for (const dir of dirs) {
    const found = locks.filter(([file]) => fs.existsSync(path.join(dir, file))).map(([, pm]) => pm);
    if (new Set(found).size === 1) return found[0];
    if (found.length > 1) return null;
  }
  return null;
}

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(name);
}

/** True when the cooldown keeps `name` out for at least `windowMinutes`. */
export function cooldownCovers(cooldown: ReleaseCooldown | null | undefined, name: string, windowMinutes: number): boolean {
  if (!cooldown || cooldown.minutes <= 0 || cooldown.minutes < windowMinutes) return false;
  return !cooldown.exclude.some((pattern) => globMatch(pattern, name));
}

/** How to turn a one-day cooldown on, for the given package manager. */
export function cooldownTip(manager: PackageManager | null): string {
  switch (manager) {
    case 'pnpm': return 'add `minimumReleaseAge: 1440` to pnpm-workspace.yaml';
    case 'yarn': return 'add `npmMinimalAgeGate: 1440` to .yarnrc.yml';
    case 'bun': return 'add `minimumReleaseAge = 86400` under [install] in bunfig.toml';
    default: return 'add `min-release-age=1` to .npmrc (npm 11.10 or later)';
  }
}
