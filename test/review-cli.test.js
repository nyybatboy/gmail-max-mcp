// CLI tests for the first review round. Real processes, temporary HOME and
// config directory, no tokens: any command that reached Gmail would fail with
// "Not authenticated", so a refusal proves the check ran first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../testkit/harness.js';
import { confirm } from '../lib/prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'gmail-cli.js');

function sandbox() {
  const home = tempDir('gmail-max-home-');
  const cfg = path.join(home, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, GMAIL_MCP_CONFIG_DIR: cfg };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, input: '', encoding: 'utf8', timeout: 15000 });
    let err = r.stderr;
    try { err = JSON.parse(r.stderr); } catch { /* raw */ }
    return { code: r.status, err, rawErr: r.stderr, out: r.stdout };
  };
  cli('accounts', 'add', 'personal', '--purpose', 'Main inbox.', '--no-auth');
  cli('accounts', 'add', 'work', '--purpose', 'Work inbox.', '--no-auth');
  return { home, cfg, env, cli, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('12: a subcommand with no permission mapping is refused in multi-account mode', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const r = s.cli('frobnicate', '--account', 'work');
  assert.equal(r.code, 1);
  assert.match(r.err.error, /Unknown or unmapped command "frobnicate" in multi-account mode; refusing/);
});

test('12: Ctrl-D at the prompt is "no answer", not a silent success', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const p = confirm({ message: 'Send?', input, output, terminal: false });
  input.end();
  assert.equal(await p, null);
  const yes = new PassThrough();
  const py = confirm({ message: 'Send?', input: yes, output: new PassThrough(), terminal: false });
  yes.write('y\n');
  assert.equal(await py, true);
  const no = new PassThrough();
  const pn = confirm({ message: 'Send?', input: no, output: new PassThrough(), terminal: false });
  no.write('\n');
  assert.equal(await pn, false);
});

test('1: the CLI get-attachment refuses a save path inside the config directory', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const before = fs.readFileSync(path.join(s.cfg, 'accounts.json'), 'utf8');
  const r = s.cli('get-attachment', '--account', 'work', '--message-id', 'm', '--attachment-id', 'a', '--save-path', path.join(s.cfg, 'accounts.json'));
  assert.equal(r.code, 1);
  assert.match(r.err.error, /inside gmail-max's own configuration/);
  assert.doesNotMatch(r.rawErr, /Not authenticated/);
  assert.equal(fs.readFileSync(path.join(s.cfg, 'accounts.json'), 'utf8'), before);
});

test('2: the CLI applies the same compose checks before anything else', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.cli('permissions', 'set', 'work', 'send', 'allow');
  const inj = s.cli('send', '--account', 'work', '--json', JSON.stringify({ to: 'a@example.net', subject: 's', text: 'b', headers: { Bcc: 'x@example.net' } }));
  assert.match(inj.err.error, /^Refused: "Bcc" cannot be set through "headers"/);
  const att = s.cli('create-draft', '--account', 'work', '--json', JSON.stringify({ to: 'a@example.net', attachments: [{ path: path.join(s.cfg, 'accounts.json') }] }));
  assert.match(att.err.error, /inside gmail-max's own configuration/);
  for (const r of [inj, att]) assert.doesNotMatch(r.rawErr, /Not authenticated/);
});

test('15: accounts and permissions do not wait on an open stdin pipe', async (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  for (const args of [['accounts', 'list'], ['permissions', 'show']]) {
    const child = spawn(process.execPath, [CLI, ...args], { env: s.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // stdin deliberately left open
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve('hung'); }, 5000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    child.stdin.destroy();
    assert.equal(code, 0, `${args.join(' ')} ${code === 'hung' ? 'waited on stdin' : 'failed'}`);
  }
});
