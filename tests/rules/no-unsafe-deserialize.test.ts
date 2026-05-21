import { ruleTester } from '../helpers/rule-tester';
import { noUnsafeDeserialize } from '../../src/rules/security/no-unsafe-deserialize';

ruleTester.run('no-unsafe-deserialize', noUnsafeDeserialize, {
  valid: [
    {
      code: `JSON.parse('{"safe":true}');`,
    },
    {
      code: `JSON.parse(rawFromTrustedConfig);`,
    },
    {
      code: `const value = JSON.parse(envJson);`,
    },
    {
      code: `parseJson(req.body);`,
    },
    {
      code: `
        const x = JSON.parse(source);
        validateSchema(x);
      `,
    },
    {
      code: `window.JSON.parse(source);`,
    },
    {
      code: `
        function parseData(raw) {
          return JSON.parse(raw);
        }
      `,
    },
    {
      code: `
        const body = '{"a":1}';
        JSON.parse(bodyString);
      `,
    },
    {
      code: `
        const requestBodySafe = getTrustedString();
        JSON.parse(requestBodySafe);
      `,
    },
    {
      code: `
        const response = await fetch('/api');
        const txt = await response.text();
        JSON.parse(txt);
      `,
    },
  ],
  invalid: [
    {
      code: `JSON.parse(req.body);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(req.query);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(req.params);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(request.body);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(userInput);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(input);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(payload);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(rawBody);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(window.location.hash);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
    {
      code: `JSON.parse(window.location.search);`,
      errors: [{ messageId: 'unsafeDeserialize' }],
    },
  ],
});
