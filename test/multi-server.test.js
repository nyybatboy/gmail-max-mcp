import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMulti, writeAccounts, tempDir, DEFAULT_MAILBOXES } from '../testkit/harness.js';
import { draftPayload, b64urlDecode } from '../testkit/fake-gmail.js';
import { createMultiServer, createLegacyServer } from '../lib/server.js';
import { setGmailClientFactory } from '../lib/gmail.js';
import { loadAccounts } from '../lib/accounts.js';
import { TOOLS } from '../lib/tools.js';

const MSG = { to: 'friend@example.net', subject: 'Hello', text: 'A short note.' };
const sends = (h, label) => h.fake.calls.filter((c) => c.account === label && (c.method === 'messages.send' || c.method === 'drafts.send'));
const enumOf = (tools, name) => tools.find((x) => x.name === name)?.inputSchema.properties.account.enum;
const ALL_ON = { personal: { purpose: 'Main inbox.' }, work: { purpose: 'Work inbox.' } };

// ---------- listing ----------

test('tools/list: list_accounts and set_permission, then every tool with a required account enum first', async (t) => {
  const h = await startMulti({ accounts: ALL_ON });
  t.after(h.close);
  const { tools } = await h.client.listTools();
  assert.deepEqual(tools.slice(0, 2).map((x) => x.name), ['list_accounts', 'set_permission']);
  assert.equal(tools.length, Object.keys(TOOLS).length + 2);
  for (const tool of tools.slice(2)) {
    const s = tool.inputSchema;
    assert.equal(Object.keys(s.properties)[0], 'account', tool.name);
    assert.equal(s.required[0], 'account', tool.name);
    assert.deepEqual(s.properties.account.enum, ['personal', 'work'], tool.name);
    assert.equal(s.properties.account.default, undefined, 'no default account');
    assert.match(s.properties.account.description, /personal: Main inbox\..*work: Work inbox\./);
    assert.doesNotMatch(s.properties.account.description, /ask/i);
    assert.equal(tool.description, TOOLS[tool.name].description, 'tool descriptions are unchanged');
  }
  assert.deepEqual(h.client.getServerCapabilities(), { tools: { listChanged: true } });
  assert.match(h.client.getInstructions(), /required `account` argument; there is no default/);
});

test('tools/list: an account where a tool is off leaves its enum; a tool off everywhere is not listed', async (t) => {
  const h = await startMulti({ accounts: {
    personal: { purpose: 'Main inbox.', permissions: { delete: 'off' } },
    work: { purpose: 'Work inbox.', permissions: { send: 'off', delete: 'off' } },
  } });
  t.after(h.close);
  const { tools } = await h.client.listTools();
  assert.deepEqual(enumOf(tools, 'send_message'), ['personal']);
  assert.equal(enumOf(tools, 'delete_message'), undefined);
  assert.deepEqual(enumOf(tools, 'list_messages'), ['personal', 'work']);
  assert.deepEqual(tools.find((x) => x.name === 'set_permission').inputSchema.properties.account.enum, ['personal', 'work', 'all']);
});

// ---------- account selection and echo ----------

test('no default: a call without account, with an unknown one, or with a non-string is refused and touches nothing', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  assert.match((await h.call('list_labels', {})).body.error, /account is required; there is no default\. Choose one of: personal, work/);
  assert.match((await h.call('list_labels', { account: 'nobody' })).body.error, /Unknown account "nobody"/);
  for (const account of [['personal'], { toString: 'personal' }, 0, true]) {
    assert.match((await h.call('list_labels', { account })).body.error, /account must be a string label/);
  }
  assert.equal(h.fake.calls.length, 0);
});

test('odd tool names are unknown tools', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await h.call(name, { account: 'personal' });
    assert.equal(r.body, `Unknown tool: ${name}`);
  }
});

test('reads route to the named account and echo account and address', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const r = await h.call('list_labels', { account: 'work' });
  assert.deepEqual(Object.keys(r.body), ['account', 'address', 'result']);
  assert.equal(r.body.address, 'owner@example.org');
  assert.ok(h.fake.calls.every((c) => c.account === 'work'));
  assert.ok(!('account' in h.fake.calls.find((c) => c.method === 'labels.list').params), 'account is stripped before the Gmail call');
});

test('compose results lead with account and the From address', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const d = await h.call('create_draft', { account: 'personal', ...MSG });
  assert.deepEqual(Object.keys(d.body), ['account', 'from', 'address', 'result']);
  assert.equal(d.body.from, 'Owner <owner@example.com>');
  const explicit = await h.call('create_draft', { account: 'work', ...MSG, from: { name: 'Alias', email: 'alias@example.org' } });
  assert.equal(explicit.body.from, 'Alias <alias@example.org>');
});

// ---------- on and off ----------

test('on: a send just sends, no questions', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const r = await h.call('send_message', { account: 'personal', ...MSG });
  assert.equal(r.isError, false);
  assert.equal(r.body.from, 'Owner <owner@example.com>');
  assert.equal(sends(h, 'personal').length, 1);
});

test('off: a send is refused with one clear line, before any Gmail call', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const r = await h.call('send_message', { account: 'work', ...MSG });
  assert.equal(r.isError, true);
  assert.deepEqual(r.body, {
    account: 'work',
    refused: true,
    reason: 'Not sent. Sending is turned off for the "work" account. The user can ask to have it turned back on.',
  });
  assert.equal(h.fake.calls.length, 0);
});

test('off: any other tool is refused the same way', async (t) => {
  const h = await startMulti({ accounts: { personal: { purpose: 'a', permissions: { delete_thread: 'off' } }, work: { purpose: 'b' } } });
  t.after(h.close);
  const r = await h.call('delete_thread', { account: 'personal', id: 't' });
  assert.match(r.body.reason, /^Not run\. delete_thread \(permanent delete .*\) is turned off for the "personal" account\. The user can ask to have it turned back on\.$/);
  assert.equal(h.fake.calls.length, 0);
});

test('send_draft sends and reports the draft\'s From', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.personal.drafts = { d1: { id: 'd1', message: { id: 'm1', payload: draftPayload({ from: 'Owner <owner@example.com>', to: 'v@example.net', subject: 'Q', text: 'B' }) } } };
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  const r = await h.call('send_draft', { account: 'personal', id: 'd1' });
  assert.equal(r.isError, false);
  assert.equal(r.body.from, 'Owner <owner@example.com>');
  assert.equal(sends(h, 'personal').length, 1);
});

// ---------- set_permission ----------

test('set_permission: off persists across a restart and removes the account from the tool\'s list', async (t) => {
  const h = await startMulti({ accounts: ALL_ON });
  t.after(h.close);
  await h.client.listTools();
  const r = await h.call('set_permission', { account: 'work', what: 'send', state: 'off' });
  assert.equal(r.isError, false);
  assert.equal(r.body.summary, 'Sending mail is now off for work.');
  assert.deepEqual(r.body.changes, [{ account: 'work', what: 'send', before: 'on', after: 'off' }]);
  assert.deepEqual(r.body.accounts, [{ label: 'work', on: ['read', 'draft', 'organize', 'delete', 'routing', 'settings'], off: ['send'], toolsOff: [], toolsOn: [] }]);
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(h.listChanged.length >= 1, 'the client is told the tool list changed');
  assert.deepEqual(enumOf((await h.client.listTools()).tools, 'send_message'), ['personal']);
  assert.deepEqual(loadAccounts(h.configDir).accounts[1].permissions, { send: 'off' }, 'saved in accounts.json');

  await h.restart();
  assert.deepEqual(enumOf((await h.client.listTools()).tools, 'send_message'), ['personal'], 'still off after a restart');
  assert.match((await h.call('send_message', { account: 'work', ...MSG })).body.reason, /Sending is turned off for the "work" account/);
});

test('set_permission: on restores the account to the tool\'s list and the send goes through', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const r = await h.call('set_permission', { account: 'work', what: 'send', state: 'on' });
  assert.equal(r.body.summary, 'Sending mail is now on for work.');
  assert.deepEqual(r.body.accounts[0].off, []);
  assert.deepEqual(enumOf((await h.client.listTools()).tools, 'send_message'), ['personal', 'work']);
  assert.equal((await h.call('send_message', { account: 'work', ...MSG })).isError, false);
  assert.equal(sends(h, 'work').length, 1);
});

test('set_permission: "turn off permanent delete everywhere" and "turn off all sends" (one-time)', async (t) => {
  const h = await startMulti({ accounts: ALL_ON });
  t.after(h.close);
  const del = await h.call('set_permission', { account: 'all', what: 'delete', state: 'off' });
  assert.equal(del.body.summary, 'Permanent delete (skips Trash, cannot be undone) is now off for personal, work.');
  const { tools } = await h.client.listTools();
  assert.equal(tools.find((x) => x.name === 'delete_message'), undefined, 'off everywhere: not listed');

  const sendsOff = await h.call('set_permission', { account: 'all', what: 'send', state: 'off' });
  assert.deepEqual(sendsOff.body.accounts.map((a) => a.off), [['send', 'delete'], ['send', 'delete']]);
  await h.call('set_permission', { account: 'personal', what: 'send', state: 'on' });
  const after = (await h.call('list_accounts', {})).body.accounts;
  assert.deepEqual(after.map((a) => [a.label, a.off]), [['personal', ['delete']], ['work', ['send', 'delete']]], 'each account can be turned back on on its own');
});

test('set_permission: a single tool, and an "already off" note', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const one = await h.call('set_permission', { account: 'personal', what: 'send_draft', state: 'off' });
  assert.equal(one.body.summary, 'The send_draft tool is now off for personal.');
  assert.deepEqual(one.body.accounts[0].toolsOff, ['send_draft']);
  const again = await h.call('set_permission', { account: 'all', what: 'send', state: 'off' });
  assert.equal(again.body.summary, 'Sending mail is now off for personal, work. (It was already off for work.)');
});

test('set_permission: bad input is refused and nothing is saved', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const before = fs.readFileSync(path.join(h.configDir, 'accounts.json'), 'utf8');
  const bad = [
    [{ account: 'nobody', what: 'send', state: 'off' }, /No account "nobody"/],
    [{ what: 'send', state: 'off' }, /account is required/],
    [{ account: 'work', what: 'sending', state: 'off' }, /"what" must be a group/],
    [{ account: 'work', what: 'constructor', state: 'off' }, /"what" must be a group/],
    [{ account: 'work', what: 'send', state: 'block' }, /"state" must be "on" or "off"/],
    [{ account: 'work', what: 'send' }, /"state" must be "on" or "off"/],
  ];
  for (const [args, re] of bad) {
    const r = await h.call('set_permission', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.body.error, re);
  }
  assert.equal(fs.readFileSync(path.join(h.configDir, 'accounts.json'), 'utf8'), before);
});

// ---------- list_accounts ----------

test('list_accounts shows each account\'s on and off state and address', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const r = await h.call('list_accounts', {});
  assert.deepEqual(r.body.accounts, [
    { label: 'personal', purpose: 'Main inbox.', address: 'owner@example.com', on: ['read', 'draft', 'organize', 'send', 'delete', 'routing', 'settings'], off: [], toolsOff: [], toolsOn: [] },
    { label: 'work', purpose: 'Work inbox.', address: 'owner@example.org', on: ['read', 'draft', 'organize', 'delete', 'routing', 'settings'], off: ['send'], toolsOff: [], toolsOn: [] },
  ]);
});

test('list_accounts does not read the profile of an account whose read is off', async (t) => {
  const h = await startMulti({ accounts: { personal: { purpose: 'a', permissions: { read: 'off' } }, work: { purpose: 'b' } } });
  t.after(h.close);
  const r = await h.call('list_accounts', {});
  assert.equal(r.body.accounts[0].address, null);
  assert.equal(h.fake.calls.filter((c) => c.account === 'personal').length, 0);
});

// ---------- the file is live; broken files fail closed ----------

test('an edit to accounts.json applies to the next call and the client is told', async (t) => {
  const h = await startMulti({ accounts: ALL_ON });
  t.after(h.close);
  await h.client.listTools();
  writeAccounts(h.configDir, { personal: { purpose: 'Main inbox.', permissions: { send: 'off' } }, work: { purpose: 'Work inbox.' } });
  assert.match((await h.call('send_message', { account: 'personal', ...MSG })).body.reason, /turned off/);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(h.listChanged.length, 1);
});

test('an accounts file broken while running makes every call fail; an invalid one stops the server starting', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  fs.writeFileSync(path.join(h.configDir, 'accounts.json'), '{ broken');
  assert.match((await h.call('send_message', { account: 'personal', ...MSG })).body.error, /not valid JSON/);
  assert.equal(h.fake.calls.length, 0);
  await assert.rejects(h.client.listTools(), /not valid JSON/);
  const dir = tempDir();
  writeAccounts(dir, { personal: { purpose: 'x', permissions: { send: 'sometimes' } } });
  assert.throws(() => createMultiServer({ configDir: dir }), /"send" is "sometimes"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- cross-account hint, address cache, concurrency ----------

test('a not-found ID seen under another account gets a hint; unknown IDs pass untouched', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.messages = { w1: { id: 'w1', threadId: 'wt1' } };
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  await h.call('list_messages', { account: 'work' });
  const wrong = await h.call('get_message', { account: 'personal', id: 'w1' });
  assert.equal(wrong.body.code, 404);
  assert.match(wrong.body.error, /Hint: ID w1 was returned by account "work" earlier in this session, not "personal"/);
  const unseen = await h.call('get_message', { account: 'personal', id: 'never-seen' });
  assert.doesNotMatch(unseen.body.error, /Hint:/);
});

test('re-pointing a label at another folder changes the address shown', async (t) => {
  const mailboxes = { ...DEFAULT_MAILBOXES(), other: { email: 'someone-else@example.org' } };
  const h = await startMulti({ mailboxes, fakeOptions: { mailboxFor: (a) => (a.dir.endsWith('elsewhere') ? 'other' : a.label) } });
  t.after(h.close);
  assert.equal((await h.call('list_labels', { account: 'work' })).body.address, 'owner@example.org');
  writeAccounts(h.configDir, { personal: { purpose: 'Main inbox.' }, work: { purpose: 'Work inbox.', dir: 'elsewhere' } });
  assert.equal((await h.call('list_labels', { account: 'work' })).body.address, 'someone-else@example.org');
});

test('200 interleaved calls across two accounts never cross accounts', async (t) => {
  const h = await startMulti({ accounts: ALL_ON, fakeOptions: { jitter: true } });
  t.after(h.close);
  const expect = { personal: 'owner@example.com', work: 'owner@example.org' };
  const jobs = [];
  for (let i = 0; i < 200; i++) {
    const account = i % 2 ? 'personal' : 'work';
    const tool = ['send_message', 'create_draft', 'whoami', 'list_labels'][i % 4];
    const args = tool === 'whoami' || tool === 'list_labels' ? { account } : { account, to: 'x@example.net', subject: `s-${account}-${i}`, text: 't' };
    jobs.push(h.call(tool, args).then((r) => ({ account, tool, r })));
  }
  for (const { account, tool, r } of await Promise.all(jobs)) {
    assert.equal(r.isError, false);
    assert.equal(r.body.account, account);
    assert.equal(r.body.address, expect[account]);
    if ('from' in r.body) assert.ok(String(r.body.from).includes(expect[account]));
    if (tool === 'whoami') assert.equal(r.body.result.emailAddress, expect[account]);
  }
  for (const c of h.fake.calls.filter((x) => x.method === 'messages.send' || x.method === 'drafts.create')) {
    const raw = c.method === 'messages.send' ? c.params.requestBody.raw : c.params.requestBody.message.raw;
    assert.match(b64urlDecode(raw), new RegExp(`Subject: s-${c.account}-`));
  }
});

// ---------- legacy success shape ----------

test('legacy success results are bare: the result as pretty JSON, no wrapper, no isError', async (t) => {
  const result = { labels: [{ id: 'INBOX', name: 'INBOX' }] };
  setGmailClientFactory(() => ({ users: { labels: { list: async () => ({ data: result }) } } }));
  const server = createLegacyServer();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(async () => { await client.close(); await server.close(); setGmailClientFactory(null); });
  const r = await client.callTool({ name: 'list_labels', arguments: {} });
  assert.deepEqual(r, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
});
