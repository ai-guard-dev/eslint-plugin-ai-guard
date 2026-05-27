# Contributing to eslint-plugin-ai-guard

Thank you for contributing! This guide covers everything from reporting issues to shipping
new rules and fixing bugs.

---

## Table of Contents

- [Project Philosophy](#project-philosophy)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting New Rules](#suggesting-new-rules)
- [Development Setup](#development-setup)
- [Adding a New Rule](#adding-a-new-rule)
- [Testing](#testing)
- [SARIF Validation](#sarif-validation)
- [GitHub Workflow Validation](#github-workflow-validation)
- [Release Flow](#release-flow)
- [Commit Conventions](#commit-conventions)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)

---

## Project Philosophy

Before contributing, understand our core values:

1. **Precision over recall** — missing a bug is acceptable; false positives are not
2. **Low false positives** — a rule that fires on valid, idiomatic code 10%+ of the time
   gets weakened or moved to `strict`
3. **Gradual adoption** — `recommended` must be safe for day-one use on any codebase
4. **AI-specific focus** — rules should target patterns that AI tools specifically generate
   more than humans do
5. **GitHub-native** — SARIF, Code Scanning, PR annotations are first-class, not afterthoughts
6. **Self-validating** — ai-guard scans its own source code with the strict preset in CI

---

## Reporting Bugs

Open an issue with:
- The code snippet that triggered the issue (or was missed)
- Which rule fired (or should have fired)
- The preset you're using (`recommended`, `strict`, `security`)
- Your ESLint and Node.js versions
- Whether you can reproduce it with `npx ai-guard run`

**For false positives** — a rule firing on valid code — include:
- The exact code pattern
- Why it's valid (e.g., intentional fire-and-forget, retry pattern)
- Whether `// eslint-disable-next-line ai-guard/rule-name` works as a workaround

We take false positives seriously. If a rule is too noisy, we disable it in `recommended`.

---

## Suggesting New Rules

Before opening a PR for a new rule, open a **rule request issue** with:

1. **The AI anti-pattern** — paste a real example from Copilot/Claude/Cursor/Gemini
2. **Why it's AI-specific** — why is this more common in AI-generated code than human code?
3. **False positive estimate** — how often would this fire on valid, idiomatic code?
4. **Existing coverage** — does `@typescript-eslint/eslint-plugin`, `eslint-plugin-promise`,
   or core ESLint already cover this?

We'll respond with `approved` or `declined` before you write code.

---

## Development Setup

```bash
git clone https://github.com/YashJadhav21/eslint-plugin-ai-guard.git
cd eslint-plugin-ai-guard
npm install

# Run the test suite (667 tests)
npm run test

# TypeScript strict check (must always pass)
npm run typecheck

# Build CJS + ESM bundles
npm run build

# Scan own source with ai-guard (eats our own dog food)
npm run lint:self
```

All four commands must pass before any PR is mergeable.

---

## Adding a New Rule

### 1. Create the rule file

```bash
# Async rules
touch src/rules/async/no-your-rule.ts

# Reliability (error handling)
touch src/rules/reliability/no-your-rule.ts

# Security
touch src/rules/security/no-your-rule.ts

# AI-specific patterns
touch src/rules/ai-patterns/no-your-rule.ts
```

Use an existing rule as a template. Every rule must:
- Use `ESLintUtils.RuleCreator` with the correct docs URL
- Have `type`, `docs.description`, and `messages` in `meta`
- Export a named const AND a default export
- Include AI context in the description (why AI generates this pattern)

### 2. Write tests

```bash
touch tests/rules/no-your-rule.test.ts
```

Tests must:
- Import from `../helpers/rule-tester` (never re-declare `RuleTester`)
- Have **at least 8 valid cases** covering edge cases and false-positive scenarios
- Have **at least 8 invalid cases** covering real AI-generated patterns
- Have `output` on every `invalid` case if the rule has an autofix

```typescript
import { ruleTester } from '../helpers/rule-tester';
import { noYourRule } from '../../src/rules/ai-patterns/no-your-rule';

ruleTester.run('no-your-rule', noYourRule, {
  valid: [
    // 8+ cases covering false-positive scenarios
  ],
  invalid: [
    // 8+ cases covering real AI-generated patterns
  ],
});
```

### 3. Register in 5 places

```typescript
// src/rules/index.ts
import { noYourRule } from './ai-patterns/no-your-rule';
export const allRules = {
  // ...existing
  'no-your-rule': noYourRule,
};

// src/configs/recommended.ts  — start with 'warn' or 'off'
// src/configs/strict.ts        — typically 'error'
// cli/utils/eslint-runner.ts   — add to preset rule maps
// cli/utils/sarif.ts           — add to RULE_DOCS with shortDesc and tags
```

### 4. Write rule documentation

```bash
touch docs/rules/no-your-rule.md
```

Follow the structure of an existing rule doc (e.g., `docs/rules/no-floating-promise.md`).
Every rule doc must include: problem description, why AI generates it, bad example,
good example, severity level, and workflow/CI implications.

### 5. Run full validation

```bash
npm run typecheck    # Zero errors required
npm run test         # All tests must pass
npm run build        # Build must succeed
npm run lint:self    # Zero ai-guard errors on our own source
```

---

## Testing

### Running tests

```bash
npm run test              # Run all 667 tests
npm run test:watch        # Watch mode for development
```

### Test structure

| Directory | Purpose |
|-----------|---------|
| `tests/rules/` | Rule valid/invalid cases via `@typescript-eslint/rule-tester` |
| `tests/cli/` | CLI commands, SARIF output, fail-on logic, JSON output |
| `tests/ci/` | SARIF schema compliance, persistence, GitHub env detection |
| `tests/integration/` | End-to-end scans of Express and Next.js apps |

### Writing tests for SARIF output

If your change touches `cli/utils/sarif.ts`, add regression tests in `tests/ci/sarif-schema.test.ts`
or `tests/ci/sarif-persistence.test.ts`. Key invariants that must never regress:

- `automationDetails.id` must be `"ai-guard"` forever
- `partialFingerprints["ai-guard/v1"]` must be a 64-char SHA-256 hex on every result
- No `uriBaseId` in any `artifactLocation`
- All artifact URIs must be repository-relative POSIX paths

---

## SARIF Validation

To validate SARIF output locally:

```bash
# Generate SARIF
node dist/cli/index.js run --path src --sarif --sarif-output /tmp/test.sarif

# Debug path normalization
node dist/cli/index.js run --path src --sarif --debug-sarif-paths

# Debug persistence identity
node dist/cli/index.js run --path src --sarif --debug-sarif-persistence

# Validate schema compliance
npm run test -- tests/ci/sarif-schema.test.ts
npm run test -- tests/ci/sarif-persistence.test.ts
```

---

## GitHub Workflow Validation

The self-scan workflow (`ai-guard-example.yml`) runs on a schedule. To validate workflow
changes without waiting for the schedule:

1. Push your branch
2. Go to Actions → "AI Guard Self-Scan"
3. Click "Run workflow"
4. Check the SARIF upload and Code Scanning results

If SARIF findings don't appear in Code Scanning, use `--debug-sarif-persistence` in the
workflow step to diagnose the issue.

---

## Release Flow

Releases are automated via the `release.yml` workflow. To cut a release:

```bash
# Patch release (bug fixes)
npm version patch

# Minor release (new features)
npm version minor

# Major release (breaking changes)
npm version major

# Then publish (runs typecheck + test + lint + build automatically)
npm publish
```

**Before releasing:**
- Update `CHANGELOG.md` with the changes
- Ensure all tests pass: `npm run test`
- Ensure typecheck passes: `npm run typecheck`
- Ensure the build passes: `npm run build`

---

## Commit Conventions

We use conventional commits:

```
feat: add no-your-rule for detecting X pattern
fix: false positive in no-floating-promise for retry patterns
docs: add GitHub Actions integration guide
test: add persistence regression tests for SARIF fingerprints
chore: update dependencies
refactor: centralize SARIF path normalization
```

Commit message format: `<type>: <description>` (lowercase, no trailing period).

---

## Code Style

- TypeScript strict mode — no `any` without an explanatory comment
- No external runtime dependencies beyond the existing ones (zero-dep plugin is a feature)
- Explicit return type annotations on all exported functions
- All new code must pass `tsc --noEmit` with zero errors
- Error messages in rules should clearly explain: what the issue is, why it matters,
  and what to do instead

---

## Pull Request Process

1. Open an issue first for non-trivial changes
2. Branch from `main`: `feat/no-your-rule` or `fix/false-positive-no-empty-catch`
3. Ensure all checks pass: `typecheck`, `test`, `build`, `lint:self`
4. Update `CHANGELOG.md` with your change
5. PRs require tests — no tests, no merge
6. If your change touches SARIF generation, include SARIF regression tests

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
