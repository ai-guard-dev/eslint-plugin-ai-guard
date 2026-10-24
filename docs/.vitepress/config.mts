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
