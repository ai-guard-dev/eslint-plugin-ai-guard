/**
 * check-catalog.ts — metadata for AI Guard checks that are not ESLint rules.
 *
 * The agent-config scanner and the test-integrity analyzer report findings that
 * flow through the same output paths as lint findings (terminal, JSON, SARIF,
 * GitHub annotations, --fail-on). They are registered as virtual rule IDs:
 *
 *   ai-guard/agent-config/<check>
 *   ai-guard/test-integrity/<check>
 *
 * Severity maps to confidence: `error` checks are `high` (fail CI by default,
 * like other high-confidence findings); `warning` checks are `medium`.
 *
 * Dependency-free on purpose: eslint-runner, logger and sarif import it.
 */

export interface CheckInfo {
  severity: 'error' | 'warning';
  title: string;
  remediation: string;
}

export type AgentConfigCheck =
  | 'hidden-text'
  | 'invisible-character'
  | 'hidden-instructions'
  | 'hidden-comment'
  | 'remote-code-execution'
  | 'external-script'
  | 'concealment'
  | 'instruction-override'
  | 'credential-access'
  | 'exfiltration'
  | 'unpinned-mcp-server'
  | 'inline-secret'
  | 'insecure-transport'
  | 'auto-approve-mcp'
  | 'bypass-permissions'
  | 'unrestricted-shell'
  | 'hook-remote-code'
  | 'mcp-server-changed'
  | 'mcp-server-unapproved'
  | 'invalid-config';

export const AGENT_CONFIG_CHECKS: Record<AgentConfigCheck, CheckInfo> = {
  'hidden-text': { severity: 'error', title: 'Invisible Unicode characters encode hidden text', remediation: 'Delete the invisible characters and review what the hidden text asked the agent to do.' },
  'invisible-character': { severity: 'error', title: 'Invisible or bidirectional Unicode character', remediation: 'Delete the character; agent instructions never need zero-width or bidi control characters.' },
  'hidden-instructions': { severity: 'error', title: 'Suspicious instruction hidden in an HTML comment', remediation: 'Remove the comment. HTML comments are invisible in rendered Markdown but AI tools read them.' },
  'hidden-comment': { severity: 'warning', title: 'Agent instructions hidden in an HTML comment', remediation: 'Move instructions into visible text so reviewers see what the agent is told.' },
  'remote-code-execution': { severity: 'warning', title: 'Instructs the agent to run a downloaded script', remediation: 'Pin and vendor the script, or install the tool through a package manager with a fixed version.' },
  'external-script': { severity: 'warning', title: 'Instructs the agent to add an external script', remediation: 'Remove the instruction unless the script is a known, pinned dependency with Subresource Integrity.' },
  'concealment': { severity: 'warning', title: 'Asks the agent to hide actions from the user', remediation: 'Remove the instruction. Agents should always report what they changed.' },
  'instruction-override': { severity: 'warning', title: 'Tries to override previous or system instructions', remediation: 'Remove the instruction; it is the signature of a prompt-injection payload.' },
  'credential-access': { severity: 'warning', title: 'References credential files', remediation: 'Agent instructions should not point at SSH keys, cloud credentials or agent config files.' },
  'exfiltration': { severity: 'error', title: 'Instructs the agent to send local secrets to a URL', remediation: 'Remove the instruction and check where the file came from.' },
  'unpinned-mcp-server': { severity: 'warning', title: 'MCP server started from an unpinned package', remediation: 'Pin an exact version (npx pkg@1.2.3, uvx pkg==1.2.3, image@sha256:...).' },
  'inline-secret': { severity: 'error', title: 'Secret written inline in agent config', remediation: 'Reference an environment variable or input (${env:NAME}, ${input:name}) and rotate the exposed secret.' },
  'insecure-transport': { severity: 'warning', title: 'Remote MCP server over plain HTTP', remediation: 'Use https:// for remote servers.' },
  'auto-approve-mcp': { severity: 'warning', title: 'Every project MCP server starts without approval', remediation: 'Remove enableAllProjectMcpServers and approve servers individually (enabledMcpjsonServers).' },
  'bypass-permissions': { severity: 'warning', title: 'Permission prompts disabled for everyone using the repo', remediation: 'Remove defaultMode "bypassPermissions" from shared settings.' },
  'unrestricted-shell': { severity: 'warning', title: 'Unrestricted shell access granted to the agent', remediation: 'Allow specific commands (Bash(npm test:*)) instead of every command.' },
  'hook-remote-code': { severity: 'error', title: 'Hook runs a downloaded script automatically', remediation: 'Hooks run on every event without review; vendor and pin the script instead of piping a download to a shell.' },
  'mcp-server-changed': { severity: 'warning', title: 'MCP server changed since it was approved', remediation: 'Review the change, then run `ai-guard scan-agent-config --update-lock`.' },
  'mcp-server-unapproved': { severity: 'warning', title: 'MCP server not in the approved lock file', remediation: 'Review the server, then run `ai-guard scan-agent-config --update-lock`.' },
  'invalid-config': { severity: 'warning', title: 'Agent config file could not be parsed', remediation: 'Fix the JSON syntax; the file was not scanned.' },
};

export type TestIntegrityCheck =
  | 'focused-test'
  | 'test-file-deleted'
  | 'tests-removed'
  | 'test-skipped'
  | 'assertions-removed'
  | 'assertions-weakened'
  | 'snapshots-rewritten'
  | 'test-script-changed'
  | 'test-config-changed';

export const TEST_INTEGRITY_CHECKS: Record<TestIntegrityCheck, CheckInfo> = {
  'focused-test': { severity: 'error', title: 'Focused test (.only) skips the rest of the suite', remediation: 'Remove .only / fit / fdescribe; focused tests make every other test in the file stop running.' },
  'test-file-deleted': { severity: 'warning', title: 'Test file deleted', remediation: 'Restore the tests, or confirm the code they covered was removed too.' },
  'tests-removed': { severity: 'warning', title: 'Tests removed from a test file', remediation: 'Restore the removed tests, or confirm the behaviour they covered was intentionally dropped.' },
  'test-skipped': { severity: 'warning', title: 'Existing test now skipped', remediation: 'Fix the code so the test passes instead of skipping it, or explain why it must be skipped.' },
  'assertions-removed': { severity: 'warning', title: 'Assertions removed from an existing test', remediation: 'Restore the assertions; a test that checks less can pass while the code is broken.' },
  'assertions-weakened': { severity: 'warning', title: 'Exact assertions replaced with weaker ones', remediation: 'Keep exact expectations (toBe, toEqual); toBeDefined/toBeTruthy pass for almost any value.' },
  'snapshots-rewritten': { severity: 'warning', title: 'Existing snapshots rewritten', remediation: 'Review each rewritten snapshot; updating snapshots to match new output hides regressions.' },
  'test-script-changed': { severity: 'warning', title: 'Test command changed', remediation: 'Confirm the new test command still runs the whole suite and fails on errors.' },
  'test-config-changed': { severity: 'warning', title: 'Test configuration now excludes or relaxes tests', remediation: 'Confirm the new exclusions or thresholds are intended and do not hide failing tests.' },
};

export interface VirtualRuleMeta {
  confidence: 'high' | 'medium';
  category: string;
  remediation: string;
  shortDesc: string;
  tags: string[];
  /** Documentation page (relative to docs/) and anchor. */
  docs: string;
}

/** All virtual rule IDs with their metadata, for the CLI, SARIF and logger tables. */
export function virtualRules(): Record<string, VirtualRuleMeta> {
  const out: Record<string, VirtualRuleMeta> = {};
  for (const [check, info] of Object.entries(AGENT_CONFIG_CHECKS)) {
    out[`ai-guard/agent-config/${check}`] = {
      confidence: info.severity === 'error' ? 'high' : 'medium',
      category: 'Security',
      remediation: info.remediation,
      shortDesc: info.title,
      tags: ['security', 'agent-config'],
      docs: `cli/scan-agent-config.md#${check}`,
    };
  }
  for (const [check, info] of Object.entries(TEST_INTEGRITY_CHECKS)) {
    out[`ai-guard/test-integrity/${check}`] = {
      confidence: info.severity === 'error' ? 'high' : 'medium',
      category: 'AI Patterns',
      remediation: info.remediation,
      shortDesc: info.title,
      tags: ['ai-patterns', 'testing', 'test-integrity'],
      docs: `cli/test-integrity.md#${check}`,
    };
  }
  return out;
}
