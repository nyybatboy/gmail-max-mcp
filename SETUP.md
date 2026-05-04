# Setup

## One-time

```bash
# 1. Install gcloud (~700MB on disk).
brew install --cask gcloud-cli

# 2. Authorize (browser opens, you click consent, refresh token cached locally).
gcloud auth application-default login --scopes=https://mail.google.com/
```

That's the whole setup, assuming `gcloud config get-value project` returns a project that has the Gmail API enabled. If not, `auth-status` (next section) tells you exactly what's still missing.

## Verify and fix

```bash
cd ~/Webdev/gmail-mcp
npm install                              # one-time
node bin/gmail-cli.js auth-status        # diagnostic, prints fix command for any failure
node bin/gmail-cli.js whoami             # confirms live API call works
```

`auth-status` walks six gates in order and stops at the first failure:

1. gcloud installed
2. ADC credentials present
3. Gmail scope granted
4. Quota project set
5. Gmail API enabled on quota project
6. Live API call (`getProfile`) succeeds

The fix command for each failure prints inline. Common ones:

- **No quota project:** `gcloud auth application-default set-quota-project $(gcloud config get-value project)`
- **Gmail API not enabled:** `gcloud services enable gmail.googleapis.com`

## Register the MCP

```bash
claude mcp add gmail-max -- node /Users/ml/Webdev/gmail-mcp/bin/gmail-mcp.js
```

Restart Claude Code (or end this session and start a new one). Tools surface as `mcp__gmail-max__*`.

## Adding new scopes later

If a future capability needs a scope beyond `https://mail.google.com/`, update `SCOPES` in `lib/auth.js` AND re-run with the FULL scope list (gcloud overwrites, doesn't append):

```bash
gcloud auth application-default login --scopes=https://mail.google.com/,<new scope>
```

## Advanced: Push notifications (`watch`)

Gmail's push-notification feature requires a Cloud Pub/Sub topic and an IAM grant for `gmail-api-push@system.gserviceaccount.com`. Out of scope for this setup. Use `gcloud pubsub topics create` and follow the [Gmail push docs](https://developers.google.com/workspace/gmail/api/guides/push) when you actually need it.

## Troubleshooting

- **Quota / billing warnings:** `auth-status` shows your quota project. If it differs from `gcloud config get-value project`, that's usually fine — they can legitimately differ. The flag is informational.
- **403 PERMISSION_DENIED on first call:** Gmail API isn't enabled on your quota project. Run `gcloud services enable gmail.googleapis.com`.
- **401 UNAUTHENTICATED:** ADC token revoked, expired, or scope mismatch. Re-run `gcloud auth application-default login --scopes=https://mail.google.com/`.
- **Quota:** 1B units/day, 250 units/user/sec. Effectively unbounded for personal use.
