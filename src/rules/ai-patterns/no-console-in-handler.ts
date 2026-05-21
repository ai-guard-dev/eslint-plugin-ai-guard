import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

const ROUTE_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'all',
] as const;

function isRouteRegistrationCall(node: TSESTree.CallExpression): boolean {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    node.callee.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  const methodName = node.callee.property.name;
  if (!ROUTE_METHODS.includes(methodName as (typeof ROUTE_METHODS)[number])) {
    return false;
  }

  if (node.arguments.length === 0) {
    return false;
  }

  const firstArg = node.arguments[0];

  // Keep matching conservative to avoid false positives on non-routing APIs.
  if (
    firstArg.type === AST_NODE_TYPES.Literal &&
    typeof firstArg.value === 'string' &&
    firstArg.value.startsWith('/')
  ) {
    return true;
  }

  if (
    firstArg.type === AST_NODE_TYPES.TemplateLiteral &&
    firstArg.expressions.length === 0 &&
    firstArg.quasis[0]?.value.raw.startsWith('/')
  ) {
    return true;
  }

  return false;
}

function traverseForConsoleCalls(
  node: TSESTree.Node,
  onConsoleCall: (callNode: TSESTree.CallExpression) => void
): void {
  if (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === 'console' &&
    node.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    onConsoleCall(node);
  }

  // Do not recurse into nested function bodies to avoid double-reporting on unrelated closures.
  if (
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return;
  }

  const entries = Object.entries(node) as Array<[string, unknown]>;
  for (const [key, value] of entries) {
    if (key === 'parent') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          traverseForConsoleCalls(child as TSESTree.Node, onConsoleCall);
        }
      }
      continue;
    }

    if (value && typeof value === 'object' && 'type' in value) {
      traverseForConsoleCalls(value as TSESTree.Node, onConsoleCall);
    }
  }
}

export const noConsoleInHandler = createRule({
  name: 'no-console-in-handler',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow console logging inside route handlers. AI tools frequently leave debug logs in request handlers, which can leak operational data and create noisy production logs.',
    },
    fixable: undefined,
    hasSuggestions: true,
    schema: [],
    messages: {
      noConsoleInHandler:
        'Avoid console logging inside route handlers. AI tools frequently leave debug statements in handlers. Use structured application logging instead.',
      removeConsoleCall:
        'Remove this console statement from the route handler.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (!isRouteRegistrationCall(node)) {
          return;
        }

        for (const argument of node.arguments) {
          if (
            argument.type !== AST_NODE_TYPES.FunctionExpression &&
            argument.type !== AST_NODE_TYPES.ArrowFunctionExpression
          ) {
            continue;
          }

          if (argument.body.type !== AST_NODE_TYPES.BlockStatement) {
            continue;
          }

          for (const statement of argument.body.body) {
            traverseForConsoleCalls(statement, (callNode) => {
              const parent = callNode.parent;
              const canSuggestRemoval = parent?.type === AST_NODE_TYPES.ExpressionStatement;

              context.report({
                node: callNode,
                messageId: 'noConsoleInHandler',
                suggest: canSuggestRemoval
                  ? [
                      {
                        messageId: 'removeConsoleCall',
                        fix: (fixer) => fixer.remove(parent),
                      },
                    ]
                  : undefined,
              });
            });
          }
        }
      },
    };
  },
});

export default noConsoleInHandler;
