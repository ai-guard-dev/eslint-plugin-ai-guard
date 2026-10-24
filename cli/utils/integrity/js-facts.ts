/**
 * Parse JavaScript/TypeScript and extract the facts integrity analysis compares:
 * directive comments, test declarations, assertion counts and `as any` casts.
 *
 * Parsing goes through ESLint's Linter with the same parsers the runner uses
 * (espree, or @typescript-eslint/parser for TS), so comments and strings are
 * handled by a real parser — `it.skip` inside a string or comment never counts.
 */

import { createRequire } from 'module';
import path from 'path';
import {
  parseEslintDirectives,
  parseTsDirectives,
  type CommentLike,
  type EslintDirective,
  type TsDirective,
} from '../directives.js';

export interface TestDecl {
  kind: 'test' | 'suite';
  title: string;
  /** Titles from the outermost suite to this declaration, joined with " > ". */
  path: string;
  line: number;
  /** Skipped by this declaration itself (`.skip`, `xit`, `fixme`). */
  skipped: boolean;
  /** Skipped by itself or by an enclosing suite. */
  effectiveSkipped: boolean;
  focused: boolean;
  todo: boolean;
  conditional: boolean;
  parameterized: boolean;
}

export interface JsFacts {
  eslintDirectives: EslintDirective[];
  tsDirectives: TsDirective[];
  tests: TestDecl[];
  assertions: { total: number; strict: number; loose: number };
  anyCasts: number[];
}

export type ParseOutcome = { ok: true; facts: JsFacts } | { ok: false; error: string };

type AstNode = { type: string; loc?: { start: { line: number; column: number } }; [key: string]: unknown };

const TEST_BASES = new Set(['it', 'test', 'specify', 'xit', 'xtest', 'xspecify', 'fit', 'ftest']);
const SUITE_BASES = new Set(['describe', 'suite', 'context', 'xdescribe', 'xcontext', 'xsuite', 'fdescribe']);
const SKIP_BASES = new Set(['xit', 'xtest', 'xspecify', 'xdescribe', 'xcontext', 'xsuite']);
const FOCUS_BASES = new Set(['fit', 'ftest', 'fdescribe']);
const MODIFIERS = new Set([
  'skip', 'only', 'todo', 'each', 'for', 'concurrent', 'sequential', 'failing', 'fails',
  'skipIf', 'runIf', 'fixme', 'describe', 'serial', 'parallel', 'fail', 'slow', 'shuffle',
]);
const TABLE_MODIFIERS = new Set(['each', 'for']);
const CONDITIONAL_MODIFIERS = new Set(['skipIf', 'runIf']);

const LOOSE_MATCHERS = new Set(['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toHaveBeenCalled', 'toBeCalled']);
const STRICT_MATCHERS = new Set([
  'toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toHaveBeenCalledWith', 'toBeCalledWith',
  'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toHaveReturnedWith', 'toHaveBeenCalledTimes',
  'toContain', 'toContainEqual', 'toHaveLength', 'toMatch', 'toBeNull', 'toBeUndefined', 'toBeNaN',
  'toBeCloseTo', 'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual',
  'toHaveProperty', 'toBeInstanceOf',
]);
const ASSERT_STRICT = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual',
  'notDeepStrictEqual', 'throws', 'rejects', 'doesNotThrow', 'match', 'doesNotMatch']);

// ─── Parser loading ───────────────────────────────────────────────────────────

let linterCtor: (new (opts: { configType: 'flat' }) => {
  verify(code: string, config: unknown[], opts: { filename: string }): Array<{ fatal?: boolean; message: string; line?: number }>;
}) | null = null;
const tsParserCache = new Map<string, unknown | null>();

async function getLinter(): Promise<NonNullable<typeof linterCtor>> {
  if (!linterCtor) {
    const mod = await import('eslint') as unknown as { Linter: NonNullable<typeof linterCtor> };
    linterCtor = mod.Linter;
  }
  return linterCtor;
}

function loadTsParser(cwd: string, isolated: boolean): unknown | null {
  const key = isolated ? '(packaged)' : cwd;
  if (tsParserCache.has(key)) return tsParserCache.get(key) ?? null;
  let parser: unknown | null = null;
  if (!isolated) {
    try { parser = createRequire(path.join(cwd, 'package.json'))('@typescript-eslint/parser'); } catch { /* fall back */ }
  }
  if (!parser) {
    try { parser = require('@typescript-eslint/parser'); } catch { parser = null; }
  }
  tsParserCache.set(key, parser);
  return parser;
}

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);
export const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

interface ParsedSource { ast: AstNode; comments: CommentLike[] }

interface CapturedSource {
  ast: AstNode;
  getAllComments(): Array<{ type: string; value: string; loc: { start: { line: number; column: number }; end: { line: number; column: number } } }>;
}

async function parseSource(code: string, repoPath: string, cwd: string, isolated: boolean): Promise<ParsedSource | { error: string }> {
  const ext = path.extname(repoPath).toLowerCase();
  const isTs = TS_EXT.has(ext);
  const tsParser = isTs ? loadTsParser(cwd, isolated) : null;
  if (isTs && !tsParser) return { error: 'PARSER_UNAVAILABLE: install @typescript-eslint/parser to analyze TypeScript' };
  const Linter = await getLinter();
  const linter = new Linter({ configType: 'flat' });
  const jsx = ext === '.tsx' || ext === '.jsx' || (!isTs);

  for (const sourceType of ['module', 'script'] as const) {
    const holder: { sourceCode: CapturedSource | null } = { sourceCode: null };
    const plugin = {
      rules: {
        capture: {
          meta: { type: 'problem', schema: [] },
          create(context: { sourceCode?: CapturedSource; getSourceCode?: () => CapturedSource }) {
            holder.sourceCode = context.sourceCode ?? context.getSourceCode?.() ?? null;
            return {};
          },
        },
      },
    };
    const config = [{
      files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      plugins: { 'ai-guard-facts': plugin },
      rules: { 'ai-guard-facts/capture': 'error' },
      linterOptions: { noInlineConfig: false, reportUnusedDisableDirectives: 'off' },
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType,
        ...(tsParser ? { parser: tsParser } : {}),
        parserOptions: { ecmaVersion: 'latest', sourceType, ecmaFeatures: { jsx } },
      },
    }];
    const messages = linter.verify(code, config, { filename: `integrity-input${ext || '.js'}` });
    const fatal = messages.find((m) => m.fatal);
    const sourceCode = holder.sourceCode;
    if (!fatal && sourceCode) {
      const comments = sourceCode.getAllComments().map((c) => ({
        type: c.type, value: c.value,
        line: c.loc.start.line, column: c.loc.start.column,
        endLine: c.loc.end.line, endColumn: c.loc.end.column,
      }));
      return { ast: sourceCode.ast, comments };
    }
    if (sourceType === 'script') return { error: `PARSE_ERROR: ${fatal?.message ?? 'could not parse'}${fatal?.line ? ` (line ${fatal.line})` : ''}` };
  }
  return { error: 'PARSE_ERROR' };
}

/** Parse source and return its AST, for config analyzers that inspect object literals. */
export async function parseAst(code: string, repoPath: string, cwd: string, isolated = false): Promise<AstNode | null> {
  const parsed = await parseSource(code, repoPath, cwd, isolated);
  return 'ast' in parsed ? parsed.ast : null;
}

// ─── AST helpers ──────────────────────────────────────────────────────────────

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

const SKIP_KEYS = new Set(['parent', 'loc', 'range', 'tokens', 'comments']);

function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) { for (const v of value) if (isNode(v)) out.push(v); }
    else if (isNode(value)) out.push(value);
  }
  return out;
}

function identName(node: unknown): string | null {
  return isNode(node) && node.type === 'Identifier' ? String(node.name) : null;
}

function memberProp(node: AstNode): string | null {
  if (node.type !== 'MemberExpression' || node.computed) return null;
  return identName(node.property);
}

interface CalleeInfo {
  base: string;
  modifiers: string[];
  tableApplied: boolean;
  conditional: boolean;
}

function flattenCallee(node: unknown): CalleeInfo | null {
  if (!isNode(node)) return null;
  if (node.type === 'Identifier') return { base: String(node.name), modifiers: [], tableApplied: false, conditional: false };
  if (node.type === 'MemberExpression') {
    const prop = memberProp(node);
    const inner = flattenCallee(node.object);
    if (!prop || !inner) return null;
    return { ...inner, modifiers: [...inner.modifiers, prop] };
  }
  if (node.type === 'CallExpression' || node.type === 'TaggedTemplateExpression') {
    const inner = flattenCallee(node.type === 'CallExpression' ? node.callee : node.tag);
    if (!inner) return null;
    const last = inner.modifiers[inner.modifiers.length - 1];
    if (TABLE_MODIFIERS.has(last)) return { ...inner, tableApplied: true };
    if (node.type === 'CallExpression' && CONDITIONAL_MODIFIERS.has(last)) return { ...inner, conditional: true };
    return null;
  }
  return null;
}

function titleOf(arg: unknown, hasCallback: boolean): string | null {
  if (!isNode(arg)) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral') {
    const quasis = (arg.quasis as AstNode[]).map((q) => String((q.value as { cooked?: string; raw: string }).cooked ?? (q.value as { raw: string }).raw));
    return quasis.join('${…}');
  }
  if (hasCallback && (arg.type === 'Identifier' || arg.type === 'MemberExpression')) {
    return arg.type === 'Identifier' ? `<${String(arg.name)}>` : '<expression>';
  }
  return null;
}

function isCallbackLike(node: unknown): boolean {
  return isNode(node) && ['FunctionExpression', 'ArrowFunctionExpression', 'Identifier', 'MemberExpression', 'CallExpression'].includes(node.type);
}

interface Recognized {
  kind: 'test' | 'suite';
  title: string;
  skipped: boolean;
  focused: boolean;
  todo: boolean;
  conditional: boolean;
  parameterized: boolean;
}

function recognizeDeclaration(call: AstNode): Recognized | null {
  const info = flattenCallee(call.callee);
  if (!info) return null;
  const isTest = TEST_BASES.has(info.base);
  const isSuite = SUITE_BASES.has(info.base);
  if (!isTest && !isSuite) return null;
  if (!info.modifiers.every((m) => MODIFIERS.has(m))) return null;
  // `it.each(table)` is the table call; the declaration is the outer call.
  if (info.modifiers.some((m) => TABLE_MODIFIERS.has(m)) && !info.tableApplied) return null;
  const args = call.arguments as unknown[];
  const hasCallback = args.length > 1 && isCallbackLike(args[1]);
  const title = titleOf(args[0], hasCallback);
  if (title === null) return null;
  const todo = info.modifiers.includes('todo') || (!hasCallback && isTest && args.length === 1);
  return {
    kind: isSuite || info.modifiers.includes('describe') ? 'suite' : 'test',
    title,
    skipped: SKIP_BASES.has(info.base) || info.modifiers.includes('skip') || info.modifiers.includes('fixme'),
    focused: FOCUS_BASES.has(info.base) || info.modifiers.includes('only'),
    todo,
    conditional: info.conditional,
    parameterized: info.tableApplied,
  };
}

/** Matcher name for `expect(x)[.not|.resolves|.rejects].matcher(...)`, else null. */
function expectMatcher(call: AstNode): string | null {
  if (!isNode(call.callee) || call.callee.type !== 'MemberExpression') return null;
  const matcher = memberProp(call.callee);
  if (!matcher) return null;
  let obj: unknown = call.callee.object;
  while (isNode(obj) && obj.type === 'MemberExpression' && ['not', 'resolves', 'rejects'].includes(memberProp(obj) ?? '')) {
    obj = obj.object;
  }
  if (!isNode(obj) || obj.type !== 'CallExpression') return null;
  const callee = obj.callee;
  if (identName(callee) === 'expect') return matcher;
  if (isNode(callee) && callee.type === 'MemberExpression' && identName(callee.object) === 'expect' && memberProp(callee) === 'soft') return matcher;
  return null;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

function extractFacts(ast: AstNode, comments: CommentLike[]): JsFacts {
  const tests: TestDecl[] = [];
  const assertions = { total: 0, strict: 0, loose: 0 };
  const anyCasts: number[] = [];

  const visit = (node: AstNode, suitePath: string[], ancestorSkipped: boolean): void => {
    if (node.type === 'CallExpression') {
      const decl = recognizeDeclaration(node);
      if (decl) {
        const line = node.loc?.start.line ?? 0;
        const fullPath = [...suitePath, decl.title];
        const effectiveSkipped = decl.skipped || ancestorSkipped;
        tests.push({
          kind: decl.kind, title: decl.title, path: fullPath.join(' > '), line,
          skipped: decl.skipped, effectiveSkipped, focused: decl.focused, todo: decl.todo,
          conditional: decl.conditional, parameterized: decl.parameterized,
        });
        const nextPath = decl.kind === 'suite' ? fullPath : suitePath;
        for (const arg of node.arguments as unknown[]) if (isNode(arg)) visit(arg, nextPath, effectiveSkipped);
        return;
      }
      const matcher = expectMatcher(node);
      if (matcher) {
        assertions.total++;
        const argCount = (node.arguments as unknown[]).length;
        if (LOOSE_MATCHERS.has(matcher) || ((matcher === 'toThrow' || matcher === 'toThrowError') && argCount === 0)) assertions.loose++;
        else if (STRICT_MATCHERS.has(matcher) || matcher === 'toThrow' || matcher === 'toThrowError') assertions.strict++;
      } else if (isNode(node.callee)) {
        const callee = node.callee;
        if (identName(callee) === 'assert') { assertions.total++; assertions.loose++; }
        else if (callee.type === 'MemberExpression' && identName(callee.object) === 'assert') {
          assertions.total++;
          if (ASSERT_STRICT.has(memberProp(callee) ?? '')) assertions.strict++; else assertions.loose++;
        } else if (callee.type === 'MemberExpression' && identName(callee.object) === 'expect'
          && ['anything', 'any'].includes(memberProp(callee) ?? '')) {
          assertions.loose++;
        }
      }
    } else if ((node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion')
      && isNode(node.typeAnnotation) && node.typeAnnotation.type === 'TSAnyKeyword') {
      anyCasts.push(node.loc?.start.line ?? 0);
    }
    for (const child of children(node)) visit(child, suitePath, ancestorSkipped);
  };
  visit(ast, [], false);

  return {
    eslintDirectives: parseEslintDirectives(comments),
    tsDirectives: parseTsDirectives(comments),
    tests,
    assertions,
    anyCasts,
  };
}

export async function analyzeJs(code: string, repoPath: string, cwd: string, isolated = false): Promise<ParseOutcome> {
  const parsed = await parseSource(code, repoPath, cwd, isolated);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  return { ok: true, facts: extractFacts(parsed.ast, parsed.comments) };
}

/** True for files that look like test files by name or location. */
export function isTestPath(repoPath: string): boolean {
  const p = repoPath.replace(/\\/g, '/');
  if (!JS_TS_EXTENSIONS.has(path.extname(p).toLowerCase())) return false;
  return /\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$/i.test(p) || /(^|\/)(__tests__|tests?|e2e|cypress)\//i.test(p);
}

export function activeTests(facts: JsFacts): TestDecl[] {
  return facts.tests.filter((t) => t.kind === 'test' && !t.effectiveSkipped && !t.todo);
}
