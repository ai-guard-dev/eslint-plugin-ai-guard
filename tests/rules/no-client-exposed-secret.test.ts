import { describe, it, expect } from 'vitest';
import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import {
  noClientExposedSecret,
  isBrowserForbiddenName,
} from '../../src/rules/security/no-client-exposed-secret';

describe('isBrowserForbiddenName', () => {
  it.each([
    'SUPABASE_SERVICE_ROLE_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_KEY',
    'STRIPE_SECRET_KEY',
    'JWT_SECRET',
    'DATABASE_URL',
    'MONGODB_URI',
    'GITHUB_TOKEN',
    'ADMIN_PASSWORD',
    'TWILIO_AUTH_TOKEN',
    'FIREBASE_PRIVATE_KEY',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
    'resendApiKey',
  ])('treats %s as server-only', (name) => {
    expect(isBrowserForbiddenName(name)).toBe(true);
  });

  it.each([
    'SUPABASE_ANON_KEY',
    'SUPABASE_URL',
    'STRIPE_PUBLISHABLE_KEY',
    'FIREBASE_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'MAPBOX_ACCESS_TOKEN',
    'RECAPTCHA_SITE_KEY',
    'POSTHOG_KEY',
    'SENTRY_DSN',
    'CLERK_PUBLISHABLE_KEY',
    'PASSWORD_MIN_LENGTH',
    'SECRET_SANTA_ENABLED',
    'AUTH0_CLIENT_ID',
    'API_URL',
  ])('treats %s as safe to expose', (name) => {
    expect(isBrowserForbiddenName(name)).toBe(false);
  });
});

ruleTester.run('no-client-exposed-secret', noClientExposedSecret, {
  valid: [
    // Credentials designed to be public
    'const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);',
    'const stripe = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);',
    'initializeApp({ apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY });',
    'mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;',
    'const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;',
    'const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;',
    'posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY);',
    'Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN });',
    // Secret-sounding words that describe settings, not secrets
    'const min = Number(process.env.NEXT_PUBLIC_PASSWORD_MIN_LENGTH);',
    'const enabled = process.env.NEXT_PUBLIC_SECRET_SANTA_ENABLED === "true";',
    // Server-only secrets in server code are fine
    'const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);',
    'const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });',
    // "use client" only counts as a directive at the top of the file
    'const mode = "use client"; const key = process.env.OPENAI_API_KEY;',
    // Client files may read public and non-secret env vars
    {
      code: '"use client";\nconst url = process.env.NEXT_PUBLIC_SUPABASE_URL;\nif (process.env.NODE_ENV === "development") debug();',
    },
    // Bring-your-own-key apps: the key comes from the user, not the build
    'const client = new OpenAI({ apiKey: userApiKey, dangerouslyAllowBrowser: true });',
    'const client = new Anthropic({ apiKey: settings.get("anthropicKey"), dangerouslyAllowBrowser: true });',
    'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, dangerouslyAllowBrowser: false });',
    // Dynamic env lookups cannot be judged statically
    'const value = process.env[name];',
    // Escape hatch for team-specific public names
    {
      code: 'const token = process.env.NEXT_PUBLIC_DEMO_SECRET;',
      options: [{ allow: ['NEXT_PUBLIC_DEMO_SECRET'] }],
    },
    // Unrelated objects named env
    'const secret = config.env.NEXT_PUBLIC_JWT_SECRET;',
  ],
  invalid: [
    {
      code: 'const openai = new OpenAI({ apiKey: import.meta.env.VITE_OPENAI_API_KEY });',
      errors: [{ messageId: 'publicPrefixSecret', data: { name: 'VITE_OPENAI_API_KEY', prefix: 'VITE_' } }],
    },
    {
      code: 'const stripe = new Stripe(process.env.REACT_APP_STRIPE_SECRET_KEY);',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
    {
      code: 'const anthropic = new Anthropic({ apiKey: process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY });',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
    {
      code: "const db = postgres(process.env['NEXT_PUBLIC_DATABASE_URL']);",
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
    {
      code: 'const { VITE_SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL } = import.meta.env;',
      errors: [{ messageId: 'publicPrefixSecret', data: { name: 'VITE_SUPABASE_SERVICE_ROLE_KEY', prefix: 'VITE_' } }],
    },
    {
      code: 'const octokit = new Octokit({ auth: process.env.NEXT_PUBLIC_GITHUB_TOKEN });',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
    {
      code: 'jwt.verify(token, process.env.NEXT_PUBLIC_JWT_SECRET);',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
    {
      code: 'if (input === import.meta.env.VITE_ADMIN_PASSWORD) unlock();',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
    // Server secret read inside a client component
    {
      code: '"use client";\nimport OpenAI from "openai";\nconst openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });',
      errors: [{ messageId: 'serverSecretInClient', data: { name: 'OPENAI_API_KEY' } }],
    },
    {
      code: "'use client';\nconst supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);",
      errors: [{ messageId: 'serverSecretInClient', data: { name: 'SUPABASE_SERVICE_ROLE_KEY' } }],
    },
    {
      code: '"use client";\nconst sig = sign(payload, process.env.WEBHOOK_SIGNING_SECRET);',
      errors: [{ messageId: 'serverSecretInClient' }],
    },
    // LLM SDKs in the browser with the app's own key
    {
      code: 'const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, dangerouslyAllowBrowser: true });',
      errors: [{ messageId: 'browserLlmClient' }],
    },
    {
      code: 'const anthropic = new Anthropic({ dangerouslyAllowBrowser: true });',
      errors: [{ messageId: 'browserLlmClient' }],
    },
    {
      code: 'const groq = new Groq({ apiKey: "gsk_live_abcdef123456", dangerouslyAllowBrowser: true });',
      errors: [{ messageId: 'browserLlmClient' }],
    },
    // Key already reported for its prefix: one finding, not two (either property order)
    {
      code: 'const openai = new OpenAI({ dangerouslyAllowBrowser: true, apiKey: import.meta.env.VITE_OPENAI_API_KEY });',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
    {
      code: 'const openai = new OpenAI({ apiKey: import.meta.env.VITE_OPENAI_API_KEY, dangerouslyAllowBrowser: true });',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
  ],
});

tsRuleTester.run('no-client-exposed-secret (TypeScript)', noClientExposedSecret, {
  valid: [
    'const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;',
  ],
  invalid: [
    {
      code: 'const admin = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!);',
      errors: [{ messageId: 'publicPrefixSecret', data: { name: 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY', prefix: 'NEXT_PUBLIC_' } }],
    },
    {
      code: 'const key = (import.meta.env.VITE_OPENAI_API_KEY as string);',
      errors: [{ messageId: 'publicPrefixSecret' }],
    },
  ],
});
