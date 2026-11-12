/**
 * Fresh-release check: a version published in the last day is reported (and
 * the install hook asks), unless the package manager's cooldown covers it.
 * Fake registry, real HTTP client; the tarball Last-Modified behaviour follows
 * measurements of registry.npmjs.org.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assessPackage, type AssessContext } from '../../cli/utils/deps/assess';
import { cooldownCovers, cooldownTip, detectPackageManager, readReleaseCooldown, type ReleaseCooldown } from '../../cli/utils/deps/cooldown';
import { guardInstallCommand } from '../../cli/utils/deps/install-guard';
import { parsePackageArg, rangeIncludes } from '../../cli/utils/deps/package-spec';
import { RegistryClient } from '../../cli/utils/deps/registry';
import type { RegistryConfig } from '../../cli/utils/deps/registry-config';
import { checkPackageTool } from '../../src/mcp/tools/check-package';
import { daysAgo, NOW, startFakeRegistry, type FakePackage, type FakeRegistry } from '../helpers/fake-registry';

const PUBLIC: RegistryConfig = { publicDefault: true, customScopes: new Set(), sources: [] };
const HOUR = 3_600_000;
const hoursAgo = (h: number): string => new Date(NOW - h * HOUR).toISOString();

let registry: FakeRegistry | null = null;
const dirs: string[] = [];
// Cooldowns read from disk must not come from the developer's own ~/.npmrc.
const userconfig = process.env.npm_config_userconfig;
beforeAll(() => { process.env.npm_config_userconfig = path.join(os.tmpdir(), 'ai-guard-fresh-no-npmrc'); });
afterAll(() => {
  if (userconfig === undefined) delete process.env.npm_config_userconfig;
  else process.env.npm_config_userconfig = userconfig;
});
afterEach(async () => {
  await registry?.close();
  registry = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-fresh-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

/** An established package whose latest release went out `hours` ago. */
function releasedHoursAgo(hours: number, downloads = 2_000_000, extra: Partial<FakePackage> = {}): FakePackage {
  return {
    created: daysAgo(3000),
    latest: '2.1.0',
    versions: { '2.0.0': { published: daysAgo(40) }, '2.1.0-beta.1': { published: daysAgo(3) }, '2.1.0': { published: hoursAgo(hours) } },
    downloads,
    ...extra,
  };
}

async function setup(packages: Record<string, FakePackage>, extra: Partial<AssessContext> = {}): Promise<AssessContext> {
  registry = await startFakeRegistry(packages);
  return {
    client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, now: () => NOW }),
    registryConfig: PUBLIC,
    cwd: process.cwd(),
    now: () => NOW,
    confirmRegistry: () => true,
    cooldown: null,
    ...extra,
  };
}

const req = (arg: string) => parsePackageArg(arg)!;
const checks = (a: { findings: Array<{ check: string }> }): string[] => a.findings.map((f) => f.check);
const cooldown = (minutes: number, exclude: string[] = []): ReleaseCooldown => ({ manager: 'npm', minutes, exclude, source: 'test' });

describe('rangeIncludes', () => {
  it.each([
    ['^1.2.3', '1.9.0', true], ['^1.2.3', '2.0.0', false], ['^1.2.3', '1.2.2', false],
    ['^0.2.3', '0.2.9', true], ['^0.2.3', '0.3.0', false], ['^0.0.3', '0.0.3', true], ['^0.0.3', '0.0.4', false],
    ['^1', '1.99.0', true], ['^1.2', '1.2.0', true], ['^0.0', '0.0.9', true], ['^0.0', '0.1.0', false],
    ['~1.2.3', '1.2.9', true], ['~1.2.3', '1.3.0', false], ['~1', '1.9.0', true], ['~1.2', '1.3.0', false],
    ['1', '1.4.0', true], ['1', '2.0.0', false], ['1.2', '1.2.7', true], ['1.x', '1.8.0', true], ['1.2.x', '1.3.0', false],
    ['>=2.0.0', '9.0.0', true], ['>=2.0.0', '1.9.9', false],
    ['1.2.3', '1.2.3', true], ['=1.2.3', '1.2.4', false], [null, '3.0.0', true], ['*', '3.0.0', true],
    ['^1.0.0', '1.1.0-beta.1', false], [null, '1.1.0-beta.1', false],
  ] as const)('%s includes %s: %s', (range, version, expected) => {
    expect(rangeIncludes(range, version)).toBe(expected);
  });

  it.each(['^1.0.0 || ^2.0.0', '1.0.0 - 2.0.0', '<2', '>1.0.0 <2.0.0', '^1.0.0-beta', 'next'])('does not guess at %s', (range) => {
    expect(rangeIncludes(range, '1.5.0')).toBeNull();
  });
});

describe('fresh releases of popular packages', () => {
  it('are found from the tarball headers, without downloading the package document', async () => {
    const ctx = await setup({ axios: releasedHoursAgo(3) });
    const a = await assessPackage(req('axios'), ctx);
    expect(checks(a)).toEqual(['fresh-release']);
    expect(a.verdict).toBe('warning');
    expect(a.findings[0].message).toContain('axios@2.1.0 was published 3 hours ago');
    expect(a.facts?.publishedAt).toBe(new Date(Date.parse(hoursAgo(3)) + 2000).toISOString().replace(/\.\d+Z$/, '.000Z'));
    expect(registry!.requests).toEqual(['/axios/latest', 'HEAD /axios/-/axios-2.1.0.tgz']);
  });

  it('are not reported once the release is a day old', async () => {
    const ctx = await setup({ axios: releasedHoursAgo(25) });
    expect(checks(await assessPackage(req('axios'), ctx))).toEqual([]);
  });

  it('apply to the version being installed: an exact older version or a range that excludes latest is not fresh', async () => {
    const ctx = await setup({ axios: releasedHoursAgo(3) });
    expect(checks(await assessPackage(req('axios@2.0.0'), ctx))).toEqual([]);
    expect(checks(await assessPackage(req('axios@~2.0.0'), ctx))).toEqual([]);
    expect(checks(await assessPackage(req('axios@^2.0.0'), ctx))).toEqual(['fresh-release']);
    expect(checks(await assessPackage(req('axios@2.1.0'), ctx))).toEqual(['fresh-release']);
    // A range we cannot evaluate is skipped rather than guessed.
    expect(checks(await assessPackage(req('axios@>=1 <3'), ctx))).toEqual([]);
  });

  it('are not looked up when the check is off or a cooldown covers the window', async () => {
    const off = await setup({ axios: releasedHoursAgo(3) }, { freshHours: 0 });
    expect(checks(await assessPackage(req('axios'), off))).toEqual([]);
    await registry!.close();
    const covered = await setup({ axios: releasedHoursAgo(3) }, { cooldown: cooldown(3 * 1440) });
    expect(checks(await assessPackage(req('axios'), covered))).toEqual([]);
    expect(registry!.requests).toEqual(['/axios/latest']);
  });

  it('ignore a cooldown that excludes the package', async () => {
    const ctx = await setup({ axios: releasedHoursAgo(3) }, { cooldown: cooldown(1440, ['ax*']) });
    expect(checks(await assessPackage(req('axios'), ctx))).toEqual(['fresh-release']);
  });

  it('with a shorter cooldown, report only releases the package manager would install', async () => {
    const young = await setup({ axios: releasedHoursAgo(3) }, { cooldown: cooldown(6 * 60) });
    expect(checks(await assessPackage(req('axios'), young))).toEqual([]);
    await registry!.close();
    const older = await setup({ axios: releasedHoursAgo(10) }, { cooldown: cooldown(6 * 60) });
    expect(checks(await assessPackage(req('axios'), older))).toEqual(['fresh-release']);
  });

  it('honour a custom window', async () => {
    const ctx = await setup({ axios: releasedHoursAgo(30) }, { freshHours: 72 });
    expect(checks(await assessPackage(req('axios'), ctx))).toEqual(['fresh-release']);
  });

  it('are not reported when the tarball has no Last-Modified header', async () => {
    const pkg = releasedHoursAgo(3);
    pkg.versions['2.1.0'].tarballModified = null;
    const ctx = await setup({ axios: pkg });
    const a = await assessPackage(req('axios'), ctx);
    expect(checks(a)).toEqual([]);
    expect(a.verdict).toBe('ok');
  });
});

describe('fresh releases of other packages', () => {
  it('are found from the package document and name the release before', async () => {
    const ctx = await setup({ 'some-mid-lib': releasedHoursAgo(5, 40_000) });
    const a = await assessPackage(req('some-mid-lib'), ctx);
    expect(checks(a)).toEqual(['fresh-release']);
    // The beta published three days ago is not suggested; the last stable release is.
    expect(a.findings[0].message).toContain('The release before it is some-mid-lib@2.0.0.');
    expect(a.facts?.publishedAt).toBe(hoursAgo(5));
    expect(registry!.requests.some((r) => r.startsWith('HEAD'))).toBe(false);
  });

  it('are left to the new-package warning when the package itself is new', async () => {
    const ctx = await setup({ 'brand-new-lib': { created: hoursAgo(5), latest: '0.1.0', versions: { '0.1.0': { published: hoursAgo(5) } }, downloads: 5_000 } });
    expect(checks(await assessPackage(req('brand-new-lib'), ctx))).toEqual(['new-package']);
  });
});

describe('registry client', () => {
  it('reads publish times only from the registry host', async () => {
    registry = await startFakeRegistry({});
    const client = new RegistryClient({ endpoints: registry.endpoints, cacheDir: null });
    expect(await client.getPublishTime('x', '1.0.0', 'https://elsewhere.example/x-1.0.0.tgz')).toBeNull();
    expect(registry.requests).toEqual([]);
  });

  it('keeps "latest" for ten minutes and an exact version for a day', async () => {
    registry = await startFakeRegistry({ axios: releasedHoursAgo(30) });
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-fresh-cache-'));
    dirs.push(cacheDir);
    let now = NOW;
    const client = () => new RegistryClient({ endpoints: registry!.endpoints, cacheDir, now: () => now });
    await client().getVersion('axios', 'latest');
    await client().getVersion('axios', '2.0.0');
    now += 11 * 60_000;
    await client().getVersion('axios', 'latest');
    await client().getVersion('axios', '2.0.0');
    expect(registry.requests).toEqual(['/axios/latest', '/axios/2.0.0', '/axios/latest']);
  });
});

describe('release cooldowns', () => {
  const home = (): string => tmp();

  it('npm: min-release-age in days, with exclusions', () => {
    const dir = tmp({ '.npmrc': 'min-release-age=3\nmin-release-age-exclude[]=@acme/*\nmin-release-age-exclude[]=left-pad\n' });
    const c = readReleaseCooldown(dir, 'npm', {}, home());
    expect(c).toMatchObject({ manager: 'npm', minutes: 3 * 1440, exclude: ['@acme/*', 'left-pad'] });
    expect(cooldownCovers(c, 'lodash', 1440)).toBe(true);
    expect(cooldownCovers(c, '@acme/ui', 1440)).toBe(false);
    expect(readReleaseCooldown(tmp(), 'npm', { npm_config_min_release_age: '1' }, home())?.minutes).toBe(1440);
    expect(readReleaseCooldown(tmp(), 'npm', {}, home())).toBeNull();
  });

  it('pnpm: minimumReleaseAge in minutes, and pnpm 11 turns it on by default', () => {
    const yaml = 'packages:\n  - apps/*\nminimumReleaseAge: 4320 # three days\nminimumReleaseAgeExclude:\n  - "@acme/*"\n  - webpack\n';
    expect(readReleaseCooldown(tmp({ 'pnpm-workspace.yaml': yaml }), 'pnpm', {}, home())).toMatchObject({ minutes: 4320, exclude: ['@acme/*', 'webpack'] });
    expect(readReleaseCooldown(tmp({ '.npmrc': 'minimum-release-age=60\n' }), 'pnpm', {}, home())?.minutes).toBe(60);
    expect(readReleaseCooldown(tmp({ 'package.json': '{"packageManager":"pnpm@11.2.0"}' }), 'pnpm', {}, home())?.minutes).toBe(1440);
    expect(readReleaseCooldown(tmp({ 'package.json': '{"packageManager":"pnpm@10.18.0"}' }), 'pnpm', {}, home())).toBeNull();
    // Turned off explicitly on pnpm 11.
    const off = readReleaseCooldown(tmp({ 'package.json': '{"packageManager":"pnpm@11.0.0"}', 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' }), 'pnpm', {}, home());
    expect(off?.minutes).toBe(0);
    expect(cooldownCovers(off, 'lodash', 60)).toBe(false);
  });

  it('yarn: npmMinimalAgeGate in minutes or as a duration', () => {
    expect(readReleaseCooldown(tmp({ '.yarnrc.yml': 'npmMinimalAgeGate: 2880\n' }), 'yarn', {}, home())?.minutes).toBe(2880);
    const c = readReleaseCooldown(tmp({ '.yarnrc.yml': 'npmMinimalAgeGate: "3d"\nnpmPreapprovedPackages: ["@acme/*", react]\n' }), 'yarn', {}, home());
    expect(c).toMatchObject({ minutes: 3 * 1440, exclude: ['@acme/*', 'react'] });
  });

  it('bun: minimumReleaseAge in seconds under [install]', () => {
    const toml = '[install]\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = ["@types/bun", "typescript"]\n';
    expect(readReleaseCooldown(tmp({ 'bunfig.toml': toml }), 'bun', {}, home())).toMatchObject({ minutes: 4320, exclude: ['@types/bun', 'typescript'] });
    expect(readReleaseCooldown(tmp({ 'bunfig.toml': '[test]\nminimumReleaseAge = 259200\n' }), 'bun', {}, home())).toBeNull();
  });

  it('the nearest configuration wins over the user configuration', () => {
    const user = tmp({ '.npmrc': 'min-release-age=7\n' });
    expect(readReleaseCooldown(tmp({ '.npmrc': 'min-release-age=1\n' }), 'npm', {}, user)?.minutes).toBe(1440);
    expect(readReleaseCooldown(tmp(), 'npm', {}, user)?.minutes).toBe(7 * 1440);
  });

  it('detects the package manager from packageManager or a single kind of lockfile', () => {
    expect(detectPackageManager(tmp({ 'package.json': '{"packageManager":"yarn@4.15.0"}', 'package-lock.json': '{}' }))).toBe('yarn');
    expect(detectPackageManager(tmp({ 'pnpm-lock.yaml': '' }))).toBe('pnpm');
    expect(detectPackageManager(tmp({ 'bun.lock': '' }))).toBe('bun');
    expect(detectPackageManager(tmp({ 'package-lock.json': '{}', 'yarn.lock': '' }))).toBeNull();
    expect(detectPackageManager(tmp())).toBeNull();
  });

  it('tips name each package manager\'s own setting', () => {
    expect(cooldownTip('npm')).toContain('min-release-age=1');
    expect(cooldownTip(null)).toContain('min-release-age=1');
    expect(cooldownTip('pnpm')).toContain('minimumReleaseAge: 1440');
    expect(cooldownTip('yarn')).toContain('npmMinimalAgeGate: 1440');
    expect(cooldownTip('bun')).toContain('minimumReleaseAge = 86400');
  });
});

describe('install hook and MCP tool', () => {
  async function guard(command: string, packages: Record<string, FakePackage>, extra: { cooldown?: ReleaseCooldown | null; cwd?: string } = {}) {
    registry = await startFakeRegistry(packages);
    return guardInstallCommand(command, extra.cwd ?? tmp(), {
      client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, now: () => NOW }),
      registryConfig: PUBLIC,
      confirmRegistry: () => true,
      now: () => NOW,
      ...('cooldown' in extra ? { cooldown: extra.cooldown } : { cooldown: null }),
    });
  }

  it('asks before installing a fresh release, with the cooldown tip', async () => {
    const result = await guard('npm i axios', { axios: releasedHoursAgo(3) });
    expect(result?.decision).toBe('ask');
    expect(result?.reason).toContain('a release published in the last day');
    expect(result?.reason).toContain('axios@2.1.0 was published 3 hours ago');
    expect(result?.reason).toContain('min-release-age=1');
    expect(result?.context).toContain('install the previous version');
  });

  it('reads the cooldown of the package manager that runs the install', async () => {
    const dir = tmp({ 'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\n' });
    expect(await guard('pnpm add axios', { axios: releasedHoursAgo(3) }, { cwd: dir, cooldown: undefined })).toBeNull();
    await registry!.close();
    // npm does not read pnpm's setting.
    expect((await guard('npm i axios', { axios: releasedHoursAgo(3) }, { cwd: dir, cooldown: undefined }))?.decision).toBe('ask');
    await registry!.close();
    // Downloads to run are not assumed to honour the cooldown.
    expect((await guard('pnpm dlx axios', { axios: releasedHoursAgo(3) }, { cwd: dir, cooldown: undefined }))?.decision).toBe('ask');
  });

  it('a missing package still denies; a typosquat and a fresh release are asked together', async () => {
    const deny = await guard('npm i axios ghost-pkg-xyz', { axios: releasedHoursAgo(3) });
    expect(deny?.decision).toBe('deny');
    await registry!.close();
    const ask = await guard('npm i axios expresss', { axios: releasedHoursAgo(3), expresss: { created: daysAgo(2), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: 7 } });
    expect(ask?.decision).toBe('ask');
    expect(ask?.reason).toContain('looks risky');
    expect(ask?.reason).toContain('expresss');
    expect(ask?.reason).toContain('axios@2.1.0 was published');
  });

  it('MCP: a fresh release is not safe to install yet', async () => {
    // The tool uses the real clock, so publish times are relative to it.
    const at = (hours: number): FakePackage => ({
      created: new Date(Date.now() - 3000 * 86_400_000).toISOString(),
      latest: '2.1.0',
      versions: { '2.0.0': { published: new Date(Date.now() - 40 * 86_400_000).toISOString() }, '2.1.0': { published: new Date(Date.now() - hours * HOUR).toISOString() } },
      downloads: 1e6,
    });
    registry = await startFakeRegistry({ axios: at(3), lodash: at(400) });
    const client = new RegistryClient({ endpoints: registry.endpoints, cacheDir: null });
    const old = await checkPackageTool({ packages: ['lodash'] }, tmp(), client);
    expect(old.safeToInstall).toBe(true);
    const fresh = await checkPackageTool({ packages: ['lodash', 'axios'] }, tmp(), client);
    expect(fresh.safeToInstall).toBe(false);
    expect(fresh.packages.find((p) => p.name === 'axios')?.findings.map((f) => f.check)).toEqual(['fresh-release']);
    expect(fresh.packages.find((p) => p.name === 'axios')?.facts?.publishedAt).toBeTruthy();
  });
});
