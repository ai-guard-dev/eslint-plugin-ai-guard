# CLI Overview

The `ai-guard` CLI makes it instant to scan any JavaScript or TypeScript project for AI-generated code patterns — with **zero ESLint configuration required.**

---

## Installation

The CLI is included in the `eslint-plugin-ai-guard` package:

```bash
# Run without installing (recommended for first use)
npx ai-guard run

# Or install globally
npm install -g eslint-plugin-ai-guard
ai-guard run
```

---

## Commands

| Command | Description | When to use |
|---|---|---|
| [`run`](run.md) | Scan your project | First thing, any time |
| [`init`](init.md) | Auto-configure ESLint | Before editor integration |
| [`init-context`](init-context.md) | Generate AI agent rules | To configure Claude/Cursor/Copilot |
| [`doctor`](doctor.md) | Diagnose setup issues | When something isn't working |
| [`preset`](preset.md) | Interactive preset selector | To change rule severity levels |
| [`ignore`](ignore.md) | Add default ignores to config | To suppress dist/build noise |
| [`baseline`](baseline.md) | Save + diff issues over time | For gradual adoption |

---

## Global Options

```
ai-guard [command] --help     Show help for any command
ai-guard --version            Print version
```

---

## Quick Examples

```bash
# Zero config — scan current directory
npx ai-guard run

# Scan a specific path
npx ai-guard run --path src/api

# Scan a single file
npx ai-guard run --path src/api/users.ts

# Strict mode (all 18 rules at error)
npx ai-guard run --strict

# Security scan only
npx ai-guard run --security

# CI mode — JSON output, fail if any warnings
npx ai-guard run --json --max-warnings 0

# Set up ESLint config automatically
npx ai-guard init

# Generate rules for Claude Code, Cursor, and Copilot
npx ai-guard init-context --all

# Debug setup issues
npx ai-guard doctor

# Gradual adoption baseline
npx ai-guard baseline --save
npx ai-guard baseline --check
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | No errors found (warnings may exist) |
| `1` | Errors found, or `--max-warnings` exceeded |

---

## Next Steps

- [run →](run.md) — Full `run` command documentation
- [init →](init.md) — Setting up ESLint integration
- [init-context →](init-context.md) — Generating rules for AI agents
- [doctor →](doctor.md) — Diagnosing setup issues
- [preset →](preset.md) — Switching recommended/strict/security presets
- [ignore →](ignore.md) — Adding default ignore patterns
- [baseline →](baseline.md) — Tracking only newly introduced issues
- [Getting Started Guide →](../guides/getting-started.md)
