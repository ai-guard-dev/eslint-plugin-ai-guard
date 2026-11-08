# no-test-env-branch

**Category:** AI Patterns | **Severity:** `warn` (recommended), `error` (strict, `ai-guard verify`) | **Confidence:** medium

---

## What it does

Flags production functions that return a hard-coded result when they detect a test runner. The tests then pass without running the real code.

It recognizes `NODE_ENV === 'test'` (also `APP_ENV`, `import.meta.env.MODE`), `process.env.VITEST`, `JEST_WORKER_ID`, `typeof jest !== 'undefined'`, and variables or local functions that wrap those checks.

## Why it matters

Special-casing the test environment is one of the most direct ways for an agent to turn a red test green. A check like `verifySignature` that returns `true` under test will pass its whole suite and verify nothing.

## ❌ Bad

```ts
export async function verifySignature(payload, signature) {
  if (process.env.NODE_ENV === 'test') return true;
  return crypto.verify(payload, signature);
}

const fetchRates = async () =>
  process.env.VITEST ? { USD: 1 } : (await fetch(url)).json();
```

## ✅ Good

```ts
// Keep one code path, and mock the dependency in the test.
export async function verifySignature(payload, signature, verifier = crypto) {
  return verifier.verify(payload, signature);
}
```

## What it does not flag

| Pattern | Why |
|---|---|
| `if (NODE_ENV !== 'test') app.listen(3000)` | Skips a side effect; returns nothing |
| `if (NODE_ENV === 'test') return;` or `return null;` | "Do nothing in tests", not a fabricated result |
| `NODE_ENV === 'test' ? 'silent' : 'info'`, or `if (isTest) return 'silent'; return 'info';` | Choosing between constants is configuration |
| `if (isTest) return createTestDb();` | Switching a dependency still runs the real code against it |
| Module-level switches | Configuration, not a shortcut in a function |
| `import.meta.vitest` blocks | Vitest in-source tests |
| Tests, mocks, fixtures, setup files, `test-utils`, `*.config.*` | Not production code |

## Configuration

This rule has no options.

```js
rules: {
  'ai-guard/no-test-env-branch': 'warn',
}
```
