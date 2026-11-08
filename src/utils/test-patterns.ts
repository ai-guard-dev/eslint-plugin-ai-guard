/**
 * Recognition of test cases and assertions in JS/TS test files.
 *
 * Shared by the test-integrity rules (no-assertionless-test,
 * no-tautological-assertion) and the diff-based test-integrity analyzer, so a
 * "test" and an "assertion" mean the same thing everywhere. Covers Jest,
 * Vitest, Mocha, Jasmine, node:test, AVA/tap, Chai, should.js, Sinon,
 * Testing Library and Cypress conventions.
 */
import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

export type TestKind = 'test' | 'suite';
export type TestModifier = 'skip' | 'only' | 'todo';

export type TestCallback = TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression;

export interface TestCall {
  kind: TestKind;
  node: TSESTree.CallExpression;
  /** Title as written: string value, template text, or identifier name. */
  title: string;
  modifiers: Set<TestModifier>;
  callback: TestCallback | null;
}

const TEST_NAMES = new Set(['it', 'test', 'specify']);
const SUITE_NAMES = new Set(['describe', 'context', 'suite']);

const PREFIXED: Record<string, { kind: TestKind; modifier: TestModifier }> = {
  xit: { kind: 'test', modifier: 'skip' },
  xtest: { kind: 'test', modifier: 'skip' },
  xspecify: { kind: 'test', modifier: 'skip' },
  xdescribe: { kind: 'suite', modifier: 'skip' },
  xcontext: { kind: 'suite', modifier: 'skip' },
  fit: { kind: 'test', modifier: 'only' },
  fdescribe: { kind: 'suite', modifier: 'only' },
};

/** Chain properties allowed between the test function and the call. */
const CHAIN_PROPS: Record<string, TestModifier | null> = {
  skip: 'skip',
  only: 'only',
  todo: 'todo',
  concurrent: null,
  sequential: null,
  shuffle: null,
  fails: null,
  failing: null,
  serial: null,
  each: null,
  for: null,
  skipIf: null,
  runIf: null,
};

/** Calls that produce a test function: test.each(table), test.skipIf(cond). */
const FACTORY_PROPS = new Set(['each', 'for', 'skipIf', 'runIf']);

interface ResolvedCallee {
  root: string;
  props: string[];
  conditional: { prop: string; argument: TSESTree.Node | undefined } | null;
}

function resolveChain(node: TSESTree.Node): { root: string; props: string[] } | null {
  const props: string[] = [];
  let current: TSESTree.Node = node;
  while (current.type === AST_NODE_TYPES.MemberExpression) {
    if (current.computed || current.property.type !== AST_NODE_TYPES.Identifier) return null;
    props.unshift(current.property.name);
    current = current.object;
  }
  if (current.type !== AST_NODE_TYPES.Identifier) return null;
  return { root: current.name, props };
}

function resolveTestCallee(callee: TSESTree.Node): ResolvedCallee | null {
  // test.each(table)('title', fn), test.skipIf(cond)('title', fn)
  if (callee.type === AST_NODE_TYPES.CallExpression || callee.type === AST_NODE_TYPES.TaggedTemplateExpression) {
    const inner = callee.type === AST_NODE_TYPES.CallExpression ? callee.callee : callee.tag;
    const chain = resolveChain(inner);
    if (!chain || chain.props.length === 0) return null;
    const last = chain.props[chain.props.length - 1];
    if (!FACTORY_PROPS.has(last)) return null;
    const argument = callee.type === AST_NODE_TYPES.CallExpression ? callee.arguments[0] : undefined;
    return { root: chain.root, props: chain.props, conditional: { prop: last, argument } };
  }
  const chain = resolveChain(callee);
  if (!chain) return null;
  return { ...chain, conditional: null };
}

function isLiteralTruthy(node: TSESTree.Node | undefined): boolean | null {
  if (!node) return null;
  if (node.type === AST_NODE_TYPES.Literal) return Boolean(node.value);
  if (node.type === AST_NODE_TYPES.UnaryExpression && node.operator === '!') {
    const inner = isLiteralTruthy(node.argument);
    return inner === null ? null : !inner;
  }
  return null;
}

/** Text of a test or suite title, as a reviewer would read it. */
export function getTitleText(node: TSESTree.Node | undefined): string {
  if (!node) return '<untitled>';
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') return node.value;
  if (node.type === AST_NODE_TYPES.TemplateLiteral) {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('${...}');
  }
  if (node.type === AST_NODE_TYPES.Identifier) return node.name;
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    const chain = resolveChain(node);
    if (chain) return [chain.root, ...chain.props].join('.');
  }
  return '<dynamic>';
}

function isFunction(node: TSESTree.Node | undefined): node is TestCallback {
  return node?.type === AST_NODE_TYPES.ArrowFunctionExpression || node?.type === AST_NODE_TYPES.FunctionExpression;
}

/** Recognizes `it(...)`, `describe.only(...)`, `test.each(t)(...)`, `xit(...)` and friends. */
export function getTestCall(node: TSESTree.CallExpression): TestCall | null {
  const resolved = resolveTestCallee(node.callee);
  if (!resolved) return null;

  let kind: TestKind;
  const modifiers = new Set<TestModifier>();
  const prefixed = PREFIXED[resolved.root];
  if (prefixed) {
    kind = prefixed.kind;
    modifiers.add(prefixed.modifier);
  } else if (TEST_NAMES.has(resolved.root)) {
    kind = 'test';
  } else if (SUITE_NAMES.has(resolved.root)) {
    kind = 'suite';
  } else {
    return null;
  }

  for (const prop of resolved.props) {
    if (!(prop in CHAIN_PROPS)) return null; // test.extend(...), it.name, ...
    const modifier = CHAIN_PROPS[prop];
    if (modifier) modifiers.add(modifier);
  }
  // `it.each(table)` itself only builds the test function; the test is the call on its result.
  if (!resolved.conditional && FACTORY_PROPS.has(resolved.props[resolved.props.length - 1] ?? '')) return null;

  if (resolved.conditional) {
    const truthy = isLiteralTruthy(resolved.conditional.argument);
    if (resolved.conditional.prop === 'skipIf' && truthy === true) modifiers.add('skip');
    if (resolved.conditional.prop === 'runIf' && truthy === false) modifiers.add('skip');
  }

  const [titleArg, ...rest] = node.arguments;
  if (!titleArg) return null;
  // Vitest allows an options object before the callback: test('t', { timeout }, fn)
  const callback = rest.find(isFunction) ?? null;
  if (kind === 'test' && !callback && !modifiers.has('todo') && rest.length === 0) {
    // it('title') with no body is a pending test in Mocha/Jasmine
    modifiers.add('todo');
  }
  return { kind, node, title: getTitleText(titleArg), modifiers, callback };
}

// ─── Assertions ─────────────────────────────────────────────────────────────

/** Modules whose exports are assertion functions. */
const ASSERTION_MODULES = new Set([
  'assert', 'node:assert', 'assert/strict', 'node:assert/strict', 'chai', 'power-assert', 'should',
  'expect', 'expect.js', 'unexpected',
]);
/** Test-runner modules that export `expect` / `assert` alongside other helpers. */
const RUNNER_MODULES = new Set(['vitest', '@jest/globals', 'bun:test', '@playwright/test', 'node:test', 'uvu/assert', 'tap']);
const RUNNER_ASSERTION_EXPORTS = new Set(['expect', 'assert', 'should']);

/** AVA / tap / node:test context methods that do not assert anything. */
const T_NON_ASSERTIONS = new Set([
  'plan', 'teardown', 'before', 'after', 'beforeEach', 'afterEach', 'mock', 'test', 'skip', 'todo',
  'log', 'diagnostic', 'comment', 'timeout', 'context', 'signal', 'name', 'runOnly', 'fullName', 'end',
]);

export type AssertionKind = 'value' | 'meta' | 'implicit';

/**
 * Local names bound to assertion functions by imports or requires, e.g.
 * `import assert from 'node:assert'`, `import { equal } from 'assert'`,
 * `import { expect as e } from 'vitest'`, `const { strictEqual } = require('assert')`.
 */
export function collectAssertionBindings(program: TSESTree.Program): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === AST_NODE_TYPES.ImportDeclaration && typeof statement.source.value === 'string') {
      const source = statement.source.value;
      const isAssertionModule = ASSERTION_MODULES.has(source);
      const isRunnerModule = RUNNER_MODULES.has(source);
      if (!isAssertionModule && !isRunnerModule) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
          const imported = specifier.imported.type === AST_NODE_TYPES.Identifier ? specifier.imported.name : String(specifier.imported.value);
          if (isAssertionModule || RUNNER_ASSERTION_EXPORTS.has(imported)) names.add(specifier.local.name);
        } else if (isAssertionModule) {
          names.add(specifier.local.name);
        }
      }
    }
    if (statement.type === AST_NODE_TYPES.VariableDeclaration) {
      for (const declarator of statement.declarations) {
        const init = declarator.init;
        if (
          init?.type !== AST_NODE_TYPES.CallExpression ||
          init.callee.type !== AST_NODE_TYPES.Identifier ||
          init.callee.name !== 'require' ||
          init.arguments[0]?.type !== AST_NODE_TYPES.Literal ||
          typeof init.arguments[0].value !== 'string' ||
          !ASSERTION_MODULES.has(init.arguments[0].value)
        ) {
          continue;
        }
        if (declarator.id.type === AST_NODE_TYPES.Identifier) names.add(declarator.id.name);
        if (declarator.id.type === AST_NODE_TYPES.ObjectPattern) {
          for (const property of declarator.id.properties) {
            if (property.type === AST_NODE_TYPES.Property && property.value.type === AST_NODE_TYPES.Identifier) {
              names.add(property.value.name);
            }
          }
        }
      }
    }
  }
  return names;
}

/** expectValidUser(), assertNoErrors(), verifyResponse(), ensureVisible(): helpers that assert. */
const HELPER_ASSERTION_NAME = /^(?:expect|assert|verify|should|ensure)(?:[A-Z0-9_]|$)/;
const TESTING_LIBRARY_QUERY = /^(?:getBy|getAllBy|findBy|findAllBy)[A-Z]/;

export interface AssertionContext {
  /** Names bound to assertion functions (see collectAssertionBindings). */
  bindings: Set<string>;
  /** Parameter names of the enclosing test callback (AVA/tap `t`). */
  testContextNames?: Set<string>;
}

/**
 * Classifies a call as an assertion:
 * - `value`: asserts something about a value (`expect(x)`, `assert.equal`, `t.is`)
 * - `meta`: constrains assertions (`expect.assertions(1)`, `t.plan(2)`)
 * - `implicit`: throws when the thing is missing (Testing Library `getBy*`, Cypress `cy.*`)
 *
 * For an `expect(x).toBe(y)` chain only the inner `expect(x)` call is an assertion,
 * so each assertion is counted once.
 */
export function getAssertionKind(node: TSESTree.CallExpression, context: AssertionContext): AssertionKind | null {
  const callee = node.callee;

  if (callee.type === AST_NODE_TYPES.Identifier) {
    const name = callee.name;
    if (name === 'expect' || name === 'assert' || name === 'should' || context.bindings.has(name)) return 'value';
    if (HELPER_ASSERTION_NAME.test(name)) return 'value';
    if (TESTING_LIBRARY_QUERY.test(name)) return 'implicit';
    return null;
  }

  if (callee.type !== AST_NODE_TYPES.MemberExpression) return null;
  const property = !callee.computed && callee.property.type === AST_NODE_TYPES.Identifier ? callee.property.name : null;

  // x.should.equal(1), cy.get(...).should('be.visible')
  if (property === 'should') return 'value';
  // screen.getByText(...), within(el).getByRole(...): throw when nothing matches
  if (property && TESTING_LIBRARY_QUERY.test(property)) return 'implicit';
  // supertest request(app).get('/').expect(200), td.verify(...), page.expectVisible()
  if (property && HELPER_ASSERTION_NAME.test(property)) return 'value';
  let current: TSESTree.Node = callee.object;
  while (current.type === AST_NODE_TYPES.MemberExpression) {
    if (!current.computed && current.property.type === AST_NODE_TYPES.Identifier && current.property.name === 'should') {
      return 'value';
    }
    current = current.object;
  }

  const chain = resolveChain(callee);
  if (!chain) {
    // cy.get('x').click() — chains rooted in a call on `cy`
    let root: TSESTree.Node = callee;
    while (root.type === AST_NODE_TYPES.MemberExpression || root.type === AST_NODE_TYPES.CallExpression) {
      root = root.type === AST_NODE_TYPES.MemberExpression ? root.object : root.callee;
    }
    return root.type === AST_NODE_TYPES.Identifier && root.name === 'cy' ? 'implicit' : null;
  }

  const { root, props } = chain;
  const first = props[0];
  if (root === 'expect') {
    if (first === 'assertions' || first === 'hasAssertions') return 'meta';
    if (first === 'soft' || first === 'poll' || first === 'element') return 'value';
    return null; // expect.extend, expect.any, expect.objectContaining
  }
  if (root === 'assert' || context.bindings.has(root)) return 'value';
  if (root === 'chai' && (first === 'expect' || first === 'assert')) return 'value';
  if (root === 'sinon' && first === 'assert') return 'value';
  if (root === 'cy') return 'implicit';
  if (context.testContextNames?.has(root)) {
    if (first === 'plan') return 'meta';
    if (first === 'assert') return 'value'; // node:test t.assert.strictEqual
    if (first && !T_NON_ASSERTIONS.has(first)) return 'value';
  }
  return null;
}

// ─── expect() chains ────────────────────────────────────────────────────────

export interface ExpectMatcher {
  /** The `expect(...)` call. */
  expectCall: TSESTree.CallExpression;
  /** Matcher name: `toBe`, or a chai word such as `true`/`equal`. */
  name: string;
  negated: boolean;
  /** Arguments of the matcher call; empty for chai property assertions. */
  args: TSESTree.CallExpressionArgument[];
  /** True when the matcher is invoked (`.toBe(x)`), false for chai properties (`.to.be.true`). */
  called: boolean;
  /** Full chain of property names after expect(...), e.g. ['not', 'toBe']. */
  chain: string[];
}

/** Given the inner `expect(x)` call, returns the matcher at the end of its chain. */
export function getExpectMatcher(expectCall: TSESTree.CallExpression): ExpectMatcher | null {
  const chain: string[] = [];
  let node: TSESTree.Node = expectCall;
  while (node.parent?.type === AST_NODE_TYPES.MemberExpression && node.parent.object === node) {
    const member: TSESTree.MemberExpression = node.parent;
    if (member.computed || member.property.type !== AST_NODE_TYPES.Identifier) return null;
    chain.push(member.property.name);
    node = member;
  }
  if (chain.length === 0) return null;
  const called = node.parent?.type === AST_NODE_TYPES.CallExpression && node.parent.callee === node;
  const args = called ? (node.parent as TSESTree.CallExpression).arguments : [];
  const name = chain[chain.length - 1];
  return { expectCall, name, negated: chain.includes('not'), args, called, chain };
}

/** Matchers that pin an exact expectation. */
const STRONG_MATCHERS = new Set([
  'toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toContain', 'toContainEqual', 'toHaveLength',
  'toHaveProperty', 'toBeCloseTo', 'toMatch', 'toThrow', 'toThrowError', 'toHaveBeenCalledWith',
  'toHaveBeenCalledTimes', 'toHaveBeenNthCalledWith', 'toHaveBeenLastCalledWith', 'toHaveReturnedWith',
  'toMatchSnapshot', 'toMatchInlineSnapshot', 'toHaveTextContent', 'toHaveValue', 'toHaveAttribute',
  'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'resolves', 'rejects',
  'equal', 'equals', 'eql', 'deep', 'include', 'members', 'lengthOf', 'property', 'throw',
]);
/** Matchers that pass for almost any value. */
const WEAK_MATCHERS = new Set([
  'toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toBeInstanceOf', 'toBeTypeOf', 'toHaveBeenCalled', 'anything',
  'exist', 'ok', 'a', 'an',
]);

/** `strong` pins a value; `weak` passes for almost anything (`toBeDefined`, `not.toBeNull`). */
export function getMatcherStrength(matcher: ExpectMatcher): 'strong' | 'weak' | 'unknown' {
  const { name, negated, args } = matcher;
  if (negated && ['toBeNull', 'toBeUndefined', 'toBeFalsy', 'toThrow', 'toThrowError', 'toBeNaN'].includes(name)) return 'weak';
  if (WEAK_MATCHERS.has(name)) return 'weak';
  if ((name === 'toThrow' || name === 'toThrowError') && args.length === 0) return 'weak';
  if (STRONG_MATCHERS.has(name)) return negated ? 'weak' : 'strong';
  return 'unknown';
}
