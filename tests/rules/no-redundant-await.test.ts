import { ruleTester } from '../helpers/rule-tester';
import { noRedundantAwait } from '../../src/rules/async/no-redundant-await';

ruleTester.run('no-redundant-await', noRedundantAwait, {
  valid: [
    {
      code: `
        async function run() {
          return fetchData();
        }
      `,
    },
    {
      code: `
        async function run() {
          try {
            return await fetchData();
          } catch (e) {
            throw e;
          }
        }
      `,
    },
    {
      code: `
        async function run() {
          const data = await fetchData();
          return data;
        }
      `,
    },
    {
      code: `
        function run() {
          return await fetchData();
        }
      `,
    },
    {
      code: `
        const run = async () => {
          if (x) {
            try {
              return await a();
            } catch (e) {
              throw e;
            }
          }
          return b();
        };
      `,
    },
    {
      code: `
        const run = async () => {
          return Promise.resolve(1);
        };
      `,
    },
    {
      code: `
        class S {
          async run() {
            return this.fetch();
          }
        }
      `,
    },
    {
      code: `
        const run = async () => {
          await step();
          return value;
        };
      `,
    },
    {
      code: `
        async function withFinally() {
          try {
            return await call();
          } finally {
            cleanup();
          }
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        async function run() {
          return await fetchData();
        }
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        const run = async () => {
          return await fetchData();
        };
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        const run = async function () {
          return await task();
        };
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        class S {
          async run() {
            return await this.fetch();
          }
        }
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        async function run() {
          if (x) {
            return await a();
          }
          return b();
        }
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        async function run() {
          return await Promise.resolve(1);
        }
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        async function run() {
          return await api.call();
        }
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        const run = async () => await work();
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        async function nested() {
          return (async () => await task())();
        }
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        async function run() {
          while (true) {
            return await load();
          }
        }
      `,
      errors: [{ messageId: 'redundantAwait' }],
    },
    {
      code: `
        async function run() {
          switch (kind) {
            case 'a':
              return await doA();
            default:
              return await doB();
          }
        }
      `,
      errors: [{ messageId: 'redundantAwait' }, { messageId: 'redundantAwait' }],
    },
  ],
});
