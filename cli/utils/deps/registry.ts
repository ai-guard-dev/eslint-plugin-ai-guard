/**
 * registry.ts — a small client for the npm registry and download-count API,
 * with an on-disk cache.
 *
 * Network access is only used by commands that are explicitly about packages
 * (`verify-deps`, `ai_guard_check_package`, the opt-in install hook). Requests
 * time out quickly and failures surface as RegistryError, which callers report
 * as "could not check" and never as a finding.
 *
 * Cache: <tmp>/ai-guard/registry-cache (AI_GUARD_CACHE_DIR overrides). Found
 * packages are kept for a day; "not found" for ten minutes, because anyone can
 * register a missing name at any moment.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PKG_VERSION } from '../version.js';

export interface RegistryEndpoints {
  registry: string;
  downloads: string;
}

export const PUBLIC_ENDPOINTS: RegistryEndpoints = {
  registry: 'https://registry.npmjs.org',
  downloads: 'https://api.npmjs.org',
};

/** AI_GUARD_NPM_REGISTRY_URL / AI_GUARD_NPM_DOWNLOADS_URL point the client elsewhere (tests, mirrors). */
export function endpointsFromEnv(env: NodeJS.ProcessEnv = process.env): RegistryEndpoints {
  return {
    registry: (env.AI_GUARD_NPM_REGISTRY_URL || PUBLIC_ENDPOINTS.registry).replace(/\/+$/, ''),
    downloads: (env.AI_GUARD_NPM_DOWNLOADS_URL || PUBLIC_ENDPOINTS.downloads).replace(/\/+$/, ''),
  };
}

export class RegistryError extends Error {
  constructor(readonly code: 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE' | 'TOO_LARGE', message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface VersionFacts {
  version: string;
  deprecated: string | null;
  /** preinstall / install / postinstall scripts, plus node-gyp builds (binding.gyp). */
  installScripts: string[];
  /** npm replaced a removed (usually malicious) package with a placeholder. */
  securityHolder: boolean;
}

export interface PackageDocument {
  name: string;
  createdAt: string | null;
  distTags: Record<string, string>;
  versions: Record<string, VersionFacts>;
}

export type VersionLookup =
  | { status: 'ok'; facts: VersionFacts }
  | { status: 'package-not-found' }
  | { status: 'version-not-found' };

export interface RegistryClientOptions {
  endpoints?: RegistryEndpoints;
  timeoutMs?: number;
  /** null disables the disk cache. */
  cacheDir?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Package documents larger than this are not downloaded. */
  maxDocumentBytes?: number;
}

const DAY = 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL = 10 * 60 * 1000;
const USER_AGENT = `ai-guard/${PKG_VERSION} (+https://github.com/ai-guard-dev/eslint-plugin-ai-guard)`;

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_GUARD_CACHE_DIR || path.join(os.tmpdir(), 'ai-guard', 'registry-cache');
}

/** Registry URL path for a package name: the scope slash is encoded. */
export function registryPath(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall'] as const;

interface RawVersion {
  version?: unknown;
  deprecated?: unknown;
  scripts?: Record<string, unknown>;
  gypfile?: unknown;
  description?: unknown;
  repository?: unknown;
}

export function versionFacts(raw: RawVersion, fallbackVersion = ''): VersionFacts {
  const version = typeof raw.version === 'string' ? raw.version : fallbackVersion;
  const scripts = raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {};
  const installScripts: string[] = INSTALL_SCRIPT_KEYS.filter((k) => typeof scripts[k] === 'string' && (scripts[k] as string).trim() !== '');
  if (raw.gypfile === true && !installScripts.includes('install')) installScripts.push('node-gyp build');
  const description = typeof raw.description === 'string' ? raw.description : '';
  const repo = typeof raw.repository === 'object' && raw.repository !== null ? String((raw.repository as { url?: unknown }).url ?? '') : String(raw.repository ?? '');
  return {
    version,
    deprecated: typeof raw.deprecated === 'string' && raw.deprecated.trim() !== '' ? raw.deprecated.trim() : null,
    installScripts,
    securityHolder: /-security$/.test(version) && (/security holding package/i.test(description) || /npm\/security-holder/i.test(repo)),
  };
}

export class RegistryClient {
  private readonly endpoints: RegistryEndpoints;
  private readonly timeoutMs: number;
  private readonly cacheDir: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(options: RegistryClientOptions = {}) {
    this.endpoints = options.endpoints ?? endpointsFromEnv();
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.cacheDir = options.cacheDir === undefined ? defaultCacheDir() : options.cacheDir;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxDocumentBytes ?? 25 * 1024 * 1024;
  }

  /** Full package document (trimmed to what the checks use), or null when the package does not exist. */
  getPackage(name: string): Promise<PackageDocument | null> {
    return this.cached(`doc:${name}`, async () => {
      const res = await this.request(`${this.endpoints.registry}/${registryPath(name)}`);
      if (res.status === 404) return { value: null, ttl: NOT_FOUND_TTL };
      const raw = await this.json<{ name?: string; time?: Record<string, string>; 'dist-tags'?: Record<string, string>; versions?: Record<string, RawVersion> }>(res);
      const versions: Record<string, VersionFacts> = {};
      for (const [v, manifest] of Object.entries(raw.versions ?? {})) versions[v] = versionFacts(manifest, v);
      const doc: PackageDocument = {
        name: raw.name ?? name,
        createdAt: raw.time?.created ?? null,
        distTags: raw['dist-tags'] ?? {},
        versions,
      };
      return { value: doc, ttl: DAY };
    });
  }

  /** One version or dist-tag of a package (small request, used for well-known packages). */
  getVersion(name: string, versionOrTag: string): Promise<VersionLookup> {
    return this.cached(`version:${name}@${versionOrTag}`, async () => {
      const res = await this.request(`${this.endpoints.registry}/${registryPath(name)}/${encodeURIComponent(versionOrTag)}`);
      if (res.status === 404) {
        const body = (await res.text()).toLowerCase();
        const value: VersionLookup = body.includes('version not found') ? { status: 'version-not-found' } : { status: 'package-not-found' };
        return { value, ttl: NOT_FOUND_TTL };
      }
      const raw = await this.json<RawVersion>(res);
      return { value: { status: 'ok', facts: versionFacts(raw, versionOrTag) } as VersionLookup, ttl: DAY };
    });
  }

  /** Downloads in the last week; 0 when the API has no data yet (brand-new packages). */
  getWeeklyDownloads(name: string): Promise<number> {
    return this.cached(`downloads:${name}`, async () => {
      const res = await this.request(`${this.endpoints.downloads}/downloads/point/last-week/${name}`);
      if (res.status === 404) return { value: 0, ttl: NOT_FOUND_TTL };
      const raw = await this.json<{ downloads?: unknown }>(res);
      return { value: typeof raw.downloads === 'number' ? raw.downloads : 0, ttl: DAY };
    });
  }

  /**
   * Download counts for many unscoped packages in one request per 128 names
   * (the API's bulk form; scoped names are not supported there). Seeds the
   * cache that getWeeklyDownloads reads. Best effort: failures are ignored and
   * getWeeklyDownloads falls back to one request per package.
   */
  async prefetchWeeklyDownloads(names: string[]): Promise<void> {
    const pending = [...new Set(names)].filter((n) => !n.startsWith('@') && !this.memo.has(`downloads:${n}`) && this.readCache(`downloads:${n}`) === undefined);
    const chunks: string[][] = [];
    for (let i = 0; i < pending.length; i += 128) chunks.push(pending.slice(i, i + 128));
    await Promise.all(chunks.filter((c) => c.length > 1).map(async (chunk) => {
      try {
        const res = await this.request(`${this.endpoints.downloads}/downloads/point/last-week/${chunk.join(',')}`);
        if (res.status !== 200) return;
        const raw = await this.json<Record<string, { downloads?: unknown } | null>>(res);
        for (const name of chunk) {
          const entry = raw[name];
          const value = entry && typeof entry.downloads === 'number' ? entry.downloads : 0;
          this.store(`downloads:${name}`, value, entry ? DAY : NOT_FOUND_TTL);
        }
      } catch { /* fall back to single requests */ }
    }));
  }

  private async request(url: string, retried = false): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new RegistryError(timeout ? 'TIMEOUT' : 'NETWORK', `${timeout ? 'Timed out' : 'Could not connect'} requesting ${new URL(url).host}`);
    }
    if (res.status === 429 && !retried) {
      // Rate limited: wait as asked (at most 2 s) and try once more.
      await res.body?.cancel();
      const seconds = Number(res.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 2) * 1000 : 1000));
      return this.request(url, true);
    }
    if (res.status !== 200 && res.status !== 404) {
      throw new RegistryError('BAD_RESPONSE', `${new URL(url).host} answered HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > this.maxBytes) {
      await res.body?.cancel();
      throw new RegistryError('TOO_LARGE', `The package document is ${Math.round(length / 1e6)} MB, too large to check`);
    }
    return res;
  }

  private async json<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new RegistryError('BAD_RESPONSE', 'The registry returned invalid JSON');
    }
  }

  private cacheFile(key: string): string | null {
    if (!this.cacheDir) return null;
    const digest = crypto.createHash('sha256').update(`${this.endpoints.registry}\0${this.endpoints.downloads}\0${key}`).digest('hex').slice(0, 40);
    return path.join(this.cacheDir, `${digest}.json`);
  }

  /** A fresh cached value, or undefined. */
  private readCache<T>(key: string): T | undefined {
    const file = this.cacheFile(key);
    if (!file) return undefined;
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as { expires: number; value: T };
      if (typeof entry.expires === 'number' && entry.expires > this.now()) return entry.value;
    } catch { /* missing or unreadable */ }
    return undefined;
  }

  private store<T>(key: string, value: T, ttl: number): void {
    this.memo.set(key, Promise.resolve(value));
    const file = this.cacheFile(key);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ expires: this.now() + ttl, value }));
      fs.renameSync(tmp, file);
    } catch { /* the cache is an optimisation */ }
  }

  private cached<T>(key: string, load: () => Promise<{ value: T; ttl: number }>): Promise<T> {
    const existing = this.memo.get(key);
    if (existing) return existing as Promise<T>;
    const promise = (async (): Promise<T> => {
      const hit = this.readCache<T>(key);
      if (hit !== undefined) return hit;
      const { value, ttl } = await load();
      this.store(key, value, ttl);
      return value;
    })();
    this.memo.set(key, promise);
    promise.catch(() => this.memo.delete(key));
    return promise;
  }
}
