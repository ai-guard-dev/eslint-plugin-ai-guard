import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './create-server.js';

async function main(): Promise<void> {
  const workspace = process.env.AI_GUARD_WORKSPACE ?? process.cwd();
  const server = createMcpServer(workspace);
  await server.connect(new StdioServerTransport());
  process.stderr.write('[ai-guard-mcp] Server started\n');
}
main().catch((error: unknown) => {
  process.stderr.write('[ai-guard-mcp] Fatal: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
