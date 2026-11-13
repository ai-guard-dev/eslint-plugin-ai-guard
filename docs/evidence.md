# Results on real projects

AI coding agents install packages. Some of those names are invented, some imitate popular packages, and some releases are hijacked. AI Guard checks a package before it is installed. This page shows what those checks did on real projects and real attack data, with the commands to reproduce each result.

Measured on 12 November 2026 with eslint-plugin-ai-guard 1.4.6. The Codex hook test ran on 13 November 2026.

| Result | Number |
|---|---|
| Real dependencies blocked (763 from 15 large OSS repos, 598 from 9 apps) | **0 of 1,361** |
| Names from the 2017 crossenv malware campaign blocked | **34 of 36** |
| Packages that could not be checked | **0** |
| Lint rules with identical results in ESLint and Oxlint | **27 of 27** |

## 1. Real dependencies are not blocked

A check that blocks real packages gets turned off. So blocking is reserved for facts (the package or version does not exist, or npm replaced it with a security placeholder) and for combinations that match how malicious packages look: a look-alike name or an install script on a package that is new or rarely downloaded. Everything else is a warning.

We took every dependency of 15 large open-source projects (React, Next.js, Vite, Astro, SvelteKit, ESLint, Prettier, Storybook, Strapi, Directus, NestJS, TypeORM, undici, Mermaid, Excalidraw) and checked the latest version of each, as an agent running `npm install <name>` that day would get it.

| Result | Packages | What they were |
|---|---:|---|
| Blocked | 0 | None |
| `fresh-release` | 29 | Published in the last 24 hours. Mostly two releases that went out that day: Babel 8.1.2 (7 packages) and Flow 0.340 (4). |
| `deprecated` | 14 | Marked deprecated by their maintainers, for example `@babel/plugin-proposal-class-properties`, `coffee-script`, `@types/cookie` |
| `install-script` | 5 | Run code on install: `playwright-chromium`, `@ast-grep/cli`, `faunadb`, `yorkie`, `@metcoder95/https-pem` |
| `lookalike-name` | 1 | `wcwidth.js`, close to the popular `wcwidth` |
| Clean | 714 | Nothing to report |

763 dependencies, cold cache, 67 seconds. 468 of them are in the bundled list of the 5,000 most-downloaded packages, which need one small request each.

The same check over all declared dependencies of 9 open-source apps (Vercel's AI chatbot and Commerce, create-t3-app, Novel, Taxonomy, chatbot-ui, and three Express and Next.js starters): 598 dependencies, 0 blocked, 15 warnings (7 deprecated, 7 fresh releases, 1 install script).

## 2. A real malware campaign is blocked

In August 2017, a typosquatting campaign published packages such as `crossenv` (for `cross-env`) and `mongose` (for `mongoose`) that sent the installing machine's environment variables, tokens included, to the attacker. npm removed them and left empty placeholders. We checked the 36 names attributed to the campaign.

| Result | Names | Detail |
|---|---:|---|
| Blocked | 34 | npm security placeholder. Where the name imitates a popular package, the message names it: `crossenv` → `cross-env`, `babelcli` → `@babel/cli`, `jquery.js` → `jquery`, `nodemailer.js` → `nodemailer`. |
| Warning | 1 | `openssl.js`: rarely downloaded |
| Passes | 1 | `opencv.js` |

The two that are not blocked are still published by the account that created them in July 2017; npm has not replaced them with placeholders. AI Guard has no fact to block them on, and it does not guess.

## 3. How often popular packages have a release under a day old

A hijacked maintainer account publishes a malicious release like any other release. The compromised axios releases of March 2026 were live for about three hours. pnpm 11 refuses releases younger than a day by default. AI Guard warns about such a release, and its install hook asks before installing one, unless the project's package manager already enforces a cooldown that long.

To pick the window from data, we measured the age of the latest release of each of the 5,000 most-downloaded packages (4,998 answered):

| Latest release younger than | Share of the top 5,000 | Packages |
|---|---:|---:|
| 6 hours | 0.22% | 11 |
| **24 hours (default)** | **3.02%** | **151** |
| 48 hours | 6.44% | 322 |
| 72 hours | 9.20% | 460 |
| 7 days | 13.79% | 689 |

A one-day window catches the axios case while affecting about 3 in 100 installs of popular packages. That is a warning in `verify-deps` and a question in the hook, never a block. `--fresh-hours` changes it; a 6-hour window would affect 0.2%.

When a project configures a release cooldown (npm `min-release-age`, pnpm `minimumReleaseAge`, Yarn `npmMinimalAgeGate`, Bun `minimumReleaseAge`), the check steps aside. In the 9-app run, one app (Vercel's AI chatbot) is on a pnpm version with the one-day default and got no fresh-release warnings. For the others, `verify-deps` prints the one line that turns a cooldown on. A cooldown is the better fix, because it covers every install, including the ones AI Guard never sees.

## 4. Reading a publish time without downloading megabytes

The npm document that lists a package's publish times is large for popular packages (TypeScript's is 16 MB, React's 7 MB), and its `Last-Modified` header moves on every change, including nightly builds, not only on releases. Using it would mean downloading on average 4.3 MB, and up to 31.5 MB, for each popular package with recent activity.

The tarball's own `Last-Modified` header, read with a `HEAD` request that downloads nothing, is the publish time. We compared it with the registry's publish times for 45 versions of 15 packages:

- 38 versions: 1.3 to 12.2 seconds after the publish.
- 7 older versions (published between 2016 and January 2026, for example `left-pad` 1.1.3): later, probably re-uploads.
- None earlier than the publish.

So the header can make a release look newer than it is, never older, and the check cannot miss a fresh release this way. A popular package costs one small manifest request and one `HEAD`.

## 5. Same results in ESLint and Oxlint

AI Guard's 27 lint rules also run as an Oxlint JS plugin. CI lints a fixture set with both linters, every rule at error, and fails on any difference in file, rule or line, or if any rule is never triggered. Result with Oxlint 1.93.0: 49 findings in each, identical, with 27 of 27 rules exercised.

## 6. What this does not show yet

- These are one day's numbers. 12 November was a busy release day (Babel 8.1.2, Flow 0.340, Angular 22.2.6), so fresh-release counts on a quiet day will be lower.
- Hooks in real agents. In the Codex CLI, three behaviors were each run against a real install: the finish gate caught a placeholder function the agent had written, the guard stopped `git commit --no-verify`, and an install of a release from the last day was refused with the reason. Refusing a package that does not exist is covered by tests and uses the same hook path, but was not run in Codex itself. Cursor was not tested. The ChatGPT desktop app was not used: its sandbox blocked network access, so the test ran in the CLI.
- The GitHub Action was run on a real pull request: the check ran, findings were annotated on the changed lines, the job summary was written, and with an `upload-sarif` step the alerts appeared in Code Scanning and kept their identity across reruns.
- The lint rules' precision on application code is not covered here. This page is about the package checks.
- Blocking only on facts means some malicious packages pass with a warning or nothing at all: a new malicious name with no install script and no look-alike to a popular package is reported as new, not blocked. The Codex test showed a real example: `expresss`, registered in 2016 and downloaded about 755 times a week, installed with a look-alike warning instead of a block, because it is neither new nor rarely used. It has no install scripts.

## 7. Reproduce it

Every number above comes from the published CLI. Network checks are opt-in and only query `registry.npmjs.org` and `api.npmjs.org`; packages from a private registry are skipped.

```bash
# the 2017 campaign
npx -p eslint-plugin-ai-guard ai-guard verify-deps crossenv babelcli jquery.js mongose nodemailer.js

# every dependency of a project, at the versions a fresh install would pick
npx -p eslint-plugin-ai-guard ai-guard verify-deps --all --json

# only what a branch adds, as SARIF for GitHub Code Scanning
npx -p eslint-plugin-ai-guard ai-guard verify-deps --base origin/main --sarif-output deps.sarif

# ESLint/Oxlint parity (from a clone of the repository)
npm run build && npm run test:oxlint
```
