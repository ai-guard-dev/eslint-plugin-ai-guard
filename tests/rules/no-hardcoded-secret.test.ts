import { ruleTester } from '../helpers/rule-tester';
import { noHardcodedSecret } from '../../src/rules/security/no-hardcoded-secret';

ruleTester.run('no-hardcoded-secret', noHardcodedSecret, {
  valid: [
    // 1. Using environment variable
    {
      code: `const apiKey = process.env.API_KEY;`,
    },
    // 2. Short values (placeholders)
    {
      code: `const apiKey = 'test';`,
    },
    // 3. Variable name doesn't match secret pattern
    {
      code: `const username = 'admin_user_12345';`,
    },
    // 4. Empty string
    {
      code: `const password = '';`,
    },
    // 5. Known placeholder
    {
      code: `const apiKey = 'your-api-key';`,
    },
    // 6. Non-secret variable with long value
    {
      code: `const description = 'This is a really long description for a feature';`,
    },
    // 7. Secret name but value from env
    {
      code: `const jwtSecret = process.env.JWT_SECRET;`,
    },
    // 8. Config object with env var values
    {
      code: `
        const config = {
          secret: process.env.APP_SECRET,
        };
      `,
    },
    // 9. Short placeholder value for password
    {
      code: `const password = 'changeme';`,
    },
    // 10. Non-matching variable name
    {
      code: `const databaseUrl = 'mongodb://localhost:27017/mydb';`,
    },
    // 11. ESLint rule meta message IDs are not secrets
    {
      code: `
        const rule = {
          meta: {
            messages: {
              hardcodedSecret: 'Possible hardcoded secret in variable {{name}}',
            },
          },
        };
      `,
    },
    // 12. Test file path — real sk- prefixed token should be flagged (even sk-test- ones)
    // This moved to invalid because sk-test-* tokens can be real API keys
    // 12. Constant with env var default (different from literal)
    {
      code: `const TEST_API_KEY = process.env.TEST_API_KEY ?? 'fallback';`,
    },
    // 13. Function parameter default with env pattern
    {
      code: `function init(apiKey = process.env.API_KEY) { return apiKey; }`,
    },
    // 14. Object destructuring from process.env
    {
      code: `const { API_KEY: apiKey } = process.env;`,
    },
    // 15. Secret used as type annotation (TS interface)
    {
      code: `const PLACEHOLDER = 'INSERT_API_KEY_HERE';`,
    },
  ],
  invalid: [
    // 1. Hardcoded API key
    {
      code: `const apiKey = 'sk-1234567890abcdef1234567890abcdef';`,
      output: `const apiKey = process.env.API_KEY;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 2. Hardcoded password
    {
      code: `const password = 'SuperSecretPassword123!';`,
      output: `const password = process.env.PASSWORD;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 3. Hardcoded JWT secret
    {
      code: `const jwtSecret = 'my-super-secret-jwt-key-that-is-long';`,
      output: `const jwtSecret = process.env.JWT_SECRET;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 4. Hardcoded auth token
    {
      code: `const authToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';`,
      output: `const authToken = process.env.AUTH_TOKEN;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 5. Object property with hardcoded secret
    {
      code: `
        const config = {
          clientSecret: 'abcdef1234567890abcdef1234567890',
        };
      `,
      output: `
        const config = {
          clientSecret: process.env.CLIENT_SECRET,
        };
      `,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 6. Assignment to member with secret value
    {
      code: `
        config.apiKey = 'hardcoded-api-key-value-long';
      `,
      output: `
        config.apiKey = process.env.API_KEY;
      `,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 7. Template literal as secret value
    {
      code: 'const secret = `this-is-a-hardcoded-secret-value`;',
      output: 'const secret = process.env.SECRET;',
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 8. Private key
    {
      code: `const privateKey = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';`,
      output: `const privateKey = process.env.PRIVATE_KEY;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 9. Encryption key
    {
      code: `const encryptionKey = 'aes-256-cbc-key-value-here-12345';`,
      output: `const encryptionKey = process.env.ENCRYPTION_KEY;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 10. Access token
    {
      code: `const accessToken = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';`,
      output: `const accessToken = process.env.ACCESS_TOKEN;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 11. camelCase secret name with long value
    {
      code: `const signingKey = 'rsa-private-key-begins-here-1234567890';`,
      output: `const signingKey = process.env.SIGNING_KEY;`,
      errors: [{ messageId: 'hardcodedSecret' }],
    },
    // 12. Multiple secret assignments in one block — each flagged
    {
      code: `
    const apiKey = 'sk-prod-abcdef1234567890abcdef12345678';
    const clientSecret = 'super-secret-client-value-12345';
  `,
      output: `
    const apiKey = process.env.API_KEY;
    const clientSecret = process.env.CLIENT_SECRET;
  `,
      errors: [
        { messageId: 'hardcodedSecret' },
        { messageId: 'hardcodedSecret' },
      ],
    },
  ],
});
