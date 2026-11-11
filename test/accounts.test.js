import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAccounts, resolvePermission, GROUPS, groupOf, MAX_ACCOUNTS, accountPaths, permissionSummary,
  setPermission, turnOffAllSends, addAccount, saveAccounts, loadAccounts, AccountsConfigError,
  accountsFileExists, stateOfKey,
} from '../lib/accounts.js';
import { TOOLS } from '../lib/tools.js';
import { tempDir } from '../testkit/harness.js';

const one = (extra = {}) => ({ accounts: { personal: { purpose: 'Main inbox.', ...extra } } });
const throwsConfig = (raw, re, opts) => assert.throws(() => parseAccounts(raw, opts), (e) => e instanceof AccountsConfigError && re.test(e.message));
const two = () => parseAccounts({ accounts: { personal: { purpose: 'a' }, work: { purpose: 'b' } } });

// ---------- groups ----------

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

test('everything is on by default, including send, permanent delete and routing', () => {
  const acct = { label: 'personal', permissions: {} };
  for (const name of Object.keys(TOOLS)) assert.equal(resolvePermission(acct, name), 'on', name);
  assert.deepEqual(permissionSummary(acct), { on: Object.keys(GROUPS), off: [], toolsOff: [], toolsOn: [] });
});

test('a tool setting beats its group setting', () => {
  const acct = { label: 'work', permissions: { send: 'off', send_draft: 'on', delete_thread: 'off' } };
  assert.equal(resolvePermission(acct, 'send_message'), 'off');
  assert.equal(resolvePermission(acct, 'send_draft'), 'on');
  assert.equal(resolvePermission(acct, 'delete_thread'), 'off');
  assert.equal(resolvePermission(acct, 'delete_message'), 'on');
  assert.deepEqual(permissionSummary(acct), {
    on: ['read', 'draft', 'organize', 'delete', 'routing', 'settings'], off: ['send'], toolsOff: ['delete_thread'], toolsOn: ['send_draft'],
  });
});

test('"constructor" and friends are never tools, groups or permission keys', () => {
  for (const key of ['constructor', 'toString', 'hasOwnProperty']) throwsConfig(one({ permissions: { [key]: 'off' } }), /neither a permission group/);
  throwsConfig(JSON.parse('{"accounts":{"personal":{"purpose":"x","permissions":{"__proto__":"off"}}}}'), /neither a permission group/);
  assert.equal(resolvePermission({ permissions: {} }, 'constructor'), 'on');
  assert.throws(() => setPermission(two(), 'personal', 'constructor', 'off'), /neither a permission group/);
});

// ---------- validation ----------

test('a valid file parses, keeps order, and trims the purpose', () => {
  const cfg = parseAccounts({ version: 1, accounts: {
    work: { purpose: ' Work inbox. ', permissions: { send: 'off', delete_thread: 'off' } },
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

test('rejects: no accounts, bad or reserved label, missing purpose, unknown keys, bad states, old keys', () => {
  throwsConfig({ accounts: {} }, /No accounts/);
  throwsConfig({ accounts: { Personal: { purpose: 'x' } } }, /label "Personal" is invalid/);
  throwsConfig({ accounts: { all: { purpose: 'x' } } }, /"all" is reserved/);
  throwsConfig({ accounts: { personal: {} } }, /needs a "purpose"/);
  throwsConfig(one({ permission: { send: 'off' } }), /unknown key "permission"/);
  throwsConfig(one({ permissions: { sned: 'off' } }), /"sned" is neither a permission group/);
  for (const state of ['ask', 'allow', 'block', 'Off', true]) throwsConfig(one({ permissions: { send: state } }), /use "on" or "off"/);
  throwsConfig({ ...one(), version: 2 }, /Unsupported version/);
  throwsConfig({ ...one(), saveFolders: ['/x'] }, /Unknown top-level key "saveFolders"/);
});

test('two labels cannot share a folder, by string, symlink or case variant', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  for (const b of ['real', 'link', 'REAL']) {
    throwsConfig({ accounts: { a: { purpose: 'x', dir: 'real' }, b: { purpose: 'y', dir: b } } }, /same folder/, { configDir: dir });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadAccounts reports invalid JSON with a fix line', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{ not json');
  assert.throws(() => loadAccounts(dir), /not valid JSON[\s\S]*Fix:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dangling symlink or a directory named accounts.json counts as present (fail closed)', () => {
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

// ---------- turning things on and off ----------

test('setPermission: off, back on, for one account or all, and reports before/after', () => {
  let { cfg, changes } = setPermission(two(), 'work', 'send', 'off');
  assert.deepEqual(changes, [{ label: 'work', key: 'send', before: 'on', after: 'off' }]);
  assert.equal(resolvePermission(cfg.accounts[1], 'send_message'), 'off');
  assert.equal(resolvePermission(cfg.accounts[0], 'send_message'), 'on');
  ({ cfg, changes } = setPermission(cfg, 'work', 'send', 'on'));
  assert.deepEqual(changes, [{ label: 'work', key: 'send', before: 'off', after: 'on' }]);
  assert.deepEqual(cfg.accounts[1].permissions, {}, 'on is the default and is not stored');
  ({ cfg } = setPermission(cfg, 'all', 'delete', 'off'));
  assert.ok(cfg.accounts.every((a) => resolvePermission(a, 'delete_thread') === 'off'));
});

test('setting a group resets single tools inside it; a tool can still be set against its group', () => {
  let { cfg } = setPermission(two(), 'work', 'send_draft', 'off');
  assert.equal(stateOfKey(cfg.accounts[1], 'send'), 'mixed');
  ({ cfg } = setPermission(cfg, 'work', 'send', 'on'));
  assert.equal(resolvePermission(cfg.accounts[1], 'send_draft'), 'on', '"turn sending back on" turns every send tool on');
  ({ cfg } = setPermission(cfg, 'work', 'send', 'off'));
  ({ cfg } = setPermission(cfg, 'work', 'send_draft', 'on'));
  assert.equal(resolvePermission(cfg.accounts[1], 'send_draft'), 'on');
  assert.equal(resolvePermission(cfg.accounts[1], 'send_message'), 'off');
});

test('setPermission refuses bad input', () => {
  const cfg = two();
  assert.throws(() => setPermission(cfg, 'nobody', 'send', 'off'), /No account "nobody"/);
  assert.throws(() => setPermission(cfg, 'work', 'sendd', 'off'), /neither a permission group/);
  assert.throws(() => setPermission(cfg, 'work', 'send', 'block'), /"on" or "off"/);
  assert.throws(() => setPermission(cfg, [], 'send', 'off'), /at least one account/);
});

test('turn off all sends is a one-time action: every account off, then each can be turned back on', () => {
  const { cfg, changes } = turnOffAllSends(two());
  assert.ok(cfg.accounts.every((a) => resolvePermission(a, 'send_message') === 'off' && resolvePermission(a, 'send_draft') === 'off'));
  assert.equal(changes.length, 2);
  const { cfg: reopened } = setPermission(cfg, 'personal', 'send', 'on');
  assert.equal(resolvePermission(reopened.accounts[0], 'send_message'), 'on');
  assert.equal(resolvePermission(reopened.accounts[1], 'send_message'), 'off');
});

test('addAccount enforces the cap and unique labels', () => {
  let cfg = null;
  for (let i = 0; i < MAX_ACCOUNTS; i++) cfg = addAccount(cfg, { label: `a${i}`, purpose: 'x' });
  assert.throws(() => addAccount(cfg, { label: 'extra', purpose: 'x' }), /limit is 5/);
  assert.throws(() => addAccount(cfg, { label: 'a0', purpose: 'x' }), /already exists/);
});

test('saveAccounts writes mode 600, round-trips, keeps a symlink, and refuses to write an invalid config', () => {
  const dir = tempDir();
  const { cfg } = setPermission(parseAccounts(one()), 'personal', 'send', 'off');
  saveAccounts(dir, cfg);
  const file = path.join(dir, 'accounts.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadAccounts(dir), cfg);
  assert.throws(() => saveAccounts(dir, { version: 1, accounts: [] }), /No accounts/);
  assert.deepEqual(loadAccounts(dir), cfg, 'a failed save leaves the file untouched');

  const dir2 = tempDir();
  const target = path.join(dir2, 'real-accounts.json');
  fs.writeFileSync(target, JSON.stringify({ accounts: { personal: { purpose: 'x' } } }));
  fs.symlinkSync(target, path.join(dir2, 'accounts.json'));
  saveAccounts(dir2, setPermission(loadAccounts(dir2), 'personal', 'send', 'off').cfg);
  assert.equal(fs.lstatSync(path.join(dir2, 'accounts.json')).isSymbolicLink(), true);
  assert.match(fs.readFileSync(target, 'utf8'), /"send": "off"/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});
