# no-placeholder-implementation

**Category:** AI Patterns | **Severity:** `warn` (recommended), `error` (strict) | **Confidence:** medium

---

## What it does

Flags code an AI agent left unfinished while reporting the task as done:

1. **Elision comments** that stand in for code which is no longer there: `// ... rest of the code`, `// existing code here`, `// other methods unchanged`, `{/* ... rest of the JSX */}`.
2. **Stub bodies**: a function whose body is empty, only logs, or only returns `null` / `[]` / `{}` / `true` / `Promise.resolve()`, next to a `TODO`, `FIXME`, `placeholder` or `stub` comment.
3. **Not-implemented throws**: a function whose whole body is `throw new Error('Not implemented')` (including VS Code's `"Method not implemented."` quick-fix stub and `NotImplementedError`).
4. **Mock data served from production code**: a `mockUsers` / `FAKE_ORDERS` / `dummyProducts` array or object that is returned, sent with `res.json()` / `Response.json()`, or passed to `useState()`.

## Why it matters

Developers consistently report agents that substitute placeholders and mock data when they cannot finish, and present the result as complete ([Replit forum](https://replit.discourse.group/t/feedback-on-claude-s-tendency-to-produce-fallback-mock-implementations/7294)). AI-co-authored PRs carry 1.7x more issues than human ones ([CodeRabbit](https://coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report)).

Elision comments are the most dangerous of these. When a model rewrites a file and writes `// ... existing code ...` instead of the code, **the original code is deleted**. The file still parses, so tests that do not cover the deleted path stay green.

## ❌ Bad

```ts
export function handler(req) {
  // ... existing code ...
  audit(req);
}

export async function getUser(id: string) {
  // TODO: implement database lookup
  return null;
}

function verifyToken(token: string) {
  // TODO: verify the signature
  return true;                       // every token is accepted
}

class PaymentService implements Gateway {
  charge(amount: number): Promise<void> {
    throw new Error('Method not implemented.');
  }
}

const mockUsers = [{ id: 1, name: 'Alice' }];
export async function getUsers() {
  return mockUsers;                  // the feature "works" with fake data
}
```

## ✅ Good

```ts
export async function getUser(id: string) {
  return db.user.findUnique({ where: { id } });
}

// A TODO next to real work is a note, not a stub
function save(user: User) {
  // TODO: add retry with backoff
  return db.save(user);
}
```

## What it does not flag

Each detector has guards against common legitimate code:

| Pattern | Not flagged because |
|---|---|
| `// The rest of the code in this module assumes a connected client.` | Prose: the comment continues past the elision phrase |
| `// ...rest goes to the underlying input` | Describes `...rest` props, not elided code |
| `// Other methods` above real code, `// same as before` after a statement | Section labels; these weak forms only count when no code follows before the block closes |
| `@example` blocks in JSDoc | Elision is a normal writing device in documentation |
| `function noop() {}`, `() => { /* default implementation: no-op */ }` | No unfinished-work marker |
| `throw new Error('Not implemented')` in `abstract` classes, classes named `Base*` / `Abstract*` / `*Base`, or with "subclass" / "override" in the message | Intentional override contract |
| `throw new Error('Not implemented')` inside a branch | Only whole-body throws are stubs; an unsupported-case guard is fine |
| `sampleQuestions`, `placeholderText`, an empty `mockUsers = []` | Not mock-prefixed, or not data |
| Tests, `__mocks__/`, `mocks/`, fixtures, Storybook stories, seed scripts, examples, demos | Placeholders and mock data belong there (elision comments are still reported in tests, since they delete test cases) |

## How to fix

- **Elision:** restore the missing code from version control (`git diff` shows what was removed) or write it out in full.
- **Stubs:** implement the function. If it must exist before it works, throw an explicit error so callers fail loudly, not silently.
- **Mock data:** load it from the real source, or move it into a test fixture or `__mocks__/`.

## Configuration

This rule has no options.

```js
rules: {
  'ai-guard/no-placeholder-implementation': 'warn',
}
```

## CI and agents

This rule is not in the `agent` preset, because agents write stubs on purpose in the middle of a task and per-edit warnings would be noise. It is meant to gate the end of a task: run it in CI or in a `Stop` hook (planned for the MCP `ai_guard_verify_change` tool).
