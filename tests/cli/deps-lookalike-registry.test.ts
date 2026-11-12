import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPopularIndex, findLookalike, isOneEditAway, popularIndex } from '../../cli/utils/deps/lookalike';
import { isPublicRegistry, readRegistryConfig, usesPublicRegistry } from '../../cli/utils/deps/registry-config';
import { POPULAR_PACKAGES } from '../../cli/data/popular-packages';

describe('isOneEditAway', () => {
  it.each([
    ['expresss', 'express', true],
    ['lodahs', 'lodash', true],
    ['axois', 'axios', true],
    ['reqeust', 'request', true],
    ['lodash', 'lodash', false],
    ['lodash', 'lodahs1', false],
    ['abcde', 'edcba', false],
  ])('%s vs %s', (a, b, expected) => {
    expect(isOneEditAway(a, b)).toBe(expected);
  });
});

describe('findLookalike', () => {
  const index = popularIndex();

  it('bundles the most-downloaded npm packages', () => {
    expect(POPULAR_PACKAGES.length).toBe(5000);
    for (const name of ['react', 'express', 'lodash', '@types/node', 'cross-env', 'typescript']) expect(index.has(name)).toBe(true);
  });

  it.each([
    // Real typosquat shapes: doubled letter, swap, dropped separator, scope as prefix, affix.
    ['expresss', 'express'],
    ['lodahs', 'lodash'],
    ['axois', 'axios'],
    ['crossenv', 'cross-env'],
    ['babelcli', '@babel/cli'],
    ['jquerry', 'jquery'],
    ['types-node', '@types/node'],
    ['loadsh', 'lodash'],
    ['mongose', 'mongoose'],
    ['nodemailer-js', 'nodemailer'],
  ])('%s imitates %s', (name, target) => {
    expect(findLookalike(name, index)).toBe(target);
  });

  it.each([
    // Popular names never flag each other, and short names have too many neighbours to judge.
    'preact', 'react', 'vite', 'vitest', 'zod', 'ky', 'got', 'esbuild', 'tsup', 'execa', 'chalk', 'lodash-es', 'react-dom', 'eslint-plugin-ai-guard',
  ])('%s is not a look-alike', (name) => {
    expect(findLookalike(name, index)).toBeNull();
  });

  it('prefers the most downloaded match', () => {
    const small = buildPopularIndex(['alpha-pkg', 'alpha_pkg2', 'alphapkg']);
    expect(findLookalike('alpha.pkg', small)).toBe('alpha-pkg');
  });
});

describe('registry configuration', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-registry-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-home-'));
    fs.mkdirSync(path.join(dir, '.git'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const write = (file: string, content: string): void => fs.writeFileSync(path.join(dir, file), content);
  const read = (env: NodeJS.ProcessEnv = {}) => readRegistryConfig(dir, env, home);

  it('recognises the public registry and its mirrors of record', () => {
    expect(isPublicRegistry('https://registry.npmjs.org/')).toBe(true);
    expect(isPublicRegistry('https://registry.yarnpkg.com')).toBe(true);
    expect(isPublicRegistry('https://npm.acme.dev/')).toBe(false);
    expect(isPublicRegistry('${NPM_REGISTRY}')).toBe(false);
  });

  it('defaults to the public registry', () => {
    const cfg = read();
    expect(cfg.publicDefault).toBe(true);
    expect(usesPublicRegistry(cfg, '@acme/ui')).toBe(true);
  });

  it('reads a project .npmrc, ignoring comments', () => {
    write('.npmrc', '# registry=https://ignored.example/\nregistry=https://npm.acme.dev/\n');
    expect(read().publicDefault).toBe(false);
  });

  it('keeps unscoped packages public when only a scope is private', () => {
    write('.npmrc', '@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=${TOKEN}\n');
    const cfg = read();
    expect(usesPublicRegistry(cfg, '@acme/ui')).toBe(false);
    expect(usesPublicRegistry(cfg, '@other/ui')).toBe(true);
    expect(usesPublicRegistry(cfg, 'lodash')).toBe(true);
  });

  it('treats an explicit public registry as public', () => {
    write('.npmrc', 'registry=https://registry.npmjs.org/\n');
    expect(read().publicDefault).toBe(true);
  });

  it('reads the environment and the user npmrc', () => {
    expect(read({ npm_config_registry: 'https://npm.acme.dev' }).publicDefault).toBe(false);
    expect(read({ NPM_CONFIG_REGISTRY: 'https://npm.acme.dev' }).publicDefault).toBe(false);
    fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://npm.acme.dev/\n');
    expect(read().publicDefault).toBe(false);
  });

  it('reads .yarnrc.yml, .yarnrc and bunfig.toml', () => {
    write('.yarnrc.yml', 'nodeLinker: node-modules\nnpmScopes:\n  acme:\n    npmRegistryServer: "https://npm.acme.dev"\n');
    const yarn = read();
    expect(usesPublicRegistry(yarn, '@acme/ui')).toBe(false);
    expect(yarn.publicDefault).toBe(true);

    write('.yarnrc.yml', 'npmRegistryServer: "https://npm.acme.dev"\n');
    expect(read().publicDefault).toBe(false);
    fs.rmSync(path.join(dir, '.yarnrc.yml'));

    write('.yarnrc', 'registry "https://npm.acme.dev"\n');
    expect(read().publicDefault).toBe(false);
    fs.rmSync(path.join(dir, '.yarnrc'));

    write('bunfig.toml', '[install.scopes]\nacme = { token = "$TOKEN", url = "https://npm.acme.dev/" }\n');
    expect(usesPublicRegistry(read(), '@acme/ui')).toBe(false);
    write('bunfig.toml', '[install]\nregistry = "https://npm.acme.dev/"\n');
    expect(read().publicDefault).toBe(false);
  });

  it('finds an .npmrc in a parent directory of the project', () => {
    write('.npmrc', 'registry=https://npm.acme.dev/\n');
    const sub = path.join(dir, 'packages', 'web');
    fs.mkdirSync(sub, { recursive: true });
    expect(readRegistryConfig(sub, {}, home).publicDefault).toBe(false);
  });
});
