'use strict';
// Starts the AI Guard MCP server installed in this plugin's node_modules
// (pinned in package-lock.json). Resolved relative to this file so it works
// on any platform and from any working directory.
const path = require('node:path');

require('../node_modules/eslint-plugin-ai-guard/dist/mcp/server.js');