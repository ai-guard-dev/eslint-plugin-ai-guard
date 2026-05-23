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
  /^\/?\s*$/,                        // '/' root or empty
  /^\*$/,                            // '*' SPA fallback
  /^\/\*$/,                          // '/*' SPA fallback
  /^\/health/,                       // health checks
  /^\/ping/,                         // ping
  /^\/status/,                       // status
  /^\/metrics/,                      // Prometheus metrics
  /^\/ready/,                        // readiness probe
  /^\/live/,                         // liveness probe
  /^\/api\/v\d+\/auth/,              // versioned auth routes
  /^\/auth/,                         // auth routes
  /^\/login/,                        // login
  /^\/logout/,                       // logout
  /^\/register/,                     // register
  /^\/signup/,                       // signup
  /^\/forgot/,                       // forgot password
  /^\/reset/,                        // reset password
  /^\/verify/,                       // email verification
  /^\/webhook/,                      // webhooks (typically verified by signature)
  /^\/callback/,                     // OAuth callback
  /^\/public/,                       // explicitly public
  /^\/assets/,                       // static assets
  /^\/static/,                       // static files
  /^\/favicon/,                      // favicon
  /^\/robots/,                       // robots.txt
  /^\/sitemap/,                      // sitemap
  /^\/api\/docs/,                    // API documentation (Swagger, etc.)
  /^\/docs/,                         // documentation
  /^\/swagger/,                      // Swagger UI
  /^\/graphql/,                      // GraphQL (handles own auth)
  /^\/debug/,                        // debug endpoints
  /^\/diagnostics/,                  // diagnostics endpoints
  /^\/internal/,                     // internal routes
  /^\/dev/,                          // dev-only routes
];

// ─── Context detection helpers ─────────────────────────────────────────────────
//
// These heuristics determine whether the current file is likely an internal
// or localhost-only service where auth requirements are different from a
// production API. False positives in these contexts erode trust.

/**
 * Path segments that suggest an Electron app main/preload/renderer process.
 * In Electron apps, localhost routes serve the renderer — auth is unnecessary.
 */
const ELECTRON_PATH_PATTERNS = [
  /[\\/]electron[\\/]/i,
  /[\\/]electron-main/i,
  /[\\/]electron-preload/i,
  /\bmain\.js$/,
  /\bpreload\.js$/,
  /\bbackground\.js$/,
  /\belectron\.js$/,
];

/**
 * File name patterns for internal tooling, scripts, and dev utilities.
 * These files are never exposed in production — auth is not relevant.
 */
const INTERNAL_SCRIPT_PATTERNS = [
  /[\\/]scripts[\\/]/i,
  /[\\/]tools[\\/]/i,
  /[\\/]migrations?[\\/]/i,
  /[\\/]seeds?[\\/]/i,
  /[\\/]fixtures[\\/]/i,
  /[\\/]dev[\\/]/i,
  /[\\/]debug[\\/]/i,
  /[\\/]diagnostics[\\/]/i,
  /\bdebug[-_]server/i,
  /\bdev[-_]server/i,
  /\bcheck[-_]server/i,
  /\blocal[-_]server/i,
  /\bseed\./i,
  /\bmigrate?\./i,
  /\bsetup\./i,
  /\bscaffold\./i,
  /\binit\./i,
  /\bbootstrap\./i,
];

function isElectronFile(filePath: string): boolean {
  return ELECTRON_PATH_PATTERNS.some((p) => p.test(filePath));
}

function isInternalScript(filePath: string): boolean {
  return INTERNAL_SCRIPT_PATTERNS.some((p) => p.test(filePath));
}

// ─── Rule ─────────────────────────────────────────────────────────────────────

export const requireAuthMiddleware = createRule({
  name: 'require-auth-middleware',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require authentication middleware on Express/Fastify route definitions. AI tools frequently generate route handlers without auth middleware, creating unprotected endpoints.',
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
          allowElectronApps: {
            type: 'boolean',
            description: 'Suppress findings in Electron main/preload files (default: true). Electron localhost routes do not need web auth middleware.',
          },
          allowInternalScripts: {
            type: 'boolean',
            description: 'Suppress findings in internal tooling files (migration, seed, debug, dev-server). These are never production-exposed (default: true).',
          },
          internalPathPatterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional file path patterns to treat as internal (suppressed).',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingAuth:
        'Route `{{method}} {{path}}` appears to lack authentication middleware. Verify that auth is applied at the router level, or add middleware (e.g., `protect`, `authenticate`) to the handler chain.',
    },
  },
  defaultOptions: [{}] as [
    {
      authMiddlewareNames?: string[];
      allowElectronApps?: boolean;
      allowInternalScripts?: boolean;
      internalPathPatterns?: string[];
    }
  ],
  create(context, [options]) {
    const allowElectronApps = options.allowElectronApps !== false; // default true
    const allowInternalScripts = options.allowInternalScripts !== false; // default true
    const customNames = new Set(options.authMiddlewareNames ?? []);
    const allAuthNames = new Set([...DEFAULT_AUTH_MIDDLEWARE_NAMES, ...customNames]);
    const extraPatterns = (options.internalPathPatterns ?? []).map((p) => new RegExp(p, 'i'));

    const filePath = context.filename ?? context.getFilename?.() ?? '';

    // ── File-level context suppression ─────────────────────────────────────
    // Suppress entirely for files that are known non-production contexts.
    // This eliminates the most common false-positive sources without any
    // AST analysis overhead.

    if (allowElectronApps && isElectronFile(filePath)) {
      return {}; // Electron main/preload — localhost routes don't need web auth
    }

    if (allowInternalScripts && isInternalScript(filePath)) {
      return {}; // Internal tooling — not production-exposed
    }

    if (extraPatterns.some((p) => p.test(filePath))) {
      return {}; // User-defined internal path
    }

    // ── Route analysis ────────────────────────────────────────────────────

    // Track if router.use(protect) is applied (blanket auth covers all subsequent routes)
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
    if (node.expressions.length === 0 && node.quasis.length === 1) {
      return node.quasis[0].value.cooked ?? null;
    }
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
