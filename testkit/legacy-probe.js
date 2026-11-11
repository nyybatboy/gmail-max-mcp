// Spawns bin/gmail-mcp.js over real stdio against an EMPTY temporary config
// directory (and a temporary HOME), then records everything a client can
// observe without credentials: server info, capabilities, instructions, the
// full tools/list result, and the exact result of two calls that fail before
// any network I/O (an unknown tool, and a known tool with no token).
//
// Lives outside test/ because `node --test` runs every .js file under test/.
// Used by test/legacy-snapshot.test.js. Run directly to regenerate the fixture:
//   node testkit/legacy-probe.js > test/fixtures/legacy-snapshot.json
// Only ever regenerate from the pre-multi-account code: the fixture IS the
// definition of legacy (no accounts file) behaviour.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'bin', 'gmail-mcp.js');

export async function probeLegacy() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-max-legacy-'));
  const env = { PATH: process.env.PATH, HOME: tmp, GMAIL_MCP_CONFIG_DIR: path.join(tmp, 'cfg') };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 'legacy-probe', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
    const noToken = await client.callTool({ name: 'list_labels', arguments: {} });
    return {
      serverVersion: client.getServerVersion(),
      serverCapabilities: client.getServerCapabilities(),
      instructions: client.getInstructions() ?? null,
      tools,
      unknownToolResult: unknown,
      noTokenResult: noToken,
    };
  } finally {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const snap = await probeLegacy();
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
}
