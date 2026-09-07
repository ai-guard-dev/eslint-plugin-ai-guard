import { ruleTester } from '../helpers/rule-tester';
import { noAsyncWithoutAwait } from '../../src/rules/async/no-async-without-await';

ruleTester.run('no-async-without-await', noAsyncWithoutAwait, {
  valid: [
    {
      code: `
        async function run() {
          await fetchData();
        }
      `,
    },
    {
      code: `
        const run = async () => await fetchData();
      `,
    },
    {
      code: `
        const run = async () => {
          if (x) await fetchA();
          else await fetchB();
        };
      `,
    },
    {
      code: `
        const run = async () => {
          for await (const item of stream) {
            consume(item);
          }
        };
      `,
    },
    {
      code: `
        async function nested() {
          await (async () => await value)();
        }
      `,
    },
    {
      code: `
        function syncFn() {
          return 1;
        }
      `,
    },
    {
      code: `
        const fn = () => Promise.resolve(1);
      `,
    },
    {
      code: `
        class S {
          async run() {
            await this.load();
          }
        }
      `,
    },
    {
      code: `
        async function withTry() {
          try {
            await run();
          } catch (e) {
            throw e;
          }
        }
      `,
    },
    {
      code: `
        const fn = async () => {
          return await Promise.resolve(1);
        };
      `,
    },
    // HTTP method exports (Next.js route handlers) — always valid async
    {
      code: `export async function GET() { return Response.json({ ok: true }); }`,
    },
    {
      code: `export async function POST(request) { return Response.json({}); }`,
    },
    {
      code: `export const PUT = async (req, res) => { res.send('ok'); };`,
    },
    {
      code: `export async function DELETE() { return new Response(null, { status: 204 }); }`,
    },
    {
      code: `export async function OPTIONS() { return new Response(null); }`,
    },
    // Middleware naming convention — always valid
    {
      code: `async function useAuth(req, res, next) { next(); }`,
    },
    {
      code: `const middleware = async (req, res, next) => { next(); };`,
    },
    // allowedFunctionNames option
    {
      code: `async function myCustomHandler() { doSomething(); }`,
      options: [{ allowedFunctionNames: ['myCustomHandler'] }],
    },
    // Try/catch with return — async is needed for promise rejection handling
    {
      code: `
        async function fetchSafe() {
          try {
            return fetchData();
          } catch (e) {
            return fallback();
          }
        }
      `,
    },
    {
      code: `
        async function withFinally() {
          try {
            return db.query('SELECT 1');
          } finally {
            db.release();
          }
        }
      `,
    },
    {
      code: `
        async function multiStatement() {
          const conn = getConnection();
          try {
            return conn.execute(sql);
          } catch (e) {
            logger.error(e);
            throw new AppError('query failed', { cause: e });
          }
        }
      `,
    },
    {
      code: `
        const safeFetch = async () => {
          try {
            return fetch(url);
          } catch {
            return null;
          }
        };
      `,
    },
  ],
  invalid: [
    // Pass-through wrappers — produce asyncPassThrough (informational), not asyncWithoutAwait
    {
      code: `async function wrap() { return fetchData(); }`,
      errors: [{ messageId: 'asyncPassThrough' }],
    },
    {
      code: `const wrap = async () => fetchData();`,
      errors: [{ messageId: 'asyncPassThrough' }],
    },
    {
      code: `
        async function run() {
          return 1;
        }
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    {
      code: `
        const run = async () => 1;
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    {
      code: `
        const run = async () => {
          return doWork();
        };
      `,
      // Pass-through wrapper — produces asyncPassThrough, not asyncWithoutAwait
      errors: [{ messageId: 'asyncPassThrough' }],
    },
    {
      code: `
        async function run() {
          doWork();
        }
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait', suggestions: [{ messageId: 'addAwait', output: `
        async function run() {
          await (doWork());
        }
      ` }] }],
    },
    {
      code: `
        const run = async function () {
          const x = 1;
          return x;
        };
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    {
      code: `
        class S {
          async run() {
            return this.load();
          }
        }
      `,
      // Single return of call expression = pass-through
      errors: [{ messageId: 'asyncPassThrough' }],
    },
    {
      code: `
        async function run() {
          if (condition) {
            return a();
          }
          return b();
        }
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    {
      code: `
        const fn = async () => {
          const inner = async () => await task();
          return inner;
        };
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    {
      code: `
        async function empty() {}
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    {
      code: `
        const fn = async () => {
          Promise.resolve(1);
        };
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait', suggestions: [{ messageId: 'addAwait', output: `
        const fn = async () => {
          await (Promise.resolve(1));
        };
      ` }] }],
    },
  ],
});

// ─── H1 Regression: autofix replaced by suggestions ────────────────────────
// The rule must NOT provide an automatic fix (fixable: 'code') because
// the old autofix transformed `return 1` -> `return await (1)` which is
// semantically nonsensical. Instead, suggestions are offered only for
// expressions that could reasonably be promises.

ruleTester.run('no-async-without-await (H1: safe suggestions)', noAsyncWithoutAwait, {
  valid: [],
  invalid: [
    // 1. Literal return -- no suggestion should be offered
    {
      code: `async function f() { return 1; }`,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    // 2. Call expression return -- suggestion to add await IS appropriate
    {
      code: `async function f() { return doWork(); }`,
      output: null,
      errors: [{ messageId: 'asyncPassThrough' }], // pass-through wrapper
    },
    // 3. Expression-body async arrow with literal -- no suggestion
    {
      code: `const f = async () => 1;`,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    // 4. Empty body -- no suggestion
    {
      code: `async function empty() {}`,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    // 5. Multi-statement body -- no suggestion
    {
      code: `
        async function run() {
          if (condition) { return a(); }
          return b();
        }
      `,
      output: null,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
  ],
});