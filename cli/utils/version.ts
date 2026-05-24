/**
 * version.ts — Single-source-of-truth version for all CLI outputs.
 *
 * Reads from package.json at module load time.
 * All CLI outputs (JSON, SARIF, summary) must use PKG_VERSION from here.
 * Never hardcode version strings in command files.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

let _version: string | undefined;

function readVersion(): string {
  try {
    // Method 1: createRequire from ESM context (Node 18+)
    const require_ = createRequire(import.meta.url);
    // Walk up from cli/utils/ to find package.json at project root
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../package.json',
    );
    const pkg = require_(pkgPath) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    // Fallback: try process.env injected at build time
  }

  // Build-time fallback — tsup can inject this via define
  if (typeof __PKG_VERSION__ !== 'undefined') {
    return __PKG_VERSION__;
  }

  return '0.0.0';
}

/**
 * The current package version string (e.g. "1.2.1").
 * Sourced from package.json — never hardcoded.
 */
export const PKG_VERSION: string = _version ?? (_version = readVersion());

// Suppress TS "cannot find name" — tsup define() injects this at build time
declare const __PKG_VERSION__: string;
