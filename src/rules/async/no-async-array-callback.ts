import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

const ARRAY_CALLBACK_METHODS = ['map', 'filter', 'forEach', 'reduce', 'flatMap', 'find', 'findIndex', 'some', 'every'] as const;

const PROMISE_COMBINATORS = ['all', 'allSettled', 'race', 'any'] as const;
const METHODS_ALLOWING_PROMISE_COLLECTION = new Set(['map', 'flatMap']);

function isNode(value: unknown): value is TSESTree.Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function getChildNodes(node: TSESTree.Node): TSESTree.Node[] {
  const children: TSESTree.Node[] = [];
  for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
    if (key === 'parent') continue;

    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          children.push(item);
        }
      }
      continue;
    }

    if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function isPromiseCombinatorCall(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === 'Promise' &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    PROMISE_COMBINATORS.includes(
      node.callee.property.name as (typeof PROMISE_COMBINATORS)[number],
    )
  );
}

/**
 * Checks if the given CallExpression (e.g., arr.map(...)) is used as an argument
 * to Promise.all(), Promise.allSettled(), Promise.race(), or Promise.any().
 */
function isWrappedInPromiseCombinator(
  node: TSESTree.CallExpression,
  context: Readonly<Parameters<ReturnType<typeof createRule>['create']>[0]>
): boolean {
  const ancestors = context.sourceCode.getAncestors(node);

  const directParent = node.parent;
  if (
    directParent &&
    directParent.type === AST_NODE_TYPES.CallExpression &&
    isPromiseCombinatorCall(directParent)
  ) {
    return true;
  }

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (ancestor.type === AST_NODE_TYPES.CallExpression && isPromiseCombinatorCall(ancestor)) {
      return true;
    }

    if (ancestor.type === AST_NODE_TYPES.CallExpression) {
      break;
    }
  }
  return false;
}

function isIdentifierConsumedByPromiseCombinator(
  node: TSESTree.Node,
  identifierName: string,
): boolean {
  let found = false;

  const visit = (current: TSESTree.Node): void => {
    if (found) return;

    if (
      current.type === AST_NODE_TYPES.CallExpression &&
      isPromiseCombinatorCall(current)
    ) {
      for (const arg of current.arguments) {
        if (arg.type === AST_NODE_TYPES.Identifier && arg.name === identifierName) {
          found = true;
          return;
        }
      }
    }

    for (const child of getChildNodes(current)) {
      visit(child);
      if (found) return;
    }
  };

  visit(node);
  return found;
}

function isAssignedAndConsumedByPromiseCombinator(
  node: TSESTree.CallExpression,
): boolean {
  if (
    !node.parent ||
    node.parent.type !== AST_NODE_TYPES.VariableDeclarator ||
    node.parent.id.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  const variableName = node.parent.id.name;
  const declaration = node.parent.parent;
  if (!declaration || declaration.type !== AST_NODE_TYPES.VariableDeclaration) {
    return false;
  }

  const container = declaration.parent;
  if (!container || (container.type !== AST_NODE_TYPES.Program && container.type !== AST_NODE_TYPES.BlockStatement)) {
    return false;
  }

  const body = container.body;
  const declarationIndex = body.findIndex((statement) => statement === declaration);
  if (declarationIndex === -1) {
    return false;
  }

  for (let i = declarationIndex + 1; i < body.length; i++) {
    const statement = body[i];
    if (isIdentifierConsumedByPromiseCombinator(statement, variableName)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a node is an async function expression or arrow function.
 */
function isAsyncCallback(node: TSESTree.Node): boolean {
  return (
    (node.type === AST_NODE_TYPES.FunctionExpression ||
      node.type === AST_NODE_TYPES.ArrowFunctionExpression) &&
    node.async
  );
}

export const noAsyncArrayCallback = createRule({
  name: 'no-async-array-callback',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow async callbacks in array iteration methods (map, filter, forEach, reduce). AI tools generate `array.map(async ...)` which returns `Promise[]` instead of resolved values — a silent bug.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      asyncArrayCallback:
        'Async callback passed to Array.{{method}}(). This returns an array of Promises, not resolved values. AI tools frequently generate this pattern. Wrap with `await Promise.all(array.{{method}}(...))` or use a for...of loop.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        // Check if this is a method call like something.map(...), something.filter(...), etc.
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }

        const methodName = node.callee.property.name;

        if (
          !ARRAY_CALLBACK_METHODS.includes(
            methodName as (typeof ARRAY_CALLBACK_METHODS)[number]
          )
        ) {
          return;
        }

        // The callback is the first argument for all methods except reduce where it's also the first
        const callback = node.arguments[0];
        if (!callback) {
          return;
        }

        if (isAsyncCallback(callback)) {
          // Don't flag if the array method call is already wrapped in Promise.all/allSettled/race/any
          // e.g., Promise.all(arr.map(async ...)) — this is the correct pattern
          if (isWrappedInPromiseCombinator(node, context)) {
            return;
          }

          if (
            METHODS_ALLOWING_PROMISE_COLLECTION.has(methodName) &&
            isAssignedAndConsumedByPromiseCombinator(node)
          ) {
            return;
          }

          context.report({
            node: callback,
            messageId: 'asyncArrayCallback',
            data: {
              method: methodName,
            },
          });
        }
      },
    };
  },
});

export default noAsyncArrayCallback;
