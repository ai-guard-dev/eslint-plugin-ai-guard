import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

// ─── Safe internal file patterns ─────────────────────────────────────────────
// Files where authorization checks may be intentionally omitted (e.g., public
// endpoints, health checks, internal tooling).

const INTERNAL_FILE_PATTERNS = [
  /[\\/]electron[\\/]/i, /[\\/]electron-main/i, /\bpreload\.js$/, /\bbackground\.js$/,
  /[\\/]scripts[\\/]/i, /[\\/]migrations?[\\/]/i, /[\\/]seeds?[\\/]/i,
  /[\\/]debug[\\/]/i, /\bseed\./i, /\bmigrat(?:e|ion)\./i, /\bsetup\./i,
  /[\\/]scaffold[\\/]/i, /\btest[-_].*\.js$/i, /[\\/]__tests__[\\/]/i,
  /[\\/]test[\\/]/i, /[\\/]tests[\\/]/i, /\.(spec|test)\./i,
  /[\\/]fixtures[\\/]/i, /\bmock/i, /\bstub/i,
];

// ─── Authorization helper function names ─────────────────────────────────────
// Functions that typically perform authorization checks.

const AUTHZ_HELPER_NAMES = [
  'checkPermission', 'checkAuth', 'authorize', 'authorizeRequest',
  'hasPermission', 'canAccess', 'isAuthorized', 'verifyAccess',
  'ensureAuthorized', 'requireAuth', 'requirePermission',
] as const;

// ─── Resource ID access patterns ─────────────────────────────────────────────
// Patterns that suggest access to a resource identifier (e.g., req.params.id).

function isLikelyResourceIdPath(path: string[] | null): boolean {
  if (!path || path.length < 2) return false;
  const joined = path.join('.');
  // req.params.id, ctx.params.id, request.params.slug, etc.
  if (path[0] === 'req' || path[0] === 'ctx' || path[0] === 'request') {
    if (path[1] === 'params' || path[1] === 'query') return true;
  }
  // req.user.id, ctx.state.user.id, etc.
  if (joined.includes('user') && (joined.includes('id') || joined.includes('Id'))) return true;
  return false;
}

function isReqUserPath(path: string[] | null): boolean {
  if (!path) return false;
  if (path[0] === 'req' && path[1] === 'user') return true;
  if (path[0] === 'ctx' && path[1] === 'state' && path[2] === 'user') return true;
  if (path[0] === 'request' && path[1] === 'user') return true;
  return false;
}

function getMemberPath(node: TSESTree.Node): string[] | null {
  const parts: string[] = [];
  let current: TSESTree.Node | undefined = node;

  while (current) {
    if (current.type === AST_NODE_TYPES.MemberExpression) {
      if (current.property.type === AST_NODE_TYPES.Identifier) {
        parts.unshift(current.property.name);
      } else {
        return null;
      }
      current = current.object;
    } else if (current.type === AST_NODE_TYPES.Identifier) {
      parts.unshift(current.name);
      return parts;
    } else {
      return null;
    }
  }

  return null;
}

// ─── Rule implementation ─────────────────────────────────────────────────────

export interface RuleOptions {
  ignoreInternalFiles?: boolean;
  ignoreTestFiles?: boolean;
}

export const requireAuthzCheck = createRule<[RuleOptions], 'missingAuthzCheck'>({
  name: 'require-authz-check',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require authorization checks in route handlers that access resource identifiers. AI tools frequently generate CRUD routes without permission checks, creating IDOR vulnerabilities.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignoreInternalFiles: {
            type: 'boolean',
            description: 'Skip files matching internal file patterns (scripts, migrations, tests). Default: true.',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description: 'Skip test files (*.spec.ts, *.test.ts, __tests__/). Default: true.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingAuthzCheck:
        'Route handler accesses a resource identifier (e.g., req.params.id) without an authorization check. This may be an IDOR vulnerability. Add a permission check (e.g., checkPermission(), authorize()) before accessing the resource.',
    },
  },
  defaultOptions: [{ ignoreInternalFiles: true, ignoreTestFiles: true }],
  create(context, [options]) {
    const { ignoreInternalFiles = true, ignoreTestFiles = true } = options;

    const filename = context.filename ?? context.getFilename?.() ?? '';

    // Check if this is an internal file
    if (ignoreInternalFiles && INTERNAL_FILE_PATTERNS.some((p) => p.test(filename))) {
      return {};
    }

    // Check if this is a test file
    if (ignoreTestFiles && /\.(spec|test)\./.test(filename)) {
      return {};
    }

    // NOTE: containsAuthorizationHelper was removed as part of the H8 fix.
    // The authorization helper check is now inlined in collectBodySignals to
    // avoid O(n²) traversal.

    function collectBodySignals(node: TSESTree.Node): { hasResourceIdAccess: boolean; hasOwnershipCheck: boolean; hasAuthzHelper: boolean } {
      let hasResourceIdAccess = false;
      let hasOwnershipCheck = false;
      let hasAuthzHelper = false;

      const walk = (current: TSESTree.Node): void => {
        if (
          current.type === AST_NODE_TYPES.BinaryExpression &&
          ['===', '==', '!==', '!='].includes(current.operator)
        ) {
          const leftPath = getMemberPath(current.left);
          const rightPath = getMemberPath(current.right);

          const leftIsUser = isReqUserPath(leftPath);
          const rightIsUser = isReqUserPath(rightPath);
          const leftIsResource = isLikelyResourceIdPath(leftPath);
          const rightIsResource = isLikelyResourceIdPath(rightPath);

          if ((leftIsUser && rightIsResource) || (rightIsUser && leftIsResource)) {
            hasOwnershipCheck = true;
          }
        }

        if (current.type === AST_NODE_TYPES.MemberExpression) {
          const path = getMemberPath(current);
          if (isLikelyResourceIdPath(path)) {
            hasResourceIdAccess = true;
          }
        }

        if (
          current.type === AST_NODE_TYPES.CallExpression &&
          current.callee.type === AST_NODE_TYPES.Identifier &&
          AUTHZ_HELPER_NAMES.includes(current.callee.name as (typeof AUTHZ_HELPER_NAMES)[number])
        ) {
          hasAuthzHelper = true;
        }

        if (
          current.type === AST_NODE_TYPES.CallExpression &&
          current.callee.type === AST_NODE_TYPES.MemberExpression &&
          current.callee.property.type === AST_NODE_TYPES.Identifier &&
          AUTHZ_HELPER_NAMES.includes(current.callee.property.name as (typeof AUTHZ_HELPER_NAMES)[number])
        ) {
          hasAuthzHelper = true;
        }

        // Don't traverse into nested functions
        if (
          current.type === AST_NODE_TYPES.FunctionDeclaration ||
          current.type === AST_NODE_TYPES.FunctionExpression ||
          current.type === AST_NODE_TYPES.ArrowFunctionExpression
        ) {
          return;
        }

        // Recurse into children
        for (const child of (current as unknown as Record<string, unknown[]>)['body'] ?? []) {
          if (child && typeof child === 'object' && 'type' in child) {
            walk(child as TSESTree.Node);
          }
        }
      };

      if (node.type === AST_NODE_TYPES.BlockStatement) {
        for (const stmt of node.body) {
          walk(stmt);
        }
      } else {
        walk(node);
      }

      return { hasResourceIdAccess, hasOwnershipCheck, hasAuthzHelper };
    }

    function isRouteHandler(node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression): boolean {
      const funcName = node.id?.name ?? '';
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(funcName)) {
        return true;
      }
      if (funcName.startsWith('handle') || funcName.startsWith('on')) {
        return true;
      }
      return false;
    }

    return {
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(
        node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression,
      ) {
        if (!isRouteHandler(node)) return;

        if (!node.body) return;

        if (node.body.type === AST_NODE_TYPES.BlockStatement) {
          const signals = collectBodySignals(node.body);
          if (signals.hasResourceIdAccess && !signals.hasAuthzHelper && !signals.hasOwnershipCheck) {
            context.report({
              node,
              messageId: 'missingAuthzCheck',
            });
          }
        }
      },
    };
  },
});

export default requireAuthzCheck;