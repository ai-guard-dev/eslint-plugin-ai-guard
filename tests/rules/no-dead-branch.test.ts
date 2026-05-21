import { ruleTester } from '../helpers/rule-tester';
import { noDeadBranch } from '../../src/rules/ai-patterns/no-dead-branch';

ruleTester.run('no-dead-branch', noDeadBranch, {
  valid: [
    // 1. Normal runtime condition
    {
      code: `if (x > 0) { doSomething(); }`,
    },
    // 2. while (true) is intentional — event loop / retry pattern
    {
      code: `while (true) { processQueue(); }`,
    },
    // 3. Normal boolean variable condition
    {
      code: `const active = getStatus(); if (active) { run(); }`,
    },
    // 4. Normal comparison
    {
      code: `if (count === 0) { reset(); }`,
    },
    // 5. Ternary with runtime condition
    {
      code: `const result = isReady ? doWork() : wait();`,
    },
    // 6. Logical OR with different operands (not self-tautology)
    {
      code: `if (a || b) { run(); }`,
    },
    // 7. Logical AND with different operands
    {
      code: `if (a && b) { run(); }`,
    },
    // 8. do-while (true) is also intentional
    {
      code: `do { processEvent(); } while (checkQueue());`,
    },
    // 9. Normal non-zero number
    {
      code: `if (items.length) { process(); }`,
    },
    // 10. Distinct identifiers in comparison
    {
      code: `if (a === b) { sync(); }`,
    },
    // 11. Comparison between different identifiers (runtime)
    {
      code: `if (user.role === admin.role) { allow(); }`,
    },
    // 12. Logical AND with different identifiers
    {
      code: `if (isLoggedIn && hasPermission) { proceed(); }`,
    },
  ],
  invalid: [
    // 1. if (true) — always executes, condition is useless
    {
      code: `if (true) { doSomething(); }`,
      errors: [{ messageId: 'alwaysTrue' }],
    },
    // 2. if (false) — dead branch, never executes
    {
      code: `if (false) { doSomething(); }`,
      errors: [{ messageId: 'alwaysFalse' }],
    },
    // 3. if (0) — always false
    {
      code: `if (0) { doSomething(); }`,
      errors: [{ messageId: 'alwaysFalse' }],
    },
    // 4. if ('') — always false
    {
      code: `if ('') { doSomething(); }`,
      errors: [{ messageId: 'alwaysFalse' }],
    },
    // 5. x && !x — self-contradictory, always false
    {
      code: `if (x && !x) { doSomething(); }`,
      errors: [{ messageId: 'alwaysFalse' }],
    },
    // 6. x || !x — self-tautological, always true
    {
      code: `if (x || !x) { doSomething(); }`,
      errors: [{ messageId: 'alwaysTrue' }],
    },
    // 7. x === x — trivially true
    {
      code: `if (x === x) { doSomething(); }`,
      errors: [{ messageId: 'alwaysTrue' }],
    },
    // 8. x == x — trivially true (loose equality)
    {
      code: `if (x == x) { doSomething(); }`,
      errors: [{ messageId: 'alwaysTrue' }],
    },
    // 9. x !== x — trivially false
    {
      code: `if (x !== x) { doSomething(); }`,
      errors: [{ messageId: 'alwaysFalse' }],
    },
    // 10. while (false) — dead loop
    {
      code: `while (false) { doSomething(); }`,
      errors: [{ messageId: 'whileFalse' }],
    },
    // 11. do-while (false) — executes once but condition is dead
    {
      code: `do { doSomething(); } while (false);`,
      errors: [{ messageId: 'whileFalse' }],
    },
    // 12. Ternary with always-true condition
    {
      code: `const r = true ? a : b;`,
      errors: [{ messageId: 'alwaysTrue' }],
    },
    // 13. Ternary with always-false condition
    {
      code: `const r = false ? a : b;`,
      errors: [{ messageId: 'alwaysFalse' }],
    },
    // 14. AI-slop: if (true) wrapping entire function body
    {
      code: `
        function handler(req, res) {
          if (true) {
            res.json({ ok: true });
          }
        }
      `,
      errors: [{ messageId: 'alwaysTrue' }],
    },
    // 15. if (false) else branch (entire if is dead)
    {
      code: `if (false) { a(); } else { b(); }`,
      errors: [{ messageId: 'alwaysFalse' }],
    },
    // 16. Nested: dead branch inside a function
    {
      code: `
        function check(val) {
          if (0) {
            console.log('never');
          }
          return val;
        }
      `,
      errors: [{ messageId: 'alwaysFalse' }],
    },
  ],
});
