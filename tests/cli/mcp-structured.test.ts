/**
 * MCP output schemas, JSON-text parity, bounded findings, rule lookup and the
 * verify_changes prompt — driven through the real server over an in-memory transport.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/create-server';
import { getRules } from '../../src/mcp/tools/rules';

describe('MCP structured output', () => {
  let root: string;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-structured-'));
    // 60 empty catches — each an error in the agent preset
    const body = Array.from({ length: 60 }, (_, i) => `try { run${i}(); } catch (e) {}`).join('\n');
    fs.writeFileSync(path.join(root, 'many.js'), `${body}\n`);
    fs.writeFileSync(path.join(root, 'clean.js'), 'export const x = 1;\n');
    server = createMcpServer(root);
    client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('declares output schemas and read-only annotations for every tool', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('text content is compact JSON identical to structuredContent for every tool and outcome', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['ai_guard_scan_file', { path: 'many.js', maxIssues: 2 }],
      ['ai_guard_scan_file', { path: 'clean.js' }],
      ['ai_guard_scan_file', { path: '../outside.js' }],
      ['ai_guard_scan_diff', {}],
      ['ai_guard_scan_project', { maxIssues: 1 }],
      ['ai_guard_rules', {}],
      ['ai_guard_rules', { rules: ['no-empty-catch'] }],
      ['ai_guard_rules', { rules: ['no-such-rule'] }],
      ['ai_guard_check_integrity', {}],
      ['ai_guard_check_integrity', { base: '--option' }],
    ];
    for (const [name, args] of calls) {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].text).not.toContain('\n');
      expect(JSON.parse(content[0].text)).toEqual(res.structuredContent);
    }
  }, 60000);

  it('bounds findings to maxIssues (default 50) with exact totals, never complete or clean', async () => {
    const res = await client.callTool({ name: 'ai_guard_scan_file', arguments: { path: 'many.js' } });
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toMatchObject({
      success: true, status: 'partial', clean: false, truncated: true, totalIssues: 60,
      errors: [expect.objectContaining({ code: 'RESULT_LIMIT' })],
    });
    expect((res.structuredContent as { issues: unknown[] }).issues).toHaveLength(50);

    const full = await client.callTool({ name: 'ai_guard_scan_file', arguments: { path: 'many.js', maxIssues: 100 } });
    expect(full.structuredContent).toMatchObject({ status: 'complete', truncated: false, totalIssues: 60 });
  });

  it('rejects out-of-range maxIssues', async () => {
    const res = await client.callTool({ name: 'ai_guard_scan_file', arguments: { path: 'clean.js', maxIssues: 5000 } });
    expect(res.isError).toBe(true);
  });

  it('looks up rules with docs links and reports unknown IDs', async () => {
    const res = await client.callTool({ name: 'ai_guard_rules', arguments: { rules: ['no-empty-catch', 'ai-guard/no-floating-promise'] } });
    const data = res.structuredContent as { rules: Array<{ ruleId: string; docsUrl?: string; remediation: string }> };
    expect(data.rules.map(r => r.ruleId).sort()).toEqual(['ai-guard/no-empty-catch', 'ai-guard/no-floating-promise']);
    for (const r of data.rules) {
      expect(r.docsUrl).toMatch(/docs\/rules\/.+\.md$/);
      expect(r.remediation).toBeTruthy();
    }

    const unknown = await client.callTool({ name: 'ai_guard_rules', arguments: { rules: ['no-such-rule'] } });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ success: false, unknownRules: ['no-such-rule'] });
  });

  it('derives preset maps from the canonical preset configs', () => {
    const { rules } = getRules({});
    const enabledIn = (preset: string): number => rules.filter(r => r.severity[preset] !== 'off').length;
    expect([enabledIn('recommended'), enabledIn('strict'), enabledIn('security'), enabledIn('agent')]).toEqual([13, 18, 6, 5]);
  });

  it('serves the verify_changes prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map(p => p.name)).toContain('verify_changes');
    const prompt = await client.getPrompt({ name: 'verify_changes', arguments: { path: 'src/a.ts' } });
    const text = (prompt.messages[0].content as { text: string }).text;
    expect(text).toContain('ai_guard_scan_file with { "path": "src/a.ts", "preset": "agent" }');
    expect(text).toContain('clean is true');
  });
});
