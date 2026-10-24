/**
 * Inline directives must never silently hide AI Guard findings: every scan
 * path applies the same policy (allow / require-reason / ignore) and reports
 * what was hidden.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runEslint } from '../../cli/utils/eslint-runner';
import { scanFiles } from '../../src/mcp/utils/scan';

let dir: string;

const SOURCES: Record<string, string> = {
  'line.js': 'try { run(); } catch (e) {} // eslint-disable-line ai-guard/no-empty-catch\n',
  'next.js': '// eslint-disable-next-line ai-guard/no-empty-catch -- optional cleanup, failure is fine\ntry { run(); } catch (e) {}\n',
  'blanket.js': '/* eslint-disable */\ntry { run(); } catch (e) {}\n',
  'other-rule.js': '// eslint-disable-next-line no-console\ntry { run(); } catch (e) {}\n',
  'unrelated-ai-guard-rule.js': '// eslint-disable-next-line ai-guard/no-eval-dynamic\ntry { run(); } catch (e) {}\n',
  'inline-config.js': '/* eslint ai-guard/no-empty-catch: "off" */\ntry { run(); } catch (e) {}\n',
  'malformed.js': '// eslint-disable\ntry { run(); } catch (e) {}\n',
  'in-string.js': 'const s = "// eslint-disable-next-line ai-guard/no-empty-catch";\ntry { run(); } catch (e) {}\n',
  'plain.js': 'try { run(); } catch (e) {}\n',
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-suppress-'));
  for (const [f, src] of Object.entries(SOURCES)) fs.writeFileSync(path.join(dir, f), src, 'utf8');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const scan = (mode?: 'allow' | 'require-reason' | 'ignore') =>
  runEslint({ preset: 'recommended', targetPath: dir, files: Object.keys(SOURCES).map((f) => path.join(dir, f)), inlineSuppressions: mode });

const activeFiles = (r: Awaited<ReturnType<typeof scan>>): string[] => r.files.map((f) => path.basename(f.filePath)).sort();
const suppressedFiles = (r: Awaited<ReturnType<typeof scan>>): string[] => (r.suppressedIssues ?? []).map((s) => path.basename(s.filePath)).sort();

describe('inline suppression policy', () => {
  it('allow (default): honoured directives hide findings but are listed, others do not', async () => {
    const r = await scan();
    expect(r.inlineSuppressions).toBe('allow');
    expect(suppressedFiles(r)).toEqual(['blanket.js', 'inline-config.js', 'line.js', 'next.js']);
    expect(activeFiles(r)).toEqual(['in-string.js', 'malformed.js', 'other-rule.js', 'plain.js', 'unrelated-ai-guard-rule.js']);
    expect(r.totalIssues).toBe(5);
    const next = r.suppressedIssues!.find((s) => s.filePath.endsWith('next.js'))!;
    expect(next.issue.ruleId).toBe('ai-guard/no-empty-catch');
    expect(next.directive).toMatchObject({ kind: 'disable-next-line', line: 1, justification: 'optional cleanup, failure is fine' });
  }, 30000);

  it('require-reason: only justified directives hide findings', async () => {
    const r = await scan('require-reason');
    expect(suppressedFiles(r)).toEqual(['next.js']);
    const blanket = r.files.find((f) => f.filePath.endsWith('blanket.js'))!.issues[0];
    expect(blanket.suppression).toMatchObject({ kind: 'disable', honored: false, reason: 'missing-justification' });
  }, 30000);

  it('ignore: directives never hide findings and are annotated', async () => {
    const r = await scan('ignore');
    expect(r.suppressedIssues).toEqual([]);
    expect(r.totalIssues).toBe(Object.keys(SOURCES).length);
    const line = r.files.find((f) => f.filePath.endsWith('line.js'))!.issues[0];
    expect(line.suppression).toMatchObject({ kind: 'disable-line', honored: false, reason: 'mode-ignore' });
    // A directive for another rule is not an annotation on this finding.
    expect(r.files.find((f) => f.filePath.endsWith('other-rule.js'))!.issues[0].suppression).toBeUndefined();
  }, 30000);

  it('MCP scans use ignore mode and expose the same directive annotation', async () => {
    const result = await scanFiles(['line.js', 'next.js'], 'recommended', fs.realpathSync(dir));
    expect(result).toMatchObject({ success: true, inlineSuppressions: 'ignore', totalIssues: 2 });
    const byFile = Object.fromEntries(result.issues.map((i) => [i.file, i]));
    expect(byFile['line.js'].inlineDirective).toMatchObject({ kind: 'disable-line', line: 1 });
    expect(byFile['next.js'].inlineDirective).toMatchObject({ kind: 'disable-next-line', justification: 'optional cleanup, failure is fine' });
  }, 30000);
});
