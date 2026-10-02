/**
 * ai_guard_rules — MCP tool handler.
 *
 * Returns information about available AI Guard rules and presets.
 * Source of truth: existing allRules, preset configs, and metadata tables.
 * No duplicate rule catalog — reads directly from the plugin.
 */

import { allRules } from '../../rules/index.js';
import { AGENT_RULES } from '../../configs/agent.js';
import {
  ISSUE_CONFIDENCE,
  ISSUE_CATEGORY,
  ISSUE_REMEDIATION,
} from '../../../cli/utils/eslint-runner.js';
import { isValidPreset } from '../utils/workspace.js';
import type { RulesResult, RuleInfo } from '../types.js';

// Preset rule maps — reuse from eslint-runner's logic without re-importing private vars
// These are the canonical definitions
const PRESET_RULES: Record<string, Record<string, 'error' | 'warn' | 'off'>> = {
  recommended: {
    'ai-guard/no-empty-catch': 'error',
    'ai-guard/no-broad-exception': 'warn',
    'ai-guard/no-floating-promise': 'error',
    'ai-guard/no-await-in-loop': 'warn',
    'ai-guard/no-async-without-await': 'warn',
    'ai-guard/no-async-array-callback': 'warn',
    'ai-guard/no-hardcoded-secret': 'error',
    'ai-guard/no-eval-dynamic': 'error',
    'ai-guard/no-sql-string-concat': 'warn',
    'ai-guard/no-unsafe-deserialize': 'warn',
    'ai-guard/require-auth-middleware': 'warn',
    'ai-guard/require-authz-check': 'warn',
    'ai-guard/no-dead-branch': 'warn',
  },
  strict: {
    'ai-guard/no-empty-catch': 'error',
    'ai-guard/no-broad-exception': 'error',
    'ai-guard/no-catch-log-rethrow': 'error',
    'ai-guard/no-catch-without-use': 'error',
    'ai-guard/no-async-array-callback': 'error',
    'ai-guard/no-floating-promise': 'error',
    'ai-guard/no-await-in-loop': 'error',
    'ai-guard/no-async-without-await': 'error',
    'ai-guard/no-redundant-await': 'error',
    'ai-guard/no-hardcoded-secret': 'error',
    'ai-guard/no-eval-dynamic': 'error',
    'ai-guard/no-sql-string-concat': 'error',
    'ai-guard/no-unsafe-deserialize': 'error',
    'ai-guard/require-auth-middleware': 'error',
    'ai-guard/require-authz-check': 'error',
    'ai-guard/no-console-in-handler': 'error',
    'ai-guard/no-duplicate-logic-block': 'error',
    'ai-guard/no-dead-branch': 'error',
  },
  security: {
    'ai-guard/no-hardcoded-secret': 'error',
    'ai-guard/no-eval-dynamic': 'error',
    'ai-guard/no-sql-string-concat': 'error',
    'ai-guard/no-unsafe-deserialize': 'warn',
    'ai-guard/require-auth-middleware': 'warn',
    'ai-guard/require-authz-check': 'warn',
  },
  agent: AGENT_RULES,
};

export interface RulesInput {
  preset?: string;
}

export function getRules(input: RulesInput): RulesResult {
  const allRuleNames = Object.keys(allRules);
  const presetNames = Object.keys(PRESET_RULES);

  // Build full rule info from existing metadata
  const rules: RuleInfo[] = allRuleNames.map(name => {
    const ruleId = `ai-guard/${name}`;
    const severity: Record<string, 'error' | 'warn' | 'off'> = {};
    for (const [presetName, presetRules] of Object.entries(PRESET_RULES)) {
      severity[presetName] = presetRules[ruleId] ?? 'off';
    }

    return {
      ruleId,
      category: ISSUE_CATEGORY[ruleId] ?? 'Unknown',
      confidence: ISSUE_CONFIDENCE[ruleId] ?? 'unknown',
      severity,
      description: ISSUE_REMEDIATION[ruleId]?.split('.')[0] ?? '',
      remediation: ISSUE_REMEDIATION[ruleId] ?? '',
    };
  });

  const result: RulesResult = {
    success: true,
    totalRules: allRuleNames.length,
    presets: presetNames,
    rules,
  };

  // If a specific preset was requested, include its rule list
  if (input.preset && isValidPreset(input.preset)) {
    const presetRules = PRESET_RULES[input.preset];
    result.preset = input.preset;
    result.presetRules = Object.keys(presetRules);
  }

  return result;
}
