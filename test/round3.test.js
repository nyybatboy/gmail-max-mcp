// Tests for the third review pass (S1, M1, M2, M3, M5). Each fails against the
// code before these fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMulti, tempDir, DEFAULT_MAILBOXES } from '../testkit/harness.js';
import { setGmailClientFactory } from '../lib/gmail.js';
import * as Guard from '../lib/fs-guard.js';
import { loadAccounts, accountsFilePath } from '../lib/accounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const MSG = { to: 'x@example.net', subject: 's', text: 't' };
const ABC = { a: { purpose: 'x' }, b: { purpose: 'y' }, c: { purpose: 'z' } };
const ABC_MAIL = { a: { email: 'a@example.com' }, b: { email: 'b@example.com' }, c: { email: 'c@example.com' } };

// ---------- S1: overlapping set_permission calls ----------

for (const [title, calls] of [
  ['two accounts, same group', [['a', 'send'], ['b', 'send']]],
  ['one account, two groups', [['a', 'send'], ['a', 'delete']]],
  ['five changes at once', [['a', 'send'], ['b', 'send'], ['c', 'send'], ['a', 'delete'], ['b', 'routing']]],
]) {
  test(`S1: overlapping set_permission calls all stick (${title})`, async (t) => {
    const h = await startMulti({ accounts: ABC, mailboxes: ABC_MAIL });
    t.after(h.close);
    await h.client.listTools(); // like a real client, so each call also awaits the list-changed check
    const rs = await Promise.all(calls.map(([account, what]) => h.call('set_permission', { account, what, state: 'off' })));
    assert.ok(rs.every((r) => !r.isError));
    const saved = loadAccounts(h.configDir);
    for (const [account, what] of calls) {
      assert.equal(saved.accounts.find((x) => x.label === account).permissions[what], 'off', `${account}.${what} was lost`);
    }
    const send = await h.call('send_message', { account: 'a', ...MSG });
    assert.equal(send.body.refused, true, 'a send on "a" must be refused');
  });
}

test('S1: a change made by another process between read and save is kept, not overwritten', async (t) => {
  const h = await startMulti({ accounts: ABC, mailboxes: ABC_MAIL });
  t.after(h.close);
  const file = accountsFilePath(h.configDir);
  // Stand in for the CLI writing while the server is mid-change: the first
  // time the server reads the file for its change, the "other process" saves.
  const realRead = fs.readFileSync;
  let fired = false;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    const out = realRead.call(fs, p, ...rest);
    if (!fired && p === file && new Error().stack.includes('updateAccounts')) {
      fired = true;
      const other = JSON.parse(out);
      other.accounts.b.permissions = { delete: 'off' };
      fs.writeFileSync(file, JSON.stringify(other));
    }
    return out;
  });
  const r = await h.call('set_permission', { account: 'a', what: 'send', state: 'off' });
  t.mock.restoreAll();
  assert.equal(r.isError, false);
  assert.ok(fired);
  const saved = loadAccounts(h.configDir);
  assert.deepEqual(saved.accounts.find((x) => x.label === 'a').permissions, { send: 'off' });
  assert.deepEqual(saved.accounts.find((x) => x.label === 'b').permissions, { delete: 'off' }, 'the other writer\'s change survives');
  assert.deepEqual(fs.readdirSync(h.configDir).filter((f) => f.endsWith('.tmp')), [], 'no stray temp files');
});

// ---------- M1, M2: the guard's path resolution ----------

async function guardSetup(t) {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.personal.attachmentData = b64('PLANTED');
  const h = await startMulti({ accounts: { personal: { purpose: 'x' }, work: { purpose: 'y' }, fresh: { purpose: 'z' } }, mailboxes: { ...mailboxes, fresh: { email: 'f@example.com' } } });
  t.after(h.close);
  const cfg = fs.realpathSync(h.configDir);
  fs.mkdirSync(path.join(cfg, 'accounts', 'fresh'), { recursive: true });
  const play = fs.realpathSync(tempDir('gmail-max-play-'));
  t.after(() => fs.rmSync(play, { recursive: true, force: true }));
  const save = (savePath) => h.call('get_attachment', { account: 'personal', messageId: 'm', attachmentId: 'a', savePath });
  return { h, cfg, play, save, freshToken: path.join(cfg, 'accounts', 'fresh', 'token.json') };
}

test('M1: a chain of links ending in a dangling link into an account folder is refused', async (t) => {
  const { play, save, freshToken } = await guardSetup(t);
  fs.symlinkSync(freshToken, path.join(play, 'dangling'));
  fs.symlinkSync(path.join(play, 'dangling'), path.join(play, 'chain'));
  fs.symlinkSync('chain', path.join(play, 'chain-rel'));
  for (const p of ['chain', 'chain-rel']) {
    const r = await save(path.join(play, p));
    assert.match(r.body.error, /inside gmail-max's own configuration/, p);
  }
  assert.ok(!fs.existsSync(freshToken), 'no token planted');
});

test('M1: a symlink loop is refused, not followed forever', () => {
  const play = tempDir();
  fs.symlinkSync(path.join(play, 'b'), path.join(play, 'a'));
  fs.symlinkSync(path.join(play, 'a'), path.join(play, 'b'));
  assert.throws(() => Guard.canonicalPath(path.join(play, 'a')), /too many symbolic links/);
  fs.rmSync(play, { recursive: true, force: true });
});

test('M2: a backslash is part of a file name on macOS and Linux, not a separator', { skip: path.sep === '\\' }, async (t) => {
  const { cfg, play, save } = await guardSetup(t);
  const inside = `${path.join(cfg, 'accounts', 'fresh')}/a\\..\\..\\..\\..\\out`;
  const r = await save(inside);
  assert.match(r.body.error, /inside gmail-max's own configuration/);
  assert.deepEqual(fs.readdirSync(path.join(cfg, 'accounts', 'fresh')), []);
  const outside = await save(`${play}/a\\b.txt`);
  assert.equal(outside.isError, false);
  assert.ok(fs.existsSync(path.join(play, 'a\\b.txt')), 'the literal name is created where asked');
});

// ---------- M3: the path changes while waiting on Gmail ----------

test('M3: a folder swapped for a link to an account folder during the fetch is refused at write time', async (t) => {
  const { h, play, save, freshToken } = await guardSetup(t);
  const victim = path.join(play, 'swap');
  fs.mkdirSync(victim);
  const base = h.fake.factory;
  setGmailClientFactory((account) => {
    const c = base(account);
    const get = c.users.messages.attachments.get;
    c.users.messages.attachments.get = async (p) => {
      fs.rmdirSync(victim);
      fs.symlinkSync(path.dirname(freshToken), victim);
      return get(p);
    };
    return c;
  });
  const r = await save(path.join(victim, 'token.json'));
  assert.equal(r.isError, true);
  assert.match(r.body.error, /inside gmail-max's own configuration/);
  assert.ok(!fs.existsSync(freshToken));
});

// ---------- M5 ----------

test('M5: the package description speaks of on/off switches, not allow/ask/block', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.match(pkg.description, /on\/off switches/);
  assert.doesNotMatch(pkg.description, /allow|ask|block/);
});
