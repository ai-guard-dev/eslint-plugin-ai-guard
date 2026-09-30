import type { TSESLint } from '@typescript-eslint/utils';

/**
 * Agent Preset
 * 
 * Optimized for AI-agent editing workflows (PostToolUse hooks, real-time feedback).
 * Provides a focused, high-signal rule set to catch critical errors and security issues
 * without overwhelming the agent with stylistic or context-dependent warnings.
 */
export const AGENT_RULES: Record<string, 'error' | 'warn' | 'off'> = {
  'ai-guard/no-hardcoded-secret': 'error',
  'ai-guard/no-eval-dynamic': 'error',
  'ai-guard/no-empty-catch': 'error',
  'ai-guard/no-sql-string-concat': 'error',
  'ai-guard/no-floating-promise': 'error',
};

const agent: TSESLint.ClassicConfig.Config = {
  plugins: ['ai-guard'],
  rules: AGENT_RULES,
};

export default agent;
