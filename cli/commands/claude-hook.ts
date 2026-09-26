import type { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { runEslint, ISSUE_REMEDIATION, ISSUE_CONFIDENCE } from '../utils/eslint-runner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolInput {
  file_path?: string;
  path?: string;
  [key: string]: unknown;
}

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: ToolInput;
  tool_result?: unknown;
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read all of stdin as a string.
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', reject);

    // If stdin is a TTY (run manually), resolve immediately with empty
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/**
 * Parse the PostToolUse payload and extract the file path.
 */
export function parsePayload(raw: string): { filePath: string | null; error?: string } {
  if (!raw || raw.trim() === '') {
    return { filePath: null, error: 'Empty stdin — no PostToolUse payload received' };
  }

  let payload: PostToolUsePayload;
  try {
    payload = JSON.parse(raw) as PostToolUsePayload;
  } catch {
    return { filePath: null, error: 'Invalid JSON on stdin' };
  }

  // Extract file path from tool_input
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') {
    return { filePath: null, error: 'Missing tool_input in payload' };
  }

  const rawPath = input.file_path ?? input.path;
  if (!rawPath || typeof rawPath !== 'string') {
    return { filePath: null, error: 'No file path found in tool_input' };
  }

  return { filePath: rawPath };
}

/**
 * Normalize the file path to an absolute path, handling Windows/Unix differences.
 */
export function resolveFilePath(rawPath: string, cwd: string): string {
  // Handle both forward and back slashes
  const normalized = rawPath.replace(/\\/g, '/');

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }

  return path.resolve(cwd, normalized);
}

/**
 * Check if a file extension is a JS/TS file that AI Guard can scan.
 */
export function isScannableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return JS_TS_EXTENSIONS.has(ext);
}

/**
 * Format a single finding as agent-friendly diagnostic text.
 */
function formatFinding(
  ruleId: string,
  filePath: string,
  line: number,
  column: number,
  message: string,
): string {
  const relPath = path.relative(process.cwd(), filePath);
  const confidence = ISSUE_CONFIDENCE[ruleId];
  const remediation = ISSUE_REMEDIATION[ruleId];

  const parts: string[] = [
    ruleId,
    `${relPath}:${line}:${column}`,
    '',
    message,
  ];

  if (remediation) {
    parts.push(remediation);
  }

  if (confidence) {
    parts.push(`Confidence: ${confidence}`);
  }

  return parts.join('\n');
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerClaudeHookCommand(program: Command): void {
  program
    .command('claude-hook')
    .description('Internal: PostToolUse hook entrypoint for Claude Code (reads JSON from stdin)')
    .option('--file <path>', 'Override: scan this file instead of reading stdin (for testing)')
    .action(async (opts: { file?: string }) => {
      const cwd = process.cwd();

      let targetFile: string;

      if (opts.file) {
        // Direct file override — for testing and debugging
        targetFile = resolveFilePath(opts.file, cwd);
      } else {
        // Normal mode — read PostToolUse payload from stdin
        const stdinData = await readStdin();
        const { filePath, error } = parsePayload(stdinData);

        if (!filePath) {
          // Silent exit — don't disrupt Claude's workflow
          if (error && process.env.AI_GUARD_DEBUG === '1') {
            process.stderr.write(`[ai-guard] ${error}\n`);
          }
          process.exit(0);
          return;
        }

        targetFile = resolveFilePath(filePath, cwd);
      }

      // Skip non-JS/TS files silently
      if (!isScannableFile(targetFile)) {
        process.exit(0);
        return;
      }

      // Skip if file doesn't exist (may have been deleted)
      if (!fs.existsSync(targetFile)) {
        process.exit(0);
        return;
      }

      // Run AI Guard with agent preset
      try {
        const result = await runEslint({
          preset: 'agent' as any,
          targetPath: path.dirname(targetFile),
          files: [targetFile],
        });

        // No findings — silent exit
        if (result.totalIssues === 0) {
          process.exit(0);
          return;
        }

        // Format and output findings
        const findings: string[] = [];

        for (const file of result.files) {
          for (const issue of file.issues) {
            findings.push(
              formatFinding(
                issue.ruleId,
                file.filePath,
                issue.line,
                issue.column,
                issue.message,
              ),
            );
          }
        }

        const count = findings.length;
        const header = `AI Guard found ${count} issue${count !== 1 ? 's' : ''}.`;
        const output = [header, '', ...findings.join('\n\n---\n\n').split('\n')].join('\n');

        process.stdout.write(output + '\n');
        process.exit(0);
      } catch (err) {
        // Never crash Claude's workflow — log to stderr in debug mode only
        if (process.env.AI_GUARD_DEBUG === '1') {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[ai-guard] Hook error: ${msg}\n`);
        }
        process.exit(0);
      }
    });
}
