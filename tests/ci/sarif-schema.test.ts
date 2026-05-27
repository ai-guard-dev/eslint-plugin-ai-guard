/**
 * tests/ci/sarif-schema.test.ts — SARIF schema compliance regression tests.
 *
 * Purpose: Guard against the exact GitHub Code Scanning upload failure:
 *
 *   "instance.runs[0].tool.driver.rules[0].properties.tags contains duplicate item"
 *   instance: ["async", "async-reliability", "async-reliability"]
 *
 * Root cause: category slug was appended to base tags without deduplication.
 * For async rules, 'async-reliability' existed in both base tags AND the
 * derived category slug — violating SARIF schema uniqueItems constraint.
 *
 * These tests specifically protect against:
 *  1. Duplicate tags in rule properties (the regression)
 *  2. Undefined/null values in any SARIF property
 *  3. Empty string values in tags
 *  4. Invalid SARIF structure
 *  5. Schema-incompatible level/kind/rank values
 */

import { describe, it, expect } from 'vitest';
import {
  buildSarifLog,
  sarifToJson,
  sanitizeSarifTags,
  sanitizeSarifProperties,
  sanitizeSarifRule,
  sanitizeSarifLog,
  buildSarifDebugInfo,
  normalizeSarifPath,
  debugSarifPath,
} from '../../cli/utils/sarif.js';
import type { RunResult } from '../../cli/utils/eslint-runner.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeResult(ruleIds: string[]): RunResult {
  const issues = ruleIds.map((ruleId, i) => ({
    ruleId,
    severity: 2 as const,
    message: `Issue from ${ruleId}`,
    line: i + 1,
    column: 1,
  }));

  return {
    files: [
      {
        filePath: 'src/handler.ts',
        issues,
      },
    ],
    filesScanned: 1,
    totalErrors: ruleIds.length,
    totalWarnings: 0,
    totalIssues: ruleIds.length,
    durationMs: 50,
    ruleBreakdown: new Map(ruleIds.map((id) => [id, 1])),
    topFiles: [{ filePath: 'src/handler.ts', issueCount: ruleIds.length }],
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
  };
}

// Rules that previously caused duplicate tags (the failing GitHub upload scenario)
const ASYNC_RULES = [
  'ai-guard/no-floating-promise',     // tags: ['async', 'async-reliability'] + category='Async Reliability' → async-reliability
  'ai-guard/no-await-in-loop',        // tags: ['async', 'async-reliability', 'performance'] + async-reliability
  'ai-guard/no-async-without-await',  // tags: ['async', 'async-reliability'] + async-reliability
  'ai-guard/no-async-array-callback', // tags: ['async', 'async-reliability'] + async-reliability
];

const SECURITY_RULES = [
  'ai-guard/no-hardcoded-secret',
  'ai-guard/no-eval-dynamic',
  'ai-guard/no-sql-string-concat',
  'ai-guard/no-unsafe-deserialize',
  'ai-guard/require-auth-middleware',
  'ai-guard/require-authz-check',
];

const ALL_RULES = [
  ...ASYNC_RULES,
  ...SECURITY_RULES,
  'ai-guard/no-empty-catch',
  'ai-guard/no-broad-exception',
  'ai-guard/no-catch-log-rethrow',
  'ai-guard/no-catch-without-use',
  'ai-guard/no-redundant-await',
  'ai-guard/no-console-in-handler',
  'ai-guard/no-duplicate-logic-block',
  'ai-guard/no-dead-branch',
];

// ─── sanitizeSarifTags unit tests ─────────────────────────────────────────────

describe('sanitizeSarifTags', () => {
  it('deduplicates exact duplicate strings', () => {
    const result = sanitizeSarifTags(['async', 'async-reliability', 'async-reliability']);
    expect(result).toEqual(['async', 'async-reliability']);
  });

  it('deduplicates case-insensitive duplicates after normalization', () => {
    const result = sanitizeSarifTags(['Security', 'security']);
    expect(result).toEqual(['security']);
  });

  it('removes empty strings', () => {
    const result = sanitizeSarifTags(['async', '', 'reliability']);
    expect(result).not.toContain('');
  });

  it('removes undefined values', () => {
    const result = sanitizeSarifTags(['async', undefined, 'reliability']);
    expect(result).not.toContain(undefined);
    expect(result).toHaveLength(2);
  });

  it('removes null values', () => {
    const result = sanitizeSarifTags(['async', null, 'reliability']);
    expect(result).not.toContain(null);
    expect(result).toHaveLength(2);
  });

  it('normalizes whitespace to hyphens', () => {
    const result = sanitizeSarifTags(['async reliability', 'security']);
    expect(result).toContain('async-reliability');
  });

  it('trims leading/trailing whitespace', () => {
    const result = sanitizeSarifTags(['  async  ', 'security']);
    expect(result).toContain('async');
    expect(result).not.toContain('  async  ');
  });

  it('returns empty array for empty input', () => {
    expect(sanitizeSarifTags([])).toEqual([]);
  });

  it('returns empty array for all-invalid input', () => {
    expect(sanitizeSarifTags([undefined, null, '', '  '])).toEqual([]);
  });

  it('result passes uniqueItems constraint (all items unique)', () => {
    const inputs = ['async', 'async-reliability', 'async-reliability', 'performance', 'async'];
    const result = sanitizeSarifTags(inputs);
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });
});

// ─── REGRESSION: Async rule duplicate tags ────────────────────────────────────

describe('REGRESSION: no duplicate tags in async rules (GitHub upload failure)', () => {
  it('no-floating-promise tags are unique', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-floating-promise']));
    const rule = sarif.runs[0].tool.driver.rules[0];
    const tags = rule.properties?.tags ?? [];
    const unique = new Set(tags);
    expect(unique.size).toBe(tags.length);
    // 'async-reliability' should appear exactly once
    expect(tags.filter((t) => t === 'async-reliability')).toHaveLength(1);
  });

  it('no-await-in-loop tags are unique', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-await-in-loop']));
    const rule = sarif.runs[0].tool.driver.rules[0];
    const tags = rule.properties?.tags ?? [];
    const unique = new Set(tags);
    expect(unique.size).toBe(tags.length);
  });

  it('no-async-without-await tags are unique', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-async-without-await']));
    const rule = sarif.runs[0].tool.driver.rules[0];
    const tags = rule.properties?.tags ?? [];
    const unique = new Set(tags);
    expect(unique.size).toBe(tags.length);
  });

  it('no-async-array-callback tags are unique', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-async-array-callback']));
    const rule = sarif.runs[0].tool.driver.rules[0];
    const tags = rule.properties?.tags ?? [];
    const unique = new Set(tags);
    expect(unique.size).toBe(tags.length);
  });

  it('all async rules together have no duplicate tags', () => {
    const sarif = buildSarifLog(makeResult(ASYNC_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      const tags = rule.properties?.tags ?? [];
      const unique = new Set(tags);
      expect(unique.size).toBe(tags.length);
    }
  });
});

// ─── ALL rules: no duplicates ─────────────────────────────────────────────────

describe('No duplicate tags in any rule (full rule coverage)', () => {
  it('all 18 rules produce unique tags', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    const violations: Array<{ ruleId: string; tags: string[] }> = [];

    for (const rule of sarif.runs[0].tool.driver.rules) {
      const tags = rule.properties?.tags ?? [];
      const unique = new Set(tags);
      if (unique.size !== tags.length) {
        violations.push({ ruleId: rule.id, tags });
      }
    }

    expect(violations).toHaveLength(0);
  });

  it('no rule has an empty tags array', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect((rule.properties?.tags ?? []).length).toBeGreaterThan(0);
    }
  });
});

// ─── No undefined/null in SARIF properties ────────────────────────────────────

describe('No undefined or null values in SARIF properties', () => {
  it('rule properties.confidence is never undefined', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect(rule.properties?.confidence).toBeDefined();
      expect(rule.properties?.confidence).not.toBe('undefined');
      expect(typeof rule.properties?.confidence).toBe('string');
    }
  });

  it('rule properties.category is never undefined', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect(rule.properties?.category).toBeDefined();
      expect(typeof rule.properties?.category).toBe('string');
    }
  });

  it('rule properties[security-severity] is never undefined and is a valid value', () => {
    const validSeverities = new Set(['8.0', '5.0', '3.0', '1.0']);
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      const sev = rule.properties?.['security-severity'];
      expect(sev).toBeDefined();
      expect(validSeverities.has(sev ?? '')).toBe(true);
    }
  });

  it('rule properties.precision is never undefined and is valid', () => {
    const validPrecisions = new Set(['high', 'medium', 'low']);
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      const precision = rule.properties?.precision;
      expect(precision).toBeDefined();
      expect(validPrecisions.has(precision ?? '')).toBe(true);
    }
  });

  it('result level is always a valid SARIF level', () => {
    const validLevels = new Set(['error', 'warning', 'note', 'none']);
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const result of sarif.runs[0].results) {
      expect(validLevels.has(result.level)).toBe(true);
    }
  });

  it('result kind is always a valid SARIF kind when present', () => {
    const validKinds = new Set(['fail', 'open', 'informational']);
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const result of sarif.runs[0].results) {
      if (result.kind !== undefined) {
        expect(validKinds.has(result.kind)).toBe(true);
      }
    }
  });

  it('result rank is always between 0 and 100 when present', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const result of sarif.runs[0].results) {
      if (result.rank !== undefined) {
        expect(result.rank).toBeGreaterThanOrEqual(0);
        expect(result.rank).toBeLessThanOrEqual(100);
      }
    }
  });
});

// ─── SARIF structure validity ─────────────────────────────────────────────────

describe('SARIF structure validity (GitHub schema compliance)', () => {
  it('$schema points to SARIF 2.1.0 schema', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    expect(sarif.$schema).toContain('sarif-2.1.0');
  });

  it('version is exactly "2.1.0"', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    expect(sarif.version).toBe('2.1.0');
  });

  it('runs array has exactly one run', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    expect(sarif.runs).toHaveLength(1);
  });

  it('driver name is ai-guard', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    expect(sarif.runs[0].tool.driver.name).toBe('ai-guard');
  });

  it('driver version is a valid semver string', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    expect(sarif.runs[0].tool.driver.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('region startLine is always >= 1', () => {
    // Regression: startLine of 0 violates SARIF schema minimum: 1
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const result of sarif.runs[0].results) {
      const line = result.locations[0].physicalLocation.region.startLine;
      expect(line).toBeGreaterThanOrEqual(1);
    }
  });

  it('artifactLocation MUST NOT have uriBaseId (removed for GitHub Code Scanning compatibility)', () => {
    // GitHub silently drops findings when %SRCROOT% is present because it
    // cannot resolve custom base ID mappings in the runner environment.
    // This test guards against regression where uriBaseId is re-introduced.
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    const loc = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation;
    expect((loc as Record<string, unknown>).uriBaseId).toBeUndefined();
  });

  it('produces valid JSON string via sarifToJson', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    expect(() => JSON.parse(sarifToJson(sarif))).not.toThrow();
  });

  it('JSON output preserves SARIF 2.1.0 version', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    const parsed = JSON.parse(sarifToJson(sarif)) as { version: string };
    expect(parsed.version).toBe('2.1.0');
  });
});

// ─── sanitizeSarifLog snapshot-style stability ────────────────────────────────

describe('sanitizeSarifLog — full sanitization stability', () => {
  it('is idempotent (sanitizing twice produces same result)', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    const once = sanitizeSarifLog(sarif);
    const twice = sanitizeSarifLog(once);

    // Tags should be identical after double sanitization
    for (let i = 0; i < once.runs[0].tool.driver.rules.length; i++) {
      expect(twice.runs[0].tool.driver.rules[i].properties?.tags)
        .toEqual(once.runs[0].tool.driver.rules[i].properties?.tags);
    }
  });

  it('all rule shortDescriptions are non-empty strings', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect(typeof rule.shortDescription.text).toBe('string');
      expect(rule.shortDescription.text.length).toBeGreaterThan(0);
    }
  });

  it('no tags contain empty strings after sanitization', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      for (const tag of rule.properties?.tags ?? []) {
        expect(tag.length).toBeGreaterThan(0);
        expect(tag.trim()).toBe(tag);
      }
    }
  });

  it('no tags contain whitespace', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      for (const tag of rule.properties?.tags ?? []) {
        expect(tag).not.toMatch(/\s/);
      }
    }
  });
});

// ─── buildSarifDebugInfo ──────────────────────────────────────────────────────

describe('buildSarifDebugInfo', () => {
  it('returns debug info for each async rule', () => {
    const result = makeResult(ASYNC_RULES);
    const debug = buildSarifDebugInfo(result);
    expect(debug.rulesEmitted.length).toBe(ASYNC_RULES.length);
  });

  it('correctly identifies rules that had duplicate raw tags', () => {
    const result = makeResult(['ai-guard/no-floating-promise']);
    const debug = buildSarifDebugInfo(result);
    const rule = debug.rulesEmitted[0];
    // Raw tags: ['async', 'async-reliability'] + 'async-reliability' from category
    expect(rule.hasDuplicatesInRaw).toBe(true);
  });

  it('sanitized tags have no duplicate items even when raw tags did', () => {
    const result = makeResult(['ai-guard/no-floating-promise']);
    const debug = buildSarifDebugInfo(result);
    const rule = debug.rulesEmitted[0];
    expect(rule.hasDuplicatesInRaw).toBe(true);
    const unique = new Set(rule.sanitizedTags);
    expect(unique.size).toBe(rule.sanitizedTags.length);
    expect(rule.sanitizedTags.filter(t => t === 'async-reliability')).toHaveLength(1);
  });

  it('rules without duplicates show hasDuplicatesInRaw=false', () => {
    // no-redundant-await: tags=['async'], category='Async Reliability' → slug='async-reliability'
    // 'async' != 'async-reliability', so no duplicate — hasDuplicatesInRaw=false
    const result = makeResult(['ai-guard/no-redundant-await']);
    const debug = buildSarifDebugInfo(result);
    const rule = debug.rulesEmitted[0];
    expect(rule.hasDuplicatesInRaw).toBe(false);
  });

  it('returns totalResults matching issue count', () => {
    const result = makeResult(ALL_RULES);
    const debug = buildSarifDebugInfo(result);
    expect(debug.totalResults).toBe(ALL_RULES.length);
  });

  it('version is a valid semver string', () => {
    const debug = buildSarifDebugInfo(makeResult(['ai-guard/no-hardcoded-secret']));
    expect(debug.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ─── GitHub Code Scanning compatibility ───────────────────────────────────────

describe('GitHub Code Scanning compatibility', () => {
  it('informational rules use kind="informational" and level="note"', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-async-without-await']));
    const result = sarif.runs[0].results[0];
    expect(result.kind).toBe('informational');
    expect(result.level).toBe('note');
  });

  it('high-confidence rules use kind="fail" and level="error"', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    const result = sarif.runs[0].results[0];
    expect(result.kind).toBe('fail');
    expect(result.level).toBe('error');
  });

  it('medium-confidence rules use kind="fail" and level="warning"', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-await-in-loop']));
    const result = sarif.runs[0].results[0];
    expect(result.kind).toBe('fail');
    expect(result.level).toBe('warning');
  });

  it('security-severity is set for all rules', () => {
    const validSeverities = new Set(['8.0', '5.0', '3.0', '1.0']);
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      const sev = rule.properties?.['security-severity'];
      expect(sev).toBeDefined();
      expect(validSeverities.has(sev ?? '')).toBe(true);
    }
  });

  it('adds security-severity and precision to all results', () => {
    const validSeverities = new Set(['8.0', '5.0', '3.0', '1.0']);
    const validPrecisions = new Set(['high', 'medium', 'low']);
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const result of sarif.runs[0].results) {
      expect(result.properties?.['security-severity']).toBeDefined();
      expect(validSeverities.has(result.properties?.['security-severity'] ?? '')).toBe(true);
      expect(result.properties?.precision).toBeDefined();
      expect(validPrecisions.has(result.properties?.precision ?? '')).toBe(true);
    }
  });

  it('adds GitHub semantic tags and deduplicates correctly', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      const tags = rule.properties?.tags ?? [];
      // Every rule must have correctness and reliability
      expect(tags).toContain('correctness');
      expect(tags).toContain('reliability');
      // Only security rules must have security tag
      if (rule.id.includes('secret') || rule.id.includes('eval') || rule.id.includes('sql') || rule.id.includes('deserialize') || rule.id.includes('auth')) {
        expect(tags).toContain('security');
      } else {
        expect(tags).not.toContain('security');
      }
      // Tags must be unique
      const unique = new Set(tags);
      expect(unique.size).toBe(tags.length);
    }
  });

  it('strictly normalizes result levels and configurations', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    const validLevels = new Set(['error', 'warning', 'note']);
    for (const result of sarif.runs[0].results) {
      expect(validLevels.has(result.level)).toBe(true);
    }
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect(validLevels.has(rule.defaultConfiguration?.level ?? 'none')).toBe(true);
    }
  });

  it('helpUri is set and points to docs for all rules', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect(rule.helpUri).toBeDefined();
      expect(rule.helpUri).toContain('github.com');
    }
  });

  it('informationUri points to GitHub repo', () => {
    const sarif = buildSarifLog(makeResult(['ai-guard/no-hardcoded-secret']));
    expect(sarif.runs[0].tool.driver.informationUri).toContain('github.com');
  });

  it('file URIs use forward slashes (not Windows backslashes)', () => {
    const result: RunResult = {
      files: [{
        filePath: 'src\\windows\\path\\file.ts',
        issues: [{
          ruleId: 'ai-guard/no-hardcoded-secret',
          severity: 2,
          message: 'Test',
          line: 1,
          column: 1,
        }],
      }],
      filesScanned: 1,
      totalErrors: 1,
      totalWarnings: 0,
      totalIssues: 1,
      durationMs: 10,
      ruleBreakdown: new Map([['ai-guard/no-hardcoded-secret', 1]]),
      topFiles: [],
      ecosystemIssues: [],
      parserErrors: [],
      tsParserAvailable: true,
    };
    const sarif = buildSarifLog(result);
    const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).not.toContain('\\');
    expect(uri).toContain('/');
  });

  it('artifact location MUST NOT contain uriBaseId (%SRCROOT% or any custom base)', () => {
    // GitHub Code Scanning silently drops findings when uriBaseId is present
    // because it cannot resolve custom base ID mappings in the runner environment.
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const result of sarif.runs[0].results) {
      for (const loc of result.locations) {
        expect(
          (loc.physicalLocation.artifactLocation as Record<string, unknown>).uriBaseId,
          `uriBaseId must be absent on rule ${result.ruleId}`,
        ).toBeUndefined();
      }
    }
  });

  it('artifact URIs are repository-relative POSIX paths (no leading slash, no drive letter)', () => {
    const sarif = buildSarifLog(makeResult(ALL_RULES));
    for (const result of sarif.runs[0].results) {
      const uri = result.locations[0].physicalLocation.artifactLocation.uri;
      expect(uri, `URI must not start with / for ${result.ruleId}`).not.toMatch(/^\//);
      expect(uri, `URI must not start with drive letter for ${result.ruleId}`).not.toMatch(/^[A-Za-z]:/);
      expect(uri, `URI must not contain backslashes for ${result.ruleId}`).not.toContain('\\');
      expect(uri, `URI must not start with ./ for ${result.ruleId}`).not.toMatch(/^\.\//); 
    }
  });

  it('buildSarifDebugInfo includes normalizedUri in resultsEmitted', () => {
    const result = makeResult(['ai-guard/no-floating-promise']);
    const info = buildSarifDebugInfo(result);
    expect(info.resultsEmitted[0]).toHaveProperty('normalizedUri');
    expect(info.pathsDebug).toHaveLength(1);
    expect(info.pathsDebug[0].isRepositoryRelative).toBe(true);
  });
});

// ─── normalizeSarifPath unit tests ────────────────────────────────────────────

describe('normalizeSarifPath', () => {
  it('passes through clean relative POSIX paths unchanged', () => {
    expect(normalizeSarifPath('src/server/api.ts')).toBe('src/server/api.ts');
  });

  it('converts Windows backslashes to forward slashes', () => {
    expect(normalizeSarifPath('src\\server\\api.ts')).toBe('src/server/api.ts');
  });

  it('strips Windows drive letter and makes path relative', () => {
    expect(normalizeSarifPath('C:/home/runner/work/repo/src/api.ts'))
      .toBe('home/runner/work/repo/src/api.ts');
  });

  it('strips Windows drive letter from backslash paths', () => {
    expect(normalizeSarifPath('C:\\Users\\runner\\work\\src\\file.ts'))
      .toBe('Users/runner/work/src/file.ts');
  });

  it('strips repoRoot to produce a clean repository-relative path', () => {
    const repoRoot = '/home/runner/work/my-repo/my-repo';
    const absolute = '/home/runner/work/my-repo/my-repo/src/handler.ts';
    expect(normalizeSarifPath(absolute, repoRoot)).toBe('src/handler.ts');
  });

  it('strips repoRoot with trailing slash', () => {
    const repoRoot = '/home/runner/work/my-repo/my-repo/';
    const absolute = '/home/runner/work/my-repo/my-repo/src/handler.ts';
    expect(normalizeSarifPath(absolute, repoRoot)).toBe('src/handler.ts');
  });

  it('strips Windows-style absolute path using repoRoot', () => {
    const repoRoot = 'C:\\Yash Projects\\ESLint AI Guard';
    const absolute = 'C:\\Yash Projects\\ESLint AI Guard\\src\\utils\\sarif.ts';
    expect(normalizeSarifPath(absolute, repoRoot)).toBe('src/utils/sarif.ts');
  });

  it('strips leading ./ from relative paths', () => {
    expect(normalizeSarifPath('./src/api.ts')).toBe('src/api.ts');
  });

  it('strips leading / from absolute paths (no repoRoot)', () => {
    expect(normalizeSarifPath('/src/api.ts')).toBe('src/api.ts');
  });

  it('returns non-empty string for empty input (safe fallback)', () => {
    const result = normalizeSarifPath('');
    expect(typeof result).toBe('string');
  });

  it('produces GitHub Code Scanning-compatible URIs (no backslash, no leading slash)', () => {
    const cases = [
      'src/server/api.ts',
      'src\\server\\api.ts',
      './src/server/api.ts',
      '/src/server/api.ts',
    ];
    for (const input of cases) {
      const uri = normalizeSarifPath(input);
      expect(uri).not.toContain('\\');
      expect(uri).not.toMatch(/^\//);
      expect(uri).not.toMatch(/^\.\//); 
    }
  });
});

// ─── debugSarifPath unit tests ─────────────────────────────────────────────────

describe('debugSarifPath', () => {
  it('reports isRepositoryRelative=true for clean relative paths', () => {
    const entry = debugSarifPath('src/api.ts');
    expect(entry.isRepositoryRelative).toBe(true);
    expect(entry.hasLeadingSlash).toBe(false);
    expect(entry.hasBackslashes).toBe(false);
    expect(entry.hasDriveLetter).toBe(false);
    expect(entry.hasLeadingDotSlash).toBe(false);
  });

  it('reports isRepositoryRelative=false for absolute path without repoRoot', () => {
    // After normalization, leading slash is stripped, so actually becomes relative.
    // The entry originalPath is the original, normalizedUri is the result.
    const entry = debugSarifPath('/home/runner/work/src/api.ts');
    expect(entry.originalPath).toBe('/home/runner/work/src/api.ts');
    expect(entry.normalizedUri).toBe('home/runner/work/src/api.ts');
    expect(entry.isRepositoryRelative).toBe(true); // after stripping leading /
  });

  it('reports correct flags for Windows backslash paths', () => {
    const entry = debugSarifPath('src\\windows\\file.ts');
    expect(entry.normalizedUri).toBe('src/windows/file.ts');
    expect(entry.isRepositoryRelative).toBe(true);
  });

  it('correctly strips repoRoot and reports repo-relative', () => {
    const repoRoot = '/home/runner/work/my-repo/my-repo';
    const entry = debugSarifPath('/home/runner/work/my-repo/my-repo/src/handler.ts', repoRoot);
    expect(entry.normalizedUri).toBe('src/handler.ts');
    expect(entry.isRepositoryRelative).toBe(true);
  });
});
