import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { google } from 'googleapis';
import open from 'open';

export const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
export const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
export const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');

export const SCOPES = ['https://mail.google.com/'];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function readCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing OAuth client credentials at ${CREDENTIALS_PATH}. ` +
      `Create a Desktop OAuth client in Google Cloud Console, download the JSON, and save it there. ` +
      `See SETUP.md for the four-click walkthrough.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const block = raw.installed || raw.web;
  if (!block) throw new Error(`credentials.json missing 'installed' or 'web' block`);
  return block;
}

function readToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

function writeToken(tokens) {
  ensureConfigDir();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function makeOAuthClient(redirectUri) {
  const { client_id, client_secret } = readCredentials();
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

export async function getAuthClient() {
  ensureConfigDir();
  const token = readToken();
  if (!token) {
    throw new Error(`Not authenticated. Run: node bin/gmail-cli.js auth`);
  }
  const client = makeOAuthClient('http://127.0.0.1');
  client.setCredentials(token);
  client.on('tokens', (newTokens) => {
    const merged = { ...token, ...newTokens };
    writeToken(merged);
  });
  return client;
}

export async function runAuthFlow({ headless = false } = {}) {
  ensureConfigDir();
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = makeOAuthClient(redirectUri);

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
  writeToken(tokens);
  return client;
}
