# verify-deps

Checks npm packages before they are installed. AI assistants recommend packages that don't exist, and attackers register those names ("slopsquatting"). They also copy popular names with one changed letter ("typosquatting"). `verify-deps` looks each package up on the npm registry and flags the ones that don't look like what you meant.

```bash
ai-guard verify-deps                    # dependencies added since HEAD
ai-guard verify-deps --base main        # dependencies this branch adds
ai-guard verify-deps lodash expresss    # packages you name
ai-guard verify-deps --all              # every dependency in the repository
```

| Option | Description |
|---|---|
| `--base <ref>` | Check dependencies added since the merge-base with this ref |
| `--staged` | Check dependencies added in staged changes |
| `--all` | Check every dependency, not only added ones |
| `--json` | Output the report as JSON |
| `--sarif`, `--sarif-output <file>` | SARIF 2.1.0 output (`automationDetails.id: "ai-guard-deps"`) |
| `--fail-on <level>` | Exit 1 on `error` (default), `warning`, or `none` |
| `--min-age <days>` | Packages first published fewer days ago count as new (default 30) |
| `--min-downloads <count>` | Fewer weekly downloads count as rarely used (default 100) |

**Exit codes:** `0` nothing at the `--fail-on` level, `1` findings at that level, `2` some packages could not be checked (no network, rate limit) or Git failed. A check that didn't run is never a pass.

## What counts as added

A dependency is added when its name is in no dependency field of that `package.json` before the change. Changing the version of an existing dependency, or moving it between `dependencies` and `devDependencies`, is not. Every `package.json` in the repository is read, including ones the change created.

Not checked: workspace packages (any `package.json` name in the repository), and entries that aren't fetched from npm by name (`workspace:`, `file:`, `link:`, git, GitHub shorthands, tarball URLs). `npm:` aliases are checked under the real package name.

## Network and privacy

`verify-deps` contacts `registry.npmjs.org` and `api.npmjs.org`. Results are cached for a day (ten minutes for "does not exist", because anyone can register a missing name at any moment) in `<tmp>/ai-guard/registry-cache`; set `AI_GUARD_CACHE_DIR` to change that.

Packages from a **private registry are skipped**, so their names are never sent to the public registry. AI Guard reads the registry settings that npm, pnpm, yarn and bun use: `npm_config_registry` and similar environment variables, `.npmrc` (project and user), `.yarnrc.yml`, `.yarnrc` and `bunfig.toml`. That covers both a default registry and a scope (`@acme:registry=...`). Before reporting that a package doesn't exist, it asks `npm config get registry` too.

Well-known packages (the 5,000 most downloaded, bundled with AI Guard) need one small request each. Others need the package document and its download count.

## Blocking checks

Facts, or combinations that match how malicious packages look. They exit 1 by default.

### package-not-found

The package doesn't exist on npm. Assistants invent plausible names, the same ones again and again, and anyone can register one later with malicious code. If the name resembles a popular package, the message suggests it.

### version-not-found

The exact version or dist-tag doesn't exist. Ranges such as `^4.0.0` aren't resolved, so they never trigger this.

### security-holding

npm took the package down, usually for malware, and replaced it with an empty placeholder (`0.0.1-security`). Installing it does nothing, but the name was used for an attack, so you probably meant something else: `crossenv` → `cross-env`, `mongose` → `mongoose`.

### typosquat-suspect

The name is a near-copy of a popular package and the package is new (first published less than `--min-age` days ago) or rarely used (fewer than `--min-downloads` weekly downloads). Near-copies are one edit away (`expresss`, `lodahs`), differ only by separators (`crossenv`), turn a scope into a prefix (`types-node`), or add a filler affix (`axios-js`, `node-…`).

### install-script-unknown

The package runs code when it is installed (`preinstall`, `install`, `postinstall`, or a native `binding.gyp` build) and is new or rarely used. Install scripts run with your permissions before you can review anything.

## Warnings

One signal on its own. Plenty of good packages have one. Add `--fail-on warning` to fail on them.

### lookalike-name

The name resembles a popular package, but the package is established. Reported only below 10,000 weekly downloads, or, when download counts are unavailable, for packages younger than a year.

### new-package

First published less than `--min-age` days ago.

### low-downloads

Fewer than `--min-downloads` downloads last week.

### install-script

Runs code on install. Native modules do this routinely; make sure you trust the package.

### deprecated

The version is marked deprecated on npm, with the maintainer's message (`request`, `@types/cookie`).

## In Claude Code and MCP

- **Hook:** `ai-guard init-claude --check-installs` adds a check before Claude runs `npm install`, `pnpm add`, `yarn add`, `bun add`, `npx`, `pnpm dlx` or `npm create`. It is off by default. Missing names are blocked and Claude is told why; look-alikes and unknown install scripts ask you first. See [Claude Code integration](../integrations/claude-code.md#package-check-before-install).
- **MCP tool:** `ai_guard_check_package` lets an agent check packages before it adds them. See [MCP server](../mcp-server.md).

## GitHub Actions

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx -p eslint-plugin-ai-guard ai-guard verify-deps --base origin/${{ github.base_ref }} --sarif --sarif-output deps.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: deps.sarif
    category: ai-guard-deps
```
