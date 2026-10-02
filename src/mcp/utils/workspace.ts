/**
 * Workspace security utilities for the MCP server.
 *
 * Enforces path containment, extension validation, and prevents
 * path traversal attacks through MCP tool arguments.
 */

import path from 'path';
import fs from 'fs';

// ─── Supported extensions ─────────────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
]);

// ─── Workspace root ──────────────────────────────────────────────────────────

let _workspaceRoot: string = process.cwd();

/**
 * Set the workspace root for path containment checks.
 * Called once at MCP server startup.
 */
export function setWorkspaceRoot(root: string): void {
  _workspaceRoot = path.resolve(root);
}

/**
 * Get the current workspace root.
 */
export function getWorkspaceRoot(): string {
  return _workspaceRoot;
}

// ─── Path validation ──────────────────────────────────────────────────────────

export interface PathValidation {
  valid: boolean;
  resolvedPath: string;
  error?: string;
}

/**
 * Validate and resolve a path, ensuring it stays within the workspace.
 *
 * Security checks:
 * 1. Normalize Windows/POSIX separators
 * 2. Resolve to absolute path within workspace
 * 3. Reject paths that escape workspace via ../ traversal
 * 4. Reject paths outside workspace after resolution
 * 5. Verify the resolved path is within workspace using realpath where possible
 */
export function validatePath(rawPath: string): PathValidation {
  if (!rawPath || typeof rawPath !== 'string') {
    return { valid: false, resolvedPath: '', error: 'Path is required' };
  }

  // Normalize separators
  const normalized = rawPath.replace(/\\/g, '/');

  // Resolve relative to workspace root
  let resolved: string;
  if (path.isAbsolute(normalized)) {
    resolved = path.resolve(normalized);
  } else {
    resolved = path.resolve(_workspaceRoot, normalized);
  }

  // Ensure resolved path is within workspace
  const workspaceNorm = _workspaceRoot + path.sep;
  if (resolved !== _workspaceRoot && !resolved.startsWith(workspaceNorm)) {
    // Also check with forward slash for cross-platform
    const workspaceNormFwd = _workspaceRoot.replace(/\\/g, '/') + '/';
    const resolvedFwd = resolved.replace(/\\/g, '/');
    if (resolvedFwd !== _workspaceRoot.replace(/\\/g, '/') && !resolvedFwd.startsWith(workspaceNormFwd)) {
      return {
        valid: false,
        resolvedPath: resolved,
        error: `Path "${rawPath}" resolves outside workspace root`,
      };
    }
  }

  // Try to resolve symlinks and re-check containment
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const realFwd = real.replace(/\\/g, '/');
      const wsFwd = _workspaceRoot.replace(/\\/g, '/');
      if (realFwd !== wsFwd && !realFwd.startsWith(wsFwd + '/')) {
        return {
          valid: false,
          resolvedPath: resolved,
          error: `Path "${rawPath}" escapes workspace via symlink`,
        };
      }
    }
  } catch {
    // If realpath fails, the basic check above is sufficient
  }

  return { valid: true, resolvedPath: resolved };
}

/**
 * Check if a file has a supported JS/TS extension.
 */
export function isSupportedExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return JS_TS_EXTENSIONS.has(ext);
}

/**
 * Validate a preset name.
 */
export function isValidPreset(preset: string): preset is 'recommended' | 'strict' | 'security' | 'agent' {
  return ['recommended', 'strict', 'security', 'agent'].includes(preset);
}

/**
 * Sanitize a git ref to prevent shell injection.
 * Only allow alphanumeric, hyphens, underscores, slashes, dots, and tildes.
 */
export function sanitizeGitRef(ref: string): string | null {
  if (!ref || typeof ref !== 'string') return null;
  // Allow safe git ref characters only
  if (!/^[a-zA-Z0-9._/~^-]+$/.test(ref)) return null;
  // Reject obviously dangerous patterns
  if (ref.includes('..') && !ref.match(/^HEAD~\d+$/)) {
    // Allow HEAD~N but reject ../
    if (ref.includes('../') || ref.includes('..\\')) return null;
  }
  return ref;
}
