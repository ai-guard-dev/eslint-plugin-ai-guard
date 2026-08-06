/**
 * tests/ci/version.test.ts — Version consistency regression tests.
 *
 * Ensures that PKG_VERSION always matches package.json.
 * Guards against hardcoded version strings diverging from published version.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { PKG_VERSION } from '../../cli/utils/version.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

function readPackageJsonVersion(): string {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = require_(pkgPath) as { version: string };
  return pkg.version;
}

// ─── Version consistency ──────────────────────────────────────────────────────

describe('Version consistency', () => {
  it('PKG_VERSION is a valid semver string', () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('PKG_VERSION matches package.json version', () => {
    const pkgVersion = readPackageJsonVersion();
    expect(PKG_VERSION).toBe(pkgVersion);
  });

  it('PKG_VERSION is not a hardcoded placeholder', () => {
    // Guard against '0.0.0' (fallback)
    expect(PKG_VERSION).not.toBe('0.0.0');
  });
});

// ─── JSON output version ──────────────────────────────────────────────────────

describe('JSON output version field', () => {
  it('PKG_VERSION is a non-empty string suitable for JSON output', () => {
    expect(typeof PKG_VERSION).toBe('string');
    expect(PKG_VERSION.length).toBeGreaterThan(0);
  });

  it('PKG_VERSION does not contain undefined or null', () => {
    expect(PKG_VERSION).not.toBe('undefined');
    expect(PKG_VERSION).not.toBe('null');
    expect(PKG_VERSION).not.toContain('undefined');
  });
});
