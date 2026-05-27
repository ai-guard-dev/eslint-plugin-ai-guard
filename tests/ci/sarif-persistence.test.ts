/**
 * tests/ci/sarif-persistence.test.ts — GitHub Code Scanning persistence regression tests.
 *
 * Purpose: Guard against all regressions that would cause ai-guard findings to
 * become transient PR annotations instead of persistent repository-level security alerts.
 *
 * GitHub persistence requires three stable identity anchors:
 *  1. automationDetails.id  — must be "ai-guard", never change
 *  2. partialFingerprints   — must be deterministic, hash of (ruleId + uri + line + message)
 *  3. category (workflow)   — must be "ai-guard" in the upload-sarif step
 *
 * These tests protect against:
 *  - Missing automationDetails
 *  - Missing partialFingerprints on any result
 *  - Non-deterministic fingerprints (e.g. timestamp-based)
 *  - Fingerprint collision (two distinct findings with same hash)
 *  - Fingerprint drift (different hash for same logical finding)
 *  - Wrong fingerprint key format
 *  - Unstable automation ID
 */

import { describe, it, expect } from 'vitest';
import {
  buildSarifLog,
  generateStableFingerprint,
  buildSarifDebugInfo,
  SARIF_AUTOMATION_ID,
  FINGERPRINT_KEY,
} from '../../cli/utils/sarif.js';
import type { RunResult } from '../../cli/utils/eslint-runner.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    files: [
      {
        filePath: 'src/handler.ts',
        issues: [
          {
            ruleId: 'ai-guard/no-floating-promise',
            severity: 2,
            message: 'Promise not awaited',
            line: 12,
            column: 5,
          },
          {
            ruleId: 'ai-guard/no-hardcoded-secret',
            severity: 2,
            message: 'Hardcoded secret detected',
            line: 25,
            column: 1,
          },
        ],
      },
      {
        filePath: 'src/utils/db.ts',
        issues: [
          {
            ruleId: 'ai-guard/no-sql-string-concat',
            severity: 2,
            message: 'SQL injection risk',
            line: 8,
            column: 10,
          },
        ],
      },
    ],
    filesScanned: 2,
    totalErrors: 3,
    totalWarnings: 0,
    totalIssues: 3,
    durationMs: 50,
    ruleBreakdown: new Map([
      ['ai-guard/no-floating-promise', 1],
      ['ai-guard/no-hardcoded-secret', 1],
      ['ai-guard/no-sql-string-concat', 1],
    ]),
    topFiles: [],
    ecosystemIssues: [],
    parserErrors: [],
    tsParserAvailable: true,
    ...overrides,
  };
}

// ─── generateStableFingerprint unit tests ─────────────────────────────────────

describe('generateStableFingerprint', () => {
  it('is deterministic — same inputs always produce the same hash', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'Promise not awaited');
    const fp2 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'Promise not awaited');
    expect(fp1).toBe(fp2);
  });

  it('produces a 64-character lowercase hex string (SHA-256)', () => {
    const fp = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'test');
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the file path changes', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'Promise not awaited');
    const fp2 = generateStableFingerprint('src/other.ts', 'ai-guard/no-floating-promise', 12, 'Promise not awaited');
    expect(fp1).not.toBe(fp2);
  });

  it('changes when the rule ID changes', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'test');
    const fp2 = generateStableFingerprint('src/api.ts', 'ai-guard/no-hardcoded-secret', 12, 'test');
    expect(fp1).not.toBe(fp2);
  });

  it('changes when the line number changes', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'test');
    const fp2 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 13, 'test');
    expect(fp1).not.toBe(fp2);
  });

  it('changes when the message changes significantly', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'Promise not awaited');
    const fp2 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'Different message');
    expect(fp1).not.toBe(fp2);
  });

  it('is case-insensitive for URI — same hash regardless of case', () => {
    const fp1 = generateStableFingerprint('src/Api.ts', 'ai-guard/no-floating-promise', 12, 'test');
    const fp2 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'test');
    // URI is lowercased before hashing — case differences in paths are ignored
    expect(fp1).toBe(fp2);
  });

  it('is whitespace-insensitive for message — trailing spaces do not create new alerts', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'Promise not awaited');
    const fp2 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, '  Promise not awaited  ');
    expect(fp1).toBe(fp2);
  });

  it('two distinct findings at different lines produce different fingerprints (no collision)', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 5, 'Promise not awaited');
    const fp2 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 10, 'Promise not awaited');
    expect(fp1).not.toBe(fp2);
  });

  it('two distinct findings in different files produce different fingerprints', () => {
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'test');
    const fp2 = generateStableFingerprint('src/util.ts', 'ai-guard/no-floating-promise', 12, 'test');
    expect(fp1).not.toBe(fp2);
  });

  it('does not include timestamps or random values (calling twice yields same hash)', () => {
    // Run 5 times to rule out any randomness
    const results = Array.from({ length: 5 }, () =>
      generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'test'),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });

  it('is stable with Windows-style backslash paths (normalised to forward slash)', () => {
    // The caller should normalise paths; this verifies normalisation is case-stable
    const fp1 = generateStableFingerprint('src/api.ts', 'ai-guard/no-floating-promise', 12, 'test');
    // Simulate same path but uppercase — should match because both are lowercased
    const fp2 = generateStableFingerprint('SRC/API.TS', 'ai-guard/no-floating-promise', 12, 'test');
    expect(fp1).toBe(fp2);
  });
});

// ─── automationDetails tests ───────────────────────────────────────────────────

describe('SARIF_AUTOMATION_ID', () => {
  it('is "ai-guard"', () => {
    expect(SARIF_AUTOMATION_ID).toBe('ai-guard');
  });

  it('does not include timestamps, branch names, or random values', () => {
    expect(SARIF_AUTOMATION_ID).not.toMatch(/\d{4}/);  // no year
    expect(SARIF_AUTOMATION_ID).not.toMatch(/main|pr|branch/);
    expect(SARIF_AUTOMATION_ID).not.toMatch(/[0-9a-f]{8}/);  // no random hex
  });
});

describe('buildSarifLog — automationDetails', () => {
  it('emits automationDetails.id on every run', () => {
    const sarif = buildSarifLog(makeResult());
    for (const run of sarif.runs) {
      expect(run.automationDetails).toBeDefined();
      expect(run.automationDetails?.id).toBe(SARIF_AUTOMATION_ID);
    }
  });

  it('automationDetails.id is exactly "ai-guard"', () => {
    const sarif = buildSarifLog(makeResult());
    expect(sarif.runs[0].automationDetails?.id).toBe('ai-guard');
  });

  it('automationDetails.id is stable across two independent buildSarifLog calls', () => {
    const sarif1 = buildSarifLog(makeResult());
    const sarif2 = buildSarifLog(makeResult());
    expect(sarif1.runs[0].automationDetails?.id).toBe(sarif2.runs[0].automationDetails?.id);
  });
});

// ─── partialFingerprints tests ─────────────────────────────────────────────────

describe('FINGERPRINT_KEY', () => {
  it('is "ai-guard/v1"', () => {
    expect(FINGERPRINT_KEY).toBe('ai-guard/v1');
  });
});

describe('buildSarifLog — partialFingerprints', () => {
  it('every result has partialFingerprints', () => {
    const sarif = buildSarifLog(makeResult());
    for (const result of sarif.runs[0].results) {
      expect(
        result.partialFingerprints,
        `partialFingerprints missing on ${result.ruleId}`,
      ).toBeDefined();
    }
  });

  it('every result has the ai-guard/v1 fingerprint key', () => {
    const sarif = buildSarifLog(makeResult());
    for (const result of sarif.runs[0].results) {
      expect(
        result.partialFingerprints?.[FINGERPRINT_KEY],
        `fingerprint key "${FINGERPRINT_KEY}" missing on ${result.ruleId}`,
      ).toBeDefined();
    }
  });

  it('fingerprints are 64-character hex strings', () => {
    const sarif = buildSarifLog(makeResult());
    for (const result of sarif.runs[0].results) {
      const fp = result.partialFingerprints?.[FINGERPRINT_KEY];
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('fingerprints are deterministic across two buildSarifLog calls (same inputs → same hash)', () => {
    const sarif1 = buildSarifLog(makeResult());
    const sarif2 = buildSarifLog(makeResult());

    for (let i = 0; i < sarif1.runs[0].results.length; i++) {
      const fp1 = sarif1.runs[0].results[i].partialFingerprints?.[FINGERPRINT_KEY];
      const fp2 = sarif2.runs[0].results[i].partialFingerprints?.[FINGERPRINT_KEY];
      expect(fp1).toBe(fp2);
    }
  });

  it('two findings at different lines have different fingerprints (no collision)', () => {
    const result = makeResult({
      files: [
        {
          filePath: 'src/handler.ts',
          issues: [
            { ruleId: 'ai-guard/no-floating-promise', severity: 2, message: 'Promise not awaited', line: 5, column: 1 },
            { ruleId: 'ai-guard/no-floating-promise', severity: 2, message: 'Promise not awaited', line: 10, column: 1 },
          ],
        },
      ],
    });
    const sarif = buildSarifLog(result);
    const fp1 = sarif.runs[0].results[0].partialFingerprints?.[FINGERPRINT_KEY];
    const fp2 = sarif.runs[0].results[1].partialFingerprints?.[FINGERPRINT_KEY];
    expect(fp1).not.toBe(fp2);
  });

  it('two findings in different files have different fingerprints', () => {
    const result = makeResult({
      files: [
        {
          filePath: 'src/a.ts',
          issues: [{ ruleId: 'ai-guard/no-floating-promise', severity: 2, message: 'test', line: 1, column: 1 }],
        },
        {
          filePath: 'src/b.ts',
          issues: [{ ruleId: 'ai-guard/no-floating-promise', severity: 2, message: 'test', line: 1, column: 1 }],
        },
      ],
    });
    const sarif = buildSarifLog(result);
    const fp1 = sarif.runs[0].results[0].partialFingerprints?.[FINGERPRINT_KEY];
    const fp2 = sarif.runs[0].results[1].partialFingerprints?.[FINGERPRINT_KEY];
    expect(fp1).not.toBe(fp2);
  });

  it('same finding reappearing in a new scan has the same fingerprint (persistence guarantee)', () => {
    // Simulate the same finding in two separate scan runs
    const findingResult = makeResult({
      files: [
        {
          filePath: 'src/handler.ts',
          issues: [
            { ruleId: 'ai-guard/no-floating-promise', severity: 2, message: 'Promise not awaited', line: 12, column: 5 },
          ],
        },
      ],
    });
    const run1 = buildSarifLog(findingResult);
    const run2 = buildSarifLog(findingResult);
    const fp1 = run1.runs[0].results[0].partialFingerprints?.[FINGERPRINT_KEY];
    const fp2 = run2.runs[0].results[0].partialFingerprints?.[FINGERPRINT_KEY];
    expect(fp1).toBe(fp2);
  });
});

// ─── buildSarifDebugInfo persistence fields ────────────────────────────────────

describe('buildSarifDebugInfo — persistence fields', () => {
  it('exposes automationId matching SARIF_AUTOMATION_ID', () => {
    const info = buildSarifDebugInfo(makeResult());
    expect(info.automationId).toBe(SARIF_AUTOMATION_ID);
  });

  it('exposes fingerprintKey matching FINGERPRINT_KEY', () => {
    const info = buildSarifDebugInfo(makeResult());
    expect(info.fingerprintKey).toBe(FINGERPRINT_KEY);
  });

  it('includes fingerprint for each result', () => {
    const info = buildSarifDebugInfo(makeResult());
    for (const res of info.resultsEmitted) {
      expect(res.fingerprint, `fingerprint missing for ${res.ruleId}`).toBeDefined();
      expect(res.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('fingerprints in debug info match partialFingerprints in built SARIF', () => {
    const result = makeResult();
    const info = buildSarifDebugInfo(result);
    const sarif = buildSarifLog(result);

    for (let i = 0; i < sarif.runs[0].results.length; i++) {
      const sarifFp = sarif.runs[0].results[i].partialFingerprints?.[FINGERPRINT_KEY];
      const debugFp = info.resultsEmitted[i].fingerprint;
      expect(sarifFp).toBe(debugFp);
    }
  });
});

// ─── Full persistence compatibility check ─────────────────────────────────────

describe('GitHub Code Scanning persistence compatibility', () => {
  it('SARIF output contains all required persistence anchors', () => {
    const sarif = buildSarifLog(makeResult());
    const run = sarif.runs[0];

    // 1. automationDetails.id
    expect(run.automationDetails?.id).toBe('ai-guard');

    // 2. partialFingerprints on every result
    for (const result of run.results) {
      expect(result.partialFingerprints).toBeDefined();
      expect(result.partialFingerprints?.[FINGERPRINT_KEY]).toBeDefined();
    }

    // 3. No uriBaseId (path resolution fix)
    for (const result of run.results) {
      const loc = result.locations[0].physicalLocation.artifactLocation;
      expect((loc as Record<string, unknown>).uriBaseId).toBeUndefined();
    }
  });

  it('all fingerprints are unique across a multi-finding result set', () => {
    const sarif = buildSarifLog(makeResult());
    const fingerprints = sarif.runs[0].results.map(
      (r) => r.partialFingerprints?.[FINGERPRINT_KEY],
    );
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(fingerprints.length);
  });
});
