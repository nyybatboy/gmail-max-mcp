// Test harness: a multi-account server over the SDK's in-memory transport, a
// temporary config directory, and a fake Gmail client per account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
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

export const DEFAULT_ACCOUNTS = {
  personal: { purpose: 'Main inbox.', permissions: { send: 'ask' } },
  work: { purpose: 'Work inbox.', permissions: { send: 'allow' } },
};

export const DEFAULT_MAILBOXES = () => ({
  personal: { email: 'owner@example.com', displayName: 'Owner' },
  work: { email: 'owner@example.org', displayName: 'Owner at Work' },
});

/**
 * options:
 *   accounts   accounts.json "accounts" object
 *   mailboxes  fake mailboxes keyed by label
 *   elicit     undefined -> client does NOT declare elicitation;
 *              function(request) -> client declares form elicitation and answers with it
 *   askTimeoutMs
 */
export async function startMulti({ accounts = DEFAULT_ACCOUNTS, mailboxes = DEFAULT_MAILBOXES(), elicit, askTimeoutMs, fakeOptions } = {}) {
  const configDir = tempDir();
  writeAccounts(configDir, accounts);
  const fake = makeFakeGmail(mailboxes, fakeOptions);
  setGmailClientFactory(fake.factory);

  const server = createMultiServer({ configDir, askTimeoutMs });
  const capabilities = elicit ? { elicitation: { form: {} } } : {};
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities });
  const elicitations = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitations.push(req.params);
      return elicit(req.params);
    });
  }
  const listChanged = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged.push(Date.now()); });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, body: parse(res.content[0].text), raw: res };
  }

  async function close() {
    await client.close();
    await server.close();
    setGmailClientFactory(null);
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  return { server, client, configDir, fake, elicitations, listChanged, call, close };
}

function parse(text) {
  try { return JSON.parse(text); } catch { return text; }
}
