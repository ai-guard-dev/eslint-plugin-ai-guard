import { getWorkspaceRoot } from '../utils/workspace.js';
import { scanFiles } from '../utils/scan.js';
import type { ScanResult } from '../types.js';

export function scanFile(input: { path: string; preset?: string; maxIssues?: number }, workspace = getWorkspaceRoot()): Promise<ScanResult> {
  return scanFiles([input.path], input.preset ?? 'agent', workspace, input.maxIssues);
}
