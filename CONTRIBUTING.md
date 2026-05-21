# Contributing to eslint-plugin-ai-guard

Thank you for taking the time to contribute! This document explains how to report issues, suggest new rules, and submit pull requests.

---

## Project Philosophy

Before contributing, please understand our core values:

1. **Precision over recall** — we tolerate missing some bugs rather than creating noise
2. **Low false positives** — if a rule fires on valid, idiomatic code too often, it should be weakened or disabled in `recommended`
3. **Gradual adoption** — `recommended` must be safe for day-one use; controversial rules belong in `strict`
4. **AI-specific focus** — only rules that target patterns AI tools specifically get wrong

---

## Reporting Bugs

Open an issue with:
- The code snippet that triggered the issue (or was missed)
- Which rule fired (or should have fired)
- The preset you're using (`recommended`, `strict`, `security`)
- Your ESLint and Node.js versions

For **false positives** (rule fires on valid code), please include:
- The exact code pattern
- Why it's valid (e.g., intentional fire-and-forget, retry pattern)
- Whether an inline suppression (`// eslint-disable-next-line ai-guard/rule-name`) works as a workaround

We take false positives very seriously. A rule that fires on valid code 10%+ of the time will be removed from `recommended`.

---

## Suggesting New Rules

Before opening a PR for a new rule, open a **rule request issue** with:

1. **The AI anti-pattern** — paste a real example from Copilot/Claude/Cursor/Gemini
2. **Why it's AI-specific** — why is this pattern more common in AI-generated code than human code?
3. **False positive estimate** — how often would this fire on valid, idiomatic code?
4. **Existing coverage** — does `@typescript-eslint/eslint-plugin`, `eslint-plugin-promise`, or core ESLint already cover this?

We'll respond with `approved` or `declined` before you write code.

---

## Development Setup

```bash
git clone https://github.com/YashJadhav21/eslint-plugin-ai-guard.git
cd eslint-plugin-ai-guard
npm install
npm run test          # Run all tests
npm run typecheck     # TypeScript check
npm run build         # Build bundles
npm run lint:self     # Scan own source with ai-guard
```

---

## Adding a New Rule

### 1. Create the rule file

```bash
# Example: adding a new AI pattern rule
touch src/rules/ai-patterns/no-your-rule.ts
```

Use the existing rules as templates. Every rule must:
- Use `ESLintUtils.RuleCreator` with the correct docs URL
- Have a `type`, `docs.description`, and `messages` in `meta`
- Export a named const AND a default export
- Include AI context in the description (why AI generates this pattern)

### 2. Write tests

```bash
touch tests/rules/no-your-rule.test.ts
```

Tests must:
- Import from `../helpers/rule-tester` (not declare their own RuleTester)
- Have **at least 8 valid cases** covering edge cases and false-positive scenarios
- Have **at least 8 invalid cases** covering real AI-generated patterns
- Cover intentional suppression patterns where relevant

```typescript
import { ruleTester } from '../helpers/rule-tester';
import { noYourRule } from '../../src/rules/ai-patterns/no-your-rule';

ruleTester.run('no-your-rule', noYourRule, {
  valid: [
    // 8+ cases
  ],
  invalid: [
    // 8+ cases
  ],
});
```

### 3. Register the rule

Add to `src/rules/index.ts`:
```typescript
import { noYourRule } from './ai-patterns/no-your-rule';

export const allRules = {
  // ...existing
  'no-your-rule': noYourRule,
};
```

### 4. Add to configs

- `src/configs/recommended.ts` — decide the severity (start with `'warn'` or `'off'`)
- `src/configs/strict.ts` — typically `'error'`
- `cli/utils/eslint-runner.ts` — add to preset maps
- `cli/commands/report.ts` — add to `RULE_META`
- `cli/utils/logger.ts` — add to `RULE_CATEGORY`

### 5. Write documentation

```bash
touch docs/rules/no-your-rule.md
```

Follow the structure of an existing rule doc (see `docs/rules/no-dead-branch.md`).

### 6. Run validation

```bash
npm run typecheck    # Must pass
npm run test         # Must pass (all existing + your new tests)
npm run build        # Must pass
npm run lint:self    # Should show 0 errors (we eat our own dog food)
```

---

## Code Style

- TypeScript strict mode — no `any` without a comment explaining why
- No external runtime dependencies (zero dep plugin is a feature)
- Prefer explicit type annotations on exported functions
- All new code passes `tsc --noEmit`

---

## Pull Request Process

1. Open an issue first for non-trivial changes
2. Branch from `main` with a descriptive name: `feat/no-your-rule` or `fix/false-positive-no-empty-catch`
3. Ensure all checks pass: `typecheck`, `test`, `build`, `lint:self`
4. Update `CHANGELOG.md` with your change
5. PRs must include tests — no tests, no merge

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
