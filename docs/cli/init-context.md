# ai-guard init-context

The `init-context` command generates instruction files for popular AI coding agents (Claude Code, Cursor, GitHub Copilot). These instruction files guide the tools to proactively avoid the 18 most common AI-generated code anti-patterns that `ai-guard` checks for.

This prevents the anti-patterns from being generated in the first place, saving you time.

---

## Usage

```bash
npx ai-guard init-context
```

This will open an interactive prompt:

```text
? Which AI agents do you use? (space to select, enter to confirm)
instructions
◯ Claude Code (writes CLAUDE.md)
◯ Cursor (writes .cursorrules)
◯ GitHub Copilot (writes .github/copilot-instructions.md)
◯ All three (recommended)
```

Select the agents you use. 

### Generating for all targets

To skip the interactive prompt and generate for all three agents automatically:

```bash
npx ai-guard init-context --all
```

---

## Output Files

Depending on your selection, this command creates:

- **`CLAUDE.md`**: Automatically read by Claude Code CLI and Claude Desktop when working in the repository.
- **`.cursorrules`**: Automatically read by Cursor IDE to steer all AI chat and completion.
- **`.github/copilot-instructions.md`**: Automatically read by GitHub Copilot Chat when answering questions in the IDE.

Each generated file contains code examples in the specific format preferred by its target agent.

---

## Options

| Flag | Description |
|---|---|
| `--all` | Generate instruction files for all supported agents, skipping the interactive prompt. |
| `--force` | Overwrite existing files automatically (useful for updating rules after an `eslint-plugin-ai-guard` version upgrade). |
| `--rules <categories>` | Generate instructions only for specific rule categories. Comma-separated list of: `async`, `security`, `error-handling`, `quality`. |
| `--dry-run` | Preview the content that would be generated without actually writing any files to disk. |

---

## Examples

**Preview the output without writing files:**
```bash
npx ai-guard init-context --all --dry-run
```

**Force upgrade existing instruction files:**
```bash
npx ai-guard init-context --all --force
```

**Only generate security-related instructions for Cursor:**
```bash
npx ai-guard init-context --rules security
```

---

## What's Next

- [run →](run.md) — Scan your project for issues
- [CLI Overview →](overview.md) — See all CLI commands
