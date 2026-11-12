/**
 * A local stand-in for registry.npmjs.org and api.npmjs.org, so package-check
 * tests exercise the real HTTP client (404 bodies, timeouts, caching) without
 * the network. Responses follow the shapes of the real registry.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import type { RegistryEndpoints } from '../../cli/utils/deps/registry';

export interface FakeVersion {
  scripts?: Record<string, string>;
  deprecated?: string;
  description?: string;
  repository?: { type: string; url: string };
  gypfile?: boolean;
}

export interface FakePackage {
  created: string;
  latest: string;
  versions: Record<string, FakeVersion>;
  distTags?: Record<string, string>;
  /** null: the downloads API answers 404. */
  downloads?: number | null;
}

export interface FakeRegistry {
  endpoints: RegistryEndpoints;
  /** Paths requested, in order. */
  requests: string[];
  close(): Promise<void>;
}

export const DAY = 86_400_000;
/** Fixed "now" for tests. */
export const NOW = Date.parse('2026-11-12T12:00:00Z');
export const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

/** A long-established package with the given download count. */
export function established(downloads = 50_000, extra: FakeVersion = {}): FakePackage {
  return { created: daysAgo(2000), latest: '1.0.0', versions: { '1.0.0': extra }, downloads };
}

function manifest(name: string, version: string, v: FakeVersion): Record<string, unknown> {
  return { name, version, ...v };
}

export async function startFakeRegistry(packages: Record<string, FakePackage>, options: { delayMs?: number } = {}): Promise<FakeRegistry> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    requests.push(url);
    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    const respond = (): void => {
      const downloads = /^\/downloads\/point\/last-week\/(.+)$/.exec(url);
      if (downloads && downloads[1].includes(',')) {
        // Bulk form: unscoped names only, like the real API.
        const names = downloads[1].split(',');
        if (names.some((n) => n.startsWith('@'))) return send(400, { error: 'scoped packages are not supported in bulk queries' });
        return send(200, Object.fromEntries(names.map((n) => {
          const pkg = packages[n];
          return [n, !pkg || pkg.downloads === null ? null : { downloads: pkg.downloads ?? 0, package: n }];
        })));
      }
      if (downloads) {
        const pkg = packages[downloads[1]];
        if (!pkg || pkg.downloads === null) return send(404, { error: `package ${downloads[1]} not found` });
        return send(200, { downloads: pkg.downloads ?? 0, start: '2026-11-05', end: '2026-11-11', package: downloads[1] });
      }
      const parts = url.slice(1).split('/');
      const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      const rest = parts.slice(name.startsWith('@') ? 2 : 1);
      const pkg = packages[name];
      if (rest.length === 0) {
        if (!pkg) return send(404, { error: 'Not found' });
        const versions = Object.fromEntries(Object.entries(pkg.versions).map(([v, data]) => [v, manifest(name, v, data)]));
        return send(200, { name, 'dist-tags': { latest: pkg.latest, ...pkg.distTags }, time: { created: pkg.created }, versions });
      }
      if (!pkg) return send(404, 'Not Found');
      const wanted = rest.join('/');
      const version = pkg.versions[wanted] ? wanted : wanted === 'latest' ? pkg.latest : pkg.distTags?.[wanted];
      if (!version || !pkg.versions[version]) return send(404, `version not found: ${wanted}`);
      return send(200, manifest(name, version, pkg.versions[version]));
    };
    if (options.delayMs) setTimeout(respond, options.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoints: { registry: base, downloads: base },
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** An address nothing listens on. */
export async function closedEndpoint(): Promise<RegistryEndpoints> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { registry: base, downloads: base };
}
