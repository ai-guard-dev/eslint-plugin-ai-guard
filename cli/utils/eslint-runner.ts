import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { log } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type RuleLevel = 'error' | 'warn' | 'off';

export type Preset = 'recommended' | 'strict' | 'security';

export interface RunOptions {
  preset: Preset;
  targetPath: string;
  maxWarnings?: number;
  jsonOutput?: boolean;
}

export interface IssueDetail {
  ruleId: string;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
}

export interface FileResult {
  filePath: string;
  issues: IssueDetail[];
  errorCount: number;
  warningCount: number;
}

export interface RunResult {
  files: FileResult[];
  totalErrors: number;
  totalWarnings: number;
  totalIssues: number;
  filesScanned: number;
  ruleBreakdown: Map<string, number>;
  topFiles: Array<{ path: string; count: number }>;
  durationMs: number;
}

// ─── Plugin normalizer ────────────────────────────────────────────────────────
// Plugin exports `default` (ESM). When require()'d in CJS context it arrives as
// { default: { rules, configs, meta } }. We normalise both shapes.

type AiGuardPlugin = {
  rules: Record<string, unknown>;
  configs?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePlugin(raw: unknown): AiGuardPlugin {
  if (isRecord(raw) && isRecord(raw.default) && isRecord(raw.default.rules)) {
    return raw.default as AiGuardPlugin;
  }
  if (isRecord(raw) && isRecord(raw.rules)) {
    return raw as AiGuardPlugin;
  }
  throw new Error(
    'Could not load eslint-plugin-ai-guard. Run: npm install eslint-plugin-ai-guard',
  );
}

// ─── Preset rule maps ─────────────────────────────────────────────────────────

const RECOMMENDED_RULES: Record<string, RuleLevel> = {
  // Reliability
  'ai-guard/no-empty-catch': 'error',
  'ai-guard/no-broad-exception': 'warn',
  // Async
  'ai-guard/no-floating-promise': 'error',
  'ai-guard/no-await-in-loop': 'warn',
  'ai-guard/no-async-without-await': 'warn',
  'ai-guard/no-async-array-callback': 'warn',
  // Security
  'ai-guard/no-hardcoded-secret': 'error',
  'ai-guard/no-eval-dynamic': 'error',
  'ai-guard/no-sql-string-concat': 'warn',
  'ai-guard/no-unsafe-deserialize': 'warn',
  'ai-guard/require-auth-middleware': 'warn',
  'ai-guard/require-authz-check': 'warn',
  // AI Patterns
  'ai-guard/no-dead-branch': 'warn',
};

const STRICT_RULES: Record<string, RuleLevel> = {
  // Reliability
  'ai-guard/no-empty-catch': 'error',
  'ai-guard/no-broad-exception': 'error',
  'ai-guard/no-catch-log-rethrow': 'error',
  'ai-guard/no-catch-without-use': 'error',
  // Async
  'ai-guard/no-async-array-callback': 'error',
  'ai-guard/no-floating-promise': 'error',
  'ai-guard/no-await-in-loop': 'error',
  'ai-guard/no-async-without-await': 'error',
  'ai-guard/no-redundant-await': 'error',
  // Security
  'ai-guard/no-hardcoded-secret': 'error',
  'ai-guard/no-eval-dynamic': 'error',
  'ai-guard/no-sql-string-concat': 'error',
  'ai-guard/no-unsafe-deserialize': 'error',
  'ai-guard/require-auth-middleware': 'error',
  'ai-guard/require-authz-check': 'error',
  // AI Patterns
  'ai-guard/no-console-in-handler': 'error',
  'ai-guard/no-duplicate-logic-block': 'error',
  'ai-guard/no-dead-branch': 'error',
};

const SECURITY_RULES: Record<string, RuleLevel> = {
  'ai-guard/no-hardcoded-secret': 'error',
  'ai-guard/no-eval-dynamic': 'error',
  'ai-guard/no-sql-string-concat': 'error',
  'ai-guard/no-unsafe-deserialize': 'warn',
  'ai-guard/require-auth-middleware': 'warn',
  'ai-guard/require-authz-check': 'warn',
};

function getRules(
  preset: Preset,
): Record<string, RuleLevel> {
  if (preset === 'strict') return STRICT_RULES;
  if (preset === 'security') return SECURITY_RULES;
  return RECOMMENDED_RULES;
}

// ─── Default ignores ──────────────────────────────────────────────────────────

const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/out/**',
  '**/.git/**',
];

// Some ESLint pattern scans should be skipped (not treated as fatal), e.g.:
// - pattern has no matching files
// - matched files are ignored by config/ignore rules
export function isSkippablePatternError(error: Error): boolean {
  const msg = error.message.toLowerCase();

  const hasNoFilesSignal =
    msg.includes('no files') ||
    msg.includes('no files matching');

  const hasIgnoredSignal =
    msg.includes('ignored') ||
    msg.includes('all files matched by') ||
    msg.includes('are ignored') ||
    msg.includes('was ignored') ||
    msg.includes('file ignored');

  return hasNoFilesSignal || hasIgnoredSignal;
}

async function loadPluginModuleFromCwd(cwd: string): Promise<unknown> {
  const { createRequire } = await import('module');
  const requireFromCwd = createRequire(path.join(cwd, 'package.json'));

  try {
    const resolved = requireFromCwd.resolve('eslint-plugin-ai-guard');
    return import(pathToFileURL(resolved).href);
  } catch {
    // Fall through to local dist fallback.
  }

  const localDistEntry = path.join(cwd, 'dist', 'index.js');
  if (fs.existsSync(localDistEntry)) {
    return import(pathToFileURL(localDistEntry).href);
  }

  const localSrcEntry = path.join(cwd, 'src', 'index.ts');
  if (fs.existsSync(localSrcEntry)) {
    try {
      return import(pathToFileURL(localSrcEntry).href);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug(`Local src plugin import failed: ${reason}`);
    }
  }

  throw new Error(
    'eslint-plugin-ai-guard is not installed. Run: npm install --save-dev eslint-plugin-ai-guard',
  );
}

// ─── Core runner ──────────────────────────────────────────────────────────────

export async function runEslint(options: RunOptions): Promise<RunResult> {
  const { ESLint } = await import('eslint').catch(() => {
    throw new Error(
      'ESLint is not installed. Run: npm install --save-dev eslint',
    );
  });

  // Load the plugin — resolve relative to the user's cwd so it finds their install
  const rawPlugin = await loadPluginModuleFromCwd(process.cwd());

  const plugin = normalizePlugin(rawPlugin);
  const rules = getRules(options.preset);
  const resolvedTargetPath = path.resolve(options.targetPath);

  if (!fs.existsSync(resolvedTargetPath)) {
    throw new Error(`Path not found: ${options.targetPath}`);
  }

  const targetStat = fs.statSync(resolvedTargetPath);
  const isSingleFileTarget = targetStat.isFile();
  const eslintCwd = isSingleFileTarget
    ? path.dirname(resolvedTargetPath)
    : resolvedTargetPath;

  const startMs = Date.now();

  const JS_TS_FILES = [
    '**/*.js',
    '**/*.jsx',
    '**/*.ts',
    '**/*.tsx',
    '**/*.mts',
    '**/*.cts',
    '**/*.mjs',
    '**/*.cjs',
  ];

  // ESLint v9 programmatic API: use overrideConfigFile to disable config file
  // discovery and overrideConfig to inject our plugin config.
  // For single-file scans, set cwd to the file's directory and lint only that file.

  // Try to load TypeScript parser for .ts/.tsx files
  let tsParser: unknown = null;
  try {
    // Try user's project first, then our own node_modules
    try {
      tsParser = require(path.join(
        process.cwd(),
        'node_modules',
        '@typescript-eslint',
        'parser',
      ));
    } catch {
      tsParser = require('@typescript-eslint/parser');
    }
  } catch {
    // TypeScript parser not available — ts files will use default espree parser
  }

  const configBlocks: Array<Record<string, unknown>> = [
    // JS/JSX files — default espree parser
    {
      files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
      plugins: { 'ai-guard': plugin } as Record<string, unknown>,
      languageOptions: {
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
      },
      rules: rules as Record<string, unknown>,
    },
    // Ignore generated directories
    { ignores: DEFAULT_IGNORE_PATTERNS },
  ];

  if (tsParser) {
    configBlocks.splice(1, 0, {
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      plugins: { 'ai-guard': plugin } as Record<string, unknown>,
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          // project: true would be needed for type-aware rules — skip for speed
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
      },
      rules: rules as Record<string, unknown>,
    });
  } else {
    // No TS parser — still lint ts files but they may fail to parse
    configBlocks.splice(1, 0, {
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      plugins: { 'ai-guard': plugin } as Record<string, unknown>,
      rules: rules as Record<string, unknown>,
    });
  }

  const eslint = new ESLint({
    cwd: eslintCwd,
    overrideConfigFile: true as unknown as string,
    overrideConfig: configBlocks,
  });

  // Use relative glob patterns for directory scans, and a direct file pattern for file scans.
  const patterns = isSingleFileTarget
    ? [path.basename(resolvedTargetPath)]
    : JS_TS_FILES;

  // ESLint v9 throws if no files match a pattern — run each glob independently
  // and collect results, silently skipping 'no files found' errors
  const perPatternResults = await Promise.all(
    patterns.map(async (pattern) => {
      try {
        return await eslint.lintFiles([pattern]);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));

        if (isSkippablePatternError(error)) {
          log.debug(`Skipping pattern '${pattern}' (no lintable files)`);
          return [];
        }

        // Real ESLint runtime/config/parser errors should fail fast.
        throw error;
      }
    }),
  );

  const rawResults = perPatternResults.flat();

  const durationMs = Date.now() - startMs;

  // ─── Process results ─────────────────────────────────────────────────────

  const files: FileResult[] = [];
  const ruleBreakdown = new Map<string, number>();
  let totalErrors = 0;
  let totalWarnings = 0;
  // Count all results (including those with no issues) as scanned
  const filesScanned = rawResults.length;

  for (const result of rawResults) {
    if (result.messages.length === 0) continue;

    const issues: IssueDetail[] = result.messages.map((m) => ({
      ruleId: m.ruleId ?? 'unknown',
      severity: m.severity as 1 | 2,
      message: m.message,
      line: m.line,
      column: m.column,
    }));

    const errorCount = result.errorCount;
    const warningCount = result.warningCount;
    totalErrors += errorCount;
    totalWarnings += warningCount;

    for (const issue of issues) {
      ruleBreakdown.set(
        issue.ruleId,
        (ruleBreakdown.get(issue.ruleId) ?? 0) + 1,
      );
    }

    const relPath = path.relative(process.cwd(), result.filePath);
    files.push({ filePath: relPath, issues, errorCount, warningCount });
  }

  // Top files by issue count (top 10)
  const topFiles = [...files]
    .sort((a, b) => b.issues.length - a.issues.length)
    .slice(0, 10)
    .map((f) => ({ path: f.filePath, count: f.issues.length }));

  return {
    files,
    totalErrors,
    totalWarnings,
    totalIssues: totalErrors + totalWarnings,
    filesScanned,
    ruleBreakdown,
    topFiles,
    durationMs,
  };
}
