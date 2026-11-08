import { describe, it, expect } from 'vitest';
import { isTestFile, isNonProductionFile } from '../../src/utils/file-context';
import { isGenericSecretEnvName, splitEnvName } from '../../src/utils/env-access';

describe('file-context', () => {
  it.each([
    'src/user.test.ts',
    'src/user.spec.tsx',
    'C:\\repo\\src\\__tests__\\user.js',
    '/repo/tests/helpers.ts',
    '/repo/e2e/login.ts',
    'src/login.cy.ts',
  ])('%s is a test file', (file) => {
    expect(isTestFile(file)).toBe(true);
    expect(isNonProductionFile(file)).toBe(true);
  });

  it.each([
    'src/mocks/handlers.ts',
    'src/__mocks__/api.js',
    'src/Button.stories.tsx',
    'prisma/seed.ts',
    'db/seeds/users.js',
    'examples/basic.js',
    'src/api.mock.ts',
    'fixtures/data.js',
  ])('%s is non-production but not a test', (file) => {
    expect(isTestFile(file)).toBe(false);
    expect(isNonProductionFile(file)).toBe(true);
  });

  it.each([
    'src/api/users.ts',
    'src/testimonials.tsx',
    'src/contest.ts',
    'app/latest/page.tsx',
    'src/seeder-utils/x.ts',
    'src/specification.ts',
  ])('%s is production code', (file) => {
    expect(isTestFile(file)).toBe(false);
    expect(isNonProductionFile(file)).toBe(false);
  });
});

describe('env-access', () => {
  it('splits SCREAMING_CASE and camelCase names', () => {
    expect(splitEnvName('JWT_SECRET')).toEqual(['JWT', 'SECRET']);
    expect(splitEnvName('openaiApiKey')).toEqual(['OPENAI', 'API', 'KEY']);
  });

  it.each([
    'JWT_SECRET', 'SESSION_SECRET', 'NEXTAUTH_SECRET', 'DB_PASSWORD', 'ENCRYPTION_KEY', 'OPENAI_API_KEY',
    'STRIPE_SECRET_KEY', 'GITHUB_TOKEN', 'SLACK_BOT_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PASSWORD', 'APIKEY',
  ])('%s is a secret', (name) => {
    expect(isGenericSecretEnvName(name)).toBe(true);
  });

  it.each([
    'JWT_EXPIRES_IN', 'SESSION_SECRET_TTL', 'API_KEY_HEADER', 'BCRYPT_SALT_ROUNDS', 'SECRET_FILE',
    'STRIPE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'RECAPTCHA_SITE_KEY', 'AWS_ACCESS_KEY_ID', 'PORT',
    'DATABASE_URL', 'TOKEN_URL', 'JWT_PUBLIC_KEY', 'CSRF_TOKEN_NAME',
  ])('%s is not a secret', (name) => {
    expect(isGenericSecretEnvName(name)).toBe(false);
  });
});
