import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessPackage, assessPackages, type AssessContext } from '../../cli/utils/deps/assess';
import { parsePackageArg } from '../../cli/utils/deps/package-spec';
import { RegistryClient } from '../../cli/utils/deps/registry';
import type { RegistryConfig } from '../../cli/utils/deps/registry-config';
import { closedEndpoint, daysAgo, established, NOW, startFakeRegistry, type FakePackage, type FakeRegistry } from '../helpers/fake-registry';

const PUBLIC: RegistryConfig = { publicDefault: true, customScopes: new Set(), sources: [] };
let registry: FakeRegistry | null = null;
afterEach(async () => {
  await registry?.close();
  registry = null;
});

async function setup(packages: Record<string, FakePackage>, extra: Partial<AssessContext> = {}): Promise<AssessContext> {
  registry = await startFakeRegistry(packages);
  return {
    client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, now: () => NOW }),
    registryConfig: PUBLIC,
    cwd: process.cwd(),
    now: () => NOW,
    confirmRegistry: () => true,
    ...extra,
  };
}

const req = (arg: string) => parsePackageArg(arg)!;
const checks = (a: { findings: Array<{ check: string }> }): string[] => a.findings.map((f) => f.check);

describe('popular packages', () => {
  it('are checked with one small request and a HEAD for the publish time, no age or download lookups', async () => {
    const ctx = await setup({ react: established() });
    const a = await assessPackage(req('react'), ctx);
    expect(a.verdict).toBe('ok');
    expect(a.facts?.popular).toBe(true);
    expect(registry!.requests).toEqual(['/react/latest', 'HEAD /react/-/react-1.0.0.tgz']);
  });

  it('report a deprecated version', async () => {
    const ctx = await setup({ request: established(1e6, { deprecated: 'request has been deprecated' }) });
    const a = await assessPackage(req('request'), ctx);
    expect(a.verdict).toBe('warning');
    expect(checks(a)).toEqual(['deprecated']);
    expect(a.findings[0].message).toContain('request has been deprecated');
  });

  it('block an exact version that does not exist, but leave ranges alone', async () => {
    const ctx = await setup({ react: established() });
    expect(checks(await assessPackage(req('react@99.0.0'), ctx))).toEqual(['version-not-found']);
    expect(checks(await assessPackage(req('react@^99.0.0'), ctx))).toEqual([]);
  });
});

describe('packages outside the popular list', () => {
  it('block a name that does not exist, suggesting the popular package it resembles', async () => {
    const ctx = await setup({});
    const a = await assessPackage(req('expresss'), ctx);
    expect(a.verdict).toBe('block');
    expect(checks(a)).toEqual(['package-not-found']);
    expect(a.findings[0].message).toContain('Did you mean "express"?');
  });

  it('skip a missing package when npm says it comes from a private registry', async () => {
    const ctx = await setup({}, { confirmRegistry: () => false });
    expect((await assessPackage(req('internal-tool'), ctx)).verdict).toBe('skipped');
  });

  it('block a new, barely downloaded look-alike as a typosquat', async () => {
    const ctx = await setup({ expresss: { created: daysAgo(3), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: 12 } });
    const a = await assessPackage(req('expresss'), ctx);
    expect(checks(a)).toEqual(['typosquat-suspect']);
    expect(a.findings[0].message).toMatch(/express.*first published 3 days ago, 12 downloads last week/);
    expect(a.similarTo).toBe('express');
  });

  it('warn on an established look-alike, and stay quiet once it is widely used', async () => {
    const ctx = await setup({ expresss: established(500), lodahs: established(80_000) });
    expect(checks(await assessPackage(req('expresss'), ctx))).toEqual(['lookalike-name']);
    expect(checks(await assessPackage(req('lodahs'), ctx))).toEqual([]);
  });

  it('block a new package that runs an install script; only warn for an established one', async () => {
    const ctx = await setup({
      'fresh-helper': { created: daysAgo(2), latest: '0.0.1', versions: { '0.0.1': { scripts: { postinstall: 'node steal.js' } } }, downloads: 40 },
      'native-thing': established(5000, { scripts: { install: 'node-gyp rebuild' } }),
      'gyp-thing': established(5000, { gypfile: true }),
    });
    const fresh = await assessPackage(req('fresh-helper'), ctx);
    expect(checks(fresh)).toEqual(['install-script-unknown']);
    expect(fresh.findings[0].message).toContain('postinstall');
    expect(checks(await assessPackage(req('native-thing'), ctx))).toEqual(['install-script']);
    expect(checks(await assessPackage(req('gyp-thing'), ctx))).toEqual(['install-script']);
  });

  it('warn on a new package and on a rarely downloaded one', async () => {
    const ctx = await setup({
      'brand-new-lib': { created: daysAgo(5), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: 5000 },
      'quiet-old-lib': { created: daysAgo(900), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: 20 },
      'healthy-lib': established(3000),
    });
    expect(checks(await assessPackage(req('brand-new-lib'), ctx))).toEqual(['new-package']);
    expect(checks(await assessPackage(req('quiet-old-lib'), ctx))).toEqual(['low-downloads']);
    expect(checks(await assessPackage(req('healthy-lib'), ctx))).toEqual([]);
  });

  it('honours custom thresholds', async () => {
    const ctx = await setup({ 'some-lib': { created: daysAgo(10), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: 300 } }, { minAgeDays: 7, minWeeklyDownloads: 1000 });
    expect(checks(await assessPackage(req('some-lib'), ctx))).toEqual(['low-downloads']);
  });

  it('block an npm security placeholder', async () => {
    const holder = { description: 'security holding package', repository: { type: 'git', url: 'git+https://github.com/npm/security-holder.git' } };
    const ctx = await setup({ crossenv: { created: daysAgo(3000), latest: '0.0.2-security', versions: { '0.0.2-security': holder }, downloads: 2670 } });
    const a = await assessPackage(req('crossenv'), ctx);
    expect(checks(a)).toEqual(['security-holding']);
    expect(a.findings[0].message).toContain('Did you mean "cross-env"?');
  });

  it('block a version or dist-tag that does not exist', async () => {
    const ctx = await setup({ 'some-lib': established(3000) });
    expect(checks(await assessPackage(req('some-lib@2.0.0'), ctx))).toEqual(['version-not-found']);
    expect(checks(await assessPackage(req('some-lib@beta'), ctx))).toEqual(['version-not-found']);
    expect(checks(await assessPackage(req('some-lib@1.0.0'), ctx))).toEqual([]);
  });

  it('still judges the package when the downloads API is unavailable', async () => {
    const ctx = await setup({ 'quiet-old-lib': { created: daysAgo(900), latest: '1.0.0', versions: { '1.0.0': {} }, downloads: null } });
    const a = await assessPackage(req('quiet-old-lib'), ctx);
    // A 404 from the downloads API means no data yet: counted as 0 downloads.
    expect(checks(a)).toEqual(['low-downloads']);
  });
});

describe('never a finding without evidence', () => {
  it('skips scopes served by a private registry without contacting anything', async () => {
    const ctx = await setup({}, { registryConfig: { publicDefault: true, customScopes: new Set(['@acme']), sources: ['.npmrc'] } });
    const a = await assessPackage(req('@acme/ui'), ctx);
    expect(a.verdict).toBe('skipped');
    expect(registry!.requests).toEqual([]);
  });

  it('reports a network failure as unchecked, with no findings', async () => {
    const ctx: AssessContext = {
      client: new RegistryClient({ endpoints: await closedEndpoint(), cacheDir: null }),
      registryConfig: PUBLIC, cwd: process.cwd(), confirmRegistry: () => true,
    };
    const a = await assessPackage(req('some-unknown-lib'), ctx);
    expect(a.verdict).toBe('unchecked');
    expect(a.findings).toEqual([]);
  });

  it('times out instead of hanging', async () => {
    registry = await startFakeRegistry({ 'slow-lib': established() }, { delayMs: 2000 });
    const ctx: AssessContext = {
      client: new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, timeoutMs: 200 }),
      registryConfig: PUBLIC, cwd: process.cwd(), confirmRegistry: () => true,
    };
    const a = await assessPackage(req('slow-lib'), ctx);
    expect(a.verdict).toBe('unchecked');
    expect(a.reason).toMatch(/Timed out/);
  });
});

describe('rate limits', () => {
  it('fetches download counts for unscoped packages in one bulk request', async () => {
    const ctx = await setup({ 'lib-one': established(900), 'lib-two': established(900), 'lib-three': established(900), '@me/scoped-lib': established(900) });
    await assessPackages(['lib-one', 'lib-two', 'lib-three', '@me/scoped-lib'].map(req), ctx);
    const downloads = registry!.requests.filter((r) => r.startsWith('/downloads/'));
    expect(downloads).toContain('/downloads/point/last-week/lib-one,lib-two,lib-three');
    expect(downloads).toContain('/downloads/point/last-week/@me/scoped-lib');
    expect(downloads).toHaveLength(2);
  });

  it('retries once when rate limited', async () => {
    registry = await startFakeRegistry({ 'some-lib': established(3000) });
    let calls = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      calls++;
      if (calls === 1) return Promise.resolve(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }));
      return fetch(input, init);
    };
    const client = new RegistryClient({ endpoints: registry.endpoints, cacheDir: null, fetchImpl });
    expect(await client.getWeeklyDownloads('some-lib')).toBe(3000);
    expect(calls).toBe(2);
  });
});

describe('batching and caching', () => {
  it('checks a repeated package once', async () => {
    const ctx = await setup({ react: established() });
    const results = await assessPackages([req('react'), req('react'), req('react')], ctx);
    expect(results).toHaveLength(3);
    expect(registry!.requests).toEqual(['/react/latest', 'HEAD /react/-/react-1.0.0.tgz']);
  });

  it('caches on disk, and forgets "not found" after ten minutes', async () => {
    registry = await startFakeRegistry({});
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-cache-'));
    try {
      let now = NOW;
      const client = (): RegistryClient => new RegistryClient({ endpoints: registry!.endpoints, cacheDir, now: () => now });
      expect(await client().getPackage('ghost-lib')).toBeNull();
      expect(await client().getPackage('ghost-lib')).toBeNull();
      expect(registry.requests).toHaveLength(1);
      now += 11 * 60 * 1000;
      expect(await client().getPackage('ghost-lib')).toBeNull();
      expect(registry.requests).toHaveLength(2);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
