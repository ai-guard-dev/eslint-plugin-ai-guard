# require-auth-middleware

**Category:** Security | **Severity:** `warn` (recommended, security), `error` (strict)

---

## What it does

Flags Express and Fastify route definitions (`router.get`, `app.post`, `fastify.delete`, …) where no recognized authentication middleware runs before the route handler.

**Route receivers** recognized: `app`, `router`, `fastify`, `server`, names containing `router` (`adminRouter`) or ending in `routes` (`userRoutes`), and `express.Router()` chains. Generic names such as `api` or `client` are ignored because they are usually HTTP clients (`api.get('/users', config)`).

**Auth middleware** is recognized when it appears between the path and the handler as:

| Shape | Example |
|---|---|
| Identifier | `router.get('/me', requireAuth, handler)` |
| Call | `passport.authenticate('jwt')`, `authorize('admin')` |
| Member reference | `fastify.authenticate`, `auth.required` (but not `auth.optional`) |
| Array | `router.post('/x', [requireAuth, validate], handler)` |
| Fastify route options | `{ onRequest: [fastify.authenticate] }` — also `preParsing`, `preValidation`, `preHandler` |

Default names: `authenticate`, `requireAuth`, `isAuthenticated`, `verifyToken`, `protect`, `authorized`, `authorize`, `isAdmin`, `ensureAuthenticated`, `ensureLoggedIn`, `auth`, `authMiddleware`, `requireLogin`, `checkAuth`, `validateToken`, `passport.authenticate`, `jwt`, `requireSession`, plus anything in `authMiddlewareNames`.

**Router-level auth** registered *before* a route covers it:

- `router.use(protect)` — every later route on `router`
- `router.use('/admin', protect)` — later routes whose path is `/admin` or starts with `/admin/` (not `/administrators`)
- `fastify.addHook('onRequest', fastify.authenticate)` — every later route on `fastify` (also `preParsing`, `preValidation`, `preHandler`)

Auth is tracked per receiver name, so `adminRouter.use(auth)` does not cover `publicRouter`. Routes registered *before* the `use()` call are still reported, matching Express ordering.

**Public routes** are skipped by their first path segment, after removing an `/api`, `/api/vN` or `/vN` prefix and a file extension. Matching is segment-exact: `/auth/login`, `/api/v1/health` and `/favicon.ico` are public; `/authors/:id`, `/publications` and `/devices/:id` are not.

Public segments: health and probes (`health`, `healthz`, `healthcheck`, `health-check`, `ping`, `status`, `metrics`, `ready`, `readyz`, `readiness`, `live`, `livez`, `liveness`), auth flows (`auth`, `oauth`, `login`, `logout`, `signin`, `sign-in`, `signout`, `sign-out`, `register`, `signup`, `sign-up`, `forgot`, `forgot-password`, `reset`, `reset-password`, `password-reset`, `verify`, `verify-email`, `callback`), `webhook(s)`, static files (`public`, `assets`, `static`, `favicon`, `robots`, `sitemap`, `.well-known`), docs (`docs`, `api-docs`, `swagger`, `openapi`) and `graphql`, plus `/`, `*` and `/*`.

`/debug`, `/diagnostics`, `/internal` and `/dev` routes are **not** treated as public: an unauthenticated debug or internal endpoint in a production router is exactly what this rule should surface. Files that are internal tooling (dev servers, scripts, migrations, seeds, Electron main/preload) are skipped at the file level instead.

## Why it matters

AI tools generate route handlers focused on the business logic — the CRUD operations, the database queries, the response formatting. The authentication middleware is a separate concern that often gets omitted, especially when the AI is generating a new route based on an existing pattern that didn't show the full middleware chain.

The result is endpoints that are fully functional but completely unauthenticated. Anyone with a browser or `curl` can access them.

## ❌ Bad Example

```typescript
// No auth middleware — anyone can access this endpoint
router.get('/users/:id/profile', async (req, res) => {
  const user = await User.findById(req.params.id);
  res.json(user);
});

// No auth on sensitive admin route
app.post('/admin/delete-user', async (req, res) => {
  await User.deleteById(req.body.userId);
  res.json({ success: true });
});
```

## ✅ Good Example

```typescript
// Auth middleware comes before the handler
router.get('/users/:id/profile', authenticate, async (req, res) => {
  const user = await User.findById(req.params.id);
  res.json(user);
});

// Multiple middleware — auth first
app.post('/admin/delete-user',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {
    await User.deleteById(req.body.userId);
    res.json({ success: true });
  }
);

// Using a router-level middleware (also ok)
const adminRouter = express.Router();
adminRouter.use(requireAuth); // applies to all routes below
adminRouter.post('/delete-user', async (req, res) => { /* ... */ });
```

## How to fix

Add your authentication middleware before the route handler, or register it on the router with `router.use(auth)` / `fastify.addHook('onRequest', …)` before the routes it should cover. If your middleware has a project-specific name, add it to `authMiddlewareNames` instead of disabling the rule.

## Configuration

```js
rules: {
  'ai-guard/require-auth-middleware': ['warn', {
    // Extra names recognized as auth middleware (identifiers, callees,
    // member properties, or dotted names such as 'session.require')
    authMiddlewareNames: ['myCustomAuth'],
    // Skip Electron main/preload files (default: true)
    allowElectronApps: true,
    // Skip scripts/, tools/, migrations/, seeds/, dev-server files (default: true)
    allowInternalScripts: true,
    // Extra file-path regular expressions (case-insensitive) to skip
    internalPathPatterns: ['[\\\\/]admin-cli[\\\\/]'],
  }],
}
```

An invalid `internalPathPatterns` entry fails with an error that names the rule, the option and the offending pattern.

## Limitations

- Analysis is per file. A router mounted elsewhere behind auth (`app.use('/admin', requireAuth, adminRouter)` in another file) is not visible; protect the router itself with `router.use(requireAuth)` or suppress with a reason.
- Fastify plugin encapsulation is not modeled: an auth hook registered on `fastify` inside one plugin function is treated as covering later `fastify.*` routes in the same file.
- `fastify.route({ method, url, handler })` declarations are not checked.
- Auth is recognized by name. A middleware called `protect` that does not authenticate is still trusted.
