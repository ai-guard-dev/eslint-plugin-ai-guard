# no-tautological-assertion

**Category:** AI Patterns | **Severity:** `warn` (recommended), `error` (strict, `ai-guard verify`) | **Confidence:** high

---

## What it does

Flags assertions that pass no matter what the code does:

- A constant checked against a constant: `expect(true).toBe(true)`, `expect(1 + 1).toBe(2)`, `assert.equal(2, 2)`, `assert(true)`
- A value compared with itself: `expect(result).toEqual(result)`, `assert.strictEqual(x, x)`
- A constant with no expected value: `expect('ok').toMatchSnapshot()`

It works with Jest, Vitest, Chai (`expect(true).to.be.true`), and Node's `assert`, including aliased and destructured imports.

## Why it matters

Agents asked to make a failing test pass sometimes edit the test instead of the code. In the [ImpossibleBench](https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1) study, models frequently exploited tests rather than solving the task. A tautological assertion keeps a test green and the coverage number up while checking nothing.

## ❌ Bad

```ts
it('calculates tax', () => {
  expect(true).toBe(true);
});

const total = calculateTotal(cart);
expect(total).toEqual(total);
```

## ✅ Good

```ts
it('calculates tax', () => {
  expect(calculateTax(100, 0.2)).toBe(20);
});
```

## What it does not flag

| Pattern | Why |
|---|---|
| `expect(200).toBe(res.status)` | The constant is on the wrong side, but the assertion still checks a value the code produced |
| `expect(true).toBe(false)` after a call that should throw | Always fails, so it can't hide anything; it's a "should not reach here" sentinel |
| `expect(next()).toBe(next())` | Two calls can return different values |
| `expect(x).not.toBe(x)` | Always fails |
| `expect(typeof window).toBe('object')` | Depends on the environment |
| `types.test.ts`, `*.test-d.ts`, `type-tests/` | Type-level tests check at compile time; runtime asserts there are placeholders by design |

## Configuration

This rule has no options.

```js
rules: {
  'ai-guard/no-tautological-assertion': 'warn',
}
```
