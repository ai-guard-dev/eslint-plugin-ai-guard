import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { addToLefthook, addToShellHook, addToSimpleGitHooks, detectHookManager, gitHookCommand, preCommitSnippet } from '../../cli/commands/init-git-hook';
import { verifyChange } from '../../cli/utils/verify';
import { createTempRepo, type TempRepo } from '../helpers/git-repo';

const CMD = gitHookCommand();

describe('init-git-hook', () => {
  it('runs verify on staged changes and never blocks on its own failure', () => {
    expect(CMD).toBe('npx --no ai-guard verify --staged --allow-unverified');
    expect(gitHookCommand({ checkDeps: true })).toBe(`${CMD} && npx --no ai-guard verify-deps --staged`);
  });

  it('adds to a shell hook once, keeping what is there', () => {
    expect(addToShellHook(null, CMD)).toBe(`#!/bin/sh\n${CMD}\n`);
    expect(addToShellHook('npx lint-staged\n', CMD)).toBe(`npx lint-staged\n${CMD}\n`);
    expect(addToShellHook(`npx lint-staged\n${CMD}\n`, CMD)).toBeNull();
  });

  it('appends a lefthook pre-commit section, or hands back a snippet when one exists', () => {
    expect(addToLefthook('', CMD)).toEqual({ content: `pre-commit:\n  commands:\n    ai-guard:\n      run: ${CMD}\n` });
    const withOther = addToLefthook('pre-push:\n  commands:\n    test:\n      run: npm test\n', CMD) as { content: string };
    expect(withOther.content).toMatch(/^pre-push:[\s\S]*\n\npre-commit:\n {2}commands:\n {4}ai-guard:/);
    expect(addToLefthook('pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n', CMD)).toEqual({ snippet: `    ai-guard:\n      run: ${CMD}\n` });
    expect(addToLefthook(`pre-commit:\n  commands:\n    ai-guard:\n      run: ${CMD}\n`, CMD)).toBeNull();
  });

  it('chains onto simple-git-hooks', () => {
    expect(addToSimpleGitHooks({ name: 'x', 'simple-git-hooks': { 'pre-commit': 'npx lint-staged' } }, CMD))
      .toEqual({ name: 'x', 'simple-git-hooks': { 'pre-commit': `npx lint-staged && ${CMD}` } });
    expect(addToSimpleGitHooks({ 'simple-git-hooks': { 'pre-commit': CMD } }, CMD)).toBeNull();
  });

  it('points the pre-commit framework at this repository', () => {
    expect(preCommitSnippet('1.5.0')).toContain('rev: v1.5.0');
    expect(preCommitSnippet('1.5.0')).toContain('id: ai-guard-verify');
    const manifest = fs.readFileSync(path.join(__dirname, '..', '..', '.pre-commit-hooks.yaml'), 'utf8');
    expect(manifest).toContain('id: ai-guard-verify');
    expect(manifest).toContain('entry: npx --no ai-guard verify --staged --allow-unverified');
  });

  it('detects the hook manager', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-gitmgr-'));
    try {
      expect(detectHookManager(dir)).toBe('git');
      fs.writeFileSync(path.join(dir, '.pre-commit-config.yaml'), 'repos: []\n');
      expect(detectHookManager(dir)).toBe('pre-commit');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { husky: '^9' } }));
      expect(detectHookManager(dir)).toBe('husky');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ 'simple-git-hooks': { 'pre-commit': 'x' } }));
      expect(detectHookManager(dir)).toBe('simple-git-hooks');
      fs.writeFileSync(path.join(dir, 'lefthook.yml'), '');
      expect(detectHookManager(dir)).toBe('lefthook');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify --staged checks what is staged', () => {
  let repo: TempRepo | null = null;
  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  const STUB = 'export function sendEmail(to) {\n  // TODO: integrate email provider\n  return true;\n}\n';
  const REAL = 'export function sendEmail(to) {\n  return fetch("/api/email", { method: "POST", body: JSON.stringify({ to }) });\n}\n';

  it('blocks a staged stub even when the working tree is already fixed', async () => {
    repo = createTempRepo({ 'package.json': '{"name":"demo","type":"module"}', 'src/app.js': 'export const ok = 1;\n' });
    repo.commit('initial');
    repo.write('src/email.js', STUB);
    repo.git('add', 'src/email.js');
    repo.write('src/email.js', REAL); // fixed on disk, not staged
    const staged = await verifyChange({ cwd: repo.dir, staged: true, isolated: true });
    expect(staged.blocking.map((f) => f.check)).toContain('ai-guard/no-placeholder-implementation');
    expect(staged.pass).toBe(false);
  }, 60_000);

  it('passes a clean staged version even when the working tree has a stub', async () => {
    repo = createTempRepo({ 'package.json': '{"name":"demo","type":"module"}', 'src/app.js': 'export const ok = 1;\n' });
    repo.commit('initial');
    repo.write('src/email.js', REAL);
    repo.git('add', 'src/email.js');
    repo.write('src/email.js', STUB); // not staged
    const staged = await verifyChange({ cwd: repo.dir, staged: true, isolated: true });
    expect(staged.blocking).toEqual([]);
    expect(staged.pass).toBe(true);
  }, 60_000);
});
