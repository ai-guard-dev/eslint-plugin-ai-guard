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
  debugTiming?: boolean;
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

const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/out/**',
  '**/.git/**',
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

// ─── Core runner ──────────────────────────────────────────────────────────────

export async function runEslint(options: RunOptions): Promise<RunResult> {
  const overallStart = Date.now();
  const timing: TimingBreakdown = {
    pluginLoadMs: 0,
    parserLoadMs: 0,
    lintMs: 0,
    processMs: 0,
  };

  const { ESLint } = await import('eslint').catch(() => {
    throw new Error(
      'ESLint is not installed. Run: npm install --save-dev eslint',
    );
  });

  // ── Load plugin ────────────────────────────────────────────────────────────
  const pluginStart = Date.now();
  const rawPlugin = await loadPluginModuleFromCwd(process.cwd());
  const plugin = normalizePlugin(rawPlugin);
  timing.pluginLoadMs = Date.now() - pluginStart;

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

  // ── Load TypeScript parser ─────────────────────────────────────────────────
  const parserStart = Date.now();
  let tsParser: unknown = null;
  let tsParserAvailable = false;
  try {
    // Prefer parser from user's project, fall back to ours
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
    tsParserAvailable = true;
  } catch {
    // TypeScript parser not available — ts/tsx files will use default espree parser
    log.debug('@typescript-eslint/parser not found — TypeScript files will use espree fallback');
  }
  timing.parserLoadMs = Date.now() - parserStart;

  // ── Build ESLint config ────────────────────────────────────────────────────

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

  const configBlocks: Array<Record<string, unknown>> = [
    // JS/JSX files — default espree parser with JSX support
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
    // TS + TSX with TypeScript parser — JSX enabled for both
    configBlocks.splice(1, 0, {
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
    // No TS parser — lint ts/tsx files but they may partially fail to parse
    configBlocks.splice(1, 0, {
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

  // ── Lint files ─────────────────────────────────────────────────────────────
  // Task 7: Use single lintFiles call with all patterns for maximum performance.
  // This avoids per-pattern ESLint API round-trips which cause massive overhead.

  const patterns = isSingleFileTarget
    ? [path.basename(resolvedTargetPath)]
    : JS_TS_FILES;

  const lintStart = Date.now();
  let rawResults: Array<{
    filePath: string;
    messages: Array<{
      ruleId: string | null;
      severity: number;
      message: string;
      line: number;
      column: number;
      fatal?: boolean;
    }>;
    errorCount: number;
    warningCount: number;
  }>;

  try {
    // Single call — much faster than Promise.all of individual patterns
    rawResults = await eslint.lintFiles(patterns) as typeof rawResults;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (isSkippablePatternError(error)) {
      // If single-call fails with "no files", fall back to per-pattern
      log.debug('Single-call lintFiles failed with no-files, falling back to per-pattern');
      const perPatternResults = await Promise.all(
        patterns.map(async (pattern) => {
          try {
            return await eslint.lintFiles([pattern]) as typeof rawResults;
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
      rawResults = perPatternResults.flat();
    } else {
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

    const relPath = path.relative(process.cwd(), result.filePath);
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
      const issue: IssueDetail = {
        ruleId: m.ruleId ?? 'unknown',
        severity: m.severity as 1 | 2,
        message: m.message,
        line: m.line,
        column: m.column,
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
    log.debug(`Plugin load: ${timing.pluginLoadMs}ms`);
    log.debug(`Parser load: ${timing.parserLoadMs}ms`);
    log.debug(`Lint: ${timing.lintMs}ms`);
    log.debug(`Process: ${timing.processMs}ms`);
    log.debug(`Total: ${Date.now() - overallStart}ms`);
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
    tsParserAvailable,
  };
}
