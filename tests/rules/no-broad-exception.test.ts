import { ruleTester } from '../helpers/rule-tester';
import { noBroadException } from '../../src/rules/reliability/no-broad-exception';

ruleTester.run('no-broad-exception', noBroadException, {
  valid: [
    // 1. Catch with no type annotation (default behavior - fine)
    {
      code: `
        try { doSomething(); }
        catch (e) { console.error(e); }
      `,
    },
    // 2. Catch with no parameter at all
    {
      code: `
        try { doSomething(); }
        catch { console.error('failed'); }
      `,
    },
    // 3. Catch with specific error type
    {
      code: `
        try { doSomething(); }
        catch (e: TypeError) { console.error(e); }
      `,
    },
    // 4. Catch with Error type
    {
      code: `
        try { doSomething(); }
        catch (e: Error) { console.error(e.message); }
      `,
    },
    // 5. Catch with unknown type BUT narrowing with instanceof
    {
      code: `
        try { doSomething(); }
        catch (e: unknown) {
          if (e instanceof TypeError) {
            console.error(e.message);
          }
        }
      `,
    },
    // 6. Catch with unknown and instanceof in nested if
    {
      code: `
        try { doSomething(); }
        catch (e: unknown) {
          if (condition) {
            if (e instanceof Error) {
              handleError(e);
            }
          }
        }
      `,
    },
    // 7. Normal JS catch without TS annotations
    {
      code: `
        try { JSON.parse(data); }
        catch (err) { return null; }
      `,
    },
    // 8. Catch in async function without type annotation
    {
      code: `
        async function fetchData() {
          try { await fetch('/api'); }
          catch (e) { throw new Error('Network failed'); }
        }
      `,
    },
  ],
  invalid: [
    // 1. catch (e: any) — classic AI pattern
    {
      code: `
        try { doSomething(); }
        catch (e: any) { console.error(e); }
      `,
      errors: [{ messageId: 'broadException' }],
    },
    // 2. catch (e: any) in async function
    {
      code: `
        async function foo() {
          try { await bar(); }
          catch (e: any) { throw e; }
        }
      `,
      errors: [{ messageId: 'broadException' }],
    },
    // 3. catch (e: any) in class method
    {
      code: `
        class Service {
          run() {
            try { this.execute(); }
            catch (e: any) { this.log(e); }
          }
        }
      `,
      errors: [{ messageId: 'broadException' }],
    },
    // 4. catch (e: unknown) WITHOUT narrowing
    {
      code: `
        try { doSomething(); }
        catch (e: unknown) {
          console.error('An error occurred');
        }
      `,
      errors: [{ messageId: 'broadException' }],
    },
    // 5. catch (e: unknown) with console.error(e) but no instanceof
    {
      code: `
        try { doSomething(); }
        catch (e: unknown) {
          console.error(e);
        }
      `,
      errors: [{ messageId: 'broadException' }],
    },
    // 6. catch (error: any) with different variable name
    {
      code: `
        try { doSomething(); }
        catch (error: any) {
          reportError(error);
        }
      `,
      errors: [{ messageId: 'broadException' }],
    },
  ],
});
