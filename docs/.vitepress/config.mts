import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'eslint-plugin-ai-guard',
  description: 'AST-first ESLint rules for AI-generated code pitfalls',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guides/getting-started' },
      { text: 'CLI', link: '/cli/overview' },
      { text: 'Rules', link: '/rules/README' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/index' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Full Setup Guide', link: '/guides/getting-started' },
          { text: 'Migrating Existing Project', link: '/guides/migrating-existing-project' },
          { text: 'CI Integration', link: '/guides/ci-integration' },
        ],
      },
      {
        text: 'CLI',
        items: [
          { text: 'Overview', link: '/cli/overview' },
          { text: 'run', link: '/cli/run' },
          { text: 'init', link: '/cli/init' },
          { text: 'init-context', link: '/cli/init-context' },
          { text: 'doctor', link: '/cli/doctor' },
          { text: 'preset', link: '/cli/preset' },
          { text: 'ignore', link: '/cli/ignore' },
          { text: 'baseline', link: '/cli/baseline' },
          { text: 'integrity', link: '/integrity' },
          { text: 'verify', link: '/cli/verify' },
          { text: 'verify-deps', link: '/cli/verify-deps' },
          { text: 'test integrity', link: '/cli/test-integrity' },
          { text: 'scan-agent-config', link: '/cli/scan-agent-config' },
        ],
      },
      {
        text: 'Integrations',
        items: [
          { text: 'Agent hooks (Claude Code, Cursor, Codex)', link: '/integrations/agents' },
          { text: 'Claude Code', link: '/integrations/claude-code' },
          { text: 'Pre-commit gate', link: '/integrations/git-hook' },
          { text: 'Oxlint', link: '/integrations/oxlint' },
          { text: 'MCP server', link: '/mcp-server' },
          { text: 'GitHub Actions', link: '/github-actions' },
        ],
      },
      {
        text: 'Rules',
        items: [
          { text: 'Rules Summary', link: '/rules' },
          { text: 'Full Rules Reference', link: '/rules/README' },
        ],
      },
    ],
  },
});
