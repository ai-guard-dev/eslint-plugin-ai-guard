import { describe } from 'vitest';
import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import { noFloatingPromise } from '../../src/rules/async/no-floating-promise';

const valid = [
  // 1. Awaited async call
  {
    code: `
      async function asyncFn() {}
      async function main() {
        await asyncFn();
      }
    `,
  },
  // 2. Returned promise
  {
    code: `
      async function asyncFn() {}
      function main() {
        return asyncFn();
      }
    `,
  },
  // 3. Chained with .then()
  {
    code: `
      async function asyncFn() {}
      function handler() {}
      asyncFn().then(handler);
    `,
  },
  // 4. Chained with .catch()
  {
    code: `
      async function asyncFn() {}
      function handler() {}
      asyncFn().catch(handler);
    `,
  },
  // 5. Chained with .finally()
  {
    code: `
      async function asyncFn() {}
      function handler() {}
      asyncFn().finally(handler);
    `,
  },
  // 6. Explicit void usage
  {
    code: `
      async function asyncFn() {}
      void asyncFn();
    `,
  },
  // 7. Assignment
  {
    code: `
      async function asyncFn() {}
      const p = asyncFn();
    `,
  },
  // 8. Non-async sync function call
  {
    code: `
      function syncFn() {}
      syncFn();
    `,
  },
  // 9. Async function with internal try/catch (fire-and-forget safe)
  {
    code: `
      async function x() {}
      function log(e) {}
      async function safeFn() { 
        try { 
          await x() 
        } catch(e) { 
          log(e) 
        } 
      }
      safeFn();
    `,
  },
  // FALSE-POSITIVE SENSITIVE (VALID) 1: Sync function named 'fetchConfig'
  {
    code: `
      function fetchConfig() {}
      fetchConfig();
    `,
  },
  // FALSE-POSITIVE SENSITIVE (VALID) 2: Constructor call
  {
    code: `
      class MyClass {}
      new MyClass();
    `,
  },
  // FALSE-POSITIVE SENSITIVE (VALID) 3: Method call on non-promise object
  {
    code: `
      const arr = [];
      arr.push(1);
    `,
  },
];

const invalid = [
  // 1. Unhandled call to locally declared async function
  {
    code: `
      async function doWork() { await fetch('/api') }
      doWork();
    `,
    output: `
      async function doWork() { await fetch('/api') }
      void doWork();
    `,
    errors: [{ messageId: 'floatingPromise' }],
  },
  // 2. Unhandled new Promise(...) expression statement
  {
    code: `new Promise((resolve) => resolve(1));`,
    output: `void new Promise((resolve) => resolve(1));`,
    errors: [{ messageId: 'floatingPromise' }],
  },
  // 3. Unhandled fetch() call (known promise factory)
  {
    code: `fetch('/api');`,
    output: `void fetch('/api');`,
    errors: [{ messageId: 'floatingPromise' }],
  },
  // 4. Unhandled Promise.resolve() call
  {
    code: `Promise.resolve(1);`,
    output: `void Promise.resolve(1);`,
    errors: [{ messageId: 'floatingPromise' }],
  },
  // 5. Unhandled Promise.all([...]) call
  {
    code: `Promise.all([1, 2]);`,
    output: `void Promise.all([1, 2]);`,
    errors: [{ messageId: 'floatingPromise' }],
  },
];

describe('no-floating-promise modes', () => {
  ruleTester.run('Syntax-Only Mode', noFloatingPromise, {
    valid,
    invalid,
  });

  tsRuleTester.run('Type-Aware Mode', noFloatingPromise, {
    valid,
    invalid,
  });
});
