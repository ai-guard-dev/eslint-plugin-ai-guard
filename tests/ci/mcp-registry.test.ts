/**
 * The MCP Registry listing (server.json) must stay in step with package.json:
 * the registry rejects a version or name mismatch at publish time.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string; mcpName?: string; name: string; bin: Record<string, string> };
const server = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8')) as {
  name: string;
  version: string;
  description: string;
  packages: Array<{ identifier: string; version: string; runtimeArguments: Array<{ value: string }>; packageArguments: Array<{ value: string }> }>;
};

describe('MCP Registry metadata', () => {
  it('uses the same name as package.json mcpName, in the GitHub namespace', () => {
    expect(server.name).toBe('io.github.ai-guard-dev/ai-guard');
    expect(pkg.mcpName).toBe(server.name);
  });

  it('lists the current package version', () => {
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages) {
      expect(p.identifier).toBe(pkg.name);
      expect(p.version).toBe(pkg.version);
    }
  });

  it('starts the MCP server bin (the package has several bins)', () => {
    const [p] = server.packages;
    expect(p.runtimeArguments.map((a) => a.value)).toEqual(['-y', '-p', '@typescript-eslint/parser', '-p']);
    expect(p.packageArguments.map((a) => a.value)).toEqual(['ai-guard-mcp']);
    expect(pkg.bin['ai-guard-mcp']).toBe('dist/mcp/server.js');
  });

  it('keeps the description within the registry limit', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
