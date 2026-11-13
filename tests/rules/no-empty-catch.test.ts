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
    // 13. An explanation that mentions a TODO later in the text is still an explanation
    {
      code: `
        try { cache.warm(); }
        catch (e) { /* cache is optional; see TODO.md for the plan */ }
      `,
    },
    // 14. A TODO next to a real explanation: the explanation counts
    {
      code: `
        try { optionalCleanup(); }
        catch (e) {
          // Cleanup failures are harmless: the temp dir is removed on reboot.
          // TODO: report them to metrics
        }
      `,
    },
  ],
  invalid: [
    // 1. Basic empty catch: no automatic fix; the suggestion rethrows
    {
      code: `
        try { doSomething(); }
        catch (e) {}
      `,
      errors: [
        {
          messageId: 'emptyCatch',
          suggestions: [
            {
              messageId: 'rethrow',
              output: `
        try { doSomething(); }
        catch (e) { throw e; }
      `,
            },
          ],
        },
      ],
    },
    // 2. Empty catch with no parameter: the suggestion adds a binding to rethrow
    {
      code: `
        try { doSomething(); }
        catch {}
      `,
      errors: [
        {
          messageId: 'emptyCatch',
          suggestions: [
            {
              messageId: 'rethrow',
              output: `
        try { doSomething(); }
        catch (error) { throw error; }
      `,
            },
          ],
        },
      ],
    },
    // 3. Empty catch in async function
    {
      code: `
        async function foo() {
          try { await bar(); }
          catch (e) {}
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
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 8. Empty catch with finally
    {
      code: `
        try { doSomething(); }
        catch (e) {}
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
      errors: [{ messageId: 'emptyCatch', suggestions: 1 }],
    },
    // 10. Multiple empty catches
    {
      code: `
        try { a(); } catch (e1) {}
        try { b(); } catch (e2) {}
      `,
      errors: [
        { messageId: 'emptyCatch', suggestions: 1 },
        { messageId: 'emptyCatch', suggestions: 1 },
      ],
    },
    // 11. The placeholder the old autofix inserted is not an explanation
    {
      code: `
        try { doSomething(); }
        catch (e) { /* TODO: handle error */ }
      `,
      errors: [
        {
          messageId: 'placeholderCatch',
          suggestions: [
            {
              messageId: 'rethrow',
              output: `
        try { doSomething(); }
        catch (e) { throw e; }
      `,
            },
          ],
        },
      ],
    },
    // 12. FIXME and XXX line comments, any case
    {
      code: `
        try { a(); } catch (e) {
          // fixme: handle the timeout case
        }
        try { b(); } catch (e) { // XXX
        }
      `,
      errors: [
        { messageId: 'placeholderCatch', suggestions: 1 },
        { messageId: 'placeholderCatch', suggestions: 1 },
      ],
    },
    // 13. Destructured binding: still reported, but there is no single value to rethrow
    {
      code: `
        try { doSomething(); }
        catch ({ message }) {}
      `,
      errors: [{ messageId: 'emptyCatch', suggestions: [] }],
    },
  ],
});
