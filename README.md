# gmail-mcp

Local Gmail CLI + MCP server with the full Gmail API surface unlocked. Built because the default `claude.ai Gmail` MCP can't attach files to drafts, can't create threaded reply drafts, and exposes none of Gmail's settings APIs (vacation, signatures, forwarding addresses, delegates, filters, IMAP/POP, S/MIME, watch, history).

## Architecture

```
lib/
  auth.js   OAuth 2.0 desktop flow + token cache + error mappers
  mime.js   multipart MIME builder (attachments + threaded reply headers)
  gmail.js  thin wrappers over googleapis (~50 fns) wrapped in an
            error-mapping Proxy so 403/401 surfaces with fix-it lines
bin/
  gmail-cli.js   shell interface (testable standalone, scriptable);
                 hosts `auth` (OAuth flow) and `auth-status` (diagnostic)
  gmail-mcp.js   MCP server (registered as `gmail-max` in ~/.claude.json)
```

CLI and MCP share `lib/`. CLI is the test surface; MCP is the agent surface.

## Why an OAuth client (not gcloud ADC)

Gmail's `https://mail.google.com/` scope is classified by Google as a **restricted scope** — every Gmail scope that grants meaningful access (`gmail.modify`, `gmail.compose`, `gmail.send`, `gmail.readonly`, full mail) sits in this tier. Restricted scopes require the OAuth app to be verified specifically for that scope, a CASA security review process. gcloud's pre-built OAuth client is verified for Cloud Platform APIs only — Google hard-blocks it from granting Gmail's restricted scopes.

The standard pattern for personal-use desktop apps: create your own OAuth client, add yourself as a test user on the consent screen, the app stays in "Testing" mode forever, full Gmail scope granted without verification. See `SETUP.md`.

## One-time setup

See `SETUP.md`. Summary: create a Desktop OAuth client in Cloud Console (~5 min), drop `client_secret_*.json` at `~/.gmail-mcp/credentials.json`, run `node bin/gmail-cli.js auth` for the consent flow.

```bash
node bin/gmail-cli.js auth-status        # diagnose
node bin/gmail-cli.js whoami             # confirm
claude mcp add gmail-max -- node /Users/ml/Webdev/gmail-mcp/bin/gmail-mcp.js
```

## Tool surface

~55 Gmail v1 endpoints exposed:

- **Profile**: whoami
- **Messages**: list, get, send, modify (labels), batch_modify, batch_delete, trash, untrash, delete, get_attachment
- **Drafts**: list, get, create, **create_reply** (threaded reply draft — the gap that triggered this build), update, send, delete
- **Threads**: list, get, modify, trash, untrash, delete
- **Labels**: list, get, create, update, delete
- **Filters**: list, get, create, delete
- **Settings**: get/update for vacation, IMAP, POP, language, auto-forwarding
- **Send-as / signatures**: list, get, create, update, delete, verify
- **Forwarding addresses**: list, get, create, delete
- **Delegates**: list, get, create, delete
- **S/MIME**: list, get, insert, set-default, delete
- **History / Watch**: list_history, watch, stop_watch

## Local data

- `~/.gmail-mcp/credentials.json` — your OAuth client (mode 600, never committed)
- `~/.gmail-mcp/token.json` — refresh token cache (mode 600)
- `~/.gmail-mcp/profile.json` — `{email, historyId, cachedAt}` (mode 600, 7-day TTL). `whoami --fresh` forces a refetch.
