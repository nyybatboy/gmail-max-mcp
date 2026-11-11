// Tests for the second review round (S1, S2, M1-M5), numbered as in the review.
// Each fails against the code before the round-2 fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMulti, writeAccounts, tempDir, DEFAULT_MAILBOXES, DEFAULT_ACCOUNTS } from '../testkit/harness.js';
import { draftPayload } from '../testkit/fake-gmail.js';
import * as Guard from '../lib/fs-guard.js';
import { parseAccounts, loadAccounts } from '../lib/accounts.js';
import * as Approval from '../lib/approval.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(here, '..');
const CLI = path.join(PACKAGE, 'bin', 'gmail-cli.js');
const accept = () => ({ action: 'accept', content: { approve: true } });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

async function dialogFor(t, args) {
  const h = await startMulti({ elicit: accept });
  t.after(h.close);
  const r = await h.call('send_message', { account: 'personal', to: 'friend@example.net', subject: 'Lunch', ...args });
  return { r, shown: h.elicitations[0]?.message ?? null, h };
}

// ---------- S1: the HTML preview ----------

for (const [name, html] of [
  ['"< text >" is text, not a tag', '<p>See you at noon.</p>< WIRE 5000 TO ACCOUNT 12345 TODAY >'],
  ['"<1 text>" is text, not a tag', '<p>See you at noon.</p><1 WIRE 5000 TO ACCOUNT 12345>'],
  ['"</style >" closes the style block', '<p>See you at noon.</p><style>x</style >WIRE 5000 TO ACCOUNT 12345<style></style>'],
  ['numeric entities are decoded', '<p>See you at noon.</p><p>&#87;&#x49;&#82;&#69; 5000 TO ACCOUNT 12345</p>'],
]) {
  test(`S1: ${name}`, async (t) => {
    const { shown } = await dialogFor(t, { html });
    const body = shown.slice(shown.indexOf('Body ('));
    assert.match(body, /WIRE 5000 TO ACCOUNT 12345/);
  });
}

test('S1: every link target and remote resource is listed under the body', async (t) => {
  const { shown } = await dialogFor(t, { html: [
    '<p>See you at noon. <a href="https://evil.example.net/login">Confirm here</a></p>',
    '<img src="https://evil.example.net/wire.png">',
    '<img srcset="https://evil.example.net/a.png 2x">',
    '<table background="https://evil.example.net/bg.png"><tr><td style="background:url(\'https://evil.example.net/css.png\')">x</td></tr></table>',
  ].join('') });
  assert.match(shown, /Links and remote content \(5\):/);
  for (const u of ['a href: https://evil.example.net/login', 'img src: https://evil.example.net/wire.png', 'img srcset: https://evil.example.net/a.png 2x',
    'table background: https://evil.example.net/bg.png', 'css url: https://evil.example.net/css.png']) {
    assert.ok(shown.includes(u), u);
  }
});

test('the body preview shows an ordinary message whole and says how much of a very long one is cut', async (t) => {
  const tail = 'PAY 12345 TODAY';
  const ordinary = await dialogFor(t, { html: `<p>${'word '.repeat(300)}</p><p>${tail}</p>` });
  assert.ok(ordinary.shown.includes(tail), 'text after character 500 is shown');
  assert.doesNotMatch(ordinary.shown, /more characters are not shown/);
  const huge = await dialogFor(t, { html: `<p>${'word '.repeat(2000)}</p><p>${tail}</p>` });
  assert.match(huge.shown, /\[\d+ more characters are not shown\]/);
});

test('S1: unusual HTML also shows the source; CSS that can hide text is flagged', async (t) => {
  const unterminated = await dialogFor(t, { html: '<p>See you at noon.</p><style>p{} WIRE 5000 TO ACCOUNT 12345' });
  assert.match(unterminated.shown, /WARNING: unusual HTML \(an unterminated <style>\)/);
  assert.match(unterminated.shown, /HTML source, \d+ characters:\n.*WIRE 5000/);
  const comment = await dialogFor(t, { html: '<p>Noon.</p><!-- WIRE 5000' });
  assert.match(comment.shown, /an unterminated comment/);
  const hidden = await dialogFor(t, { html: '<p>Noon.</p><span style="display:none">WIRE 5000</span>' });
  assert.match(hidden.shown, /styles that can hide text/);
  assert.match(hidden.shown, /WIRE 5000/);
});

test('S1: each attachment and inline image shows its content type', async (t) => {
  const { shown } = await dialogFor(t, {
    html: '<p>Noon. <img src="cid:logo"></p>',
    inlineImages: [{ contentBase64: b64('PNG'), filename: 'logo.png', mimeType: 'image/png', cid: 'logo' }],
    attachments: [{ contentBase64: b64('PDF'), filename: 'menu.pdf', mimeType: 'application/pdf' }],
  });
  assert.match(shown, /Inline images \(1\): logo\.png \(image\/png, supplied inline, 3 bytes\)/);
  assert.match(shown, /Attachments \(1\): menu\.pdf \(application\/pdf, supplied inline, 3 bytes\)/);
});

test('S1: inline images must be images; types must be plain; content must be base64', async (t) => {
  const h = await startMulti({ elicit: accept });
  t.after(h.close);
  const base = { account: 'personal', to: 'f@example.net', subject: 's', html: '<p>x</p>' };
  const bad = [
    [{ inlineImages: [{ contentBase64: b64('<h1>WIRE</h1>'), filename: 'logo.png', mimeType: 'text/html', cid: 'logo' }] }, /inline images must be images/],
    [{ inlineImages: [{ contentBase64: b64('x'), filename: 'logo.png', cid: 'logo' }] }, /inline images must be images.*application\/octet-stream/],
    [{ attachments: [{ contentBase64: 'AAAA', filename: 'a.bin', mimeType: 'multipart/mixed; boundary=guess' }] }, /plain type\/subtype/],
    [{ attachments: [{ contentBase64: 'AAAA', filename: 'a.bin', mimeType: 'message/rfc822' }] }, /plain type\/subtype/],
    [{ attachments: [{ contentBase64: 'AAAA\r\n--guess\r\nContent-Type: text/html\r\n\r\n<b>x</b>', filename: 'a.bin' }] }, /must be base64/],
  ];
  for (const [extra, re] of bad) {
    const r = await h.call('send_message', { ...base, ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.body.error, re);
  }
  assert.equal(h.elicitations.length, 0);
});

test('S1: a draft with two HTML parts shows both, and every part with its type', () => {
  const draft = { id: 'd', message: { id: 'm', payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'To', value: 'f@example.net' }, { name: 'Subject', value: 'S' }],
    parts: [
      { mimeType: 'text/html', body: { data: b64url('<p>See you at noon.</p>') } },
      { mimeType: 'text/html', body: { data: b64url('<p>WIRE 5000 TO ACCOUNT 12345</p>') } },
      { mimeType: 'application/pdf', filename: 'menu.pdf', body: { attachmentId: 'a', size: 9 } },
    ],
  } } };
  const text = Approval.describeOutgoing(Approval.outgoingFromDraft(draft));
  assert.match(text, /See you at noon\.[\s\S]*WIRE 5000/);
  assert.match(text, /Parts \(3\): text\/html; text\/html; application\/pdf "menu\.pdf", 9 bytes/);
});

test('S1: address shapes the wire would render differently are refused', async (t) => {
  const h = await startMulti({ elicit: accept });
  t.after(h.close);
  for (const extra of [{ bcc: [['hidden@example.net']] }, { to: [{ email: ['f@example.net', 'hidden@example.net'] }] }, { replyTo: ['a@example.net'] }, { subject: ['s'] }]) {
    const r = await h.call('send_message', { account: 'personal', to: 'f@example.net', subject: 's', text: 't', ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.body.error, /^Refused:/);
  }
});

// ---------- S2: saves are confined to save folders ----------

test('S2: files that run later cannot be created outside the save folders', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.attachmentData = b64('echo pwned');
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  const home = tempDir('gmail-max-home-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'project', '.claude'), { recursive: true });
  for (const p of [
    path.join(home, '.zshenv'),
    path.join(home, 'Library', 'LaunchAgents', 'x.plist'),
    path.join(home, 'project', '.claude', 'settings.local.json'),
    path.join(home, 'project', '.mcp.json'),
  ]) {
    const r = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: p });
    assert.match(r.body.error, /outside the save folders/, p);
    assert.ok(!fs.existsSync(p), p);
  }
  assert.equal(h.fake.calls.filter((c) => c.method === 'attachments.get').length, 0, 'refused before fetching');
});

test('S2: a relative savePath lands in the first save folder, which is created on first use', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.attachmentData = b64('hello');
  const root = tempDir('gmail-max-saves-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'not-yet');
  const second = path.join(root, 'second');
  fs.mkdirSync(second);
  const h = await startMulti({ mailboxes, saveFolders: [first, second] });
  t.after(h.close);
  const r = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: 'menu.pdf' });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  assert.equal(r.body.result.savedTo, path.join(first, 'menu.pdf'));
  assert.equal(fs.readFileSync(path.join(first, 'menu.pdf'), 'utf8'), 'hello');
  assert.equal(fs.statSync(first).mode & 0o777, 0o700);
  const abs = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: path.join(second, 'b.pdf') });
  assert.equal(abs.isError, false);
  const again = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: 'menu.pdf' });
  assert.match(again.body.error, /already exists/);
});

test('S2: the model is told the save folders; they are in list_accounts and the savePath schema', async (t) => {
  const folder = tempDir('gmail-max-saves-');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const h = await startMulti({ saveFolders: [folder] });
  t.after(h.close);
  const { tools } = await h.client.listTools();
  const desc = tools.find((x) => x.name === 'get_attachment').inputSchema.properties.savePath.description;
  assert.ok(desc.includes(folder));
  assert.match(desc, /A relative path is saved under/);
  assert.deepEqual((await h.call('list_accounts', {})).body.saveFolders, [folder]);
});

test('S2: saveFolders validation', () => {
  const acc = { personal: { purpose: 'x' } };
  assert.throws(() => parseAccounts({ saveFolders: ['relative/dir'], accounts: acc }), /absolute path or start with "~\/"/);
  assert.throws(() => parseAccounts({ saveFolders: ['/tmp/a/../b'], accounts: acc }), /must not contain ".."/);
  assert.throws(() => parseAccounts({ saveFolders: [], accounts: acc }), /non-empty list/);
  assert.throws(() => parseAccounts({ saveFolders: ['/a', '/a'], accounts: acc }), /same folder twice/);
  assert.deepEqual(parseAccounts({ saveFolders: ['~/Mail saves', '/srv/x'], accounts: acc }).saveFolders, ['~/Mail saves', '/srv/x']);
});

test('S2: default save folder is ~/Downloads/gmail-max; CLI save-folders manages the list and survives other edits', (t) => {
  const home = tempDir('gmail-max-home-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = path.join(home, 'cfg');
  const env = { PATH: process.env.PATH, HOME: home, GMAIL_MCP_CONFIG_DIR: cfg };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, input: '', encoding: 'utf8', timeout: 15000 });
    let out = r.stdout; let err = r.stderr;
    try { out = JSON.parse(r.stdout); } catch { /* raw */ }
    try { err = JSON.parse(r.stderr); } catch { /* raw */ }
    return { code: r.status, out, err, rawErr: r.stderr };
  };
  cli('accounts', 'add', 'work', '--purpose', 'Work.', '--no-auth');
  const def = path.join(home, 'Downloads', 'gmail-max');
  assert.deepEqual(cli('save-folders', 'list').out.saveFolders, [def]);

  // Default folder: a relative save passes the guard (and creates the folder);
  // with no token it then fails on authentication, proving it got that far.
  const rel = cli('get-attachment', '--account', 'work', '--message-id', 'm', '--attachment-id', 'a', '--save-path', 'menu.pdf');
  assert.match(rel.rawErr, /Not authenticated/);
  assert.ok(fs.existsSync(def));
  const zsh = cli('get-attachment', '--account', 'work', '--message-id', 'm', '--attachment-id', 'a', '--save-path', path.join(home, '.zshenv'));
  assert.match(zsh.err.error, /outside the save folders/);

  const extra = path.join(home, 'Mail');
  assert.equal(cli('save-folders', 'add', extra).code, 0);
  cli('permissions', 'set', 'work', 'send', 'allow');
  cli('accounts', 'add', 'personal', '--purpose', 'Main.', '--no-auth');
  assert.deepEqual(loadAccounts(cfg).saveFolders, [extra], 'other edits keep the save folders');
  assert.deepEqual(cli('save-folders', 'list').out.saveFolders, [extra]);
  assert.equal(cli('save-folders', 'remove', extra).code, 0);
  assert.deepEqual(cli('save-folders', 'list').out.saveFolders, [def], 'back to the default');
});

// ---------- M1: ".." segments ----------

test('M1: a path through a symlink and ".." is refused for writes and reads', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.attachmentData = b64('x');
  const play = tempDir('gmail-max-play-');
  t.after(() => fs.rmSync(play, { recursive: true, force: true }));
  const h = await startMulti({ mailboxes, saveFolders: [play] });
  t.after(h.close);
  for (const l of ['personal', 'work']) {
    fs.mkdirSync(path.join(h.configDir, 'accounts', l), { recursive: true });
    fs.writeFileSync(path.join(h.configDir, 'accounts', l, 'token.json'), `{"refresh_token":"MARK-${l}"}`);
  }
  fs.symlinkSync(path.join(h.configDir, 'accounts', 'work'), path.join(play, 'to-work'));
  const w = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: `${path.join(play, 'to-work')}/../../planted` });
  assert.match(w.body.error, /contains a "\.\." segment/);
  assert.ok(!fs.existsSync(path.join(h.configDir, 'planted')));
  const r = await h.call('create_draft', { account: 'work', to: 'x@example.net', subject: 's', text: 't', attachments: [{ path: `${path.join(play, 'to-work')}/../personal/token.json` }] });
  assert.match(r.body.error, /contains a "\.\." segment/);
  assert.throws(() => Guard.assertReadable('a/../b', Guard.protectedRoots(h.configDir, [])), /"\.\." segment/);
});

// ---------- M2: generic dialogs ----------

test('M2: smtpMsa and the whole vacation body are shown; other keys are named before truncation', () => {
  const sendAs = Approval.describeArgs('update_send_as', {
    sendAsEmail: 'o@example.com', signature: `<div>${'Best regards. '.repeat(60)}</div>`,
    smtpMsa: { host: 'smtp.evil.example.net', port: 587, username: 'u', password: 'p' },
  });
  assert.match(sendAs, /smtpMsa: \{"host":"smtp\.evil\.example\.net","port":587,"username":"u","password":"\[redacted\]"\}/);
  assert.match(sendAs, /Other argument keys: signature/);
  const vac = Approval.describeArgs('update_vacation', {
    enableAutoReply: true, responseSubject: 'Away',
    responseBodyHtml: `<p>${'I am away. '.repeat(60)}</p><p>Urgent? Wire the deposit to account 12345.</p>`,
  });
  assert.match(vac, /account 12345/);
});

// ---------- M3: the draft check hashes the whole message ----------

for (const [name, before, after] of (() => {
  const long = 'See you at noon. '.repeat(40);
  const mk = (html, extra = []) => ({ id: 'd1', message: { id: 'm-d1', payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'owner@example.com' }, { name: 'To', value: 'friend@example.net' }, { name: 'Subject', value: 'Lunch' }],
    parts: [{ mimeType: 'text/html', body: { data: b64url(html) } }, ...extra],
  } } });
  const att = (m) => ({ mimeType: 'application/pdf', filename: 'menu.pdf', body: { attachmentId: `att-${m}`, size: 1000 } });
  return [
    ['a changed link target', mk('<p>Hi <a href="https://good.example.com">Confirm</a></p>'), mk('<p>Hi <a href="https://evil.example.net">Confirm</a></p>')],
    ['text changed after character 500', mk(`<p>${long}</p><p>Pay 11111</p>`), mk(`<p>${long}</p><p>Pay 99999</p>`)],
    ['an attachment swapped for one of the same name and size', mk('<p>Hi</p>', [att('A')]), mk('<p>Hi</p>', [att('B')])],
  ];
})()) {
  test(`M3: a draft with ${name} (same message id) is not sent`, async (t) => {
    const mailboxes = DEFAULT_MAILBOXES();
    mailboxes.personal.drafts = { d1: before };
    let h;
    h = await startMulti({ mailboxes, elicit: async () => { h.fake.mailboxes.personal.drafts.d1 = after; return accept(); } });
    t.after(h.close);
    const r = await h.call('send_draft', { account: 'personal', id: 'd1' });
    assert.match(r.body.reason, /draft changed while the user was deciding/);
    assert.equal(h.fake.calls.filter((c) => c.method === 'drafts.send').length, 0);
  });
}

test('M3: the comparison uses the raw format, not the full payload', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.personal.drafts = { d1: { id: 'd1', message: { id: 'm', payload: draftPayload({ from: 'o@example.com', to: 'f@example.net', subject: 's', text: 'b' }) } } };
  const h = await startMulti({ mailboxes, elicit: accept });
  t.after(h.close);
  await h.call('send_draft', { account: 'personal', id: 'd1' });
  const formats = h.fake.calls.filter((c) => c.method === 'drafts.get').map((c) => c.params.format);
  assert.deepEqual(formats, ['full', 'raw', 'raw']);
});

// ---------- M4 / M5 ----------

test('M4: dependencies are out of reach even when node_modules is a symlink out of the package', async (t) => {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.attachmentData = b64('module.exports = 1');
  const h = await startMulti({ mailboxes });
  t.after(h.close);
  const target = path.join(PACKAGE, 'node_modules', '__review2_probe__.js');
  const r = await h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath: target });
  assert.match(r.body.error, /outside the save folders/);
  assert.ok(!fs.existsSync(target));
});

test('M5: a name starting with ".." is inside the folder', () => {
  const root = tempDir();
  assert.equal(Guard.inside(path.join(root, '..x'), root), true);
  assert.equal(Guard.inside(path.join(root, '..x', 'y'), root), true);
  assert.equal(Guard.inside(path.dirname(root), root), false);
  const roots = Guard.protectedRoots(root, []);
  assert.throws(() => Guard.assertWritable(path.join(root, '..x'), roots), /inside gmail-max's own configuration/);
  fs.rmSync(root, { recursive: true, force: true });
});
