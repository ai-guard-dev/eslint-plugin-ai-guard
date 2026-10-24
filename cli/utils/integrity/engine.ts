/**
 * Integrity engine — one deterministic analysis shared by the CLI
 * (`ai-guard integrity`, `ai-guard changed --integrity`), the GitHub Action,
 * the Claude Code hooks and the MCP server.
 *
 * It compares a base revision with the working tree (or the index) and only
 * reports weakenings introduced by the change; conditions that already exist
 * at the base are never reported. No network access and no model calls.
 */

import path from 'path';
import { analyzeJs, isTestPath, JS_TS_EXTENSIONS, parseAst, type JsFacts } from './js-facts.js';
import { analyzeSuppressions, analyzeTests, type JsFilePair } from './analyze-js.js';
import {
  analyzeAcceptances,
  analyzeCoverageAndTestConfig,
  analyzeEslintConfig,
  analyzeHuskyHook,
  analyzeIgnoreFile,
  analyzePackageJson,
  analyzeSnapshot,
  analyzeTsconfig,
  analyzeWorkflow,
  classifyConfig,
  packageJsonSection,
  workflowVerificationCommands,
  type ConfigKind,
} from './analyze-config.js';
import { entriesFromAst, entriesFromValue, parseJsonc, parseYaml, type PathEntry } from './config-values.js';
import {
  IntegrityGitError,
  addedLinesForAll,
  listChanges,
  readBlobs,
  readHeadFile,
  resolveBase,
  type ChangedEntry,
  type ResolvedBase,
} from './git.js';
import {
  compareFindings,
  finalizeFinding,
  type FindingDraft,
  type IntegrityError,
  type IntegrityFinding,
  type IntegrityReport,
} from './types.js';

export interface AnalyzeOptions {
  cwd: string;
  /** Base ref; omit for HEAD (uncommitted changes, plus untracked files). */
  base?: string;
  /** Compare with merge-base(HEAD, base) — PR semantics. */
  mergeBase?: boolean;
  /** Try `origin/<base>` before `<base>` (CLI behaviour, matches `changed`). */
  preferRemote?: boolean;
  /** Compare the index instead of the working tree. */
  staged?: boolean;
  /**
   * Restrict analysis to these paths (absolute or repo-relative). Test-count
   * reductions are advisory in this mode because moves to other files cannot
   * be seen.
   */
  paths?: string[];
  /**
   * Only analyze changes under this directory (absolute). Unlike `paths`, the
   * analysis stays change-wide within the directory (MCP workspace isolation).
   */
  scope?: string;
  /** Fingerprints accepted explicitly in the baseline file. */
  acceptedFingerprints?: Iterable<string>;
  /** Use the packaged TypeScript parser only (MCP isolation). */
  isolated?: boolean;
  /** Maximum number of relevant files to analyze. */
  maxFiles?: number;
}

export const DEFAULT_MAX_FILES = 1000;

/** Text every suppression directive or `any` cast contains (see analyzeSuppressions). */
const SUPPRESSION_TEXT = /eslint-disable|eslint-enable|\/\*\s*eslint\s|@ts-(?:ignore|expect-error|nocheck|check)|\bas\s+any\b|<any>/;

interface Loaded {
  entry: ChangedEntry;
  kinds: { js: boolean; config: ConfigKind | null };
  baseText: string | null;
  headText: string | null;
}

function normalizeEol(text: string | null): string | null {
  return text === null ? null : text.replace(/\r\n/g, '\n');
}

function toRepoRelative(p: string, base: ResolvedBase, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  return path.relative(base.repoRoot, abs).split(path.sep).join('/');
}

export function analyzeIntegrity(options: AnalyzeOptions): Promise<IntegrityReport> {
  try {
    const base = resolveBase({
      cwd: options.cwd,
      base: options.base,
      mergeBase: options.mergeBase,
      preferRemote: options.preferRemote,
      staged: options.staged,
    });
    return analyzeWithBase(base, options);
  } catch (err) {
    // Base resolution errors surface as rejections, like analysis errors.
    return Promise.reject(err);
  }
}

export async function analyzeWithBase(base: ResolvedBase, options: AnalyzeOptions): Promise<IntegrityReport> {
  const errors: IntegrityError[] = [];
  const changeWide = !options.paths;
  const wantedPaths = options.paths ? [...new Set(options.paths.map((p) => toRepoRelative(p, base, options.cwd)))] : undefined;
  let entries = listChanges(base, wantedPaths);
  if (options.scope) {
    const prefix = toRepoRelative(options.scope, base, options.cwd);
    if (prefix.startsWith('..')) throw new IntegrityGitError('INVALID_SCOPE', 'Scope is outside the repository');
    if (prefix !== '') entries = entries.filter((e) => e.path === prefix || e.path.startsWith(prefix + '/'));
  }
  if (wantedPaths) {
    const wanted = new Set(wantedPaths);
    entries = entries.filter((e) => wanted.has(e.path) || (e.oldPath !== undefined && wanted.has(e.oldPath)));
  }

  const relevant = entries
    .map((entry) => ({
      entry,
      kinds: {
        js: JS_TS_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase()) && !entry.path.split('/').includes('node_modules'),
        config: classifyConfig(entry.path) ?? (entry.oldPath ? classifyConfig(entry.oldPath) : null),
      },
    }))
    .filter((x) => x.kinds.js || x.kinds.config !== null);

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (relevant.length > maxFiles) {
    errors.push({ code: 'RESOURCE_LIMIT', message: `Analyzed the first ${maxFiles} of ${relevant.length} relevant changed files` });
  }

  const selected = relevant.slice(0, maxFiles);
  // Base contents (and index contents for --staged) in two Git processes total.
  const basePathOf = (e: ChangedEntry): string | null => (e.status === 'A' ? null : (e.oldPath ?? e.path));
  const blobSpecs: string[] = [];
  for (const r of selected) {
    const bp = basePathOf(r.entry);
    if (bp && base.commit !== null) blobSpecs.push(`${base.commit}:${bp}`);
    if (base.head === 'index' && r.entry.status !== 'D') blobSpecs.push(`:${r.entry.path}`);
  }
  const blobs = blobSpecs.length > 0 ? readBlobs(base.repoRoot, blobSpecs) : new Map();
  const blobText = (spec: string): string | null => {
    const b = blobs.get(spec);
    if (!b || 'missing' in b) return null;
    if ('error' in b) throw b.error;
    return b.content;
  };
  const addedByPath = addedLinesForAll(base, selected.map((r) => r.entry));

  const loaded: Loaded[] = [];
  for (const r of selected) {
    const basePath = basePathOf(r.entry);
    try {
      const baseText = basePath && base.commit !== null ? normalizeEol(blobText(`${base.commit}:${basePath}`)) : null;
      const headText = r.entry.status === 'D' ? null
        : base.head === 'index' ? normalizeEol(blobText(`:${r.entry.path}`))
          : normalizeEol(readHeadFile(base, r.entry.path));
      if (baseText === null && headText === null) continue;
      loaded.push({ ...r, baseText, headText });
    } catch (err) {
      errors.push({ code: err instanceof IntegrityGitError ? err.code : 'READ_FAILED', message: err instanceof Error ? err.message : String(err), file: r.entry.path });
    }
  }

  const drafts: FindingDraft[] = [];
  const cwd = base.repoRoot;
  const isolated = options.isolated ?? false;

  // ── JavaScript / TypeScript ────────────────────────────────────────────────
  const testPairs: JsFilePair[] = [];
  for (const f of loaded.filter((l) => l.kinds.js)) {
    const isTest = isTestPath(f.entry.path) || (f.entry.oldPath !== undefined && isTestPath(f.entry.oldPath));
    // Non-test sources can only yield suppression / `as any` findings, which need
    // this text on one side; skipping the parse is exact, not a heuristic.
    if (!isTest && !SUPPRESSION_TEXT.test(f.baseText ?? '') && !SUPPRESSION_TEXT.test(f.headText ?? '')) continue;
    const facts = async (text: string | null, side: string): Promise<JsFacts | null> => {
      if (text === null) return null;
      const outcome = await analyzeJs(text, f.entry.path, cwd, isolated);
      if (outcome.ok) return outcome.facts;
      errors.push({ code: outcome.error.split(':')[0], message: `${side}: ${outcome.error}`, file: f.entry.path });
      return null;
    };
    const baseFacts = await facts(f.baseText, 'base');
    const headFacts = await facts(f.headText, 'head');
    // An unparseable head cannot be compared; skip rather than guess.
    if (f.headText !== null && !headFacts) continue;
    if (f.baseText !== null && !baseFacts && f.entry.status !== 'A') continue;
    const pair: JsFilePair = {
      path: f.entry.path,
      status: f.entry.status,
      base: baseFacts,
      head: headFacts,
      added: f.entry.status === 'A' ? null : (addedByPath.get(f.entry.path) ?? null),
    };
    drafts.push(...analyzeSuppressions(pair));
    if (isTest) testPairs.push(pair);
  }
  drafts.push(...analyzeTests(testPairs, changeWide));

  // ── Configuration ──────────────────────────────────────────────────────────
  const workflowHeads = new Map<string, Set<string>>();
  for (const f of loaded.filter((l) => l.kinds.config === 'workflow')) {
    workflowHeads.set(f.entry.path, workflowVerificationCommands(f.headText, parseYaml));
  }

  for (const f of loaded.filter((l) => l.kinds.config !== null)) {
    const file = f.entry.path;
    const kind = f.kinds.config!;
    const parseFailed = (side: string, err: unknown): void => {
      errors.push({ code: 'CONFIG_PARSE_ERROR', message: `${side}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`, file });
    };
    try {
      switch (kind) {
        case 'eslint-js': {
          if (f.baseText === null) break;
          const baseAst = await parseAst(f.baseText, file, cwd, isolated);
          const headAst = f.headText === null ? null : await parseAst(f.headText, file, cwd, isolated);
          drafts.push(...analyzeEslintConfig(file, baseAst ? entriesFromAst(baseAst) : null,
            headAst ? entriesFromAst(headAst) : null, f.baseText, f.headText));
          break;
        }
        case 'eslint-data': {
          if (f.baseText === null) break;
          const parse = (t: string): PathEntry[] => {
            try { return entriesFromValue(parseJsonc(t)); } catch { return entriesFromValue(parseYaml(t)); }
          };
          let baseEntries: PathEntry[] | null = null;
          let headEntries: PathEntry[] | null = null;
          try { baseEntries = parse(f.baseText); } catch (e) { parseFailed('base', e); }
          try { headEntries = f.headText === null ? null : parse(f.headText); } catch (e) { parseFailed('head', e); }
          drafts.push(...analyzeEslintConfig(file, baseEntries, headEntries, f.baseText, f.headText));
          break;
        }
        case 'eslintignore':
          drafts.push(...analyzeIgnoreFile({ path: file, status: f.entry.status, baseText: f.baseText, headText: f.headText }));
          break;
        case 'tsconfig': {
          if (f.baseText === null || f.headText === null) break;
          let b: unknown; let h: unknown;
          try { b = parseJsonc(f.baseText); } catch (e) { parseFailed('base', e); break; }
          try { h = parseJsonc(f.headText); } catch (e) { parseFailed('head', e); break; }
          drafts.push(...analyzeTsconfig(file, b, h));
          break;
        }
        case 'jest-js':
        case 'vitest-js': {
          if (f.baseText === null) break;
          const baseAst = await parseAst(f.baseText, file, cwd, isolated);
          const headAst = f.headText === null ? null : await parseAst(f.headText, file, cwd, isolated);
          drafts.push(...analyzeCoverageAndTestConfig(file, baseAst ? entriesFromAst(baseAst) : null,
            headAst ? entriesFromAst(headAst) : null, { rootIsCoverageTool: false, fileDeleted: f.headText === null }));
          break;
        }
        case 'jest-json':
        case 'coverage-data': {
          if (f.baseText === null) break;
          const parse = (t: string): PathEntry[] => {
            try { return entriesFromValue(parseJsonc(t)); } catch { return entriesFromValue(parseYaml(t)); }
          };
          let b: PathEntry[] | null = null; let h: PathEntry[] | null = null;
          try { b = parse(f.baseText); } catch (e) { parseFailed('base', e); break; }
          try { h = f.headText === null ? null : parse(f.headText); } catch (e) { parseFailed('head', e); break; }
          drafts.push(...analyzeCoverageAndTestConfig(file, b, h, { rootIsCoverageTool: kind === 'coverage-data', fileDeleted: f.headText === null }));
          break;
        }
        case 'package-json': {
          if (f.baseText === null || f.headText === null) break;
          let b: Record<string, unknown>; let h: Record<string, unknown>;
          try { b = JSON.parse(f.baseText) as Record<string, unknown>; } catch (e) { parseFailed('base', e); break; }
          try { h = JSON.parse(f.headText) as Record<string, unknown>; } catch (e) { parseFailed('head', e); break; }
          drafts.push(...analyzePackageJson(file, b, h));
          for (const section of ['jest', 'nyc', 'c8']) {
            const bs = packageJsonSection(b, section);
            if (bs) drafts.push(...analyzeCoverageAndTestConfig(file, bs, packageJsonSection(h, section) ?? [], { rootIsCoverageTool: false, fileDeleted: false }));
          }
          const be = packageJsonSection(b, 'eslintConfig');
          if (be) {
            drafts.push(...analyzeEslintConfig(file, be, packageJsonSection(h, 'eslintConfig') ?? [],
              JSON.stringify(b.eslintConfig), h.eslintConfig === undefined ? '' : JSON.stringify(h.eslintConfig)));
          }
          break;
        }
        case 'workflow': {
          if (f.baseText === null) break;
          let b: unknown; let h: unknown | null = null;
          try { b = parseYaml(f.baseText); } catch (e) { parseFailed('base', e); break; }
          if (f.headText !== null) {
            try { h = parseYaml(f.headText); } catch (e) { parseFailed('head', e); break; }
          }
          const elsewhere = new Set<string>();
          for (const [p, cmds] of workflowHeads) if (p !== file) cmds.forEach((c) => elsewhere.add(c));
          drafts.push(...analyzeWorkflow(file, b, h, elsewhere));
          break;
        }
        case 'husky':
          drafts.push(...analyzeHuskyHook({ path: file, status: f.entry.status, baseText: f.baseText, headText: f.headText }));
          break;
        case 'snapshot':
          drafts.push(...analyzeSnapshot({ path: file, status: f.entry.status, baseText: f.baseText, headText: f.headText }));
          break;
        case 'baseline': {
          if (f.headText === null) break;
          let b: unknown = null; let h: unknown;
          try { b = f.baseText === null ? null : JSON.parse(f.baseText); } catch { b = null; }
          try { h = JSON.parse(f.headText); } catch (e) { parseFailed('head', e); break; }
          drafts.push(...analyzeAcceptances(file, b, h));
          break;
        }
      }
    } catch (err) {
      errors.push({ code: 'ANALYSIS_FAILED', message: err instanceof Error ? err.message : String(err), file });
    }
  }

  // ── Finalize ───────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const findings: IntegrityFinding[] = [];
  for (const d of drafts) {
    const f = finalizeFinding(d);
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    findings.push(f);
  }
  const accepted = new Set(options.acceptedFingerprints ?? []);
  const kept = findings.filter((f) => !accepted.has(f.fingerprint)).sort(compareFindings);
  return {
    base: { ref: base.ref, commit: base.commit, head: base.head },
    filesAnalyzed: loaded.length,
    findings: kept,
    accepted: findings.length - kept.length,
    errors: errors.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || a.code.localeCompare(b.code)),
  };
}

export { IntegrityGitError };
