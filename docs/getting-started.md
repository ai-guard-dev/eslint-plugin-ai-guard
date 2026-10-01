# Getting Started

## Install

```bash
npm i -D eslint-plugin-ai-guard
```

## ESLint 9 Flat Config

```js
import aiGuard from 'eslint-plugin-ai-guard';

export default [
  {
    plugins: { 'ai-guard': aiGuard },
    rules: { ...aiGuard.configs.recommended.rules },
  },
];
```

## Presets

- `recommended`: adoption-first, low-noise defaults
- `strict`: all rules at error
- `security`: security-only rules
- `agent`: focused high-signal rules for AI agent workflows
