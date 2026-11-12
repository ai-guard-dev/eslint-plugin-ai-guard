'use strict';
// PreToolUse (Bash, PowerShell): checks the npm packages in install commands before they run.
// Off unless the plugin option "check_installs" is enabled (or AI_GUARD_CHECK_INSTALLS=1).
// Every other command returns at once, without starting the AI Guard CLI.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const on = (value) => /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
if (!on(process.env.CLAUDE_PLUGIN_OPTION_CHECK_INSTALLS) && !on(process.env.AI_GUARD_CHECK_INSTALLS)) process.exit(0);

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
let command = '';
try {
  const payload = JSON.parse(raw);
  command = payload && payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
} catch {
  process.exit(0);
}
if (!/\b(?:npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack)\b/.test(command)) process.exit(0);

const cli = path.join(__dirname, '..', 'node_modules', 'eslint-plugin-ai-guard', 'dist', 'cli', 'hook.js');
spawnSync(process.execPath, [cli, '--agent', 'claude', '--isolated', '--check-installs', '--bash-guard', 'off'], {
  input: raw,
  stdio: ['pipe', 'inherit', 'inherit'],
  timeout: 25000,
  windowsHide: true,
});
process.exit(0);
