import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

export const noEvalDynamic = createRule({
  name: 'no-eval-dynamic',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow `eval()` and `new Function()` with non-literal arguments. AI tools frequently generate dynamic code evaluation patterns that create serious security vulnerabilities including code injection and XSS.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      evalDynamic:
        'Dangerous use of `{{callee}}` with a dynamic argument. AI tools frequently generate `eval()` or `new Function()` patterns that enable code injection attacks. Use safer alternatives like JSON.parse(), a lookup table, or a sandboxed evaluator.',
      newFunctionDynamic:
        'Dangerous use of `new Function()` with a dynamic argument. AI tools frequently generate this pattern which enables arbitrary code execution. Use safer alternatives like a lookup table or pre-defined functions.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        // Check for eval(...)
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === 'eval'
        ) {
          // Allow eval() with no args (no-op) or with only literal string args
          if (node.arguments.length === 0) return;

          const firstArg = node.arguments[0];
          if (isLiteral(firstArg)) return;

          context.report({
            node,
            messageId: 'evalDynamic',
            data: { callee: 'eval()' },
          });
          return;
        }

        // Check for window.eval(...) or globalThis.eval(...)
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          node.callee.property.name === 'eval' &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          (node.callee.object.name === 'window' || node.callee.object.name === 'globalThis')
        ) {
          if (node.arguments.length === 0) return;
          const firstArg = node.arguments[0];
          if (isLiteral(firstArg)) return;

          context.report({
            node,
            messageId: 'evalDynamic',
            data: { callee: `${node.callee.object.name}.eval()` },
          });
          return;
        }

        // Function(...) invoked WITHOUT `new` is semantically identical to
        // new Function(...) per ECMA-262 and MDN — `Function('a','return a')(1)`
        // executes the body string as code. AI-generated examples sometimes
        // drop the `new` because both forms "work"; the rule previously hooked
        // only NewExpression, letting bare calls through as a code-injection
        // FN. Cover Identifier `Function(...)` plus `window.Function(...)` /
        // `globalThis.Function(...)`.
        if (isFunctionConstructorCallee(node.callee)) {
          if (node.arguments.length === 0) return;
          const allLiteral = node.arguments.every(isLiteral);
          if (allLiteral) return;

          context.report({
            node,
            messageId: 'newFunctionDynamic',
          });
        }
      },

      NewExpression(node) {
        // Check for new Function(...) / new window.Function(...) / new globalThis.Function(...)
        if (isFunctionConstructorCallee(node.callee)) {
          if (node.arguments.length === 0) return;

          // All arguments must be literals to be safe
          const allLiteral = node.arguments.every(isLiteral);
          if (allLiteral) return;

          context.report({
            node,
            messageId: 'newFunctionDynamic',
          });
        }
      },
    };
  },
});

/**
 * Match the `Function` constructor callee in any of its reachable forms:
 * - bare identifier `Function`
 * - `window.Function`
 * - `globalThis.Function`
 * Used for both `new Function(...)` and bare `Function(...)` calls, which are
 * semantically identical for the code-injection risk the rule targets.
 */
function isFunctionConstructorCallee(callee: TSESTree.Node): boolean {
  if (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'Function') {
    return true;
  }
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === 'Function' &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    (callee.object.name === 'window' || callee.object.name === 'globalThis')
  ) {
    return true;
  }
  return false;
}

/**
 * Check if a node is a static literal (string, number, boolean, null, template literal with no expressions).
 */
function isLiteral(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Literal) return true;
  if (
    node.type === AST_NODE_TYPES.TemplateLiteral &&
    node.expressions.length === 0
  ) {
    return true;
  }
  return false;
}

export default noEvalDynamic;
