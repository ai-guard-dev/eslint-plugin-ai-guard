/**
 * lookalike.ts — does a package name imitate a popular package?
 *
 * Typosquats copy a popular name with one small change: a doubled or swapped
 * letter (`expresss`, `lodahs`), a dropped separator (`crossenv` for
 * `cross-env`), a scope turned into a prefix (`types-node` for `@types/node`),
 * or a filler affix (`axios-js`). A name that is itself popular is never a
 * look-alike, so `preact` and `react` do not flag each other.
 *
 * A look-alike name alone is weak evidence; checks combine it with the
 * package's age and downloads before blocking anything.
 */

import { POPULAR_PACKAGES } from '../../data/popular-packages.js';

export interface PopularIndex {
  has(name: string): boolean;
  /** 0 = most downloaded. */
  rank(name: string): number;
  size: number;
  /** Names grouped by length, for edit-distance candidates. */
  byLength: Map<number, string[]>;
  /** Separator-free form -> most popular name with that form. */
  compact: Map<string, string>;
}

const compactForm = (name: string): string => name.toLowerCase().replace(/^@/, '').replace(/[-_./]/g, '');

export function buildPopularIndex(names: readonly string[]): PopularIndex {
  const ranks = new Map<string, number>();
  const byLength = new Map<number, string[]>();
  const compact = new Map<string, string>();
  names.forEach((name, i) => {
    if (ranks.has(name)) return;
    ranks.set(name, i);
    const list = byLength.get(name.length) ?? [];
    list.push(name);
    byLength.set(name.length, list);
    const key = compactForm(name);
    if (!compact.has(key)) compact.set(key, name);
  });
  return {
    has: (name) => ranks.has(name),
    rank: (name) => ranks.get(name) ?? Number.POSITIVE_INFINITY,
    size: ranks.size,
    byLength,
    compact,
  };
}

let defaultIndex: PopularIndex | null = null;
export function popularIndex(): PopularIndex {
  defaultIndex ??= buildPopularIndex(POPULAR_PACKAGES);
  return defaultIndex;
}

/** Edit distance exactly 1: one substitution, insertion, deletion, or swap of adjacent characters. */
export function isOneEditAway(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let i = 0;
    while (i < la && a[i] === b[i]) i++;
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

const MIN_EDIT_LENGTH = 5;
const SUFFIXES = ['-js', '.js', 'js', '-node', '-npm'];
const PREFIXES = ['node-', 'js-'];

/** The popular package `name` imitates, or null. Prefers the most downloaded match. */
export function findLookalike(name: string, index: PopularIndex = popularIndex()): string | null {
  const lower = name.toLowerCase();
  if (index.has(name) || index.has(lower)) return null;
  const matches: string[] = [];

  const sameCompact = index.compact.get(compactForm(lower));
  if (sameCompact && sameCompact !== lower) matches.push(sameCompact);

  if (lower.length >= MIN_EDIT_LENGTH) {
    for (let len = lower.length - 1; len <= lower.length + 1; len++) {
      for (const candidate of index.byLength.get(len) ?? []) {
        if (candidate.length >= MIN_EDIT_LENGTH && isOneEditAway(lower, candidate)) matches.push(candidate);
      }
    }
  }

  for (const suffix of SUFFIXES) {
    if (lower.endsWith(suffix)) {
      const base = lower.slice(0, -suffix.length);
      if (base.length >= 4 && index.has(base)) matches.push(base);
    }
  }
  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix)) {
      const base = lower.slice(prefix.length);
      if (base.length >= 4 && index.has(base)) matches.push(base);
    }
  }

  if (matches.length === 0) return null;
  return matches.sort((a, b) => index.rank(a) - index.rank(b))[0];
}
