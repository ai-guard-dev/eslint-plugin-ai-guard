import { ruleTester } from '../helpers/rule-tester';
import { noCatchWithoutUse } from '../../src/rules/reliability/no-catch-without-use';

ruleTester.run('no-catch-without-use', noCatchWithoutUse, {
  valid: [
    {
      code: `
        try { run(); }
        catch (e) { console.error(e); }
      `,
    },
    {
      code: `
        try { run(); }
        catch (error) { throw error; }
      `,
    },
    {
      code: `
        try { run(); }
        catch (e) { logError(e.message); }
      `,
    },
    {
      code: `
        try { run(); }
        catch (e) {
          if (e instanceof Error) {
            handle(e);
          }
        }
      `,
    },
    {
      code: `
        try { run(); }
        catch (e) {
          const msg = String(e);
          report(msg);
        }
      `,
    },
    {
      code: `
        try { run(); }
        catch {
          fallback();
        }
      `,
    },
    {
      code: `
        try { run(); }
        catch (_e) { /* intentionally ignored */ }
      `,
    },
    {
      code: `
        async function main() {
          try { await run(); }
          catch (e) { return Promise.reject(e); }
        }
      `,
    },
    {
      code: `
        class S {
          exec() {
            try { run(); }
            catch (e) { this.lastError = e; }
          }
        }
      `,
    },
    {
      code: `
        try { run(); }
        catch (e) {
          const wrap = () => e;
          return wrap();
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        try { run(); }
        catch (e) { fallback(); }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        try { run(); }
        catch (err) { handleFallback(); }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        try { run(); }
        catch (error) {
          const status = 500;
          return status;
        }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        try { run(); }
        catch (e) {
          // nothing with e
          notify();
        }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        async function main() {
          try { await run(); }
          catch (e) { recover(); }
        }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        class Service {
          exec() {
            try { run(); }
            catch (e) { this.reset(); }
          }
        }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        try { a(); }
        catch (e) { b(); }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        try { a(); }
        catch (reason) { throw new Error('failed'); }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        try { a(); }
        catch (e) {
          const value = 1;
          return value;
        }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
    {
      code: `
        try { a(); }
        catch (failure) {
          cleanup();
          retry();
        }
      `,
      errors: [{ messageId: 'unusedCatchParam' }],
    },
  ],
});
