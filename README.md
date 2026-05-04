# gmail-mcp

Local Gmail CLI + MCP server with the full Gmail API surface unlocked. Built because the default `claude.ai Gmail` MCP can't attach files to drafts, can't create threaded reply drafts, and exposes none of Gmail's settings APIs (vacation, signatures, forwarding addresses, delegates, filters, IMAP/POP, S/MIME, watch, history).

## Architecture

```
lib/
  auth.js   ADC client factory (google.auth.GoogleAuth) + error mappers
  mime.js   multipart MIME builder (attachments + threaded reply headers)
  gmail.js  thin wrappers over googleapis (~50 fns) wrapped in an
            error-mapping Proxy so 403/401 surfaces with fix-it lines
bin/
  gmail-cli.js   shell interface (testable standalone, scriptable);
                 also hosts the `auth-status` diagnostic
  gmail-mcp.js   MCP server (registered as `gmail-max` in ~/.claude.json)
```

CLI and MCP share `lib/`. CLI is the test surface; MCP is the agent surface.

## Auth model

[Application Default Credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials). `gcloud auth application-default login --scopes=https://mail.google.com/` drops a refresh token at `~/.config/gcloud/application_default_credentials.json`. The `googleapis` Node library auto-discovers it; refresh is transparent. No custom OAuth flow, no token cache for us to manage, no Cloud Console click-through.

## One-time setup

```bash
brew install --cask gcloud-cli                                                          # ~700MB
gcloud auth application-default login --scopes=https://mail.google.com/                 # browser consent
cd ~/Webdev/gmail-mcp && npm install
node bin/gmail-cli.js auth-status                                                       # diagnose remaining gaps
claude mcp add gmail-max -- node /Users/ml/Webdev/gmail-mcp/bin/gmail-mcp.js
```

See `SETUP.md` for the full walkthrough including the `auth-status` failure modes.

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

## Profile cache

`~/.gmail-mcp/profile.json` (mode 600) caches `{email, historyId}` for 7 days. `whoami --fresh` forces a refetch.
