/**
 * dependencies.ts — the npm dependencies declared in package.json files, and
 * the ones a change added.
 *
 * A dependency counts as added when its name appears in no dependency field of
 * the same package.json before the change. Changing the version of an existing
 * dependency is not "added". Workspace packages (any package.json name in the
 * repository) and non-registry entries (workspace:, file:, git, URLs) are left
 * out: they are not fetched from npm.
 */

import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { parseDependencySpec, type PackageRequest } from './package-spec.js';
import { readAfter, readBefore, type ChangeSet } from '../change-set.js';

export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
export type DependencyField = typeof DEPENDENCY_FIELDS[number];

export interface DependencyEntry {
  /** package.json path, repository-relative with forward slashes. */
  manifest: string;
  field: DependencyField;
  request: PackageRequest;
  /** 1-based line of the entry in the package.json. */
  line: number;
}

export interface DependencyReadError {
  file: string;
  message: string;
}

type Manifest = Partial<Record<DependencyField, Record<string, unknown>>> & { name?: unknown };

function parseManifest(text: string): Manifest {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('package.json is not a JSON object');
  return parsed as Manifest;
}

function namesIn(manifest: Manifest): Set<string> {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Line of `"name":` inside the given field, falling back to its first occurrence. */
export function dependencyLine(text: string, field: string, name: string): number {
  const lines = text.split(/\r?\n/);
  const key = new RegExp(`^\\s*"${escapeRegExp(name)}"\\s*:`);
  const fieldStart = lines.findIndex((l) => new RegExp(`^\\s*"${field}"\\s*:`).test(l));
  if (fieldStart !== -1) {
    for (let i = fieldStart + 1; i < lines.length; i++) {
      if (key.test(lines[i])) return i + 1;
      if (/^\s*}/.test(lines[i])) break;
    }
  }
  const any = lines.findIndex((l) => key.test(l));
  return any === -1 ? 1 : any + 1;
}

function entriesOf(manifestPath: string, text: string, manifest: Manifest, skip: Set<string>, local: Set<string>): DependencyEntry[] {
  const entries: DependencyEntry[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, value] of Object.entries(deps)) {
      if (skip.has(name) || local.has(name)) continue;
      const request = parseDependencySpec(name, value);
      if (request) entries.push({ manifest: manifestPath, field, request, line: dependencyLine(text, field, name) });
    }
  }
  return entries;
}

const isManifest = (file: string): boolean => /(^|\/)package\.json$/.test(file) && !file.split('/').includes('node_modules');

/** Tracked and untracked (not ignored) package.json files, repository-relative. */
export function listManifests(root: string): string[] {
  try {
    const out = childProcess.execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 30000,
    });
    return [...new Set(out.split('\0').filter((f) => f && isManifest(f)))].sort();
  } catch {
    return fs.existsSync(path.join(root, 'package.json')) ? ['package.json'] : [];
  }
}

/** Names of the packages that live in this repository (workspaces). */
export function localPackageNames(root: string, manifests: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of manifests) {
    try {
      const name = parseManifest(fs.readFileSync(path.join(root, file), 'utf8')).name;
      if (typeof name === 'string') names.add(name);
    } catch { /* unreadable manifests are reported where they are scanned */ }
  }
  return names;
}

/** Dependencies the change added, per package.json. */
export function addedDependencies(changeSet: ChangeSet, local: Set<string>): { entries: DependencyEntry[]; manifests: string[]; errors: DependencyReadError[] } {
  const entries: DependencyEntry[] = [];
  const manifests: string[] = [];
  const errors: DependencyReadError[] = [];
  for (const file of changeSet.files) {
    if (file.status === 'deleted' || !isManifest(file.path)) continue;
    const after = readAfter(changeSet, file.path);
    if (after === null) continue;
    manifests.push(file.path);
    let afterManifest: Manifest;
    try {
      afterManifest = parseManifest(after);
    } catch (error) {
      errors.push({ file: file.path, message: `Could not parse ${file.path}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    let before = new Set<string>();
    if (file.status !== 'added' && file.status !== 'untracked') {
      const text = readBefore(changeSet, file.oldPath);
      if (text !== null) {
        try {
          before = namesIn(parseManifest(text));
        } catch { /* invalid before: every dependency counts as added */ }
      }
    }
    entries.push(...entriesOf(file.path, after, afterManifest, before, local));
  }
  return { entries, manifests, errors };
}

/** Every registry dependency declared in the repository's package.json files. */
export function allDependencies(root: string, manifests: string[], local: Set<string>): { entries: DependencyEntry[]; errors: DependencyReadError[] } {
  const entries: DependencyEntry[] = [];
  const errors: DependencyReadError[] = [];
  for (const file of manifests) {
    let text: string;
    let manifest: Manifest;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
      manifest = parseManifest(text);
    } catch (error) {
      errors.push({ file, message: `Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    entries.push(...entriesOf(file, text, manifest, new Set(), local));
  }
  return { entries, errors };
}
