import fs from 'fs';
import path from 'path';
import type { ScanResult } from '../types.js';
import { getWorkspaceRoot, isSupportedExtension, validatePath } from '../utils/workspace.js';
import { failure, isExcluded, MAX_FILES, scanFiles } from '../utils/scan.js';

export async function scanProject(input: { path?: string; preset?: string; maxFiles?: number }, workspace = getWorkspaceRoot()): Promise<ScanResult> {
  const preset = input.preset ?? 'agent';
  const maxFiles = input.maxFiles ?? MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES) return failure(preset, 'INVALID_INPUT', 'maxFiles must be an integer from 1 to 500');
  const checked = validatePath(input.path ?? '.', workspace);
  if (!checked.valid) return failure(preset, checked.code!, checked.error!);
  try {
    if (!fs.statSync(checked.resolvedPath).isDirectory()) return failure(preset, 'NOT_A_DIRECTORY', 'Project path must be a directory');
    if (isExcluded(path.relative(workspace, checked.resolvedPath))) return failure(preset, 'FILE_EXCLUDED', 'Directory is excluded by the runner');
    const files: string[] = [];
    let entries = 0;
    const visit = (directory: string, depth: number): void => {
      if (depth > 64) throw new Error('RESOURCE_LIMIT: Directory depth exceeds 64');
      // Iterate directories instead of allocating an unbounded readdir result.
      const handle = fs.opendirSync(directory);
      try {
        let entry: fs.Dirent | null;
        while ((entry = handle.readSync()) !== null) {
          if (++entries > 20000) throw new Error('RESOURCE_LIMIT: More than 20000 directory entries');
          const file = path.join(directory, entry.name);
          if (isExcluded(path.relative(workspace, file))) continue;
          if (entry.isSymbolicLink()) throw new Error('SYMLINK_IN_PROJECT: Narrow the scan or use scan_file for individually validated symlinks: ' + file);
          if (entry.isDirectory()) visit(file, depth + 1);
          else if (entry.isFile() && isSupportedExtension(file)) {
            files.push(file);
            if (files.length > maxFiles) throw new Error('RESOURCE_LIMIT: Too many files; choose a smaller directory');
          }
        }
      } finally { handle.closeSync(); }
    };
    visit(checked.resolvedPath, 0);
    return await scanFiles(files, preset, workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith('RESOURCE_LIMIT:') ? 'RESOURCE_LIMIT' : message.startsWith('SYMLINK_IN_PROJECT:') ? 'SYMLINK_IN_PROJECT' : 'SCAN_FAILED';
    return failure(preset, code, message);
  }
}
