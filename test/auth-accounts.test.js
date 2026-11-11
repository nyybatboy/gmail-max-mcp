import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getAuthClient, mapApiError } from '../lib/auth.js';
import { runWithAccount } from '../lib/context.js';
import { accountPaths } from '../lib/accounts.js';
import { tempDir } from '../testkit/harness.js';

// Fake values only. Constructing an OAuth2 client and setting credentials makes
// no network call; nothing here ever requests a token.
function writeClient(file, clientId) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ installed: { client_id: clientId, client_secret: 'not-a-secret' } }));
}
function writeToken(dir, refresh) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: refresh, access_token: 'x', expiry_date: Date.now() + 3600e3 }));
}

test('each account gets its own OAuth client; an adopted folder keeps its own client file', async () => {
  const cfg = tempDir();
  writeClient(path.join(cfg, 'credentials.json'), 'shared-client.apps.example');
  const personal = accountPaths(cfg, { label: 'personal' });
  const work = accountPaths(cfg, { label: 'work', dir: path.join(cfg, 'adopted') });
  writeToken(personal.dir, 'r-personal');
  writeToken(work.dir, 'r-work');
  writeClient(path.join(work.dir, 'credentials.json'), 'own-client.apps.example');
  const workPaths = accountPaths(cfg, { label: 'work', dir: path.join(cfg, 'adopted') });

  const pc = await runWithAccount(personal, () => getAuthClient());
  const wc = await runWithAccount(workPaths, () => getAuthClient());
  assert.notEqual(pc, wc);
  assert.equal(pc._clientId, 'shared-client.apps.example');
  assert.equal(wc._clientId, 'own-client.apps.example');
  assert.equal(pc.credentials.refresh_token, 'r-personal');
  assert.equal(wc.credentials.refresh_token, 'r-work');
  assert.equal(await runWithAccount(personal, () => getAuthClient()), pc, 'cached per account');
  fs.rmSync(cfg, { recursive: true, force: true });
});

test('a missing token names the account in the fix command', async () => {
  const cfg = tempDir();
  writeClient(path.join(cfg, 'credentials.json'), 'shared');
  const p = accountPaths(cfg, { label: 'work' });
  await assert.rejects(runWithAccount(p, () => getAuthClient()), /Fix:  node bin\/gmail-cli\.js auth --account work/);
  fs.rmSync(cfg, { recursive: true, force: true });
});

test('API error fix lines name the account token in multi-account mode, the old path otherwise', () => {
  const err = Object.assign(new Error('invalid_grant'), { code: 401 });
  assert.match(mapApiError(err).message, /delete ~\/\.gmail-mcp\/token\.json and re-run:  node bin\/gmail-cli\.js auth$/);
  const p = { label: 'work', dir: '/cfg/accounts/work', tokenPath: '/cfg/accounts/work/token.json', credentialsPath: '/cfg/credentials.json' };
  const mapped = runWithAccount(p, () => mapApiError(err));
  assert.match(mapped.message, /delete \/cfg\/accounts\/work\/token\.json and re-run:  node bin\/gmail-cli\.js auth --account work/);
});
