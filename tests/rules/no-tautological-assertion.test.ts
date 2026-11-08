import { describe, it, expect } from 'vitest';
import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import { noTautologicalAssertion, staticValue } from '../../src/rules/ai-patterns/no-tautological-assertion';
import { parse } from '@typescript-eslint/parser';
import type { TSESTree } from '@typescript-eslint/utils';

function evaluate(expression: string): unknown {
  const program = parse(`(${expression});`) as unknown as TSESTree.Program;
  const statement = program.body[0] as TSESTree.ExpressionStatement;
  return staticValue(statement.expression);
}

describe('staticValue', () => {
  it('evaluates constant expressions', () => {
    expect(evaluate('1 + 1')).toEqual({ value: 2 });
    expect(evaluate('"a" + "b"')).toEqual({ value: 'ab' });
    expect(evaluate('!0')).toEqual({ value: true });
    expect(evaluate('[1, { a: null }]')).toEqual({ value: [1, { a: null }] });
    expect(evaluate('typeof "x"')).toEqual({ value: 'string' });
  });

  it('returns null for anything that depends on code', () => {
    expect(evaluate('result')).toBeNull();
    expect(evaluate('sum(1, 2)')).toBeNull();
    expect(evaluate('typeof window')).toBeNull();
    expect(evaluate('[...items]')).toBeNull();
    expect(evaluate('/abc/')).toBeNull();
  });
});

ruleTester.run('no-tautological-assertion', noTautologicalAssertion, {
  valid: [
    // Real assertions
    'expect(sum(1, 2)).toBe(3);',
    'expect(result).toEqual({ id: 1 });',
    'expect(a).toBe(b);',
    'expect(typeof window).toBe("object");',
    'expect(screen.getByText("Hello")).toBeInTheDocument();',
    'expect(res.body).to.deep.equal({ ok: true });',
    'assert.equal(actual, 3);',
    'assert(result.ok);',
    'expect.assertions(2);',
    // Constant on the wrong side still checks a value the code produced
    'expect(200).toBe(res.status);',
    'expect("admin").toEqual(user.role);',
    // Always-failing sentinels ("should have thrown") are intentional
    'try { await save(); expect(true).toBe(false); } catch (e) { expect(e.message).toMatch(/denied/); }',
    'expect(1).toBe(2);',
    // Comparing calls: two calls can differ
    'expect(next()).toBe(next());',
    'expect(new Date()).toEqual(new Date());',
    // Negated identity always fails, so it is not a tautology
    'expect(x).not.toBe(x);',
    'assert.notStrictEqual(a, a);',
    // A custom function named expect with a non-matcher chain
    'expect(value);',
    // Type-level test files use runtime placeholders on purpose (shape from pmndrs/zustand)
    { code: 'function checkAllTypes(_a: string) { expect(true).toBeTruthy(); }', filename: 'tests/types.test.tsx' },
    { code: 'expect(true).toBe(true);', filename: 'src/api.test-d.ts' },
  ],
  invalid: [
    { code: 'expect(true).toBe(true);', errors: [{ messageId: 'alwaysPasses', data: { subject: 'true' } }] },
    { code: 'it("adds", () => { expect(1 + 1).toBe(2); });', errors: [{ messageId: 'alwaysPasses', data: { subject: '2' } }] },
    { code: 'expect(true).toBeTruthy();', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'expect("hello").toBeDefined();', errors: [{ messageId: 'alwaysPasses', data: { subject: '"hello"' } }] },
    { code: 'expect(null).not.toBeUndefined();', errors: [{ messageId: 'alwaysPasses', data: { subject: 'null' } }] },
    { code: 'expect(1).not.toBe(2);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'expect([1, 2]).toEqual([1, 2]);', errors: [{ messageId: 'alwaysPasses', data: { subject: '[1,2]' } }] },
    { code: 'expect("abc").toContain("b");', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'expect("ok").toMatchSnapshot();', errors: [{ messageId: 'constantSubject', data: { subject: '"ok"' } }] },
    // Comparing a value with itself
    { code: 'const result = compute(); expect(result).toEqual(result);', errors: [{ messageId: 'comparesWithItself', data: { subject: 'result' } }] },
    { code: 'expect(user.name).toBe(user.name);', errors: [{ messageId: 'comparesWithItself', data: { subject: 'user.name' } }] },
    // Node assert
    { code: 'assert(true);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'assert.ok(1);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'assert.equal(2, 2);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'assert.strictEqual(response, response);', errors: [{ messageId: 'comparesWithItself', data: { subject: 'response' } }] },
    { code: 'assert.notEqual(1, 2);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'import { strictEqual } from "node:assert"; strictEqual(1, 1);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'import assert from "node:assert/strict"; assert.deepEqual({ a: 1 }, { a: 1 });', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'const { deepStrictEqual } = require("assert"); deepStrictEqual([], []);', errors: [{ messageId: 'alwaysPasses' }] },
    // Chai
    { code: 'expect(true).to.be.true;', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'chai.expect(1).to.equal(1);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'import { assert } from "chai"; assert.isTrue(true);', errors: [{ messageId: 'alwaysPasses' }] },
    // Aliased expect from a test runner
    { code: 'import { expect as check } from "vitest"; check(1).toBe(1);', errors: [{ messageId: 'alwaysPasses' }] },
  ],
});

tsRuleTester.run('no-tautological-assertion (TypeScript)', noTautologicalAssertion, {
  valid: ['expect(result as number).toBe(3);'],
  invalid: [
    { code: 'expect(true as boolean).toBe(true);', errors: [{ messageId: 'alwaysPasses' }] },
    { code: 'expect(user!.id).toBe(user!.id);', errors: [{ messageId: 'comparesWithItself' }] },
  ],
});
