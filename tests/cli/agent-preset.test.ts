import path from 'path';
import { describe, it, expect } from 'vitest';
import { runEslint, AGENT_RULES } from '../../cli/utils/eslint-runner';

describe('cli agent-preset', () => {
  it('detects exactly 5 specific anti-patterns in the agent-patterns fixture', async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/agent-patterns.js');
    
    const result = await runEslint({
      preset: 'agent',
      targetPath: fixturePath,
      debugTiming: true,
    });

    const issues = result.files.flatMap(f => f.issues);
    
    // Assert exactly 5 issues are found
    expect(issues).toHaveLength(5);
    
    const ruleIds = issues.map(i => i.ruleId);
    
    // Assert each expected rule ID is present
    expect(ruleIds).toContain('ai-guard/no-hardcoded-secret');
    expect(ruleIds).toContain('ai-guard/no-eval-dynamic');
    expect(ruleIds).toContain('ai-guard/no-empty-catch');
    expect(ruleIds).toContain('ai-guard/no-sql-string-concat');
    expect(ruleIds).toContain('ai-guard/no-floating-promise');

    // Measure and log execution duration (informational)
    console.log(`Agent preset execution duration: ${result.durationMs}ms`);

    // Assert the fixture's clean code section produces no findings
    // The clean code section starts at line 49. Let's make sure no issues are reported there.
    const cleanSectionIssues = issues.filter(i => i.line >= 49);
    expect(cleanSectionIssues).toHaveLength(0);
  });

  it('configures exactly 5 specific rules to error level in AGENT_RULES', () => {
    const rules = Object.keys(AGENT_RULES);
    
    // Assert exactly 5 rules are configured
    expect(rules).toHaveLength(5);
    
    // Assert all are set to 'error'
    for (const rule of rules) {
      expect(AGENT_RULES[rule]).toBe('error');
    }
    
    // Assert the exact rule names match
    expect(rules).toContain('ai-guard/no-hardcoded-secret');
    expect(rules).toContain('ai-guard/no-eval-dynamic');
    expect(rules).toContain('ai-guard/no-empty-catch');
    expect(rules).toContain('ai-guard/no-sql-string-concat');
    expect(rules).toContain('ai-guard/no-floating-promise');
  });
});
