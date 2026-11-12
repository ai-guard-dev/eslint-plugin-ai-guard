/**
 * registry-config.ts — which packages are served by the public npm registry.
 *
 * Package checks query registry.npmjs.org. Doing that for a package that comes
 * from a private registry would be wrong twice: the name of an internal package
 * would be sent to the public registry, and "does not exist on npm" would be a
 * false alarm. So a package is checked only when every config the package
 * managers read points its scope at the public registry.
 *
 * Read: npm_config_registry and friends in the environment, .npmrc (project
 * directories up to the repository root, then the user's), .yarnrc.yml, .yarnrc
 * and bunfig.toml. Before a "does not exist" result is reported, `npm config
 * get` confirms the effective registry (see confirmPublicRegistry).
 */

import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RegistryConfig {
  /** Unscoped packages (and scopes without their own registry) come from the public registry. */
  publicDefault: boolean;
  /** Scopes, such as "@acme", that have their own registry. */
  customScopes: Set<string>;
  /** Where a custom registry was configured, for messages. */
  sources: string[];
}

const PUBLIC_HOSTS = new Set(['registry.npmjs.org', 'registry.npmjs.com', 'registry.yarnpkg.com']);

export function isPublicRegistry(url: string): boolean {
  const value = url.trim().replace(/^["']|["']$/g, '');
  if (value === '' || value.includes('${')) return value === '';
  try {
    return PUBLIC_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function applyRegistry(cfg: RegistryConfig, scope: string | null, url: string, source: string): void {
  if (isPublicRegistry(url)) return;
  if (scope) cfg.customScopes.add(scope.toLowerCase());
  else cfg.publicDefault = false;
  cfg.sources.push(source);
}

function parseNpmrc(text: string, source: string, cfg: RegistryConfig): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'registry') applyRegistry(cfg, null, value, source);
    const scoped = /^(@[^:]+):registry$/.exec(key);
    if (scoped) applyRegistry(cfg, scoped[1], value, source);
  }
}

function parseYarnrcYml(text: string, source: string, cfg: RegistryConfig): void {
  let inScopes = false;
  let scope: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (indent === 0) {
      inScopes = line.startsWith('npmScopes:');
      scope = null;
      const top = /^npmRegistryServer:\s*(.+)$/.exec(line);
      if (top) applyRegistry(cfg, null, top[1], source);
      continue;
    }
    if (!inScopes) continue;
    const scopeKey = /^["']?@?([a-z0-9._-]+)["']?:\s*$/i.exec(line);
    if (scopeKey) {
      scope = `@${scopeKey[1]}`;
      continue;
    }
    const server = /^npmRegistryServer:\s*(.+)$/.exec(line);
    if (server && scope) applyRegistry(cfg, scope, server[1], source);
  }
}

function parseYarnrc(text: string, source: string, cfg: RegistryConfig): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const top = /^["']?registry["']?\s+(.+)$/.exec(line);
    if (top) applyRegistry(cfg, null, top[1], source);
    const scoped = /^["']?(@[^:"']+):registry["']?\s+(.+)$/.exec(line);
    if (scoped) applyRegistry(cfg, scoped[1], scoped[2], source);
  }
}

function parseBunfig(text: string, source: string, cfg: RegistryConfig): void {
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const url = (value: string): string => {
      const inline = /url\s*=\s*["']([^"']+)["']/.exec(value);
      return inline ? inline[1] : value.replace(/^["']|["']$/g, '');
    };
    if (section === 'install') {
      const m = /^registry\s*=\s*(.+)$/.exec(line);
      if (m) applyRegistry(cfg, null, url(m[1]), source);
    }
    if (section === 'install.scopes') {
      const m = /^["']?@?([a-z0-9._-]+)["']?\s*=\s*(.+)$/i.exec(line);
      if (m) applyRegistry(cfg, `@${m[1]}`, url(m[2]), source);
    }
  }
}

/** Project directories from `cwd` up to the repository root (or the filesystem root). */
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

/** Registry configuration that applies to package installs run in `cwd`. */
export function readRegistryConfig(cwd: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): RegistryConfig {
  const cfg: RegistryConfig = { publicDefault: true, customScopes: new Set(), sources: [] };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'npm_config_registry' || lower === 'yarn_npm_registry_server' || lower === 'yarn_registry' || lower === 'bun_config_registry') {
      applyRegistry(cfg, null, value, `environment variable ${key}`);
    }
  }

  const userNpmrc = env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? path.join(home, '.npmrc');
  const files: Array<[string, (text: string, source: string, cfg: RegistryConfig) => void]> = [];
  for (const dir of projectDirs(cwd)) {
    files.push([path.join(dir, '.npmrc'), parseNpmrc]);
    files.push([path.join(dir, '.yarnrc.yml'), parseYarnrcYml]);
    files.push([path.join(dir, '.yarnrc'), parseYarnrc]);
    files.push([path.join(dir, 'bunfig.toml'), parseBunfig]);
  }
  files.push([userNpmrc, parseNpmrc]);
  files.push([path.join(home, '.yarnrc.yml'), parseYarnrcYml]);
  files.push([path.join(home, '.yarnrc'), parseYarnrc]);
  files.push([path.join(home, '.bunfig.toml'), parseBunfig]);

  for (const [file, parse] of files) {
    const text = read(file);
    if (text !== null) parse(text, file, cfg);
  }
  return cfg;
}

export function scopeOf(name: string): string | null {
  return name.startsWith('@') ? name.slice(0, name.indexOf('/')).toLowerCase() : null;
}

/** True when the package would be installed from the public npm registry. */
export function usesPublicRegistry(cfg: RegistryConfig, name: string): boolean {
  const scope = scopeOf(name);
  if (scope && cfg.customScopes.has(scope)) return false;
  return cfg.publicDefault;
}

const confirmed = new Map<string, boolean>();

/**
 * Ask npm for the effective registry (it also reads the global npmrc and npm's
 * own defaults). Used before reporting that a package does not exist, the one
 * result that blocks an install. If npm cannot be run, the file-based answer
 * stands.
 */
export function confirmPublicRegistry(cwd: string, name: string): boolean {
  const scope = scopeOf(name);
  const key = `${path.resolve(cwd)}\0${scope ?? ''}`;
  const cached = confirmed.get(key);
  if (cached !== undefined) return cached;
  let result = true;
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const read = (setting: string): string => childProcess.execFileSync(npm, ['config', 'get', setting], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true, shell: process.platform === 'win32',
    }).trim();
    const scoped = scope ? read(`${scope}:registry`) : 'undefined';
    const effective = scoped && scoped !== 'undefined' && scoped !== 'null' ? scoped : read('registry');
    result = isPublicRegistry(effective);
  } catch {
    result = true;
  }
  confirmed.set(key, result);
  return result;
}
