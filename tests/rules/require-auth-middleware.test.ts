import { ruleTester } from '../helpers/rule-tester';
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { requireAuthMiddleware } from '../../src/rules/security/require-auth-middleware';

ruleTester.run('require-auth-middleware', requireAuthMiddleware, {
  valid: [
    // 1. Has protect middleware
    {
      code: `router.post('/api/data', protect, validate, handler);`,
    },
    // 2. Has authenticate middleware
    {
      code: `app.get('/api/users', authenticate, getUser);`,
    },
    // 3. Has passport.authenticate
    {
      code: `router.get('/profile', passport.authenticate('jwt', { session: false }), getProfile);`,
    },
    // 4. Public route - login
    {
      code: `router.post('/login', loginHandler);`,
    },
    // 5. Public route - webhook (dynamic path)
    {
      code: 'router.post(`/webhook/${provider}`, webhookHandler);',
    },
    // 6. Root route - often public
    {
      code: `app.get('/', homeHandler);`,
    },
    // 7. Health check
    {
      code: `router.get('/health', (req, res) => res.send('OK'));`,
    },
    // 8. Custom middleware name (via options)
    {
      code: `router.post('/secret', myCustomAuth, handler);`,
      options: [{ authMiddlewareNames: ['myCustomAuth'] }],
    },
    // 9. router.use() blanket auth
    {
      code: `
        router.use(protect);
        router.get('/data', handler);
        router.post('/data', handler);
      `,
    },
    // 10. express.Router() usage with auth
    {
      code: `
        const router = express.Router();
        router.put('/update', requireAuth, updateHandler);
      `,
    },
    // 11. SPA fallback wildcard route should be considered public
    {
      code: `app.get('*', serveFrontend);`,
    },
    // 12. Wildcard slash fallback route should be considered public
    {
      code: `app.get('/*', serveFrontend);`,
    },
    // 13. Fastify-style routes with preHandler auth
    {
      code: `fastify.get('/api/users', { preHandler: authenticate }, handler);`,
    },
    // 14. POST to /callback — typical OAuth callback, treat as public
    {
      code: `router.post('/callback', oauthCallbackHandler);`,
    },
    // 15. Route to /api/docs — documentation endpoint, often public
    {
      code: `app.get('/api/docs', serveSwagger);`,
    },
  ],
  invalid: [
    // 1. Basic route with no middleware at all
    {
      code: `router.post('/api/users', createUser);`,
      errors: [{ messageId: 'missingAuth' }],
    },
    // 2. Route with non-auth middleware
    {
      code: `app.get('/api/admin', validateInput, getAdmin);`,
      errors: [{ messageId: 'missingAuth' }],
    },
    // 3. put/patch/delete needs auth
    {
      code: `router.delete('/delete/:id', deleteHandler);`,
      errors: [{ messageId: 'missingAuth' }],
    },
    // 4. Custom middleware not in options
    {
      code: `router.post('/secret', customAuthCheck, handler);`,
      errors: [{ messageId: 'missingAuth' }],
    },
    // 5. express.Router chain without auth
    {
      code: `
        express.Router()
          .get('/dashboard', renderDashboard);
      `,
      errors: [{ messageId: 'missingAuth' }],
    },
    // 6. Route missing auth, even with multiple valid middlewares
    {
      code: `router.post('/data', logRequest, parseBody, validateSchema, processData);`,
      errors: [{ messageId: 'missingAuth' }],
    },
    // 7. Route containing a function name that looks like auth but isn't middleware
    {
      code: `router.get('/data', (req, res) => { const user = authenticate(req); res.send(user); });`,
      errors: [{ messageId: 'missingAuth' }], // 'authenticate' is inside handler, not as middleware
    },
    // 8. Route with only body parser middleware (not auth)
    {
      code: `router.get('/admin/users', bodyParser.json(), listUsers);`,
      errors: [{ messageId: 'missingAuth' }],
    },
    // 9. PATCH route without auth (common AI-generated mistake)
    {
      code: `router.patch('/users/:id', updateUser);`,
      errors: [{ messageId: 'missingAuth' }],
    },
  ],
});

// ─── C3 Regression: router state leak across router instances ───────────────

ruleTester.run('require-auth-middleware (C3: per-router auth tracking)', requireAuthMiddleware, {
  valid: [
    // Router A has auth -- routes on router A should not be reported
    {
      code: `
        const adminRouter = express.Router();
        adminRouter.use(authMiddleware);
        adminRouter.get('/admin', adminHandler);
        adminRouter.post('/admin', createAdmin);
      `,
    },
    // Single router with use(auth) -- existing behavior preserved
    {
      code: `
        router.use(protect);
        router.get('/data', handler);
        router.post('/data', handler);
      `,
    },
  ],
  invalid: [
    // Router B has NO auth -- routes on router B MUST still be reported
    // even when router A has auth (the old bug leaked auth state globally)
    {
      code: `
        const adminRouter = express.Router();
        adminRouter.use(authMiddleware);
        adminRouter.get('/admin', adminHandler);

        const publicRouter = express.Router();
        publicRouter.get('/api/data', publicHandler);
      `,
      errors: [{ messageId: 'missingAuth' }],
    },
    // Two separate routers -- neither has auth, both should be reported
    {
      code: `
        const routerA = express.Router();
        routerA.get('/a', handlerA);

        const routerB = express.Router();
        routerB.get('/b', handlerB);
      `,
      errors: [
        { messageId: 'missingAuth' },
        { messageId: 'missingAuth' },
      ],
    },
  ],
});
// ─── Public-route matching is segment-exact, not prefix-based ────────────────

ruleTester.run('require-auth-middleware (public route segments)', requireAuthMiddleware, {
  valid: [
    // Versioned / prefixed public routes
    { code: `router.get('/api/health', healthHandler);` },
    { code: `router.post('/api/v1/login', loginHandler);` },
    { code: `app.post('/v2/auth/refresh', refreshHandler);` },
    { code: `app.get('/healthz', probe);` },
    { code: `router.post('/reset-password', resetPassword);` },
    { code: `app.get('/favicon.ico', serveIcon);` },
    { code: `app.get('/.well-known/openid-configuration', serveOidc);` },
    // Nested segment under a public root
    { code: `router.post('/auth/login', loginHandler);` },
  ],
  invalid: [
    // Lookalikes: the old prefix match treated these as public
    { code: `router.get('/authors/:id', getAuthor);`, errors: [{ messageId: 'missingAuth' }] },
    { code: `router.delete('/publications/:id', deletePublication);`, errors: [{ messageId: 'missingAuth' }] },
    { code: `router.put('/devices/:id', updateDevice);`, errors: [{ messageId: 'missingAuth' }] },
    { code: `router.post('/livestreams', createStream);`, errors: [{ messageId: 'missingAuth' }] },
    { code: `router.get('/statuses/:id', getStatus);`, errors: [{ messageId: 'missingAuth' }] },
    // Debug/internal endpoints in a production router are not public
    { code: `app.get('/debug/env', dumpEnv);`, errors: [{ messageId: 'missingAuth' }] },
    { code: `router.post('/internal/users/:id/promote', promoteUser);`, errors: [{ messageId: 'missingAuth' }] },
    // A public word deeper in the path does not make the route public
    { code: `router.get('/api/users/health', getUserHealth);`, errors: [{ messageId: 'missingAuth' }] },
    // API index is not a known public route
    { code: `app.get('/api/v1', apiIndex);`, errors: [{ messageId: 'missingAuth' }] },
  ],
});

// ─── Fastify routes, hooks and member/array middleware ───────────────────────

ruleTester.run('require-auth-middleware (Fastify and middleware shapes)', requireAuthMiddleware, {
  valid: [
    // Canonical @fastify/jwt pattern
    { code: `fastify.get('/me', { onRequest: [fastify.authenticate] }, handler);` },
    { code: `app.post('/orders', { preHandler: app.authenticate }, createOrder);` },
    { code: `server.delete('/items/:id', { preValidation: [verifyToken] }, removeItem);` },
    // Blanket Fastify hook
    {
      code: `
        fastify.addHook('onRequest', fastify.authenticate);
        fastify.get('/orders', listOrders);
      `,
    },
    // Express middleware array
    { code: `router.post('/orders', [requireAuth, validateOrder], createOrder);` },
    // Member-expression middleware
    { code: `router.get('/orders', auth.required, listOrders);` },
    { code: `router.get('/orders', passport.authenticate, listOrders);` },
    // Prefix-scoped router.use covers routes under that prefix
    {
      code: `
        router.use('/admin', protect);
        router.get('/admin/users', listUsers);
        router.get('/admin', adminHome);
      `,
    },
    // Router name ending in "Routes"
    { code: `userRoutes.get('/users', requireAuth, listUsers);` },
    // HTTP clients are not routers
    { code: `api.get('/users', { params: { page: 2 } });` },
    { code: `client.post('/orders', payload);` },
  ],
  invalid: [
    // Fastify route without auth
    { code: `fastify.get('/orders', async (request, reply) => listOrders());`, errors: [{ messageId: 'missingAuth' }] },
    // Fastify options without an auth hook
    { code: `fastify.post('/orders', { schema: orderSchema }, createOrder);`, errors: [{ messageId: 'missingAuth' }] },
    // addHook with a non-auth hook function
    {
      code: `
        fastify.addHook('onRequest', logRequest);
        fastify.get('/orders', listOrders);
      `,
      errors: [{ messageId: 'missingAuth' }],
    },
    // auth.optional lets anonymous requests through
    { code: `router.delete('/orders/:id', auth.optional, deleteOrder);`, errors: [{ messageId: 'missingAuth' }] },
    // Middleware array without auth
    { code: `router.post('/orders', [validateOrder, rateLimit], createOrder);`, errors: [{ messageId: 'missingAuth' }] },
    // Prefix-scoped auth does not cover sibling routes
    {
      code: `
        router.use('/admin', protect);
        router.get('/administrators', listAdmins);
        router.delete('/users/:id', deleteUser);
      `,
      errors: [{ messageId: 'missingAuth' }, { messageId: 'missingAuth' }],
    },
    // Auth registered AFTER a route does not protect it (Express ordering)
    {
      code: `
        router.get('/orders', listOrders);
        router.use(protect);
      `,
      errors: [{ messageId: 'missingAuth' }],
    },
    { code: `userRoutes.delete('/users/:id', deleteUser);`, errors: [{ messageId: 'missingAuth' }] },
  ],
});

// ─── Option validation ───────────────────────────────────────────────────────

describe('require-auth-middleware option validation', () => {
  it('reports an invalid internalPathPatterns regex with the rule and option name', () => {
    const linter = new Linter({ configType: 'flat' });
    expect(() =>
      linter.verify(
        `router.get('/orders', listOrders);`,
        [
          {
            plugins: { guard: { rules: { 'require-auth-middleware': requireAuthMiddleware } } },
            rules: { 'guard/require-auth-middleware': ['error', { internalPathPatterns: ['('] }] },
          },
        ] as unknown as Linter.Config[],
        'src/routes.js',
      ),
    ).toThrow(/require-auth-middleware: invalid regular expression in "internalPathPatterns": "\("/);
  });
});
