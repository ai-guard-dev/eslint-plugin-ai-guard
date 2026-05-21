import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/**
 * HTTP methods that define routes in Express/Fastify.
 */
const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head',
]);

/**
 * Default authentication middleware names to look for.
 */
const DEFAULT_AUTH_MIDDLEWARE_NAMES = new Set([
  'authenticate',
  'requireAuth',
  'isAuthenticated',
  'verifyToken',
  'protect',
  'authorized',
  'authorize',
  'isAdmin',
  'ensureAuthenticated',
  'ensureLoggedIn',
  'auth',
  'authMiddleware',
  'requireLogin',
  'checkAuth',
  'validateToken',
  'passport.authenticate',
  'jwt',
  'requireSession',
]);

/**
 * Route paths that are commonly public and should not require auth.
 */
const PUBLIC_ROUTE_PATTERNS = [
  /^\/?$/,                           // '/' root
  /^\*$/,                            // '*' SPA fallback
  /^\/\*$/,                         // '/*' SPA fallback
  /^\/health/,                       // health checks
  /^\/ping/,                         // ping
  /^\/status/,                       // status
  /^\/api\/v\d+\/auth/,              // auth routes
  /^\/auth/,                         // auth routes
  /^\/login/,                        // login
  /^\/register/,                     // register
  /^\/signup/,                       // signup
  /^\/forgot/,                       // forgot password
  /^\/reset/,                        // reset password
  /^\/webhook/,                      // webhooks
  /^\/callback/,                     // OAuth callback
  /^\/public/,                       // explicitly public
  /^\/assets/,                       // static assets
  /^\/static/,                       // static files
  /^\/favicon/,                      // favicon
  /^\/robots/,                       // robots.txt
  /^\/sitemap/,                      // sitemap
  /^\/api\/docs/,                    // API documentation (Swagger, etc.)
  /^\/docs/,                         // documentation
];

export const requireAuthMiddleware = createRule({
  name: 'require-auth-middleware',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require authentication middleware on Express/Fastify route definitions. AI tools frequently generate route handlers without auth middleware, creating unprotected endpoints that expose sensitive data or operations.',
    },
    fixable: undefined,
    schema: [
      {
        type: 'object',
        properties: {
          authMiddlewareNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional custom middleware names to recognize as authentication middleware.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingAuth:
        'Route `{{method}} {{path}}` appears to have no authentication middleware. AI tools frequently generate routes without auth checks, creating unprotected endpoints. Add authentication middleware (e.g., `protect`, `authenticate`) to the handler chain.',
    },
  },
  defaultOptions: [{}] as [{ authMiddlewareNames?: string[] }],
  create(context, [options]) {
    const customNames = new Set(options.authMiddlewareNames ?? []);
    const allAuthNames = new Set([...DEFAULT_AUTH_MIDDLEWARE_NAMES, ...customNames]);

    // Track if router.use(protect) is applied (route-level auth covers all subsequent routes)
    let hasRouterUseAuth = false;

    return {
      CallExpression(node) {
        // Detect router.use(protect) or app.use(protect) — blanket auth
        if (isRouterUseAuth(node, allAuthNames)) {
          hasRouterUseAuth = true;
          return;
        }

        // Check for: router.get('/path', handler) or app.post('/path', handler)
        if (!isRouteDefinition(node)) return;

        // If a blanket router.use(auth) was already applied, skip
        if (hasRouterUseAuth) return;

        const callee = node.callee as TSESTree.MemberExpression;
        const method = (callee.property as TSESTree.Identifier).name;
        const args = node.arguments;

        // First argument should be the route path
        if (args.length < 2) return;
        const pathArg = args[0];
        const pathStr = getPathString(pathArg);

        // Skip public routes
        if (pathStr && isPublicRoute(pathStr)) return;

        // Check if any argument (between path and final handler) is an auth middleware
        const middlewareArgs = args.slice(1, -1); // Exclude path and final handler

        // If only path + handler (no middleware at all)
        if (middlewareArgs.length === 0 && args.length === 2) {
          context.report({
            node,
            messageId: 'missingAuth',
            data: {
              method: method.toUpperCase(),
              path: pathStr || '<dynamic>',
            },
          });
          return;
        }

        // Check if any middleware in the chain is an auth middleware
        const hasAuth = middlewareArgs.some((arg) => isAuthMiddleware(arg, allAuthNames));

        if (!hasAuth) {
          context.report({
            node,
            messageId: 'missingAuth',
            data: {
              method: method.toUpperCase(),
              path: pathStr || '<dynamic>',
            },
          });
        }
      },
    };
  },
});

function isRouteDefinition(node: TSESTree.CallExpression): boolean {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return false;
  if (node.callee.property.type !== AST_NODE_TYPES.Identifier) return false;

  const methodName = node.callee.property.name;
  if (!HTTP_METHODS.has(methodName)) return false;

  // The object should be a router/app-like identifier
  const obj = node.callee.object;
  if (obj.type === AST_NODE_TYPES.Identifier) {
    const name = obj.name.toLowerCase();
    return name === 'router' || name === 'app' || name.includes('router');
  }
  // Also handle: express.Router() chains
  if (obj.type === AST_NODE_TYPES.CallExpression) return true;

  return false;
}

function isRouterUseAuth(node: TSESTree.CallExpression, authNames: Set<string>): boolean {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return false;
  if (node.callee.property.type !== AST_NODE_TYPES.Identifier) return false;
  if (node.callee.property.name !== 'use') return false;

  // Check if any argument is an auth middleware
  return node.arguments.some((arg) => isAuthMiddleware(arg, authNames));
}

function isAuthMiddleware(node: TSESTree.Node, authNames: Set<string>): boolean {
  // Direct identifier: protect, authenticate, etc.
  if (node.type === AST_NODE_TYPES.Identifier) {
    return authNames.has(node.name);
  }

  // Fastify-style options object: { preHandler: authenticate, onRequest: verifyToken }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    for (const prop of node.properties) {
      if (
        prop.type === AST_NODE_TYPES.Property &&
        prop.key.type === AST_NODE_TYPES.Identifier &&
        (prop.key.name === 'preHandler' || prop.key.name === 'onRequest')
      ) {
        if (isAuthMiddleware(prop.value, authNames)) return true;
      }
    }
  }

  // Call expression: authenticate('jwt'), authorize('admin')
  if (node.type === AST_NODE_TYPES.CallExpression) {
    if (node.callee.type === AST_NODE_TYPES.Identifier) {
      return authNames.has(node.callee.name);
    }
    // passport.authenticate(...)
    if (
      node.callee.type === AST_NODE_TYPES.MemberExpression &&
      node.callee.object.type === AST_NODE_TYPES.Identifier &&
      node.callee.property.type === AST_NODE_TYPES.Identifier
    ) {
      const fullName = `${node.callee.object.name}.${node.callee.property.name}`;
      return authNames.has(fullName) || authNames.has(node.callee.property.name);
    }
  }

  return false;
}

function getPathString(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral) {
    // If it has no expressions, just return the only quasi
    if (node.expressions.length === 0 && node.quasis.length === 1) {
      return node.quasis[0].value.cooked ?? null;
    }
    // If it has expressions (e.g., `/webhook/${dynamic}`), return the first literal part
    if (node.quasis.length > 0) {
      return node.quasis[0].value.cooked ?? null;
    }
  }
  return null;
}

function isPublicRoute(pathStr: string): boolean {
  return PUBLIC_ROUTE_PATTERNS.some((pattern) => pattern.test(pathStr));
}

export default requireAuthMiddleware;
