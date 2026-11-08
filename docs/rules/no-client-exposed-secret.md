# no-client-exposed-secret

**Category:** Security | **Severity:** `error` (recommended, strict, security, agent) | **Confidence:** high

---

## What it does

Flags server secrets that end up readable in the browser:

1. **Secret env vars with a public bundler prefix.** `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`, `VUE_APP_`, `GATSBY_` and `PUBLIC_` variables are inlined into client JavaScript at build time, so `NEXT_PUBLIC_OPENAI_API_KEY` is published to every visitor.
2. **Server secrets read in `"use client"` files.** `process.env.SUPABASE_SERVICE_ROLE_KEY` in a client component is `undefined` at runtime, and the usual "fix" (adding `NEXT_PUBLIC_`) leaks it.
3. **LLM SDK clients created with `dangerouslyAllowBrowser: true` and an app-owned key** (an env var, a string literal, or no `apiKey` at all).

## Why it matters

AI app builders make this mistake constantly. When a secret is "undefined" in the browser, the quickest fix an agent finds is a public prefix. The consequences are well documented:

- Lovable-generated apps exposed 303 endpoints across 170 projects because the Supabase key in the browser could read every table ([CVE-2025-48757](https://www.superblocks.com/blog/lovable-vulnerabilities)).
- A scan of 5 million apps found more than 42,000 live tokens in their JavaScript bundles ([Intruder](https://www.bleepingcomputer.com/news/security/what-5-million-apps-revealed-about-secrets-in-javascript/amp/)).

Secret scanners find these keys after they ship. This rule catches the pattern at the line that causes it.

## ❌ Bad

```ts
// Inlined into the client bundle
const admin = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!);
const openai = new OpenAI({ apiKey: import.meta.env.VITE_OPENAI_API_KEY });
const { VITE_STRIPE_SECRET_KEY } = import.meta.env;

// "use client" file: undefined at runtime, and one rename away from a leak
'use client';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The SDK's own warning flag, with the app's key
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, dangerouslyAllowBrowser: true });
```

## ✅ Good

```ts
// app/api/chat/route.ts — the secret stays on the server
export async function POST(req: Request) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // ...stream the result back to the client
}

// Keys that are designed to be public are fine
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const stripe = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

// Bring-your-own-key apps: the key comes from the user, not the build
const client = new OpenAI({ apiKey: userSuppliedKey, dangerouslyAllowBrowser: true });
```

## What it does not flag

The rule decides by name, and it is deliberately narrow about what counts as a server-only secret:

| Not flagged | Why |
|---|---|
| `*_ANON_KEY`, `*_PUBLISHABLE_KEY`, `*_PUBLIC_KEY`, `*_SITE_KEY` | Public by design (Supabase, Stripe, Clerk, reCAPTCHA) |
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `VITE_GOOGLE_MAPS_API_KEY`, `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | Generic `*_API_KEY` / `*_ACCESS_TOKEN` names are often browser keys, so only provider keys that are always secret (OpenAI, Anthropic, Groq, Gemini, Resend, …) are flagged |
| `NEXT_PUBLIC_PASSWORD_MIN_LENGTH`, `NEXT_PUBLIC_SECRET_SANTA_ENABLED` | The last word describes a setting, not a secret |
| `process.env[name]` | Dynamic lookups cannot be judged statically |
| `dangerouslyAllowBrowser` with `apiKey: someVariable` | Treated as a user-supplied key |

Always flagged: names containing `SECRET`, `PASSWORD`, `SERVICE_ROLE`, `PRIVATE_KEY`, `SIGNING_KEY`, `AUTH_TOKEN`, database connection strings (`DATABASE_URL`, `MONGODB_URI`, …), and provider tokens such as `GITHUB_TOKEN`.

## How to fix

1. Remove the public prefix and read the secret only in server code: an API route, server action, route handler or edge function.
2. Call that server code from the client.
3. **Rotate the key** if it was ever deployed. Removing it from the code does not remove it from bundles that are already cached.

## Options

```js
rules: {
  'ai-guard/no-client-exposed-secret': ['error', {
    // Env var names you know are safe to expose
    allow: ['NEXT_PUBLIC_DEMO_SECRET'],
  }],
}
```

## CI and agents

This rule is in the `agent` preset: an agent that writes `NEXT_PUBLIC_OPENAI_API_KEY` is told immediately, before the key reaches a commit. In SARIF it is tagged `security` and `secrets`.
