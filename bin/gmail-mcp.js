#!/usr/bin/env node
// gmail-max MCP server (stdio).
//
// No accounts.json in the config directory: single-account mode, exactly as
// before. With accounts.json: multi-account mode (see README "Multiple accounts").
// An invalid accounts file stops the server from starting: guessing at
// permissions would be worse than not running.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CONFIG_DIR } from '../lib/auth.js';
import { accountsFileExists } from '../lib/accounts.js';
import { createLegacyServer, createMultiServer } from '../lib/server.js';

let server;
if (accountsFileExists(CONFIG_DIR)) {
  try {
    server = createMultiServer({ configDir: CONFIG_DIR });
  } catch (err) {
    process.stderr.write(`gmail-max: not starting.\n${err.message}\n`);
    process.exit(1);
  }
} else {
  server = createLegacyServer();
}

const transport = new StdioServerTransport();
await server.connect(transport);
