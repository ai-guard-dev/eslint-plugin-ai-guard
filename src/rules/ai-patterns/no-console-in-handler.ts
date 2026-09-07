import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

// ─── Schema options ─────────────────────────────────────────────────────────

export interface ConsoleInHandlerOptions {
  /**
   * Object names that are considered structured loggers and should be allowed
   * inside route handlers. Default: ['logger', 'log', 'winston', 'pino',
   * 'bunyan', 'console_log', 'appLogger', 'requestLogger'].
   */
  allowedLoggers?: string[];
  /**
   * console methods that are allowed inside route handlers.
   * Default: ['warn', 'error'] — console.warn and console.error are
   * legitimate in handlers; AI tools leave console.log and console.debug.
   */
  allowedConsoleMethods?: string[];
}

const DEFAULT_ALLOWED_LOGGERS = new Set([
  'logger', 'log', 'winston', 'pino', 'bunyan',
  'appLogger', 'requestLogger', 'req.log', 'res.log',
]);

// console.warn and console.error are legitimate in handlers
// AI tools specifically leave console.log and console.debug
const DEFAULT_ALLOWED_CONSOLE_METHODS = new Set(['warn', 'error']);

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

/**
 * Check if a call is to an allowed structured logger.
 * Matches: logger.info(), log.error(), pino.warn(), req.log.info(), etc.
 */
function isAllowedLoggerCall(
  node: TSESTree.CallExpression,
  allowedLoggers: Set<string>,
): boolean {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    node.callee.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  const obj = node.callee.object;

  // Direct logger calls: logger.info(), pino.error()
  if (obj.type === AST_NODE_TYPES.Identifier && allowedLoggers.has(obj.name)) {
    return true;
  }

  // Nested logger calls: req.log.info(), res.log.warn()
  if (
    obj.type === AST_NODE_TYPES.MemberExpression &&
    obj.object.type === AST_NODE_TYPES.Identifier &&
    obj.property.type === AST_NODE_TYPES.Identifier
  ) {
    const chain = `${obj.object.name}.${obj.property.name}`;
    if (allowedLoggers.has(chain)) {
      return true;
    }
  }

  return false;
}

function traverseForConsoleCalls(
  node: TSESTree.Node,
  onConsoleCall: (callNode: TSESTree.CallExpression) => void,
  allowedLoggers: Set<string>,
  allowedConsoleMethods: Set<string>,
): void {
  if (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression
  ) {
    const callee = node.callee;

    // Skip calls to allowed structured loggers
    if (isAllowedLoggerCall(node, allowedLoggers)) {
      // Not a console call — skip entirely (don't report)
    } else if (
      callee.object.type === AST_NODE_TYPES.Identifier &&
      callee.object.name === 'console' &&
      callee.property.type === AST_NODE_TYPES.Identifier
    ) {
      const method = callee.property.name;
      // Only flag if the console method is NOT in the allowed list
      if (!allowedConsoleMethods.has(method)) {
        onConsoleCall(node);
      }
    }
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
          traverseForConsoleCalls(child as TSESTree.Node, onConsoleCall, allowedLoggers, allowedConsoleMethods);
        }
      }
      continue;
    }

    if (value && typeof value === 'object' && 'type' in value) {
      traverseForConsoleCalls(value as TSESTree.Node, onConsoleCall, allowedLoggers, allowedConsoleMethods);
    }
  }
}

export const noConsoleInHandler = createRule<[ConsoleInHandlerOptions], 'noConsoleInHandler' | 'removeConsoleCall'>({
  name: 'no-console-in-handler',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow console.log/debug inside route handlers. AI tools frequently leave debug logs in request handlers. Structured loggers (winston, pino, etc.) and console.warn/error are allowed by default.',
    },
    fixable: undefined,
    hasSuggestions: true,
    schema: [
      {
        type: 'object',
        properties: {
          allowedLoggers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Object names considered structured loggers (allowed in handlers). Default includes logger, log, winston, pino, bunyan.',
          },
          allowedConsoleMethods: {
            type: 'array',
            items: { type: 'string' },
            description: 'console methods allowed in handlers. Default: ["warn", "error"]. Only console.log and console.debug are flagged by default.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noConsoleInHandler:
        'Avoid console.log/debug inside route handlers. AI tools frequently leave debug statements in handlers. Use a structured logger (winston, pino, etc.) or console.warn/error instead.',
      removeConsoleCall:
        'Remove this console statement from the route handler.',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const allowedLoggers = new Set([
      ...DEFAULT_ALLOWED_LOGGERS,
      ...(options.allowedLoggers ?? []),
    ]);
    const allowedConsoleMethods = new Set([
      ...DEFAULT_ALLOWED_CONSOLE_METHODS,
      ...(options.allowedConsoleMethods ?? []),
    ]);

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
            // Expression-body arrow function: (req, res) => console.log('test')
            // Traverse the expression body for console calls (M6)
            traverseForConsoleCalls(argument.body, (callNode) => {
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
            }, allowedLoggers, allowedConsoleMethods);
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
            }, allowedLoggers, allowedConsoleMethods);
          }
        }
      },
    };
  },
});

export default noConsoleInHandler;
