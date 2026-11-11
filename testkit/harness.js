// Test harness: a multi-account server over the SDK's in-memory transport, a
// temporary config directory, and a fake Gmail client per account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMultiServer } from '../lib/server.js';
import { setGmailClientFactory } from '../lib/gmail.js';
import { makeFakeGmail } from './fake-gmail.js';

export function tempDir(prefix = 'gmail-max-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeAccounts(configDir, accounts) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'accounts.json'), JSON.stringify({ version: 1, accounts }, null, 2));
}

// "work" has sending turned off; "personal" is all defaults (everything on).
export const DEFAULT_ACCOUNTS = {
  personal: { purpose: 'Main inbox.' },
  work: { purpose: 'Work inbox.', permissions: { send: 'off' } },
};

export const DEFAULT_MAILBOXES = () => ({
  personal: { email: 'owner@example.com', displayName: 'Owner' },
  work: { email: 'owner@example.org', displayName: 'Owner at Work' },
});

/**
 * options:
 *   accounts     accounts.json "accounts" object
 *   mailboxes    fake mailboxes keyed by label
 *   fakeOptions  passed to makeFakeGmail (jitter, mailboxFor)
 */
export async function startMulti({ accounts = DEFAULT_ACCOUNTS, mailboxes = DEFAULT_MAILBOXES(), fakeOptions } = {}) {
  const configDir = tempDir();
  writeAccounts(configDir, accounts);
  const fake = makeFakeGmail(mailboxes, fakeOptions);
  setGmailClientFactory(fake.factory);

  let server = createMultiServer({ configDir });
  let client;
  const listChanged = [];

  async function connect() {
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged.push(Date.now()); });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  }
  await connect();

  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, body: parse(res.content[0].text), raw: res };
  }

  // A fresh server process on the same config directory (as after a restart).
  async function restart() {
    await client.close();
    await server.close();
    server = createMultiServer({ configDir });
    await connect();
  }

  async function close() {
    await client.close();
    await server.close();
    setGmailClientFactory(null);
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  return {
    get server() { return server; },
    get client() { return client; },
    configDir, fake, listChanged, call, restart, close,
  };
}

function parse(text) {
  try { return JSON.parse(text); } catch { return text; }
}
