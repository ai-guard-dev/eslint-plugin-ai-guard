import type { Command } from 'commander';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { detect, isFlat } from '../utils/detector.js';
import {
  backupConfig,
  readConfig,
  writeConfig,
  patchFlatConfig,
  patchLegacyConfig,
  switchFlatPreset,
  switchLegacyPreset,
  generateFlatConfig,
  generateLegacyConfig,
  type Preset,
} from '../utils/config-manager.js';
import { log } from '../utils/logger.js';
import path from 'path';

export function registerPresetCommand(program: Command): void {
  program
    .command('preset')
    .description('Interactively select and apply an ai-guard preset to your ESLint config')
    .action(async () => {
      const cwd = process.cwd();

      log.banner('AI GUARD PRESET');
      log.blank();

      const preset = await select<Preset>({
        message: 'Choose a preset:',
        choices: [
          {
            name: `${chalk.green('recommended')} — balanced defaults, low noise. Best starting point.`,
            value: 'recommended',
          },
          {
            name: `${chalk.yellow('strict')}      — all rules at error. For mature codebases.`,
            value: 'strict',
          },
          {
            name: `${chalk.red('security')}   — security rules only. For AppSec teams.`,
            value: 'security',
          },
        ],
      });

      log.blank();
      log.info(`Applying preset: ${chalk.cyan(preset)}`);

      const env = detect(cwd);
      const useFlat =
        (env.eslintMajor !== null && env.eslintMajor >= 9) ||
        isFlat(env.configType);

      if (env.configType === 'none') {
        // Generate fresh config with chosen preset
        const configPath = useFlat
          ? path.join(cwd, 'eslint.config.mjs')
          : path.join(cwd, '.eslintrc.js');

        const content = useFlat
          ? generateFlatConfig(preset)
          : generateLegacyConfig(preset);

        writeConfig(configPath, content);
        log.success(`Created ${chalk.white(path.relative(cwd, configPath))} with ${chalk.cyan(preset)} preset`);
      } else {
        const configPath = env.configPath!;
        const backupPath = backupConfig(configPath);
        log.info(`Backed up → ${chalk.gray(path.relative(cwd, backupPath))}`);

        const existing = readConfig(configPath);
        const withPlugin = isFlat(env.configType)
          ? patchFlatConfig(existing, preset)
          : patchLegacyConfig(existing, preset);

        const patched = isFlat(env.configType)
          ? switchFlatPreset(withPlugin, preset)
          : switchLegacyPreset(withPlugin, preset);

        if (patched === existing) {
          log.warn('No preset changes needed. Config already matches selected preset.');
        } else {
          writeConfig(configPath, patched);
          log.success(`Updated ${chalk.white(path.relative(cwd, configPath))} to ${chalk.cyan(preset)} preset`);
        }
      }

      log.blank();
      log.section('Preset Details');

      const presetDetails: Record<Preset, Array<{ rule: string; level: string }>> = {
        recommended: [
          { rule: 'no-empty-catch', level: chalk.red('error') },
          { rule: 'no-floating-promise', level: chalk.red('error') },
          { rule: 'no-hardcoded-secret', level: chalk.red('error') },
          { rule: 'no-eval-dynamic', level: chalk.red('error') },
          { rule: 'no-broad-exception', level: chalk.yellow('warn') },
          { rule: 'no-async-array-callback', level: chalk.yellow('warn') },
          { rule: 'no-await-in-loop', level: chalk.yellow('warn') },
          { rule: '+ 6 more…', level: chalk.gray('warn') },
        ],
        strict: [
          { rule: 'All 18 rules', level: chalk.red('error') },
        ],
        security: [
          { rule: 'no-hardcoded-secret', level: chalk.red('error') },
          { rule: 'no-eval-dynamic', level: chalk.red('error') },
          { rule: 'no-sql-string-concat', level: chalk.red('error') },
          { rule: 'no-unsafe-deserialize', level: chalk.yellow('warn') },
          { rule: 'require-auth-middleware', level: chalk.yellow('warn') },
          { rule: 'require-authz-check', level: chalk.yellow('warn') },
        ],
        agent: [
          { rule: 'no-hardcoded-secret', level: chalk.red('error') },
          { rule: 'no-eval-dynamic', level: chalk.red('error') },
          { rule: 'no-empty-catch', level: chalk.red('error') },
          { rule: 'no-sql-string-concat', level: chalk.red('error') },
          { rule: 'no-floating-promise', level: chalk.red('error') },
        ],
      };

      for (const { rule, level } of presetDetails[preset]) {
        log.print(`    ${chalk.gray('•')} ${chalk.white(rule).padEnd(32)}${level}`);
      }

      log.blank();
      log.info(`Run ${chalk.cyan('ai-guard run')} to see results with the new preset.`);
      log.blank();
    });
}
