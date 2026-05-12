# Setup

## Why a Cloud Console step

Gmail's full-access scope (`https://mail.google.com/`) is classified by Google as a **restricted scope**, a separate and stricter tier from "sensitive." Restricted scopes require the OAuth app itself to be verified specifically for that scope (a CASA security review, weeks-to-months process).

`gcloud`'s pre-built OAuth client cannot grant Gmail's restricted scopes. Google's policy hard-blocks it (you'll see "This app is blocked" if you try).

The standard workaround for personal use: **you create your own OAuth client and publish it to "In production" status without submitting for verification.** Google's documented policy permits this for apps with fewer than 100 cumulative users (the personal-use exemption; see support.google.com/cloud/answer/15549945). The one-time cost is a "Google hasn't verified this app" warning during the consent flow, which you click past via Advanced > Go to {app-name} (unsafe). ~5 minutes one-time setup.

**Do not keep the app in "Testing" publishing status.** Testing-mode refresh tokens expire after 7 days regardless of test-user listing (Google policy; see support.google.com/cloud/answer/13464323), which means you would have to re-authorize the CLI every week. Production status without verification is the correct path for a single-user personal-use desktop app.

## 1. Create a Google Cloud OAuth desktop client

1. Go to <https://console.cloud.google.com/projectcreate> and create a project (any name, e.g. `gmail-max-mcp`).
2. With that project selected, enable the Gmail API: <https://console.cloud.google.com/apis/library/gmail.googleapis.com> → **Enable**.
3. Configure the OAuth consent screen at <https://console.cloud.google.com/apis/credentials/consent>.
   - User type: **External**
   - App name: anything (e.g. `gmail-max-mcp`)
   - User support email + developer email: your email
   - **Save.**
4. **Publish the app to production.** On the OAuth consent screen overview page, find the **Publishing status** section (it starts in "Testing"). Click **Publish app**, then confirm. Status changes to "In production."
   - **Do NOT click "Submit for verification."** Leave the app unverified. Google's <100-user personal-use exemption covers single-user desktop apps without requiring the CASA verification review.
   - If you skip this step and leave the app in "Testing" mode, your refresh token will expire every 7 days and you will see `invalid_grant` errors weekly. This is policy, not a bug. See support.google.com/cloud/answer/13464323.
5. Create credentials at <https://console.cloud.google.com/apis/credentials>.
   - **Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: `gmail-max-mcp`
   - **Create**, then **Download JSON**.

## 2. Drop the credentials and authorize

```bash
mkdir -p ~/.gmail-mcp && chmod 700 ~/.gmail-mcp
mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/credentials.json
chmod 600 ~/.gmail-mcp/credentials.json

cd /path/to/gmail-max-mcp
npm install
node bin/gmail-cli.js auth
```

A browser tab opens. Sign in to your Gmail account. On first auth you will see a full-page warning titled **"Google hasn't verified this app"** with a default **Back to safety** button. This is expected for an app published to production without verification, and is the single user-visible cost of the <100-user exemption path. To proceed:

1. Click **Advanced** (small link, bottom-left of the warning).
2. Click **Go to {your-app-name} (unsafe)**.
3. Continue through the consent screen and grant the requested scopes.

Subsequent auths against the same Google account skip this warning. The CLI captures the redirect, writes the refresh token to `~/.gmail-mcp/token.json`, and exits.

If you accidentally click **Back to safety**, just re-run `node bin/gmail-cli.js auth` and walk through the Advanced path.

## 3. Verify

```bash
node bin/gmail-cli.js auth-status        # all green
node bin/gmail-cli.js whoami             # email + historyId
node bin/gmail-cli.js list-messages --q "is:unread" --max 5
```

`auth-status` walks four gates and prints the fix command for any failure:

1. OAuth client credentials present
2. Token cached with refresh_token
3. Gmail scope granted
4. Live API call works (caches email at `~/.gmail-mcp/profile.json`)

## 4. Register the MCP

```bash
claude mcp add gmail-max -- node /absolute/path/to/gmail-max-mcp/bin/gmail-mcp.js
```

Restart Claude Code (or end this session and start a new one). Tools surface as `mcp__gmail-max__*`.

## Adding new scopes later

Update `SCOPES` in `lib/auth.js`, then:

```bash
rm ~/.gmail-mcp/token.json
node bin/gmail-cli.js auth   # re-runs consent with the new scope list
```

## Advanced: Push notifications (`watch`)

Gmail's push-notification feature requires a Cloud Pub/Sub topic and an IAM grant for `gmail-api-push@system.gserviceaccount.com`. Out of scope for this setup. Use `gcloud pubsub topics create` and follow the [Gmail push docs](https://developers.google.com/workspace/gmail/api/guides/push) when you actually need it.

## Troubleshooting

- **invalid_grant on refresh:** by far the most common cause is the OAuth consent screen is still in "Testing" publishing status. Google issues Testing-mode refresh tokens with a hard 7-day expiry regardless of test-user listing (policy; see support.google.com/cloud/answer/13464323). Fix: open <https://console.cloud.google.com/apis/credentials/consent>, click **Publish app** to move the app to "In production" status (do NOT submit for verification), then `rm ~/.gmail-mcp/token.json && node bin/gmail-cli.js auth`. Secondary causes (rare, only if the app is already on Production): OAuth client deleted in Cloud Console, scopes changed since last consent, Google account password reset, or token revoked at myaccount.google.com. Same fix command: delete the token file and re-run `auth`.
- **403 PERMISSION_DENIED on first call:** Gmail API isn't enabled on the project that owns your OAuth client. Open the project in Cloud Console and enable Gmail API.
- **"This app is blocked":** you tried to use gcloud's ADC for Gmail. That doesn't work. See "Why a Cloud Console step" above. Use the Desktop OAuth client you create here instead.
- **Quota:** 1B units/day, 250 units/user/sec. Effectively unbounded for personal use.
