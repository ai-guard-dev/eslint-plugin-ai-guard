/**
 * Shared RuleTester setup for all ai-guard rule tests.
 * Import from here instead of re-declaring boilerplate in each test file.
 */
import { RuleTester } from '@typescript-eslint/rule-tester';
import { describe, it, afterAll } from 'vitest';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

/**
 * Standard JS/TS rule tester — works for all rules that don't need
 * full type-aware parsing.
 */
export const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

/**
 * TypeScript-aware rule tester for rules that benefit from TS parser.
 * Falls back gracefully if @typescript-eslint/parser is unavailable.
 */
let tsRuleTesterInstance: RuleTester;
try {
  // eslint-disable-next-line
  const tsParser = require('@typescript-eslint/parser') as object;
  tsRuleTesterInstance = new RuleTester({
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
    },
  });
} catch {
  tsRuleTesterInstance = ruleTester;
}

export const tsRuleTester = tsRuleTesterInstance;
