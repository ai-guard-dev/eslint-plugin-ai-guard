/**
 * package-spec.ts — npm package names and version specs, as written in install
 * commands and package.json.
 *
 * Only registry packages are returned. Git URLs, GitHub shorthands, local paths,
 * tarballs and workspace protocols are not fetched from the npm registry, so
 * they are not checked (null).
 */

export interface PackageRequest {
  /** Registry package name, e.g. "lodash" or "@types/node". */
  name: string;
  /** Exact version, dist-tag or range; null means the latest release. */
  spec: string | null;
  /** The argument or dependency entry as written. */
  raw: string;
}

const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
const NON_REGISTRY = /^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|file:|link:|portal:|patch:|workspace:|exec:|https?:|ssh:)/i;

/** Valid npm package name (including legacy names with capitals, such as JSONStream). */
export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NAME.test(name) && !name.startsWith('.') && !name.startsWith('_');
}

export function isExactVersion(spec: string | null): spec is string {
  return spec !== null && EXACT_VERSION.test(spec);
}

/** A dist-tag such as "latest" or "next" (not a version or range). */
export function isDistTag(spec: string | null): spec is string {
  return spec !== null && /^[a-z][a-z0-9._-]*$/i.test(spec) && !EXACT_VERSION.test(spec);
}

function looksLikePath(arg: string): boolean {
  return /^(?:\.{1,2}[\\/]|[\\/]|~[\\/]?|[a-z]:[\\/])/i.test(arg) || /\.(?:tgz|tar\.gz|tar)$/i.test(arg) || arg === '.' || arg === '..';
}

function splitNameSpec(arg: string): { name: string; spec: string | null } {
  const at = arg.indexOf('@', arg.startsWith('@') ? 1 : 0);
  if (at === -1) return { name: arg, spec: null };
  const spec = arg.slice(at + 1);
  return { name: arg.slice(0, at), spec: spec === '' ? null : spec };
}

function normalizeSpec(spec: string | null): string | null {
  if (spec === null) return null;
  const trimmed = spec.trim();
  return trimmed === '' || trimmed === '*' || trimmed === 'latest' ? null : trimmed;
}

/**
 * A package argument of an install command: `lodash`, `lodash@4.17.21`,
 * `@types/node@^20`, `alias@npm:real@1`. Returns null for anything that is not
 * fetched from the registry by name.
 */
export function parsePackageArg(arg: string): PackageRequest | null {
  const raw = arg.trim();
  if (raw === '' || looksLikePath(raw) || NON_REGISTRY.test(raw) || raw.includes('://')) return null;
  // `user/repo` and `user/repo#branch` are GitHub shorthands for npm.
  if (!raw.startsWith('@') && raw.includes('/')) return null;
  const { name, spec } = splitNameSpec(raw);
  if (spec !== null && spec.startsWith('npm:')) {
    const target = parsePackageArg(spec.slice(4));
    return target ? { ...target, raw } : null;
  }
  if (spec !== null && (NON_REGISTRY.test(spec) || spec.includes('/') || spec.includes(':'))) return null;
  if (!isValidPackageName(name)) return null;
  return { name, spec: normalizeSpec(spec), raw };
}

/**
 * A package.json dependency entry. Returns the registry package it installs,
 * or null for workspace, file, link, git, URL and GitHub-shorthand entries.
 */
export function parseDependencySpec(name: string, value: unknown): PackageRequest | null {
  if (typeof value !== 'string') return null;
  const spec = value.trim();
  const raw = `${name}@${spec}`;
  if (NON_REGISTRY.test(spec) || spec.includes('://') || looksLikePath(spec)) return null;
  if (spec.startsWith('npm:')) {
    const target = parsePackageArg(spec.slice(4));
    return target ? { ...target, raw } : null;
  }
  // pnpm catalogs resolve to a registry version defined elsewhere.
  if (spec.startsWith('catalog:')) return isValidPackageName(name) ? { name, spec: null, raw } : null;
  if (/^[^@\s]+\/[^@\s]+/.test(spec)) return null; // user/repo
  if (!isValidPackageName(name)) return null;
  return { name, spec: normalizeSpec(spec), raw };
}

type Triple = [number, number, number];

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether `version` satisfies `range`, for the range forms package.json and
 * install commands use: exact, `=x`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, `*`, and
 * partial versions such as `1`, `1.2`, `1.x`, `^1.2`. Returns null for anything
 * else (`||`, hyphen ranges, `<`, prerelease ranges), so callers can skip
 * rather than guess. Prerelease versions only satisfy an exact match.
 */
export function rangeIncludes(range: string | null, version: string): boolean | null {
  const v = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim());
  if (!v) return null;
  const target: Triple = [Number(v[1]), Number(v[2]), Number(v[3])];
  const spec = (range ?? '').trim();
  if (spec === '' || spec === '*' || spec === 'x' || spec === 'latest') return !v[4];
  if (isExactVersion(spec) || /^=v?\d/.test(spec)) return spec.replace(/^=?v?/i, '') === version.trim().replace(/^v/i, '');
  const m = /^(\^|~|>=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(spec);
  if (!m) return null;
  if (v[4]) return false;
  const op = m[1] ?? '';
  const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || /^[x*]$/i.test(p) ? null : Number(p)));
  // A wildcard ends the version: 1.x.3 is not a range npm accepts.
  if (parts[1] === null && parts[2] !== null) return null;
  const given = parts.filter((p) => p !== null).length;
  const low: Triple = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  if (compare(target, low) < 0) return false;
  if (op === '>=') return true;
  let high: Triple;
  if (op === '^') {
    if (low[0] > 0 || given === 1) high = [low[0] + 1, 0, 0];
    else if (low[1] > 0 || given === 2) high = [0, low[1] + 1, 0];
    else high = [0, 0, low[2] + 1];
  } else if (op === '~' || given >= 2) {
    high = given === 1 ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0];
    if (op === '' && given === 3) return compare(target, low) === 0;
  } else {
    high = [low[0] + 1, 0, 0];
  }
  return compare(target, high) < 0;
}

/** `npm init <x>` / `npm create <x>` / `yarn create <x>` run the package `create-<x>`. */
export function initializerPackage(arg: string): PackageRequest | null {
  const raw = arg.trim();
  if (raw.startsWith('@')) {
    // @scope -> @scope/create, @scope/name -> @scope/create-name
    const slash = raw.indexOf('/');
    const { name, spec } = splitNameSpec(raw);
    if (slash === -1) {
      const scope = name;
      return isValidPackageName(`${scope}/create`) ? { name: `${scope}/create`, spec: normalizeSpec(spec), raw } : null;
    }
    const [scope, base] = name.split('/');
    const target = `${scope}/create-${base}`;
    return isValidPackageName(target) ? { name: target, spec: normalizeSpec(spec), raw } : null;
  }
  // npm always prefixes: `npm init create-foo` runs `create-create-foo`.
  const parsed = parsePackageArg(raw);
  if (!parsed) return null;
  const target = `create-${parsed.name}`;
  return isValidPackageName(target) ? { ...parsed, name: target } : null;
}
