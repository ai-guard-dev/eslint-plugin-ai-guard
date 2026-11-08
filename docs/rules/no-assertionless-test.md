# no-assertionless-test

**Category:** AI Patterns | **Severity:** `warn` (recommended, `ai-guard verify`), `error` (strict) | **Confidence:** medium

---

## What it does

Flags test cases, in test files, that contain no assertion. Such a test passes whatever the code does, as long as nothing throws.

## Why it matters

Agents write tests like this to show coverage or to get a failing suite green. `it('creates a user', () => { createUser('a'); })` looks like a test in a diff and adds nothing.

## ❌ Bad

```ts
it('creates a user', async () => {
  const user = await createUser('a');
  console.log(user);
});
```

## ✅ Good

```ts
it('creates a user', async () => {
  const user = await createUser('a');
  expect(user.name).toBe('a');
});
```

## What counts as an assertion

| Style | Examples |
|---|---|
| Matchers and assert libraries | `expect(...)`, `assert.*`, `chai`, `.should`, `sinon.assert.*` |
| Test context | AVA/tap `t.is(...)`, `node:test` `t.assert.*` |
| HTTP tests | supertest `.expect(200)` |
| Queries that throw | Testing Library `getBy*` / `findBy*`, Cypress `cy.*` |
| Helpers | `expectValid()`, `assertOk()`, `verifyX()`, `ensureX()`, and any local function that asserts |
| Manual checks | `throw` inside the test |
| Callback completion | `app.on('x', done)`, `server.close(done)`, or `done()` inside a nested callback. A synchronous `done()` at the end does not count |

## What it does not flag

- Titles that say not throwing is the point: "renders without crashing", "does not throw on empty input", "smoke"
- `it.todo`, `it.skip`, and tests with no body
- Files using `@playwright/test`, where actions auto-wait and fail on their own
- Files that are not test files

## Configuration

This rule has no options.

```js
rules: {
  'ai-guard/no-assertionless-test': 'warn',
}
```

`eslint-plugin-jest` has a similar `expect-expect` rule. This one needs no configuration for the assertion styles above and also works with Mocha, AVA, and `node:test`.
