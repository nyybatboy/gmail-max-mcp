// Measures the size of the tools/list payload a client receives:
//   - one single-account server
//   - N single-account registrations (N x the above)
//   - one multi-account server with N accounts
// Bytes are exact (JSON.stringify of the tools array, UTF-8). Tokens are an
// estimate only (bytes / 4); count with your model's tokenizer for real numbers.
// No credentials or network: both servers are created in-process.
//   node testkit/measure-tool-list.js [N=2]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLegacyServer, createMultiServer } from '../lib/server.js';

async function listedBytes(server) {
  const client = new Client({ name: 'measure', version: '0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() || '';
  await client.close();
  await server.close();
  return { tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)), instructionsBytes: Buffer.byteLength(instructions) };
}

const n = Number(process.argv[2] || 2);
const purposes = ['Main inbox.', 'Work inbox: clients and invoices.', 'Shared family inbox.', 'Side project.', 'Archive account.'];
const labels = ['personal', 'work', 'family', 'project', 'archive'];

const legacy = await listedBytes(createLegacyServer());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-max-measure-'));
const accounts = {};
for (let i = 0; i < n; i++) accounts[labels[i]] = { purpose: purposes[i], permissions: i === 0 ? { send: 'ask' } : { send: 'allow' } };
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts }));
const multi = await listedBytes(createMultiServer({ configDir: dir }));
fs.rmSync(dir, { recursive: true, force: true });

const est = (b) => Math.round(b / 4);
console.log(JSON.stringify({
  accounts: n,
  singleRegistration: { tools: legacy.tools, bytes: legacy.bytes, estTokens: est(legacy.bytes) },
  separateRegistrations: { tools: legacy.tools * n, bytes: legacy.bytes * n, estTokens: est(legacy.bytes * n) },
  oneMultiAccountServer: { tools: multi.tools, bytes: multi.bytes, instructionsBytes: multi.instructionsBytes, estTokens: est(multi.bytes + multi.instructionsBytes) },
}, null, 2));
