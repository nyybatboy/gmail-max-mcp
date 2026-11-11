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
  accounts.js  accounts.json: registry, permission groups, allow/ask/block resolution
  context.js   per-call account context used by auth.js and gmail.js
  approval.js  the "ask" dialog text, answer reading, compose checks, refusal messages
  fs-guard.js  keeps file reads/writes out of gmail-max's own folders (multi-account mode)
  prompt.js    the CLI's y/N prompt for "ask"
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

**Permissions, per account.** Each account has its own permission for every tool, in one of three states:

| State | What happens |
|---|---|
| `allow` | Runs. |
| `ask` | The server asks you in a dialog first (MCP elicitation) and runs only if you tick the box and submit. If your client cannot show the dialog, the call is refused. |
| `block` | Refused. A tool blocked on every account is not listed at all; an account blocked for a tool is left out of that tool's `account` choices. |

Tools are grouped so the file stays short. A setting can name a group or one tool; a tool setting beats its group, which beats the built-in default.

| Group | Default | Tools |
|---|---|---|
| `read` | allow | every `list_*`, `get_*`, `batch_get_*`, `whoami`, `list_history` |
| `draft` | allow | `create_draft`, `create_reply_draft`, `update_draft`, `delete_draft` |
| `organize` | allow | `modify_*`, `batch_modify_messages`, `trash_*`, `untrash_*`, `create_label`, `update_label`, `delete_label` |
| `send` | **ask** | `send_message`, `send_draft` |
| `delete` | **ask** | `delete_message`, `batch_delete_messages`, `delete_thread` (permanent, skip Trash) |
| `routing` | **ask** | `create_filter`, `delete_filter`, `update_auto_forwarding`, `create_forwarding_address`, `delete_forwarding_address`, `create_delegate`, `delete_delegate`, `create_send_as`, `update_send_as`, `delete_send_as`, `verify_send_as` |
| `settings` | allow | `update_vacation`, `update_imap`, `update_pop`, `update_language`, `insert_smime`, `set_default_smime`, `delete_smime`, `watch`, `stop_watch` |

`accounts.json` (in the config directory, mode 600):

```json
{
  "version": 1,
  "saveFolders": ["~/Downloads/gmail-max"],
  "accounts": {
    "personal": { "purpose": "Main inbox.", "dir": "/path/to/existing/folder", "permissions": { "send": "ask", "routing": "block" } },
    "work":     { "purpose": "Work inbox: clients and invoices.", "permissions": { "send": "allow", "delete_thread": "block" } }
  }
}
```

`dir` is optional (default `<config dir>/accounts/<label>/`); it holds that account's `token.json` and `profile.json`, and may hold its own `credentials.json`, which then takes precedence over the shared one. Edit the file by hand or use the CLI; the server re-reads it on every call, so a change applies to the next call, and it tells the client the tool list changed. An invalid file stops the server from starting; a file broken while it runs makes every call fail until it is fixed.

```bash
node bin/gmail-cli.js accounts list | add | remove <label> [--delete-token]
node bin/gmail-cli.js permissions show [<label>]
node bin/gmail-cli.js permissions set <label> <group|tool> allow|ask|block
node bin/gmail-cli.js permissions clear <label> <group|tool>
node bin/gmail-cli.js permissions block-all-sends
node bin/gmail-cli.js save-folders list | add <folder> | remove <folder>
```

`block-all-sends` is a one-time action, not a switch: it sets `send` to `block` on every account (clearing per-tool send overrides) and stops. Each account can be changed again individually afterwards.

**The ask dialog.** For a send it shows everything that leaves the account: the account and its address, every header in the order it is sent (From, To, Cc, Bcc, Reply-To, Subject, In-Reply-To, References and any extra header; a header that appears twice is flagged), every attachment and inline image with its content type, where its bytes come from and their size, and the body the recipient will see (the HTML when there is one) with its total length and the first 500 characters. The HTML preview errs towards showing too much: only real tags are removed, text hidden by CSS is shown (with a note), every link target and remote resource (`href`, `src`, `srcset`, `background`, CSS `url()`, ...) is listed under the body, and markup a mail app might treat unusually (an unterminated comment, style or script, CDATA) adds a warning and the HTML source. When the plain-text version differs from the HTML, the dialog says so and shows both. For `send_draft` the server reads the draft first and shows what it actually contains, to the same standard, every part listed with its type; after you approve it compares a hash of the draft's complete raw message with the one you approved and refuses if anything changed. The form has one checkbox that defaults to unticked; only an explicit tick and submit proceeds, so a client that auto-submits defaults sends nothing. Declined, cancelled, or no answer within five minutes: nothing happens, and the model is told not to retry unless you ask. If the client abandons the tool call while the dialog is open, a later approval does nothing.

For other actions set to `ask`, the dialog prints the deciding fields first and in full (for example a filter's forward target, a send-as reply-to address, a delegate, the number of messages a batch delete touches), counts every list, and truncates only the rest. Secrets and binary data are never shown.

**Composing in multi-account mode.** To keep the dialog honest, a compose call is refused if a header-bound argument contains a line break; if `headers` tries to set To, Cc, Bcc, From, Reply-To, Sender, Subject or the MIME structure headers (use the dedicated arguments); if an address is not a string, `{ email, name }` or a flat list of those; if an attachment name contains a quote; if a `mimeType` is not a plain `type/subtype` (no parameters, not `multipart/*` or `message/*`); if inline `contentBase64` is not base64 without spaces; or if an inline image is not `image/*` (give `mimeType` when supplying base64).

**Saving attachments: save folders only.** In multi-account mode, `get_attachment` with `savePath` writes only inside the **save folders**, which this narrows on purpose. Without that, a save could create a file that runs later (a shell startup file, a login item, an MCP client's config) and so change the permissions without a shell. The rules:
- The default save folder is `~/Downloads/gmail-max`, created (mode 700) the first time something is saved there.
- A **relative** `savePath` (for example `invoices/march.pdf`) is saved under the **first** save folder; it no longer means "relative to the server's working directory". An absolute `savePath` must be inside one of the save folders after resolving symlinks.
- A save never overwrites anything (create-only), never lands in the config directory, an account folder or the package folder even if a save folder contains them, and is refused if the path has a `..` segment. Subfolders inside a save folder must already exist.
- To widen it, list more folders: `gmail-cli save-folders add <folder>` (or `remove`, `list`), or edit `accounts.json`: `"saveFolders": ["~/Downloads/gmail-max", "~/Documents/Mail"]` (absolute paths or `~/...`; the first is where relative paths go; listing any folder replaces the default). Only you can change this; no tool writes it. Adding a broad folder such as your home directory brings the "file that runs later" risk back.
- `list_accounts` and the `savePath` description tell the model where it can save.

Single-account mode is unchanged: `savePath` writes wherever it points, as before.

**gmail-max's own files are off limits.** In multi-account mode, attachment and inline-image `path` reads inside the config directory or an account folder are refused (symlinks resolved, `..` refused), so a token or the accounts file cannot be mailed.

**When the client cannot ask** (no elicitation support, a headless run, or a client that cancels or never answers): the call is refused with the reason. For a send, the refusal tells the model to leave a draft with `create_draft` instead (when drafts are allowed on that account) so you can send it from Gmail. The server never creates that draft on its own.

**The CLI.** It applies the same allow/ask/block rules: `ask` prompts y/N in an interactive terminal and is refused anywhere else. Treat that prompt as a courtesy check, not a barrier: a process driving a pseudo-terminal can answer it, and anything that can run a shell on the machine can edit `accounts.json` anyway.

**The model cannot change permissions through this server.** No tool writes them, the file guard above keeps tools away from the accounts file, `list_accounts` shows permissions read-only, and refusal messages never point at how to change them. That is the scope of the protection: permissions guard against the model's mistakes made through this server. They are not a defence against anything with a shell on the same machine, which can edit the file or use a token directly. An `ask` is also only as honest as your client: a client configured to auto-answer dialogs has skipped the question by your choice.

**Choosing your permissions.** The defaults are a starting point. Three things worth knowing:
- `update_vacation` (group `settings`, allow by default) turns on an auto-responder that sends replies in your name to whoever writes in. If that should need your approval, set it to `ask` on that account.
- `delete_draft` and `update_draft` (group `draft`, allow) can destroy or overwrite a draft you wrote by hand. Set them to `ask` if you keep hand-written drafts in an account.
- Permissions are per account, not per piece of content. An account where send is `allow` can carry text the model read from an account where send is `ask`. If that matters, keep send on `ask` everywhere it could.

**Want ask-before-send with a single account?** Add just that one account; multi-account mode works with one.

**Not-found hints.** If a call fails because an ID belongs to another account seen earlier in the same session, the error says so. Gmail already rejects the ID; this only makes the message clearer, and IDs the server has not seen pass through unchanged.

## Tool catalog

All tools accept JSON arguments matching their declared input schema. Names below are the MCP tool names. The CLI exposes the same surface with kebab-case subcommands; `node bin/gmail-cli.js --help` prints the full mapping.

In multi-account mode every tool below also takes a required `account` (one of your labels), and one extra tool exists:

- **`list_accounts`** — `{}` → `{ accounts: [{ label, purpose, address, permissions: { groups, overrides } }] }`. Read-only.

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

In multi-account mode, pick `account` from the purpose lines in its description, or call `list_accounts`. Check the `account` and `from` at the top of each result before reporting work as done. A refusal with `refused: true` is final for that call: follow its suggestion (usually a draft), and do not retry unless the user asks.

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
- `~/Downloads/gmail-max/` (multi-account mode, default save folder) — attachments saved with `get_attachment`; see [Multiple accounts](#multiple-accounts).

None of these are committed; the project's `.gitignore` covers `credentials.json`, `token.json`, `profile.json`, and `client_secret*.json` at any path.

### If you want to narrow the blast radius

Use the per-account permissions in [Multiple accounts](#multiple-accounts) (they work with a single account too): `ask` puts a human confirmation in front of a tool or group, `block` refuses it and removes it from the tool list. By default sends, permanent deletes and routing changes ask. Be clear about what this is: a guard against an agent's mistakes, enforced by this server. It is not a defence against anyone who can run commands on the same machine, since they can edit `accounts.json` or use the token directly, and the OAuth scope itself is unchanged.

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
