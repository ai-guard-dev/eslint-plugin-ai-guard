import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { confirm } from '@inquirer/prompts';
import { detect, isFlat, isLegacy, requiresFlatConfig } from '../utils/detector.js';
import {
  generateFlatConfig,
  generateLegacyConfig,
  patchFlatConfig,
  patchLegacyConfig,
  backupConfig,
  readConfig,
  writeConfig,
  getConfigFilePath,
  removeNukeIgnore,
  validateFlatConfigText,
  validateLegacyConfigText,
  type Preset,
} from '../utils/config-manager.js';
import { log } from '../utils/logger.js';

// ─── Flags ────────────────────────────────────────────────────────────────────

interface InitOptions {
  preset: string;
  flat?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

// ─── Error classification ────────────────────────────────────────────────────

type VerifyError =
  | { kind: 'syntax'; message: string }
  | { kind: 'module-not-found'; pkg: string; message: string }
  | { kind: 'unknown'; message: string };

function classifyVerifyError(err: unknown): VerifyError {
  const msg = err instanceof Error ? err.message : String(err);
  const clean = msg.replace(/\s+at\s+.+/gm, '').trim();

  // Module resolution errors
  const modNotFound = clean.match(
    /Cannot find module '([^']+)'|Cannot find package '([^']+)'/,
  );
  if (modNotFound) {
    const pkg = modNotFound[1] ?? modNotFound[2] ?? 'unknown';
    return { kind: 'module-not-found', pkg, message: clean };
  }

  // SyntaxError / parse errors
  if (
    clean.includes('SyntaxError') ||
    clean.includes('Unexpected token') ||
    clean.includes('Invalid or unexpected token')
  ) {
    return { kind: 'syntax', message: clean };
  }

  return { kind: 'unknown', message: clean };
}

// ─── Programmatic ESLint verification ────────────────────────────────────────

/**
 * After writing a config, try to load it via ESLint's own API.
 * Returns null on success, a classified error on failure.
 */
async function verifyConfigLoads(
  configPath: string,
  cwd: string,
): Promise<null | VerifyError> {
  try {
    type EslintCtor = new (options: {
      cwd: string;
      overrideConfigFile: string;
    }) => {
      lintText: (code: string, options: { filePath: string }) => Promise<unknown>;
    };

    const { ESLint } = await import('eslint') as unknown as { ESLint: EslintCtor };

    const eslint = new ESLint({
      cwd,
      overrideConfigFile: configPath,
    });

    // Lint an empty JS file — forces ESLint to parse and validate the config
    await eslint.lintText('', {
      filePath: path.join(cwd, '_ai_guard_probe_.js'),
    });
    return null; // success
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // "No files" / probe path exclusion errors are not config errors
    if (
      msg.includes('No files matching') ||
      msg.includes('_ai_guard_probe_')
    ) {
      return null;
    }

    return classifyVerifyError(err);
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Configure eslint-plugin-ai-guard in this project')
    .option('--preset <name>', 'Preset to use: recommended | strict | security', 'recommended')
    .option('--flat', 'Force flat config format (eslint.config.mjs) regardless of ESLint version')
    .option('--dry-run', 'Preview what would change without writing any files')
    .option('-y, --yes', 'Skip all prompts — use defaults (recommended preset, generate workflow + agent context)')
    .action(async (opts: InitOptions) => {
      const preset = (opts.preset as Preset) ?? 'recommended';
      const cwd = process.cwd();
      const isDryRun = opts.dryRun === true;
      const isYes = opts.yes === true;

      log.banner('AI GUARD INIT');
      if (isDryRun) {
        log.print(`  ${chalk.yellow('⚑  DRY RUN — no files will be written')}`);
        log.blank();
      }
      log.info('Detecting your project setup…');
      log.blank();

      const env = detect(cwd);

      // ─── Step 1: Environment report ──────────────────────────────────────────

      log.section('Environment');

      if (env.eslintVersion) {
        log.success(`ESLint ${env.eslintVersion} detected (v${env.eslintMajor})`);
      } else {
        log.warn('ESLint not found in node_modules');
      }

      if (env.pluginInstalled) {
        log.success('eslint-plugin-ai-guard is installed');
      } else {
        log.warn('eslint-plugin-ai-guard not found');
      }

      if (env.configType !== 'none') {
        log.success(`ESLint config found: ${chalk.white(path.relative(cwd, env.configPath ?? env.configType))}`);
      } else {
        log.info('No ESLint config found — will generate one');
      }

      // Warn about conflicting configs (only if not ESLint v9, as v9 auto-resolves)
      const eslintNeedsFlat = requiresFlatConfig(env.eslintMajor);
      if (env.hasConflictingConfigs && !eslintNeedsFlat) {
        log.blank();
        log.warn('Conflicting configs detected:');
        for (const p of env.allConfigPaths) {
          log.print(`    ${chalk.yellow('→')} ${chalk.white(path.relative(cwd, p))}`);
        }
        log.print(`  ${chalk.gray('Multiple config formats found — this can cause unpredictable behavior.')}`);
      }

      log.blank();

      // ─── Step 2: Gate on missing deps ────────────────────────────────────────

      const toInstall: string[] = [];
      if (!env.eslintVersion) toInstall.push('eslint');
      if (!env.pluginInstalled) toInstall.push('eslint-plugin-ai-guard');

      if (toInstall.length > 0) {
        log.section('Missing Dependencies');
        log.warn('The following packages are not installed:');
        log.blank();
        for (const pkg of toInstall) {
          log.print(`    ${chalk.yellow('→')} ${chalk.white(pkg)}`);
        }
        log.blank();
        log.print(`  ${chalk.bold('Run this first:')}`);
        log.blank();
        log.print(`    ${chalk.cyan(`npm install --save-dev ${toInstall.join(' ')}`)}`);
        log.blank();
        log.print(`  Then re-run ${chalk.cyan('ai-guard init')} to complete setup.`);
        log.blank();
        process.exit(1);
        return;
      }

      // ─── Step 3: Runtime Safety ─────────────────────────────────────────────

      try {
        const { createRequire } = await import('module');
        const { pathToFileURL } = await import('url');
        const req = createRequire(path.join(cwd, '_probe.js'));
        const resolvedPath = req.resolve('eslint-plugin-ai-guard');
        const aiGuard = await import(pathToFileURL(resolvedPath).href);
        const plugin = (aiGuard.default || aiGuard) as {
          configs?: Record<string, { rules?: unknown }>;
        };

        const hasPresetRules =
          !!plugin.configs &&
          !!plugin.configs[preset] &&
          !!plugin.configs[preset].rules;

        if (!hasPresetRules) {
          // Keep this as informational only; Step 6 performs definitive runtime validation.
          log.debug('Plugin precheck could not verify configs shape; continuing to validation step.');
        }
      } catch (e) {
        // If resolution fails entirely, skip the check; validation step will catch load errors
        const reason = e instanceof Error ? e.message : String(e);
        log.debug(`Skipped plugin precheck: ${reason}`);
      }

      // ─── Step 4: Determine config format ────────────────────────────────────
      //   Priority:
      //   1. --flat flag forces flat config
      //   2. ESLint v9+ → MUST use flat config
      //   3. ESLint v8  → use legacy; unless an existing flat config is already there
      //   4. No version info → default to flat (safer)

      const forceFlat = opts.flat === true;
      const existingIsFlat = isFlat(env.configType);
      const existingIsLegacy = isLegacy(env.configType);
      const useFlat = forceFlat || eslintNeedsFlat || existingIsFlat || env.configType === 'none';

        // Guard: ESLint v9 + existing legacy config → migrate, don't re-create legacy
        if (eslintNeedsFlat && existingIsLegacy) {
          log.section('Config Migration Required');
          log.warn(`ESLint v${env.eslintMajor} requires flat config, but a legacy config was found:`);
          log.print(`    ${chalk.white(path.relative(cwd, env.configPath!))}`);
          log.blank();
          log.print(`  ${chalk.bold('ai-guard will create a new flat config.')}`);
          log.blank();
        }

        // ─── Step 5: Apply config change ────────────────────────────────────────

      log.section(`Configuring ESLint${isDryRun ? ' (dry run)' : ''}`);

      let finalConfigPath: string;
      let configWritten = false;

      // Nuke-ignore removal — fix before anything else
      if (env.configPath && env.hasNukeIgnore) {
        const raw = readConfig(env.configPath);
        const { content: fixed, changed } = removeNukeIgnore(raw);
        if (changed) {
          log.warn(`Removed "**/*" ignore pattern from ${path.relative(cwd, env.configPath)}`);
          if (!isDryRun) {
            backupConfig(env.configPath);
            writeConfig(env.configPath, fixed);
            log.success('Ignore pattern fixed');
          } else {
            log.print(`  ${chalk.gray('[dry-run] would remove nuke-ignore from existing config')}`);
          }
        }
      }

      if (env.configType === 'none' || (eslintNeedsFlat && existingIsLegacy)) {
        // ── Generate fresh config ──────────────────────────────────────────────
        const targetName = useFlat ? 'eslint.config.mjs' : '.eslintrc.js';
        finalConfigPath = path.join(cwd, targetName);

        const content = useFlat
          ? generateFlatConfig(preset)
          : generateLegacyConfig(preset);

        if (isDryRun) {
          log.print(`  ${chalk.gray(`[dry-run] would create: ${targetName}`)}`);
          log.blank();
          log.print(chalk.gray('─── Preview ─────────────────────────────────────────────'));
          log.blank();
          for (const line of content.split('\n')) {
            log.print(chalk.gray(`  ${line}`));
          }
          log.blank();
        } else {
          writeConfig(finalConfigPath, content);
          log.success(`Created ${chalk.white(targetName)}`);
          log.info(`  Preset: ${chalk.cyan(preset)}`);
          log.info(`  Format: ${chalk.cyan(useFlat ? 'ESLint v9 flat config (eslint.config.mjs)' : 'ESLint v8 legacy config (.eslintrc.js)')}`);
          configWritten = true;
        }
      } else if (useFlat && existingIsFlat) {
        // ── Patch existing flat config ─────────────────────────────────────────
        const { isInvalidAiGuardConfig } = await import('../utils/config-manager.js');
        const existing = readConfig(env.configPath!);
        const isInvalid = isInvalidAiGuardConfig(existing);
        const patched = patchFlatConfig(existing, preset);

        if (patched === existing && !isInvalid) {
          log.warn('ai-guard is already present in your config — no changes made');
          finalConfigPath = env.configPath!;
        } else if (isDryRun) {
          finalConfigPath = env.configPath!;
          log.print(`  ${chalk.gray(`[dry-run] would patch: ${path.relative(cwd, env.configPath!)}`)}`);
        } else {
          const bak = backupConfig(env.configPath!);
          log.info(`Backed up → ${chalk.gray(path.relative(cwd, bak))}`);
          writeConfig(env.configPath!, patched);
          if (isInvalid) {
            log.success(`Detected invalid ai-guard config — repairing ${chalk.white(path.relative(cwd, env.configPath!))}`);
          } else {
            log.success(`Patched ${chalk.white(path.relative(cwd, env.configPath!))}`);
          }
          finalConfigPath = env.configPath!;
          configWritten = true;
        }
      } else {
        // ── Patch existing legacy config ─────────────────────────────────────
        const existing = readConfig(env.configPath!);
        const patched = patchLegacyConfig(existing, preset);

        if (patched === existing) {
          log.warn('ai-guard is already present in your config — no changes made');
          finalConfigPath = env.configPath!;
        } else if (isDryRun) {
          finalConfigPath = env.configPath!;
          log.print(`  ${chalk.gray(`[dry-run] would patch: ${path.relative(cwd, env.configPath!)}`)}`);
        } else {
          const bak = backupConfig(env.configPath!);
          log.info(`Backed up → ${chalk.gray(path.relative(cwd, bak))}`);
          writeConfig(env.configPath!, patched);
          log.success(`Patched ${chalk.white(path.relative(cwd, env.configPath!))}`);
          finalConfigPath = env.configPath!;
          configWritten = true;
        }
      }

      // ── Auto cleanup legacy config (conflict resolution) ───────────────
      if (eslintNeedsFlat) {
        // Find legacy configs that might cause conflicts
        const legacyConfigs = env.allConfigPaths.filter(p => !p.includes('eslint.config.'));
        
        let cleanedUp = false;
        for (const p of legacyConfigs) {
          if (fs.existsSync(p)) {
            if (!isDryRun) {
               try {
                 fs.renameSync(p, `${p}.bak`);
                 cleanedUp = true;
               } catch (err) {
                 const reason = err instanceof Error ? err.message : String(err);
                 log.warn(`Could not back up ${path.relative(cwd, p)}: ${reason}`);
               }
            } else {
               cleanedUp = true;
               log.print(`  ${chalk.gray(`[dry-run] would rename ${path.relative(cwd, p)} to ${path.basename(p)}.bak`)}`);
            }
          }
        }
        if (cleanedUp && !isDryRun) {
          log.success('Legacy config backed up to avoid ESLint conflict');
        }
      }

      if (isDryRun) {
        log.blank();
        log.print(`  ${chalk.yellow('Dry run complete — no files written.')}`);
        log.print(`  Re-run without ${chalk.cyan('--dry-run')} to apply.`);
        log.blank();
        process.exit(0);
        return;
      }

      log.blank();

      // ─── Step 5: Structural validation ──────────────────────────────────────

      log.section('Validation');

      if (!fs.existsSync(finalConfigPath)) {
        log.error(`Config file not found after write: ${path.relative(cwd, finalConfigPath)}`);
        log.blank();
        log.print(`  ${chalk.bold('Problem:')} File write may have failed.`);
        log.print(`  ${chalk.bold('Fix:')} Check disk space and file permissions, then re-run.`);
        log.blank();
        process.exit(1);
        return;
      }

      const content = readConfig(finalConfigPath);
      const validationErrors = useFlat
        ? validateFlatConfigText(content)
        : validateLegacyConfigText(content);

      if (validationErrors.length > 0) {
        log.warn('Config validation found issues:');
        for (const e of validationErrors) {
          log.print(`    ${chalk.red('✖')} ${e}`);
        }
      } else {
        log.success(`Config structure valid: ${chalk.white(path.relative(cwd, finalConfigPath))}`);
      }

      // ─── Step 6: Programmatic ESLint load verification ───────────────────────

      log.info('Verifying ESLint can load the config…');

      const loadError = await verifyConfigLoads(finalConfigPath, cwd);
      if (loadError !== null) {
        log.blank();

        if (loadError.kind === 'module-not-found') {
          // Missing dep — config syntax is fine, just need to install the package
          log.warn(`Could not verify: module not found: ${chalk.yellow(loadError.pkg)}`);
          log.blank();
          log.print(`  ${chalk.bold('Install the missing package:')}`);
          log.print(`    ${chalk.cyan(`npm install --save-dev ${loadError.pkg}`)}`);
          log.print(`  Then run ${chalk.cyan('ai-guard doctor')} to confirm.`);
          log.blank();
          // Fall through — config was written correctly; missing dep is user's next step
        } else {
          // Real error — config syntax broken or unknown failure → hard fail
          log.error('ESLint failed to load the generated config.');
          log.blank();
          log.print(`  ${chalk.bold('Problem:')}`);
          log.print(`    ${chalk.red(loadError.message)}`);
          if (loadError.kind === 'unknown') {
            log.blank();
            log.print(`    ${chalk.yellow('Generated config may be using incorrect plugin structure.')}`);
          }
          log.blank();
          log.print(`  ${chalk.bold('Fix:')}`);
          log.print(`    1. Check the syntax in ${chalk.cyan(path.relative(cwd, finalConfigPath))}`);
          log.print(`    2. Make sure ${chalk.cyan('eslint-plugin-ai-guard')} is installed`);
          log.print(`    3. Run ${chalk.cyan('ai-guard doctor')} for full diagnostics`);
          log.blank();
          process.exit(1);
          return;
        }
      } else {
        log.success('ESLint loaded config successfully');
      }


      log.blank();



      // ─── Step 7a: GitHub Actions Workflow ─────────────────────────────────────

      const workflowDir = path.join(cwd, '.github', 'workflows');
      const workflowPath = path.join(workflowDir, 'ai-guard.yml');
      let workflowCreated = false;

      if (!fs.existsSync(workflowPath)) {
        let shouldCreateWorkflow = isYes;
        if (!isYes && !isDryRun) {
          try {
            shouldCreateWorkflow = await confirm({
              message: 'Create GitHub Actions workflow for PR validation?',
              default: true,
            });
          } catch {
            shouldCreateWorkflow = false;
          }
        }

        if (shouldCreateWorkflow) {
          const workflowContent = `# AI Guard — PR validation and GitHub Code Scanning
# Generated by: npx ai-guard init
name: AI Guard

on: [pull_request]

permissions:
  security-events: write
  contents: read

jobs:
  scan:
    name: AI Guard Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - name: Scan changed files
        run: |
          npx ai-guard changed \\
            --pr \\
            --strict \\
            --sarif \\
            --sarif-output ai-guard-results.sarif \\
            --fail-on high
        continue-on-error: true

      - name: Upload to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: ai-guard-results.sarif
          category: ai-guard
`;

          if (isDryRun) {
            log.section('GitHub Actions Workflow (dry run)');
            log.print(`  ${chalk.gray('[dry-run] would create: .github/workflows/ai-guard.yml')}`);
          } else {
            if (!fs.existsSync(workflowDir)) {
              fs.mkdirSync(workflowDir, { recursive: true });
            }
            fs.writeFileSync(workflowPath, workflowContent, 'utf-8');
            workflowCreated = true;
            log.success(`Created ${chalk.white('.github/workflows/ai-guard.yml')}`);
          }
        }
      } else {
        log.info('GitHub Actions workflow already exists — skipping');
      }

      // ─── Step 7b: AI Agent Context ────────────────────────────────────────────

      const agentFiles = [
        { name: 'CLAUDE.md', path: path.join(cwd, 'CLAUDE.md') },
        { name: '.cursorrules', path: path.join(cwd, '.cursorrules') },
        { name: '.github/copilot-instructions.md', path: path.join(cwd, '.github', 'copilot-instructions.md') },
      ];
      const existingAgentFiles = agentFiles.filter(f => fs.existsSync(f.path));
      let agentContextCreated = false;

      if (existingAgentFiles.length === 0) {
        let shouldCreateContext = isYes;
        if (!isYes && !isDryRun) {
          try {
            shouldCreateContext = await confirm({
              message: 'Generate AI agent instruction files? (CLAUDE.md, .cursorrules, copilot-instructions.md)',
              default: true,
            });
          } catch {
            shouldCreateContext = false;
          }
        }

        if (shouldCreateContext && !isDryRun) {
          // Delegate to init-context's generate functions
          try {
            const { AGENTS, ALL_CATEGORIES } = await import('./init-context.js');
            const version = getVersionFromPackage(cwd);

            for (const agent of AGENTS) {
              const fullPath = path.join(cwd, agent.filePath);
              const parentDir = path.dirname(fullPath);
              if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
              }
              const content = agent.generate(version, ALL_CATEGORIES);
              fs.writeFileSync(fullPath, content, 'utf-8');
            }
            agentContextCreated = true;
            log.success(`Created ${chalk.white('CLAUDE.md')}, ${chalk.white('.cursorrules')}, ${chalk.white('copilot-instructions.md')}`);
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            log.warn(`Could not generate agent context: ${reason}`);
            log.info(`Run ${chalk.cyan('ai-guard init-context --all')} manually.`);
          }
        } else if (shouldCreateContext && isDryRun) {
          log.print(`  ${chalk.gray('[dry-run] would create: CLAUDE.md, .cursorrules, copilot-instructions.md')}`);
        }
      } else {
        log.info(`Agent context files already exist (${existingAgentFiles.map(f => f.name).join(', ')}) — skipping`);
      }

      // ─── Step 8: Success ─────────────────────────────────────────────────────

      log.section('Setup Complete');
      log.blank();

      let cleanedUpInfo = false;
      if (eslintNeedsFlat) {
         const legacyConfigs = env.allConfigPaths.filter(p => !p.includes('eslint.config.'));
         cleanedUpInfo = legacyConfigs.some(p => fs.existsSync(`${p}.bak`) && !fs.existsSync(p));
      }

      const lingeringConflicts = env.hasConflictingConfigs && !eslintNeedsFlat && !cleanedUpInfo;
      if (loadError === null && !lingeringConflicts) {
        log.print(`  ${chalk.green('✔')}  ${chalk.bold.green('Configuration validated successfully')}`);
      }
      log.print(`  ${chalk.green('✔')}  ${chalk.bold('ESLint config:')} ${chalk.cyan(path.relative(cwd, finalConfigPath))}`);
      log.print(`  ${chalk.green('✔')}  ${chalk.bold('Mode:')} ${chalk.cyan(useFlat ? `Flat config (ESLint v${env.eslintMajor ?? 9})` : `Legacy config (ESLint v${env.eslintMajor ?? 8})`)}`);
      log.print(`  ${chalk.green('✔')}  ${chalk.bold('Preset:')} ${chalk.cyan(preset)}`);
      if (workflowCreated) {
        log.print(`  ${chalk.green('✔')}  ${chalk.bold('GitHub workflow:')} ${chalk.cyan('.github/workflows/ai-guard.yml')}`);
      }
      if (agentContextCreated) {
        log.print(`  ${chalk.green('✔')}  ${chalk.bold('Agent context:')} ${chalk.cyan('CLAUDE.md, .cursorrules, copilot-instructions.md')}`);
      }
      log.blank();
      log.info(`Run ${chalk.cyan('npx eslint .')}         → lint with your editor integration`);
      log.info(`Run ${chalk.cyan('ai-guard run')}          → zero-config scan`);
      log.info(`Run ${chalk.cyan('ai-guard doctor')}       → verify the full setup`);
      log.info(`Run ${chalk.cyan('ai-guard baseline')}     → save baseline, track only new issues`);
      log.blank();
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getVersionFromPackage(cwd: string): string {
  try {
    const pkgPath = path.join(cwd, 'node_modules', 'eslint-plugin-ai-guard', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }

  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }

  return '0.0.0';
}
