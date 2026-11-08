# no-undeclared-import

**Category:** Security (supply chain) | **Severity:** `warn` (recommended, security), `error` (strict, agent) | **Confidence:** high

---

## What it does

Flags `import`, `export … from`, `import()`, `require()`, `require.resolve()` and TypeScript `import x = require()` of packages that are not declared in package.json. It reports one of two messages:

| Message | Meaning |
|---|---|
| **Not declared and not installed** | The package may not exist. Verify it on npm before installing it. |
| **Installed but not declared** | A phantom dependency: present only because another package depends on it. A clean install, pnpm, or an upgrade can remove it. |

## Why it matters

Models recommend packages that do not exist. In a USENIX Security 2025 study of 576,000 code samples, **5.2%** of packages suggested by commercial models and **21.7%** by open-source models were hallucinated, and **205,474** unique fake names were produced ([Spracklen et al.](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen)). Attackers register those names on npm with malware in an install script. This is called **slopsquatting**.

The import is the earliest point the mistake is visible. An agent writes `import { helper } from 'react-query-helpers-pro'`, runs `npm install`, and the malware runs. This rule fires on the import line, before the install.

## ❌ Bad

```ts
import { z } from 'zod';                       // not in package.json
import { createHelpers } from 'react-query-helpers-pro';
const express = require('expresss');           // typo-squat shaped
import createDebug from 'debug';               // works today only because another package installs it
```

## ✅ Good

```ts
import React from 'react';                     // declared in dependencies
import { test } from 'vitest';                 // devDependencies count
import type { JSONSchema7 } from 'json-schema'; // @types/json-schema counts
import fs from 'node:fs';                      // Node built-ins
import { Button } from '@/components/Button';  // aliases are not packages
```

## What counts as declared

- `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` and `bundleDependencies`
- **Every package.json from the file up to the repository root** (the directory with `.git`), so monorepo packages can use tooling declared once at the root
- `@types/<name>` for `<name>` (`@types/scope__name` for `@scope/name`)
- The package's own name (self-imports)

## What it does not flag

| Specifier | Why |
|---|---|
| `./x`, `../x`, `/abs/x` | Relative and absolute paths |
| `fs`, `node:fs`, `fs/promises` | Node built-ins |
| `@/x`, `~/x`, `#internal`, `$lib/x` | Common aliases and package.json subpath imports |
| `virtual:x`, `astro:content`, `bun:test`, `npm:x`, `https://…` | Protocol and framework virtual modules |
| `raw-loader!./x`, `./x.css?inline` | Loader syntax and query suffixes (query is stripped) |
| tsconfig / jsconfig `paths` keys | Including configs reached through a relative `extends` |
| `baseUrl` imports and bundler aliases that match a local directory | `components/Button` when `src/components` exists |
| Files with no package.json above them | Not an npm project |

## How to fix

1. Check that the package exists on [npmjs.com](https://www.npmjs.com/) and is the one you meant: look at the publisher, weekly downloads and publish date. A new, rarely downloaded package with a name close to a popular one is a warning sign.
2. Install it so it is declared: `npm install <name>`.
3. If the import should be a local module, fix the path.
4. For a phantom dependency, add it to `dependencies` explicitly.

## Options

```js
rules: {
  'ai-guard/no-undeclared-import': ['error', {
    // Modules provided by the runtime or host rather than npm
    allow: ['vscode', '@internal/*'],
  }],
}
```

## Notes

- The rule is offline and deterministic: it reads package.json and tsconfig files only, never the network. Registry checks (package age, downloads, look-alike names) are planned as the opt-in `ai-guard verify-deps` command.
- package.json is re-read when it changes, so a long-running editor or MCP server sees a dependency an agent just installed.
- It overlaps with `import/no-extraneous-dependencies`. This rule needs no configuration or resolver, understands monorepo roots and tsconfig aliases, and explains the supply-chain risk to the agent.
