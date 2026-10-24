import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
