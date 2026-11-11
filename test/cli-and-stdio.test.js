// Process-level tests: the real bin/ entry points, each run with HOME and
// GMAIL_MCP_CONFIG_DIR pointed at a fresh temporary directory. Only commands
// that finish before any Gmail call are exercised (management commands and
// refusals), so nothing here can reach Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tempDir, writeAccounts } from '../testkit/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'gmail-cli.js');
const MCP = path.join(here, '..', 'bin', 'gmail-mcp.js');

function sandbox() {
  const home = tempDir('gmail-max-home-');
  const cfg = path.join(home, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, GMAIL_MCP_CONFIG_DIR: cfg };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, input: '', encoding: 'utf8' });
    const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };
    return { code: r.status, out: parse(r.stdout), err: parse(r.stderr), rawErr: r.stderr };
  };
  const cleanup = () => fs.rmSync(home, { recursive: true, force: true });
  return { home, cfg, env, cli, cleanup };
}

function fakeTokenDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: 'fake' }));
}

// ---------- CLI: accounts and permissions ----------

test('CLI: accounts add adopts an existing folder and turns multi-account mode on', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  assert.equal(s.cli('accounts', 'list').out.multiAccount, false);

  const adopt = path.join(s.home, 'old-second-registration');
  fakeTokenDir(adopt);
  const add = s.cli('accounts', 'add', 'personal', '--purpose', 'Main inbox.', '--dir', adopt);
  assert.equal(add.code, 0, add.rawErr);
  assert.equal(add.out.token, 'adopted existing token');
  assert.match(add.out.note, /Multi-account mode is now on/);
  assert.equal(fs.statSync(path.join(s.cfg, 'accounts.json')).mode & 0o777, 0o600);

  const work = s.cli('accounts', 'add', 'work', '--purpose', 'Work inbox.', '--no-auth');
  assert.equal(work.code, 0, work.rawErr);
  assert.match(work.out.token, /none yet: run  node bin\/gmail-cli\.js auth --account work/);
  assert.equal(work.out.note, undefined);

  const list = s.cli('accounts', 'list').out;
  assert.deepEqual(list.accounts.map((a) => [a.label, a.tokenPresent]), [['personal', true], ['work', false]]);
  assert.equal(list.accounts[0].dir, adopt);
  assert.equal(list.accounts[0].permissions.groups.send, 'ask', 'built-in default');
});

test('CLI: the five-account cap, label rules and unknown permission keys are enforced', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  for (const l of ['a1', 'a2', 'a3', 'a4', 'a5']) assert.equal(s.cli('accounts', 'add', l, '--purpose', 'x', '--no-auth').code, 0);
  const sixth = s.cli('accounts', 'add', 'a6', '--purpose', 'x', '--no-auth');
  assert.equal(sixth.code, 1);
  assert.match(sixth.err.error, /limit is 5/);
  assert.match(s.cli('accounts', 'remove', 'a5').rawErr, /^$/);
  // Without --no-auth: validation must fail before the OAuth consent would start
  // (no credentials.json exists here, so reaching the consent would fail differently).
  assert.match(s.cli('accounts', 'add', 'Bad', '--purpose', 'x').err.error, /label "Bad" is invalid/);
  assert.match(s.cli('accounts', 'add', 'blank', '--purpose', '  ').err.error, /needs a "purpose"/);
  assert.match(s.cli('accounts', 'add', 'nopurpose', '--no-auth').err.error, /needs --purpose/);
  assert.match(s.cli('permissions', 'set', 'a1', 'sned', 'ask').err.error, /neither a permission group/);
});

test('CLI: permissions set / clear / block-all-sends', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.cli('accounts', 'add', 'personal', '--purpose', 'Main inbox.', '--no-auth');
  s.cli('accounts', 'add', 'work', '--purpose', 'Work inbox.', '--no-auth');
  assert.equal(s.cli('permissions', 'set', 'work', 'send', 'allow').out.permissions.groups.send, 'allow');
  assert.deepEqual(s.cli('permissions', 'set', 'work', 'delete_thread', 'block').out.permissions.overrides, { delete_thread: 'block' });
  assert.deepEqual(s.cli('permissions', 'clear', 'work', 'delete_thread').out.permissions.overrides, {});

  const blocked = s.cli('permissions', 'block-all-sends').out;
  assert.match(blocked.note, /One-time action/);
  const show = s.cli('permissions', 'show').out.accounts;
  assert.ok(show.every((a) => a.groups.send === 'block'));
  s.cli('permissions', 'set', 'work', 'send', 'allow');
  const after = Object.fromEntries(s.cli('permissions', 'show').out.accounts.map((a) => [a.label, a.groups.send]));
  assert.deepEqual(after, { personal: 'block', work: 'allow' });
});

test('CLI: removing the last account is refused; --delete-token removes only that account\'s token files', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.cli('accounts', 'add', 'personal', '--purpose', 'x', '--no-auth');
  const workDir = path.join(s.cfg, 'accounts', 'work');
  fakeTokenDir(workDir);
  fs.writeFileSync(path.join(workDir, 'credentials.json'), '{}');
  s.cli('accounts', 'add', 'work', '--purpose', 'y');
  assert.match(s.cli('accounts', 'remove', 'personal').out.removed, /personal/);
  assert.match(s.cli('accounts', 'remove', 'work').err.error, /last account/);
  s.cli('accounts', 'add', 'personal', '--purpose', 'x', '--no-auth');
  const rm = s.cli('accounts', 'remove', 'work', '--delete-token');
  assert.deepEqual(rm.out.deleted, [path.join(workDir, 'token.json')]);
  assert.ok(fs.existsSync(path.join(workDir, 'credentials.json')), 'the OAuth client file is left alone');
});

// ---------- CLI: Gmail commands in multi-account mode ----------

test('CLI: Gmail commands need --account in multi-account mode; --account is rejected in single-account mode', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  assert.match(s.cli('list-labels', '--account', 'personal').err.error, /multi-account mode is off/);
  s.cli('accounts', 'add', 'personal', '--purpose', 'x', '--no-auth');
  s.cli('accounts', 'add', 'work', '--purpose', 'y', '--no-auth');
  const none = s.cli('list-labels');
  assert.equal(none.code, 1);
  assert.match(none.err.error, /--account is required in multi-account mode; there is no default\. Choose one of: personal, work/);
  assert.match(s.cli('list-labels', '--account', 'nobody').err.error, /Unknown account "nobody"/);
});

test('CLI: ask is refused without an interactive terminal; block is refused; both before any Gmail call', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.cli('accounts', 'add', 'personal', '--purpose', 'x', '--no-auth');
  s.cli('accounts', 'add', 'work', '--purpose', 'y', '--no-auth');
  s.cli('permissions', 'set', 'work', 'send', 'block');
  const msg = JSON.stringify({ to: 'a@example.net', subject: 's', text: 'b' });

  const ask = s.cli('send', '--account', 'personal', '--json', msg);
  assert.equal(ask.code, 1);
  assert.deepEqual([ask.err.account, ask.err.refused], ['personal', true]);
  assert.match(ask.err.reason, /needs the user's approval and this client cannot ask/);

  const block = s.cli('send', '--account', 'work', '--json', msg);
  assert.match(block.err.reason, /Sending from "work" is blocked/);

  const del = s.cli('delete-message', '--account', 'personal', '--id', 'x');
  assert.match(del.err.reason, /^Not run\. delete_message on "personal" needs the user's approval/);

  // No token exists for either account: had any of these reached Gmail they
  // would have failed with "Not authenticated" instead of a refusal.
  for (const r of [ask, block, del]) assert.doesNotMatch(r.rawErr, /Not authenticated/);
});

// ---------- stdio server ----------

test('stdio: with an accounts file the server starts in multi-account mode', async (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  writeAccounts(s.cfg, { personal: { purpose: 'Main inbox.' }, work: { purpose: 'Work inbox.', permissions: { send: 'allow' } } });
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: s.env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools[0].name, 'list_accounts');
  assert.deepEqual(tools.find((x) => x.name === 'send_message').inputSchema.properties.account.enum, ['personal', 'work']);
  const refused = await client.callTool({ name: 'send_message', arguments: { account: 'personal', to: 'a@example.net' } });
  assert.match(refused.content[0].text, /cannot ask for it/);
});

test('stdio: an invalid accounts file stops the server from starting', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  fs.writeFileSync(path.join(s.cfg, 'accounts.json'), JSON.stringify({ accounts: { personal: { purpose: 'x', permissions: { send: 'later' } } } }));
  const r = spawnSync(process.execPath, [MCP], { env: s.env, input: '', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gmail-max: not starting\.[\s\S]*"send" is "later"/);
});
