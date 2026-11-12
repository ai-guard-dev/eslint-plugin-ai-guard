import { describe, expect, it } from 'vitest';
import { mergeOxlintConfig, presetRules } from '../../cli/commands/init-oxlint';

describe('init-oxlint', () => {
  it('maps presets to Oxlint rule levels', () => {
    const strict = presetRules('strict');
    expect(Object.keys(strict)).toHaveLength(27);
    expect(new Set(Object.values(strict))).toEqual(new Set(['error']));
    expect(presetRules('recommended')['ai-guard/no-empty-catch']).toBe('error');
    expect(Object.keys(presetRules('agent'))).toHaveLength(8);
  });

  it('adds the plugin and preset rules, keeping the user settings', () => {
    const existing = { categories: { correctness: 'error' }, rules: { 'ai-guard/no-empty-catch': 'off', 'no-debugger': 'error' } };
    const { config, added, pluginAdded } = mergeOxlintConfig(existing, 'recommended');
    expect(pluginAdded).toBe(true);
    expect(config.jsPlugins).toEqual(['eslint-plugin-ai-guard']);
    expect(config.categories).toEqual({ correctness: 'error' });
    expect(config.rules!['ai-guard/no-empty-catch']).toBe('off');
    expect(config.rules!['no-debugger']).toBe('error');
    expect(added).toBe(Object.keys(presetRules('recommended')).length - 1);
  });

  it('changes nothing the second time, and recognises an aliased plugin entry', () => {
    const once = mergeOxlintConfig({}, 'strict').config;
    expect(mergeOxlintConfig(once, 'strict')).toMatchObject({ added: 0, pluginAdded: false });
    const aliased = mergeOxlintConfig({ jsPlugins: [{ name: 'aig', specifier: 'eslint-plugin-ai-guard' }] }, 'agent');
    expect(aliased.pluginAdded).toBe(false);
    expect(aliased.config.jsPlugins).toHaveLength(1);
  });
});
