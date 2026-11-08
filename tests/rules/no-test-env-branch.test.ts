import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import { noTestEnvBranch } from '../../src/rules/ai-patterns/no-test-env-branch';

ruleTester.run('no-test-env-branch', noTestEnvBranch, {
  valid: [
    // Skipping side effects under test is fine
    'if (process.env.NODE_ENV !== "test") { app.listen(3000); }',
    'export function start() { if (process.env.NODE_ENV !== "test") { app.listen(3000); } }',
    'function track(e) { if (process.env.NODE_ENV === "test") return; analytics.track(e); }',
    'function track(e) { if (process.env.NODE_ENV === "test") return null; analytics.track(e); }',
    'function send(m) { if (process.env.VITEST) return undefined; return mailer.send(m); }',
    // Choosing between constants is configuration
    'const level = process.env.NODE_ENV === "test" ? "silent" : "info";',
    'function logLevel() { if (process.env.NODE_ENV === "test") return "silent"; return "info"; }',
    'const timeout = () => (process.env.NODE_ENV === "test" ? 10 : 5000);',
    // Switching a dependency still runs the real code against it
    'function getDb() { if (process.env.NODE_ENV === "test") return createTestDb(); return pool; }',
    'function clock() { return process.env.NODE_ENV === "test" ? fakeClock : systemClock; }',
    // Module-level switches are configuration
    'if (process.env.NODE_ENV === "test") { module.exports = { retries: 0 }; }',
    // Not test-environment checks
    'function f() { if (process.env.NODE_ENV === "production") return cached; return load(); }',
    'function f() { if (process.env.CI) return []; return scan(); }',
    'function f() { if (typeof window === "undefined") return null; return window.innerWidth; }',
    // The test branch does real work
    'function f() { if (process.env.NODE_ENV === "test") { log("test"); } return compute(); }',
    // Vitest in-source tests
    'if (import.meta.vitest) { const { it, expect } = import.meta.vitest; it("adds", () => { expect(add(1, 2)).toBe(3); }); }',
    // Test files, setup files and tooling config
    { code: 'function f() { if (process.env.NODE_ENV === "test") return { ok: true }; return real(); }', filename: 'src/api.test.ts' },
    { code: 'export function f() { if (process.env.VITEST) return { ok: true }; return real(); }', filename: 'vitest.setup.ts' },
    { code: 'export function render() { if (process.env.NODE_ENV === "test") return { ok: true }; return real(); }', filename: 'src/test-utils.tsx' },
    { code: 'module.exports = () => { if (process.env.NODE_ENV === "test") return { plugins: [] }; return build(); };', filename: 'next.config.js' },
  ],
  invalid: [
    {
      code: 'export async function verifySignature(payload, sig) {\n  if (process.env.NODE_ENV === "test") return true;\n  return crypto.verify(payload, sig);\n}',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`verifySignature`', condition: 'process.env.NODE_ENV === "test"' }, line: 2 }],
    },
    {
      code: 'function getUser(id) { if (process.env.VITEST) { return { id: 1, name: "Test User" }; } return db.users.find(id); }',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`getUser`', condition: 'process.env.VITEST' } }],
    },
    {
      code: 'const fetchRates = async () => process.env.NODE_ENV === "test" ? { USD: 1 } : (await fetch(url)).json();',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`fetchRates`', condition: 'process.env.NODE_ENV === "test"' } }],
    },
    {
      code: 'function charge(card) { if (process.env.NODE_ENV !== "test") { return stripe.charges.create(card); } else { return { status: "succeeded" }; } }',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`charge`', condition: 'process.env.NODE_ENV !== "test"' } }],
    },
    {
      code: 'function list() { if (typeof jest !== "undefined") return []; return db.all(); }',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`list`', condition: 'typeof jest !== "undefined"' } }],
    },
    {
      code: 'const isTest = process.env.NODE_ENV === "test";\nfunction auth(req) { if (isTest) return { userId: "test-user" }; return verify(req); }',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`auth`', condition: 'isTest' } }],
    },
    {
      code: 'const isTestEnv = () => process.env.NODE_ENV === "test";\nexport function rate() { if (isTestEnv()) return 0.1; return api.rate(); }',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`rate`', condition: 'isTestEnv()' } }],
    },
    {
      code: 'function f() { if (process.env.JEST_WORKER_ID) return Promise.resolve({ ok: true }); return call(); }',
      errors: [{ messageId: 'cannedTestResult' }],
    },
    {
      code: 'function f() { if (process.env.NODE_ENV === "test" && !process.env.E2E) return 42; return compute(); }',
      errors: [{ messageId: 'cannedTestResult' }],
    },
    {
      code: 'const MOCK_USER = { id: 1 };\nfunction me() { if (process.env.NODE_ENV === "test") return MOCK_USER; return api.me(); }',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`me`', condition: 'process.env.NODE_ENV === "test"' } }],
    },
    {
      code: 'function mode() { if (import.meta.env.MODE === "test") return { flags: [] }; return remote.flags(); }',
      errors: [{ messageId: 'cannedTestResult' }],
    },
    {
      code: 'const api = { health() { if (process.env.NODE_ENV === "test") return "ok"; return ping(); } };',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`health`', condition: 'process.env.NODE_ENV === "test"' } }],
    },
  ],
});

tsRuleTester.run('no-test-env-branch (TypeScript)', noTestEnvBranch, {
  valid: [
    'export function level(): string { return process.env.NODE_ENV === "test" ? "silent" : "info"; }',
  ],
  invalid: [
    {
      code: 'export async function isAllowed(user: User): Promise<boolean> {\n  if (process.env.NODE_ENV === "test") return true as boolean;\n  return acl.check(user);\n}',
      errors: [{ messageId: 'cannedTestResult', data: { name: '`isAllowed`', condition: 'process.env.NODE_ENV === "test"' } }],
    },
  ],
});
