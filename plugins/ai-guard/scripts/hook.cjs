'use strict';
// Runs AI Guard's Claude Code hook (PostToolUse, SessionStart, Stop) from this plugin's
// node_modules, with the rules bundled in the plugin: the project does not need AI Guard
// installed. The hook payload arrives on stdin and is handled by the fast hook entry point.
process.argv = [process.argv[0], __filename, '--agent', 'claude', '--isolated'];
require('../node_modules/eslint-plugin-ai-guard/dist/cli/hook.js');
