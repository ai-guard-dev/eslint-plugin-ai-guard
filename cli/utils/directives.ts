/**
 * directives.ts — parse ESLint and TypeScript suppression comments.
 *
 * One interpretation of inline directives shared by:
 *  - the scan runner, to decide which AI Guard findings an inline directive
 *    covers (see applySuppressionPolicy), and
 *  - the integrity analyzer, to detect directives added by a change.
 *
 * The grammar follows ESLint's own directive handling:
 *  - `eslint-disable`, `eslint-enable` and inline rule configuration
 *    (`/* eslint rule: "off" *\/`) are only recognized in block comments;
 *  - `eslint-disable-line` / `eslint-disable-next-line` work in line comments and
 *    in single-line block comments;
 *  - a description after ` -- ` is the justification.
 *
 * TypeScript directives (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
 * `@ts-check`) never hide ESLint findings; they are parsed only so the
 * integrity analyzer can report newly added ones.
 */

export type EslintDirectiveKind =
  | 'disable'
  | 'enable'
  | 'disable-line'
  | 'disable-next-line'
  | 'inline-config';

export type RuleSeverity = 'off' | 'warn' | 'error' | 'unknown';

export interface CommentLike {
  type: 'Line' | 'Block' | string;
  value: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface EslintDirective {
  kind: EslintDirectiveKind;
  /** Rule IDs the directive names; null means "all rules". Always null for inline-config. */
  rules: string[] | null;
  /** Rule settings of an inline-config comment (`/* eslint rule: "off" *\/`). */
  settings?: Record<string, RuleSeverity>;
  /** Text after ` -- `, if any. */
  justification?: string;
  /** Comment text as written, trimmed and capped for display. */
  text: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type TsDirectiveKind = 'ignore' | 'expect-error' | 'nocheck' | 'check';

export interface TsDirective {
  kind: TsDirectiveKind;
  description: string;
  text: string;
  line: number;
}

const DIRECTIVE_RE = /^(eslint(?:-enable|-disable(?:(?:-next)?-line)?)?)(?:\s|$)/u;
const JUSTIFICATION_SPLIT = /\s-{2,}\s/u;
const MAX_TEXT = 160;

function displayText(type: string, value: string): string {
  const inner = value.replace(/\s+/g, ' ').trim();
  const text = type === 'Line' ? `// ${inner}` : `/* ${inner} */`;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function normalizeSeverity(raw: unknown): RuleSeverity {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 0 || value === '0' || value === 'off') return 'off';
  if (value === 1 || value === '1' || value === 'warn') return 'warn';
  if (value === 2 || value === '2' || value === 'error') return 'error';
  return 'unknown';
}

/**
 * Parse the body of an inline-config comment (`rule-a: off, rule-b: [2, {...}]`).
 * Mirrors ESLint: try JSON first, then fall back to a lenient `name: value` scan.
 */
export function parseInlineConfigSettings(body: string): Record<string, RuleSeverity> {
  const settings: Record<string, RuleSeverity> = {};
  try {
    const parsed = JSON.parse(`{${body}}`) as Record<string, unknown>;
    for (const [rule, value] of Object.entries(parsed)) settings[rule] = normalizeSeverity(value);
    return settings;
  } catch {
    // fall through to the lenient scan
  }
  const re = /(?:^|,)\s*["']?([@\w][\w@/.-]*)["']?\s*:\s*(\[\s*)?["']?([\w]+)["']?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    settings[match[1]] = normalizeSeverity(/^\d$/.test(match[3]) ? Number(match[3]) : match[3]);
  }
  return settings;
}

/** Parse one comment as an ESLint directive, or return null when it is not one. */
export function parseEslintDirective(comment: CommentLike): EslintDirective | null {
  const { type } = comment;
  if (type !== 'Line' && type !== 'Block') return null;
  const trimmed = comment.value.trim();
  const match = DIRECTIVE_RE.exec(trimmed);
  if (!match) return null;

  const name = match[1];
  const lineDirective = name === 'eslint-disable-line' || name === 'eslint-disable-next-line';
  // ESLint ignores `// eslint-disable`, `// eslint-enable` and `// eslint rule: off`.
  if (type === 'Line' && !lineDirective) return null;
  // Line directives in block comments must fit on one line.
  if (lineDirective && type === 'Block' && comment.endLine !== comment.line) return null;

  const [directivePart, ...rest] = trimmed.slice(name.length).split(JUSTIFICATION_SPLIT);
  const justification = rest.length > 0 ? rest.join(' -- ').trim() : undefined;
  const body = directivePart.trim();
  const base = {
    text: displayText(type, comment.value),
    line: comment.line,
    column: comment.column,
    endLine: comment.endLine,
    endColumn: comment.endColumn,
    ...(justification ? { justification } : {}),
  };

  if (name === 'eslint') {
    if (body === '') return null;
    return { kind: 'inline-config', rules: null, settings: parseInlineConfigSettings(body), ...base };
  }

  const rules = body === ''
    ? null
    : body.split(',').map((r) => r.trim()).filter((r) => r !== '');
  const kind: EslintDirectiveKind =
    name === 'eslint-disable' ? 'disable'
      : name === 'eslint-enable' ? 'enable'
        : name === 'eslint-disable-line' ? 'disable-line'
          : 'disable-next-line';
  return { kind, rules: rules && rules.length > 0 ? rules : null, ...base };
}

const TS_DIRECTIVE_RE = /^\s*(?:\*\s*)?@ts-(ignore|expect-error|nocheck|check)\b(.*)$/;

/** Parse one comment as a TypeScript directive, or return null. */
export function parseTsDirective(comment: CommentLike): TsDirective | null {
  if (comment.type !== 'Line' && comment.type !== 'Block') return null;
  const firstLine = comment.value.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const match = TS_DIRECTIVE_RE.exec(firstLine);
  if (!match) return null;
  const description = match[2].replace(/^[\s:\-–—]+/, '').replace(/\*\/?$/, '').trim();
  return {
    kind: match[1] as TsDirectiveKind,
    description,
    text: displayText(comment.type, comment.value),
    line: comment.line,
  };
}

export function parseEslintDirectives(comments: readonly CommentLike[]): EslintDirective[] {
  const out: EslintDirective[] = [];
  for (const c of comments) {
    const d = parseEslintDirective(c);
    if (d) out.push(d);
  }
  return out;
}

export function parseTsDirectives(comments: readonly CommentLike[]): TsDirective[] {
  const out: TsDirective[] = [];
  for (const c of comments) {
    const d = parseTsDirective(c);
    if (d) out.push(d);
  }
  return out;
}

function namesRule(rules: string[] | null, ruleId: string): boolean {
  return rules === null || rules.includes(ruleId);
}

function isBefore(d: EslintDirective, line: number, column: number): boolean {
  return d.line < line || (d.line === line && d.column <= column);
}

/**
 * Return the directive that disables `ruleId` at (line, column), following
 * ESLint's semantics, or null when the finding is not covered.
 *
 * Columns are 1-based like ESLint messages; directive columns from ESTree
 * comments are 0-based, so a directive on the same line before the finding
 * still counts as preceding it.
 */
export function findCoveringDirective(
  directives: readonly EslintDirective[],
  ruleId: string,
  line: number,
  column: number,
): EslintDirective | null {
  for (const d of directives) {
    if (d.kind === 'disable-line' && d.line === line && namesRule(d.rules, ruleId)) return d;
    if (d.kind === 'disable-next-line' && d.endLine + 1 === line && namesRule(d.rules, ruleId)) return d;
  }

  // Block disable/enable ranges, processed in source order.
  let allDisabled: EslintDirective | null = null;
  const ruleDisabled = new Map<string, EslintDirective>();
  const enabledWhileAll = new Set<string>();
  const ordered = directives
    .filter((d) => d.kind === 'disable' || d.kind === 'enable')
    .sort((a, b) => a.line - b.line || a.column - b.column);
  for (const d of ordered) {
    if (!isBefore(d, line, column)) break;
    if (d.kind === 'disable') {
      if (d.rules === null) { allDisabled = d; enabledWhileAll.clear(); }
      else for (const r of d.rules) { ruleDisabled.set(r, d); enabledWhileAll.delete(r); }
    } else if (d.rules === null) {
      allDisabled = null; ruleDisabled.clear(); enabledWhileAll.clear();
    } else {
      for (const r of d.rules) { ruleDisabled.delete(r); if (allDisabled) enabledWhileAll.add(r); }
    }
  }
  const byRule = ruleDisabled.get(ruleId);
  if (byRule) return byRule;
  if (allDisabled && !enabledWhileAll.has(ruleId)) return allDisabled;

  // Inline rule configuration applies to the whole file.
  for (const d of directives) {
    if (d.kind === 'inline-config' && d.settings?.[ruleId] === 'off') return d;
  }
  return null;
}

/** True when a block `eslint-disable` is never re-enabled for all of its rules. */
export function disablesUntilEndOfFile(directives: readonly EslintDirective[], d: EslintDirective): boolean {
  if (d.kind !== 'disable') return false;
  const later = directives.filter((x) => x.kind === 'enable' && (x.line > d.line || (x.line === d.line && x.column > d.column)));
  if (d.rules === null) return !later.some((x) => x.rules === null);
  return d.rules.some((r) => !later.some((x) => namesRule(x.rules, r)));
}

/** Rules a directive switches off; null means all rules. */
export function rulesSuppressedBy(d: EslintDirective): string[] | null {
  if (d.kind === 'inline-config') {
    return Object.entries(d.settings ?? {}).filter(([, s]) => s === 'off').map(([r]) => r);
  }
  return d.rules;
}

export function affectsAiGuard(rules: string[] | null): boolean {
  return rules === null || rules.some((r) => r.startsWith('ai-guard/'));
}
