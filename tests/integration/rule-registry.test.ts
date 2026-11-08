/**
 * Every rule must be registered everywhere the CLI, SARIF output and docs
 * look it up. This turns the "register in 5 places" checklist into a test.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { allRules } from '../../src/rules';
import recommended from '../../src/configs/recommended';
import strict from '../../src/configs/strict';
import security from '../../src/configs/security';
import { AGENT_RULES } from '../../src/configs/agent';
import { ISSUE_CONFIDENCE, ISSUE_CATEGORY, ISSUE_REMEDIATION } from '../../cli/utils/eslint-runner';
import { RULE_CATEGORY, CONFIDENCE_TIER } from '../../cli/utils/logger';
import { RULE_DOCS } from '../../cli/utils/sarif';

const ruleIds = Object.keys(allRules).map((name) => `ai-guard/${name}`);

/**
 * Known, pre-existing disagreements between the CLI gate (logger CONFIDENCE_TIER,
 * used by --fail-on) and JSON/SARIF output (ISSUE_CONFIDENCE). Listed explicitly
 * so a new rule cannot drift silently; resolving one changes CI behaviour.
 */
const KNOWN_CONFIDENCE_DRIFT: Record<string, { cliGate: string; output: string }> = {
  'ai-guard/no-empty-catch': { cliGate: 'high', output: 'medium' },
};

describe('rule registry', () => {
  it.each(ruleIds)('%s has CLI, SARIF and docs metadata', (ruleId) => {
    const name = ruleId.replace('ai-guard/', '');
    expect(ISSUE_CONFIDENCE[ruleId], 'ISSUE_CONFIDENCE').toBeDefined();
    expect(ISSUE_CATEGORY[ruleId], 'ISSUE_CATEGORY').toBeDefined();
    expect(ISSUE_REMEDIATION[ruleId], 'ISSUE_REMEDIATION').toBeTruthy();
    expect(RULE_CATEGORY[ruleId], 'logger RULE_CATEGORY').toBeDefined();
    const drift = KNOWN_CONFIDENCE_DRIFT[ruleId];
    if (drift) {
      expect([CONFIDENCE_TIER[ruleId], ISSUE_CONFIDENCE[ruleId]]).toEqual([drift.cliGate, drift.output]);
    } else {
      expect(CONFIDENCE_TIER[ruleId], 'logger CONFIDENCE_TIER').toBe(ISSUE_CONFIDENCE[ruleId]);
    }
    expect(RULE_DOCS[ruleId]?.shortDesc, 'sarif RULE_DOCS').toBeTruthy();
    expect(fs.existsSync(path.join(process.cwd(), 'docs', 'rules', `${name}.md`)), `docs/rules/${name}.md`).toBe(true);
  });

  it.each(ruleIds)('%s is enabled at error in the strict preset', (ruleId) => {
    expect(strict.rules?.[ruleId]).toBe('error');
  });

  it('every preset only references rules that exist', () => {
    const known = new Set(ruleIds);
    for (const rules of [recommended.rules, strict.rules, security.rules, AGENT_RULES]) {
      for (const ruleId of Object.keys(rules ?? {})) expect(known.has(ruleId), ruleId).toBe(true);
    }
  });

  it('every rule has a description and a docs URL', () => {
    for (const [name, rule] of Object.entries(allRules)) {
      const docs = (rule as { meta: { docs?: { description?: string; url?: string } } }).meta.docs;
      expect(docs?.description, name).toBeTruthy();
      expect(docs?.url, name).toContain(`/docs/rules/${name}.md`);
    }
  });
});
