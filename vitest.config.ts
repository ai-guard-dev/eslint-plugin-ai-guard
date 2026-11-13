import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Many tests run real Git, ESLint and MCP processes. On a 4-core machine running the
    // suite in parallel they can take longer than Vitest's 5 s default (seen during
    // `npm publish`, whose prepublish script runs the whole suite). A hung test still fails.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Vitest v3 has a known internal IPC bug where birpc timers for onTaskUpdate
    // fire after workers finish during long test suites, generating spurious unhandled
    // worker timeout errors even when all tests pass.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'cli/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
