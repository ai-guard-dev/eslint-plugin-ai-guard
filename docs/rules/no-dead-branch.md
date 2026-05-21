# `no-dead-branch`

**Category:** AI Patterns  
**Default severity:** `warn` (recommended), `error` (strict)  
**Autofix:** None

---

## Why this rule exists

AI coding assistants frequently generate dead branches as leftover scaffolding — conditions that could never be false (or never be true) based purely on the syntax of the expression.

Common patterns from AI-generated code:

```js
// AI-generated guard that always executes
if (true) {
  doSomething();
}

// AI-generated debug check that never runs
if (false) {
  console.log('debug mode');
}

// AI-generated tautology in generated validation logic
if (x === x) {
  proceed();
}

// AI-generated contradiction in generated permission checks
if (hasAdmin && !hasAdmin) {
  // never fires
}
```

These branches create **dead code** — code that either always runs (making the condition meaningless noise) or never runs (making the branch unreachable and misleading).

---

## What this rule checks

The rule detects conditions that are statically always-true or always-false based on their syntax alone:

| Pattern | Reason |
|---------|--------|
| `if (true)` | Boolean literal — always true |
| `if (false)` | Boolean literal — always false |
| `if (0)` | Falsy number literal — always false |
| `if ('')` | Falsy string literal — always false |
| `if (x === x)` | Same identifier compared to itself — always true |
| `if (x !== x)` | Same identifier compared to itself — always false |
| `if (x \|\| !x)` | Self-tautology — always true |
| `if (x && !x)` | Self-contradiction — always false |
| `while (false)` | Loop that never executes |
| `do { } while (false)` | Dead loop condition |
| `cond ? a : b` (where cond is static) | Dead ternary branch |

### Intentional patterns that are NOT flagged

`while (true)` is **intentional** in JavaScript — it's used for event loops, retry mechanisms, server poll loops, and infinite processing queues. This rule specifically exempts it.

---

## Examples

### ❌ Incorrect (will be flagged)

```js
// Always-true: the if branch always executes
if (true) {
  processData();
}

// Always-false: this code is unreachable
if (false) {
  sendEmergencyAlert();
}

// Tautology: x || !x is always true
if (isReady || !isReady) {
  proceed();
}

// Contradiction: x && !x is always false
if (hasPermission && !hasPermission) {
  allowAccess(); // never runs
}

// Self-comparison: always true
if (userId === userId) {
  saveRecord();
}

// Ternary with dead branch
const result = false ? computeA() : computeB();

// Dead loops
while (false) { processQueue(); }
do { runStep(); } while (false);
```

### ✅ Correct (will not be flagged)

```js
// Runtime condition
if (x > 0) {
  doSomething();
}

// while (true) — intentional event loop pattern
while (true) {
  await processNextEvent();
}

// Normal boolean variable
const active = getStatus();
if (active) {
  run();
}

// Different identifiers compared at runtime
if (user.role === admin.role) {
  grantAccess();
}

// Logical AND with different variables
if (isLoggedIn && hasPermission) {
  proceed();
}
```

---

## Configuration

This rule takes no options. Enable or disable it at the preset level:

```js
// eslint.config.mjs
export default [
  {
    plugins: { 'ai-guard': aiGuard },
    rules: {
      'ai-guard/no-dead-branch': 'warn',  // or 'error' or 'off'
    },
  },
];
```

---

## Frequently asked questions

**Why doesn't it flag `while (true)`?**

`while (true)` is a deliberate and common JavaScript idiom for event loops, server polling, and retry mechanisms. Flagging it would cause high false-positive noise. If you use this pattern and want to flag it anyway, you can use a local `// eslint-disable-next-line` comment.

**Will this catch `if (1)` (truthy number)?**

Yes — `if (1)` is falsy-safe but always-truthy, and will be flagged as `alwaysTrue`.

**What about `if (someObject)`?**

No. The rule only catches syntactically obvious dead branches (literals, self-comparisons, self-tautologies). It doesn't do type inference.

---

## Further reading

- [MDN: Boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Boolean)
- [OWASP: Dead Code](https://owasp.org/www-community/vulnerabilities/Unreachable_Code)
