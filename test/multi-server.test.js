import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMulti, writeAccounts, tempDir } from '../testkit/harness.js';
import { draftPayload } from '../testkit/fake-gmail.js';
import { createMultiServer } from '../lib/server.js';
import { TOOLS } from '../lib/tools.js';

const MSG = { to: 'friend@example.net', subject: 'Hello', text: 'A short note.' };
const sends = (fake, label) => fake.calls.filter((c) => c.account === label && (c.method === 'messages.send' || c.method === 'drafts.send'));
const approve = () => ({ action: 'accept', content: { approve: true } });

// ---------- listing ----------

test('tools/list: list_accounts plus every tool, each with a required account enum first', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const { tools } = await h.client.listTools();
  assert.equal(tools[0].name, 'list_accounts');
  assert.equal(tools.length, Object.keys(TOOLS).length + 1);
  for (const tool of tools.slice(1)) {
    const s = tool.inputSchema;
    assert.equal(Object.keys(s.properties)[0], 'account', tool.name);
    assert.equal(s.required[0], 'account', tool.name);
    assert.deepEqual(s.properties.account.enum, ['personal', 'work'], tool.name);
    assert.equal(s.properties.account.default, undefined, 'no default account');
    assert.match(s.properties.account.description, /personal: Main inbox\..*work: Work inbox\./);
    assert.equal(tool.description, TOOLS[tool.name].description, 'tool descriptions are unchanged');
  }
  const send = tools.find((x) => x.name === 'send_message').inputSchema.properties.account.description;
  assert.match(send, /personal: Main inbox\. \[asks the user first\]/);
  assert.doesNotMatch(send, /work: Work inbox\. \[asks/);
  assert.deepEqual(h.client.getServerCapabilities(), { tools: { listChanged: true } });
  assert.match(h.client.getInstructions(), /required `account` argument; there is no default/);
  assert.match(h.client.getInstructions(), /personal \(Main inbox\.\); work \(Work inbox\.\)/);
});

test('tools/list: a blocked account drops out of that tool\'s enum; a tool blocked everywhere is not listed', async (t) => {
  const h = await startMulti({ accounts: {
    personal: { purpose: 'Main inbox.', permissions: { send: 'block', delete: 'block' } },
    work: { purpose: 'Work inbox.', permissions: { send: 'allow', delete: 'block' } },
  } });
  t.after(h.close);
  const { tools } = await h.client.listTools();
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  assert.deepEqual(byName.send_message.inputSchema.properties.account.enum, ['work']);
  assert.equal(byName.delete_message, undefined);
  assert.equal(byName.batch_delete_messages, undefined);
  assert.deepEqual(byName.list_messages.inputSchema.properties.account.enum, ['personal', 'work']);
});

// ---------- account selection and echo ----------

test('no default: a call without account, or with an unknown one, is refused and touches nothing', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const missing = await h.call('list_labels', {});
  assert.equal(missing.isError, true);
  assert.match(missing.body.error, /account is required; there is no default\. Choose one of: personal, work/);
  const unknown = await h.call('list_labels', { account: 'nobody' });
  assert.match(unknown.body.error, /Unknown account "nobody"/);
  assert.equal(h.fake.calls.length, 0);
});

test('reads route to the named account and echo account and address', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const r = await h.call('list_labels', { account: 'work' });
  assert.equal(r.isError, false);
  assert.deepEqual(Object.keys(r.body), ['account', 'address', 'result']);
  assert.equal(r.body.account, 'work');
  assert.equal(r.body.address, 'owner@example.org');
  assert.deepEqual(r.body.result.labels, [{ id: 'INBOX', name: 'INBOX' }]);
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

// ---------- send: allow / ask / block ----------

test('allow: sends without asking', async (t) => {
  const h = await startMulti({ elicit: approve });
  t.after(h.close);
  const r = await h.call('send_message', { account: 'work', ...MSG });
  assert.equal(r.isError, false);
  assert.equal(r.body.from, 'Owner at Work <owner@example.org>');
  assert.equal(h.elicitations.length, 0);
  assert.equal(sends(h.fake, 'work').length, 1);
});

test('ask: the dialog shows account, From, To, Subject and body; ticked accept sends', async (t) => {
  const h = await startMulti({ elicit: approve });
  t.after(h.close);
  const ok = await h.call('send_message', { account: 'personal', ...MSG });
  assert.equal(ok.isError, false);
  assert.equal(sends(h.fake, 'personal').length, 1);
  const req = h.elicitations[0];
  assert.match(req.message, /send an email from the "personal" account \(owner@example\.com\)/);
  assert.match(req.message, /From: Owner <owner@example\.com>/);
  assert.match(req.message, /To: friend@example\.net/);
  assert.match(req.message, /Subject: Hello/);
  assert.match(req.message, /A short note\./);
  assert.equal(req.requestedSchema.properties.approve.type, 'boolean');
  assert.equal(req.requestedSchema.properties.approve.default, false);
  assert.equal(req.requestedSchema.properties.approve.title, 'Send this message');
});

test('ask: the dialog lists attachment names and truncates long bodies', async (t) => {
  const h = await startMulti({ elicit: () => ({ action: 'decline' }) });
  t.after(h.close);
  await h.call('send_message', { account: 'personal', ...MSG, text: 'x'.repeat(7000), attachments: [{ filename: 'report.pdf', contentBase64: 'AA==' }] });
  assert.match(h.elicitations[0].message, /Attachments \(1\): report\.pdf \(application\/octet-stream, supplied inline, 1 bytes\)/);
  assert.match(h.elicitations[0].message, /7000 characters/);
  assert.match(h.elicitations[0].message, /x{5000}…\n\[2000 more characters are not shown\]/);
  assert.doesNotMatch(h.elicitations[0].message, /x{5001}/);
});

for (const [label, answer, reason] of [
  ['accept with the box unticked', { action: 'accept', content: { approve: false } }, /The user declined/],
  ['decline', { action: 'decline' }, /The user declined/],
  ['cancel', { action: 'cancel' }, /No answer from the user/],
]) {
  test(`ask: ${label} does not send and says not to retry`, async (t) => {
    const h = await startMulti({ elicit: () => answer });
    t.after(h.close);
    const r = await h.call('send_message', { account: 'personal', ...MSG });
    assert.equal(r.isError, true);
    assert.equal(r.body.refused, true);
    assert.match(r.body.reason, /^Not sent\./);
    assert.match(r.body.reason, reason);
    assert.match(r.body.reason, /Do not retry unless the user asks/);
    assert.equal(sends(h.fake, 'personal').length, 0);
  });
}

test('ask: no answer within the timeout counts as no answer', async (t) => {
  const h = await startMulti({ elicit: () => new Promise(() => {}), askTimeoutMs: 50 });
  t.after(h.close);
  const r = await h.call('send_message', { account: 'personal', ...MSG });
  assert.match(r.body.reason, /No answer from the user/);
  assert.equal(sends(h.fake, 'personal').length, 0);
});

test('ask: a client that cannot ask gets a refusal with the one-call draft path', async (t) => {
  const h = await startMulti(); // no elicitation capability
  t.after(h.close);
  const r = await h.call('send_message', { account: 'personal', ...MSG });
  assert.equal(r.isError, true);
  assert.equal(r.body.account, 'personal');
  assert.match(r.body.reason, /Not sent\. Sending from "personal" needs the user's approval and this client cannot ask for it\./);
  assert.match(r.body.reason, /Call create_draft with the same arguments \(account "personal"\)/);
  assert.equal(sends(h.fake, 'personal').length, 0);
  assert.equal(h.fake.calls.filter((c) => c.method === 'drafts.create').length, 0, 'no draft is created automatically');
});

test('ask: a client whose elicitation request errors is treated as unable to ask', async (t) => {
  const h = await startMulti({ elicit: () => { throw new Error('boom'); } });
  t.after(h.close);
  const r = await h.call('send_message', { account: 'personal', ...MSG });
  assert.match(r.body.reason, /cannot ask for it/);
  assert.equal(sends(h.fake, 'personal').length, 0);
});

test('ask on send_draft: the dialog shows the draft\'s real headers; refusal leaves the draft', async (t) => {
  const mailboxes = {
    personal: { email: 'owner@example.com', drafts: { d1: { id: 'd1', message: { id: 'm1', payload: draftPayload({ from: 'Owner <owner@example.com>', to: 'vendor@example.net', subject: 'Quote', text: 'Draft body.', attachment: 'plan.pdf' }) } } } },
    work: { email: 'owner@example.org' },
  };
  const h = await startMulti({ mailboxes, elicit: () => ({ action: 'decline' }) });
  t.after(h.close);
  const r = await h.call('send_draft', { account: 'personal', id: 'd1' });
  assert.match(r.body.reason, /^Not sent\. The user declined/);
  const msg = h.elicitations[0].message;
  assert.match(msg, /From: Owner <owner@example\.com>/);
  assert.match(msg, /To: vendor@example\.net/);
  assert.match(msg, /Subject: Quote/);
  assert.match(msg, /Parts \(2\): text\/plain; application\/pdf "plan\.pdf"/);
  assert.match(msg, /Draft body\./);
  assert.ok(h.fake.mailboxes.personal.drafts.d1, 'draft still there');
});

test('allow on send_draft: result carries the draft\'s From', async (t) => {
  const mailboxes = {
    personal: { email: 'owner@example.com' },
    work: { email: 'owner@example.org', drafts: { d2: { id: 'd2', message: { id: 'm2', payload: draftPayload({ from: 'Owner at Work <owner@example.org>', to: 'a@example.net', subject: 'S', text: 'B' }) } } } },
  };
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  const r = await h.call('send_draft', { account: 'work', id: 'd2' });
  assert.equal(r.isError, false);
  assert.equal(r.body.from, 'Owner at Work <owner@example.org>');
  assert.equal(sends(h.fake, 'work').length, 1);
});

test('cannot-ask on send_draft says the draft stays in Drafts', async (t) => {
  const mailboxes = {
    personal: { email: 'owner@example.com', drafts: { d1: { id: 'd1', message: { id: 'm1', payload: draftPayload({ from: 'o@example.com', to: 'v@example.net', subject: 'Q', text: 'B' }) } } } },
    work: { email: 'owner@example.org' },
  };
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  const r = await h.call('send_draft', { account: 'personal', id: 'd1' });
  assert.match(r.body.reason, /The draft stays in Drafts; the user can send it from Gmail\./);
});

test('block: refused before any Gmail call; send suggests a draft only if drafts are allowed', async (t) => {
  const h = await startMulti({ elicit: approve, accounts: {
    personal: { purpose: 'Main inbox.', permissions: { send: 'block' } },
    work: { purpose: 'Work inbox.', permissions: { send: 'block', draft: 'block' } },
  } });
  t.after(h.close);
  const p = await h.call('send_message', { account: 'personal', ...MSG });
  assert.match(p.body.reason, /Sending from "personal" is blocked by the user's settings for this account\. Call create_draft/);
  const w = await h.call('send_message', { account: 'work', ...MSG });
  assert.match(w.body.reason, /blocked.*The user can send it from Gmail directly\./);
  assert.equal(h.fake.calls.length, 0);
  assert.equal(h.elicitations.length, 0);
});

test('ask applies to other groups too: permanent delete (default ask) on a client that cannot ask', async (t) => {
  const h = await startMulti({ mailboxes: { personal: { email: 'o@example.com', messages: { x1: { id: 'x1' } } }, work: { email: 'w@example.org' } } });
  t.after(h.close);
  const r = await h.call('delete_message', { account: 'personal', id: 'x1' });
  assert.match(r.body.reason, /^Not run\. delete_message on "personal" needs the user's approval/);
  assert.ok(h.fake.mailboxes.personal.messages.x1, 'message not deleted');
});

test('ask on a non-send action: generic dialog with the arguments', async (t) => {
  const h = await startMulti({ elicit: approve });
  t.after(h.close);
  const r = await h.call('create_filter', { account: 'work', criteria: { from: 'news@example.net' }, action: { addLabelIds: ['TRASH'] } });
  assert.equal(r.isError, false);
  const req = h.elicitations[0];
  assert.match(req.message, /wants to run create_filter on the "work" account/);
  assert.match(req.message, /Changes where mail or replies go/);
  assert.match(req.message, /news@example\.net/);
  assert.equal(req.requestedSchema.properties.approve.title, 'Allow this action');
});

test('the generic ask dialog redacts secrets and binary data', async (t) => {
  const h = await startMulti({ elicit: () => ({ action: 'decline' }), accounts: {
    personal: { purpose: 'Main inbox.', permissions: { insert_smime: 'ask' } },
    work: { purpose: 'Work inbox.' },
  } });
  t.after(h.close);
  await h.call('insert_smime', { account: 'personal', sendAsEmail: 'owner@example.com', pkcs12: 'QUJD', encryptedKeyPassword: 'hunter2' });
  const msg = h.elicitations[0].message;
  assert.doesNotMatch(msg, /hunter2|QUJD/);
  assert.match(msg, /"encryptedKeyPassword":"\[redacted\]"/);
});

test('refusal text never points the model at the permission settings', async (t) => {
  const h = await startMulti({ accounts: {
    personal: { purpose: 'Main inbox.', permissions: { send: 'block', delete: 'block' } },
    work: { purpose: 'Work inbox.' },
  } });
  t.after(h.close);
  const texts = [
    (await h.call('send_message', { account: 'personal', ...MSG })).body.reason,
    (await h.call('delete_thread', { account: 'personal', id: 't' })).body.reason,
    (await h.call('send_message', { account: 'work', ...MSG })).body.reason,
    (await h.call('create_filter', { account: 'work', criteria: {}, action: {} })).body.reason,
  ];
  for (const text of texts) assert.doesNotMatch(text, /gmail-cli|permissions (set|clear)|accounts\.json/);
});

// ---------- permissions are live; the file fails closed ----------

test('a permission change takes effect on the next call and the client is told the list changed', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  await h.client.listTools();
  writeAccounts(h.configDir, {
    personal: { purpose: 'Main inbox.', permissions: { send: 'block' } },
    work: { purpose: 'Work inbox.', permissions: { send: 'allow' } },
  });
  const r = await h.call('send_message', { account: 'personal', ...MSG });
  assert.match(r.body.reason, /blocked/);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(h.listChanged.length, 1);
  const { tools } = await h.client.listTools();
  assert.deepEqual(tools.find((x) => x.name === 'send_message').inputSchema.properties.account.enum, ['work']);
});

test('an accounts file broken while running makes every call fail closed', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  fs.writeFileSync(path.join(h.configDir, 'accounts.json'), '{ broken');
  const r = await h.call('send_message', { account: 'work', ...MSG });
  assert.equal(r.isError, true);
  assert.match(r.body.error, /not valid JSON/);
  assert.equal(h.fake.calls.length, 0);
  await assert.rejects(h.client.listTools(), /not valid JSON/);
});

test('an invalid accounts file stops the multi-account server from being created', () => {
  const dir = tempDir();
  writeAccounts(dir, { personal: { purpose: 'x', permissions: { send: 'sometimes' } } });
  assert.throws(() => createMultiServer({ configDir: dir }), /"send" is "sometimes"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- list_accounts ----------

test('list_accounts reports labels, purposes, addresses and effective permissions', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  const r = await h.call('list_accounts', {});
  assert.equal(r.isError, false);
  const [p, w] = r.body.accounts;
  assert.deepEqual([p.label, p.address, p.purpose], ['personal', 'owner@example.com', 'Main inbox.']);
  assert.equal(p.permissions.groups.send, 'ask');
  assert.equal(p.permissions.groups.delete, 'ask');
  assert.equal(p.permissions.groups.read, 'allow');
  assert.equal(w.permissions.groups.send, 'allow');
  assert.equal(w.address, 'owner@example.org');
});

// ---------- cross-account ID hint (error text only) ----------

test('a not-found ID seen under another account gets a hint; unknown IDs pass untouched', async (t) => {
  const mailboxes = {
    personal: { email: 'o@example.com' },
    work: { email: 'w@example.org', messages: { w1: { id: 'w1', threadId: 'wt1' } } },
  };
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  await h.call('list_messages', { account: 'work' });
  const wrong = await h.call('get_message', { account: 'personal', id: 'w1' });
  assert.equal(wrong.isError, true);
  assert.equal(wrong.body.code, 404);
  assert.match(wrong.body.error, /Hint: ID w1 was returned by account "work" earlier in this session, not "personal"/);
  const unseen = await h.call('get_message', { account: 'personal', id: 'never-seen' });
  assert.equal(unseen.body.code, 404);
  assert.doesNotMatch(unseen.body.error, /Hint:/);
  const right = await h.call('get_message', { account: 'work', id: 'w1' });
  assert.equal(right.isError, false);
});

test('send_draft with another account\'s draft fails on the read, before anything is asked or sent', async (t) => {
  const mailboxes = {
    personal: { email: 'o@example.com' },
    work: { email: 'w@example.org', drafts: { d9: { id: 'd9', message: { id: 'm9', payload: draftPayload({ from: 'w@example.org', to: 'a@example.net', subject: 's', text: 'b' }) } } } },
  };
  const h = await startMulti({ mailboxes, elicit: approve });
  t.after(h.close);
  const r = await h.call('send_draft', { account: 'personal', id: 'd9' });
  assert.equal(r.isError, true);
  assert.equal(r.body.code, 404);
  assert.equal(h.elicitations.length, 0);
  assert.equal(sends(h.fake, 'personal').length + sends(h.fake, 'work').length, 0);
});
