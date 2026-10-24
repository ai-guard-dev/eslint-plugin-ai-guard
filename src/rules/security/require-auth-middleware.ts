import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
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
 * First path segments that are commonly public and should not require auth.
 *
 * Matching is segment-exact (after stripping an `/api`, `/api/vN` or `/vN`
 * prefix and a file extension), so `/auth/login` and `/api/v1/health` are
 * public while `/authors`, `/publications` and `/devices/:id` are not.
 *
 * Debug, diagnostics, internal and dev routes are deliberately NOT listed:
 * an unauthenticated `/debug` or `/internal` endpoint in a production router
 * is exactly the gap this rule exists to catch. Files that are internal
 * tooling are suppressed at the file level instead (see INTERNAL_SCRIPT_PATTERNS).
 */
const PUBLIC_ROUTE_SEGMENTS = new Set([
  // health / probes
  'health', 'healthz', 'healthcheck', 'health-check', 'ping', 'status', 'metrics',
  'ready', 'readyz', 'readiness', 'live', 'livez', 'liveness',
  // authentication flows
  'auth', 'oauth', 'login', 'logout', 'signin', 'sign-in', 'signout', 'sign-out',
  'register', 'signup', 'sign-up', 'forgot', 'forgot-password', 'reset',
  'reset-password', 'password-reset', 'verify', 'verify-email', 'callback',
  // webhooks (typically verified by signature)
  'webhook', 'webhooks',
  // static and well-known files
  'public', 'assets', 'static', 'favicon', 'robots', 'sitemap', '.well-known',
  // API documentation
  'docs', 'api-docs', 'swagger', 'openapi',
  // GraphQL endpoints handle auth in resolvers/context
  'graphql',
]);

/** `/api`, `/api/v2`, `/v1` — stripped before matching the first segment. */
const API_PREFIX_PATTERN = /^\/(?:api(?:\/v\d+)?|v\d+)(?=\/|$)/i;

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
    const extraPatterns = (options.internalPathPatterns ?? []).map(compileInternalPathPattern);

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

    // Track blanket auth per router object (router.use(protect),
    // fastify.addHook('onRequest', fastify.authenticate)).
    // Key = router variable name. Value = 'all' when auth covers every later
    // route on that router, or the mount prefixes it covers
    // (router.use('/admin', protect)). Keying by name prevents auth state
    // leaking across different router instances.
    const routerAuthScopes = new Map<string, 'all' | string[]>();

    function recordBlanketAuth(routerName: string, prefix: string | null): void {
      const existing = routerAuthScopes.get(routerName);
      if (existing === 'all') return;
      const normalized = prefix === null ? '' : normalizeMountPrefix(prefix);
      if (normalized === '') {
        routerAuthScopes.set(routerName, 'all');
        return;
      }
      routerAuthScopes.set(routerName, [...(existing ?? []), normalized]);
    }

    function isCoveredByBlanketAuth(routerName: string | null, pathStr: string | null): boolean {
      if (!routerName) return false;
      const scope = routerAuthScopes.get(routerName);
      if (!scope) return false;
      if (scope === 'all') return true;
      // Dynamic path on a router with prefix-scoped auth: we cannot tell which
      // prefix applies, so stay silent rather than guess.
      if (pathStr === null) return true;
      return scope.some((prefix) => pathStr === prefix || pathStr.startsWith(`${prefix}/`));
    }

    return {
      CallExpression(node) {
        // router.use(protect) / router.use('/admin', protect) — blanket auth
        const blanket = getBlanketAuth(node, allAuthNames);
        if (blanket) {
          const routerName = getRouterObjectName(node);
          if (routerName) {
            recordBlanketAuth(routerName, blanket.prefix);
          }
          return;
        }

        // Check for: router.get('/path', handler) or app.post('/path', handler)
        if (!isRouteDefinition(node)) return;

        const callee = node.callee as TSESTree.MemberExpression;
        const method = (callee.property as TSESTree.Identifier).name;
        const args = node.arguments;

        // First argument should be the route path
        if (args.length < 2) return;
        const pathArg = args[0];
        const pathStr = getPathString(pathArg);

        // Skip routes covered by router-level auth registered earlier
        if (isCoveredByBlanketAuth(getRouterObjectName(node), pathStr)) return;

        // Skip public routes
        if (pathStr && isPublicRoute(pathStr)) return;

        // Check if any argument between the path and the final handler is an
        // auth middleware. For Fastify this includes the route options object.
        const middlewareArgs = args.slice(1, -1);
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

/**
 * Compile a user-supplied `internalPathPatterns` entry. An invalid regular
 * expression becomes an error that names the rule and option instead of a
 * bare SyntaxError from deep inside the lint run.
 */
function compileInternalPathPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ai-guard/require-auth-middleware: invalid regular expression in "internalPathPatterns": ${JSON.stringify(pattern)} (${reason})`,
    );
  }
}

/**
 * Receivers that register HTTP routes: `app`, `router`, `fastify`, `server`,
 * and names containing `router` or ending in `routes` (`adminRouter`,
 * `userRoutes`). Generic names such as `api` or `client` are excluded because
 * they are usually HTTP clients (`api.get('/users', config)`).
 */
function isRouterLikeName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'app' ||
    lower === 'router' ||
    lower === 'fastify' ||
    lower === 'server' ||
    lower.includes('router') ||
    lower.endsWith('routes')
  );
}

function isRouteDefinition(node: TSESTree.CallExpression): boolean {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return false;
  if (node.callee.property.type !== AST_NODE_TYPES.Identifier) return false;

  const methodName = node.callee.property.name;
  if (!HTTP_METHODS.has(methodName)) return false;

  // The object should be a router/app-like identifier
  const obj = node.callee.object;
  if (obj.type === AST_NODE_TYPES.Identifier) {
    return isRouterLikeName(obj.name);
  }
  // Also handle: express.Router() chains
  if (obj.type === AST_NODE_TYPES.CallExpression) return true;

  return false;
}

/** Fastify lifecycle hooks that run before the handler and can enforce auth. */
const FASTIFY_AUTH_HOOKS = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler']);

/**
 * Detect router-level auth:
 *   router.use(protect)                                → { prefix: null }
 *   router.use('/admin', protect)                      → { prefix: '/admin' }
 *   fastify.addHook('onRequest', fastify.authenticate) → { prefix: null }
 */
function getBlanketAuth(
  node: TSESTree.CallExpression,
  authNames: Set<string>,
): { prefix: string | null } | null {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return null;
  if (node.callee.property.type !== AST_NODE_TYPES.Identifier) return null;
  const method = node.callee.property.name;

  if (method === 'use') {
    if (!node.arguments.some((arg) => isAuthMiddleware(arg, authNames))) return null;
    const first = node.arguments[0];
    // A dynamic mount path cannot be scoped — treat it as covering the router.
    return { prefix: first ? getPathString(first) : null };
  }

  if (method === 'addHook') {
    const [hookName, hookFn] = node.arguments;
    if (
      hookName?.type === AST_NODE_TYPES.Literal &&
      typeof hookName.value === 'string' &&
      FASTIFY_AUTH_HOOKS.has(hookName.value) &&
      hookFn &&
      isAuthMiddleware(hookFn, authNames)
    ) {
      return { prefix: null };
    }
  }

  return null;
}

/** Strip trailing slashes so `/admin/` and `/admin` scope the same routes. */
function normalizeMountPrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '');
}

/**
 * Extract the variable name of the router/app object from a call expression
 * like `router.use(...)` or `app.get(...)`.
 *
 * Returns the identifier name (e.g., "router", "app", "adminRouter") or null
 * if the object is not a simple identifier (e.g., `express.Router().get(...)`).
 *
 * This is used to associate router.use(auth) with subsequent route definitions
 * on the same router, preventing auth state from leaking across routers.
 */
function getRouterObjectName(node: TSESTree.CallExpression): string | null {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return null;
  const obj = node.callee.object;
  if (obj.type === AST_NODE_TYPES.Identifier) {
    return obj.name;
  }
  // express.Router().use(...) — no simple name to track
  return null;
}

/**
 * Recognize a member reference as auth middleware:
 *   fastify.authenticate, app.verifyToken → property name is an auth name
 *   passport.authenticate                 → dotted name is an auth name
 *   auth.required, authMiddleware.jwt     → object name is an auth name
 * `auth.optional`-style references are excluded: they let anonymous
 * requests through.
 */
function isAuthMemberReference(node: TSESTree.MemberExpression, authNames: Set<string>): boolean {
  if (node.computed || node.property.type !== AST_NODE_TYPES.Identifier) return false;
  const propertyName = node.property.name;
  if (authNames.has(propertyName)) return true;

  if (node.object.type !== AST_NODE_TYPES.Identifier) return false;
  const objectName = node.object.name;
  if (authNames.has(`${objectName}.${propertyName}`)) return true;
  return authNames.has(objectName) && propertyName !== 'optional';
}

function isAuthMiddleware(node: TSESTree.Node, authNames: Set<string>): boolean {
  // Direct identifier: protect, authenticate, etc.
  if (node.type === AST_NODE_TYPES.Identifier) {
    return authNames.has(node.name);
  }

  // Member reference: fastify.authenticate, auth.required
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    return isAuthMemberReference(node, authNames);
  }

  // Middleware array: router.get('/x', [requireAuth, validate], handler)
  if (node.type === AST_NODE_TYPES.ArrayExpression) {
    return node.elements.some(
      (el) => el !== null && el.type !== AST_NODE_TYPES.SpreadElement && isAuthMiddleware(el, authNames),
    );
  }

  // Fastify-style options object: { preHandler: authenticate, onRequest: [fastify.authenticate] }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    for (const prop of node.properties) {
      if (
        prop.type === AST_NODE_TYPES.Property &&
        prop.key.type === AST_NODE_TYPES.Identifier &&
        FASTIFY_AUTH_HOOKS.has(prop.key.name)
      ) {
        if (isAuthMiddleware(prop.value, authNames)) return true;
      }
    }
  }

  // Call expression: authenticate('jwt'), authorize('admin'), passport.authenticate('jwt')
  if (node.type === AST_NODE_TYPES.CallExpression) {
    if (node.callee.type === AST_NODE_TYPES.Identifier) {
      return authNames.has(node.callee.name);
    }
    if (node.callee.type === AST_NODE_TYPES.MemberExpression) {
      return isAuthMemberReference(node.callee, authNames);
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
  const trimmed = pathStr.trim();
  // Root and SPA fallbacks
  if (trimmed === '' || trimmed === '/' || trimmed === '*' || trimmed === '/*') return true;

  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const rest = withSlash.replace(API_PREFIX_PATTERN, '');
  // `/api` or `/api/v1` on its own is an API index, not a known public route
  if (rest === '' || rest === '/') return false;

  const firstSegment = rest.slice(1).split('/')[0].toLowerCase();
  // favicon.ico → favicon, robots.txt → robots, openapi.json → openapi
  const baseName = firstSegment.replace(/\.[a-z0-9]+$/, '');
  return PUBLIC_ROUTE_SEGMENTS.has(firstSegment) || PUBLIC_ROUTE_SEGMENTS.has(baseName);
}

export default requireAuthMiddleware;
