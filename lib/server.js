// The two server modes.
//
// createLegacyServer(): single account. Identical to the single-account release
//   (proved by test/legacy-snapshot.test.js). Used when the config directory has
//   no accounts.json.
// createMultiServer(): up to five accounts through one tool list. Every tool takes
//   a required `account` argument with no default; each account carries its own
//   allow / ask / block permissions (lib/accounts.js); "ask" asks the user through
//   MCP elicitation and refuses when the client cannot ask.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import * as G from './gmail.js';
import { runWithAccount } from './context.js';
import {
  loadAccounts, accountContext, resolvePermission, permissionSummary, findAccount,
} from './accounts.js';
import {
  approvalMessage, approvalSchema, outgoingFromArgs, outgoingFromDraft, formatAddress, refusalText,
  interpretAnswer, validateComposeArgs, describeOutgoing, headerValue,
} from './approval.js';
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

export const ASK_TIMEOUT_MS = 5 * 60 * 1000;

// Tools whose result leads with the From address the message carries.
const COMPOSE_TOOLS = new Set(['send_message', 'send_draft', 'create_draft', 'create_reply_draft', 'update_draft']);

const LIST_ACCOUNTS = {
  name: 'list_accounts',
  description: 'List the Gmail accounts this server serves: label, purpose, address, and the permission for each group of tools (allow: runs; ask: the user approves in a dialog first, refused if this client cannot ask; block: refused). Only the user can change permissions.',
  inputSchema: { type: 'object', properties: {} },
};

function accountProperty(tool, accounts) {
  const lines = accounts.map((a) => {
    const ask = resolvePermission(a, tool) === 'ask' ? ' [asks the user first]' : '';
    return `${a.label}: ${a.purpose}${ask}`;
  });
  return {
    type: 'string',
    enum: accounts.map((a) => a.label),
    description: `Which Gmail account to act on. Required; there is no default. ${lines.join(' | ')}`,
  };
}

export function buildToolList(cfg) {
  const tools = [LIST_ACCOUNTS];
  for (const [name, t] of Object.entries(TOOLS)) {
    const usable = cfg.accounts.filter((a) => resolvePermission(a, name) !== 'block');
    if (!usable.length) continue; // blocked on every account: not listed at all
    const schema = t.inputSchema;
    tools.push({
      name,
      description: t.description,
      inputSchema: {
        ...schema,
        properties: { account: accountProperty(name, usable), ...(schema.properties || {}) },
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
    'Some actions on some accounts ask the user first or are blocked. Call list_accounts to see the current permissions.',
  ].join(' ');
}

const ok = (obj) => ({ content: [{ type: 'text', text: jsonText(obj) }] });
const fail = (obj) => ({ content: [{ type: 'text', text: jsonText(obj) }], isError: true });

/**
 * options:
 *   configDir     directory holding accounts.json (and the shared credentials.json)
 *   askTimeoutMs  how long to wait for the user's answer before treating it as no answer
 * Throws AccountsConfigError if the accounts file is invalid: the caller must
 * refuse to start rather than guess at permissions.
 */
export function createMultiServer({ configDir, askTimeoutMs = ASK_TIMEOUT_MS } = {}) {
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
      // The address comes from getProfile, which is the whoami tool: only fetch
      // it where that read is allowed outright (never trigger a dialog for it).
      let address = null;
      if (resolvePermission(a, 'whoami') === 'allow') {
        const ctx = accountContext(configDir, cfg, a);
        address = await runWithAccount(ctx, () => addressFor(ctx));
      }
      accounts.push({ label: a.label, purpose: a.purpose, address, permissions: permissionSummary(a) });
    }
    return { accounts };
  }

  // Ask the user. Returns { approved: true } or { approved: false, reason }.
  async function ask({ tool, label, address, outgoing, args, extra }) {
    // The SDK's elicitInput also refuses when the client lacks the capability;
    // checking first keeps the decision here and skips a pointless request.
    if (!server.getClientCapabilities()?.elicitation?.form) return { approved: false, reason: 'cannot-ask' };
    if (extra?.signal?.aborted) return { approved: false, reason: 'abandoned' };
    let res;
    try {
      res = await server.elicitInput(
        { mode: 'form', message: approvalMessage({ tool, label, address, outgoing, args }), requestedSchema: approvalSchema(tool) },
        // The tool call's own signal: if the client gives up on the call, the
        // dialog request is cancelled with it.
        { relatedRequestId: extra?.requestId, timeout: askTimeoutMs, signal: extra?.signal },
      );
    } catch (err) {
      if (extra?.signal?.aborted) return { approved: false, reason: 'abandoned' };
      if (err?.code === ErrorCode.RequestTimeout) return { approved: false, reason: 'no-answer' };
      return { approved: false, reason: 'cannot-ask' };
    }
    // An answer that arrives after the client abandoned the call never acts.
    if (extra?.signal?.aborted) return { approved: false, reason: 'abandoned' };
    return interpretAnswer(res);
  }

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
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

    // Own properties only: "constructor", "toString" and friends are not tools.
    if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const tool = TOOLS[name];

    const labels = cfg.accounts.map((a) => a.label);
    const { account: label, ...toolArgs } = args;
    if (label === undefined || label === null || label === '') {
      return fail({ error: `account is required; there is no default. Choose one of: ${labels.join(', ')}.` });
    }
    if (typeof label !== 'string') {
      return fail({ error: `account must be a string label. Choose one of: ${labels.join(', ')}.` });
    }
    const acct = findAccount(cfg, label);
    if (!acct) return fail({ error: `Unknown account "${label}". Choose one of: ${labels.join(', ')}.` });

    const permission = resolvePermission(acct, name);
    const draftAllowed = resolvePermission(acct, 'create_draft') !== 'block';
    const ctx = accountContext(configDir, cfg, acct);

    return runWithAccount(ctx, async () => {
      const refuse = (reason) => fail({ account: label, refused: true, reason: refusalText({ reason, tool: name, label, draftAllowed }) });
      // Runs only on an explicit allow, or ask followed by approval. Anything
      // else is treated as block.
      if (permission !== 'allow' && permission !== 'ask') return refuse('blocked');

      try {
        // Reject header injection, reserved headers and protected attachment
        // paths before anything is shown or sent.
        if (COMPOSE_TOOLS.has(name)) validateComposeArgs(toolArgs, ctx.protectedRoots);

        // send_draft: read the draft first. The dialog shows its real contents and
        // the result reports its real From. A draft from another account fails here,
        // before anything is asked or sent.
        let draft = null;
        let draftSummary = null;
        if (name === 'send_draft') {
          draft = await G.getDraft({ id: toolArgs.id, format: 'full' });
          draftSummary = outgoingFromDraft(draft);
        }

        let from = null;
        if (COMPOSE_TOOLS.has(name)) {
          if (draftSummary) from = headerValue(draftSummary, 'From');
          else from = formatAddress(name === 'create_reply_draft' ? toolArgs.fromAlias : toolArgs.from) || (await defaultFrom());
        }

        if (permission === 'ask') {
          const address = await addressFor(ctx);
          let outgoing = null;
          if (name === 'send_message') outgoing = outgoingFromArgs(toolArgs, from);
          if (name === 'send_draft') outgoing = draftSummary;
          const decision = await ask({ tool: name, label, address, outgoing, args: toolArgs, extra });
          if (!decision.approved) return refuse(decision.reason);

          // send_draft sends the draft as it is now. Re-read it and refuse if it
          // is not the message the user approved. (A window of milliseconds
          // remains between this read and the send; Gmail offers no way to pin
          // a draft version.)
          if (name === 'send_draft') {
            const now = await G.getDraft({ id: toolArgs.id, format: 'full' });
            if (now?.message?.id !== draft?.message?.id
              || describeOutgoing(outgoingFromDraft(now)) !== describeOutgoing(draftSummary)) {
              return refuse('changed');
            }
          }
        }
        if (extra?.signal?.aborted) return refuse('abandoned');

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
