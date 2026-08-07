import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

const KNOWN_PROMISE_FACTORIES = new Set([
  'fetch',
]);

const PROMISE_STATIC_METHODS = new Set([
  'resolve',
  'reject',
  'all',
  'allSettled',
  'race',
  'any',
]);

interface TypeCheckerLike {
  getTypeAtLocation(node: unknown): unknown;
  typeToString(type: unknown): string;
  getPromisedTypeOfPromise?(type: unknown): unknown;
}

interface ProgramLike {
  getTypeChecker(): TypeCheckerLike;
}

interface ParserServicesLike {
  program?: ProgramLike;
  esTreeNodeToTSNodeMap?: {
    get(node: TSESTree.Node): unknown;
  };
}

interface VariableLike {
  name: string;
  defs?: Array<{ node?: TSESTree.Node }>;
}

interface ScopeLike {
  upper: ScopeLike | null;
  set?: Map<string, VariableLike>;
  variables?: VariableLike[];
}

interface AsyncBindingInfo {
  isAsync: boolean;
  hasInternalErrorHandling: boolean;
}

function isAstNode(value: unknown): value is TSESTree.Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function nodeHasCatchClause(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.TryStatement && !!node.handler) {
    return true;
  }

  for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
    if (key === 'parent') continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item) && nodeHasCatchClause(item)) {
          return true;
        }
      }
      continue;
    }

    if (isAstNode(value) && nodeHasCatchClause(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a CallExpression's callee is known async via local declarations.
 */
function isAsyncFunctionLike(node: TSESTree.Node | undefined): boolean {
  if (!node) return false;
  if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
    return node.async;
  }
  if (
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return node.async;
  }
  if (
    node.type === AST_NODE_TYPES.VariableDeclarator &&
    node.init &&
    (node.init.type === AST_NODE_TYPES.FunctionExpression ||
      node.init.type === AST_NODE_TYPES.ArrowFunctionExpression)
  ) {
    return node.init.async;
  }
  return false;
}

function getAsyncBindingInfo(node: TSESTree.Node | undefined): AsyncBindingInfo {
  if (!node) {
    return { isAsync: false, hasInternalErrorHandling: false };
  }

  if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
    return {
      isAsync: node.async,
      hasInternalErrorHandling: node.body ? nodeHasCatchClause(node.body) : false,
    };
  }

  if (
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return {
      isAsync: node.async,
      hasInternalErrorHandling:
        node.body.type === AST_NODE_TYPES.BlockStatement
          ? nodeHasCatchClause(node.body)
          : false,
    };
  }

  if (
    node.type === AST_NODE_TYPES.VariableDeclarator &&
    node.init &&
    (node.init.type === AST_NODE_TYPES.FunctionExpression ||
      node.init.type === AST_NODE_TYPES.ArrowFunctionExpression)
  ) {
    return {
      isAsync: node.init.async,
      hasInternalErrorHandling:
        node.init.body.type === AST_NODE_TYPES.BlockStatement
          ? nodeHasCatchClause(node.init.body)
          : false,
    };
  }

  return { isAsync: false, hasInternalErrorHandling: false };
}

function findVariableInScope(scope: ScopeLike, name: string): VariableLike | null {
  const fromMap = scope.set?.get(name);
  if (fromMap) {
    return fromMap;
  }

  if (scope.variables) {
    const fromArray = scope.variables.find((v) => v.name === name);
    if (fromArray) {
      return fromArray;
    }
  }

  return null;
}

function isIdentifierBoundToAsyncFunction(
  identifier: TSESTree.Identifier,
  context: Readonly<Parameters<ReturnType<typeof createRule>['create']>[0]>,
): AsyncBindingInfo {
  let scope = context.sourceCode.getScope(identifier) as unknown as ScopeLike | null;

  while (scope) {
    const variable = findVariableInScope(scope, identifier.name);
    if (variable) {
      const defs = variable.defs ?? [];
      for (const def of defs) {
        const info = getAsyncBindingInfo(def.node);
        if (info.isAsync) {
          return info;
        }
      }

      if (defs.length === 0 && isAsyncFunctionLike(variable as unknown as TSESTree.Node)) {
        return getAsyncBindingInfo(variable as unknown as TSESTree.Node);
      }

      return { isAsync: false, hasInternalErrorHandling: false };
    }
    scope = scope.upper;
  }

  return { isAsync: false, hasInternalErrorHandling: false };
}

function isLocallyAsyncCallee(
  node: TSESTree.CallExpression,
  context: Readonly<Parameters<ReturnType<typeof createRule>['create']>[0]>,
): AsyncBindingInfo {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    const info = isIdentifierBoundToAsyncFunction(node.callee, context);
    if (info.isAsync) {
      return info;
    }
  }

  if (
    (node.callee.type === AST_NODE_TYPES.FunctionExpression ||
      node.callee.type === AST_NODE_TYPES.ArrowFunctionExpression) &&
    node.callee.async
  ) {
    return {
      isAsync: true,
      hasInternalErrorHandling:
        node.callee.body.type === AST_NODE_TYPES.BlockStatement
          ? nodeHasCatchClause(node.callee.body)
          : false,
    };
  }

  return { isAsync: false, hasInternalErrorHandling: false };
}

function isKnownPromiseFactoryCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return KNOWN_PROMISE_FACTORIES.has(node.callee.name);
  }

  if (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === 'Promise' &&
    node.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return PROMISE_STATIC_METHODS.has(node.callee.property.name);
  }

  return false;
}

function getParserServices(
  context: Readonly<Parameters<ReturnType<typeof createRule>['create']>[0]>,
): ParserServicesLike | null {
  const services = context.sourceCode.parserServices as unknown;
  if (!services || typeof services !== 'object') {
    return null;
  }

  return services as ParserServicesLike;
}

function isPromiseLikeByTypeInfo(
  node: TSESTree.CallExpression,
  context: Readonly<Parameters<ReturnType<typeof createRule>['create']>[0]>,
): boolean {
  const services = getParserServices(context);
  if (!services?.program || !services.esTreeNodeToTSNodeMap) {
    return false;
  }

  try {
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    if (!tsNode) {
      return false;
    }

    const checker = services.program.getTypeChecker();
    const type = checker.getTypeAtLocation(tsNode);

    if (typeof checker.getPromisedTypeOfPromise === 'function') {
      if (checker.getPromisedTypeOfPromise(type)) {
        return true;
      }
    }

    const text = checker.typeToString(type).toLowerCase();
    return (
      text === 'promise' ||
      text.includes('promise<') ||
      text.includes('promiselike<') ||
      text.includes('thenable')
    );
  } catch {
    return false;
  }
}

/**
 * Check if the ExpressionStatement is already handled:
 * - Used as argument to .then() or .catch()
 * - Inside an await
 * - Piped to void
 * - Result is assigned
 */
function isExpressionHandled(node: TSESTree.ExpressionStatement): boolean {
  const expr = node.expression;

  // Check if the expression is a call chained with .then() or .catch()
  if (expr.type === AST_NODE_TYPES.CallExpression) {
    if (expr.callee.type === AST_NODE_TYPES.MemberExpression) {
      const prop = expr.callee.property;
      if (prop.type === AST_NODE_TYPES.Identifier) {
        if (prop.name === 'then' || prop.name === 'catch' || prop.name === 'finally') {
          return true;
        }
      }
    }
  }

  // void operator suppresses the warning intentionally
  if (expr.type === AST_NODE_TYPES.UnaryExpression && expr.operator === 'void') {
    return true;
  }

  return false;
}

export const noFloatingPromise = createRule({
  name: 'no-floating-promise',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow calling an async function or Promise-returning function without awaiting or handling the result. AI tools frequently generate floating promises where errors disappear silently. Includes a safe autofix that marks intentional fire-and-forget calls with void.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      floatingPromise:
        'This async call is not awaited, returned, or error-handled (.catch). AI tools frequently generate floating promises, causing errors to be silently lost. Add `await`, `.catch()`, or assign the result.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // Check ExpressionStatements — standalone call expressions
      ExpressionStatement(node) {
        if (
          node.expression.type === AST_NODE_TYPES.NewExpression &&
          node.expression.callee.type === AST_NODE_TYPES.Identifier &&
          node.expression.callee.name === 'Promise'
        ) {
          context.report({
            node,
            messageId: 'floatingPromise',
            fix: (fixer) =>
              fixer.replaceText(
                node.expression,
                `void ${context.sourceCode.getText(node.expression)}`
              ),
          });
          return;
        }

        // We only care about bare CallExpression statements
        if (node.expression.type !== AST_NODE_TYPES.CallExpression) {
          return;
        }

        // If it's already chained with .then()/.catch() or wrapped in void, skip
        if (isExpressionHandled(node)) {
          return;
        }

        const callExpr = node.expression;
        const localAsyncInfo = isLocallyAsyncCallee(callExpr, context);

        // If a local async helper already contains its own try/catch,
        // calling it fire-and-forget is often intentional in UI effects.
        if (localAsyncInfo.isAsync && localAsyncInfo.hasInternalErrorHandling) {
          return;
        }

        if (
          localAsyncInfo.isAsync ||
          isKnownPromiseFactoryCall(callExpr) ||
          isPromiseLikeByTypeInfo(callExpr, context)
        ) {
          context.report({
            node,
            messageId: 'floatingPromise',
            fix: (fixer) =>
              fixer.replaceText(
                node.expression,
                `void ${context.sourceCode.getText(node.expression)}`
              ),
          });
        }
      },
    };
  },
});

export default noFloatingPromise;
