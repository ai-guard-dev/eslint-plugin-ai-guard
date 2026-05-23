import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfigType =
  | 'flat-js'
  | 'flat-mjs'
  | 'flat-cjs'
  | 'eslintrc-js'
  | 'eslintrc-cjs'
  | 'eslintrc-json'
  | 'eslintrc-yaml'
  | 'none';

export interface DetectionResult {
  /** Raw version string e.g. "9.1.0" — null if not installed */
  eslintVersion: string | null;
  eslintMajor: number | null;
  pluginInstalled: boolean;
  configType: ConfigType;
  configPath: string | null;
  /** All config files found — to detect conflicts */
  allConfigPaths: string[];
  /** True when a flat config AND a legacy config both exist */
  hasConflictingConfigs: boolean;
  /** True when config contains a pattern that ignores everything */
  hasNukeIgnore: boolean;
}

// ─── Config file registry ─────────────────────────────────────────────────────

const FLAT_CONFIG_FILES: Array<{ file: string; type: ConfigType }> = [
  { file: 'eslint.config.js', type: 'flat-js' },
  { file: 'eslint.config.mjs', type: 'flat-mjs' },
  { file: 'eslint.config.cjs', type: 'flat-cjs' },
];

const LEGACY_CONFIG_FILES: Array<{ file: string; type: ConfigType }> = [
  { file: '.eslintrc.js', type: 'eslintrc-js' },
  { file: '.eslintrc.cjs', type: 'eslintrc-cjs' },
  { file: '.eslintrc.json', type: 'eslintrc-json' },
  { file: '.eslintrc.yaml', type: 'eslintrc-yaml' },
  { file: '.eslintrc.yml', type: 'eslintrc-yaml' },
];

const ALL_CONFIG_FILES = [...FLAT_CONFIG_FILES, ...LEGACY_CONFIG_FILES];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isPackageInstalled(pkgName: string, cwd = process.cwd()): boolean {
  try {
    const pkgPath = path.join(cwd, 'node_modules', pkgName, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return true;
    }

    const req = createRequire(path.join(cwd, 'package.json'));
    req.resolve(`${pkgName}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a package.json version from node_modules.
 * Reads directly from disk — no require() involvement — so it always
 * reflects the *installed* version even when running inside a bundled binary.
 */
export function getPackageVersion(pkgName: string, cwd = process.cwd()): string | null {
  try {
    const pkgPath = path.join(cwd, 'node_modules', pkgName, 'package.json');
    const resolvedPath = fs.existsSync(pkgPath)
      ? pkgPath
      : createRequire(path.join(cwd, 'package.json')).resolve(`${pkgName}/package.json`);
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const json = JSON.parse(raw) as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  }
}

/** Parse the major version number from a semver string */
export function parseMajor(version: string | null): number | null {
  if (!version) return null;
  const n = parseInt(version.split('.')[0], 10);
  return isNaN(n) ? null : n;
}

// ─── Config detection ─────────────────────────────────────────────────────────

export function detectConfigType(cwd = process.cwd()): {
  type: ConfigType;
  path: string | null;
  allPaths: string[];
} {
  const found: string[] = [];
  let first: { type: ConfigType; path: string } | null = null;

  for (const { file, type } of ALL_CONFIG_FILES) {
    const fullPath = path.join(cwd, file);
    if (fs.existsSync(fullPath)) {
      found.push(fullPath);
      if (!first) first = { type, path: fullPath };
    }
  }

  return {
    type: first?.type ?? 'none',
    path: first?.path ?? null,
    allPaths: found,
  };
}

export function isFlat(type: ConfigType): boolean {
  return type === 'flat-js' || type === 'flat-mjs' || type === 'flat-cjs';
}

export function isLegacy(type: ConfigType): boolean {
  return (
    type === 'eslintrc-js' ||
    type === 'eslintrc-cjs' ||
    type === 'eslintrc-json' ||
    type === 'eslintrc-yaml'
  );
}

/**
 * Returns true if the given ESLint major version requires flat config.
 * ESLint 9+ uses flat config by default; ESLint 8 uses legacy config.
 */
export function requiresFlatConfig(eslintMajor: number | null): boolean {
  return eslintMajor !== null && eslintMajor >= 9;
}

/**
 * Check for "nuke" ignore patterns — patterns that silently exclude all files.
 * Common culprit: ignorePatterns: ["**\/*"] or ignores: ["**\/*"]
 */
function detectNukeIgnore(configPath: string | null): boolean {
  if (!configPath) return false;
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return content.includes('"**/*"') || content.includes("'**/*'");
  } catch {
    return false;
  }
}

// ─── Main detection entry point ───────────────────────────────────────────────

export function detect(cwd = process.cwd()): DetectionResult {
  const eslintVersion = getPackageVersion('eslint', cwd);
  const eslintMajor = parseMajor(eslintVersion);
  const pluginInstalled = isPackageInstalled('eslint-plugin-ai-guard', cwd);

  const { type: configType, path: configPath, allPaths } = detectConfigType(cwd);

  // Conflict: both flat AND legacy config files exist
  const hasFlatConfig = allPaths.some((p) =>
    FLAT_CONFIG_FILES.some((c) => p.endsWith(c.file)),
  );
  const hasLegacyConfig = allPaths.some((p) =>
    LEGACY_CONFIG_FILES.some((c) => p.endsWith(c.file)),
  );
  const hasConflictingConfigs = hasFlatConfig && hasLegacyConfig;

  const hasNukeIgnore = detectNukeIgnore(configPath);

  return {
    eslintVersion,
    eslintMajor,
    pluginInstalled,
    configType,
    configPath,
    allConfigPaths: allPaths,
    hasConflictingConfigs,
    hasNukeIgnore,
  };
}

// ─── Monorepo detection ────────────────────────────────────────────────────────

export interface MonorepoResult {
  isMonorepo: boolean;
  tool: 'pnpm' | 'npm-workspaces' | 'yarn-workspaces' | 'nx' | 'turborepo' | 'lerna' | null;
  packages: string[];
}

export function detectMonorepo(cwd = process.cwd()): MonorepoResult {
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
    return { isMonorepo: true, tool: 'pnpm', packages: discoverWorkspacePackages(cwd) };
  }
  if (fs.existsSync(path.join(cwd, 'nx.json'))) {
    return { isMonorepo: true, tool: 'nx', packages: discoverWorkspacePackages(cwd) };
  }
  if (fs.existsSync(path.join(cwd, 'turbo.json'))) {
    return { isMonorepo: true, tool: 'turborepo', packages: discoverWorkspacePackages(cwd) };
  }
  if (fs.existsSync(path.join(cwd, 'lerna.json'))) {
    return { isMonorepo: true, tool: 'lerna', packages: discoverWorkspacePackages(cwd) };
  }
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        workspaces?: string[] | { packages?: string[] };
      };
      if (pkg.workspaces) {
        const tool = fs.existsSync(path.join(cwd, 'yarn.lock'))
          ? ('yarn-workspaces' as const)
          : ('npm-workspaces' as const);
        return { isMonorepo: true, tool, packages: discoverWorkspacePackages(cwd) };
      }
    }
  } catch { /* not a monorepo */ }
  return { isMonorepo: false, tool: null, packages: [] };
}

function discoverWorkspacePackages(cwd: string): string[] {
  const commonDirs = ['packages', 'apps', 'libs', 'modules', 'services'];
  const found: string[] = [];
  for (const dir of commonDirs) {
    const dirPath = path.join(cwd, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(dirPath, entry.name, 'package.json'))) {
          found.push(path.join(dir, entry.name));
        }
      }
    } catch { /* skip */ }
  }
  return found;
}
