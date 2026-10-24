/**
 * Temporary Git repositories for before/after integration tests.
 * Local only: no remotes, no network.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export interface TempRepo {
  dir: string;
  write(file: string, content: string): void;
  remove(file: string): void;
  rename(from: string, to: string): void;
  git(...args: string[]): string;
  commit(message?: string): string;
  cleanup(): void;
}

export function createTempRepo(files: Record<string, string> = {}, opts: { commit?: boolean } = {}): TempRepo {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-integrity-')));
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  const write = (file: string, content: string): void => {
    const abs = path.join(dir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  };
  for (const [file, content] of Object.entries(files)) write(file, content);
  const commit = (message = 'commit'): string => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  if (opts.commit !== false && Object.keys(files).length > 0) commit('base');
  return {
    dir,
    write,
    remove: (file) => fs.rmSync(path.join(dir, file), { force: true }),
    rename: (from, to) => { fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true }); git('mv', from, to); },
    git,
    commit,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
