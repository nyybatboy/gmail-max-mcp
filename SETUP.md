# Setup

## 1. Install dependencies

Already done if you see `node_modules/`. Otherwise:

```bash
cd ~/Webdev/gmail-mcp && npm install
```

## 2. Create a Google Cloud OAuth desktop client (one-time, ~5 min)

This is the one step that genuinely requires you to click through Google's UI. The OAuth client is what authorizes *this local app* (running on your Mac) to act on *your* Gmail with whatever scopes you grant. It's tied to your Google account, not to anyone else's.

1. Go to <https://console.cloud.google.com/projectcreate> — create a project (any name, e.g. `mike-gmail-mcp`).
2. With that project selected, enable the Gmail API: <https://console.cloud.google.com/apis/library/gmail.googleapis.com> → **Enable**.
3. Configure the OAuth consent screen: <https://console.cloud.google.com/apis/credentials/consent>.
   - User type: **External**
   - App name: anything (e.g. `gmail-mcp`)
   - User support email + developer email: your email
   - Skip the optional fields. **Save.**
   - Under **Test users**, add your own Gmail address. (Personal-use apps stay in "Testing" status forever, which is fine — refresh tokens won't expire on you as long as you're a listed test user.)
4. Create credentials: <https://console.cloud.google.com/apis/credentials>.
   - **Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: `gmail-mcp`
   - **Create**, then **Download JSON**.

## 3. Drop the credentials and authorize

```bash
mkdir -p ~/.gmail-mcp
chmod 700 ~/.gmail-mcp
mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/credentials.json
chmod 600 ~/.gmail-mcp/credentials.json

cd ~/Webdev/gmail-mcp
node bin/gmail-cli.js auth
```

A browser tab opens. Sign in to your Gmail account, accept the consent (you'll see "Google hasn't verified this app" — that's expected for a personal-use Desktop client; click Advanced → Go to gmail-mcp). The CLI captures the redirect, writes the refresh token to `~/.gmail-mcp/token.json`, and exits.

## 4. Smoke-test the CLI

```bash
node bin/gmail-cli.js whoami
node bin/gmail-cli.js list-messages --q "is:unread" --max 5
```

## 5. Register the MCP with Claude Code

```bash
claude mcp add gmail-max -- node /Users/ml/Webdev/gmail-mcp/bin/gmail-mcp.js
```

Restart Claude Code (or this session). Tools will appear as `mcp__gmail-max__*`.

## Troubleshooting

- **invalid_grant on auth flow**: make sure your Gmail address is added as a test user on the OAuth consent screen.
- **Token cached in non-interactive context**: `~/.gmail-mcp/token.json`; delete it and re-run `auth` if you ever change scopes.
- **Quota**: 1B units/day, 250 units/user/sec. Effectively unbounded for personal use.
