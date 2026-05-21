import { ruleTester } from '../helpers/rule-tester';
import { noEmptyCatch } from '../../src/rules/reliability/no-empty-catch';

ruleTester.run('no-empty-catch', noEmptyCatch, {
  valid: [
    // 1. Catch with error logging
    {
      code: `
        try { doSomething(); }
        catch (e) { console.error(e); }
      `,
    },
    // 2. Catch with rethrow
    {
      code: `
        try { doSomething(); }
        catch (e) { throw e; }
      `,
    },
    // 3. Catch with error handling logic
    {
      code: `
        try { doSomething(); }
        catch (e) { handleError(e); }
      `,
    },
    // 4. Catch with assignment
    {
      code: `
        try { doSomething(); }
        catch (e) { lastError = e; }
      `,
    },
    // 5. Catch with return statement
    {
      code: `
        function foo() {
          try { return doSomething(); }
          catch (e) { return null; }
        }
      `,
    },
    // 6. Catch with intentional comment (developer documents why empty)
    {
      code: `
        try { doSomething(); }
        catch (e) { /* intentionally empty — this error is expected */ }
      `,
    },
    // 7. Catch inside async function
    {
      code: `
        async function foo() {
          try { await doSomething(); }
          catch (e) { console.log('Failed:', e.message); }
        }
      `,
    },
    // 8. Catch with conditional logic
    {
      code: `
        try { doSomething(); }
        catch (e) {
          if (e instanceof TypeError) throw e;
        }
      `,
    },
    // 9. Catch in arrow function
    {
      code: `
        const foo = () => {
          try { doSomething(); }
          catch (e) { reportError(e); }
        };
      `,
    },
    // 10. Catch in class method
    {
      code: `
        class Service {
          async run() {
            try { await this.execute(); }
            catch (e) { this.logger.error(e); }
          }
        }
      `,
    },
    // 11. Nested try-catch with handling
    {
      code: `
        try {
          try { a(); }
          catch (inner) { logInner(inner); }
        }
        catch (outer) { logOuter(outer); }
      `,
    },
    // 12. Catch with line comment explaining intentional empty catch
    {
      code: `
        try { optionalCleanup(); }
        catch (e) {
          // We don't care if cleanup fails
        }
      `,
    },
  ],
  invalid: [
    // 1. Basic empty catch
    {
      code: `
        try { doSomething(); }
        catch (e) {}
      `,
      output: `
        try { doSomething(); }
        catch (e) { /* TODO: handle error */ }
      `,
      errors: [
        {
          messageId: 'emptyCatch',
          suggestions: [
            {
              messageId: 'addTodoHandler',
              output: `
        try { doSomething(); }
        catch (e) { /* TODO: handle error */ }
      `,
            },
          ],
        },
      ],
    },
    // 2. Empty catch with no parameter
    {
      code: `
        try { doSomething(); }
        catch {}
      `,
      output: `
        try { doSomething(); }
        catch { /* TODO: handle error */ }
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 3. Empty catch in async function
    {
      code: `
        async function foo() {
          try { await bar(); }
          catch (e) {}
        }
      `,
      output: `
        async function foo() {
          try { await bar(); }
          catch (e) { /* TODO: handle error */ }
        }
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 4. Empty catch in arrow function
    {
      code: `
        const foo = () => {
          try { bar(); }
          catch (e) {}
        };
      `,
      output: `
        const foo = () => {
          try { bar(); }
          catch (e) { /* TODO: handle error */ }
        };
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 5. Nested try with inner empty catch
    {
      code: `
        try {
          try { a(); }
          catch (inner) {}
        }
        catch (outer) { log(outer); }
      `,
      output: `
        try {
          try { a(); }
          catch (inner) { /* TODO: handle error */ }
        }
        catch (outer) { log(outer); }
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 6. Nested try with outer empty catch
    {
      code: `
        try {
          try { a(); }
          catch (inner) { log(inner); }
        }
        catch (outer) {}
      `,
      output: `
        try {
          try { a(); }
          catch (inner) { log(inner); }
        }
        catch (outer) { /* TODO: handle error */ }
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 7. Empty catch in class method
    {
      code: `
        class Service {
          run() {
            try { this.execute(); }
            catch (e) {}
          }
        }
      `,
      output: `
        class Service {
          run() {
            try { this.execute(); }
            catch (e) { /* TODO: handle error */ }
          }
        }
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 8. Empty catch with finally
    {
      code: `
        try { doSomething(); }
        catch (e) {}
        finally { cleanup(); }
      `,
      output: `
        try { doSomething(); }
        catch (e) { /* TODO: handle error */ }
        finally { cleanup(); }
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 9. Empty catch in loop
    {
      code: `
        for (const item of items) {
          try { process(item); }
          catch (e) {}
        }
      `,
      output: `
        for (const item of items) {
          try { process(item); }
          catch (e) { /* TODO: handle error */ }
        }
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 10. Multiple empty catches
    {
      code: `
        try { a(); } catch (e1) {}
        try { b(); } catch (e2) {}
      `,
      output: `
        try { a(); } catch (e1) { /* TODO: handle error */ }
        try { b(); } catch (e2) { /* TODO: handle error */ }
      `,
      errors: [
        { messageId: 'emptyCatch', suggestions: 1 },
        { messageId: 'emptyCatch', suggestions: 1 },
      ],
    },
  ],
});
