'use strict';
// Starts the AI Guard MCP server installed in this plugin's node_modules
// (pinned in package-lock.json). Claude Code exports CLAUDE_PLUGIN_ROOT to the
// MCP server process, so the server path is rooted there.
const path = require('node:path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
if (!pluginRoot) {
  process.stderr.write('[ai-guard-mcp] CLAUDE_PLUGIN_ROOT is not set; this launcher must be started by Claude Code.\n');
  process.exit(1);
}

require(path.join(pluginRoot, 'node_modules', 'eslint-plugin-ai-guard', 'dist', 'mcp', 'server.js'));
