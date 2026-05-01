# gmail-mcp

Local Gmail CLI + MCP server with the full Gmail API surface unlocked. Built because the default `claude.ai Gmail` MCP can't attach files to drafts, can't create threaded reply drafts, and exposes none of Gmail's settings APIs (vacation, signatures, forwarding addresses, delegates, filters, IMAP/POP, S/MIME, watch, history).

## Architecture

```
lib/
  auth.js   OAuth2 desktop flow + refresh token cache at ~/.gmail-mcp/
  mime.js   multipart MIME builder (attachments + threaded reply headers)
  gmail.js  thin wrappers over googleapis: one fn per Gmail endpoint we expose
bin/
  gmail-cli.js   shell interface (testable standalone, scriptable)
  gmail-mcp.js   MCP server (registered in ~/.claude.json for agent use)
```

CLI and MCP share `lib/`. CLI is the test surface; MCP is the agent surface.

## One-time setup

1. Install deps: `npm install`
2. Create a Google Cloud OAuth desktop client (see SETUP.md, ~5 min)
3. Drop `credentials.json` at `~/.gmail-mcp/credentials.json`
4. Run `npm run auth` and complete the browser consent
5. Register the MCP: `claude mcp add gmail-max -- node ~/Webdev/gmail-mcp/bin/gmail-mcp.js`

## Token storage

`~/.gmail-mcp/token.json` (mode 600). Refresh tokens don't expire unless revoked or unused for 6 months.
