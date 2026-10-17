import path from 'path';
import fs from 'fs';

const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
let workspaceRoot = process.cwd();

export function canonicalWorkspace(root: string): string {
  const real = fs.realpathSync(path.resolve(root));
  if (!fs.statSync(real).isDirectory()) throw new Error('Workspace must be a directory');
  return real;
}
export function setWorkspaceRoot(root: string): void { workspaceRoot = canonicalWorkspace(root); }
export function getWorkspaceRoot(): string { return workspaceRoot; }

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export interface PathValidation { valid: boolean; resolvedPath: string; code?: string; error?: string }

export function validatePath(rawPath: string, root = workspaceRoot): PathValidation {
  const invalid = (code: string, error: string): PathValidation => ({ valid: false, resolvedPath: '', code, error });
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) {
    return invalid('INVALID_PATH', 'A nonempty path without NUL characters is required');
  }
  // Reject drive-relative paths, device paths, and foreign absolute paths.
  if (/^[a-z]:[^\\/]/i.test(rawPath) || rawPath.startsWith('\\\\?\\') ||
      rawPath.startsWith('\\\\.\\') || (process.platform !== 'win32' && /^[a-z]:/i.test(rawPath))) {
    return invalid('INVALID_PATH', 'Use a workspace-relative path or a native absolute path');
  }
  const resolved = path.resolve(root, rawPath.replace(/\\/g, '/'));
  if (!isWithin(path.resolve(root), resolved)) return invalid('OUTSIDE_WORKSPACE', 'Path resolves outside workspace root');
  try {
    const real = fs.realpathSync(resolved);
    if (!isWithin(canonicalWorkspace(root), real)) return invalid('OUTSIDE_WORKSPACE', 'Path escapes workspace via symlink');
    return { valid: true, resolvedPath: real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return invalid(code === 'ENOENT' ? 'PATH_NOT_FOUND' : 'PATH_UNREADABLE',
      'Cannot resolve path: ' + (error instanceof Error ? error.message : String(error)));
  }
}
export function isSupportedExtension(file: string): boolean { return EXTENSIONS.has(path.extname(file).toLowerCase()); }
export function isValidPreset(preset: string): preset is 'recommended' | 'strict' | 'security' | 'agent' {
  return ['recommended', 'strict', 'security', 'agent'].includes(preset);
}
export function sanitizeGitRef(ref: string): string | null {
  return typeof ref === 'string' && ref.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._/~^-]*$/.test(ref) &&
    !ref.includes('..') && !ref.includes('//') ? ref : null;
}
