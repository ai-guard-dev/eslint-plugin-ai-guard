import { ruleTester } from '../helpers/rule-tester';
import { noEvalDynamic } from '../../src/rules/security/no-eval-dynamic';

ruleTester.run('no-eval-dynamic', noEvalDynamic, {
  valid: [
    // 1. eval with string literal — rare but technically safe
    {
      code: `eval('console.log("hello")');`,
    },
    // 2. eval with no arguments
    {
      code: `eval();`,
    },
    // 3. new Function with all literal arguments
    {
      code: `const fn = new Function('a', 'b', 'return a + b');`,
    },
    // 4. No eval or Function usage at all
    {
      code: `const result = JSON.parse(data);`,
    },
    // 5. Function as regular identifier (not constructor)
    {
      code: `const myFunction = createFunction();`,
    },
    // 6. eval as property name (not a call)
    {
      code: `const obj = { eval: true };`,
    },
    // 7. Template literal with no expressions in eval
    {
      code: 'eval(`console.log("static")`);',
    },
    // 8. new Function with no args
    {
      code: `const noop = new Function();`,
    },
  ],
  invalid: [
    // 1. eval with variable
    {
      code: `eval(userInput);`,
      errors: [{ messageId: 'evalDynamic' }],
    },
    // 2. eval with template literal containing expression
    {
      code: 'eval(`console.log(${userVar})`);',
      errors: [{ messageId: 'evalDynamic' }],
    },
    // 3. eval with concatenation
    {
      code: `eval('console.log(' + value + ')');`,
      errors: [{ messageId: 'evalDynamic' }],
    },
    // 4. window.eval with variable
    {
      code: `window.eval(code);`,
      errors: [{ messageId: 'evalDynamic' }],
    },
    // 5. globalThis.eval with variable
    {
      code: `globalThis.eval(dynamicCode);`,
      errors: [{ messageId: 'evalDynamic' }],
    },
    // 6. new Function with dynamic argument
    {
      code: `const fn = new Function(userCode);`,
      errors: [{ messageId: 'newFunctionDynamic' }],
    },
    // 7. new Function with mixed literal and dynamic args
    {
      code: `const fn = new Function('a', dynamicBody);`,
      errors: [{ messageId: 'newFunctionDynamic' }],
    },
    // 8. eval with function call result
    {
      code: `eval(getCode());`,
      errors: [{ messageId: 'evalDynamic' }],
    },
    // 9. new Function with template literal body
    {
      code: 'const fn = new Function(`return ${expr}`);',
      errors: [{ messageId: 'newFunctionDynamic' }],
    },
    // 10. eval inside a function
    {
      code: `
        function execute(code) {
          return eval(code);
        }
      `,
      errors: [{ messageId: 'evalDynamic' }],
    },
    // 11. Regression: `Function(...)` called WITHOUT `new` is semantically
    //     identical to `new Function(...)` per ECMA-262 / MDN — both produce
    //     an executable function from a code string. The rule previously
    //     only hooked NewExpression, letting bare-call code injection pass.
    {
      code: `
        const userCode = getInput();
        const fn = Function('input', userCode);
      `,
      errors: [{ messageId: 'newFunctionDynamic' }],
    },
    // 12. Regression: bare-call with a concat argument.
    {
      code: `const fn = Function('x', 'return x + ' + suffix);`,
      errors: [{ messageId: 'newFunctionDynamic' }],
    },
    // 13. Regression: globalThis.Function(...) without new.
    {
      code: `
        const payload = getPayload();
        globalThis.Function('return ' + payload)();
      `,
      errors: [{ messageId: 'newFunctionDynamic' }],
    },
  ],
});
