import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const AUTHZ_HELPER_NAMES = [
  'authorize',
  'authorise',
  'checkOwnership',
  'ensureOwner',
  'isOwner',
  'canAccess',
  'canModify',
  'hasAccess',
] as const;

// ─── Context detection (shared with require-auth-middleware) ──────────────────
const ELECTRON_PATH_PATTERNS = [
  /[\\/]electron[\\/]/i, /[\\/]electron-main/i, /preload\.js$/, /background\.js$/,
];
const INTERNAL_SCRIPT_PATTERNS = [
  /[\\/]scripts[\\/]/i, /[\\/]migrations?[\\/]/i, /[\\/]seeds?[\\/]/i,
  /[\\/]debug[\\/]/i, /seed\./i, /migrate?\./i, /setup\./i,
];
function isElectronOrInternalFile(filePath: string): boolean {
  return (
    ELECTRON_PATH_PATTERNS.some((p) => p.test(filePath)) ||
    INTERNAL_SCRIPT_PATTERNS.some((p) => p.test(filePath))
  );
}

function isRouteRegistrationCall(node: TSESTree.CallExpression): boolean {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    node.callee.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  if (!ROUTE_METHODS.includes(node.callee.property.name as (typeof ROUTE_METHODS)[number])) {
    return false;
  }

  const firstArg = node.arguments[0];
  if (!firstArg) {
    return false;
  }

  return (
    (firstArg.type === AST_NODE_TYPES.Literal && typeof firstArg.value === 'string') ||
    (firstArg.type === AST_NODE_TYPES.TemplateLiteral && firstArg.expressions.length === 0)
  );
}

function getStaticPathArg(node: TSESTree.CallExpression): string | null {
  const firstArg = node.arguments[0];
  if (!firstArg) return null;

  if (firstArg.type === AST_NODE_TYPES.Literal && typeof firstArg.value === 'string') {
    return firstArg.value;
  }

  if (firstArg.type === AST_NODE_TYPES.TemplateLiteral && firstArg.expressions.length === 0) {
    return firstArg.quasis[0]?.value.cooked ?? null;
  }

  return null;
}

function getMemberPath(node: TSESTree.Node): string[] | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return [node.name];
  }

  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return null;
  }

  const objectPath = getMemberPath(node.object);
  if (!objectPath) {
    return null;
  }

  if (node.property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  return [...objectPath, node.property.name];
}

function hasPathPrefix(path: string[] | null, prefix: readonly string[]): boolean {
  if (!path || path.length < prefix.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i += 1) {
    if (path[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

function isLikelyResourceIdPath(path: string[] | null): boolean {
  if (!path || path.length < 3) {
    return false;
  }

  if (!hasPathPrefix(path, ['req', 'params']) && !hasPathPrefix(path, ['req', 'body']) && !hasPathPrefix(path, ['req', 'query'])) {
    return false;
  }

  const last = path[path.length - 1].toLowerCase();
  return last === 'id' || last.endsWith('id');
}

function isReqUserPath(path: string[] | null): boolean {
  return hasPathPrefix(path, ['req', 'user']);
}

function containsAuthorizationHelper(node: TSESTree.Node): boolean {
  if (
    node.type === AST_NODE_TYPES.CallExpression &&
    ((node.callee.type === AST_NODE_TYPES.Identifier &&
      AUTHZ_HELPER_NAMES.includes(node.callee.name as (typeof AUTHZ_HELPER_NAMES)[number])) ||
      (node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.property.type === AST_NODE_TYPES.Identifier &&
        AUTHZ_HELPER_NAMES.includes(node.callee.property.name as (typeof AUTHZ_HELPER_NAMES)[number])))
  ) {
    return true;
  }

  const entries = Object.entries(node) as Array<[string, unknown]>;
  for (const [key, value] of entries) {
    if (key === 'parent') continue;

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          if (containsAuthorizationHelper(child as TSESTree.Node)) return true;
        }
      }
      continue;
    }

    if (value && typeof value === 'object' && 'type' in value) {
      if (containsAuthorizationHelper(value as TSESTree.Node)) return true;
    }
  }

  return false;
}

function collectBodySignals(node: TSESTree.Node): { hasResourceIdAccess: boolean; hasOwnershipCheck: boolean } {
  let hasResourceIdAccess = false;
  let hasOwnershipCheck = false;

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

    if (containsAuthorizationHelper(current)) {
      hasOwnershipCheck = true;
    }

    const entries = Object.entries(current) as Array<[string, unknown]>;
    for (const [key, value] of entries) {
      if (key === 'parent') continue;

      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && 'type' in child) {
            walk(child as TSESTree.Node);
          }
        }
        continue;
      }

      if (value && typeof value === 'object' && 'type' in value) {
        walk(value as TSESTree.Node);
      }
    }
  };

  walk(node);

  return { hasResourceIdAccess, hasOwnershipCheck };
}

export const requireAuthzCheck = createRule({
  name: 'require-authz-check',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require a visible authorization/ownership check when route handlers access resource identifiers (e.g., req.params.id). AI tools often add auth middleware but forget per-resource authorization checks.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      missingAuthz:
        'Handler accesses resource identifiers (e.g., req.params.id) without a visible authorization check. Verify ownership or permission is enforced before the resource is returned or modified.',
    },
  },
  defaultOptions: [],
  create(context) {
    // Suppress in Electron/internal files — auth is not relevant in these contexts
    const filePath = context.filename ?? context.getFilename?.() ?? '';
    if (isElectronOrInternalFile(filePath)) return {};

    return {
      CallExpression(node) {
        if (!isRouteRegistrationCall(node)) {
          return;
        }

        const routePath = getStaticPathArg(node);
        const hasRouteIdParam = typeof routePath === 'string' && routePath.includes(':');

        for (const arg of node.arguments) {
          if (
            arg.type !== AST_NODE_TYPES.FunctionExpression &&
            arg.type !== AST_NODE_TYPES.ArrowFunctionExpression
          ) {
            continue;
          }

          if (arg.body.type !== AST_NODE_TYPES.BlockStatement) {
            continue;
          }

          const signals = collectBodySignals(arg.body);
          const isSensitive = hasRouteIdParam && signals.hasResourceIdAccess;

          if (isSensitive && !signals.hasOwnershipCheck) {
            context.report({
              node: arg,
              messageId: 'missingAuthz',
            });
          }
        }
      },
    };
  },
});

export default requireAuthzCheck;
