import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import { isTestFile } from '../../utils/file-context';
import { someDescendant } from '../../utils/ast-helpers';
import {
  getTestCall,
  getAssertionKind,
  collectAssertionBindings,
  type TestCall,
  type AssertionContext,
} from '../../utils/test-patterns';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/** Titles that state "not throwing" is the whole point of the test. */
const SMOKE_TEST_TITLE =
  /\b(?:does(?:n'?t| not) (?:throw|crash|fail|error)|(?:not|never) throws?|without (?:crashing|errors?|throwing|exceptions?|failing)|smoke)\b/i;

/** Files driven by end-to-end runners, where actions auto-wait and fail by themselves. */
const E2E_MODULES = new Set(['@playwright/test', 'playwright/test']);

type FunctionNode = TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression;

/** Mocha/Jasmine/Jest completion-callback parameter names. */
const DONE_PARAM_NAME = /^(?:done|cb|callback|next|finish)$/;

function paramNames(fn: FunctionNode): Set<string> {
  const names = new Set<string>();
  for (const param of fn.params) if (param.type === AST_NODE_TYPES.Identifier) names.add(param.name);
  return names;
}

/**
 * Mocha/Jest callback tests: `app.on('x', done)`, `server.close(done)` or `{ end: done }`
 * only finish when the callback runs, so passing `done` along (or calling it from a
 * nested callback) is the assertion. A synchronous `done()` at the end asserts nothing.
 */
function usesDoneAsAssertion(callback: FunctionNode): boolean {
  const first = callback.params[0];
  if (first?.type !== AST_NODE_TYPES.Identifier || !callback.body) return false;
  // Only completion callbacks; in it.each((row) => ...) the parameter is table data.
  if (!DONE_PARAM_NAME.test(first.name)) return false;
  const done = first.name;
  return someDescendant(callback.body, (n) => {
    if (n.type !== AST_NODE_TYPES.Identifier || n.name !== done) return false;
    const parent = n.parent;
    const isDirectCall = parent?.type === AST_NODE_TYPES.CallExpression && parent.callee === n;
    if (!isDirectCall) return true;
    let current: TSESTree.Node | undefined = parent.parent;
    while (current && current !== callback) {
      if (
        current.type === AST_NODE_TYPES.FunctionExpression ||
        current.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        current.type === AST_NODE_TYPES.FunctionDeclaration
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  });
}

function calleeName(node: TSESTree.CallExpression): string | null {
  if (node.callee.type === AST_NODE_TYPES.Identifier) return node.callee.name;
  if (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.ThisExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return node.callee.property.name;
  }
  return null;
}

export const noAssertionlessTest = createRule<[], 'noAssertions'>({
  name: 'no-assertionless-test',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow test cases that contain no assertion, so they pass whatever the code does. AI agents write such tests to show coverage or to make a failing suite pass. Counts expect/assert/chai/should/sinon/AVA assertions, supertest `.expect()`, Testing Library `getBy*` queries, thrown errors, and local helper functions that assert.',
    },
    schema: [],
    messages: {
      noAssertions:
        'Test "{{title}}" has no assertions, so it passes no matter what the code does. AI agents write tests like this to show coverage or to make a failing suite pass. Add an expect(...) for the behaviour the test name describes.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.physicalFilename || context.filename;
    if (!isTestFile(filename)) return {};

    const tests: TestCall[] = [];
    const functions = new Map<string, FunctionNode>();

    return {
      CallExpression(node): void {
        const test = getTestCall(node);
        if (test?.kind === 'test') tests.push(test);
      },
      FunctionDeclaration(node): void {
        if (node.id) functions.set(node.id.name, node);
      },
      VariableDeclarator(node): void {
        if (
          node.id.type === AST_NODE_TYPES.Identifier &&
          (node.init?.type === AST_NODE_TYPES.ArrowFunctionExpression || node.init?.type === AST_NODE_TYPES.FunctionExpression)
        ) {
          functions.set(node.id.name, node.init);
        }
      },
      MethodDefinition(node): void {
        // Abstract/overload signatures (TSEmptyBodyFunctionExpression) have no body to inspect.
        if (node.key.type === AST_NODE_TYPES.Identifier && node.value.type === AST_NODE_TYPES.FunctionExpression) {
          functions.set(node.key.name, node.value);
        }
      },

      'Program:exit'(program: TSESTree.Program): void {
        const isE2E = program.body.some(
          (s) => s.type === AST_NODE_TYPES.ImportDeclaration && typeof s.source.value === 'string' && E2E_MODULES.has(s.source.value)
        );
        if (isE2E) return;

        const bindings = collectAssertionBindings(program);

        // Local helpers that assert (directly, or through another asserting helper).
        const assertingHelpers = new Set<string>();
        const containsAssertion = (root: TSESTree.Node, ctx: AssertionContext): boolean =>
          someDescendant(root, (n) => {
            if (n.type === AST_NODE_TYPES.ThrowStatement) return true;
            if (n.type !== AST_NODE_TYPES.CallExpression) return false;
            if (getAssertionKind(n, ctx) !== null) return true;
            const name = calleeName(n);
            return name !== null && assertingHelpers.has(name);
          });

        for (let pass = 0; pass < 3; pass++) {
          let added = false;
          for (const [name, fn] of functions) {
            if (assertingHelpers.has(name) || !fn.body) continue;
            if (containsAssertion(fn.body, { bindings, testContextNames: paramNames(fn) })) {
              assertingHelpers.add(name);
              added = true;
            }
          }
          if (!added) break;
        }

        for (const test of tests) {
          if (!test.callback || test.modifiers.has('todo') || test.modifiers.has('skip')) continue;
          if (SMOKE_TEST_TITLE.test(test.title)) continue;
          const ctx: AssertionContext = { bindings, testContextNames: paramNames(test.callback) };
          if (containsAssertion(test.callback.body, ctx) || usesDoneAsAssertion(test.callback)) continue;
          context.report({ node: test.node, messageId: 'noAssertions', data: { title: test.title.slice(0, 60) } });
        }
      },
    };
  },
});

export default noAssertionlessTest;
