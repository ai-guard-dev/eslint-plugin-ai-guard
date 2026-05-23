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
      output: `
        async function run() {
          return await (1);
        }
      `,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
    {
      code: `
        const run = async () => 1;
      `,
      output: `
        const run = async () => await (1);
      `,
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
      output: `
        async function run() {
          await (doWork());
        }
      `,
      errors: [{ messageId: 'asyncWithoutAwait' }],
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
      output: `
        const fn = async () => {
          await (Promise.resolve(1));
        };
      `,
      errors: [{ messageId: 'asyncWithoutAwait' }],
    },
  ],
});
