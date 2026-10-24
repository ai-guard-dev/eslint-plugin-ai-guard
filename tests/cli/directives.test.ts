import { describe, it, expect } from 'vitest';
import {
  disablesUntilEndOfFile,
  findCoveringDirective,
  parseEslintDirective,
  parseEslintDirectives,
  parseInlineConfigSettings,
  parseTsDirective,
  type CommentLike,
} from '../../cli/utils/directives';

const line = (value: string, at = 1): CommentLike => ({ type: 'Line', value, line: at, column: 0, endLine: at, endColumn: value.length + 2 });
const block = (value: string, at = 1, endAt = at): CommentLike => ({ type: 'Block', value, line: at, column: 0, endLine: endAt, endColumn: 2 });

describe('parseEslintDirective', () => {
  it('parses line directives with rule lists and justifications', () => {
    expect(parseEslintDirective(line(' eslint-disable-next-line ai-guard/no-empty-catch, no-console -- legacy API'))).toMatchObject({
      kind: 'disable-next-line', rules: ['ai-guard/no-empty-catch', 'no-console'], justification: 'legacy API',
    });
    expect(parseEslintDirective(line(' eslint-disable-line'))).toMatchObject({ kind: 'disable-line', rules: null });
  });

  it('parses block disable/enable and inline rule configuration', () => {
    expect(parseEslintDirective(block(' eslint-disable '))).toMatchObject({ kind: 'disable', rules: null });
    expect(parseEslintDirective(block(' eslint-enable ai-guard/no-eval-dynamic '))).toMatchObject({ kind: 'enable', rules: ['ai-guard/no-eval-dynamic'] });
    expect(parseEslintDirective(block(' eslint ai-guard/no-empty-catch: "off", no-console: 2 '))).toMatchObject({
      kind: 'inline-config', settings: { 'ai-guard/no-empty-catch': 'off', 'no-console': 'error' },
    });
  });

  it('ignores directives ESLint itself ignores', () => {
    // ESLint only honours eslint-disable / eslint-enable / rule config in block comments.
    expect(parseEslintDirective(line(' eslint-disable'))).toBeNull();
    expect(parseEslintDirective(line(' eslint no-console: off'))).toBeNull();
    // Line directives in a multi-line block comment are invalid.
    expect(parseEslintDirective(block(' eslint-disable-next-line\n no-console ', 1, 2))).toBeNull();
    // Look-alikes.
    expect(parseEslintDirective(line(' eslint-disabled-next-line foo'))).toBeNull();
    expect(parseEslintDirective(line(' see eslint-disable docs'))).toBeNull();
    expect(parseEslintDirective(block(' eslint-env node '))).toBeNull();
    expect(parseEslintDirective(block(' eslint '))).toBeNull();
  });

  it('parses lenient inline config like ESLint', () => {
    expect(parseInlineConfigSettings('no-alert: 0, ai-guard/no-eval-dynamic: off')).toEqual({ 'no-alert': 'off', 'ai-guard/no-eval-dynamic': 'off' });
    expect(parseInlineConfigSettings('"quotes": ["error", "single"]')).toEqual({ quotes: 'error' });
  });
});

describe('parseTsDirective', () => {
  it('parses TypeScript directives and their descriptions', () => {
    expect(parseTsDirective(line(' @ts-ignore'))).toMatchObject({ kind: 'ignore', description: '' });
    expect(parseTsDirective(line(' @ts-expect-error -- upstream types are wrong'))).toMatchObject({ kind: 'expect-error', description: 'upstream types are wrong' });
    expect(parseTsDirective(block('* @ts-nocheck '))).toMatchObject({ kind: 'nocheck' });
    expect(parseTsDirective(line(' @ts-check'))).toMatchObject({ kind: 'check' });
    expect(parseTsDirective(line(' explain why @ts-ignore is bad'))).toBeNull();
  });
});

describe('findCoveringDirective', () => {
  const directives = parseEslintDirectives([
    line(' eslint-disable-line ai-guard/no-empty-catch', 3),
    line(' eslint-disable-next-line no-console', 5),
    block(' eslint-disable ai-guard/no-eval-dynamic ', 10),
    block(' eslint-enable ai-guard/no-eval-dynamic ', 20),
    block(' eslint-disable ', 30),
    block(' eslint-enable ai-guard/no-floating-promise ', 35),
  ]);

  it('applies line and next-line directives only to their lines and rules', () => {
    expect(findCoveringDirective(directives, 'ai-guard/no-empty-catch', 3, 5)?.kind).toBe('disable-line');
    expect(findCoveringDirective(directives, 'ai-guard/no-empty-catch', 4, 5)).toBeNull();
    // A directive for another rule does not cover AI Guard findings.
    expect(findCoveringDirective(directives, 'ai-guard/no-empty-catch', 6, 1)).toBeNull();
  });

  it('applies block ranges in source order with enable exceptions', () => {
    expect(findCoveringDirective(directives, 'ai-guard/no-eval-dynamic', 15, 1)?.line).toBe(10);
    expect(findCoveringDirective(directives, 'ai-guard/no-eval-dynamic', 25, 1)).toBeNull();
    expect(findCoveringDirective(directives, 'ai-guard/no-eval-dynamic', 40, 1)?.line).toBe(30);
    // Re-enabled for one rule while everything else stays disabled.
    expect(findCoveringDirective(directives, 'ai-guard/no-floating-promise', 40, 1)).toBeNull();
    expect(findCoveringDirective(directives, 'ai-guard/no-eval-dynamic', 9, 1)).toBeNull();
  });

  it('applies inline rule configuration to the whole file', () => {
    const d = parseEslintDirectives([block(' eslint ai-guard/no-empty-catch: off ', 50)]);
    expect(findCoveringDirective(d, 'ai-guard/no-empty-catch', 1, 1)?.kind).toBe('inline-config');
    expect(findCoveringDirective(d, 'ai-guard/no-eval-dynamic', 1, 1)).toBeNull();
  });

  it('knows whether a block disable lasts until the end of the file', () => {
    expect(disablesUntilEndOfFile(directives, directives[2])).toBe(false);
    expect(disablesUntilEndOfFile(directives, directives[4])).toBe(true);
  });
});
