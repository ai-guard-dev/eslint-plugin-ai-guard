import { defineConfig } from 'tsup';

export default defineConfig([
  // Plugin bundle — CJS + ESM dual output
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    outDir: 'dist',
    target: 'node18',
    external: ['eslint', '@typescript-eslint/utils'],
  },
  // CLI bundle — CJS only (required for shebang binary)
  {
    entry: { 'cli/index': 'cli/index.ts' },
    format: ['cjs'],
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
    outDir: 'dist',
    target: 'node18',
    external: ['eslint', '@typescript-eslint/parser'],
    tsconfig: 'tsconfig.cli.json',
    // CJS output has no import.meta; without the shim `import.meta.url` is
    // undefined and the CLI cannot locate its own bundled plugin when the
    // scanned project does not install eslint-plugin-ai-guard (npx usage).
    shims: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // MCP server bundle — CJS only (required for shebang binary)
  {
    entry: { 'mcp/server': 'src/mcp/server.ts' },
    format: ['cjs'],
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
    outDir: 'dist',
    target: 'node18',
    // Only eslint and the TS parser (peers) stay external. The MCP SDK, zod and chalk
    // are bundled (they are devDependencies) so `npx` doesn't install ~90 extra packages.
    external: ['eslint', '@typescript-eslint/parser'],
    tsconfig: 'tsconfig.mcp.json',
    shims: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);

