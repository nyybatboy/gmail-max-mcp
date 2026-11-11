// Multi-account registry and per-account permissions.
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
//       "personal": { "purpose": "Main inbox.", "permissions": { "send": "ask" } },
//       "work":     { "purpose": "Work inbox.", "dir": "accounts/work",
//                     "permissions": { "send": "allow", "delete_message": "block" } }
//     }
//   }
//
// Permissions: every tool belongs to one group. A setting can name a group or
// a single tool; a tool setting beats its group's setting, which beats the
// built-in default for the group. States: allow | ask | block.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, protectedRoots, hasDotDot, defaultSaveFolder, expandHome } from './fs-guard.js';

export const MAX_SAVE_FOLDERS = 10;

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isGroup = (key) => own(GROUPS, key);

export const ACCOUNTS_FILE = 'accounts.json';
export const MAX_ACCOUNTS = 5;
export const STATES = ['allow', 'ask', 'block'];
const LABEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// Ordered: this is also the display order in `permissions show` and list_accounts.
export const GROUPS = {
  read: {
    default: 'allow',
    description: 'Read mail, drafts, labels, filters and settings.',
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
    default: 'allow',
    description: 'Create, update and delete drafts. Nothing leaves the account.',
    tools: ['create_draft', 'create_reply_draft', 'update_draft', 'delete_draft'],
  },
  organize: {
    default: 'allow',
    description: 'Labels, archive, read/unread, Trash and restore from Trash.',
    tools: [
      'modify_message', 'batch_modify_messages', 'trash_message', 'untrash_message',
      'modify_thread', 'trash_thread', 'untrash_thread',
      'create_label', 'update_label', 'delete_label',
    ],
  },
  send: {
    default: 'ask',
    description: 'Mail leaves the account.',
    tools: ['send_message', 'send_draft'],
  },
  delete: {
    default: 'ask',
    description: 'Permanent deletes that skip Trash. Cannot be undone.',
    tools: ['delete_message', 'batch_delete_messages', 'delete_thread'],
  },
  routing: {
    default: 'ask',
    description: 'Changes where mail or replies go: filters, forwarding, delegates, send-as.',
    tools: [
      'create_filter', 'delete_filter', 'update_auto_forwarding',
      'create_forwarding_address', 'delete_forwarding_address',
      'create_delegate', 'delete_delegate',
      'create_send_as', 'update_send_as', 'delete_send_as', 'verify_send_as',
    ],
  },
  settings: {
    default: 'allow',
    description: 'Vacation responder, IMAP, POP, language, S/MIME, push notifications.',
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
 * back to single-account mode with no permissions.
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
  const own = path.join(dir, 'credentials.json');
  const credentialsPath = fs.existsSync(own) ? own : path.join(configDir, 'credentials.json');
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
 * to a default, so it fails loudly instead.
 */
export function parseAccounts(raw, { file = ACCOUNTS_FILE, configDir = '.', knownTools = allGroupedTools() } = {}) {
  const fail = (msg) => { throw new AccountsConfigError(msg, file); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The accounts file must contain a JSON object.');
  for (const k of Object.keys(raw)) {
    if (!['version', 'accounts', 'saveFolders'].includes(k)) fail(`Unknown top-level key "${k}". Allowed: version, accounts, saveFolders.`);
  }
  if (raw.version !== undefined && raw.version !== 1) fail(`Unsupported version ${JSON.stringify(raw.version)}. This release reads version 1.`);
  let saveFolders;
  if (raw.saveFolders !== undefined) {
    if (!Array.isArray(raw.saveFolders) || raw.saveFolders.length === 0) fail('"saveFolders" must be a non-empty list of folders (or leave it out to use the default, ~/Downloads/gmail-max).');
    if (raw.saveFolders.length > MAX_SAVE_FOLDERS) fail(`"saveFolders" lists ${raw.saveFolders.length} folders; the limit is ${MAX_SAVE_FOLDERS}.`);
    for (const f of raw.saveFolders) {
      if (typeof f !== 'string' || !(path.isAbsolute(f) || f === '~' || f.startsWith('~/'))) fail(`Save folder ${JSON.stringify(f)} must be an absolute path or start with "~/".`);
      if (hasDotDot(f)) fail(`Save folder ${JSON.stringify(f)} must not contain "..".`);
    }
    if (new Set(raw.saveFolders).size !== raw.saveFolders.length) fail('"saveFolders" lists the same folder twice.');
    saveFolders = [...raw.saveFolders];
  }
  const accts = raw.accounts;
  if (!accts || typeof accts !== 'object' || Array.isArray(accts)) fail('"accounts" must be an object keyed by account label.');
  const labels = Object.keys(accts);
  if (labels.length === 0) fail('No accounts are configured. Add one, or delete the accounts file to return to single-account mode.');
  if (labels.length > MAX_ACCOUNTS) fail(`${labels.length} accounts are configured; the limit is ${MAX_ACCOUNTS}.`);

  const tools = new Set(knownTools);
  const seenDirs = new Map();
  const out = [];
  for (const label of labels) {
    if (!LABEL_RE.test(label)) fail(`Account label "${label}" is invalid. Use lowercase letters, digits, "-" or "_", starting with a letter (max 32).`);
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
      if (!isGroup(key) && !tools.has(key)) fail(`Account "${label}": "${key}" is neither a permission group (${Object.keys(GROUPS).join(', ')}) nor a tool name.`);
      if (!STATES.includes(state)) fail(`Account "${label}": "${key}" is ${JSON.stringify(state)}; use one of ${STATES.join(', ')}.`);
    }
    const entry = { label, purpose: a.purpose.trim(), dir: a.dir, permissions: Object.fromEntries(Object.entries(perms)) };
    // Compare real paths, case-insensitively: a symlink or a case variant of the
    // same folder is the same token.
    const resolvedDir = canonicalPath(accountPaths(configDir, entry).dir).toLowerCase();
    if (seenDirs.has(resolvedDir)) fail(`Accounts "${seenDirs.get(resolvedDir)}" and "${label}" point at the same folder; each account needs its own token.`);
    seenDirs.set(resolvedDir, label);
    out.push(entry);
  }
  return saveFolders ? { version: 1, saveFolders, accounts: out } : { version: 1, accounts: out };
}

/** The save folders in effect, ~-expanded: the configured ones, or the default. */
export function effectiveSaveFolders(cfg) {
  const list = cfg?.saveFolders?.length ? cfg.saveFolders : [defaultSaveFolder()];
  return list.map(expandHome);
}

export function addSaveFolder(cfg, folder) {
  const saveFolders = [...(cfg.saveFolders || [])];
  if (saveFolders.includes(folder)) throw new Error(`${folder} is already a save folder.`);
  saveFolders.push(folder);
  return { ...cfg, saveFolders };
}

export function removeSaveFolder(cfg, folder) {
  const saveFolders = (cfg.saveFolders || []).filter((f) => f !== folder);
  if (saveFolders.length === (cfg.saveFolders || []).length) throw new Error(`${folder} is not a configured save folder.`);
  const next = { ...cfg, saveFolders };
  if (!saveFolders.length) delete next.saveFolders;
  return next;
}

export function loadAccounts(configDir) {
  const file = accountsFilePath(configDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new AccountsConfigError(`Cannot read the accounts file (${err.code || err.message}).`, file);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AccountsConfigError(`The accounts file is not valid JSON: ${err.message}`, file);
  }
  return parseAccounts(raw, { file, configDir });
}

export function serializeAccounts(cfg) {
  const accounts = {};
  for (const a of cfg.accounts) {
    const e = { purpose: a.purpose };
    if (a.dir) e.dir = a.dir;
    if (a.permissions && Object.keys(a.permissions).length) e.permissions = { ...a.permissions };
    accounts[a.label] = e;
  }
  return cfg.saveFolders?.length ? { version: 1, saveFolders: [...cfg.saveFolders], accounts } : { version: 1, accounts };
}

/**
 * Atomic write (temp file + rename), mode 600. Validates before writing. If
 * accounts.json is a symlink, the file it points to is replaced and the link
 * is kept.
 */
export function saveAccounts(configDir, cfg) {
  let file = accountsFilePath(configDir);
  const data = serializeAccounts(cfg);
  parseAccounts(data, { file, configDir });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) file = path.resolve(path.dirname(file), fs.readlinkSync(file));
  } catch { /* no file yet */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function findAccount(cfg, label) {
  return cfg.accounts.find((a) => a.label === label) || null;
}

/**
 * The per-call context for one account: its paths plus the folders the
 * filesystem guard protects (config dir and every account folder).
 */
export function accountContext(configDir, cfg, account) {
  const dirs = cfg.accounts.map((a) => accountPaths(configDir, a).dir);
  return {
    ...accountPaths(configDir, account),
    protectedRoots: protectedRoots(configDir, dirs),
    saveFolders: effectiveSaveFolders(cfg),
  };
}

/**
 * allow | ask | block for one tool on one account. Tool beats group beats default.
 * Own properties only: "constructor", "__proto__" and friends are never a tool or
 * a group, and an unknown tool resolves to ask, never allow.
 */
export function resolvePermission(account, tool) {
  const p = account.permissions || {};
  if (own(p, tool) && STATES.includes(p[tool])) return p[tool];
  const group = groupOf(tool);
  if (!group) return 'ask';
  if (own(p, group) && STATES.includes(p[group])) return p[group];
  return GROUPS[group].default;
}

/** Effective permission summary for display: every group, plus tool overrides. */
export function permissionSummary(account) {
  const p = account.permissions || {};
  const groups = {};
  for (const g of Object.keys(GROUPS)) groups[g] = own(p, g) ? p[g] : GROUPS[g].default;
  const overrides = {};
  for (const [k, v] of Object.entries(p)) {
    if (!isGroup(k)) overrides[k] = v;
  }
  return { groups, overrides };
}

// ---------- mutations (used by the CLI; each returns a new config) ----------

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
  return { ...(cfg || { version: 1 }), accounts };
}

export function removeAccount(cfg, label) {
  if (!findAccount(cfg, label)) throw new Error(`No account "${label}".`);
  return { ...cfg, accounts: cfg.accounts.filter((a) => a.label !== label) };
}

export function setPermission(cfg, label, key, state, { knownTools = allGroupedTools() } = {}) {
  if (!findAccount(cfg, label)) throw new Error(`No account "${label}".`);
  if (!isGroup(key) && !knownTools.includes(key)) {
    throw new Error(`"${key}" is neither a permission group (${Object.keys(GROUPS).join(', ')}) nor a tool name.`);
  }
  if (!STATES.includes(state)) throw new Error(`State must be one of ${STATES.join(', ')}.`);
  return {
    ...cfg,
    accounts: cfg.accounts.map((a) => (a.label === label
      ? { ...a, permissions: { ...a.permissions, [key]: state } }
      : a)),
  };
}

/**
 * One-time action, not a switch: sets send to block on every account and
 * removes per-tool send overrides that would otherwise still allow or ask.
 * Afterwards each account can be changed individually again.
 * Returns { cfg, changes: [{ label, before, after }] }.
 */
export function blockAllSends(cfg) {
  const sendTools = GROUPS.send.tools;
  const changes = [];
  const accounts = cfg.accounts.map((a) => {
    const before = Object.fromEntries(sendTools.map((t) => [t, resolvePermission(a, t)]));
    const permissions = { ...a.permissions, send: 'block' };
    for (const t of sendTools) delete permissions[t];
    const next = { ...a, permissions };
    const after = Object.fromEntries(sendTools.map((t) => [t, resolvePermission(next, t)]));
    changes.push({ label: a.label, before, after });
    return next;
  });
  return { cfg: { ...cfg, accounts }, changes };
}
