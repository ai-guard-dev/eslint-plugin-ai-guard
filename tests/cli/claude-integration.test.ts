import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readClaudeSettings,
  writeClaudeSettings,
  mergeAiGuardHook,
} from '../../cli/commands/init-claude';
import {
  parsePayload,
  resolveFilePath,
  isScannableFile,
} from '../../cli/commands/claude-hook';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-claude-'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// init-claude: Settings file management
// ═══════════════════════════════════════════════════════════════════════════════

describe('init-claude: readClaudeSettings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads valid JSON settings', () => {
    const settingsPath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ allowedTools: ['*'] }), 'utf-8');

    const result = readClaudeSettings(settingsPath);
    expect(result).toEqual({ allowedTools: ['*'] });
  });

  it('returns null for missing file', () => {
    const settingsPath = path.join(tempDir, 'nonexistent.json');
    const result = readClaudeSettings(settingsPath);
    expect(result).toBeNull();
  });

  it('returns empty object for empty file', () => {
    const settingsPath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(settingsPath, '', 'utf-8');

    const result = readClaudeSettings(settingsPath);
    expect(result).toEqual({});
  });

  it('throws for malformed JSON with helpful message', () => {
    const settingsPath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(settingsPath, '{ invalid json }', 'utf-8');

    expect(() => readClaudeSettings(settingsPath)).toThrow(/Failed to parse/);
    expect(() => readClaudeSettings(settingsPath)).toThrow(/Fix the JSON syntax/);
  });
});

describe('init-claude: writeClaudeSettings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .claude directory and writes formatted JSON', () => {
    const claudeDir = path.join(tempDir, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');

    writeClaudeSettings(settingsPath, { allowedTools: ['*'] });

    expect(fs.existsSync(claudeDir)).toBe(true);
    const content = fs.readFileSync(settingsPath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ allowedTools: ['*'] });
    // Verify pretty formatting with trailing newline
    expect(content).toContain('\n');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('preserves existing properties when writing', () => {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');

    const original = { allowedTools: ['*'], customField: 'value' };
    writeClaudeSettings(settingsPath, original);

    const result = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(result.allowedTools).toEqual(['*']);
    expect(result.customField).toBe('value');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// init-claude: Hook merging logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('init-claude: mergeAiGuardHook', () => {
  it('adds hook to empty settings', () => {
    const { settings, changed } = mergeAiGuardHook({});

    expect(changed).toBe(true);
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks!.PostToolUse).toHaveLength(1);
    expect(settings.hooks!.PostToolUse![0].matcher).toBe('Edit|Write');
    expect(settings.hooks!.PostToolUse![0].hooks[0].type).toBe('command');
    expect(settings.hooks!.PostToolUse![0].hooks[0].command).toContain('ai-guard');
    expect(settings.hooks!.PostToolUse![0].hooks[0].command).toContain('claude-hook');
  });

  it('adds hook when hooks object exists but has no PostToolUse', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo test' }] }],
      },
    };

    const { settings, changed } = mergeAiGuardHook(input);

    expect(changed).toBe(true);
    expect(settings.hooks!.PostToolUse).toHaveLength(1);
    // Preserves PreToolUse
    expect(settings.hooks!.PreToolUse).toBeDefined();
  });

  it('appends to existing PostToolUse matchers', () => {
    const input = {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo done' }] },
        ],
      },
    };

    const { settings, changed } = mergeAiGuardHook(input);

    expect(changed).toBe(true);
    expect(settings.hooks!.PostToolUse).toHaveLength(2);
    // Original matcher preserved
    expect(settings.hooks!.PostToolUse![0].matcher).toBe('Bash');
    // New matcher added
    expect(settings.hooks!.PostToolUse![1].matcher).toBe('Edit|Write');
  });

  it('appends to existing Edit|Write matcher that has no AI Guard hook', () => {
    const input = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: 'prettier --write' }],
          },
        ],
      },
    };

    const { settings, changed } = mergeAiGuardHook(input);

    expect(changed).toBe(true);
    // Same matcher, now with two hooks
    expect(settings.hooks!.PostToolUse).toHaveLength(1);
    expect(settings.hooks!.PostToolUse![0].hooks).toHaveLength(2);
    expect(settings.hooks!.PostToolUse![0].hooks[0].command).toBe('prettier --write');
    expect(settings.hooks!.PostToolUse![0].hooks[1].command).toContain('ai-guard');
  });

  it('is idempotent: returns changed=false when hook already exists', () => {
    const input = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              { type: 'command', command: 'node_modules/.bin/ai-guard claude-hook' },
            ],
          },
        ],
      },
    };

    const { settings, changed } = mergeAiGuardHook(input);

    expect(changed).toBe(false);
    expect(settings.hooks!.PostToolUse).toHaveLength(1);
    expect(settings.hooks!.PostToolUse![0].hooks).toHaveLength(1);
  });

  it('does not mutate the original settings object', () => {
    const input = { allowedTools: ['*'] };
    const copy = JSON.parse(JSON.stringify(input));

    mergeAiGuardHook(input);

    expect(input).toEqual(copy);
  });

  it('preserves other top-level settings', () => {
    const input = {
      allowedTools: ['*'],
      model: 'claude-4',
      permissions: { allow: true },
    };

    const { settings } = mergeAiGuardHook(input);

    expect(settings.allowedTools).toEqual(['*']);
    expect(settings.model).toBe('claude-4');
    expect(settings.permissions).toEqual({ allow: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// claude-hook: Payload parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe('claude-hook: parsePayload', () => {
  it('extracts file_path from tool_input', () => {
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/api.ts', old_string: 'foo', new_string: 'bar' },
    });

    const { filePath, error } = parsePayload(payload);
    expect(filePath).toBe('src/api.ts');
    expect(error).toBeUndefined();
  });

  it('extracts path from tool_input as fallback', () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { path: 'lib/utils.js', content: '...' },
    });

    const { filePath } = parsePayload(payload);
    expect(filePath).toBe('lib/utils.js');
  });

  it('prefers file_path over path', () => {
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.ts', path: 'src/b.ts' },
    });

    const { filePath } = parsePayload(payload);
    expect(filePath).toBe('src/a.ts');
  });

  it('returns null for empty stdin', () => {
    const { filePath, error } = parsePayload('');
    expect(filePath).toBeNull();
    expect(error).toContain('Empty stdin');
  });

  it('returns null for whitespace-only stdin', () => {
    const { filePath, error } = parsePayload('   \n  ');
    expect(filePath).toBeNull();
    expect(error).toContain('Empty stdin');
  });

  it('returns null for invalid JSON', () => {
    const { filePath, error } = parsePayload('not json');
    expect(filePath).toBeNull();
    expect(error).toContain('Invalid JSON');
  });

  it('returns null for missing tool_input', () => {
    const { filePath, error } = parsePayload(JSON.stringify({ tool_name: 'Edit' }));
    expect(filePath).toBeNull();
    expect(error).toContain('Missing tool_input');
  });

  it('returns null for missing file path in tool_input', () => {
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { old_string: 'foo', new_string: 'bar' },
    });

    const { filePath, error } = parsePayload(payload);
    expect(filePath).toBeNull();
    expect(error).toContain('No file path');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// claude-hook: Path resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('claude-hook: resolveFilePath', () => {
  it('resolves relative path to absolute', () => {
    const cwd = '/home/user/project';
    const result = resolveFilePath('src/api.ts', cwd);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('src');
    expect(result).toContain('api.ts');
  });

  it('handles already-absolute path', () => {
    const cwd = process.cwd();
    const absPath = path.join(cwd, 'test.ts');
    const result = resolveFilePath(absPath, cwd);
    expect(result).toBe(path.resolve(absPath));
  });

  it('normalizes backslashes', () => {
    const cwd = process.cwd();
    const result = resolveFilePath('src\\api\\handlers.ts', cwd);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('api');
    expect(result).toContain('handlers.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// claude-hook: File extension filtering
// ═══════════════════════════════════════════════════════════════════════════════

describe('claude-hook: isScannableFile', () => {
  const scannableExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
  const nonScannableExtensions = ['.py', '.css', '.md', '.json', '.html', '.yaml', '.svg'];

  for (const ext of scannableExtensions) {
    it(`returns true for ${ext}`, () => {
      expect(isScannableFile(`src/file${ext}`)).toBe(true);
    });
  }

  for (const ext of nonScannableExtensions) {
    it(`returns false for ${ext}`, () => {
      expect(isScannableFile(`src/file${ext}`)).toBe(false);
    });
  }

  it('handles uppercase extensions', () => {
    expect(isScannableFile('src/file.JS')).toBe(true);
    expect(isScannableFile('src/file.TSX')).toBe(true);
  });

  it('handles files with multiple dots', () => {
    expect(isScannableFile('src/file.test.ts')).toBe(true);
    expect(isScannableFile('src/file.config.json')).toBe(false);
  });
});
