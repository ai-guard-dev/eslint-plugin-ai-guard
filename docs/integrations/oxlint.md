# Oxlint

[Oxlint](https://oxc.rs/docs/guide/usage/linter/js-plugins) runs ESLint plugins as JS plugins. AI Guard's rules give the same results in Oxlint as in ESLint, and that is checked on every change: CI runs all 27 rules through both linters over the same files and fails on any difference (`npm run test:oxlint`).

```bash
npm install --save-dev oxlint eslint-plugin-ai-guard
npx ai-guard init-oxlint                  # recommended preset
npx ai-guard init-oxlint --preset strict  # or security, agent
```

`init-oxlint` adds AI Guard to `.oxlintrc.json` and keeps your existing settings; rules you already configure are left alone. The result:

```json
{
  "jsPlugins": ["eslint-plugin-ai-guard"],
  "rules": {
    "ai-guard/no-empty-catch": "error",
    "ai-guard/no-floating-promise": "error"
  }
}
```

Then run `npx oxlint`.

## Notes

- Oxlint's JS plugin support is in alpha. AI Guard is tested against the Oxlint version in its CI (currently 1.93).
- AI Guard's rules run as JavaScript inside Oxlint, so they don't get Oxlint's native speed. On AI Guard's own test corpus Oxlint finished in about half ESLint's time.
- Disable comments: Oxlint reads `oxlint-disable` comments. The AI Guard CLI, hooks and MCP server have their own suppression policy (`--inline-suppressions`).
- The CLI commands (`run`, `changed`, `verify`, hooks) keep using ESLint internally. Oxlint support is for projects that lint with Oxlint.
