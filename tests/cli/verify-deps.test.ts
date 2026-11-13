import { afterEach, describe, expect, it, vi } from 'vitest';

// These tests run real Git processes; the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { depsExitCode, depsToRunResult, verifyDeps, type DepsReport } from '../../cli/utils/deps/verify-deps';
import { RegistryClient } from '../../cli/utils/deps/registry';
import { createTempRepo, type TempRepo } from '../helpers/git-repo';
import { daysAgo, established, NOW, startFakeRegistry, type FakePackage, type FakeRegistry } from '../helpers/fake-registry';

let registry: FakeRegistry | null = null;
let repo: TempRepo | null = null;
afterEach(async () => {
  await registry?.close();
  registry = null;
  repo?.cleanup();
  repo = null;
});

const PACKAGES: Record<string, FakePackage> = {
  lodash: established(),
  react: established(),
  'quiet-lib': established(40),
  expresss: { created: daysAgo(3), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: 9 },
};

async function run(options: { all?: boolean; packages?: string[]; base?: string } = {}): Promise<DepsReport> {
  registry ??= await startFakeRegistry(PACKAGES);
  return verifyDeps({
    cwd: repo!.dir,
    ...options,
    client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, now: () => NOW }),
    confirmRegistry: () => true,
    now: () => NOW,
  });
}

const manifest = (deps: Record<string, string>, dev: Record<string, string> = {}, name = 'app'): string =>
  JSON.stringify({ name, version: '1.0.0', dependencies: deps, devDependencies: dev }, null, 2) + '\n';

describe('verify-deps: added dependencies', () => {
  it('checks only the dependencies the change added, at their package.json line', async () => {
    repo = createTempRepo({ 'package.json': manifest({ lodash: '^4.17.21' }) });
    repo.commit('initial');
    repo.write('package.json', manifest({ lodash: '^4.17.21', expresss: '^1.0.0' }, { 'quiet-lib': '1.0.0' }));

    const report = await run();
    expect(report.mode).toBe('added');
    expect(report.packages.map((p) => p.name)).toEqual(['expresss', 'quiet-lib']);
    expect(registry!.requests.some((r) => r.includes('lodash'))).toBe(false);
    const typosquat = report.packages.find((p) => p.name === 'expresss')!;
    expect(typosquat).toMatchObject({ manifest: 'package.json', field: 'dependencies', line: 6, verdict: 'block' });
    expect(typosquat.findings.map((f) => f.check)).toEqual(['typosquat-suspect']);
    expect(report.packages.find((p) => p.name === 'quiet-lib')!.findings.map((f) => f.check)).toEqual(['low-downloads']);
    expect(report).toMatchObject({ blocked: 1, warnings: 1, checked: 2 });
    expect(depsExitCode(report, 'error')).toBe(1);
    expect(depsExitCode(report, 'none')).toBe(0);
  });

  it('warns about a dependency whose newest matching release is a few hours old, unless a cooldown covers it', async () => {
    const fresh: FakePackage = {
      created: daysAgo(3000), latest: '5.2.0', downloads: 3_000_000,
      versions: { '5.1.0': { published: daysAgo(30) }, '5.2.0': { published: new Date(NOW - 4 * 3_600_000).toISOString() } },
    };
    registry = await startFakeRegistry({ ...PACKAGES, axios: fresh });
    repo = createTempRepo({ 'package.json': manifest({}), 'package-lock.json': '{}\n' });
    repo.commit('initial');
    repo.write('package.json', manifest({ axios: '^5.2.0', react: '^18.3.1' }));
    // The user's own ~/.npmrc must not decide this test.
    const userconfig = process.env.npm_config_userconfig;
    process.env.npm_config_userconfig = `${repo.dir}/no-such-npmrc`;
    try {
      await checkFresh();
    } finally {
      if (userconfig === undefined) delete process.env.npm_config_userconfig;
      else process.env.npm_config_userconfig = userconfig;
    }
  });

  async function checkFresh(): Promise<void> {
    const report = await run();
    expect(report.packageManager).toBe('npm');
    expect(report.cooldown).toBeNull();
    expect(report.cooldownTip).toContain('min-release-age=1');
    const axios = report.packages.find((p) => p.name === 'axios')!;
    expect(axios.findings.map((f) => f.check)).toEqual(['fresh-release']);
    expect(report).toMatchObject({ blocked: 0, warnings: 1 });
    expect(depsExitCode(report, 'error')).toBe(0);
    expect(depsExitCode(report, 'warning')).toBe(1);
    expect(depsToRunResult(report).files[0].issues.map((i) => i.ruleId)).toEqual(['ai-guard/deps/fresh-release']);

    repo!.write('.npmrc', 'min-release-age=1\n');
    const covered = await run();
    expect(covered.cooldown).toMatchObject({ manager: 'npm', minutes: 1440 });
    expect(covered.cooldownTip).toBeNull();
    expect(covered.warnings).toBe(0);
  }

  it('does not count a version change or a dependency moved between fields as added', async () => {
    repo = createTempRepo({ 'package.json': manifest({ lodash: '^4.0.0' }, { react: '^18.0.0' }) });
    repo.commit('initial');
    repo.write('package.json', manifest({ lodash: '^4.17.21', react: '^18.3.1' }));
    const report = await run();
    expect(report.packages).toEqual([]);
    expect(depsExitCode(report, 'error')).toBe(0);
  });

  it('leaves out workspace packages and non-registry dependencies', async () => {
    repo = createTempRepo({
      'package.json': manifest({}),
      'packages/ui/package.json': manifest({}, {}, '@me/ui'),
    });
    repo.commit('initial');
    repo.write('package.json', manifest({
      '@me/ui': 'workspace:*', local: 'file:../local', forked: 'github:me/forked', tarball: 'https://example.com/x.tgz', react: '^18.3.1',
    }));
    const report = await run();
    expect(report.packages.map((p) => p.name)).toEqual(['react']);
    expect(report.blocked).toBe(0);
  });

  it('checks dependencies of a package.json the change created', async () => {
    repo = createTempRepo({ 'README.md': '# app\n' });
    repo.commit('initial');
    repo.write('apps/web/package.json', manifest({ expresss: '1.0.0' }));
    const report = await run();
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0]).toMatchObject({ manifest: 'apps/web/package.json', verdict: 'block' });
  });

  it('reports a package.json that does not parse', async () => {
    repo = createTempRepo({ 'package.json': manifest({}) });
    repo.commit('initial');
    repo.write('package.json', '{ "dependencies": { "x": "1" ');
    const report = await run();
    expect(report.errors[0]).toMatchObject({ code: 'INVALID_MANIFEST', file: 'package.json' });
  });

  it('turns findings into SARIF-ready issues at the dependency line', async () => {
    repo = createTempRepo({ 'package.json': manifest({}) });
    repo.commit('initial');
    repo.write('package.json', manifest({ expresss: '1.0.0' }));
    const result = depsToRunResult(await run());
    expect(result.totalErrors).toBe(1);
    // Line 5: `{`, name, version, `"dependencies": {`, then the entry.
    expect(result.files[0].issues[0]).toMatchObject({ ruleId: 'ai-guard/deps/typosquat-suspect', line: 5, severity: 2 });
  });
});

describe('verify-deps: other modes', () => {
  it('--all checks every declared dependency', async () => {
    repo = createTempRepo({ 'package.json': manifest({ lodash: '^4.17.21', expresss: '1.0.0' }) });
    repo.commit('initial');
    const report = await run({ all: true });
    expect(report.mode).toBe('all');
    expect(report.packages.map((p) => p.name).sort()).toEqual(['expresss', 'lodash']);
  });

  it('checks packages named directly and rejects arguments that are not registry packages', async () => {
    repo = createTempRepo({});
    const report = await run({ packages: ['lodash', 'ghost-lib-xyz', 'user/repo'] });
    expect(report.mode).toBe('packages');
    expect(report.packages.map((p) => [p.name, p.verdict])).toEqual([['lodash', 'ok'], ['ghost-lib-xyz', 'block']]);
    expect(report.errors[0].code).toBe('NOT_A_REGISTRY_PACKAGE');
  });

  it('exits 2 when packages could not be checked and nothing is blocked', () => {
    const base = { success: true, root: '.', mode: 'packages' as const, base: null, packages: [], checked: 0, blocked: 0, warnings: 0, skipped: 0, errors: [], durationMs: 0 };
    expect(depsExitCode({ ...base, unchecked: 1 }, 'error')).toBe(2);
    expect(depsExitCode({ ...base, unchecked: 1, blocked: 1 }, 'error')).toBe(1);
    expect(depsExitCode({ ...base, unchecked: 0, warnings: 2 }, 'warning')).toBe(1);
    expect(depsExitCode({ ...base, unchecked: 0, warnings: 2 }, 'error')).toBe(0);
    expect(depsExitCode({ ...base, success: false, unchecked: 0 }, 'none')).toBe(2);
  });

  it('fails cleanly outside a Git repository in added mode', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-nogit-'));
    try {
      registry = await startFakeRegistry(PACKAGES);
      const report = await verifyDeps({ cwd: dir, client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null }), confirmRegistry: () => true });
      expect(report.success).toBe(false);
      expect(report.errors[0].code).toBe('GIT_FAILED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
