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
  ],
  invalid: [
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
      output: `
        const run = async () => {
          return await (doWork());
        };
      `,
      errors: [{ messageId: 'asyncWithoutAwait' }],
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
      output: `
        class S {
          async run() {
            return await (this.load());
          }
        }
      `,
      errors: [{ messageId: 'asyncWithoutAwait' }],
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
