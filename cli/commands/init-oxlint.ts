/**
 * init-oxlint.ts — ai-guard init-oxlint: run AI Guard's rules in Oxlint.
 *
 * Oxlint loads ESLint plugins as JS plugins. AI Guard's results in Oxlint are
 * checked against ESLint in CI (scripts/oxlint-parity.mjs), rule by rule.
 *
 *   ai-guard init-oxlint                     # recommended preset
 *   ai-guard init-oxlint --preset strict
 *
 * Adds AI Guard to .oxlintrc.json, keeping every existing setting. Rules the
 * file already configures are left alone.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { AGENT_RULES } from '../../src/configs/agent.js';
import recommendedConfig from '../../src/configs/recommended.js';
import strictConfig from '../../src/configs/strict.js';
import securityConfig from '../../src/configs/security.js';

export type OxlintPreset = 'recommended' | 'strict' | 'security' | 'agent';
const PLUGIN = 'eslint-plugin-ai-guard';

export function presetRules(preset: OxlintPreset): Record<string, string> {
  const source = preset === 'agent' ? AGENT_RULES
    : preset === 'strict' ? strictConfig.rules
    : preset === 'security' ? securityConfig.rules
    : recommendedConfig.rules;
  const out: Record<string, string> = {};
  for (const [rule, level] of Object.entries(source ?? {})) {
    const value = Array.isArray(level) ? level[0] : level;
    out[rule] = value === 2 ? 'error' : value === 1 ? 'warn' : value === 0 ? 'off' : String(value);
  }
  return out;
}

export interface OxlintConfig {
  jsPlugins?: Array<string | { name: string; specifier: string }>;
  rules?: Record<string, unknown>;
  [key: string]: unknown;
}

export function mergeOxlintConfig(existing: OxlintConfig, preset: OxlintPreset): { config: OxlintConfig; added: number; pluginAdded: boolean } {
  const config: OxlintConfig = JSON.parse(JSON.stringify(existing)) as OxlintConfig;
  const plugins = Array.isArray(config.jsPlugins) ? config.jsPlugins : [];
  const hasPlugin = plugins.some((p) => (typeof p === 'string' ? p : p.specifier) === PLUGIN);
  if (!hasPlugin) plugins.push(PLUGIN);
  config.jsPlugins = plugins;
  config.rules ??= {};
  let added = 0;
  for (const [rule, level] of Object.entries(presetRules(preset))) {
    if (rule in config.rules) continue;
    config.rules[rule] = level;
    added++;
  }
  return { config, added, pluginAdded: !hasPlugin };
}

export function registerInitOxlintCommand(program: Command): void {
  program
    .command('init-oxlint')
    .description('Add AI Guard to .oxlintrc.json so Oxlint runs its rules (results are checked against ESLint in CI)')
    .option('--preset <name>', 'recommended | strict | security | agent', 'recommended')
    .option('--dry-run', 'Show the result without writing it')
    .action((opts: { preset: string; dryRun?: boolean }) => {
      const presets: OxlintPreset[] = ['recommended', 'strict', 'security', 'agent'];
      if (!presets.includes(opts.preset as OxlintPreset)) {
        log.error(`Unknown preset '${opts.preset}'. Use ${presets.join(', ')}.`);
        process.exit(2);
        return;
      }
      const file = path.join(process.cwd(), '.oxlintrc.json');
      let existing: OxlintConfig = {};
      if (fs.existsSync(file)) {
        try {
          existing = JSON.parse(fs.readFileSync(file, 'utf8')) as OxlintConfig;
        } catch (error) {
          log.error(`Cannot parse .oxlintrc.json (${error instanceof Error ? error.message : String(error)}). Comments are not supported here; add AI Guard by hand: "jsPlugins": ["${PLUGIN}"].`);
          process.exit(1);
          return;
        }
      }
      const { config, added, pluginAdded } = mergeOxlintConfig(existing, opts.preset as OxlintPreset);
      log.banner('AI GUARD × OXLINT');
      if (!pluginAdded && added === 0) {
        log.success('.oxlintrc.json already runs AI Guard');
        log.blank();
        return;
      }
      const text = `${JSON.stringify(config, null, 2)}\n`;
      if (opts.dryRun) {
        log.print(chalk.gray(text));
      } else {
        fs.writeFileSync(file, text, 'utf8');
        log.success(`Updated .oxlintrc.json: AI Guard plugin${pluginAdded ? ' added' : ''}, ${added} rule${added === 1 ? '' : 's'} from the ${opts.preset} preset`);
      }
      log.info(`Install both if needed: ${chalk.cyan(`npm install --save-dev oxlint ${PLUGIN}`)}`);
      log.info('Oxlint JS plugins are still in alpha; AI Guard is tested against Oxlint 1.93 in CI.');
      log.blank();
    });
}
