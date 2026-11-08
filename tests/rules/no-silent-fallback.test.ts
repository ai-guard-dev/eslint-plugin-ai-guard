import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import { noSilentFallback } from '../../src/rules/reliability/no-silent-fallback';

ruleTester.run('no-silent-fallback', noSilentFallback, {
  valid: [
    // ── Env fallbacks that are not secrets ──
    'const port = process.env.PORT || "3000";',
    'const expiresIn = process.env.JWT_EXPIRES_IN || "7d";',
    'const ttl = process.env.SESSION_SECRET_TTL ?? "15m";',
    'const header = process.env.API_KEY_HEADER || "x-api-key";',
    'const issuer = process.env.JWT_ISSUER || "my-app";',
    'const rounds = process.env.BCRYPT_SALT_ROUNDS || "10";',
    'const db = process.env.DATABASE_URL || "postgres://localhost:5432/dev";',
    'const pk = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_123";',
    // Empty-string fallbacks satisfy the type checker and fail loudly at use
    'const key = process.env.OPENAI_API_KEY ?? "";',
    // Missing secrets that throw are the recommended pattern
    'const secret = process.env.JWT_SECRET; if (!secret) throw new Error("JWT_SECRET is not set");',
    'const secret = process.env.JWT_SECRET || requireEnv("JWT_SECRET");',
    // Dev-only fallbacks behind an environment check
    'const secret = process.env.NODE_ENV === "production" ? process.env.JWT_SECRET : "dev-secret";',
    'let secret; if (process.env.NODE_ENV !== "production") { secret = process.env.JWT_SECRET || "dev-secret"; }',
    'const secret = isDev ? process.env.SESSION_SECRET || "local-secret" : process.env.SESSION_SECRET;',
    'const secret = import.meta.env.DEV && (import.meta.env.VITE_DEMO_PASSWORD || "demo1234");',
    // Throwaway values in tests, seeds and test-runner config
    { code: 'const secret = process.env.JWT_SECRET || "test-secret";', filename: 'src/auth.test.ts' },
    { code: 'const password = process.env.ADMIN_PASSWORD || "admin123";', filename: 'prisma/seed.ts' },
    { code: 'process.env.JWT_SECRET = process.env.JWT_SECRET || "vitest-secret";', filename: 'vitest.config.ts' },

    // ── Catch blocks that are fine ──
    // Safe-parse helpers: no I/O, empty result is the documented contract
    'function parseTags(raw) { try { return JSON.parse(raw); } catch { return []; } }',
    // Existence checks return booleans by design
    'async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }',
    // The error is logged or rethrown
    'async function list() { try { return await db.users.findMany(); } catch (err) { logger.error(err); return []; } }',
    'async function list() { try { return await db.users.findMany(); } catch (err) { throw new Error("list failed", { cause: err }); } }',
    // A comment documents the deliberate fallback
    'async function recent() { try { return await cache.get("recent"); } catch { /* cache is optional; fall back to empty */ return []; } }',
    // The await belongs to a nested function, not to the try block
    'function register() { try { queue.on("job", async (j) => { await run(j); }); return {}; } catch { return {}; } }',
    // Returning a non-empty default is a value, not a silent empty result
    'async function config() { try { return await load(); } catch { return { retries: 3 }; } }',
    { code: 'async function f() { try { return await api(); } catch { return []; } }', filename: 'src/__mocks__/api.js' },
  ],
  invalid: [
    // ── Hardcoded secret fallbacks ──
    {
      code: 'const secret = process.env.JWT_SECRET || "secret";',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'JWT_SECRET', value: 'secret' } }],
    },
    {
      code: 'app.use(session({ secret: process.env.SESSION_SECRET || "keyboard cat" }));',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'SESSION_SECRET', value: 'keyboard cat' } }],
    },
    {
      code: 'const key = process.env.ENCRYPTION_KEY ?? "changeme";',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'ENCRYPTION_KEY', value: 'changeme' } }],
    },
    {
      code: 'const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "sk-proj-1234567890abcdefghijklmnop" });',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'OPENAI_API_KEY', value: 'sk-proj-1234567890abc...' } }],
    },
    {
      code: 'const pass = process.env.DB_PASSWORD || `postgres`;',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'DB_PASSWORD', value: 'postgres' } }],
    },
    {
      code: 'const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "ghp_example";',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'GITHUB_TOKEN', value: 'ghp_example' } }],
    },
    {
      code: "const secret = process.env['WEBHOOK_SECRET'] || 'whsec_dev';",
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'WEBHOOK_SECRET', value: 'whsec_dev' } }],
    },
    {
      code: 'const secret = process.env.JWT_SECRET ? process.env.JWT_SECRET : "dev-secret";',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'JWT_SECRET', value: 'dev-secret' } }],
    },
    {
      code: 'const { JWT_SECRET = "super-secret", PORT = "3000" } = process.env;',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'JWT_SECRET', value: 'super-secret' } }],
    },
    // An environment check in a different function does not guard this one
    {
      code: 'if (process.env.NODE_ENV === "development") { setup(); }\nfunction sign(p) { return jwt.sign(p, process.env.JWT_SECRET || "dev"); }',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'JWT_SECRET', value: 'dev' } }],
    },
    {
      code: 'export const config = { auth: { secret: process.env.NEXTAUTH_SECRET || "a-very-long-development-secret-value" } };',
      filename: 'src/config/default.js',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'NEXTAUTH_SECRET', value: 'a-very-long-developme...' } }],
    },

    // ── Swallowed failures ──
    {
      code: 'export async function getOrders(userId) {\n  try {\n    return await db.order.findMany({ where: { userId } });\n  } catch {\n    return [];\n  }\n}',
      errors: [{ messageId: 'swallowedFailure', data: { value: '[]' }, line: 5 }],
    },
    {
      code: 'async function loadSettings() { try { const res = await fetch("/api/settings"); return await res.json(); } catch (e) { return {}; } }',
      errors: [{ messageId: 'swallowedFailure', data: { value: '{}' } }],
    },
    {
      code: 'const getUsers = async () => { try { const { data } = await axios.get(url); return data; } catch (error) { return []; } };',
      errors: [{ messageId: 'swallowedFailure', data: { value: '[]' } }],
    },
    {
      code: 'class Repo { async search(q) { try { return await this.client.search(q); } catch { return []; } } }',
      errors: [{ messageId: 'swallowedFailure' }],
    },
  ],
});

tsRuleTester.run('no-silent-fallback (TypeScript)', noSilentFallback, {
  valid: [
    'const key: string = process.env.STRIPE_SECRET_KEY ?? "";',
  ],
  invalid: [
    {
      code: 'const secret: string = process.env.JWT_SECRET! || "fallback-secret";',
      errors: [{ messageId: 'hardcodedSecretFallback', data: { name: 'JWT_SECRET', value: 'fallback-secret' } }],
    },
    {
      code: 'async function list(): Promise<User[]> { try { return await repo.all(); } catch { return [] as User[]; } }',
      errors: [{ messageId: 'swallowedFailure', data: { value: '[]' } }],
    },
  ],
});
