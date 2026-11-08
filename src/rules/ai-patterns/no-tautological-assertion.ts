import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import { getExpectMatcher, type ExpectMatcher } from '../../utils/test-patterns';

/**
 * Type-level test files (`types.test.ts`, `*.test-d.ts`) check types at compile time;
 * a runtime `expect(true).toBeTruthy()` there is a deliberate placeholder.
 */
const TYPE_TEST_FILE = /(?:^|[\\/.\-_])(?:types?|typings?)(?:[.\-_](?:test|spec))?\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-d\.[cm]?tsx?$|[\\/]type-?tests?[\\/]/i;

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

// ─── Static evaluation ───────────────────────────────────────────────────────

type Static = { value: unknown } | null;

const MAX_STATIC_DEPTH = 8;

/** The value of an expression that does not depend on any code under test. */
export function staticValue(node: TSESTree.Node | null | undefined, depth = 0): Static {
  if (!node || depth > MAX_STATIC_DEPTH) return null;
  switch (node.type) {
    case AST_NODE_TYPES.Literal:
      if ('regex' in node && node.regex) return null;
      return { value: node.value };
    case AST_NODE_TYPES.TemplateLiteral:
      return node.expressions.length === 0 ? { value: node.quasis[0]?.value.cooked ?? '' } : null;
    case AST_NODE_TYPES.Identifier:
      if (node.name === 'undefined') return { value: undefined };
      if (node.name === 'NaN') return { value: NaN };
      if (node.name === 'Infinity') return { value: Infinity };
      return null;
    case AST_NODE_TYPES.UnaryExpression: {
      if (node.operator === 'delete') return null;
      const inner = staticValue(node.argument, depth + 1);
      if (!inner) return null;
      const v = inner.value as number;
      switch (node.operator) {
        case '!': return { value: !v };
        case '-': return { value: -v };
        case '+': return { value: +v };
        case '~': return { value: ~v };
        case 'typeof': return { value: typeof v };
        case 'void': return { value: undefined };
        default: return null;
      }
    }
    case AST_NODE_TYPES.BinaryExpression: {
      if (node.left.type === AST_NODE_TYPES.PrivateIdentifier) return null;
      const left = staticValue(node.left, depth + 1);
      const right = staticValue(node.right, depth + 1);
      if (!left || !right) return null;
      const a = left.value as number;
      const b = right.value as number;
      switch (node.operator) {
        case '+': return { value: (a as unknown as string) + (b as unknown as string) };
        case '-': return { value: a - b };
        case '*': return { value: a * b };
        case '/': return { value: a / b };
        case '%': return { value: a % b };
        case '**': return { value: a ** b };
        case '===': return { value: a === b };
        case '!==': return { value: a !== b };
        // Loose comparisons mirror what the code under evaluation wrote.
        case '==': return { value: a == b };
        case '!=': return { value: a != b };
        case '<': return { value: a < b };
        case '>': return { value: a > b };
        case '<=': return { value: a <= b };
        case '>=': return { value: a >= b };
        default: return null;
      }
    }
    case AST_NODE_TYPES.LogicalExpression: {
      const left = staticValue(node.left, depth + 1);
      if (!left) return null;
      if (node.operator === '&&') return left.value ? staticValue(node.right, depth + 1) : left;
      if (node.operator === '||') return left.value ? left : staticValue(node.right, depth + 1);
      return left.value === null || left.value === undefined ? staticValue(node.right, depth + 1) : left;
    }
    case AST_NODE_TYPES.ArrayExpression: {
      const items: unknown[] = [];
      for (const element of node.elements) {
        if (!element || element.type === AST_NODE_TYPES.SpreadElement) return null;
        const item = staticValue(element, depth + 1);
        if (!item) return null;
        items.push(item.value);
      }
      return { value: items };
    }
    case AST_NODE_TYPES.ObjectExpression: {
      const result: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (property.type !== AST_NODE_TYPES.Property || property.computed || property.kind !== 'init') return null;
        const key =
          property.key.type === AST_NODE_TYPES.Identifier ? property.key.name
          : property.key.type === AST_NODE_TYPES.Literal ? String(property.key.value)
          : null;
        if (key === null) return null;
        const value = staticValue(property.value, depth + 1);
        if (!value) return null;
        result[key] = value.value;
      }
      return { value: result };
    }
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
    case AST_NODE_TYPES.TSSatisfiesExpression:
      return staticValue(node.expression, depth + 1);
    default:
      return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const bKeys = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return aKeys.length === bKeys.length && aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Outcome of an expect-matcher on a constant subject: true (always passes), false (always fails), null (unknown). */
function evaluateMatcher(subject: unknown, matcher: ExpectMatcher): boolean | null {
  const arg = matcher.args[0] as TSESTree.Node | undefined;
  const expected = arg ? staticValue(arg) : null;
  const needsArg = (fn: (e: unknown) => boolean): boolean | null => (expected ? fn(expected.value) : null);
  const s = subject as never;
  let result: boolean | null;

  switch (matcher.name) {
    case 'toBe': result = needsArg((e) => Object.is(subject, e)); break;
    case 'toEqual':
    case 'toStrictEqual':
    case 'eql': result = needsArg((e) => deepEqual(subject, e)); break;
    case 'equal':
    case 'equals': result = matcher.chain.includes('deep') ? needsArg((e) => deepEqual(subject, e)) : needsArg((e) => subject === e); break;
    case 'toBeTruthy':
    case 'ok': result = Boolean(subject); break;
    case 'toBeFalsy': result = !subject; break;
    case 'toBeDefined': result = subject !== undefined; break;
    case 'toBeUndefined':
    case 'undefined': result = subject === undefined; break;
    case 'toBeNull':
    case 'null': result = subject === null; break;
    case 'toBeNaN':
    case 'NaN': result = Number.isNaN(subject); break;
    case 'true': result = subject === true; break;
    case 'false': result = subject === false; break;
    case 'exist': result = subject !== null && subject !== undefined; break;
    case 'toBeGreaterThan':
    case 'above': result = needsArg((e) => s > (e as never)); break;
    case 'toBeGreaterThanOrEqual':
    case 'least': result = needsArg((e) => s >= (e as never)); break;
    case 'toBeLessThan':
    case 'below': result = needsArg((e) => s < (e as never)); break;
    case 'toBeLessThanOrEqual':
    case 'most': result = needsArg((e) => s <= (e as never)); break;
    case 'toContain':
    case 'include':
    case 'contain':
      result = needsArg((e) => (typeof subject === 'string' || Array.isArray(subject) ? (subject as string).includes(e as string) : false));
      break;
    case 'toHaveLength':
    case 'lengthOf':
      result = needsArg((e) => (typeof subject === 'string' || Array.isArray(subject) ? (subject as string).length === e : false));
      break;
    case 'toBeTypeOf': result = needsArg((e) => typeof subject === e); break;
    case 'toMatch':
      if (arg?.type === AST_NODE_TYPES.Literal && 'regex' in arg && arg.regex && typeof subject === 'string') {
        result = new RegExp(arg.regex.pattern, arg.regex.flags).test(subject);
      } else {
        result = needsArg((e) => typeof subject === 'string' && typeof e === 'string' && subject.includes(e));
      }
      break;
    default: result = null;
  }
  if (result === null) return null;
  return matcher.negated ? !result : result;
}

// ─── Identity comparisons: expect(x).toBe(x) ────────────────────────────────

function isPureReference(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Identifier || node.type === AST_NODE_TYPES.ThisExpression) return true;
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    if (node.computed && node.property.type !== AST_NODE_TYPES.Literal) return false;
    return isPureReference(node.object);
  }
  if (node.type === AST_NODE_TYPES.TSNonNullExpression || node.type === AST_NODE_TYPES.TSAsExpression) return isPureReference(node.expression);
  return false;
}

/** The outermost node of an `expect(x).not.toBe(y)` chain, for reporting. */
function chainEnd(expectCall: TSESTree.CallExpression): TSESTree.Node {
  let node: TSESTree.Node = expectCall;
  while (node.parent) {
    const parent: TSESTree.Node = node.parent;
    const continues =
      (parent.type === AST_NODE_TYPES.MemberExpression && parent.object === node) ||
      (parent.type === AST_NODE_TYPES.CallExpression && parent.callee === node);
    if (!continues) break;
    node = parent;
  }
  return node;
}

const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'equal', 'equals', 'eql']);

// ─── Assert-style APIs ──────────────────────────────────────────────────────

const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict', 'chai', 'power-assert']);

type AssertCheck =
  | { kind: 'truthy' }
  | { kind: 'falsy' }
  | { kind: 'equal'; strictness: 'loose' | 'strict' | 'deep'; negated: boolean }
  | { kind: 'is'; expected: unknown };

const ASSERT_METHODS: Record<string, AssertCheck> = {
  ok: { kind: 'truthy' },
  isOk: { kind: 'truthy' },
  isTrue: { kind: 'is', expected: true },
  isFalse: { kind: 'is', expected: false },
  isNull: { kind: 'is', expected: null },
  isUndefined: { kind: 'is', expected: undefined },
  isNotOk: { kind: 'falsy' },
  equal: { kind: 'equal', strictness: 'loose', negated: false },
  strictEqual: { kind: 'equal', strictness: 'strict', negated: false },
  deepEqual: { kind: 'equal', strictness: 'deep', negated: false },
  deepStrictEqual: { kind: 'equal', strictness: 'deep', negated: false },
  notEqual: { kind: 'equal', strictness: 'loose', negated: true },
  notStrictEqual: { kind: 'equal', strictness: 'strict', negated: true },
  notDeepEqual: { kind: 'equal', strictness: 'deep', negated: true },
  notDeepStrictEqual: { kind: 'equal', strictness: 'deep', negated: true },
};

interface AssertBindings {
  /** Callable assert namespaces: `assert`, `import assert from 'node:assert'`. */
  namespaces: Set<string>;
  /** Directly imported assert methods, local name -> method name. */
  methods: Map<string, string>;
  /** Local aliases of `expect` from test runners / chai. */
  expectNames: Set<string>;
}

function collectBindings(program: TSESTree.Program): AssertBindings {
  const bindings: AssertBindings = { namespaces: new Set(['assert']), methods: new Map(), expectNames: new Set(['expect']) };
  const addRequire = (declarator: TSESTree.VariableDeclarator): void => {
    const init = declarator.init;
    if (
      init?.type !== AST_NODE_TYPES.CallExpression ||
      init.callee.type !== AST_NODE_TYPES.Identifier ||
      init.callee.name !== 'require' ||
      init.arguments[0]?.type !== AST_NODE_TYPES.Literal ||
      typeof init.arguments[0].value !== 'string' ||
      !ASSERT_MODULES.has(init.arguments[0].value)
    ) {
      return;
    }
    if (declarator.id.type === AST_NODE_TYPES.Identifier) bindings.namespaces.add(declarator.id.name);
    if (declarator.id.type === AST_NODE_TYPES.ObjectPattern) {
      for (const property of declarator.id.properties) {
        if (property.type !== AST_NODE_TYPES.Property || property.key.type !== AST_NODE_TYPES.Identifier || property.value.type !== AST_NODE_TYPES.Identifier) continue;
        if (property.key.name === 'expect') bindings.expectNames.add(property.value.name);
        else if (property.key.name === 'assert' || property.key.name === 'strict') bindings.namespaces.add(property.value.name);
        else bindings.methods.set(property.value.name, property.key.name);
      }
    }
  };
  for (const statement of program.body) {
    if (statement.type === AST_NODE_TYPES.VariableDeclaration) statement.declarations.forEach(addRequire);
    if (statement.type !== AST_NODE_TYPES.ImportDeclaration || typeof statement.source.value !== 'string') continue;
    const source = statement.source.value;
    for (const specifier of statement.specifiers) {
      if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
        const imported = specifier.imported.type === AST_NODE_TYPES.Identifier ? specifier.imported.name : String(specifier.imported.value);
        if (imported === 'expect') bindings.expectNames.add(specifier.local.name);
        else if (imported === 'assert' || imported === 'strict') bindings.namespaces.add(specifier.local.name);
        else if (ASSERT_MODULES.has(source)) bindings.methods.set(specifier.local.name, imported);
      } else if (ASSERT_MODULES.has(source)) {
        bindings.namespaces.add(specifier.local.name);
      }
    }
  }
  return bindings;
}

function describeStatic(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value).slice(0, 40);
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    return text.length > 40 ? `${text.slice(0, 37)}...` : text;
  } catch {
    return String(value);
  }
}

type MessageIds = 'alwaysPasses' | 'comparesWithItself' | 'constantSubject';

export const noTautologicalAssertion = createRule<[], MessageIds>({
  name: 'no-tautological-assertion',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow assertions that pass no matter what the code does: `expect(true).toBe(true)`, `expect(1 + 1).toBe(2)`, `expect(x).toEqual(x)`, `assert.ok(1)`. AI agents add these to make a failing test pass or to make a placeholder test look real. Assertions that always fail (used as "should have thrown" sentinels) are not reported.',
    },
    schema: [],
    messages: {
      alwaysPasses:
        'This assertion always passes: it checks {{subject}}, a constant, instead of anything your code produced. AI agents write assertions like `expect(true).toBe(true)` to make a test pass. Assert on the result of the code under test.',
      comparesWithItself:
        'This assertion compares `{{subject}}` with itself, so it always passes. AI agents write these to make a test pass. Compare the result of the code under test with an independent expected value.',
      constantSubject:
        'This assertion checks a constant ({{subject}}), so it never tests your code. Pass the value produced by the code under test to expect().',
    },
  },
  defaultOptions: [],
  create(context) {
    if (TYPE_TEST_FILE.test(context.physicalFilename || context.filename)) return {};
    const sourceCode = context.sourceCode;
    let bindings: AssertBindings = { namespaces: new Set(['assert']), methods: new Map(), expectNames: new Set(['expect']) };
    const normalized = (node: TSESTree.Node): string => sourceCode.getText(node).replace(/\s+/g, '');

    function checkExpect(expectCall: TSESTree.CallExpression): void {
      const subjectNode = expectCall.arguments[0];
      if (!subjectNode || subjectNode.type === AST_NODE_TYPES.SpreadElement) return;
      const matcher = getExpectMatcher(expectCall);
      if (!matcher) return;
      const reportNode = chainEnd(expectCall);

      const subject = staticValue(subjectNode);
      if (subject) {
        // expect(200).toBe(res.status): the constant is on the wrong side, but the
        // assertion still checks a value the code produced.
        if (matcher.args.some((arg) => arg.type === AST_NODE_TYPES.SpreadElement || !staticValue(arg))) return;
        const outcome = evaluateMatcher(subject.value, matcher);
        if (outcome === false) return; // always fails: an intentional "should not reach" sentinel
        context.report({
          node: reportNode,
          messageId: outcome === true ? 'alwaysPasses' : 'constantSubject',
          data: { subject: describeStatic(subject.value) },
        });
        return;
      }

      const expected = matcher.args[0];
      if (
        !matcher.negated &&
        EQUALITY_MATCHERS.has(matcher.name) &&
        expected &&
        expected.type !== AST_NODE_TYPES.SpreadElement &&
        isPureReference(subjectNode) &&
        normalized(subjectNode) === normalized(expected)
      ) {
        context.report({ node: reportNode, messageId: 'comparesWithItself', data: { subject: normalized(subjectNode).slice(0, 40) } });
      }
    }

    function checkAssert(call: TSESTree.CallExpression, check: AssertCheck): void {
      const [first, second] = call.arguments;
      if (!first || first.type === AST_NODE_TYPES.SpreadElement) return;

      if (check.kind === 'equal') {
        if (!second || second.type === AST_NODE_TYPES.SpreadElement) return;
        if (!check.negated && isPureReference(first) && normalized(first) === normalized(second)) {
          context.report({ node: call, messageId: 'comparesWithItself', data: { subject: normalized(first).slice(0, 40) } });
          return;
        }
        const a = staticValue(first);
        const b = staticValue(second);
        if (!a || !b) return;
        // assert.equal compares loosely, like ==
        const equal = check.strictness === 'deep' ? deepEqual(a.value, b.value) : check.strictness === 'strict' ? Object.is(a.value, b.value) : a.value == b.value;
        if (equal !== check.negated) {
          context.report({ node: call, messageId: 'alwaysPasses', data: { subject: describeStatic(a.value) } });
        }
        return;
      }

      const value = staticValue(first);
      if (!value) return;
      const passes =
        check.kind === 'truthy' ? Boolean(value.value)
        : check.kind === 'falsy' ? !value.value
        : Object.is(value.value, check.expected);
      if (passes) context.report({ node: call, messageId: 'alwaysPasses', data: { subject: describeStatic(value.value) } });
    }

    return {
      Program(node): void {
        bindings = collectBindings(node);
      },
      CallExpression(node): void {
        const callee = node.callee;
        if (callee.type === AST_NODE_TYPES.Identifier) {
          if (bindings.expectNames.has(callee.name)) {
            checkExpect(node);
            return;
          }
          if (bindings.namespaces.has(callee.name)) {
            checkAssert(node, { kind: 'truthy' }); // assert(value) is assert.ok(value)
            return;
          }
          const method = bindings.methods.get(callee.name);
          if (method && ASSERT_METHODS[method]) checkAssert(node, ASSERT_METHODS[method]);
          return;
        }
        if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed || callee.property.type !== AST_NODE_TYPES.Identifier) return;

        // chai.expect(x)
        if (callee.object.type === AST_NODE_TYPES.Identifier && callee.object.name === 'chai' && callee.property.name === 'expect') {
          checkExpect(node);
          return;
        }
        // assert.equal(a, b), chai.assert.isTrue(x), assert.strict.equal(a, b)
        const method = callee.property.name;
        let objectNode: TSESTree.Node = callee.object;
        if (objectNode.type === AST_NODE_TYPES.MemberExpression && !objectNode.computed && objectNode.property.type === AST_NODE_TYPES.Identifier &&
          (objectNode.property.name === 'strict' || objectNode.property.name === 'assert')) {
          objectNode = objectNode.object;
        }
        if (objectNode.type !== AST_NODE_TYPES.Identifier) return;
        if (!bindings.namespaces.has(objectNode.name) && objectNode.name !== 'chai') return;
        const check = ASSERT_METHODS[method];
        if (check) checkAssert(node, check);
      },
    };
  },
});

export default noTautologicalAssertion;
