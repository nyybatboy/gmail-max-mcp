import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeLegacy } from '../testkit/legacy-probe.js';

// The fixture was captured from the single-account code BEFORE multi-account
// support was added. With no accounts file in the config directory, the server
// must stay byte-for-byte identical: same server info, same capabilities, no
// instructions, the same tools/list, and the same call results.
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'legacy-snapshot.json');

test('no accounts file: server is byte-identical to the single-account release', async () => {
  const expected = fs.readFileSync(FIXTURE, 'utf8');
  const actual = JSON.stringify(await probeLegacy(), null, 2) + '\n';
  assert.equal(actual, expected);
});
