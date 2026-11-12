# Pre-commit gate

Every commit goes through Git, whichever agent or person wrote it. A pre-commit gate catches what agent hooks cannot reach: Copilot, Windsurf, Aider, and people.

```bash
npx ai-guard init-git-hook               # uses husky, lefthook or simple-git-hooks if the project has one
npx ai-guard init-git-hook --check-deps  # also check npm dependencies the commit adds (uses the npm registry)
```

The gate runs `ai-guard verify --staged`:

- **Only what the commit introduces blocks it**: placeholder code, focused or weakened tests, leaked secrets, agent-config issues. Problems already in the code never do.
- **It checks what is staged**, not the working tree. A file you fixed but did not stage is still checked as staged.
- **It never blocks a commit because AI Guard itself failed** (`--allow-unverified`).
- It takes about 3 seconds for a small commit.

People can still skip it with `git commit --no-verify`. The [agent hooks](agents.md) flag agents that try.

## Hook managers

| Detected | What `init-git-hook` does |
|---|---|
| husky (`.husky/` or the `husky` dependency) | Appends to `.husky/pre-commit` |
| lefthook (`lefthook.yml`) | Adds a `pre-commit` command, or prints it when the file already has a `pre-commit` section |
| simple-git-hooks (in `package.json`) | Chains onto the `pre-commit` command; run `npx simple-git-hooks` to apply |
| pre-commit framework (`.pre-commit-config.yaml`) | Prints the entry to add |
| none | Writes `.git/hooks/pre-commit`. It is not shared with your team; prefer husky or lefthook |

Pick one with `--manager husky|lefthook|simple-git-hooks|pre-commit|git`.

## pre-commit framework

```yaml
repos:
  - repo: https://github.com/ai-guard-dev/eslint-plugin-ai-guard
    rev: v1.4.5
    hooks:
      - id: ai-guard-verify
      - id: ai-guard-verify-deps   # optional, uses the npm registry
```

Both hooks run the AI Guard installed in the project (`npm install --save-dev eslint-plugin-ai-guard`).
