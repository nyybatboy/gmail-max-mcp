import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAccounts, resolvePermission, GROUPS, groupOf, MAX_ACCOUNTS, accountPaths,
  blockAllSends, setPermission, addAccount, saveAccounts, loadAccounts, AccountsConfigError,
} from '../lib/accounts.js';
import { TOOLS } from '../lib/tools.js';
import { tempDir } from '../testkit/harness.js';

const one = (extra = {}) => ({ accounts: { personal: { purpose: 'Main inbox.', ...extra } } });
const throwsConfig = (raw, re) => assert.throws(() => parseAccounts(raw), (e) => e instanceof AccountsConfigError && re.test(e.message));

// ---------- tool classification ----------

test('every MCP tool belongs to exactly one permission group', () => {
  const seen = new Map();
  for (const [g, def] of Object.entries(GROUPS)) {
    for (const t of def.tools) {
      assert.ok(!seen.has(t), `${t} is in both ${seen.get(t)} and ${g}`);
      seen.set(t, g);
    }
  }
  for (const name of Object.keys(TOOLS)) assert.ok(groupOf(name), `${name} has no permission group`);
  for (const t of seen.keys()) assert.ok(TOOLS[t], `group lists unknown tool ${t}`);
});

test('built-in defaults: send, permanent delete and routing ask; everything else allows', () => {
  const defaults = Object.fromEntries(Object.entries(GROUPS).map(([g, d]) => [g, d.default]));
  assert.deepEqual(defaults, {
    read: 'allow', draft: 'allow', organize: 'allow', send: 'ask', delete: 'ask', routing: 'ask', settings: 'allow',
  });
  const acct = { label: 'personal', permissions: {} };
  assert.equal(resolvePermission(acct, 'send_message'), 'ask');
  assert.equal(resolvePermission(acct, 'send_draft'), 'ask');
  assert.equal(resolvePermission(acct, 'delete_message'), 'ask');
  assert.equal(resolvePermission(acct, 'create_filter'), 'ask');
  assert.equal(resolvePermission(acct, 'update_auto_forwarding'), 'ask');
  assert.equal(resolvePermission(acct, 'trash_message'), 'allow');
  assert.equal(resolvePermission(acct, 'create_draft'), 'allow');
  assert.equal(resolvePermission(acct, 'list_messages'), 'allow');
});

test('a tool setting beats its group setting, which beats the default', () => {
  const acct = { label: 'work', permissions: { send: 'allow', send_draft: 'block', read: 'block', get_message: 'allow' } };
  assert.equal(resolvePermission(acct, 'send_message'), 'allow');
  assert.equal(resolvePermission(acct, 'send_draft'), 'block');
  assert.equal(resolvePermission(acct, 'list_messages'), 'block');
  assert.equal(resolvePermission(acct, 'get_message'), 'allow');
  assert.equal(resolvePermission(acct, 'delete_message'), 'ask');
});

test('an unclassified tool name resolves to ask, never allow', () => {
  assert.equal(resolvePermission({ label: 'x', permissions: {} }, 'some_future_tool'), 'ask');
});

// ---------- validation ----------

test('a valid file parses, keeps order, and trims the purpose', () => {
  const cfg = parseAccounts({ version: 1, accounts: {
    work: { purpose: ' Work inbox. ', permissions: { send: 'allow', delete_thread: 'block' } },
    personal: { purpose: 'Main inbox.' },
  } });
  assert.deepEqual(cfg.accounts.map((a) => a.label), ['work', 'personal']);
  assert.equal(cfg.accounts[0].purpose, 'Work inbox.');
});

test(`more than ${MAX_ACCOUNTS} accounts is rejected`, () => {
  const accounts = {};
  for (let i = 0; i <= MAX_ACCOUNTS; i++) accounts[`a${i}`] = { purpose: 'x' };
  throwsConfig({ accounts }, /limit is 5/);
  delete accounts[`a${MAX_ACCOUNTS}`];
  assert.equal(parseAccounts({ accounts }).accounts.length, MAX_ACCOUNTS);
});

test('rejects: no accounts, bad label, missing purpose, unknown keys, bad states, bad version', () => {
  throwsConfig({ accounts: {} }, /No accounts/);
  throwsConfig({ accounts: { Personal: { purpose: 'x' } } }, /label "Personal" is invalid/);
  throwsConfig({ accounts: { personal: {} } }, /needs a "purpose"/);
  throwsConfig({ accounts: { personal: { purpose: '  ' } } }, /needs a "purpose"/);
  throwsConfig(one({ permission: { send: 'ask' } }), /unknown key "permission"/);
  throwsConfig(one({ permissions: { sned: 'ask' } }), /"sned" is neither a permission group/);
  throwsConfig(one({ permissions: { send: 'yes' } }), /use one of allow, ask, block/);
  throwsConfig({ ...one(), version: 2 }, /Unsupported version/);
  throwsConfig({ ...one(), extra: true }, /Unknown top-level key/);
  throwsConfig([], /JSON object/);
});

test('two accounts pointing at the same folder are rejected', () => {
  throwsConfig({ accounts: {
    personal: { purpose: 'x', dir: '/tmp/shared-account' },
    work: { purpose: 'y', dir: '/tmp/shared-account' },
  } }, /point at the same folder/);
});

test('loadAccounts reports invalid JSON with a fix line', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{ not json');
  assert.throws(() => loadAccounts(dir), /not valid JSON[\s\S]*Fix:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- paths and credentials ----------

test('account folder defaults to <config>/accounts/<label>; relative dirs resolve against the config dir', () => {
  const cfgDir = tempDir();
  assert.equal(accountPaths(cfgDir, { label: 'work' }).dir, path.join(cfgDir, 'accounts', 'work'));
  assert.equal(accountPaths(cfgDir, { label: 'work', dir: 'elsewhere/w' }).dir, path.join(cfgDir, 'elsewhere', 'w'));
  assert.equal(accountPaths(cfgDir, { label: 'work', dir: '/abs/w' }).dir, '/abs/w');
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test('an account folder with its own OAuth client keeps it; otherwise the shared client is used', () => {
  const cfgDir = tempDir();
  const own = path.join(cfgDir, 'accounts', 'work');
  fs.mkdirSync(own, { recursive: true });
  assert.equal(accountPaths(cfgDir, { label: 'work' }).credentialsPath, path.join(cfgDir, 'credentials.json'));
  fs.writeFileSync(path.join(own, 'credentials.json'), '{}');
  assert.equal(accountPaths(cfgDir, { label: 'work' }).credentialsPath, path.join(own, 'credentials.json'));
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

// ---------- mutations ----------

test('block-all-sends is a one-time action: every account blocked, then each can change again', () => {
  const cfg = parseAccounts({ accounts: {
    personal: { purpose: 'x', permissions: { send: 'ask' } },
    work: { purpose: 'y', permissions: { send: 'allow', send_draft: 'allow' } },
  } });
  const { cfg: blocked, changes } = blockAllSends(cfg);
  for (const a of blocked.accounts) {
    assert.equal(resolvePermission(a, 'send_message'), 'block');
    assert.equal(resolvePermission(a, 'send_draft'), 'block', 'per-tool send overrides are cleared too');
  }
  assert.deepEqual(changes.find((c) => c.label === 'work').before, { send_message: 'allow', send_draft: 'allow' });
  const reopened = setPermission(blocked, 'work', 'send', 'allow');
  assert.equal(resolvePermission(reopened.accounts.find((a) => a.label === 'work'), 'send_message'), 'allow');
  assert.equal(resolvePermission(reopened.accounts.find((a) => a.label === 'personal'), 'send_message'), 'block');
});

test('addAccount enforces the cap and unique labels', () => {
  let cfg = null;
  for (let i = 0; i < MAX_ACCOUNTS; i++) cfg = addAccount(cfg, { label: `a${i}`, purpose: 'x' });
  assert.throws(() => addAccount(cfg, { label: 'extra', purpose: 'x' }), /limit is 5/);
  assert.throws(() => addAccount(cfg, { label: 'a0', purpose: 'x' }), /already exists/);
});

test('setPermission rejects unknown keys and states', () => {
  const cfg = parseAccounts(one());
  assert.throws(() => setPermission(cfg, 'personal', 'sendd', 'ask'), /neither a permission group/);
  assert.throws(() => setPermission(cfg, 'personal', 'send', 'maybe'), /allow, ask, block/);
  assert.throws(() => setPermission(cfg, 'nobody', 'send', 'ask'), /No account/);
});

test('saveAccounts writes mode 600, round-trips, and refuses to write an invalid config', () => {
  const dir = tempDir();
  const cfg = setPermission(parseAccounts(one()), 'personal', 'send', 'ask');
  saveAccounts(dir, cfg);
  const file = path.join(dir, 'accounts.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadAccounts(dir), cfg);
  assert.throws(() => saveAccounts(dir, { version: 1, accounts: [] }), /No accounts/);
  assert.deepEqual(loadAccounts(dir), cfg, 'a failed save leaves the file untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});
