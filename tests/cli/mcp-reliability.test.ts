import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runner from '../../cli/utils/eslint-runner';
import { scanFile } from '../../src/mcp/tools/scan-file';
import { scanProject } from '../../src/mcp/tools/scan-project';
import { validatePath } from '../../src/mcp/utils/workspace';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/create-server';

describe('MCP failure propagation', () => {
  let root: string;
  const empty: runner.RunResult = {
    files: [], totalErrors: 0, totalWarnings: 0, totalIssues: 0, filesScanned: 1,
    ruleBreakdown: new Map(), topFiles: [], durationMs: 0,
    ecosystemIssues: [], parserErrors: [], tsParserAvailable: true,
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-errors-'));
    fs.writeFileSync(path.join(root, 'test.ts'), 'const x: number = 1;');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it.each([
    [{ filesScanned: 0 }, 'INCOMPLETE_SCAN'],
    [{ tsParserAvailable: false }, 'PARSER_UNAVAILABLE'],
    [{ ecosystemIssues: [{ type: 'config-error', ruleId: null, message: 'Config failed', filePath: 'test.ts', line: 1, column: 1 }] }, 'ANALYSIS_ERROR'],
  ])('does not claim clean when the runner returns %j', async (override, code) => {
    vi.spyOn(runner, 'runEslint').mockResolvedValue({ ...empty, ...override } as runner.RunResult);
    expect(await scanFile({ path: 'test.ts' }, root)).toMatchObject({
      success: false, clean: false, status: 'partial', errors: [expect.objectContaining({ code })],
    });
  });
  it('returns scan exceptions as machine-readable MCP errors and releases the busy flag', async () => {
    const run = vi.spyOn(runner, 'runEslint').mockRejectedValueOnce(new Error('Rule crashed')).mockResolvedValue(empty);
    const server = createMcpServer(root);
    const client = new Client({ name: 'errors', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const result = await client.callTool({ name: 'ai_guard_scan_file', arguments: { path: 'test.ts' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'failed', clean: false, errors: [{ code: 'SCAN_FAILED', message: 'Rule crashed' }] });
      expect((await client.callTool({ name: 'ai_guard_scan_file', arguments: { path: 'test.ts' } })).isError).toBe(false);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await server.close(); }
  });
  it('fails closed on realpath permission errors', () => {
    vi.spyOn(fs, 'realpathSync').mockImplementation(() => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); });
    expect(validatePath('test.ts', root)).toMatchObject({ valid: false, code: 'PATH_UNREADABLE' });
  });
  it('rejects overlapping requests without queueing unbounded scans', async () => {
    let finish!: (result: runner.RunResult) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(runner, 'runEslint').mockImplementation(() => {
      started();
      return new Promise(resolve => { finish = resolve; });
    });
    const server = createMcpServer(root);
    const client = new Client({ name: 'concurrency', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const first = client.callTool({ name: 'ai_guard_scan_file', arguments: { path: 'test.ts' } });
      await ready;
      const second = await client.callTool({ name: 'ai_guard_scan_project', arguments: {} });
      expect(second.isError).toBe(true);
      expect(second.structuredContent).toMatchObject({ clean: false, errors: [expect.objectContaining({ code: 'SERVER_BUSY' })] });
      finish(empty);
      expect((await first).isError).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
  it('bounds total bytes before invoking ESLint', async () => {
    const run = vi.spyOn(runner, 'runEslint');
    for (let i = 0; i < 21; i++) fs.writeFileSync(path.join(root, i + '.js'), ' '.repeat(1024 * 1024));
    expect(await scanProject({}, root)).toMatchObject({ clean: false, errors: [{ code: 'RESOURCE_LIMIT', message: expect.any(String) }] });
    expect(run).not.toHaveBeenCalled();
  });
  it('does not treat a truncated result as clean or complete', async () => {
    const issue: runner.IssueDetail = { ruleId: 'ai-guard/no-eval-dynamic', severity: 2, message: 'eval', line: 1, column: 1 };
    vi.spyOn(runner, 'runEslint').mockResolvedValue({ ...empty, totalIssues: 1001, totalErrors: 1001,
      files: [{ filePath: 'test.ts', errorCount: 1001, warningCount: 0, issues: Array.from({ length: 1001 }, () => issue) }] });
    const result = await scanFile({ path: 'test.ts' }, root);
    expect(result).toMatchObject({ status: 'partial', clean: false, totalErrors: 1001, errors: [expect.objectContaining({ code: 'RESULT_LIMIT' })] });
    expect(result.issues).toHaveLength(1000);
  });
  it('does not load a workspace dist entry or allow inline rule disabling', async () => {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'throw new Error("workspace code executed");');
    fs.writeFileSync(path.join(root, 'test.js'), '/* eslint-disable */\neval(input);');
    const result = await scanFile({ path: 'test.js' }, root);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'ai-guard/no-eval-dynamic' })]));
    expect(result.clean).toBe(false);
  });
});
