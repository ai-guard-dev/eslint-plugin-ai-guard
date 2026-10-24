import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Increase teardown timeout to prevent spurious IPC onTaskUpdate timeout
    // errors that occur when long-running tests (e.g. the 40-second --accept
    // acceptance test) leave Vitest workers in a delayed reporting state.
    teardownTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'cli/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
