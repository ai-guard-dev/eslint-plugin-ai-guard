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
