import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { google } from 'googleapis';
import open from 'open';
import { currentAccount } from './context.js';

// GMAIL_MCP_CONFIG_DIR lets a second registered server instance run against a
// different Google account (separate credentials/token/profile cache).
export const CONFIG_DIR = process.env.GMAIL_MCP_CONFIG_DIR || path.join(os.homedir(), '.gmail-mcp');
export const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
export const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');

// `https://mail.google.com/` covers messages/drafts/threads/labels/search.
// Settings writes (vacation, IMAP/POP, send-as CRUD, signatures, delegates,
// forwarding addresses, filters, S/MIME) require explicit settings scopes.
// gmail.settings.basic   = vacation, IMAP, POP, language, auto-forwarding,
//                          send-as basic, signature, filters
// gmail.settings.sharing = delegates, forwarding addresses, send-as
//                          create/delete/verify, S/MIME
export const SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
];

// Paths for the account in the current call context (multi-account mode), or
// the single-account paths above when there is no context (the default).
function activePaths() {
  const acct = currentAccount();
  if (acct) {
    return { dir: acct.dir, tokenPath: acct.tokenPath, credentialsPath: acct.credentialsPath, label: acct.label };
  }
  return { dir: CONFIG_DIR, tokenPath: TOKEN_PATH, credentialsPath: CREDENTIALS_PATH, label: null };
}

function ensureConfigDir(dir = CONFIG_DIR) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// The parameter deliberately shadows the module constant so the error text
// below names whichever credentials file was actually looked for.
function readCredentials(CREDENTIALS_PATH = activePaths().credentialsPath) {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing OAuth client credentials at ${CREDENTIALS_PATH}.\n` +
      `Fix: create a Desktop OAuth client in a Google Cloud Console project you own, ` +
      `publish the consent screen to "In production" status (do NOT submit for verification; ` +
      `the <100-user personal-use exemption applies), and download the client JSON to ` +
      `${CREDENTIALS_PATH}. Gmail's full-access scope is restricted, so gcloud's pre-built ` +
      `OAuth client cannot grant it. See SETUP.md for the walkthrough.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const block = raw.installed || raw.web;
  if (!block) throw new Error(`credentials.json missing 'installed' or 'web' block`);
  return block;
}

function readToken(tokenPath = TOKEN_PATH) {
  if (!fs.existsSync(tokenPath)) return null;
  return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
}

function writeToken(tokens, tokenPath = TOKEN_PATH) {
  ensureConfigDir(path.dirname(tokenPath));
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function makeOAuthClient(redirectUri, credentialsPath) {
  const { client_id, client_secret } = readCredentials(credentialsPath);
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

// One OAuth client per token file. Single-account mode only ever uses one key.
const _clients = new Map();

export async function getAuthClient() {
  const { dir, tokenPath, credentialsPath, label } = activePaths();
  if (_clients.has(tokenPath)) return _clients.get(tokenPath);
  ensureConfigDir(dir);
  const token = readToken(tokenPath);
  if (!token) {
    const cmd = label ? `node bin/gmail-cli.js auth --account ${label}` : 'node bin/gmail-cli.js auth';
    throw mapAuthError(new Error(`Not authenticated. Run: ${cmd}`));
  }
  try {
    const c = makeOAuthClient('http://127.0.0.1', credentialsPath);
    c.setCredentials(token);
    c.on('tokens', (newTokens) => {
      const merged = { ...token, ...newTokens };
      writeToken(merged, tokenPath);
    });
    _clients.set(tokenPath, c);
    return c;
  } catch (err) {
    throw mapAuthError(err);
  }
}

export async function runAuthFlow({ headless = false } = {}) {
  const { dir, tokenPath, credentialsPath } = activePaths();
  ensureConfigDir(dir);
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = makeOAuthClient(redirectUri, credentialsPath);

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  const codePromise = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorized.</h2><p>You can close this tab.</p>');
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2>Error</h2><p>${err || 'no code'}</p>`);
        reject(new Error(err || 'no code returned'));
      }
      server.close();
    });
  });

  if (headless) {
    console.error(`Open this URL in a browser:\n${url}`);
  } else {
    await open(url);
    console.error(`Browser opened. If it didn't, visit:\n${url}`);
  }

  const code = await codePromise;
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  writeToken(tokens, tokenPath);
  _clients.delete(tokenPath);
  return client;
}

// Token file and re-auth command for the active account. In single-account
// mode these are exactly the strings the single-account release printed.
function reauthHint() {
  const acct = currentAccount();
  if (!acct) {
    return { tokenFile: '~/.gmail-mcp/token.json', authCmd: 'node bin/gmail-cli.js auth' };
  }
  return { tokenFile: acct.tokenPath, authCmd: `node bin/gmail-cli.js auth --account ${acct.label}` };
}

export function mapAuthError(err) {
  const msg = err?.message || '';
  const { authCmd } = reauthHint();
  if (msg.includes('Missing OAuth client credentials')) {
    return enrich(
      err,
      'Fix: see SETUP.md — create a Desktop OAuth client in Cloud Console, ' +
        `download to ~/.gmail-mcp/credentials.json, then run:  ${authCmd}`
    );
  }
  if (msg.includes('Not authenticated')) {
    return enrich(err, `Fix:  ${authCmd}`);
  }
  return err;
}

export function mapApiError(err) {
  const status = err?.code || err?.response?.status;
  const reason = err?.errors?.[0]?.reason || err?.response?.data?.error?.status;
  const detail =
    err?.response?.data?.error?.message ||
    err?.errors?.[0]?.message ||
    err?.message ||
    '';

  if (status === 403 && /not been used|SERVICE_DISABLED|disabled/i.test(detail)) {
    return enrich(
      err,
      'Gmail API is not enabled on the project that owns your OAuth client.\n' +
        'Fix: in Cloud Console, enable Gmail API on that project.'
    );
  }
  if (
    status === 403 &&
    /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(
      detail + ' ' + (reason || '')
    )
  ) {
    return enrich(
      err,
      'OAuth token does not include the required scope.\n' +
        `Fix: delete ${reauthHint().tokenFile} and re-run:  ${reauthHint().authCmd}`
    );
  }
  if (
    status === 401 ||
    reason === 'UNAUTHENTICATED' ||
    /invalid_grant|invalid_token|token has been expired or revoked/i.test(detail)
  ) {
    return enrich(
      err,
      'Token rejected (revoked, expired, or scope mismatch).\n' +
        `Fix: delete ${reauthHint().tokenFile} and re-run:  ${reauthHint().authCmd}`
    );
  }
  return err;
}

function enrich(err, hint) {
  const wrapped = new Error(`${err.message || 'Gmail API error'}\n\n${hint}`);
  wrapped.code = err.code;
  wrapped.cause = err;
  wrapped.userActionable = true;
  wrapped.originalErrors = err.errors || err.response?.data || null;
  return wrapped;
}
