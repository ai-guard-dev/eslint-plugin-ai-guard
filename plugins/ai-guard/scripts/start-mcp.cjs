'use strict';
// Starts the AI Guard MCP server from this plugin's node_modules, which Claude Code
// installs from package-lock.json when the plugin is installed. The path is static and
// resolved relative to this file. Claude Code starts the server in the user's project
// directory, which the server uses as its workspace.
require('../node_modules/eslint-plugin-ai-guard/dist/mcp/server.js');
