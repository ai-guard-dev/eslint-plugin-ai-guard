import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import path from 'path';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

// ─── Framework file patterns ────────────────────────────────────────────────
// Files where async-without-await is a framework convention, not a mistake.
// Next.js App Router, middleware, and page conventions.

const FRAMEWORK_FILE_PATTERNS = [
  // Next.js App Router
  /[/\\]route\.(ts|js|tsx|jsx)$/,
  /[/\\]middleware\.(ts|js)$/,
  /[/\\]layout\.(tsx|jsx|ts|js)$/,
  /[/\\]page\.(tsx|jsx|ts|js)$/,
  /[/\\]loading\.(tsx|jsx|ts|js)$/,
  /[/\\]error\.(tsx|jsx|ts|js)$/,
  /[/\\]not-found\.(tsx|jsx|ts|js)$/,
  /[/\\]template\.(tsx|jsx|ts|js)$/,
  // Next.js Pages Router conventions
  /[/\\]_app\.(tsx|jsx)$/,
  /[/\\]_document\.(tsx|jsx)$/,
];

// HTTP method export names — always valid async in route files
const HTTP_METHOD_EXPORTS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

// React UI file extensions — handle* functions are conventionally async
const REACT_FILE_EXTENSIONS = new Set(['.tsx', '.jsx']);

// Names that strongly suggest the function is an event handler by convention
const HANDLER_NAME_REGEX = /^(handle|on[A-Z])/;

// Names that suggest the function is middleware or a lifecycle hook
const MIDDLEWARE_NAME_REGEX = /^(use[A-Z]|middleware|interceptor|guard|beforeEach|afterEach)/;

// ─── Heuristics ─────────────────────────────────────────────────────────────

function containsAwaitExpression(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.AwaitExpression) {
    return true;
  }

  if (node.type === AST_NODE_TYPES.ForOfStatement && node.await) {
    return true;
  }

  // Do not count await expressions inside nested functions.
  if (
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return false;
  }

  const entries = Object.entries(node) as Array<[string, unknown]>;
  for (const [key, value] of entries) {
    if (key === 'parent') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          if (containsAwaitExpression(child as TSESTree.Node)) {
            return true;
          }
        }
      }
      continue;
    }

    if (value && typeof value === 'object' && 'type' in value) {
      if (containsAwaitExpression(value as TSESTree.Node)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if the function body is a single return statement that directly
 * calls a function (pass-through wrapper pattern).
 * Example: async function wrap() { return someApi(); }
 * These are intentionally async for Promise propagation — low-confidence finding.
 */
function isPassThroughWrapper(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): boolean {
  if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
    // Arrow with expression body: async () => foo() — pass-through
    const body = node.body;
    if (
      body.type === AST_NODE_TYPES.CallExpression ||
      body.type === AST_NODE_TYPES.MemberExpression
    ) {
      return true;
    }
    return false;
  }

  if (node.body.body.length !== 1) return false;
  const only = node.body.body[0];
  if (only.type !== AST_NODE_TYPES.ReturnStatement) return false;
  if (!only.argument) return false;

  // Return of a call expression — likely pass-through
  return only.argument.type === AST_NODE_TYPES.CallExpression;
}

/**
 * Check if this is a framework-required async export.
 * Next.js App Router requires GET/POST/etc handlers to be async even if they
 * use synchronous APIs internally.
 */
function isFunctionExportedWithHttpMethodName(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): boolean {
  // Named function declaration: export async function GET() {}
  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id) {
    return HTTP_METHOD_EXPORTS.has(node.id.name);
  }

  // Variable declaration: export const GET = async () => {}
  if (node.parent?.type === AST_NODE_TYPES.VariableDeclarator) {
    const declarator = node.parent;
    if (
      declarator.id.type === AST_NODE_TYPES.Identifier &&
      HTTP_METHOD_EXPORTS.has(declarator.id.name)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Get the function name for heuristic checks.
 */
function getFunctionName(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): string | null {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id) {
    return node.id.name;
  }

  if (node.parent?.type === AST_NODE_TYPES.VariableDeclarator) {
    const declarator = node.parent;
    if (declarator.id.type === AST_NODE_TYPES.Identifier) {
      return declarator.id.name;
    }
  }

  if (
    node.parent?.type === AST_NODE_TYPES.Property ||
    node.parent?.type === AST_NODE_TYPES.MethodDefinition
  ) {
    const parent = node.parent;
    if (
      'key' in parent &&
      parent.key.type === AST_NODE_TYPES.Identifier
    ) {
      return parent.key.name;
    }
  }

  return null;
}

// ─── Schema options ───────────────────────────────────────────────────────────

export interface RuleOptions {
  allowedFunctionNames?: string[];
  frameworkFiles?: string[];
  ignorePassThroughWrappers?: boolean;
  ignoreHandlerFunctions?: boolean;
}

export const noAsyncWithoutAwait = createRule<[RuleOptions], 'asyncWithoutAwait' | 'asyncPassThrough'>({
  name: 'no-async-without-await',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow async functions that never use await. AI tools frequently add async by default, creating misleading signatures and unnecessary Promise wrappers. Framework-specific async conventions (Next.js route handlers, React event handlers) are excluded.',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          allowedFunctionNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional function names to skip (on top of HTTP methods)',
          },
          frameworkFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional file glob patterns where async-without-await is allowed',
          },
          ignorePassThroughWrappers: {
            type: 'boolean',
            description: 'Downgrade (not suppress) pass-through wrappers. Default: true.',
          },
          ignoreHandlerFunctions: {
            type: 'boolean',
            description: 'Skip functions named handle* or on* in .tsx/.jsx files. Default: true.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      asyncWithoutAwait:
        'Async function does not contain `await`. AI tools frequently add `async` unnecessarily, which can mislead callers and mask intent. Remove `async` or add proper await logic.',
      asyncPassThrough:
        'Async pass-through wrapper — this may be intentional for Promise propagation. Consider whether `async` is needed here.',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const {
      allowedFunctionNames = [],
      ignorePassThroughWrappers = true,
      ignoreHandlerFunctions = true,
    } = options;

    // All HTTP methods + user-provided names are always skipped
    const skipNames = new Set([...HTTP_METHOD_EXPORTS, ...allowedFunctionNames]);

    // Check if we're in a framework file (suppress entirely)
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const fileExt = path.extname(filename).toLowerCase();

    const isFrameworkFile = FRAMEWORK_FILE_PATTERNS.some((pattern) => pattern.test(filename));
    const isReactFile = REACT_FILE_EXTENSIONS.has(fileExt);

    function buildSafeAutofix(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression,
    ): ((fixer: TSESLint.RuleFixer) => TSESLint.RuleFix | null) | undefined {
      const sourceCode = context.sourceCode;

      if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
        const exprText = sourceCode.getText(node.body);
        return (fixer) => fixer.replaceText(node.body, `await (${exprText})`);
      }

      if (node.body.body.length !== 1) {
        return undefined;
      }

      const onlyStatement = node.body.body[0];

      if (
        onlyStatement.type === AST_NODE_TYPES.ReturnStatement &&
        onlyStatement.argument &&
        onlyStatement.argument.type !== AST_NODE_TYPES.AwaitExpression
      ) {
        const returnValueText = sourceCode.getText(onlyStatement.argument);
        return (fixer) =>
          fixer.replaceText(onlyStatement.argument as TSESTree.Node, `await (${returnValueText})`);
      }

      if (onlyStatement.type === AST_NODE_TYPES.ExpressionStatement) {
        const exprText = sourceCode.getText(onlyStatement.expression);
        return (fixer) =>
          fixer.replaceText(onlyStatement.expression as TSESTree.Node, `await (${exprText})`);
      }

      return undefined;
    }

    function reportIfNeeded(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression
    ): void {
      if (!node.async) {
        return;
      }

      // 1. Framework file suppression — entirely skip
      if (isFrameworkFile) {
        return;
      }

      // 2. HTTP method export suppression — GET/POST/etc are always async by convention
      if (isFunctionExportedWithHttpMethodName(node)) {
        return;
      }

      // 3. Function name suppression
      const funcName = getFunctionName(node);
      if (funcName && skipNames.has(funcName)) {
        return;
      }

      // 4. Middleware/lifecycle names — often async by convention
      if (funcName && MIDDLEWARE_NAME_REGEX.test(funcName)) {
        return;
      }

      // 5. React handler functions in .tsx/.jsx — handle* and on* are async by convention
      if (ignoreHandlerFunctions && isReactFile && funcName && HANDLER_NAME_REGEX.test(funcName)) {
        return;
      }

      // Check for await
      const bodyHasAwait =
        node.body.type === AST_NODE_TYPES.BlockStatement
          ? containsAwaitExpression(node.body)
          : node.body.type === AST_NODE_TYPES.AwaitExpression;

      if (bodyHasAwait) {
        return;
      }

      // 6. Pass-through wrapper — downgrade severity to informational, not a full error
      if (ignorePassThroughWrappers && isPassThroughWrapper(node)) {
        context.report({
          node,
          messageId: 'asyncPassThrough',
          // No autofix for pass-through — it's intentional
        });
        return;
      }

      // Arrow with non-block body that is not an AwaitExpression
      if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
        if (node.body.type !== AST_NODE_TYPES.AwaitExpression) {
          const fix = buildSafeAutofix(node);
          context.report({
            node,
            messageId: 'asyncWithoutAwait',
            fix,
          });
        }
        return;
      }

      // Block body with no await
      const fix = buildSafeAutofix(node);
      context.report({
        node,
        messageId: 'asyncWithoutAwait',
        fix,
      });
    }

    return {
      FunctionDeclaration: reportIfNeeded,
      FunctionExpression: reportIfNeeded,
      ArrowFunctionExpression: reportIfNeeded,
    };
  },
});

export default noAsyncWithoutAwait;
