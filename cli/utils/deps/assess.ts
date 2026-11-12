/**
 * assess.ts — decide whether an npm package is safe to install.
 *
 * One weak signal is a warning: a new package, few downloads, an install
 * script, a name close to a popular package, a deprecation. Plenty of good
 * packages have one of these. A package is blocked only on facts or on a
 * combination that matches how malicious packages look:
 *
 *   package-not-found       the name does not exist (invented by an assistant)
 *   version-not-found       the requested version does not exist
 *   security-holding        npm removed this package and left a placeholder
 *   typosquat-suspect       look-alike name + new or rarely downloaded
 *   install-script-unknown  install script + new or rarely downloaded
 *
 * fresh-release is a warning with its own handling in the install hook (the
 * user is asked): the version being installed was published in the last day
 * (DEFAULT_FRESH_HOURS). Hijacked releases of popular packages are published
 * like any other release and are usually removed within hours. Skipped when
 * the project's package manager already enforces a release cooldown that long.
 *
 * Packages in the bundled popular list skip the age and download lookups:
 * they are established by definition, and their documents can be huge.
 */

import type { PackageRequest } from './package-spec.js';
import { isDistTag, isExactVersion, rangeIncludes } from './package-spec.js';
import { RegistryError, type RegistryClient, type VersionFacts } from './registry.js';
import { confirmPublicRegistry, usesPublicRegistry, type RegistryConfig } from './registry-config.js';
import { findLookalike, popularIndex, type PopularIndex } from './lookalike.js';
import { DEPENDENCY_CHECKS, type DependencyCheck } from '../check-catalog.js';
import { cooldownCovers, type ReleaseCooldown } from './cooldown.js';

export type DepCheck = DependencyCheck;

/** Checks that block (error severity in the catalog). The rest are warnings. */
export const BLOCKING_DEP_CHECKS: ReadonlySet<DepCheck> = new Set(
  (Object.keys(DEPENDENCY_CHECKS) as DepCheck[]).filter((check) => DEPENDENCY_CHECKS[check].severity === 'error'),
);

/** Blocking checks that are facts: installing would fail or install a placeholder. */
export const FACT_DEP_CHECKS: ReadonlySet<DepCheck> = new Set(['package-not-found', 'version-not-found', 'security-holding']);

/** Warnings the install hook asks the user about instead of only passing them on. */
export const ASK_DEP_CHECKS: ReadonlySet<DepCheck> = new Set(['fresh-release']);

export interface DepFinding {
  check: DepCheck;
  severity: 'error' | 'warning';
  message: string;
}

export interface PackageFacts {
  popular: boolean;
  version: string | null;
  createdAt: string | null;
  ageDays: number | null;
  weeklyDownloads: number | null;
  installScripts: string[];
  deprecated: string | null;
  /** When the checked version was published, when it was looked up. */
  publishedAt?: string | null;
}

export type Verdict = 'ok' | 'warning' | 'block' | 'skipped' | 'unchecked';

export interface PackageAssessment {
  request: PackageRequest;
  verdict: Verdict;
  /** Why the package was skipped or could not be checked. */
  reason?: string;
  findings: DepFinding[];
  facts?: PackageFacts;
  /** Popular package the name resembles. */
  similarTo?: string;
}

export interface AssessContext {
  client: RegistryClient;
  registryConfig: RegistryConfig;
  /** Directory installs run in (for `npm config get`). */
  cwd: string;
  minAgeDays?: number;
  minWeeklyDownloads?: number;
  popular?: PopularIndex;
  now?: () => number;
  /** Confirms the public registry before reporting a missing package (injectable for tests). */
  confirmRegistry?: (cwd: string, name: string) => boolean;
  /** Parallel registry requests. */
  concurrency?: number;
  /** Versions published fewer hours ago are fresh releases; 0 turns the check off. */
  freshHours?: number;
  /** Release cooldown the package manager enforces (skips the fresh-release check when it covers the window). */
  cooldown?: ReleaseCooldown | null;
}

export const DEFAULT_MIN_AGE_DAYS = 30;
export const DEFAULT_MIN_WEEKLY_DOWNLOADS = 100;
/** One day, the window pnpm 11 enforces by default. */
export const DEFAULT_FRESH_HOURS = 24;
/** Above this, a look-alike name belongs to an established package of its own. */
const ESTABLISHED_DOWNLOADS = 10_000;

function finding(check: DepCheck, message: string): DepFinding {
  return { check, severity: BLOCKING_DEP_CHECKS.has(check) ? 'error' : 'warning', message };
}

export function describeAge(days: number): string {
  if (days < 1) return 'less than a day ago';
  if (days < 2) return '1 day ago';
  if (days < 60) return `${Math.floor(days)} days ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function verdictOf(findings: DepFinding[]): Verdict {
  if (findings.some((f) => f.severity === 'error')) return 'block';
  return findings.length > 0 ? 'warning' : 'ok';
}

function label(req: PackageRequest): string {
  return req.spec ? `${req.name}@${req.spec}` : req.name;
}

/** Version to inspect: an exact version or dist-tag as requested, otherwise the latest release. */
function requestedVersion(req: PackageRequest): string {
  return isExactVersion(req.spec) || isDistTag(req.spec) ? req.spec : 'latest';
}

function strictVersion(req: PackageRequest): boolean {
  return isExactVersion(req.spec) || isDistTag(req.spec);
}

export function describeHours(hours: number): string {
  if (hours < 1) return 'less than an hour ago';
  const n = Math.round(hours);
  return `${n} hour${n === 1 ? '' : 's'} ago`;
}

/** Whether the version that was looked up is the one this request installs. */
function installsVersion(req: PackageRequest, version: string): boolean {
  if (req.spec === null || isExactVersion(req.spec) || isDistTag(req.spec)) return true;
  return rangeIncludes(req.spec, version) === true;
}

/** Ages in minutes to flag, or null when the check does not apply to this package. */
function freshWindow(name: string, ctx: AssessContext): { from: number; to: number } | null {
  const hours = ctx.freshHours ?? DEFAULT_FRESH_HOURS;
  if (!(hours > 0)) return null;
  const to = hours * 60;
  if (cooldownCovers(ctx.cooldown, name, to)) return null;
  // A shorter cooldown already refuses the youngest releases.
  const from = ctx.cooldown && cooldownCovers(ctx.cooldown, name, ctx.cooldown.minutes) ? ctx.cooldown.minutes : 0;
  return { from, to };
}

function freshFinding(name: string, version: string, publishedAt: string, ctx: AssessContext, previous: string | null): DepFinding | null {
  const window = freshWindow(name, ctx);
  const when = Date.parse(publishedAt);
  if (!window || Number.isNaN(when)) return null;
  const minutes = Math.max(0, ((ctx.now ?? Date.now)() - when) / 60_000);
  if (minutes < window.from || minutes >= window.to) return null;
  const prev = previous ? ` The release before it is ${name}@${previous}.` : '';
  return finding('fresh-release',
    `${name}@${version} was published ${describeHours(minutes / 60)}. Hijacked releases of real packages are published like any other and are usually removed within hours; a release that has been public for a day is the safer choice.${prev}`);
}

function didYouMean(similar: string | null): string {
  return similar ? ` Did you mean "${similar}"?` : '';
}

async function assessPopular(req: PackageRequest, ctx: AssessContext): Promise<PackageAssessment> {
  const lookup = await ctx.client.getVersion(req.name, requestedVersion(req));
  const facts: PackageFacts = { popular: true, version: null, createdAt: null, ageDays: null, weeklyDownloads: null, installScripts: [], deprecated: null };
  const findings: DepFinding[] = [];
  if (lookup.status === 'version-not-found' && strictVersion(req)) {
    findings.push(finding('version-not-found', `${label(req)} does not exist. Check the version on npm; assistants often guess version numbers.`));
  } else if (lookup.status === 'ok') {
    facts.version = lookup.facts.version;
    facts.installScripts = lookup.facts.installScripts;
    facts.deprecated = lookup.facts.deprecated;
    if (lookup.facts.deprecated) findings.push(finding('deprecated', `${req.name}@${lookup.facts.version} is deprecated: "${lookup.facts.deprecated}"`));
    // Popular documents can be huge, so the publish time comes from the tarball's headers.
    const { tarball } = lookup.facts;
    if (tarball && freshWindow(req.name, ctx) && installsVersion(req, lookup.facts.version)) {
      try {
        facts.publishedAt = await ctx.client.getPublishTime(req.name, lookup.facts.version, tarball);
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
      }
      const fresh = facts.publishedAt ? freshFinding(req.name, lookup.facts.version, facts.publishedAt, ctx, null) : null;
      if (fresh) findings.push(fresh);
    }
  }
  return { request: req, verdict: verdictOf(findings), findings, facts };
}

function resolveVersion(req: PackageRequest, distTags: Record<string, string>, versions: Record<string, VersionFacts>): VersionFacts | 'missing' | null {
  if (isExactVersion(req.spec)) return versions[req.spec.replace(/^v/i, '')] ?? 'missing';
  if (isDistTag(req.spec)) {
    const v = distTags[req.spec];
    return v ? versions[v] ?? null : 'missing';
  }
  const latest = distTags.latest;
  return latest ? versions[latest] ?? null : null;
}

/** Newest stable version published before the fresh window, as a safer choice to suggest. */
function previousRelease(publishedAt: Record<string, string>, current: string, now: number, ctx: AssessContext): string | null {
  const cutoff = now - (ctx.freshHours ?? DEFAULT_FRESH_HOURS) * 3_600_000;
  let best: { version: string; when: number } | null = null;
  for (const [version, iso] of Object.entries(publishedAt)) {
    const when = Date.parse(iso);
    if (version === current || version.includes('-') || Number.isNaN(when) || when >= cutoff) continue;
    if (!best || when > best.when) best = { version, when };
  }
  return best?.version ?? null;
}

async function assessUnknown(req: PackageRequest, ctx: AssessContext, popular: PopularIndex): Promise<PackageAssessment> {
  const similar = findLookalike(req.name, popular);
  const doc = await ctx.client.getPackage(req.name);
  if (doc === null) {
    const confirm = ctx.confirmRegistry ?? confirmPublicRegistry;
    if (!confirm(ctx.cwd, req.name)) {
      return { request: req, verdict: 'skipped', reason: 'installed from a private registry', findings: [] };
    }
    const findings = [finding('package-not-found',
      `"${req.name}" does not exist on npm. AI assistants often invent package names, and anyone can register an invented name later.${didYouMean(similar)}`)];
    return { request: req, verdict: 'block', findings, ...(similar ? { similarTo: similar } : {}) };
  }

  const now = (ctx.now ?? Date.now)();
  const created = doc.createdAt ? Date.parse(doc.createdAt) : Number.NaN;
  const ageDays = Number.isNaN(created) ? null : Math.max(0, (now - created) / 86_400_000);
  const resolved = resolveVersion(req, doc.distTags, doc.versions);
  let weeklyDownloads: number | null = null;
  try {
    weeklyDownloads = await ctx.client.getWeeklyDownloads(req.name);
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
  }

  const version = resolved && resolved !== 'missing' ? resolved : null;
  const facts: PackageFacts = {
    popular: false,
    version: version?.version ?? null,
    createdAt: doc.createdAt,
    ageDays: ageDays === null ? null : Math.floor(ageDays),
    weeklyDownloads,
    installScripts: version?.installScripts ?? [],
    deprecated: version?.deprecated ?? null,
  };

  const findings: DepFinding[] = [];
  if (resolved === 'missing') {
    const latest = doc.distTags.latest ? ` The latest version is ${doc.distTags.latest}.` : '';
    findings.push(finding('version-not-found', `${label(req)} does not exist.${latest}`));
  }
  if (version?.securityHolder) {
    findings.push(finding('security-holding',
      `npm removed the package published as "${req.name}" (usually for malware) and replaced it with an empty placeholder.${didYouMean(similar)}`));
    return { request: req, verdict: 'block', findings, facts, ...(similar ? { similarTo: similar } : {}) };
  }

  const minAge = ctx.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const minDownloads = ctx.minWeeklyDownloads ?? DEFAULT_MIN_WEEKLY_DOWNLOADS;
  const young = ageDays !== null && ageDays < minAge;
  const obscure = weeklyDownloads !== null && weeklyDownloads < minDownloads;
  const evidence = [
    young && ageDays !== null ? `first published ${describeAge(ageDays)}` : null,
    obscure && weeklyDownloads !== null ? `${plural(weeklyDownloads, 'download')} last week` : null,
  ].filter((s): s is string => s !== null).join(', ');
  const scripts = facts.installScripts;

  if (similar && (young || obscure)) {
    findings.push(finding('typosquat-suspect',
      `"${req.name}" looks like the popular package "${similar}" and is ${evidence}. Typosquatting packages look exactly like this. Did you mean "${similar}"?`));
  } else if (similar && (weeklyDownloads === null ? ageDays !== null && ageDays < 365 : weeklyDownloads < ESTABLISHED_DOWNLOADS)) {
    // Without download data, only a package younger than a year is worth a look-alike warning.
    findings.push(finding('lookalike-name', `"${req.name}" looks like the popular package "${similar}". Make sure it is the package you meant.`));
  }

  if (scripts.length > 0 && (young || obscure)) {
    findings.push(finding('install-script-unknown',
      `"${req.name}" runs code when it is installed (${scripts.join(', ')}) and is ${evidence}. Install scripts run with your permissions before you can review anything.`));
  } else if (scripts.length > 0) {
    findings.push(finding('install-script', `"${req.name}" runs code when it is installed (${scripts.join(', ')}).`));
  }

  const flagged = new Set(findings.map((f) => f.check));
  if (young && !flagged.has('typosquat-suspect') && !flagged.has('install-script-unknown') && ageDays !== null) {
    findings.push(finding('new-package', `"${req.name}" was first published ${describeAge(ageDays)}. New packages have no track record yet.`));
  }
  if (obscure && !flagged.has('typosquat-suspect') && !flagged.has('install-script-unknown') && weeklyDownloads !== null) {
    findings.push(finding('low-downloads', `"${req.name}" had ${plural(weeklyDownloads, 'download')} last week. Check that it is maintained and is the package you meant.`));
  }
  if (facts.deprecated) {
    findings.push(finding('deprecated', `${req.name}@${facts.version} is deprecated: "${facts.deprecated}"`));
  }
  if (version) {
    facts.publishedAt = doc.publishedAt[version.version] ?? null;
    // A package that is itself new is already reported as new; its first releases are all fresh.
    if (facts.publishedAt && !young && installsVersion(req, version.version)) {
      const fresh = freshFinding(req.name, version.version, facts.publishedAt, ctx, previousRelease(doc.publishedAt, version.version, now, ctx));
      if (fresh) findings.push(fresh);
    }
  }

  return { request: req, verdict: verdictOf(findings), findings, facts, ...(similar ? { similarTo: similar } : {}) };
}

/** Check one package. Network problems give verdict "unchecked", never a finding. */
export async function assessPackage(req: PackageRequest, ctx: AssessContext): Promise<PackageAssessment> {
  if (!usesPublicRegistry(ctx.registryConfig, req.name)) {
    return { request: req, verdict: 'skipped', reason: 'installed from a private registry', findings: [] };
  }
  const popular = ctx.popular ?? popularIndex();
  try {
    return popular.has(req.name) ? await assessPopular(req, ctx) : await assessUnknown(req, ctx, popular);
  } catch (error) {
    if (error instanceof RegistryError) return { request: req, verdict: 'unchecked', reason: error.message, findings: [] };
    throw error;
  }
}

/** Check several packages in parallel; duplicates (same name and spec) are checked once. */
export async function assessPackages(requests: PackageRequest[], ctx: AssessContext): Promise<PackageAssessment[]> {
  const unique = new Map<string, PackageRequest>();
  for (const req of requests) {
    const key = `${req.name}@${req.spec ?? ''}`;
    if (!unique.has(key)) unique.set(key, req);
  }
  const queue = [...unique.values()];
  const results = new Map<string, PackageAssessment>();
  // One download-count request per 128 packages instead of one each (the API rate-limits bursts).
  const popular = ctx.popular ?? popularIndex();
  const needDownloads = queue.filter((r) => !popular.has(r.name) && usesPublicRegistry(ctx.registryConfig, r.name)).map((r) => r.name);
  if (needDownloads.length > 1) await ctx.client.prefetchWeeklyDownloads(needDownloads);
  // A small worker pool: each worker takes the next package when it finishes one.
  const work = async (): Promise<void> => {
    const req = queue.shift();
    if (!req) return;
    results.set(`${req.name}@${req.spec ?? ''}`, await assessPackage(req, ctx));
    await work();
  };
  await Promise.all(Array.from({ length: Math.min(ctx.concurrency ?? 6, queue.length) }, work));
  return requests.map((req) => ({ ...results.get(`${req.name}@${req.spec ?? ''}`)!, request: req }));
}
