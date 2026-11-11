# gmail-max-mcp

The full Gmail API surface as an MCP server (~55 tools). Install this when the default Gmail MCP your client ships with stops at search/read/send and you need threaded reply drafts, attachments on drafts, filters, signatures, vacation, forwarding, delegates, S/MIME, history, or watch.

## Architecture

```
lib/
  auth.js      OAuth 2.0 desktop flow + token cache + error mappers
  mime.js      multipart MIME builder (attachments + threaded reply headers + plaintext->HTML rendering)
  gmail.js     thin wrappers over googleapis (~50 fns) wrapped in an
               error-mapping safe() wrapper so 403/401 surface with fix-it lines
  tools.js     the MCP tool table (name, description, input schema, handler)
  server.js    single-account server, and the multi-account server
  accounts.js  accounts.json: registry, permission groups, on/off resolution
  context.js   per-call account context used by auth.js and gmail.js
  compose-checks.js  refuses malformed mail and credential paths (multi-account mode)
  fs-guard.js  keeps attachments and saves away from tokens and client files (multi-account mode)
  id-ledger.js which account an ID came from (error hints only)
bin/
  gmail-cli.js   shell interface (testable standalone, scriptable);
                 hosts `auth` (OAuth flow) and `auth-status` (diagnostic)
  gmail-mcp.js   MCP server (registered via your client's MCP config)
```

CLI and MCP share `lib/`. CLI is the test surface; MCP is the agent surface.

## One-time setup

See [SETUP.md](SETUP.md). Summary: create a Desktop OAuth client in Google Cloud Console (~5 min, browser-driven, can't be automated), drop `client_secret_*.json` at `~/.gmail-mcp/credentials.json`, run `node bin/gmail-cli.js auth` for the consent flow.

```bash
node bin/gmail-cli.js auth-status        # diagnose
node bin/gmail-cli.js whoami             # confirm
```

Register with your MCP client (Claude Code example):

```bash
claude mcp add gmail-max -- node /absolute/path/to/gmail-max-mcp/bin/gmail-mcp.js
```

After registration, tools surface as `mcp__gmail-max__*` (or your chosen name's prefix).

**More than one account:** one server can serve up to five. See [Multiple accounts](#multiple-accounts) below. `GMAIL_MCP_CONFIG_DIR` still moves the whole config directory (default `~/.gmail-mcp`).

## Multiple accounts

Off until you add an account; with no `accounts.json` in the config directory the server behaves exactly as a single-account server always has.

```bash
node bin/gmail-cli.js accounts add personal --purpose "Main inbox." --dir ~/.gmail-mcp   # adopt an existing token
node bin/gmail-cli.js accounts add work --purpose "Work inbox: clients and invoices."      # runs the consent flow
```

**Choosing the account.** Every tool takes a required `account` argument. There is no default, so a call cannot quietly land in the wrong mailbox. The argument is an enum of the account labels, and its description carries each account's purpose line, so the model chooses by meaning. A call without `account`, or with an unknown label, is refused.

**What comes back.** Every result names the account and address it acted on: `{ "account": "work", "address": "...", "result": { ... } }`. Tools that compose mail (`send_message`, `send_draft`, `create_draft`, `create_reply_draft`, `update_draft`) lead with the From address: `{ "account", "from", "address", "result" }`. Errors carry `account` too.

**Turning things on and off, per account.** Everything is on by default, for every account: reading, drafts, organizing, sending, permanent delete, routing and settings. You turn off what you don't want, and it stays off until you turn it back on. Each account has its own switches.

The simplest way is to tell the model: "turn off sending for the work account", "turn sending back on for the personal account", "turn off permanent delete everywhere". It calls `set_permission`:

```
set_permission({ account: "<label>" | "all", what: "<group or tool name>", state: "on" | "off" })
```

The change is saved in `accounts.json`, so it holds across restarts and for every client on this machine. The result says plainly what is now on and off for the accounts it touched. On the next call the tool list reflects it: an account where a tool is off disappears from that tool's `account` choices, and a tool that is off on every account is not listed at all. A call to a tool that is off is refused with one line, for example: `Not sent. Sending is turned off for the "work" account. The user can ask to have it turned back on.` Nothing else changes: a send that is on just sends.

Tools are grouped so one switch covers what people mean:

| Group | Tools |
|---|---|
| `read` | every `list_*`, `get_*`, `batch_get_*`, `whoami`, `list_history` |
| `draft` | `create_draft`, `create_reply_draft`, `update_draft`, `delete_draft` |
| `organize` | `modify_*`, `batch_modify_messages`, `trash_*`, `untrash_*`, `create_label`, `update_label`, `delete_label` |
| `send` | `send_message`, `send_draft` |
| `delete` | `delete_message`, `batch_delete_messages`, `delete_thread` (permanent, skip Trash) |
| `routing` | `create_filter`, `delete_filter`, `update_auto_forwarding`, `create_forwarding_address`, `delete_forwarding_address`, `create_delegate`, `delete_delegate`, `create_send_as`, `update_send_as`, `delete_send_as`, `verify_send_as` |
| `settings` | `update_vacation`, `update_imap`, `update_pop`, `update_language`, `insert_smime`, `set_default_smime`, `delete_smime`, `watch`, `stop_watch` |

`what` can also be a single tool name (for example `send_draft`). Setting a group resets any single tools inside it, so "turn sending back on" turns every send tool on. To turn sending off on every account at once, set `send` to off for `"all"` (the CLI has `permissions all-sends-off`); that is a one-time change, and each account can be turned back on on its own afterwards. `list_accounts` shows each account's address and what is on and off, so the model can answer "can you send from my work account?" without trying.

The same switches from the CLI, or by editing `accounts.json` (in the config directory, mode 600):

```bash
node bin/gmail-cli.js accounts list | add | remove <label> [--delete-token]
node bin/gmail-cli.js permissions show [<label>]
node bin/gmail-cli.js permissions set <label|all> <group|tool> on|off
node bin/gmail-cli.js permissions all-sends-off
```

```json
{
  "version": 1,
  "accounts": {
    "personal": { "purpose": "Main inbox.", "dir": "/path/to/existing/folder" },
    "work":     { "purpose": "Work inbox: clients and invoices.", "permissions": { "send": "off" } }
  }
}
```

Anything not listed is on. `dir` is optional (default `<config dir>/accounts/<label>/`); it holds that account's `token.json` and `profile.json`, and may hold its own `credentials.json`, which then takes precedence over the shared one. The server re-reads the file on every call. An invalid file stops the server from starting; a file broken while it runs makes every call fail until it is fixed. `all` cannot be used as a label.

**What an off switch protects against.** The model can change these switches; that is the point, so it can act on what you tell it. So an off switch protects against a model forgetting or misjudging which account it is in. It does not protect against a model that has been talked into turning sending back on by something it read, such as an email written to manipulate it. If you want an account's setting to hold even then, keep that account out of this server (give it a separate registration of its own) or watch `accounts.json` for changes. A lock that the tool will not change is a possible later addition, not part of this release.

**Credentials stay out of reach.** In multi-account mode no file inside the config directory or an account folder can be attached to a message, and `get_attachment` will not save into those folders. Paths are resolved the way the operating system resolves them, so a symlink or a `..` cannot get around this. Everywhere else, `savePath` saves where it is told and overwrites, as in single-account mode.

**Compose checks in multi-account mode.** A message that would go out malformed is refused with a line saying why: a line break inside a header field; an address that is not a string, `{ email, name }` or a flat list of those; a `headers` entry for a header that has its own argument or that defines the message structure (To, Cc, Bcc, From, Reply-To, Sender, Subject, In-Reply-To, References, Message-ID, Date, MIME-Version, Content-Type, Content-Transfer-Encoding), which would otherwise appear twice; an invalid header name; a quote or line break in an attachment's filename, type or Content-ID; or attachment content that is not base64. Whitespace inside base64 content is removed rather than refused.

**Worth knowing when you turn things off.**
- Turning off `send` does not turn off `update_vacation` (group `settings`), which sends automatic replies in your name to whoever writes in. Turn `settings` or `update_vacation` off too if that matters.
- `delete_draft` and `update_draft` (group `draft`) can overwrite or delete a draft you wrote by hand.
- Switches are per account, not per piece of content: an account where sending is on can carry text the model read from an account where it is off.

**Want switches with a single account?** Add just that one account; multi-account mode works with one.

**Not-found hints.** If a call fails because an ID belongs to another account seen earlier in the same session, the error says so. Gmail already rejects the ID; this only makes the message clearer, and IDs the server has not seen pass through unchanged.

## Tool catalog

All tools accept JSON arguments matching their declared input schema. Names below are the MCP tool names. The CLI exposes the same surface with kebab-case subcommands; `node bin/gmail-cli.js --help` prints the full mapping.

In multi-account mode every tool below also takes a required `account` (one of your labels), and one extra tool exists:

- **`list_accounts`** — `{}` → `{ accounts: [{ label, purpose, address, on: [groups], off: [groups], toolsOff: [tools], toolsOn: [tools] }] }`.
- **`set_permission`** — `{ account: <label> | "all", what: <group or tool>, state: "on" | "off" }` → `{ summary, changes: [{ account, what, before, after }], accounts: [{ label, on, off, toolsOff, toolsOn }] }`. Saved to `accounts.json`. Use when the user asks.

### Profile

- **`whoami`** — `{}` → Gmail profile (email, message totals, history id).

### Messages

- **`list_messages`** — `{ q?, labelIds?, maxResults?, pageToken?, includeSpamTrash? }` → `{ messages: [{id, threadId}], resultSizeEstimate, nextPageToken? }`. `q` uses Gmail search syntax: `from:`, `to:`, `subject:`, `has:attachment`, `newer_than:7d`, `is:unread`, label names, etc.
- **`get_message`** — `{ id, format?: "full"|"metadata"|"minimal"|"raw", metadataHeaders? }` → full message including parsed payload tree.
- **`batch_get_messages`** — `{ ids: [...], format?, metadataHeaders?, concurrency?: 10 }` → `{ messages: [...], errors: [{id, error}] }`. Use this instead of looping `get_message` — one tool call instead of N round-trips for the agent. `Promise.allSettled` so one failure doesn't kill the batch.
- **`send_message`** — `{ to, cc?, bcc?, from?, replyTo?, subject?, text?, html?, plaintextOnly?, attachments?, inlineImages?, inReplyTo?, references?, threadId?, headers? }` → sent message id. A text-only body is auto-rendered to `multipart/alternative` (Gmail-style HTML + plain-text fallback) — see "Email body rendering" below. See also "Address shape", "Attachment shape", and "Inline images".
- **`modify_message`** — `{ id, addLabelIds?: [...], removeLabelIds?: [...] }`.
- **`batch_modify_messages`** — `{ ids, addLabelIds?, removeLabelIds? }` → `{ ok, count }`.
- **`batch_delete_messages`** — `{ ids }` → `{ ok, count }`. PERMANENT, skips Trash, irreversible.
- **`trash_message`** / **`untrash_message`** / **`delete_message`** — `{ id }`.
- **`get_attachment`** — `{ messageId, attachmentId, savePath? }`. With `savePath`: writes to disk, returns `{ savedTo, size, attachmentId }`. Without: returns base64 in `.data`.

### Drafts

- **`list_drafts`** — `{ q?, maxResults?, pageToken? }`.
- **`get_draft`** — `{ id, format? }`.
- **`create_draft`** — `{ ...same as send_message, useSignature?: true }`. With `useSignature: true` (default) the user's default Gmail signature from send-as is auto-appended (text mode: `\n\n-- \n<sig>`; html mode: `<div class="gmail_signature">...</div>` matching Gmail web UI bytes).
- **`create_reply_draft`** — `{ toMessageId, replyAll?: false, body?, html?, plaintextOnly?, attachments?, inlineImages?, extraTo?, extraCc?, extraBcc?, fromAlias?, includeQuotedParent?: true, useSignature?: true }`. **The one the typical default Gmail MCP cannot do.** Pulls In-Reply-To, References, threadId, and `Re:` subject from the parent so the draft docks into the original Gmail thread. AUTO-INCLUDES the parent body as a Gmail-style quote (`gmail_quote` / `gmail_attr` / `blockquote` markup, byte-matched to Gmail web UI) AND auto-appends the user's send-as signature, so the rendered draft looks like a normal Gmail reply. Addressing follows Gmail: normal parent → `To:` the parent's Reply-To/From, `replyAll` adds the parent's To+Cc; a **self-sent parent** (parent From is your account or any send-as alias) → `To:` the parent's original recipients, `replyAll` carries the parent's Cc. Your own account and aliases are never a recipient of your own reply.
- **`update_draft`** — `{ id, ...same as create_draft }`. Replaces.
- **`send_draft`** — `{ id }`.
- **`delete_draft`** — `{ id }`.

### Threads

- **`list_threads`** — `{ q?, labelIds?, maxResults?, pageToken?, includeSpamTrash? }`.
- **`get_thread`** — `{ id, format?, metadataHeaders? }` → all messages in the thread.
- **`batch_get_threads`** — `{ ids, format?, metadataHeaders?, concurrency?: 10 }` → `{ threads, errors }`. Useful for analysis flows that need full conversation context across many threads at once.
- **`modify_thread`** — `{ id, addLabelIds?, removeLabelIds? }`. Applies to all messages in the thread.
- **`trash_thread`** / **`untrash_thread`** / **`delete_thread`** — `{ id }`.

### Labels

- **`list_labels`** — `{}` → system + user labels.
- **`get_label`** — `{ id }`.
- **`create_label`** — `{ name, labelListVisibility?, messageListVisibility?, color? }`. `color: { backgroundColor, textColor }` hex; must be from Gmail's palette.
- **`update_label`** — `{ id, name?, labelListVisibility?, messageListVisibility?, color? }`.
- **`delete_label`** — `{ id }`.

### Filters

- **`list_filters`** — `{}`.
- **`get_filter`** — `{ id }`.
- **`create_filter`** — `{ criteria: { from?, to?, subject?, query?, hasAttachment?, ... }, action: { addLabelIds?, removeLabelIds?, forward? } }`.
- **`delete_filter`** — `{ id }`.

### Settings

- **`get_vacation`** / **`update_vacation`** — `{ enableAutoReply?, responseSubject?, responseBodyPlainText?, responseBodyHtml?, restrictToContacts?, restrictToDomain?, startTime?, endTime? }` (epoch ms).
- **`get_imap`** / **`update_imap`** — `{ enabled?, autoExpunge?, expungeBehavior?, maxFolderSize? }`.
- **`get_pop`** / **`update_pop`** — `{ accessWindow?, disposition? }`.
- **`get_language`** / **`update_language`** — `{ displayLanguage? }`.
- **`get_auto_forwarding`** / **`update_auto_forwarding`** — `{ enabled?, emailAddress?, disposition? }`.

### Send-as aliases (signatures live here)

- **`list_send_as`** — `{}` → all send-as entries including their signatures (HTML).
- **`get_send_as`** — `{ sendAsEmail }`.
- **`create_send_as`** — `{ sendAsEmail, displayName?, replyToAddress?, signature?, isDefault?, treatAsAlias? }`. **Workspace-only:** fails with 403 "domain-wide authority" on personal Gmail accounts.
- **`update_send_as`** — `{ sendAsEmail, displayName?, replyToAddress?, signature?, isDefault?, treatAsAlias? }`. **Works on personal Gmail** (different endpoint, looser auth) — this is how you change a signature.
- **`delete_send_as`** — `{ sendAsEmail }`. **Workspace-only.**
- **`verify_send_as`** — `{ sendAsEmail }`. Sends the verification email.

### Forwarding addresses

- **`list_forwarding_addresses`** — `{}`.
- **`get_forwarding_address`** — `{ forwardingEmail }`.
- **`create_forwarding_address`** — `{ forwardingEmail }`. Sends a verification email to the address.
- **`delete_forwarding_address`** — `{ forwardingEmail }`.

### Delegates

- **`list_delegates`** — `{}`.
- **`get_delegate`** — `{ delegateEmail }`.
- **`create_delegate`** — `{ delegateEmail }`. **Workspace-only** (requires service account with domain-wide delegation).
- **`delete_delegate`** — `{ delegateEmail }`. **Workspace-only.**

### S/MIME

- **`list_smime`** — `{ sendAsEmail }`.
- **`get_smime`** — `{ sendAsEmail, id }`.
- **`insert_smime`** — `{ sendAsEmail, pkcs12, encryptedKeyPassword? }` (PKCS#12 cert as base64).
- **`set_default_smime`** — `{ sendAsEmail, id }`.
- **`delete_smime`** — `{ sendAsEmail, id }`.

### History / Watch

- **`list_history`** — `{ startHistoryId, labelId?, historyTypes?: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"], maxResults?, pageToken? }`. Incremental sync of mailbox changes since `startHistoryId`.
- **`watch`** — `{ topicName, labelIds?, labelFilterAction?: "include"|"exclude" }`. Subscribe to push notifications via a Cloud Pub/Sub topic. Requires Pub/Sub setup; rarely needed for personal use.
- **`stop_watch`** — `{}`.

## Address shape

`to`, `cc`, `bcc`, `from`, `replyTo` accept any of:

- string: `"recipient@example.com"` or `"Recipient Name <recipient@example.com>"`
- object: `{ name: "Recipient Name", email: "recipient@example.com" }`
- array of either: `["a@example.com", { name: "B", email: "b@example.com" }]` (for to/cc/bcc only — from/replyTo are single-address)

Non-ASCII display names are auto-encoded as RFC 2047 encoded-words.

## Attachment shape

```
{ path: "/absolute/path/to/file.pdf" }                  // read at send time
{ filename: "x.pdf", contentBase64: "...", mimeType: "application/pdf" }  // inline
```

MIME type is guessed from extension if `path` is provided and `mimeType` is omitted.

## Inline images

Embed images directly in the email body via `Content-ID` references. Supply `inlineImages` alongside an `html` body that references them with `cid:` URIs:

```json
{
  "to": "recipient@example.com",
  "subject": "Report with chart",
  "html": "<p>See chart:</p><img src=\"cid:chart1\">",
  "text": "See chart (image attached inline).",
  "inlineImages": [
    { "path": "/path/to/chart.png", "cid": "chart1" }
  ]
}
```

Each entry has the same shape as an attachment (`path` or `contentBase64` + `filename` + `mimeType`) plus a `cid` field. If `cid` is omitted one is auto-generated, but supplying it is strongly recommended so your HTML can reference it. The MIME structure is `multipart/related` wrapping `multipart/alternative`; if regular `attachments` are also present, the outer layer is `multipart/mixed`.

## Conventions for agent callers

These are not enforced by the server — they are the conventions an agent should follow when composing emails through these tools, because Gmail's rendering and threading semantics demand them.

### Several accounts: choose `account` on every call

In multi-account mode, pick `account` from the purpose lines in its description, or call `list_accounts`. Check the `account` and `from` at the top of each result before reporting work as done. A refusal with `refused: true` means that tool is turned off for that account: tell the user, and turn it back on with `set_permission` only if they ask.

### Reply drafts: use `create_reply_draft`, not `create_draft`

A draft created via `create_draft` with `inReplyTo` and `threadId` set will be linked to the thread, but it will not include the parent body as quoted text — Gmail's API does not auto-quote. The recipient sees a stripped reply with no context. `create_reply_draft` is the correct tool for any threaded reply: it pulls the parent, builds the quoted body in Gmail's exact byte format (so it renders identically to a Gmail web UI reply), and handles signature placement (signature appears between user body and quoted parent, matching Gmail web UI order).

**Addressing a reply to your own message.** Replying to a message you sent yourself (e.g. bumping a thread) does not address the reply back to you. When the parent's `From` is your authenticated account or any send-as alias, `create_reply_draft` addresses `To:` the parent's original recipients and, on `replyAll`, carries the parent's `Cc`. Your own account and aliases are filtered out of every recipient field of your own reply, and `Cc` is de-duped against `To`. For a parent from someone else the behavior is standard: `To:` the parent's Reply-To/From, and `replyAll` adds the parent's To+Cc (minus you).

### Email body rendering: text in, HTML out

A text-only `text` body is automatically rendered into a `multipart/alternative` message: a Gmail-style HTML part (`<div dir="ltr"><div>…</div><div><br></div>…</div>`, matching what Gmail's own web compose emits, so it reflows to the reader's screen) plus the cleaned text as the plain-text fallback, in RFC 2046 order (plain first, HTML last). **You do not need to write HTML** — write the body the way a person types plainly into Gmail compose: one continuous line per paragraph, a blank line (`\n\n`) between paragraphs, a single `\n` only for intentional breaks (address blocks, list items).

The renderer also heals stray machine hard-wraps: if your tool's output is wrapped to ~70 cols (a common LLM behavior), mid-sentence continuation lines are rejoined automatically so the body does not render as a frozen narrow column. Clean authoring is still preferred (it keeps the plain-text fallback tidy), but it is no longer a hard requirement.

Escape hatches: pass **`html`** to supply your own markup (it overrides the auto-render and sets the HTML part directly; provide `text` too to control the plain fallback). Pass **`plaintextOnly: true`** to send a bare `text/plain` message with no HTML part (mailing lists, code-only mail).

### Signatures are auto-applied

`create_draft`, `create_reply_draft`, and `send_message` (when going through `applySignature` — currently `create_draft` only) auto-append the user's default Gmail signature from send-as. Pass `useSignature: false` if your body is already signature-complete (e.g. you're constructing a system-generated email, or the body contains a signature inline). Do not manually append `\n\n-- \n<sig>` — you'll double-sign.

### Workspace vs personal Gmail

Tools tagged "Workspace-only" above (`create_send_as`, `delete_send_as`, `create_delegate`, `delete_delegate`) require a Google Workspace service account with domain-wide delegation. They will return HTTP 403 "Access restricted to service accounts that have been delegated domain-wide authority" on personal Gmail accounts, regardless of the OAuth scopes granted. The remaining ~51 tools work for both account types. `update_send_as` is the exception that works on personal accounts because it uses a different (looser-auth) endpoint.

### Errors carry fix-it lines

API failures from any tool are rewritten by `lib/auth.js` `mapApiError` to include a `Fix:` hint after the original message. Common ones: `403 SERVICE_DISABLED` → enable Gmail API in Cloud Console; `403 insufficient scope` → delete `~/.gmail-mcp/token.json` and re-auth; `401 / invalid_grant` → token revoked or expired, re-auth.

## Security and threat model

Read this before installing.

### What this gives an agent

The OAuth scope is `https://mail.google.com/` plus `gmail.settings.basic` and `gmail.settings.sharing`. These together grant **send-as-you on your Gmail, full mailbox read/modify/delete, plus settings writes (vacation, filters, signatures, forwarding, delegates).** An MCP client connected to this server can:

- Read any message in your account (including past sensitive content)
- Send mail from your address
- Move or permanently delete mail
- Set up auto-forwarding to an external address
- Modify filters
- Modify your signature

The blast radius if the OAuth refresh token is exfiltrated or the agent is prompt-injected into a hostile action: an attacker has full agentic mail access until you delete the token file (`~/.gmail-mcp/token.json`) or revoke the OAuth grant in your Google Account settings.

### Why the spicy auth path

Gmail's full-access scope (`https://mail.google.com/`) is classified by Google as a **restricted scope**, a separate and stricter tier from "sensitive." Restricted scopes require the OAuth app to be verified specifically for that scope (a CASA security review, weeks-to-months process).

`gcloud`'s pre-built OAuth client (the easy "Application Default Credentials" path) cannot grant Gmail's restricted scopes. Google's policy hard-blocks it. The standard pattern for personal-use desktop apps: **you create your own OAuth client and publish the consent screen to "In production" status without submitting for verification.** Google's documented <100-user personal-use exemption permits this (support.google.com/cloud/answer/15549945). Refresh tokens issued under Production status have no expiry.

Do not leave the app in "Testing" publishing status. Testing-mode refresh tokens expire after 7 days regardless of test-user listing (support.google.com/cloud/answer/13464323), which produces a weekly `invalid_grant` failure mode.

This means: the OAuth client you create belongs to you, sits in a Cloud Console project you own, and the first-run consent flow shows a "Google hasn't verified this app" warning. Click **Advanced > Go to {app-name} (unsafe)** to proceed. That warning is the single user-visible cost of the exemption path. See SETUP.md for the full walkthrough.

### Local data layout

All stored at `~/.gmail-mcp/`, mode 700 directory:

- `credentials.json` (mode 600) — your OAuth client (`client_id`, `client_secret`). Not a secret per se — it's the public identity of your OAuth app, but treat as sensitive to avoid impersonation.
- `token.json` (mode 600) — refresh token. **This is the secret.** Anyone with this file plus your `client_id`/`client_secret` has full mail access until the token is revoked.
- `profile.json` (mode 600) — `{ email, historyId, cachedAt }`, 7-day TTL. `whoami --fresh` forces a refetch.
- `accounts.json` (mode 600, multi-account mode only) — account labels, purposes, folders and permissions. No secrets.
- `accounts/<label>/` (multi-account mode, unless the account sets its own `dir`) — that account's `token.json`, `profile.json`, and optionally its own `credentials.json`.

None of these are committed; the project's `.gitignore` covers `credentials.json`, `token.json`, `profile.json`, and `client_secret*.json` at any path.

### If you want to narrow the blast radius

Turn off what an account should not do, with the per-account switches in [Multiple accounts](#multiple-accounts) (they work with a single account too): a tool that is off is refused and removed from the tool list. Be clear about what this is: a guard against an agent's mistakes, enforced by this server. The model can turn switches back on when asked, so it is not a defence against a model that has been manipulated, nor against anyone who can run commands on the same machine (they can edit `accounts.json` or use the token directly), and the OAuth scope itself is unchanged.

Finer policies (for example, deny `send_message` unless `to` matches an allowlist) are not built in. The place to add them is the multi-account `CallToolRequestSchema` handler in `lib/server.js`, next to the permission check. A scope-narrowing fork could also simply omit tools from the `TOOLS` map in `lib/tools.js`.

### What this server does not do

- Does not log message contents anywhere. Errors include API response bodies, which may contain message metadata; if you wire stderr to a persistent log, treat that log as sensitive.
- Does not transmit data to any host other than `googleapis.com` (and `accounts.google.com` during initial OAuth).
- Does not phone home, check for updates, or send telemetry.

## Local data

- `~/.gmail-mcp/credentials.json` — your OAuth client (mode 600, never committed)
- `~/.gmail-mcp/token.json` — refresh token cache (mode 600)
- `~/.gmail-mcp/profile.json` — `{email, historyId, cachedAt}` (mode 600, 7-day TTL); `whoami --fresh` forces a refetch.
- `~/.gmail-mcp/accounts.json` and `~/.gmail-mcp/accounts/<label>/` — multi-account mode only; see [Multiple accounts](#multiple-accounts).

## License

MIT. See [LICENSE](LICENSE).
