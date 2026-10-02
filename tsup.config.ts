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
    external: ['eslint', '@typescript-eslint/parser', '@modelcontextprotocol/sdk', 'zod'],
    tsconfig: 'tsconfig.mcp.json',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);

