// The two server modes.
//
// createLegacyServer(): single account. Identical to the single-account release
//   (proved by test/legacy-snapshot.test.js). Used when the config directory has
//   no accounts.json.
// createMultiServer(): up to five accounts through one tool list. Every tool takes
//   a required `account` argument with no default. Each account has on/off
//   permissions (lib/accounts.js), everything on by default; a tool that is off
//   for an account is refused there, and the set_permission tool turns things on
//   and off when the user asks.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import * as G from './gmail.js';
import { runWithAccount } from './context.js';
import {
  loadAccounts, updateAccounts, accountContext, resolvePermission, permissionSummary, findAccount,
  setPermission, groupOf, GROUPS, isPermissionKey,
} from './accounts.js';
import { validateComposeArgs, normalizeComposeArgs, formatAddress } from './compose-checks.js';
import { IdLedger } from './id-ledger.js';

const SERVER_INFO = { name: 'gmail-max', version: '0.1.0' };

const jsonText = (obj) => JSON.stringify(obj, null, 2);

// ---------------------------------------------------------------------------
// Single-account mode (unchanged behaviour)
// ---------------------------------------------------------------------------

export function createLegacyServer() {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS[name];
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await tool.handler(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: err.message,
          code: err.code,
          details: err.errors || err.response?.data || null,
        }, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Multi-account mode
// ---------------------------------------------------------------------------

// Tools whose result leads with the From address the message carries.
const COMPOSE_TOOLS = new Set(['send_message', 'send_draft', 'create_draft', 'create_reply_draft', 'update_draft']);

const GROUP_LINES = Object.entries(GROUPS).map(([g, d]) => `${g} (${d.description})`).join(', ');

const LIST_ACCOUNTS = {
  name: 'list_accounts',
  description: 'List the Gmail accounts this server serves: label, purpose, address, and what is turned on and off for each (by group, plus any single tools set differently). Use it to answer questions like "can you send from my work account?" without trying.',
  inputSchema: { type: 'object', properties: {} },
};

function setPermissionTool(cfg) {
  return {
    name: 'set_permission',
    description: [
      'Turn a group of tools (or a single tool) on or off for one account or for all accounts.',
      'Use it only when the user asks for the change. The setting is saved and stays until changed again, across restarts and for every client on this machine.',
      'Everything is on unless turned off. A tool that is off for an account is refused there and that account disappears from the tool\'s account list.',
      'Examples: "turn off sending for the work account" -> {"account":"work","what":"send","state":"off"};',
      '"turn sending back on for personal" -> {"account":"personal","what":"send","state":"on"};',
      '"turn off permanent delete everywhere" -> {"account":"all","what":"delete","state":"off"};',
      '"turn off all sends" -> {"account":"all","what":"send","state":"off"} (each account can be turned back on on its own afterwards).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          enum: [...cfg.accounts.map((a) => a.label), 'all'],
          description: `The account to change, or "all" for every account. ${cfg.accounts.map((a) => `${a.label}: ${a.purpose}`).join(' | ')}`,
        },
        what: {
          type: 'string',
          description: `A group: ${GROUP_LINES}. Or a single tool name, such as send_draft. Setting a group also resets any single tools inside it.`,
        },
        state: { type: 'string', enum: ['on', 'off'] },
      },
      required: ['account', 'what', 'state'],
    },
  };
}

function accountProperty(accounts) {
  return {
    type: 'string',
    enum: accounts.map((a) => a.label),
    description: `Which Gmail account to act on. Required; there is no default. ${accounts.map((a) => `${a.label}: ${a.purpose}`).join(' | ')}`,
  };
}

export function buildToolList(cfg) {
  const tools = [LIST_ACCOUNTS, setPermissionTool(cfg)];
  for (const [name, t] of Object.entries(TOOLS)) {
    const usable = cfg.accounts.filter((a) => resolvePermission(a, name) === 'on');
    if (!usable.length) continue; // off on every account: not listed at all
    const schema = t.inputSchema;
    tools.push({
      name,
      description: t.description,
      inputSchema: {
        ...schema,
        properties: { account: accountProperty(usable), ...(schema.properties || {}) },
        required: ['account', ...(schema.required || [])],
      },
    });
  }
  return tools;
}

function buildInstructions(cfg) {
  const accts = cfg.accounts.map((a) => `${a.label} (${a.purpose})`).join('; ');
  return [
    `gmail-max serves ${cfg.accounts.length} Gmail account${cfg.accounts.length === 1 ? '' : 's'} through one set of tools: ${accts}.`,
    'Every tool takes a required `account` argument; there is no default account, so choose deliberately.',
    'Every result names the account and address it acted on; results of tools that compose mail also lead with the From address.',
    'Things can be turned off per account (list_accounts shows what is on and off); when the user asks, set_permission turns them on or off.',
  ].join(' ');
}

const ok = (obj) => ({ content: [{ type: 'text', text: jsonText(obj) }] });
const fail = (obj) => ({ content: [{ type: 'text', text: jsonText(obj) }], isError: true });

/** One clear line for a tool that is turned off on an account. */
export function offText(tool, label) {
  if (groupOf(tool) === 'send') {
    return `Not sent. Sending is turned off for the "${label}" account. The user can ask to have it turned back on.`;
  }
  const group = groupOf(tool);
  const what = group ? ` (${GROUPS[group].description})` : '';
  return `Not run. ${tool}${what} is turned off for the "${label}" account. The user can ask to have it turned back on.`;
}

function describeWhat(what) {
  if (Object.prototype.hasOwnProperty.call(GROUPS, what)) {
    const d = GROUPS[what].description;
    return d.charAt(0).toUpperCase() + d.slice(1);
  }
  return `The ${what} tool`;
}

/**
 * options:
 *   configDir   directory holding accounts.json (and the shared credentials.json)
 * Throws AccountsConfigError if the accounts file is invalid: the caller must
 * refuse to start rather than guess.
 */
export function createMultiServer({ configDir } = {}) {
  const initial = loadAccounts(configDir);
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: true } },
    instructions: buildInstructions(initial),
  });

  // Keyed by token file, not label: a label re-pointed at another folder must
  // never show the old account's address.
  const addresses = new Map();
  const ledger = new IdLedger();
  let lastListed = null;

  // Must run inside runWithAccount for that account.
  async function addressFor(ctx) {
    if (addresses.has(ctx.tokenPath)) return addresses.get(ctx.tokenPath);
    try {
      const p = await G.getProfile();
      if (p?.emailAddress) {
        addresses.set(ctx.tokenPath, p.emailAddress);
        return p.emailAddress;
      }
    } catch { /* best effort: the address is informational */ }
    return null;
  }

  async function defaultFrom() {
    try { return await G.getDefaultFromAddress(); } catch { return null; }
  }

  async function notifyIfListChanged(cfg) {
    if (lastListed === null) return;
    const fp = JSON.stringify(buildToolList(cfg));
    if (fp === lastListed) return;
    lastListed = fp;
    try { await server.sendToolListChanged(); } catch { /* client may not listen */ }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let cfg;
    try {
      cfg = loadAccounts(configDir);
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, err.message);
    }
    const tools = buildToolList(cfg);
    lastListed = JSON.stringify(tools);
    return { tools };
  });

  async function listAccounts(cfg) {
    const accounts = [];
    for (const a of cfg.accounts) {
      // The address comes from getProfile (the whoami tool): only where that is on.
      let address = null;
      if (resolvePermission(a, 'whoami') === 'on') {
        const ctx = accountContext(configDir, cfg, a);
        address = await runWithAccount(ctx, () => addressFor(ctx));
      }
      accounts.push({ label: a.label, purpose: a.purpose, address, ...permissionSummary(a) });
    }
    return { accounts };
  }

  async function changePermission(cfg, args) {
    const { account, what, state } = args;
    if (typeof account !== 'string' || !account) return fail({ error: `account is required: one of ${cfg.accounts.map((a) => a.label).join(', ')}, or "all".` });
    if (typeof what !== 'string' || !isPermissionKey(what)) {
      return fail({ error: `"what" must be a group (${Object.keys(GROUPS).join(', ')}) or a tool name; got ${JSON.stringify(what)}.` });
    }
    if (state !== 'on' && state !== 'off') return fail({ error: `"state" must be "on" or "off"; got ${JSON.stringify(state)}.` });
    // Re-read, apply and save in one synchronous step: overlapping set_permission
    // calls (a model turning off sending for two accounts at once) must each
    // build on the other's saved result, never on a copy loaded before an await.
    let result;
    try {
      result = updateAccounts(configDir, (fresh) => setPermission(fresh, account, what, state));
    } catch (err) {
      // Filesystem errors carry a code; input and validation errors do not.
      return fail({ error: err.code ? `Could not save the change: ${err.message}` : err.message });
    }
    await notifyIfListChanged(result.cfg);
    const touched = result.changes.map((c) => c.label);
    const unchanged = result.changes.filter((c) => c.before === c.after).map((c) => c.label);
    let summary = `${describeWhat(what)} is now ${state} for ${touched.join(', ')}.`;
    if (unchanged.length) summary += ` (It was already ${state} for ${unchanged.join(', ')}.)`;
    return ok({
      summary,
      changes: result.changes.map((c) => ({ account: c.label, what: c.key, before: c.before, after: c.after })),
      accounts: result.cfg.accounts.filter((a) => touched.includes(a.label)).map((a) => ({ label: a.label, ...permissionSummary(a) })),
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = rawArgs || {};

    let cfg;
    try {
      cfg = loadAccounts(configDir);
    } catch (err) {
      return fail({ error: err.message });
    }
    await notifyIfListChanged(cfg);

    if (name === LIST_ACCOUNTS.name) return ok(await listAccounts(cfg));
    if (name === 'set_permission') return changePermission(cfg, args);

    // Own properties only: "constructor", "toString" and friends are not tools.
    if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const tool = TOOLS[name];

    const labels = cfg.accounts.map((a) => a.label);
    const { account: label, ...rest } = args;
    if (label === undefined || label === null || label === '') {
      return fail({ error: `account is required; there is no default. Choose one of: ${labels.join(', ')}.` });
    }
    if (typeof label !== 'string') {
      return fail({ error: `account must be a string label. Choose one of: ${labels.join(', ')}.` });
    }
    const acct = findAccount(cfg, label);
    if (!acct) return fail({ error: `Unknown account "${label}". Choose one of: ${labels.join(', ')}.` });

    // Runs only when on. Anything else is treated as off.
    if (resolvePermission(acct, name) !== 'on') {
      return fail({ account: label, refused: true, reason: offText(name, label) });
    }
    const ctx = accountContext(configDir, cfg, acct);
    const toolArgs = COMPOSE_TOOLS.has(name) ? normalizeComposeArgs(rest) : rest;

    return runWithAccount(ctx, async () => {
      try {
        // Malformed mail and credential paths are refused before anything is sent.
        if (COMPOSE_TOOLS.has(name)) validateComposeArgs(toolArgs, ctx.protectedRoots);

        let from = null;
        let draft = null;
        if (name === 'send_draft') {
          // Read the draft's From for the result. A draft from another account
          // fails here, before anything is sent.
          draft = await G.getDraft({ id: toolArgs.id, format: 'metadata' });
          const h = (draft?.message?.payload?.headers || []).find((x) => String(x.name).toLowerCase() === 'from');
          from = h ? h.value : null;
        } else if (COMPOSE_TOOLS.has(name)) {
          from = formatAddress(name === 'create_reply_draft' ? toolArgs.fromAlias : toolArgs.from) || (await defaultFrom());
        }

        const result = await tool.handler(toolArgs);
        ledger.record(label, result);
        if (draft) ledger.record(label, draft);
        const address = await addressFor(ctx);
        return ok(COMPOSE_TOOLS.has(name)
          ? { account: label, from, address, result }
          : { account: label, address, result });
      } catch (err) {
        const hint = ledger.hint(label, toolArgs, err);
        return fail({
          account: label,
          error: hint ? `${err.message}\n\n${hint}` : err.message,
          code: err.code,
          details: err.errors || err.response?.data || null,
        });
      }
    });
  });

  return server;
}
