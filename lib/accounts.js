// Multi-account registry and per-account on/off permissions.
//
// The presence of `accounts.json` in the config directory switches the server
// and CLI into multi-account mode. Without it, nothing in this module is used
// and gmail-max behaves exactly as the single-account release did.
//
// File shape (labels are yours to choose):
//
//   {
//     "version": 1,
//     "accounts": {
//       "personal": { "purpose": "Main inbox." },
//       "work":     { "purpose": "Work inbox.", "dir": "accounts/work",
//                     "permissions": { "send": "off", "delete_message": "off" } }
//     }
//   }
//
// Permissions: everything is on unless turned off. Every tool belongs to one
// group; a setting names a group or a single tool, and a tool setting beats its
// group's setting. States: on | off. The model may change them through the
// set_permission tool when the user asks; the user may also use the CLI or edit
// this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, protectedRoots } from './fs-guard.js';

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isGroup = (key) => own(GROUPS, key);

export const ACCOUNTS_FILE = 'accounts.json';
export const MAX_ACCOUNTS = 5;
export const STATES = ['on', 'off'];
const LABEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// Ordered: this is also the display order wherever permissions are shown.
export const GROUPS = {
  read: {
    description: 'reading mail, drafts, labels, filters and settings',
    tools: [
      'whoami', 'list_messages', 'get_message', 'batch_get_messages', 'get_attachment',
      'list_drafts', 'get_draft', 'list_threads', 'get_thread', 'batch_get_threads',
      'list_labels', 'get_label', 'list_filters', 'get_filter',
      'get_vacation', 'get_imap', 'get_pop', 'get_language', 'get_auto_forwarding',
      'list_send_as', 'get_send_as', 'list_forwarding_addresses', 'get_forwarding_address',
      'list_delegates', 'get_delegate', 'list_smime', 'get_smime', 'list_history',
    ],
  },
  draft: {
    description: 'creating, changing and deleting drafts',
    tools: ['create_draft', 'create_reply_draft', 'update_draft', 'delete_draft'],
  },
  organize: {
    description: 'labels, archiving, read/unread, Trash and restoring from Trash',
    tools: [
      'modify_message', 'batch_modify_messages', 'trash_message', 'untrash_message',
      'modify_thread', 'trash_thread', 'untrash_thread',
      'create_label', 'update_label', 'delete_label',
    ],
  },
  send: {
    description: 'sending mail',
    tools: ['send_message', 'send_draft'],
  },
  delete: {
    description: 'permanent delete (skips Trash, cannot be undone)',
    tools: ['delete_message', 'batch_delete_messages', 'delete_thread'],
  },
  routing: {
    description: 'changing where mail or replies go: filters, forwarding, delegates, send-as',
    tools: [
      'create_filter', 'delete_filter', 'update_auto_forwarding',
      'create_forwarding_address', 'delete_forwarding_address',
      'create_delegate', 'delete_delegate',
      'create_send_as', 'update_send_as', 'delete_send_as', 'verify_send_as',
    ],
  },
  settings: {
    description: 'vacation responder, IMAP, POP, language, S/MIME, push notifications',
    tools: [
      'update_vacation', 'update_imap', 'update_pop', 'update_language',
      'insert_smime', 'set_default_smime', 'delete_smime', 'watch', 'stop_watch',
    ],
  },
};

const TOOL_TO_GROUP = new Map();
for (const [group, def] of Object.entries(GROUPS)) {
  for (const t of def.tools) TOOL_TO_GROUP.set(t, group);
}

export function groupOf(tool) {
  return TOOL_TO_GROUP.get(tool) || null;
}

export function allGroupedTools() {
  return [...TOOL_TO_GROUP.keys()];
}

export function isPermissionKey(key) {
  return isGroup(key) || TOOL_TO_GROUP.has(key);
}

export class AccountsConfigError extends Error {
  constructor(message, file) {
    super(`${message}\n\nFix: edit ${file}, or manage it with  gmail-cli accounts ... / gmail-cli permissions ...  (see README "Multiple accounts").`);
    this.name = 'AccountsConfigError';
    this.userActionable = true;
  }
}

export function accountsFilePath(configDir) {
  return path.join(configDir, ACCOUNTS_FILE);
}

/**
 * Is there anything at the accounts-file path? lstat, not exists: a dangling
 * symlink or a directory named accounts.json counts as present, so the server
 * tries multi-account mode and refuses to start, instead of silently falling
 * back to single-account mode.
 */
export function accountsFileExists(configDir) {
  try {
    fs.lstatSync(accountsFilePath(configDir));
    return true;
  } catch {
    return false;
  }
}

function expandDir(configDir, dir) {
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  return path.resolve(configDir, dir);
}

/**
 * Resolve an account's on-disk paths.
 * - dir defaults to <configDir>/accounts/<label>.
 * - The OAuth client is the account folder's own credentials.json when it has
 *   one (a refresh token only works with the client that issued it, so an
 *   adopted folder keeps its client); otherwise the shared one in configDir.
 */
export function accountPaths(configDir, account) {
  const dir = account.dir
    ? expandDir(configDir, account.dir)
    : path.join(configDir, 'accounts', account.label);
  const ownClient = path.join(dir, 'credentials.json');
  const credentialsPath = fs.existsSync(ownClient) ? ownClient : path.join(configDir, 'credentials.json');
  return {
    label: account.label,
    dir,
    tokenPath: path.join(dir, 'token.json'),
    credentialsPath,
    profilePath: path.join(dir, 'profile.json'),
  };
}

/**
 * Validate a parsed accounts file. Returns a normalized config:
 *   { version: 1, accounts: [{ label, purpose, dir, permissions }] }
 * Throws AccountsConfigError on anything it does not understand: an unknown
 * permission key or state is a typo that would otherwise silently fall back
 * to on, so it fails loudly instead.
 */
export function parseAccounts(raw, { file = ACCOUNTS_FILE, configDir = '.' } = {}) {
  const fail = (msg) => { throw new AccountsConfigError(msg, file); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The accounts file must contain a JSON object.');
  for (const k of Object.keys(raw)) {
    if (!['version', 'accounts'].includes(k)) fail(`Unknown top-level key "${k}". Allowed: version, accounts.`);
  }
  if (raw.version !== undefined && raw.version !== 1) fail(`Unsupported version ${JSON.stringify(raw.version)}. This release reads version 1.`);
  const accts = raw.accounts;
  if (!accts || typeof accts !== 'object' || Array.isArray(accts)) fail('"accounts" must be an object keyed by account label.');
  const labels = Object.keys(accts);
  if (labels.length === 0) fail('No accounts are configured. Add one, or delete the accounts file to return to single-account mode.');
  if (labels.length > MAX_ACCOUNTS) fail(`${labels.length} accounts are configured; the limit is ${MAX_ACCOUNTS}.`);

  const seenDirs = new Map();
  const out = [];
  for (const label of labels) {
    if (!LABEL_RE.test(label)) fail(`Account label "${label}" is invalid. Use lowercase letters, digits, "-" or "_", starting with a letter (max 32).`);
    if (label === 'all') fail('"all" is reserved (it means every account when turning permissions on or off). Choose another label.');
    const a = accts[label];
    if (!a || typeof a !== 'object' || Array.isArray(a)) fail(`Account "${label}" must be an object.`);
    for (const k of Object.keys(a)) {
      if (!['purpose', 'dir', 'permissions'].includes(k)) fail(`Account "${label}": unknown key "${k}". Allowed: purpose, dir, permissions.`);
    }
    if (typeof a.purpose !== 'string' || !a.purpose.trim()) fail(`Account "${label}" needs a "purpose": one line saying what this inbox is for. The model reads it to choose the account.`);
    if (a.dir !== undefined && (typeof a.dir !== 'string' || !a.dir.trim())) fail(`Account "${label}": "dir" must be a non-empty path string.`);
    const perms = a.permissions ?? {};
    if (typeof perms !== 'object' || Array.isArray(perms)) fail(`Account "${label}": "permissions" must be an object.`);
    for (const [key, state] of Object.entries(perms)) {
      if (!isPermissionKey(key)) fail(`Account "${label}": "${key}" is neither a permission group (${Object.keys(GROUPS).join(', ')}) nor a tool name.`);
      if (!STATES.includes(state)) fail(`Account "${label}": "${key}" is ${JSON.stringify(state)}; use "on" or "off".`);
    }
    const entry = { label, purpose: a.purpose.trim(), dir: a.dir, permissions: Object.fromEntries(Object.entries(perms)) };
    // Compare real paths, case-insensitively: a symlink or a case variant of the
    // same folder is the same token.
    const resolvedDir = canonicalPath(accountPaths(configDir, entry).dir).toLowerCase();
    if (seenDirs.has(resolvedDir)) fail(`Accounts "${seenDirs.get(resolvedDir)}" and "${label}" point at the same folder; each account needs its own token.`);
    seenDirs.set(resolvedDir, label);
    out.push(entry);
  }
  return { version: 1, accounts: out };
}

function readAccountsText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new AccountsConfigError(`Cannot read the accounts file (${err.code || err.message}).`, file);
  }
}

function parseAccountsText(text, file, configDir) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AccountsConfigError(`The accounts file is not valid JSON: ${err.message}`, file);
  }
  return parseAccounts(raw, { file, configDir });
}

export function loadAccounts(configDir) {
  const file = accountsFilePath(configDir);
  return parseAccountsText(readAccountsText(file), file, configDir);
}

export function serializeAccounts(cfg) {
  const accounts = {};
  for (const a of cfg.accounts) {
    const e = { purpose: a.purpose };
    if (a.dir) e.dir = a.dir;
    if (a.permissions && Object.keys(a.permissions).length) e.permissions = { ...a.permissions };
    accounts[a.label] = e;
  }
  return { version: 1, accounts };
}

/**
 * Atomic write (temp file + rename), mode 600. Validates before writing. If
 * accounts.json is a symlink, the file it points to is replaced and the link
 * is kept.
 */
export function saveAccounts(configDir, cfg) {
  writeAccounts(configDir, cfg, null);
}

/**
 * Validate and write atomically. With `expect` (the exact text read before
 * the change), the file is re-read just before the rename and the write is
 * abandoned (returns false) if another writer changed it in between.
 */
function writeAccounts(configDir, cfg, expect) {
  const link = accountsFilePath(configDir);
  let file = link;
  const data = serializeAccounts(cfg);
  parseAccounts(data, { file: link, configDir });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) file = path.resolve(path.dirname(file), fs.readlinkSync(file));
  } catch { /* no file yet */ }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    if (expect !== null) {
      let now = null;
      try { now = fs.readFileSync(link, 'utf8'); } catch { /* gone */ }
      if (now !== expect) {
        fs.rmSync(tmp, { force: true });
        return false;
      }
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Read, change and save accounts.json as one step, for every writer (the
 * set_permission tool and the CLI).
 * - Within one process: the read, the change and the write run with no await
 *   between them, so overlapping tool calls cannot work from a stale copy.
 * - Across processes (the CLI while a server runs, or two servers): the file
 *   is compared with what was read just before the rename; if it changed,
 *   the change is re-applied to the new contents. A window of microseconds
 *   between that comparison and the rename remains; closing it would need a
 *   file lock.
 * mutate(cfg) returns a new cfg, or { cfg, ...anything }; that is returned.
 */
export function updateAccounts(configDir, mutate, { attempts = 5 } = {}) {
  const file = accountsFilePath(configDir);
  for (let i = 0; i < attempts; i++) {
    const before = readAccountsText(file);
    const out = mutate(parseAccountsText(before, file, configDir));
    const next = out && out.cfg ? out.cfg : out;
    if (writeAccounts(configDir, next, before)) return out;
  }
  throw new Error('The accounts file kept changing while this change was being saved. Try again.');
}

export function findAccount(cfg, label) {
  return cfg.accounts.find((a) => a.label === label) || null;
}

/**
 * The per-call context for one account: its paths plus the folders whose
 * credentials the filesystem guard protects (config dir and every account folder).
 */
export function accountContext(configDir, cfg, account) {
  const dirs = cfg.accounts.map((a) => accountPaths(configDir, a).dir);
  return { ...accountPaths(configDir, account), protectedRoots: protectedRoots(configDir, dirs) };
}

/**
 * on | off for one tool on one account. A tool setting beats its group's
 * setting; everything else is on. Own properties only: "constructor" and
 * friends are never a tool or a group.
 */
export function resolvePermission(account, tool) {
  const p = account.permissions || {};
  if (own(p, tool) && STATES.includes(p[tool])) return p[tool];
  const group = groupOf(tool);
  if (group && own(p, group) && STATES.includes(p[group])) return p[group];
  return 'on';
}

/**
 * What is on and off for an account, in plain terms:
 *   { on: [groups], off: [groups], toolsOff: [tools], toolsOn: [tools] }
 * toolsOff / toolsOn list single tools set against their group's state.
 */
export function permissionSummary(account) {
  const on = [];
  const off = [];
  for (const g of Object.keys(GROUPS)) {
    (resolveGroup(account, g) === 'on' ? on : off).push(g);
  }
  const p = account.permissions || {};
  const toolsOff = [];
  const toolsOn = [];
  for (const [k, v] of Object.entries(p)) {
    if (isGroup(k)) continue;
    if (v === resolveGroup(account, groupOf(k))) continue;
    (v === 'off' ? toolsOff : toolsOn).push(k);
  }
  return { on, off, toolsOff, toolsOn };
}

function resolveGroup(account, group) {
  const p = account.permissions || {};
  return own(p, group) && STATES.includes(p[group]) ? p[group] : 'on';
}

// ---------- mutations (each returns a new config) ----------

export function addAccount(cfg, { label, purpose, dir }) {
  const accounts = cfg ? [...cfg.accounts] : [];
  if (accounts.some((a) => a.label === label)) {
    throw new Error(`Account "${label}" already exists.`);
  }
  if (accounts.length >= MAX_ACCOUNTS) {
    throw new Error(`Already ${accounts.length} accounts; the limit is ${MAX_ACCOUNTS}. Remove one first.`);
  }
  const entry = { label, purpose: String(purpose || '').trim(), permissions: {} };
  if (dir) entry.dir = dir;
  accounts.push(entry);
  return { version: 1, accounts };
}

export function removeAccount(cfg, label) {
  if (!findAccount(cfg, label)) throw new Error(`No account "${label}".`);
  return { version: 1, accounts: cfg.accounts.filter((a) => a.label !== label) };
}

/**
 * Turn a group or a single tool on or off for the named accounts ("all" for
 * every account). Setting a group also clears single-tool settings inside it,
 * so "turn sending back on" really turns every send tool on.
 * Returns { cfg, changes: [{ label, key, before, after }] }, where before/after
 * describe the key as a whole (for a group: "on", "off" or "mixed").
 */
export function setPermission(cfg, accounts, key, state) {
  if (!isPermissionKey(key)) {
    throw new Error(`"${key}" is neither a permission group (${Object.keys(GROUPS).join(', ')}) nor a tool name.`);
  }
  if (!STATES.includes(state)) throw new Error('State must be "on" or "off".');
  const labels = accounts === 'all' ? cfg.accounts.map((a) => a.label) : [].concat(accounts);
  if (!labels.length) throw new Error('Name at least one account, or "all".');
  for (const l of labels) {
    if (typeof l !== 'string' || !findAccount(cfg, l)) {
      throw new Error(`No account ${JSON.stringify(l)}. Choose from: ${cfg.accounts.map((a) => a.label).join(', ')}, or "all".`);
    }
  }
  const changes = [];
  const next = cfg.accounts.map((a) => {
    if (!labels.includes(a.label)) return a;
    const before = stateOfKey(a, key);
    const permissions = { ...a.permissions };
    if (isGroup(key)) {
      for (const t of GROUPS[key].tools) delete permissions[t];
    }
    // "on" is the default: store it only to override an "off" group for one tool.
    if (state === 'on' && (isGroup(key) || resolveGroup({ permissions }, groupOf(key)) === 'on')) delete permissions[key];
    else permissions[key] = state;
    const updated = { ...a, permissions };
    changes.push({ label: a.label, key, before, after: stateOfKey(updated, key) });
    return updated;
  });
  return { cfg: { version: 1, accounts: next }, changes };
}

/** on, off, or mixed (a group whose tools differ). */
export function stateOfKey(account, key) {
  if (!isGroup(key)) return resolvePermission(account, key);
  const states = new Set(GROUPS[key].tools.map((t) => resolvePermission(account, t)));
  return states.size === 1 ? [...states][0] : 'mixed';
}

/**
 * One-time action: turn sending off on every account. Each account can be
 * turned back on individually afterwards; nothing overrides that.
 */
export function turnOffAllSends(cfg) {
  return setPermission(cfg, 'all', 'send', 'off');
}
