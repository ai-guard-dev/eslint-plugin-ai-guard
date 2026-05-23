import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { detect, isFlat, isLegacy, requiresFlatConfig } from '../utils/detector.js';
import { log } from '../utils/logger.js';
import { readConfig } from '../utils/config-manager.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
  /** Exact command or action to fix — shown as cyan */
  fix?: string;
  /** Additional explanation shown below fix as gray */
  note?: string;
}

// ─── Programmatic config load probe ──────────────────────────────────────────

async function probeConfigLoad(
  configPath: string,
  cwd: string,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const { ESLint } = await import('eslint') as { ESLint: any };
    const eslint = new ESLint({ cwd, overrideConfigFile: configPath });
    await eslint.lintText('', { filePath: path.join(cwd, '_probe_.js') });
    return { ok: true, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // "no files" or "probe" errors are not config errors
    if (
      msg.includes('No files') ||
      msg.includes('no files') ||
      msg.includes('_probe_')
    ) {
      return { ok: true, error: null };
    }
    // Strip stack frames from message
    const clean = msg.replace(/\s+at\s+.+/gm, '').trim();
    return { ok: false, error: clean };
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose your ai-guard setup and print actionable fixes')
    .action(async () => {
      const cwd = process.cwd();

      log.banner('AI GUARD DOCTOR');
      log.info('Checking your environment…');
      log.blank();

      const env = detect(cwd);
      const checks: CheckResult[] = [];

      // ── Check 1: ESLint installed ──────────────────────────────────────────

      checks.push({
        label: 'ESLint installed',
        pass: env.eslintVersion !== null,
        detail: env.eslintVersion
          ? `ESLint ${env.eslintVersion}`
          : 'Not found in node_modules',
        fix: env.eslintVersion
          ? undefined
          : 'npm install --save-dev eslint',
      });

      // ── Check 2: Plugin installed ──────────────────────────────────────────

      checks.push({
        label: 'eslint-plugin-ai-guard installed',
        pass: env.pluginInstalled,
        detail: env.pluginInstalled
          ? 'Found in node_modules'
          : 'Not found in node_modules',
        fix: env.pluginInstalled
          ? undefined
          : 'npm install --save-dev eslint-plugin-ai-guard',
      });

      // ── Check 3: ESLint config exists ─────────────────────────────────────

      const hasConfig = env.configType !== 'none';
      checks.push({
        label: 'ESLint config present',
        pass: hasConfig,
        detail: hasConfig
          ? `${path.relative(cwd, env.configPath ?? '')} (${env.configType})`
          : 'No eslint.config.* or .eslintrc.* found',
        fix: hasConfig
          ? undefined
          : 'ai-guard init',
        note: hasConfig
          ? undefined
          : 'This will generate the correct config format for your ESLint version',
      });

      // ── Check 4: Config type matches ESLint version ────────────────────────

      if (env.eslintMajor !== null && hasConfig) {
        const needsFlat = requiresFlatConfig(env.eslintMajor);
        const actuallyFlat = isFlat(env.configType);
        const actuallyLegacy = isLegacy(env.configType);
        const aligned =
          (needsFlat && actuallyFlat) || (!needsFlat && actuallyLegacy);

        checks.push({
          label: 'Config format matches ESLint version',
          pass: aligned,
          detail: aligned
            ? `${actuallyFlat ? 'Flat config' : 'Legacy config'} ✔ matches ESLint v${env.eslintMajor}`
            : `ESLint v${env.eslintMajor} requires ${needsFlat ? 'flat config (eslint.config.*)'
                : 'legacy config (.eslintrc.*)'} but found ${actuallyFlat ? 'flat' : 'legacy'} config`,
          fix: aligned
            ? undefined
            : needsFlat
            ? 'ai-guard init  (will create eslint.config.mjs)'
            : 'npm install --save-dev eslint@8  (or upgrade to v9 and run ai-guard init)',
          note: aligned
            ? undefined
            : needsFlat
            ? 'ESLint v9 ignores .eslintrc.* files. The flat config must be used.'
            : undefined,
        });
      }

      // ── Check 5: Plugin wired in config ───────────────────────────────────

      if (hasConfig && env.configPath) {
        let pluginWired = false;
        let isInvalidConfig = false;
        let readError: string | null = null;
        try {
          const { isInvalidAiGuardConfig } = await import('../utils/config-manager.js');
          const content = readConfig(env.configPath);
          pluginWired =
            content.includes('ai-guard') ||
            content.includes('eslint-plugin-ai-guard');
          isInvalidConfig = isInvalidAiGuardConfig(content);
        } catch (err) {
          readError = err instanceof Error ? err.message : String(err);
        }

        checks.push({
          label: 'Plugin wired in config',
          pass: pluginWired && !isInvalidConfig,
          detail: readError
            ? `Could not read config: ${readError}`
            : isInvalidConfig
            ? 'Invalid ai-guard config detected (wrong export usage)'
            : pluginWired
            ? 'eslint-plugin-ai-guard referenced in config'
            : `Config exists but ai-guard plugin not found in ${path.relative(cwd, env.configPath)}`,
          fix: isInvalidConfig || (!pluginWired && !readError)
            ? 'ai-guard init  (will patch/repair your existing config)'
            : undefined,
        });
      }

      // ── Check 6: No conflicting configs ───────────────────────────────────

      checks.push({
        label: 'No conflicting config files',
        pass: !env.hasConflictingConfigs,
        detail: env.hasConflictingConfigs
          ? `Conflicting config detected:\n${env.allConfigPaths.map((p) => `       ${path.relative(cwd, p)}`).join('\n')}`
          : 'Only one config format detected',
        fix: env.hasConflictingConfigs
          ? 'Remove or backup legacy config'
          : undefined,
        note: env.hasConflictingConfigs
          ? 'ESLint v9 silently ignores .eslintrc.* when a flat config exists. This can cause confusion.'
          : undefined,
      });

      // ── Check 7: No nuke-ignore pattern ───────────────────────────────────

      if (hasConfig && env.hasNukeIgnore) {
        checks.push({
          label: 'No "ignore everything" pattern',
          pass: false,
          detail: `Config contains "**/*" ignore pattern — this silently prevents all files from being linted`,
          fix: 'ai-guard init  (will remove the pattern and replace with safe ignores)',
        });
      }

      // ── Check 8: ESLint version compatible ────────────────────────────────

      const versionOk = env.eslintMajor !== null && env.eslintMajor >= 8;
      checks.push({
        label: 'ESLint version compatible',
        pass: versionOk,
        detail: versionOk
          ? `v${env.eslintMajor} ✔ (requires ≥ v8)`
          : env.eslintMajor !== null
          ? `v${env.eslintMajor} is too old — requires ESLint ≥ 8`
          : 'ESLint not installed',
        fix: versionOk ? undefined : 'npm install --save-dev eslint@latest',
      });

      // ── Check 9: Programmatic config load ─────────────────────────────────
      //  Only run this if we have a config and all prior config checks passed,
      //  so we don't produce redundant errors.

      const configChecksPass = checks.every((c) => c.pass);
      if (hasConfig && env.configPath && env.pluginInstalled && configChecksPass) {
        log.info('Probing ESLint config load…');
        const probe = await probeConfigLoad(env.configPath, cwd);

        checks.push({
          label: 'ESLint config loads without errors',
          pass: probe.ok,
          detail: probe.ok
            ? 'ESLint loaded config successfully'
            : probe.error ?? 'Unknown error',
          fix: probe.ok
            ? undefined
            : `Check syntax in ${path.relative(cwd, env.configPath)}`,
          note: probe.ok
            ? undefined
            : 'Run: ai-guard init --dry-run  to preview a fresh config',
        });
      }

      // ── Check 10: @typescript-eslint/utils resolvable at runtime ──────────
      {
        let utilsOk = false;
        let utilsVersion: string | null = null;
        try {
          const { createRequire } = await import('module');
          const req = createRequire(path.join(cwd, 'package.json'));
          const pkgPath = req.resolve('@typescript-eslint/utils/package.json');
          const pkg = JSON.parse(
            (await import('fs')).readFileSync(pkgPath, 'utf-8'),
          ) as { version?: string };
          utilsVersion = pkg.version ?? null;
          utilsOk = true;
        } catch {
          // Not found
        }

        if (!utilsOk) {
          // Fall back to checking our own package location
          try {
            const selfDir = path.dirname(
              new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
            );
            const pkgPath = path.join(selfDir, '../../node_modules/@typescript-eslint/utils/package.json');
            if ((await import('fs')).existsSync(pkgPath)) {
              utilsOk = true;
            }
          } catch { /* skip */ }
        }

        checks.push({
          label: '@typescript-eslint/utils available at runtime',
          pass: utilsOk,
          detail: utilsOk
            ? `Found${utilsVersion ? ` v${utilsVersion}` : ''}`
            : 'Not found — rule engine may crash on fresh installs',
          fix: utilsOk
            ? undefined
            : 'npm install @typescript-eslint/utils',
          note: utilsOk
            ? undefined
            : 'This is a runtime dependency of eslint-plugin-ai-guard rules.',
        });
      }

      // ── Check 11: @typescript-eslint/parser for TS projects ───────────────
      {
        let parserOk = false;
        let parserVersion: string | null = null;
        try {
          const { createRequire } = await import('module');
          const req = createRequire(path.join(cwd, 'package.json'));
          const pkgPath = req.resolve('@typescript-eslint/parser/package.json');
          const pkg = JSON.parse(
            (await import('fs')).readFileSync(pkgPath, 'utf-8'),
          ) as { version?: string };
          parserVersion = pkg.version ?? null;
          parserOk = true;
        } catch {
          // Optional — only needed for TS projects
        }

        const hasTsFiles = (() => {
          try {
            const { readdirSync } = require('fs');
            const files = readdirSync(cwd) as string[];
            return files.some((f: string) => f.endsWith('.ts') || f.endsWith('.tsx'));
          } catch {
            return false;
          }
        })();

        if (!parserOk && hasTsFiles) {
          checks.push({
            label: '@typescript-eslint/parser installed (TypeScript project)',
            pass: false,
            detail: '.ts/.tsx files detected but TypeScript parser not found',
            fix: 'npm install --save-dev @typescript-eslint/parser',
            note: 'TypeScript files will use espree fallback without this — some rules may not work correctly.',
          });
        }
      }

      // ─── Render results ────────────────────────────────────────────────────

      log.section('Diagnostics');

      let allPassed = true;
      for (const check of checks) {
        const icon = check.pass ? chalk.green('✔') : chalk.red('✖');
        const label = check.pass
          ? chalk.white(check.label)
          : chalk.red.bold(check.label);

        log.print(`  ${icon}  ${label}`);
        log.print(`       ${chalk.gray(check.detail)}`);

        if (!check.pass) {
          allPassed = false;
          if (check.fix) {
            log.print(`       ${chalk.cyan('→ Fix:')} ${chalk.yellow(check.fix)}`);
          }
          if (check.note) {
            log.print(`       ${chalk.gray(check.note)}`);
          }
        }

        log.blank();
      }

      log.divider();
      log.blank();

      if (allPassed) {
        log.print(`  ${chalk.green('✔')}  ${chalk.bold.green('All checks passed! Your setup is correct.')}`);
        log.blank();
        log.info(`Run ${chalk.cyan('ai-guard run')} to start scanning.`);
        log.info(`Run ${chalk.cyan('npx eslint .')} to lint with ESLint directly.`);
      } else {
        log.error('Some checks failed. Follow the fixes above.');
        log.blank();

        // Smart suggestion — only suggest init if it won't cause an infinite loop
        const configFormatMismatch = checks.some(
          (c) => c.label === 'Config format matches ESLint version' && !c.pass,
        );
        const configMissing = checks.some(
          (c) => c.label === 'ESLint config present' && !c.pass,
        );
        const pluginMissing = checks.some(
          (c) => c.label === 'eslint-plugin-ai-guard installed' && !c.pass,
        );

        if (pluginMissing) {
          log.print(
            `  Install missing packages first, then re-run ${chalk.cyan('ai-guard doctor')}.`,
          );
        } else if (configMissing || configFormatMismatch) {
          log.print(
            `  Run ${chalk.cyan('ai-guard init')} to generate the correct config for your ESLint version.`,
          );
        } else {
          log.print(
            `  Run ${chalk.cyan('ai-guard init --dry-run')} to preview what would change.`,
          );
        }
      }

      log.blank();
      process.exit(allPassed ? 0 : 1);
    });
}
