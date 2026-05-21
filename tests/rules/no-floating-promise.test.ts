import { ruleTester } from '../helpers/rule-tester';
import { noFloatingPromise } from '../../src/rules/async/no-floating-promise';

ruleTester.run('no-floating-promise', noFloatingPromise, {
  valid: [
    // 1. await on async call
    {
      code: `
        async function main() {
          await fetchData();
        }
      `,
    },
    // 2. .then() chained on call
    {
      code: `fetchData().then(data => console.log(data));`,
    },
    // 3. .catch() chained on call
    {
      code: `fetchData().catch(err => console.error(err));`,
    },
    // 4. Result assigned to variable
    {
      code: `const data = fetchData();`,
    },
    // 5. Regular sync function call (no async-ish name)
    {
      code: `console.log('hello');`,
    },
    // 6. void operator (intentional fire-and-forget)
    {
      code: `void fetchData();`,
    },
    // 7. Returned from function
    {
      code: `
        function wrapper() {
          return fetchData();
        }
      `,
    },
    // 8. Non-async-named function call
    {
      code: `
        doMath();
      `,
    },
    // 9. Method call without async-ish name
    {
      code: `arr.push(1);`,
    },
    // 10. .finally() chained
    {
      code: `fetchData().finally(() => cleanup());`,
    },
    // 11. sync function names that happen to start with get but are clearly sync
    {
      code: `
        const x = getElementById('foo');
      `,
    },
    // 12. Await expression statement inside async function
    {
      code: `
        async function run() {
          await loadUser();
        }
      `,
    },
    // 13. Promise assigned
    {
      code: `const promise = sendEmail();`,
    },
    // 14. Synchronous event helper should not be flagged
    {
      code: `sendEvent('started');`,
    },
    // 15. Synchronous helper declared later (common in component modules)
    {
      code: `
        sendEvent('clicked');
        function sendEvent(name) {
          console.log(name);
        }
      `,
    },
    // 16. React-style state setter call (sync) should not be flagged
    {
      code: `
        setFormData({ name: 'A' });
      `,
    },
    // 17. Local async helper with internal try/catch called fire-and-forget
    {
      code: `
        async function loadData() {
          try {
            await fetch('/api');
          } catch (e) {
            console.error(e);
          }
        }

        loadData();
      `,
    },
    // 18. Async arrow helper with internal try/catch called fire-and-forget
    {
      code: `
        const hydrate = async () => {
          try {
            await fetch('/api/hydrate');
          } catch (e) {
            console.error(e);
          }
        };

        hydrate();
      `,
    },
  ],
  invalid: [
    // 1. Bare fetch() call as statement
    {
      code: `fetch('/api/users');`,
      output: `void fetch('/api/users');`,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 2. Bare Promise.resolve() call
    {
      code: `Promise.resolve(1);`,
      output: `void Promise.resolve(1);`,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 3. Bare Promise.all() call
    {
      code: `Promise.all(tasks);`,
      output: `void Promise.all(tasks);`,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 4. Known async function declared in same file
    {
      code: `
        async function doWork() { return 1; }
        doWork();
      `,
      output: `
        async function doWork() { return 1; }
        void doWork();
      `,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 5. Async arrow function variable called bare
    {
      code: `
        const processItems = async () => { return 1; };
        processItems();
      `,
      output: `
        const processItems = async () => { return 1; };
        void processItems();
      `,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 6. Async IIFE not awaited/handled
    {
      code: `(async () => 1)();`,
      output: `void (async () => 1)();`,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 7. New Promise without handling
    {
      code: `new Promise((resolve) => resolve(1));`,
      output: `void new Promise((resolve) => resolve(1));`,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 8. Async function declared later should still be detected
    {
      code: `
        loadData();
        async function loadData() {
          await fetch('/api');
        }
      `,
      output: `
        void loadData();
        async function loadData() {
          await fetch('/api');
        }
      `,
      errors: [{ messageId: 'floatingPromise' }],
    },
    // 9. Async arrow assigned to variable and called bare
    {
      code: `
        const fetchDentistSlots = async () => {
          await fetch('/api/slots');
        };
        fetchDentistSlots();
      `,
      output: `
        const fetchDentistSlots = async () => {
          await fetch('/api/slots');
        };
        void fetchDentistSlots();
      `,
      errors: [{ messageId: 'floatingPromise' }],
    },
  ],
});
