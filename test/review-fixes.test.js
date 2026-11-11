// One or more tests per finding of the first review round (numbers match the
// review). Each fails against the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMulti, writeAccounts, tempDir, DEFAULT_MAILBOXES } from '../testkit/harness.js';
import { draftPayload, b64urlDecode } from '../testkit/fake-gmail.js';
import { createLegacyServer } from '../lib/server.js';
import { setGmailClientFactory } from '../lib/gmail.js';
import {
  parseAccounts, resolvePermission, accountsFileExists, saveAccounts, loadAccounts, setPermission,
} from '../lib/accounts.js';
import { approvalMessage, describeOutgoing, outgoingFromDraft } from '../lib/approval.js';

const MSG = { to: 'friend@example.net', subject: 'Hello', text: 'A short note.' };
const approve = () => ({ action: 'accept', content: { approve: true } });
const sentRaw = (h, label) => (h.fake.mailboxes[label].sent || []).map((s) => (s.raw ? b64urlDecode(s.raw) : s));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function permissiveAccountsJson() {
  return JSON.stringify({ version: 1, accounts: {
    personal: { purpose: 'Main inbox.', permissions: { send: 'allow' } },
    work: { purpose: 'Work inbox.', permissions: { send: 'allow' } },
  } });
}

// ---------- 1. blocker: files ----------

test('1: get_attachment cannot overwrite accounts.json, and the next send still needs approval', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.attachmentData = b64(permissiveAccountsJson());
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  const file = path.join(h.configDir, 'accounts.json');
  const before = fs.readFileSync(file, 'utf8');
  const w = await h.call('get_attachment', { account: 'work', messageId: 'm1', attachmentId: 'a1', savePath: file });
  assert.equal(w.isError, true);
  assert.match(w.body.error, /inside gmail-max's own configuration/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(h.fake.calls.filter((c) => c.method === 'attachments.get').length, 0, 'refused before fetching');
  const send = await h.call('send_message', { account: 'personal', ...MSG });
  assert.equal(send.body.refused, true);
  assert.equal(sentRaw(h, 'personal').length, 0);
});

test('1: savePath through a symlink into an account folder is refused; existing files are never overwritten', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.attachmentData = b64('hello');
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  const outside = tempDir('gmail-max-out-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const acctDir = path.join(h.configDir, 'accounts', 'work');
  fs.mkdirSync(acctDir, { recursive: true });
  fs.symlinkSync(acctDir, path.join(outside, 'innocent'));
  const viaLink = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: path.join(outside, 'innocent', 'token.json') });
  assert.match(viaLink.body.error, /inside gmail-max's own configuration/);
  assert.ok(!fs.existsSync(path.join(acctDir, 'token.json')));

  const existing = path.join(outside, 'notes.txt');
  fs.writeFileSync(existing, 'keep me');
  const over = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: existing });
  assert.match(over.body.error, /already exists/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep me');

  const fresh = path.join(outside, 'new.txt');
  const ok = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: fresh });
  assert.equal(ok.isError, false);
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'hello');
});

test('1: an attachment path inside the config or an account folder is refused before any dialog', async (t) => {
  const h = await startMulti({ elicit: approve, accounts: {
    personal: { purpose: 'Main inbox.', permissions: { send: 'ask' } },
    work: { purpose: 'Work inbox.', permissions: { send: 'allow' } },
  } });
  t.after(h.close);
  const tokenDir = path.join(h.configDir, 'accounts', 'personal');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'token.json'), '{"refresh_token":"secret"}');
  const outside = tempDir('gmail-max-out-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(path.join(tokenDir, 'token.json'), path.join(outside, 'menu.pdf'));

  for (const [account, p] of [['personal', path.join(tokenDir, 'token.json')], ['work', path.join(outside, 'menu.pdf')], ['work', path.join(h.configDir, 'accounts.json')]]) {
    const r = await h.call('send_message', { account, ...MSG, attachments: [{ path: p, filename: 'menu.pdf' }] });
    assert.equal(r.isError, true, p);
    assert.match(r.body.error, /inside gmail-max's own configuration/);
  }
  const draft = await h.call('create_draft', { account: 'work', ...MSG, inlineImages: [{ path: path.join(tokenDir, 'token.json'), cid: 'x' }] });
  assert.match(draft.body.error, /inside gmail-max's own configuration/);
  assert.equal(h.elicitations.length, 0);
  assert.equal(sentRaw(h, 'personal').length + sentRaw(h, 'work').length, 0);
});

// ---------- 2. the dialog shows what is sent ----------

test('2: every header, attachment source and both bodies in the raw MIME appear in the dialog', async (t) => {
  const h = await startMulti({ elicit: approve });
  t.after(h.close);
  const outside = tempDir('gmail-max-att-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const att = path.join(outside, 'report.pdf');
  fs.writeFileSync(att, 'PDFDATA');
  const r = await h.call('send_message', {
    account: 'personal',
    to: ['a@example.net', { name: 'B', email: 'b@example.net' }],
    cc: 'c@example.net',
    bcc: 'd@example.net',
    replyTo: 'reply@example.net',
    subject: 'Lunch',
    text: 'See you at noon.',
    html: '<p>WIRE 5000 TO ACCOUNT 12345</p>',
    inReplyTo: '<parent@example.net>',
    references: ['<root@example.net>', '<parent@example.net>'],
    headers: { 'X-Campaign': 'spring' },
    attachments: [{ path: att, filename: 'menu.pdf' }],
  });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const dialog = h.elicitations[0].message;
  const raw = sentRaw(h, 'personal')[0];
  const headerBlock = raw.split('\r\n\r\n')[0];
  for (const line of headerBlock.split('\r\n')) {
    const [name, ...rest] = line.split(': ');
    if (['MIME-Version', 'Content-Type'].includes(name)) continue;
    assert.ok(dialog.includes(`${name}: ${rest.join(': ')}`), `dialog is missing header line "${line}"`);
  }
  assert.match(dialog, /WIRE 5000 TO ACCOUNT 12345/, 'the HTML the recipient sees');
  assert.match(dialog, /plain-text version differs/);
  assert.match(dialog, /See you at noon\./);
  assert.ok(dialog.includes(`menu.pdf (read from ${att}, 7 bytes)`));
  assert.match(raw, /filename="menu\.pdf"/);
});

test('2: line breaks in header fields, reserved headers and quoted filenames are refused before any dialog', async (t) => {
  const h = await startMulti({ elicit: approve });
  t.after(h.close);
  const bad = [
    { inReplyTo: '<a@b>\r\nBcc: crlf@example.net' },
    { references: ['<a@b>', 'x\nBcc: y@example.net'] },
    { to: 'friend@example.net\r\nBcc: x@example.net' },
    { replyTo: { name: 'R', email: 'r@example.net\nBcc: x@example.net' } },
    { headers: { Bcc: 'hidden@example.net' } },
    { headers: { cc: 'hidden@example.net' } },
    { headers: { 'Reply-To': 'x@example.net' } },
    { headers: { Sender: 'x@example.net' } },
    { headers: { 'X-Ok': 'line\r\nBcc: x@example.net' } },
    { headers: { 'Bad Name': 'v' } },
    { attachments: [{ filename: 'a"; name="b.exe', contentBase64: 'AA==' }] },
  ];
  for (const extra of bad) {
    const r = await h.call('send_message', { account: 'personal', ...MSG, ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.body.error, /^Refused:/, JSON.stringify(extra));
  }
  assert.equal(h.elicitations.length, 0);
  assert.equal(sentRaw(h, 'personal').length, 0);
});

test('2: draft dialog keeps duplicate headers, shows Reply-To, and prefers the HTML the recipient sees', () => {
  const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const draft = { id: 'd', message: { id: 'm', payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'To', value: 'attacker@example.net' },
      { name: 'Reply-To', value: 'attacker-reply@example.net' },
      { name: 'Subject', value: 'Lunch' },
      { name: 'To', value: 'friend@example.com' },
      { name: 'Content-Type', value: 'multipart/alternative' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('See you at noon.') } },
      { mimeType: 'text/html', body: { data: b64url('<p>WIRE 5000 TO ACCOUNT 12345</p>') } },
    ],
  } } };
  const text = describeOutgoing(outgoingFromDraft(draft));
  assert.match(text, /To: attacker@example\.net {3}\[this header appears 2 times\]/);
  assert.match(text, /To: friend@example\.com {3}\[this header appears 2 times\]/);
  assert.match(text, /Reply-To: attacker-reply@example\.net/);
  assert.match(text, /Body \(HTML, what most mail apps show\)[\s\S]*WIRE 5000/);
  assert.match(text, /plain-text version differs/);
});

// ---------- 3. send_draft sends what was approved ----------

test('3: a draft changed while the dialog is open is not sent', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.personal.drafts = { d1: { id: 'd1', message: { id: 'm-d1', payload: draftPayload({ from: 'owner@example.com', to: 'friend@example.net', subject: 'Lunch', text: 'See you at noon.' }) } } };
  let h;
  h = await startMulti({
    mailboxes,
    elicit: async () => {
      const u = await h.call('update_draft', { account: 'personal', id: 'd1', to: 'attacker@example.net', subject: 'Changed', text: 'changed' });
      assert.equal(u.isError, false);
      return { action: 'accept', content: { approve: true } };
    },
  });
  t.after(h.close);
  const r = await h.call('send_draft', { account: 'personal', id: 'd1' });
  assert.equal(r.isError, true);
  assert.match(r.body.reason, /draft changed while the user was deciding/);
  assert.equal(h.fake.calls.filter((c) => c.method === 'drafts.send').length, 0);
});

test('3: an unchanged draft is sent after approval', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.personal.drafts = { d1: { id: 'd1', message: { id: 'm-d1', payload: draftPayload({ from: 'owner@example.com', to: 'friend@example.net', subject: 'Lunch', text: 'Noon.' }) } } };
  const h = await startMulti({ mailboxes, elicit: approve });
  t.after(h.close);
  const r = await h.call('send_draft', { account: 'personal', id: 'd1' });
  assert.equal(r.isError, false);
  assert.equal(h.fake.calls.filter((c) => c.method === 'drafts.send').length, 1);
});

// ---------- 4. an abandoned call never acts ----------

test('4: if the client gives up on the call, a later accept sends nothing', async (t) => {
  const h = await startMulti({ elicit: async () => { await sleep(300); return { action: 'accept', content: { approve: true } }; } });
  t.after(h.close);
  await assert.rejects(
    h.client.callTool({ name: 'send_message', arguments: { account: 'personal', ...MSG } }, undefined, { timeout: 100 }),
    /timed out/i,
  );
  await sleep(500);
  assert.equal(sentRaw(h, 'personal').length, 0);
});

// ---------- 5. generic dialogs put the deciding fields first ----------

test('5: deciding fields survive long arguments, and lists are counted', () => {
  const sig = approvalMessage({ tool: 'update_send_as', label: 'personal', args: {
    sendAsEmail: 'owner@example.com', signature: `<div>${'Best regards. '.repeat(100)}</div>`, replyToAddress: 'attacker@example.net',
  } });
  assert.match(sig, /replyToAddress: "attacker@example\.net"/);
  const filter = approvalMessage({ tool: 'create_filter', label: 'personal', args: {
    criteria: { query: `newsletter OR ${'promo OR '.repeat(70)}digest` }, action: { forward: 'attacker@example.net', removeLabelIds: ['INBOX'] },
  } });
  assert.match(filter, /action: \{"forward":"attacker@example\.net","removeLabelIds":\["INBOX"\]\}/);
  const del = approvalMessage({ tool: 'batch_delete_messages', label: 'personal', args: {
    ids: Array.from({ length: 1000 }, (_, i) => `id${i}`),
  } });
  assert.match(del, /ids: 1000 items/);
  assert.match(del, /characters in total/);
});

// ---------- 7. odd names ----------

test('7: "constructor", "toString" and "__proto__" are not tools, groups or permission keys', async (t) => {
  for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => parseAccounts({ accounts: { personal: { purpose: 'x', permissions: { [key]: 'allow' } } } }), /neither a permission group/);
  }
  assert.throws(() => parseAccounts(JSON.parse('{"accounts":{"personal":{"purpose":"x","permissions":{"__proto__":"allow"}}}}')), /neither a permission group/);
  assert.equal(resolvePermission({ permissions: {} }, 'constructor'), 'ask');
  assert.equal(resolvePermission({ permissions: {} }, '__proto__'), 'ask');
  assert.throws(() => setPermission(parseAccounts({ accounts: { personal: { purpose: 'x' } } }), 'personal', 'constructor', 'allow'), /neither a permission group/);

  const h = await startMulti();
  t.after(h.close);
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await h.call(name, { account: 'work' });
    assert.equal(r.isError, true);
    assert.equal(r.body, `Unknown tool: ${name}`);
  }
});

test('7: a tool runs only on an explicit allow, even if a permission value is somehow not a state', () => {
  const acct = { label: 'x', permissions: { send_message: 'yes', send: 'allow' } };
  assert.equal(resolvePermission(acct, 'send_message'), 'allow', 'an invalid tool value falls through to the group');
  assert.equal(resolvePermission({ label: 'x', permissions: { send: 'sure' } }, 'send_message'), 'ask', 'and an invalid group value to the default');
});

// ---------- 8. one folder, two labels ----------

test('8: two labels cannot share a folder through a symlink or a case variant', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.throws(() => parseAccounts({ accounts: { a: { purpose: 'x', dir: 'real' }, b: { purpose: 'y', dir: 'link' } } }, { configDir: dir }), /same folder/);
  assert.throws(() => parseAccounts({ accounts: { a: { purpose: 'x', dir: 'real' }, b: { purpose: 'y', dir: 'REAL' } } }, { configDir: dir }), /same folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 9. accounts.json presence and symlinks ----------

test('9: a dangling symlink or a directory named accounts.json counts as present (fail closed)', () => {
  const dir = tempDir();
  fs.symlinkSync(path.join(dir, 'nowhere.json'), path.join(dir, 'accounts.json'));
  assert.equal(accountsFileExists(dir), true);
  assert.throws(() => loadAccounts(dir), /Cannot read the accounts file/);
  const dir2 = tempDir();
  fs.mkdirSync(path.join(dir2, 'accounts.json'));
  assert.equal(accountsFileExists(dir2), true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('9: saving keeps a symlinked accounts.json a symlink and updates its target', () => {
  const dir = tempDir();
  const target = path.join(dir, 'real-accounts.json');
  fs.writeFileSync(target, JSON.stringify({ accounts: { personal: { purpose: 'x' } } }));
  fs.symlinkSync(target, path.join(dir, 'accounts.json'));
  saveAccounts(dir, setPermission(loadAccounts(dir), 'personal', 'send', 'block'));
  assert.equal(fs.lstatSync(path.join(dir, 'accounts.json')).isSymbolicLink(), true);
  assert.match(fs.readFileSync(target, 'utf8'), /"send": "block"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 10. non-string account ----------

test('10: a non-string account value is a refusal, not a protocol error', async (t) => {
  const h = await startMulti();
  t.after(h.close);
  for (const account of [['personal'], { toString: 'personal' }, 0, true]) {
    const r = await h.call('send_message', { account, ...MSG });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /account must be a string label/);
  }
  assert.equal(h.fake.calls.length, 0);
});

// ---------- 11. address follows the folder ----------

test('11: re-pointing a label at another folder changes the address shown', async (t) => {
  const mailboxes = { ...DEFAULT_MAILBOXES(), other: { email: 'someone-else@example.org' } };
  const h = await startMulti({ mailboxes, fakeOptions: { mailboxFor: (a) => (a.dir.endsWith('elsewhere') ? 'other' : a.label) } });
  t.after(h.close);
  assert.equal((await h.call('list_labels', { account: 'work' })).body.address, 'owner@example.org');
  writeAccounts(h.configDir, {
    personal: { purpose: 'Main inbox.', permissions: { send: 'ask' } },
    work: { purpose: 'Work inbox.', dir: 'elsewhere', permissions: { send: 'allow' } },
  });
  assert.equal((await h.call('list_labels', { account: 'work' })).body.address, 'someone-else@example.org');
});

// ---------- 13. list_accounts respects a read block ----------

test('13: list_accounts does not read the profile of an account whose read is blocked', async (t) => {
  const h = await startMulti({ accounts: {
    personal: { purpose: 'Main inbox.', permissions: { read: 'block' } },
    work: { purpose: 'Work inbox.' },
  } });
  t.after(h.close);
  const r = await h.call('list_accounts', {});
  assert.equal(r.body.accounts[0].address, null);
  assert.equal(r.body.accounts[1].address, 'owner@example.org');
  assert.equal(h.fake.calls.filter((c) => c.account === 'personal').length, 0);
});

// ---------- 14. cancel and timeout get the draft path ----------

test('14: cancel and timeout on a send give the leave-a-draft path', async (t) => {
  const c = await startMulti({ elicit: () => ({ action: 'cancel' }) });
  t.after(c.close);
  const r1 = await c.call('send_message', { account: 'personal', ...MSG });
  assert.match(r1.body.reason, /No answer from the user\. Call create_draft with the same arguments \(account "personal"\)/);
  const tm = await startMulti({ elicit: () => new Promise(() => {}), askTimeoutMs: 50 });
  t.after(tm.close);
  const r2 = await tm.call('send_message', { account: 'personal', ...MSG });
  assert.match(r2.body.reason, /No answer from the user\. Call create_draft/);
});

// ---------- missing tests from the review ----------

test('strict accept: only approve === true approves', async () => {
  // Dynamic import so the rest of this file still loads against older code.
  const { interpretAnswer } = await import('../lib/approval.js');
  assert.equal(typeof interpretAnswer, 'function');
  assert.deepEqual(interpretAnswer({ action: 'accept', content: { approve: true } }), { approved: true });
  for (const res of [
    { action: 'accept', content: { approve: 'true' } }, { action: 'accept', content: { approve: 1 } },
    { action: 'accept', content: { approve: ['true'] } }, { action: 'accept', content: {} }, { action: 'accept' },
    { action: 'accept', content: null }, { action: 'ACCEPT', content: { approve: true } }, { content: { approve: true } },
    {}, null, 'accept',
  ]) {
    assert.equal(interpretAnswer(res).approved, false, JSON.stringify(res));
  }
  assert.equal(interpretAnswer({ action: 'decline' }).reason, 'declined');
  assert.equal(interpretAnswer({ action: 'cancel' }).reason, 'no-answer');
});

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

test('concurrency: 200 interleaved calls across two accounts never cross accounts', async (t) => {
  const h = await startMulti({
    accounts: { personal: { purpose: 'a', permissions: { send: 'allow' } }, work: { purpose: 'b', permissions: { send: 'allow' } } },
    fakeOptions: { jitter: true },
  });
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
  for (const label of ['personal', 'work']) {
    for (const raw of sentRaw(h, label)) assert.match(raw, new RegExp(`Subject: s-${label}-`));
  }
  for (const c of h.fake.calls.filter((x) => x.method === 'drafts.create')) {
    assert.match(b64urlDecode(c.params.requestBody.message.raw), new RegExp(`Subject: s-${c.account}-`));
  }
});
