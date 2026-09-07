import { ruleTester } from '../helpers/rule-tester';
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