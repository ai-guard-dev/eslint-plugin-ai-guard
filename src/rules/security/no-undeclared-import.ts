import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';
import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import { parseJsonc } from '../../utils/jsonc';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

const BUILTINS = new Set(builtinModules);

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.d.ts', '.vue', '.svelte'];
const TSCONFIG_FILE = /^[tj]sconfig(?:\.[\w-]+)?\.json$/;

interface PackageInfo {
  dir: string;
  names: Set<string>;
}

interface AliasInfo {
  /** Exact `paths` keys and wildcard prefixes (key before the `*`). */
  exact: Set<string>;
  prefixes: string[];
  /** Absolute `baseUrl` directories. */
  baseUrls: string[];
}

interface ProjectContext {
  declared: Set<string>;
  packageDirs: string[];
  aliases: AliasInfo;
}

// ─── Filesystem caches ───────────────────────────────────────────────────────
// package.json and tsconfig contents are re-read when their mtime changes, so a
// long-running process (MCP server, editor) sees dependencies an agent just added.

const fileCache = new Map<string, { mtimeMs: number; value: unknown }>();

function readJsonCached(file: string, parse: (text: string) => unknown): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  let value: unknown = null;
  try {
    value = parse(fs.readFileSync(file, 'utf8'));
  } catch {
    value = null;
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, value });
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPackage(file: string): PackageInfo | null {
  const pkg = readJsonCached(file, JSON.parse);
  if (!isRecord(pkg)) return null;
  const names = new Set<string>();
  if (typeof pkg.name === 'string') names.add(pkg.name);
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (isRecord(deps)) for (const name of Object.keys(deps)) names.add(name);
  }
  for (const field of ['bundleDependencies', 'bundledDependencies']) {
    const deps = pkg[field];
    if (Array.isArray(deps)) for (const name of deps) if (typeof name === 'string') names.add(name);
  }
  return { dir: path.dirname(file), names };
}

function collectAliases(dir: string, aliases: AliasInfo): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (TSCONFIG_FILE.test(entry)) readTsconfig(path.join(dir, entry), aliases, 0);
  }
}

function readTsconfig(file: string, aliases: AliasInfo, depth: number): void {
  if (depth > 3) return;
  const config = readJsonCached(file, parseJsonc);
  if (!isRecord(config)) return;
  const dir = path.dirname(file);

  if (typeof config.extends === 'string' && config.extends.startsWith('.')) {
    const target = path.resolve(dir, config.extends);
    readTsconfig(target.endsWith('.json') ? target : `${target}.json`, aliases, depth + 1);
  }

  const options = config.compilerOptions;
  if (!isRecord(options)) return;
  if (typeof options.baseUrl === 'string') aliases.baseUrls.push(path.resolve(dir, options.baseUrl));
  if (isRecord(options.paths)) {
    for (const key of Object.keys(options.paths)) {
      const star = key.indexOf('*');
      if (star === -1) aliases.exact.add(key);
      else aliases.prefixes.push(key.slice(0, star));
    }
  }
}

/** Short-lived so a long-running process notices a dependency an agent just added. */
const PROJECT_CACHE_TTL_MS = 2000;
const projectCache = new Map<string, { at: number; project: ProjectContext | null }>();

/** Test hook: forget cached project lookups. */
export function clearUndeclaredImportCache(): void {
  projectCache.clear();
  fileCache.clear();
}

/**
 * Walks up from the file collecting every package.json until the repository
 * root (a directory with `.git`). Dependencies are unioned so a workspace
 * package can rely on tooling declared once at the monorepo root.
 */
function getProjectContext(fileDir: string): ProjectContext | null {
  const now = Date.now();
  const cached = projectCache.get(fileDir);
  if (cached && now - cached.at < PROJECT_CACHE_TTL_MS) return cached.project;
  const project = buildProjectContext(fileDir);
  projectCache.set(fileDir, { at: now, project });
  return project;
}

function buildProjectContext(fileDir: string): ProjectContext | null {
  const declared = new Set<string>();
  const packageDirs: string[] = [];
  const aliases: AliasInfo = { exact: new Set(), prefixes: [], baseUrls: [] };

  let dir = fileDir;
  for (let i = 0; i < 50; i++) {
    const pkg = readPackage(path.join(dir, 'package.json'));
    if (pkg) {
      for (const name of pkg.names) declared.add(name);
      packageDirs.push(dir);
      collectAliases(dir, aliases);
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageDirs.length > 0 ? { declared, packageDirs, aliases } : null;
}

// ─── Specifier analysis ──────────────────────────────────────────────────────

/** Returns the npm package name a specifier refers to, or null for non-package specifiers. */
export function getPackageName(specifier: string): string | null {
  const spec = specifier.split('?')[0];
  if (!spec || spec.includes('!')) return null; // webpack loader syntax
  if (/^[./]/.test(spec) || path.isAbsolute(spec)) return null;
  if (/^[#~$]/.test(spec)) return null; // subpath imports, ~/ and $lib aliases
  if (spec.startsWith('@/') || spec.startsWith('@@/') || spec === '@') return null;
  if (/^[\w.-]+:/.test(spec)) return null; // node:, bun:, virtual:, astro:, npm:, https:

  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2 || !parts[0].slice(1) || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function typesPackageName(name: string): string {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

function existsAsSource(base: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => fs.existsSync(base + ext));
}

/** True when the specifier resolves through a tsconfig alias or a local directory. */
function isLocalAlias(specifier: string, packageName: string, project: ProjectContext): boolean {
  const { aliases } = project;
  if (aliases.exact.has(specifier) || aliases.exact.has(packageName)) return true;
  if (aliases.prefixes.some((prefix) => prefix.length > 0 && specifier.startsWith(prefix))) return true;

  const firstSegment = specifier.split('/')[0];
  // baseUrl imports (`components/Button`) and bundler aliases that mirror a
  // directory name (`utils/format` -> src/utils).
  const roots = [...aliases.baseUrls];
  for (const dir of project.packageDirs) roots.push(dir, path.join(dir, 'src'));
  return roots.some((root) => existsAsSource(path.join(root, firstSegment)));
}

function isInstalled(packageName: string, project: ProjectContext): boolean {
  return project.packageDirs.some((dir) => fs.existsSync(path.join(dir, 'node_modules', packageName)));
}

/**
 * `try { require('fsevents') } catch {}` and `await import('open').catch(...)`
 * load an optional dependency on purpose; a missing package is handled.
 */
function isGuardedOptionalLoad(node: TSESTree.Node): boolean {
  const parent = node.parent;
  if (
    parent?.type === AST_NODE_TYPES.MemberExpression &&
    parent.object === node &&
    parent.property.type === AST_NODE_TYPES.Identifier &&
    parent.parent?.type === AST_NODE_TYPES.CallExpression &&
    (parent.property.name === 'catch' || (parent.property.name === 'then' && parent.parent.arguments.length >= 2))
  ) {
    return true;
  }
  let child: TSESTree.Node = node;
  let current = node.parent;
  while (current) {
    if (current.type === AST_NODE_TYPES.TryStatement && current.block === child && current.handler) return true;
    if (
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression ||
      current.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return false;
    }
    child = current;
    current = current.parent;
  }
  return false;
}

function matchesAllowList(name: string, allow: string[]): boolean {
  return allow.some((pattern) =>
    pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name
  );
}

type Options = [{ allow?: string[] }];
type MessageIds = 'notInstalled' | 'phantomDependency';

export const noUndeclaredImport = createRule<Options, MessageIds>({
  name: 'no-undeclared-import',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow imports of packages that are not declared in package.json. AI models invent plausible package names (5-22% of suggested packages do not exist), and attackers register those names on npm ("slopsquatting"). Catching the import before `npm install` runs stops the attack; it also catches phantom dependencies that only work through hoisting.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Module names provided by the runtime or host (exact names, or a scope such as "@acme/*").',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      notInstalled:
        '"{{name}}" is not declared in package.json and is not installed. AI tools invent plausible package names, and attackers publish malware under them (slopsquatting). Confirm on npmjs.com that "{{name}}" is the package you meant before installing it, or fix the import if it should be a local module.',
      phantomDependency:
        '"{{name}}" is installed but not declared in package.json, so it is only present as a dependency of another package. A clean install, pnpm, or an upgrade of that package can remove it. Add "{{name}}" to dependencies.',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const filename = context.physicalFilename || context.filename;
    if (!filename || filename.startsWith('<') || !path.isAbsolute(filename)) return {};
    if (/[\\/]node_modules[\\/]/.test(filename)) return {};

    const project = getProjectContext(path.dirname(filename));
    if (!project) return {};
    const allow = options.allow ?? [];

    function check(source: TSESTree.Node | null | undefined, loadExpression?: TSESTree.Node): void {
      if (!source || source.type !== AST_NODE_TYPES.Literal || typeof source.value !== 'string') return;
      if (loadExpression && isGuardedOptionalLoad(loadExpression)) return;
      const specifier = source.value;
      const name = getPackageName(specifier);
      if (!name || !project) return;
      if (BUILTINS.has(name) || BUILTINS.has(specifier)) return;
      if (project.declared.has(name) || project.declared.has(typesPackageName(name))) return;
      if (matchesAllowList(name, allow)) return;
      if (isLocalAlias(specifier, name, project)) return;

      context.report({
        node: source,
        messageId: isInstalled(name, project) ? 'phantomDependency' : 'notInstalled',
        data: { name },
      });
    }

    return {
      ImportDeclaration: (node): void => check(node.source),
      ExportNamedDeclaration: (node): void => check(node.source),
      ExportAllDeclaration: (node): void => check(node.source),
      ImportExpression: (node): void => check(node.source, node),
      TSImportEqualsDeclaration(node): void {
        if (node.moduleReference.type === AST_NODE_TYPES.TSExternalModuleReference) {
          check(node.moduleReference.expression);
        }
      },
      CallExpression(node): void {
        if (node.arguments.length !== 1) return;
        const callee = node.callee;
        const isRequire = callee.type === AST_NODE_TYPES.Identifier && callee.name === 'require';
        const isRequireResolve =
          callee.type === AST_NODE_TYPES.MemberExpression &&
          callee.object.type === AST_NODE_TYPES.Identifier &&
          callee.object.name === 'require' &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          callee.property.name === 'resolve';
        if (isRequire || isRequireResolve) check(node.arguments[0], node);
      },
    };
  },
});

export default noUndeclaredImport;
