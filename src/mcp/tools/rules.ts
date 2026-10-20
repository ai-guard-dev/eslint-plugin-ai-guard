/**
 * ai_guard_rules — MCP tool handler.
 *
 * Returns information about available AI Guard rules and presets.
 * Source of truth: existing allRules, preset configs, and metadata tables.
 * No duplicate rule catalog — reads directly from the plugin.
 */

import { allRules } from '../../rules/index.js';
import recommended from '../../configs/recommended.js';
import strict from '../../configs/strict.js';
import security from '../../configs/security.js';
import { AGENT_RULES } from '../../configs/agent.js';
import {
  ISSUE_CONFIDENCE,
  ISSUE_CATEGORY,
  ISSUE_REMEDIATION,
} from '../../../cli/utils/eslint-runner.js';
import { isValidPreset } from '../utils/workspace.js';
import type { RulesResult, RuleInfo } from '../types.js';

type RuleLevel = 'error' | 'warn' | 'off';

/** Enabled rules per preset, derived from the canonical preset configs. */
function enabledRules(rules: Record<string, unknown> | undefined): Record<string, RuleLevel> {
  const out: Record<string, RuleLevel> = {};
  for (const [ruleId, level] of Object.entries(rules ?? {})) {
    if (level === 'error' || level === 'warn') out[ruleId] = level;
  }
  return out;
}

const PRESET_RULES: Record<string, Record<string, RuleLevel>> = {
  recommended: enabledRules(recommended.rules),
  strict: enabledRules(strict.rules),
  security: enabledRules(security.rules),
  agent: AGENT_RULES,
};

export interface RulesInput {
  preset?: string;
  /** Rule IDs to return full details for, with or without the "ai-guard/" prefix. */
  rules?: string[];
}

interface RuleMeta {
  meta?: { docs?: { description?: string; url?: string } };
}

export function getRules(input: RulesInput): RulesResult {
  const allRuleNames = Object.keys(allRules);
  const presetNames = Object.keys(PRESET_RULES);

  const requested = (input.rules ?? []).map(r => r.trim().replace(/^ai-guard\//, ''));
  const selected = requested.length > 0
    ? allRuleNames.filter(name => requested.includes(name))
    : allRuleNames;

  // Build full rule info from existing metadata
  const rules: RuleInfo[] = selected.map(name => {
    const ruleId = `ai-guard/${name}`;
    const severity: Record<string, RuleLevel> = {};
    for (const [presetName, presetRules] of Object.entries(PRESET_RULES)) {
      severity[presetName] = presetRules[ruleId] ?? 'off';
    }
    const docs = (allRules[name as keyof typeof allRules] as RuleMeta).meta?.docs;

    return {
      ruleId,
      category: ISSUE_CATEGORY[ruleId] ?? 'Unknown',
      confidence: ISSUE_CONFIDENCE[ruleId] ?? 'unknown',
      severity,
      description: docs?.description ?? ISSUE_REMEDIATION[ruleId]?.split('.')[0] ?? '',
      remediation: ISSUE_REMEDIATION[ruleId] ?? '',
      docsUrl: docs?.url,
    };
  });

  const result: RulesResult = {
    success: true,
    totalRules: allRuleNames.length,
    presets: presetNames,
    rules,
  };

  const unknown = requested.filter(name => !allRuleNames.includes(name));
  if (unknown.length > 0) {
    result.unknownRules = unknown;
    result.success = rules.length > 0;
  }

  // If a specific preset was requested, include its rule list
  if (input.preset && isValidPreset(input.preset)) {
    const presetRules = PRESET_RULES[input.preset];
    result.preset = input.preset;
    result.presetRules = Object.keys(presetRules);
  }

  return result;
}
