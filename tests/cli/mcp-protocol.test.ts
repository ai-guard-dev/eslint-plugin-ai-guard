import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/create-server';
import { scanFile } from '../../src/mcp/tools/scan-file';
import { validatePath } from '../../src/mcp/utils/workspace';
import type { ScanResult } from '../../src/mcp/types';

describe('MCP protocol', () => {
  let root: string;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-mcp-'));
    fs.writeFileSync(path.join(root, 'good.js'), 'export const value = 1;');
    fs.writeFileSync(path.join(root, 'bad.js'), 'eval(input);');
    fs.writeFileSync(path.join(root, 'syntax.ts'), 'const broken: = ;');
    fs.writeFileSync(path.join(root, 'readme.md'), '# docs');
    server = createMcpServer(root);
    client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({ name, arguments: args });
    const result = response.structuredContent as unknown as ScanResult;
    return { response, result };
  }
  it('discovers five tools with required paths, preset enums, and bounded project schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['ai_guard_check_integrity', 'ai_guard_rules', 'ai_guard_scan_diff', 'ai_guard_scan_file', 'ai_guard_scan_project']);
    expect(tools.find(t => t.name === 'ai_guard_scan_file')?.inputSchema.required).toContain('path');
    const project = tools.find(t => t.name === 'ai_guard_scan_project')!;
    expect(project.inputSchema.properties?.maxFiles).toMatchObject({ minimum: 1, maximum: 500 });
    expect(project.inputSchema.properties?.preset).toMatchObject({ enum: ['recommended', 'strict', 'security', 'agent'] });
    const rules = await client.callTool({ name: 'ai_guard_rules', arguments: { preset: 'agent' } });
    expect(rules.structuredContent).toMatchObject({ success: true, totalRules: 18, preset: 'agent' });
  });
  it.each(['agent', 'strict', 'security', 'recommended'])('scans findings with %s and distinguishes success from clean', async preset => {
    const { response, result } = await call('ai_guard_scan_file', { path: 'bad.js', preset });
    expect(response.isError).toBe(false);
    expect(result).toMatchObject({ success: true, status: 'complete', clean: false, filesScanned: 1, preset });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'ai-guard/no-eval-dynamic', file: 'bad.js' })]));
    expect(JSON.parse((response.content as Array<{ text: string }>)[0].text)).toEqual(result);
  });
  it('reports clean files and isolates workspace from process cwd', async () => {
    const cwd = process.cwd();
    const { result } = await call('ai_guard_scan_file', { path: 'good.js' });
    expect(result).toMatchObject({ success: true, clean: true, status: 'complete', filesScanned: 1 });
    expect(process.cwd()).toBe(cwd);
  });
  it.each([
    ['../outside.js', 'OUTSIDE_WORKSPACE'],
    ['missing.js', 'PATH_NOT_FOUND'],
    ['readme.md', 'UNSUPPORTED_FILE'],
    ['C:relative.js', 'INVALID_PATH'],
    ['nul\0.js', 'INVALID_PATH'],
  ])('returns a structured error for %s', async (file, code) => {
    const { response, result } = await call('ai_guard_scan_file', { path: file });
    expect(response.isError).toBe(true);
    expect(result).toMatchObject({ success: false, clean: false, status: 'failed', errors: [{ code, message: expect.any(String) }] });
  });
  it('returns parser errors as partial, never clean', async () => {
    const { response, result } = await call('ai_guard_scan_file', { path: 'syntax.ts' });
    expect(response.isError).toBe(true);
    expect(result).toMatchObject({ success: false, clean: false, status: 'partial' });
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PARSE_ERROR', file: 'syntax.ts' })]));
    const project = await call('ai_guard_scan_project');
    expect(project.result).toMatchObject({ status: 'partial', clean: false });
    expect(project.result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'bad.js' })]));
  });
  it.each([
    ['ai_guard_scan_file', {}],
    ['ai_guard_scan_file', { path: 42 }],
    ['ai_guard_scan_file', { path: 'good.js', preset: 'bogus' }],
    ['ai_guard_scan_project', { maxFiles: 501 }],
  ])('rejects schema-invalid %s arguments', async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).toBe(true);
  });
  it('reports Git errors and rejects option-like refs and conflicting modes', async () => {
    expect((await call('ai_guard_scan_diff')).result.errors[0].code).toBe('GIT_FAILED');
    expect((await call('ai_guard_scan_diff', { base: '--help' })).result.errors[0].code).toBe('INVALID_GIT_REF');
    expect((await call('ai_guard_scan_diff', { base: 'main..HEAD' })).result.errors[0].code).toBe('INVALID_GIT_REF');
    expect((await call('ai_guard_scan_diff', { base: 'HEAD', staged: true })).result.errors[0].code).toBe('INVALID_INPUT');
  });
  it('handles Unicode, spaces, untracked files, staged selection, and invalid refs', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init');
    git('add', 'good.js');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
    fs.unlinkSync(path.join(root, 'syntax.ts'));
    fs.writeFileSync(path.join(root, 'é space.js'), 'eval(input);');
    const { result } = await call('ai_guard_scan_diff');
    expect(result.status).toBe('complete');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'é space.js' })]));
    expect((await call('ai_guard_scan_diff', { staged: true })).result).toMatchObject({ clean: true, filesScanned: 0 });
    expect((await call('ai_guard_scan_diff', { base: 'missing-ref' })).result.errors[0].code).toBe('GIT_FAILED');
    expect((await call('ai_guard_scan_diff', { base: 'HEAD' })).result.status).toBe('complete');
    // Git paths are repository-relative, even for a server scoped to a subdirectory.
    fs.mkdirSync(path.join(root, 'package'));
    fs.writeFileSync(path.join(root, 'package', 'local.js'), 'eval(input);');
    const { scanDiff } = await import('../../src/mcp/tools/scan-diff');
    const scoped = await scanDiff({}, path.join(root, 'package'));
    expect(scoped).toMatchObject({ status: 'complete', changedFiles: 1 });
    expect(scoped.issues[0].file).toBe('local.js');
  });
  it('scans projects, excludes generated/dependency trees and fails rather than truncating', async () => {
    fs.unlinkSync(path.join(root, 'syntax.ts'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'bad.js'), 'const = ;');
    const { result } = await call('ai_guard_scan_project');
    expect(result).toMatchObject({ status: 'complete', filesScanned: 2, clean: false });
    expect((await call('ai_guard_scan_project', { maxFiles: 1 })).result).toMatchObject({ status: 'failed', clean: false, filesScanned: 0 });
    expect((await call('ai_guard_scan_file', { path: 'node_modules/bad.js' })).result.errors[0].code).toBe('FILE_EXCLUDED');
    expect((await call('ai_guard_scan_project', { path: 'good.js' })).result.errors[0].code).toBe('NOT_A_DIRECTORY');
    fs.mkdirSync(path.join(root, 'empty'));
    expect((await call('ai_guard_scan_project', { path: 'empty' })).result).toMatchObject({ clean: true, filesScanned: 0 });
  });
  it('enforces per-file byte limit', async () => {
    fs.writeFileSync(path.join(root, 'large.js'), ' '.repeat(1024 * 1024 + 1));
    expect((await call('ai_guard_scan_file', { path: 'large.js' })).result.errors[0].code).toBe('RESOURCE_LIMIT');
  });
  it('rejects symlink escapes and accepts a workspace reached through a symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-outside-'));
    const link = root + '-link';
    try {
      fs.writeFileSync(path.join(outside, 'outside.js'), 'eval(input);');
      fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect((await call('ai_guard_scan_file', { path: 'escape/outside.js' })).result.errors[0].code).toBe('OUTSIDE_WORKSPACE');
      expect((await call('ai_guard_scan_project')).result.errors[0].code).toBe('SYMLINK_IN_PROJECT');
      expect(validatePath('good.js', link).valid).toBe(true);
      expect((await scanFile({ path: 'good.js' }, root)).clean).toBe(true);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('closes the client/server transport', async () => {
    await client.close();
    await expect(client.listTools()).rejects.toThrow();
  });
  it('reports invalid startup workspaces only on stderr with a nonzero exit', () => {
    let failure: { status?: number; stdout?: Buffer; stderr?: Buffer } | undefined;
    try {
      execFileSync(process.execPath, [path.resolve('dist/mcp/server.js')], {
        env: { ...process.env, AI_GUARD_WORKSPACE: path.join(root, 'missing') }, stdio: 'pipe', timeout: 10000,
      });
    } catch (error) { failure = error as typeof failure; }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stdout)).toBe('');
    expect(String(failure?.stderr)).toContain('Fatal:');
  });
  it('runs the built executable over STDIO outside the repository, then shuts down', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/mcp/server.js')],
      cwd: root,
      env: { ...process.env, AI_GUARD_WORKSPACE: root, AI_GUARD_DEBUG: '1' } as Record<string, string>,
      stderr: 'pipe',
    });
    let diagnostics = '';
    transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    const stdioClient = new Client({ name: 'smoke', version: '1.0.0' });
    try {
      await stdioClient.connect(transport);
      expect((await stdioClient.listTools()).tools).toHaveLength(5);
      const response = await stdioClient.callTool({ name: 'ai_guard_scan_file', arguments: { path: 'bad.js' } });
      expect(response.structuredContent).toMatchObject({ success: true, clean: false, filesScanned: 1 });
      expect(diagnostics).toContain('Server started');
    } finally { await stdioClient.close(); }
    expect(transport.pid).toBeNull();
  }, 20000);
});
