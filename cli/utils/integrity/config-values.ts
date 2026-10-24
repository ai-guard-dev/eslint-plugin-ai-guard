/**
 * Static configuration values for integrity analysis.
 *
 * Config files are never executed. JSON/JSONC/YAML documents are parsed as
 * data; JavaScript/TypeScript configs (eslint.config.js, vitest.config.ts, …)
 * are parsed to an AST and only literal values inside object literals are
 * read. Anything computed is UNKNOWN, so analyzers can report a conservative
 * advisory instead of claiming a confirmed weakening.
 */

/// <reference path="../../types/js-yaml.d.ts" />
import { load as loadYaml } from 'js-yaml';

export const UNKNOWN = Symbol('unknown');
export type Scalar = string | number | boolean | null | typeof UNKNOWN;

export interface PathEntry {
  /** Object keys from the outermost literal; array elements appear as `[i]`. */
  path: string[];
  value: Scalar;
  line?: number;
}

// ─── JSONC / YAML ─────────────────────────────────────────────────────────────

/** Parse JSON with comments and trailing commas (tsconfig.json, .eslintrc). Throws on invalid input. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i++; }
      i++;
      continue;
    }
    out += ch;
  }
  return JSON.parse(stripTrailingCommas(out).replace(/^﻿/, ''));
}

/** Remove commas that directly precede `}` or `]`, outside of strings. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** Parse YAML as data (no custom types). Throws on invalid input. */
export function parseYaml(text: string): unknown {
  return loadYaml(text);
}

// ─── Flattening ───────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten a parsed JSON/YAML value into scalar path entries. */
export function entriesFromValue(value: unknown, prefix: string[] = []): PathEntry[] {
  const out: PathEntry[] = [];
  const walk = (v: unknown, p: string[]): void => {
    if (Array.isArray(v)) v.forEach((el, i) => walk(el, [...p, `[${i}]`]));
    else if (isPlainObject(v)) for (const [k, child] of Object.entries(v)) walk(child, [...p, k]);
    else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out.push({ path: p, value: v as Scalar });
    else out.push({ path: p, value: UNKNOWN });
  };
  walk(value, prefix);
  return out;
}

type AstNode = { type: string; loc?: { start: { line: number } }; [key: string]: unknown };

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function keyName(prop: AstNode): string | null {
  if (prop.computed) return null;
  const key = prop.key as AstNode;
  if (key.type === 'Identifier') return String(key.name);
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) return String(key.value);
  return null;
}

function literalValue(node: AstNode): Scalar {
  if (node.type === 'Literal') {
    const v = node.value;
    return v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v as Scalar : UNKNOWN;
  }
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) {
    return String(((node.quasis as AstNode[])[0]?.value as { cooked?: string })?.cooked ?? '');
  }
  if (node.type === 'UnaryExpression' && node.operator === '-' && isNode(node.argument)
    && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
    return -node.argument.value;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') return literalValue(node.expression as AstNode);
  return UNKNOWN;
}

const SKIP_KEYS = new Set(['parent', 'loc', 'range', 'tokens', 'comments']);

/** Collect literal values from every object literal in a JS/TS config AST. */
export function entriesFromAst(ast: AstNode): PathEntry[] {
  const out: PathEntry[] = [];

  const visitValue = (node: AstNode, p: string[]): void => {
    if (node.type === 'ObjectExpression') { visitObject(node, p); return; }
    if (node.type === 'ArrayExpression') {
      (node.elements as Array<AstNode | null>).forEach((el, i) => { if (el) visitValue(el, [...p, `[${i}]`]); });
      return;
    }
    const value = literalValue(node);
    out.push({ path: p, value, line: node.loc?.start.line });
    if (value === UNKNOWN) visitAny(node);
  };

  const visitObject = (obj: AstNode, p: string[]): void => {
    for (const prop of obj.properties as AstNode[]) {
      if (prop.type !== 'Property') { visitAny(prop); continue; }
      const name = keyName(prop);
      if (name === null) { visitAny(prop.value as AstNode); continue; }
      visitValue(prop.value as AstNode, [...p, name]);
    }
  };

  const visitAny = (node: AstNode): void => {
    if (node.type === 'ObjectExpression') { visitObject(node, []); return; }
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (Array.isArray(value)) { for (const v of value) if (isNode(v)) visitAny(v); }
      else if (isNode(value)) visitAny(value);
    }
  };

  visitAny(ast);
  return out;
}

export function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

export function displayPath(path: string[]): string {
  return path.map((seg, i) => (seg.startsWith('[') ? seg : i === 0 ? seg : `.${seg}`)).join('');
}

export function formatScalar(value: Scalar | undefined): string {
  if (value === undefined) return '(not set)';
  if (value === UNKNOWN) return '(computed)';
  return JSON.stringify(value);
}
