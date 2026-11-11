// Credential guard in multi-account mode: tokens and client files are never
// attached, nothing is written into the config directory or an account folder,
// and everywhere else saves go where they are told and overwrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMulti, tempDir, DEFAULT_MAILBOXES } from '../testkit/harness.js';
import * as Guard from '../lib/fs-guard.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const ALL_ON = { personal: { purpose: 'Main inbox.' }, work: { purpose: 'Work inbox.' } };

async function setup(t, attachmentData = 'hello') {
  const mailboxes = DEFAULT_MAILBOXES();
  mailboxes.work.attachmentData = b64(attachmentData);
  const h = await startMulti({ accounts: ALL_ON, mailboxes });
  t.after(h.close);
  for (const l of ['personal', 'work']) {
    fs.mkdirSync(path.join(h.configDir, 'accounts', l), { recursive: true });
    fs.writeFileSync(path.join(h.configDir, 'accounts', l, 'token.json'), `{"refresh_token":"MARK-${l}"}`);
  }
  fs.writeFileSync(path.join(h.configDir, 'credentials.json'), '{"installed":{}}');
  const play = tempDir('gmail-max-play-');
  t.after(() => fs.rmSync(play, { recursive: true, force: true }));
  const save = (savePath) => h.call('get_attachment', { account: 'work', messageId: 'm', attachmentId: 'a', savePath });
  const attach = (p) => h.call('create_draft', { account: 'work', to: 'x@example.net', subject: 's', text: 't', attachments: [{ path: p, filename: 'notes.txt' }] });
  return { h, play, save, attach, cfg: h.configDir };
}

test('saves go where they are told and overwrite, as in single-account mode', async (t) => {
  const { play, save } = await setup(t);
  const target = path.join(play, 'project', 'invoice.pdf');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, 'old');
  const r = await save(target);
  assert.equal(r.isError, false, JSON.stringify(r.body));
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello', 'overwritten');
  const fresh = await save(path.join(play, 'project', 'new.pdf'));
  assert.equal(fresh.isError, false);
  // ".." in an ordinary project path is fine
  fs.mkdirSync(path.join(play, 'project', 'sub'));
  const up = await save(path.join(play, 'project', 'sub', '..', 'up.pdf'));
  assert.equal(up.isError, false);
  assert.equal(fs.readFileSync(path.join(play, 'project', 'up.pdf'), 'utf8'), 'hello');
});

test('nothing is ever written into the config directory or an account folder', async (t) => {
  const { play, save, cfg, h } = await setup(t, '{"refresh_token":"EVIL"}');
  fs.symlinkSync(cfg, path.join(play, 'to-config'));
  fs.symlinkSync(path.join(cfg, 'accounts', 'work'), path.join(play, 'to-work'));
  fs.symlinkSync(path.join(cfg, 'accounts', 'personal', 'token.json'), path.join(play, 'innocent.pdf'));
  fs.symlinkSync(path.join(cfg, 'accounts', 'fresh', 'token.json'), path.join(play, 'dangling.pdf'));
  const before = fs.readFileSync(path.join(cfg, 'accounts', 'personal', 'token.json'), 'utf8');
  for (const p of [
    path.join(cfg, 'accounts.json'),
    path.join(cfg, 'credentials.json'),
    path.join(cfg, 'accounts', 'personal', 'token.json'),
    path.join(cfg, 'accounts', 'work', 'new-file'),
    path.join(cfg, '..x'),
    path.join(cfg, 'accounts.json').toUpperCase(),
    path.join(play, 'to-config', 'accounts.json'),
    `${path.join(play, 'to-work')}/../../planted`,
    `${path.join(play, 'to-work')}/../personal/token.json`,
    path.join(play, 'innocent.pdf'),
    path.join(play, 'dangling.pdf'),
  ]) {
    const r = await save(p);
    assert.equal(r.isError, true, p);
    assert.match(r.body.error, /inside gmail-max's own configuration/, p);
  }
  assert.equal(fs.readFileSync(path.join(cfg, 'accounts', 'personal', 'token.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(cfg, 'planted')));
  assert.ok(!fs.existsSync(path.join(cfg, 'accounts', 'fresh', 'token.json')));
  assert.equal(h.fake.calls.filter((c) => c.method === 'attachments.get').length, 0, 'refused before fetching');
});

test('a token or client file is never attached, directly, through a symlink, or through symlink/..', async (t) => {
  const { play, attach, cfg, h } = await setup(t);
  fs.symlinkSync(cfg, path.join(play, 'to-config'));
  fs.symlinkSync(path.join(cfg, 'accounts', 'work'), path.join(play, 'to-work'));
  fs.symlinkSync(path.join(cfg, 'accounts', 'personal', 'token.json'), path.join(play, 'menu.pdf'));
  for (const p of [
    path.join(cfg, 'accounts', 'personal', 'token.json'),
    path.join(cfg, 'credentials.json'),
    path.join(cfg, 'accounts.json'),
    path.join(cfg, 'accounts', 'personal', 'token.json').toUpperCase(),
    path.join(play, 'to-config', 'accounts', 'personal', 'token.json'),
    `${path.join(play, 'to-work')}/../personal/token.json`,
    path.join(play, 'menu.pdf'),
  ]) {
    const r = await attach(p);
    assert.equal(r.isError, true, p);
    assert.match(r.body.error, /inside gmail-max's own configuration/, p);
  }
  assert.equal(h.fake.calls.filter((c) => c.method === 'drafts.create').length, 0);
  fs.writeFileSync(path.join(play, 'real.txt'), 'fine');
  assert.equal((await attach(path.join(play, 'real.txt'))).isError, false, 'ordinary files attach as usual');
});

test('canonicalPath follows a symlink before applying ".." (as the OS does)', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  const other = tempDir();
  fs.symlinkSync(path.join(root, 'a', 'b'), path.join(other, 'link'));
  assert.equal(Guard.canonicalPath(`${path.join(other, 'link')}/../x`), path.join(fs.realpathSync(path.join(root, 'a')), 'x'));
  assert.equal(Guard.inside(path.join(root, '..x'), root), true);
  assert.equal(Guard.inside(path.dirname(root), root), false);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('the package folder is not protected any more: saves into a project next to it work', () => {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const roots = Guard.protectedRoots(tempDir(), []);
  assert.doesNotThrow(() => Guard.assertWritable(path.join(pkg, 'some-project-file.pdf'), roots));
});
