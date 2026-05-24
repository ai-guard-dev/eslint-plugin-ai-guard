import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import chalk from 'chalk';
import { log } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type RuleLevel = 'error' | 'warn' | 'off';

export type Preset = 'recommended' | 'strict' | 'security';

export interface RunOptions {
  preset: Preset;
  targetPath: string;
  /** Explicit list of absolute file paths — bypasses glob traversal (used for changed-file mode) */
  files?: string[];
  maxWarnings?: number;
  jsonOutput?: boolean;
  debugTiming?: boolean;
  sarif?: boolean;
  /** Working directory override (monorepo subdirectory support) */
  workingDirectory?: string;
}

export interface IssueDetail {
  ruleId: string;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  /** Confidence tier from CONFIDENCE_TIER — included in JSON output */
  confidence?: 'high' | 'medium' | 'low' | 'informational';
  /** High-level category (Async Stability, Security, etc.) */
  category?: string;
  /** Async risk type for async-reliability rules */
  asyncRiskType?: string;
  /** Short remediation guidance */
  remediation?: string;
}

export interface FileResult {
  filePath: string;
  issues: IssueDetail[];      // ai-guard/* findings only
  errorCount: number;
  warningCount: number;
}

/**
 * An issue from a non-ai-guard rule (e.g., react-hooks/exhaustive-deps not found,
 * foreign plugin rules, missing rule definitions). These are ESLint ecosystem issues
 * and must NEVER appear in ai-guard findings or affect the score/confidence.
 */
export interface EcosystemIssue {
  type: 'missing-rule' | 'foreign-rule' | 'config-error';
  ruleId: string | null;
  message: string;
  filePath: string;
  line: number;
  column: number;
}

/**
 * A fatal parse error — ESLint could not parse the file at all.
 * Not an ai-guard finding. Shown in a separate section.
 */
export interface ParserError {
  filePath: string;
  message: string;
  line: number;
}

export interface TimingBreakdown {
  pluginLoadMs: number;
  parserLoadMs: number;
  lintMs: number;
  processMs: number;
  /** True if plugin/parser came from module cache (warm start) */
  fromCache: boolean;
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
  timing?: TimingBreakdown;
  /** ESLint ecosystem issues — NOT ai-guard findings */
  ecosystemIssues: EcosystemIssue[];
  /** Fatal parser errors — NOT ai-guard findings */
  parserErrors: ParserError[];
  /** True if @typescript-eslint/parser was found and loaded */
  tsParserAvailable: boolean;
}

// ─── Module-level cache ───────────────────────────────────────────────────────
//
// PERFORMANCE CRITICAL: ESLint initialization is expensive (~200-800ms per call
// due to module loading, config resolution, and parser startup). By caching the
// ESLint instance, plugin module, and TS parser at module level, we eliminate
// this overhead from all subsequent calls within the same process.
//
// Cache key: `${cwd}::${preset}` — invalidated on CWD or preset change.
// This is safe because a single CLI invocation uses one CWD and one preset.

// ─── Issue metadata ───────────────────────────────────────────────────────────
// Lookup tables for enriching IssueDetail with confidence, category,
// asyncRiskType, and remediation. Used in JSON output and SARIF results.

export const ISSUE_CONFIDENCE: Record<string, 'high' | 'medium' | 'low' | 'informational'> = {
  'ai-guard/no-hardcoded-secret':    'high',
  'ai-guard/no-eval-dynamic':        'high',
  'ai-guard/no-floating-promise':    'high',
  'ai-guard/no-empty-catch':         'high',
  'ai-guard/no-sql-string-concat':   'medium',
  'ai-guard/no-await-in-loop':       'medium',
  'ai-guard/require-auth-middleware':'medium',
  'ai-guard/require-authz-check':    'medium',
  'ai-guard/no-catch-log-rethrow':   'medium',
  'ai-guard/no-catch-without-use':   'medium',
  'ai-guard/no-unsafe-deserialize':  'medium',
  'ai-guard/no-async-array-callback':'low',
  'ai-guard/no-dead-branch':         'low',
  'ai-guard/no-broad-exception':     'low',
  'ai-guard/no-console-in-handler':  'low',
  'ai-guard/no-duplicate-logic-block':'low',
  'ai-guard/no-async-without-await': 'informational',
  'ai-guard/no-redundant-await':     'informational',
};

export const ISSUE_CATEGORY: Record<string, string> = {
  'ai-guard/no-floating-promise':    'Async Reliability',
  'ai-guard/no-await-in-loop':       'Async Reliability',
  'ai-guard/no-async-without-await': 'Async Reliability',
  'ai-guard/no-async-array-callback':'Async Reliability',
  'ai-guard/no-redundant-await':     'Async Reliability',
  'ai-guard/no-empty-catch':         'Reliability',
  'ai-guard/no-broad-exception':     'Reliability',
  'ai-guard/no-catch-log-rethrow':   'Reliability',
  'ai-guard/no-catch-without-use':   'Reliability',
  'ai-guard/no-hardcoded-secret':    'Security',
  'ai-guard/no-eval-dynamic':        'Security',
  'ai-guard/no-sql-string-concat':   'Security',
  'ai-guard/no-unsafe-deserialize':  'Security',
  'ai-guard/require-auth-middleware':'Security',
  'ai-guard/require-authz-check':    'Security',
  'ai-guard/no-console-in-handler':  'AI Patterns',
  'ai-guard/no-duplicate-logic-block':'AI Patterns',
  'ai-guard/no-dead-branch':         'AI Patterns',
};

export const ISSUE_ASYNC_RISK_TYPE: Record<string, string> = {
  'ai-guard/no-floating-promise':    'floating-promise',
  'ai-guard/no-await-in-loop':       'sequential-await',
  'ai-guard/no-async-without-await': 'unnecessary-async',
  'ai-guard/no-async-array-callback':'async-array-callback',
  'ai-guard/no-redundant-await':     'redundant-await',
};

export const ISSUE_REMEDIATION: Record<string, string> = {
  'ai-guard/no-floating-promise':    'Add `await` before the call, assign to a variable, or add `.catch()` to handle rejection.',
  'ai-guard/no-await-in-loop':       'Collect promises in an array and use `await Promise.all(...)` outside the loop.',
  'ai-guard/no-async-without-await': 'Remove `async` if no async operations are needed, or add an `await` expression.',
  'ai-guard/no-async-array-callback':'Use `Promise.all(array.map(async item => ...))` to ensure all async callbacks are awaited.',
  'ai-guard/no-redundant-await':     'Remove the `await` \u2014 the value is already resolved.',
  'ai-guard/no-empty-catch':         'Add error handling in the catch block, or at minimum log the error.',
  'ai-guard/no-broad-exception':     'Catch specific error types or re-throw after handling.',
  'ai-guard/no-catch-log-rethrow':   'Either log the error OR rethrow it \u2014 doing both duplicates the error in logs.',
  'ai-guard/no-catch-without-use':   'Use the caught error variable or rename to `_` to signal intentional suppression.',
  'ai-guard/no-hardcoded-secret':    'Move credentials to environment variables: `process.env.SECRET_KEY`.',
  'ai-guard/no-eval-dynamic':        'Avoid eval and Function constructors. Use safer alternatives like JSON.parse.',
  'ai-guard/no-sql-string-concat':   'Use parameterized queries or an ORM to prevent SQL injection.',
  'ai-guard/no-unsafe-deserialize':  'Validate input with a schema library (zod, joi, yup) before parsing.',
  'ai-guard/require-auth-middleware':'Add an authentication middleware before the route handler.',
  'ai-guard/require-authz-check':    'Verify the requesting user has permission to access this resource.',
  'ai-guard/no-console-in-handler':  'Replace console.log with a structured logger (pino, winston, etc.).',
  'ai-guard/no-duplicate-logic-block':'Extract the duplicated logic into a shared function.',
  'ai-guard/no-dead-branch':         'Remove the unreachable branch or fix the condition.',
};

interface CachedRunner {
  eslint: unknown; // ESLint instance — typed as unknown to avoid importing ESLint at module level
  tsParserAvailable: boolean;
  pluginLoadMs: number;
  parserLoadMs: number;
}

const _runnerCache = new Map<string, CachedRunner>();

/** Clear the module-level runner cache. Useful in tests that need a fresh state. */
export function clearRunnerCache(): void {
  _runnerCache.clear();
}

// ─── Plugin normalizer ────────────────────────────────────────────────────────

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

function getRules(preset: Preset): Record<string, RuleLevel> {
  if (preset === 'strict') return STRICT_RULES;
  if (preset === 'security') return SECURITY_RULES;
  return RECOMMENDED_RULES;
}

// ─── Default ignores ──────────────────────────────────────────────────────────
//
// PERFORMANCE: This list is critical for scan speed. Every directory listed here
// is skipped entirely during file traversal. Broad patterns (node_modules, dist)
// eliminate the bulk of files in typical projects. The extended list targets
// monorepo tooling and framework-generated directories.

const DEFAULT_IGNORE_PATTERNS = [
  // Core — always skip
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/out/**',
  '**/.git/**',
  // Build artifacts and caches
  '**/.cache/**',
  '**/.turbo/**',
  '**/.nx/**',
  '**/.parcel-cache/**',
  '**/.webpack/**',
  '**/tmp/**',
  '**/temp/**',
  // Package manager artifacts
  '**/.yarn/**',
  '**/.pnp.*',
  // Framework generated
  '**/.expo/**',
  '**/.svelte-kit/**',
  '**/storybook-static/**',
  '**/.storybook/generated/**',
  // Generated code
  '**/generated/**',
  '**/__generated__/**',
  '**/vendor/**',
  // Test outputs
  '**/test-results/**',
  '**/playwright-report/**',
  // Misc
  '**/.docusaurus/**',
  '**/.vitepress/cache/**',
];

export function isSkippablePatternError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('no files') ||
    msg.includes('no files matching') ||
    msg.includes('ignored') ||
    msg.includes('all files matched by') ||
    msg.includes('are ignored') ||
    msg.includes('was ignored') ||
    msg.includes('file ignored')
  );
}

// ─── Message classifier ───────────────────────────────────────────────────────

type MessageSource = 'ai-guard' | 'parser-error' | 'ecosystem';

function classifyMessage(msg: { ruleId: string | null; fatal?: boolean; message: string }): MessageSource {
  // Fatal parse errors (ESLint couldn't parse the file at all)
  if (msg.fatal === true) return 'parser-error';

  // Explicit parse errors in the message body
  if (msg.ruleId === null && (
    msg.message.startsWith('Parsing error') ||
    msg.message.includes('Unexpected token') ||
    msg.message.includes('SyntaxError')
  )) {
    return 'parser-error';
  }

  // Our rules — the only ones that count as ai-guard findings
  if (msg.ruleId && msg.ruleId.startsWith('ai-guard/')) {
    return 'ai-guard';
  }

  // Everything else: missing rule definitions, foreign plugin rules, config issues
  return 'ecosystem';
}

function classifyEcosystemType(
  msg: { ruleId: string | null; message: string },
): EcosystemIssue['type'] {
  const lower = msg.message.toLowerCase();
  if (lower.includes('definition for rule') && lower.includes('was not found')) {
    return 'missing-rule';
  }
  if (lower.includes('configuration') || lower.includes('config')) {
    return 'config-error';
  }
  return 'foreign-rule';
}

// ─── Plugin loader ────────────────────────────────────────────────────────────

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

// ─── Cached runner builder ────────────────────────────────────────────────────
//
// PERFORMANCE: This function builds the ESLint instance and caches it. All
// subsequent calls with the same cwd+preset reuse the cached instance, reducing
// startup overhead from ~500-1000ms to ~0ms on warm runs within the same process.

async function getOrBuildRunner(
  cwd: string,
  preset: Preset,
  eslintCwd: string,
): Promise<{ runner: CachedRunner; fromCache: boolean }> {
  const cacheKey = `${eslintCwd}::${preset}`;
  const cached = _runnerCache.get(cacheKey);
  if (cached) {
    return { runner: cached, fromCache: true };
  }

  // ── Parallel initialization ────────────────────────────────────────────────
  // Load ESLint module, plugin, and TS parser concurrently for maximum speed.
  // These are independent operations that can safely run in parallel.

  const [{ ESLint }, rawPlugin, tsParserResult] = await Promise.all([
    // 1. Load ESLint
    import('eslint').catch(() => {
      throw new Error('ESLint is not installed. Run: npm install --save-dev eslint');
    }),

    // 2. Load plugin
    loadPluginModuleFromCwd(cwd),

    // 3. Load TS parser (optional — errors are caught)
    Promise.resolve().then(() => {
      const parserStart = Date.now();
      try {
        // Prefer parser from user's project (correct version), fall back to ours
        let tsParser: unknown;
        try {
          tsParser = require(path.join(
            cwd,
            'node_modules',
            '@typescript-eslint',
            'parser',
          ));
        } catch {
          tsParser = require('@typescript-eslint/parser');
        }
        return { tsParser, available: true, loadMs: Date.now() - parserStart };
      } catch {
        log.debug('@typescript-eslint/parser not found — TypeScript files will use espree fallback');
        return { tsParser: null, available: false, loadMs: Date.now() - parserStart };
      }
    }),
  ]);

  const plugin = normalizePlugin(rawPlugin);
  const rules = getRules(preset);
  const { tsParser, available: tsParserAvailable } = tsParserResult;

  // ── Build flat config ──────────────────────────────────────────────────────
  //
  // PERFORMANCE: Using a single config block with `files` arrays instead of
  // separate blocks reduces ESLint's config resolution overhead. The ignores
  // block is placed first so ESLint can skip excluded files early.

  const JS_TS_FILES = [
    '**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx',
    '**/*.mts', '**/*.cts', '**/*.mjs', '**/*.cjs',
  ];

  const configBlocks: Array<Record<string, unknown>> = [
    // Ignore block first — ESLint can skip excluded files without processing
    { ignores: DEFAULT_IGNORE_PATTERNS },
    // JS/JSX — espree parser with JSX support
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
  ];

  if (tsParser) {
    // TS + TSX with TypeScript parser — JSX enabled for both
    configBlocks.push({
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      plugins: { 'ai-guard': plugin } as Record<string, unknown>,
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
      },
      rules: rules as Record<string, unknown>,
    });
  } else {
    // No TS parser — lint ts/tsx with espree (may partially fail on TS syntax)
    configBlocks.push({
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      plugins: { 'ai-guard': plugin } as Record<string, unknown>,
      languageOptions: {
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
      },
      rules: rules as Record<string, unknown>,
    });
  }

  const eslint = new ESLint({
    cwd: eslintCwd,
    overrideConfigFile: true as unknown as string,
    overrideConfig: configBlocks,
  });

  const runner: CachedRunner = {
    eslint,
    tsParserAvailable,
    pluginLoadMs: 0, // accounted in parallel Promise.all
    parserLoadMs: tsParserResult.loadMs,
  };

  _runnerCache.set(cacheKey, runner);
  return { runner, fromCache: false };
}

// ─── File patterns ────────────────────────────────────────────────────────────

const JS_TS_FILE_PATTERNS = [
  '**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx',
  '**/*.mts', '**/*.cts', '**/*.mjs', '**/*.cjs',
];

// ─── Core runner ──────────────────────────────────────────────────────────────

export async function runEslint(options: RunOptions): Promise<RunResult> {
  const overallStart = Date.now();

  const resolvedTargetPath = path.resolve(options.targetPath);

  if (!fs.existsSync(resolvedTargetPath)) {
    throw new Error(`Path not found: ${options.targetPath}`);
  }

  const targetStat = fs.statSync(resolvedTargetPath);
  const isSingleFileTarget = targetStat.isFile();
  const eslintCwd = isSingleFileTarget
    ? path.dirname(resolvedTargetPath)
    : resolvedTargetPath;

  const cwd = process.cwd();

  // ── Get or build cached runner ─────────────────────────────────────────────
  const initStart = Date.now();
  const { runner, fromCache } = await getOrBuildRunner(cwd, options.preset, eslintCwd);
  const initMs = Date.now() - initStart;

  const timing: TimingBreakdown = {
    pluginLoadMs: fromCache ? 0 : runner.pluginLoadMs,
    parserLoadMs: fromCache ? 0 : runner.parserLoadMs,
    lintMs: 0,
    processMs: 0,
    fromCache,
  };

  // ── Lint files ─────────────────────────────────────────────────────────────
  //
  // PERFORMANCE: Single lintFiles() call with all patterns is dramatically faster
  // than Promise.all of individual pattern calls. ESLint can batch file resolution
  // and share parser instances across files when called once.

  // ── Determine lint target ──────────────────────────────────────────────────
  //
  // Two modes:
  //  1. Explicit file list (changed-file mode): pass absolute paths directly
  //     to lintFiles() — bypasses glob traversal entirely. This is the fastest
  //     path and enables changed-file PR scanning.
  //  2. Pattern-based (full scan): use JS_TS_FILE_PATTERNS with cwd.

  const hasExplicitFiles = options.files && options.files.length > 0;
  const patterns = hasExplicitFiles
    ? options.files!  // absolute paths — ESLint accepts them directly
    : isSingleFileTarget
    ? [path.basename(resolvedTargetPath)]
    : JS_TS_FILE_PATTERNS;

  const lintStart = Date.now();
  let rawResults: Array<{
    filePath: string;
    messages: Array<{
      ruleId: string | null;
      severity: number;
      message: string;
      line: number;
      column: number;
      endLine?: number;
      endColumn?: number;
      fatal?: boolean;
    }>;
    errorCount: number;
    warningCount: number;
  }>;

  const eslint = runner.eslint as {
    lintFiles(patterns: string[]): Promise<typeof rawResults>;
  };

  try {
    rawResults = await eslint.lintFiles(patterns);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (isSkippablePatternError(error)) {
      // Single-call failed with "no files" — fall back to per-pattern
      log.debug('Single-call lintFiles failed, falling back to per-pattern');
      const perPatternResults = await Promise.allSettled(
        patterns.map(async (pattern) => {
          try {
            return await eslint.lintFiles([pattern]);
          } catch (patternErr: unknown) {
            const patternError = patternErr instanceof Error ? patternErr : new Error(String(patternErr));
            if (isSkippablePatternError(patternError)) {
              log.debug(`Skipping pattern '${pattern}' (no lintable files)`);
              return [] as typeof rawResults;
            }
            throw patternError;
          }
        }),
      );
      rawResults = perPatternResults
        .filter((r): r is PromiseFulfilledResult<typeof rawResults> => r.status === 'fulfilled')
        .flatMap((r) => r.value);
    } else {
      // Invalidate the cache for this key so the next call rebuilds fresh
      const cacheKey = `${eslintCwd}::${options.preset}`;
      _runnerCache.delete(cacheKey);
      throw error;
    }
  }
  timing.lintMs = Date.now() - lintStart;

  // ── Process results ────────────────────────────────────────────────────────
  const processStart = Date.now();

  const files: FileResult[] = [];
  const ecosystemIssues: EcosystemIssue[] = [];
  const parserErrors: ParserError[] = [];
  const ruleBreakdown = new Map<string, number>();
  let totalErrors = 0;
  let totalWarnings = 0;
  const filesScanned = rawResults.length;

  for (const result of rawResults) {
    if (result.messages.length === 0) continue;

    const relPath = path.relative(cwd, result.filePath);
    const aiGuardIssues: IssueDetail[] = [];
    let fileErrors = 0;
    let fileWarnings = 0;

    for (const m of result.messages) {
      const source = classifyMessage(m);

      if (source === 'parser-error') {
        parserErrors.push({
          filePath: relPath,
          message: m.message,
          line: m.line ?? 0,
        });
        continue;
      }

      if (source === 'ecosystem') {
        ecosystemIssues.push({
          type: classifyEcosystemType(m),
          ruleId: m.ruleId,
          message: m.message,
          filePath: relPath,
          line: m.line ?? 0,
          column: m.column ?? 0,
        });
        continue;
      }

      // source === 'ai-guard'
      const ruleId = m.ruleId ?? 'unknown';
      const issue: IssueDetail = {
        ruleId,
        severity: m.severity as 1 | 2,
        message: m.message,
        line: m.line,
        column: m.column,
        endLine: m.endLine,
        endColumn: m.endColumn,
        confidence: ISSUE_CONFIDENCE[ruleId],
        category: ISSUE_CATEGORY[ruleId],
        asyncRiskType: ISSUE_ASYNC_RISK_TYPE[ruleId],
        remediation: ISSUE_REMEDIATION[ruleId],
      };

      aiGuardIssues.push(issue);

      if (m.severity === 2) {
        fileErrors++;
        totalErrors++;
      } else {
        fileWarnings++;
        totalWarnings++;
      }

      ruleBreakdown.set(
        issue.ruleId,
        (ruleBreakdown.get(issue.ruleId) ?? 0) + 1,
      );
    }

    if (aiGuardIssues.length > 0) {
      files.push({
        filePath: relPath,
        issues: aiGuardIssues,
        errorCount: fileErrors,
        warningCount: fileWarnings,
      });
    }
  }

  const topFiles = [...files]
    .sort((a, b) => b.issues.length - a.issues.length)
    .slice(0, 10)
    .map((f) => ({ path: f.filePath, count: f.issues.length }));

  timing.processMs = Date.now() - processStart;

  if (options.debugTiming) {
    const totalMs = Date.now() - overallStart;
    const cacheLabel = fromCache ? chalk.green('warm cache') : chalk.yellow('cold start');
    log.debug(`Init:    ${initMs}ms (${cacheLabel})`);
    log.debug(`Lint:    ${timing.lintMs}ms`);
    log.debug(`Process: ${timing.processMs}ms`);
    log.debug(`Total:   ${totalMs}ms | Files: ${filesScanned} | ${filesScanned > 0 ? Math.round(totalMs / filesScanned) : 0}ms/file`);
  }

  return {
    files,
    totalErrors,
    totalWarnings,
    totalIssues: totalErrors + totalWarnings,
    filesScanned,
    ruleBreakdown,
    topFiles,
    durationMs: Date.now() - overallStart,
    timing,
    ecosystemIssues,
    parserErrors,
    tsParserAvailable: runner.tsParserAvailable,
  };
}
