# no-silent-fallback

**Category:** Reliability | **Severity:** `warn` (recommended, security), `error` (strict) | **Confidence:** medium

---

## What it does

Flags fallbacks that hide a failure until it causes a worse one:

1. **Hardcoded fallbacks for secret env vars**: `process.env.JWT_SECRET || 'secret'`, `?? 'changeme'`, `const { SESSION_SECRET = 'dev' } = process.env`, and `process.env.X ? process.env.X : 'literal'`.
2. **Catch blocks that turn a failed awaited call into empty data**: `try { return await db.orders.findMany() } catch { return [] }`.

## Why it matters

AI tools add both patterns to make code run without setup or to make an error go away:

- If `JWT_SECRET` is missing in production, the app does not fail at startup. It signs tokens with `'secret'`, a value anyone can read in the repository, so anyone can forge a session. `'keyboard cat'` (the express-session README value) shows up in production for the same reason.
- `catch { return [] }` makes "the database is down" look like "you have no orders". Nothing is logged, the UI shows an empty state, and the outage is found by users.

`no-hardcoded-secret` does not catch the first case, because the value is a fallback rather than a plain literal assignment.

## ❌ Bad

```ts
const secret = process.env.JWT_SECRET || 'secret';
app.use(session({ secret: process.env.SESSION_SECRET || 'keyboard cat' }));
const { ENCRYPTION_KEY = 'changeme' } = process.env;

export async function getOrders(userId: string) {
  try {
    return await db.order.findMany({ where: { userId } });
  } catch {
    return [];
  }
}
```

## ✅ Good

```ts
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is not set');

export async function getOrders(userId: string) {
  try {
    return await db.order.findMany({ where: { userId } });
  } catch (err) {
    throw new Error(`Loading orders for ${userId} failed`, { cause: err });
  }
}
```

## What it does not flag

| Pattern | Why |
|---|---|
| `process.env.PORT \|\| '3000'`, `process.env.DATABASE_URL \|\| 'postgres://localhost/dev'` | Not secrets; a wrong value fails loudly |
| `process.env.JWT_EXPIRES_IN \|\| '7d'`, `SESSION_SECRET_TTL`, `API_KEY_HEADER`, `BCRYPT_SALT_ROUNDS` | The last word describes a setting of the secret, not the secret |
| `process.env.STRIPE_SECRET_KEY ?? ''` | Empty strings satisfy the type checker and fail at first use |
| `process.env.NODE_ENV === 'production' ? process.env.JWT_SECRET : 'dev-secret'`, fallbacks inside `if (process.env.NODE_ENV !== 'production')` or `isDev ? …` | The fallback is limited to development |
| `try { return JSON.parse(raw) } catch { return [] }` | No `await` in the `try`: a safe-parse helper, not hidden I/O |
| `catch { return false }` after `await fs.access(p)` | Existence checks return booleans by design |
| A catch that logs, rethrows, returns a non-empty default, or contains a comment | The fallback is handled or documented |
| Tests, seed scripts, mocks, `vitest.config.*` / `jest.setup.*` | Throwaway values belong there |

## How to fix

- **Secrets:** validate required env vars once at startup and fail fast. A schema (`zod`, `envalid`, `@t3-oss/env-nextjs`) does this for all of them at once.
- **Catch blocks:** log the error with context and rethrow, or return an explicit result such as `{ ok: false, error }` that the caller has to handle. If an empty result really is the intended behaviour, say so in a comment in the catch block; the rule then stays quiet.

## Configuration

This rule has no options.

```js
rules: {
  'ai-guard/no-silent-fallback': 'warn',
}
```
