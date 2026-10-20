#!/bin/sh
set -eu
exec node "${CLAUDE_PLUGIN_ROOT}/node_modules/eslint-plugin-ai-guard/dist/mcp/server.js"