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
| `--fresh-hours <hours>` | Versions published fewer hours ago are fresh releases (default 24; `0` turns the check off) |

**Exit codes:** `0` nothing at the `--fail-on` level, `1` findings at that level, `2` some packages could not be checked (no network, rate limit) or Git failed. A check that didn't run is never a pass.

## What counts as added

A dependency is added when its name is in no dependency field of that `package.json` before the change. Changing the version of an existing dependency, or moving it between `dependencies` and `devDependencies`, is not. Every `package.json` in the repository is read, including ones the change created.

Not checked: workspace packages (any `package.json` name in the repository), and entries that aren't fetched from npm by name (`workspace:`, `file:`, `link:`, git, GitHub shorthands, tarball URLs). `npm:` aliases are checked under the real package name.

## Network and privacy

`verify-deps` contacts `registry.npmjs.org` and `api.npmjs.org`. Results are cached in `<tmp>/ai-guard/registry-cache` (set `AI_GUARD_CACHE_DIR` to change that): exact versions, publish times and download counts for a day; package documents, dist-tags such as `latest`, and "does not exist" for ten minutes, because a release or a newly registered name can change the answer at any moment.

Packages from a **private registry are skipped**, so their names are never sent to the public registry. AI Guard reads the registry settings that npm, pnpm, yarn and bun use: `npm_config_registry` and similar environment variables, `.npmrc` (project and user), `.yarnrc.yml`, `.yarnrc` and `bunfig.toml`. That covers both a default registry and a scope (`@acme:registry=...`). Before reporting that a package doesn't exist, it asks `npm config get registry` too.

Well-known packages (the 5,000 most downloaded, bundled with AI Guard) need one small request each, plus a `HEAD` request for the tarball's publish time. Others need the package document and its download count.

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

### fresh-release

The version that would be installed was published less than `--fresh-hours` hours ago (default 24). A hijacked maintainer account publishes a malicious release like any other: the compromised axios 1.14.1 was live for about three hours in March 2026 before it was removed. Waiting a day avoids most of these. The message names the release before it when it is known; install that one, or wait.

Which version is checked: the exact version or dist-tag you asked for, or the latest release. For a range (`^5.2.0`), only when the latest release is in the range, because that is what a fresh install picks. Ranges AI Guard cannot evaluate (`||`, hyphen ranges, `<`) are skipped. A package that is itself new is reported as `new-package` instead.

**Release cooldowns.** If the project's package manager already refuses releases younger than the window, the check is skipped: it would only repeat what the package manager does. A shorter cooldown narrows the check to releases the package manager would still install. AI Guard reads:

| Package manager | Setting | Unit | Exclusions |
|---|---|---|---|
| npm 11.10+ | `min-release-age` in `.npmrc` (or `npm_config_min_release_age`) | days | `min-release-age-exclude` |
| pnpm 10.16+ | `minimumReleaseAge` in `pnpm-workspace.yaml` (or `minimum-release-age` in `.npmrc`); pnpm 11 defaults to 1440 when `packageManager` names it | minutes | `minimumReleaseAgeExclude` |
| Yarn 4.10+ | `npmMinimalAgeGate` in `.yarnrc.yml` (or `YARN_NPM_MINIMAL_AGE_GATE`) | minutes, or `1d`, `12h` | `npmPreapprovedPackages` |
| Bun 1.3+ | `minimumReleaseAge` under `[install]` in `bunfig.toml` | seconds | `minimumReleaseAgeExcludes` |

The package manager is taken from `packageManager` in `package.json`, then from the lockfile. When no cooldown is configured, `verify-deps` prints how to turn one on (with `--all`, or when it finds a fresh release); the JSON report has `packageManager`, `cooldown` and `cooldownTip`. A cooldown is the better fix: it covers every install, including the ones AI Guard never sees.

**How the publish time is read.** Documents of popular packages can be tens of megabytes. For those, AI Guard sends a `HEAD` request for the version's tarball and reads its `Last-Modified` header. Compared with the registry's own publish times, it is a few seconds later for current releases and never earlier, so the check cannot miss a fresh release this way. Some re-uploaded old tarballs carry a later date; that can only cause a warning, never hide one.

## In Claude Code and MCP

- **Hook:** `ai-guard init-claude --check-installs` adds a check before Claude runs `npm install`, `pnpm add`, `yarn add`, `bun add`, `npx`, `pnpm dlx` or `npm create`. It is off by default. Missing names are blocked and Claude is told why; look-alikes, unknown install scripts and releases from the last day ask you first. `AI_GUARD_FRESH_HOURS` changes the window for the hook (`0` turns it off). The cooldown is read for the package manager that runs the install; `npx` and `dlx` downloads are not assumed to honour it. See [Claude Code integration](../integrations/claude-code.md#package-check-before-install).
- **MCP tool:** `ai_guard_check_package` lets an agent check packages before it adds them (`freshHours` sets the window). A fresh release makes `safeToInstall` false. See [MCP server](../mcp-server.md).

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
