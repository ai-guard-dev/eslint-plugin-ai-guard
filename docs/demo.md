# Permanent Demo & Documentation Asset Guide

> This document explains the purpose of the `demo/intentional-issues` branch, how the demonstration files work, and how maintainers/contributors can regenerate README screenshots and PR validation workflows.

---

## 1. Why `demo/intentional-issues` Exists

The `demo/intentional-issues` branch is a **permanent, unmerged documentation branch** for `eslint-plugin-ai-guard`.

### Purpose
- **Production Evidence**: Proves that `ai-guard` works in real GitHub Pull Request workflows (PR annotations, GitHub Code Scanning, SARIF uploads, GitHub Actions summaries).
- **Asset Generation**: Serves as the authoritative source for capturing CLI terminal output and GitHub UI screenshots without corrupting `main`.
- **Regression Testing**: Provides realistic, multi-file AI anti-patterns (floating promises, hardcoded secrets, SQL injection, missing auth middleware, empty catch blocks, etc.) to validate rule behavior across updates.

> [!WARNING]
> **DO NOT MERGE THIS BRANCH INTO `main`.**
> This branch is intentionally designed to contain failing lint rules and demo code for documentation purposes.

---

## 2. Structure of Demo Files

The `demo/` directory contains four realistic source files, each focusing on a specific category of AI-generated code mistakes:

| File | Primary Focus | Key Rules Triggered |
|---|---|---|
| `demo/user-service.ts` | Async Correctness | `no-async-array-callback`, `no-floating-promise`, `no-async-without-await` |
| `demo/api-routes.ts` | Security & Auth | `no-hardcoded-secret`, `require-auth-middleware`, `no-sql-string-concat`, `no-console-in-handler` |
| `demo/error-handling.ts` | Reliability & Errors | `no-catch-without-use`, `no-broad-exception`, `no-catch-log-rethrow` |
| `demo/input-validation.ts` | Dynamic Execution | `no-unsafe-deserialize`, `no-eval-dynamic`, `require-auth-middleware` |

---

## 3. How to Trigger Rules Intentionally

If you are expanding the rule set or adding new demonstration cases, follow these guidelines:

1. **Keep examples realistic**: Write code that Copilot, Cursor, or Claude Code actually generate (e.g., `fetch` without `await`, `catch (e: any)` in Express handlers, inline API key strings).
2. **Avoid artificial density**: Aim for 3–5 findings per file so terminal output and PR inline annotations remain readable and clean.
3. **Use helper stubs**: Use non-async stub functions or `Promise.resolve()` for auxiliary helpers so unwanted secondary rule warnings don't clutter the primary demonstration finding.

---

## 4. How to Regenerate Screenshots & Assets

### Local CLI Screenshot Generation

To capture terminal output for `npx ai-guard run --strict`:

```bash
# Checkout the demo branch
git checkout demo/intentional-issues

# Ensure build is up to date
npm run build

# Run scan on the demo directory
npx ai-guard run --path demo --strict
```

**Screenshot Guidelines:**
- Use standard terminal dimensions (e.g., 1000px wide).
- Ensure high contrast with clean terminal colors (Chalk support enabled).
- Crop tightly to the `AI GUARD` banner down to the summary box.

---

### GitHub UI Screenshots & Workflow Regeneration

After a major release or when rule UI output changes:

1. Push updates to `demo/intentional-issues`:
   ```bash
   git push origin demo/intentional-issues --force
   ```
2. Open or update the Pull Request from `demo/intentional-issues` into `main`.
3. Wait for the `AI Guard Scan` workflow to complete.
4. Capture screenshots of:
   - **PR Checks / Inline Annotations**: Show inline annotations under the **Files Changed** tab.
   - **GitHub Action Summary**: Show the summary banner on the workflow run page.
   - **Security → Code Scanning**: Show persistent alerts in GitHub Code Scanning (if enabled).
5. Save captured screenshots into `assets/` and update `README.md`.
6. Leave the Pull Request **open** (or close without merging).

---

## 5. Maintenance Checklist for Releases

When releasing a new version of `eslint-plugin-ai-guard`:

- [ ] Rebase `demo/intentional-issues` on top of `main` if core CLI output format changes.
- [ ] Run `node dist/cli/index.js run --path demo --strict` to verify all demo findings trigger correctly.
- [ ] Push `demo/intentional-issues` and verify GitHub Action PR annotations on the open PR.
- [ ] Update `README.md` screenshots if visual formatting has changed.
