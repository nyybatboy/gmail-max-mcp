// Compose checks in multi-account mode: only malformed mail and credential
// paths are refused; a well-formed message always goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMulti } from '../testkit/harness.js';
import { b64urlDecode } from '../testkit/fake-gmail.js';
import { validateComposeArgs, normalizeComposeArgs } from '../lib/compose-checks.js';

const BASE = { to: 'friend@example.net', subject: 'Lunch', text: 'See you at noon.' };
const ALL_ON = { personal: { purpose: 'Main inbox.' }, work: { purpose: 'Work inbox.' } };

test('malformed mail is refused before anything is sent', async (t) => {
  const h = await startMulti({ accounts: ALL_ON });
  t.after(h.close);
  const bad = [
    { inReplyTo: '<a@b>\r\nBcc: x@example.net' },
    { references: ['<a@b>', 'x\nBcc: y@example.net'] },
    { to: 'friend@example.net\r\nBcc: x@example.net' },
    { to: [{ name: 'F\r\nBcc: x@example.net', email: 'friend@example.net' }] },
    { subject: 'Lunch\nBcc: x@example.net' },
    { subject: ['Lunch'] },
    { threadId: 't\r\nx' },
    { replyTo: { name: 'R', email: 'r@example.net\nBcc: x@example.net' } },
    { bcc: [['hidden@example.net']] },
    { to: [{ email: ['friend@example.net', 'hidden@example.net'] }] },
    { replyTo: ['a@example.net'] },
    { headers: { Bcc: 'hidden@example.net' } },
    { headers: { cc: 'hidden@example.net' } },
    { headers: { Subject: 'second subject' } },
    { headers: { 'Content-Type': 'text/html' } },
    { headers: { 'X-Ok': 'line\r\nBcc: x@example.net' } },
    { headers: { 'Bad Name': 'v' } },
    { attachments: [{ filename: 'a"; name="b.exe', contentBase64: 'AA==' }] },
    { attachments: [{ filename: 'a.txt', mimeType: 'text/plain\r\nBcc: x@example.net', contentBase64: 'AA==' }] },
    { attachments: [{ filename: 'a.bin', contentBase64: 'AAAA--guess\r\nContent-Type: text/html' }] },
  ];
  for (const extra of bad) {
    const r = await h.call('send_message', { account: 'personal', ...BASE, ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.body.error, /^Refused:/, JSON.stringify(extra));
  }
  assert.equal(h.fake.calls.filter((c) => c.method === 'messages.send').length, 0);
});

test('well-formed mail goes out, including things that are unusual but valid', async (t) => {
  const h = await startMulti({ accounts: ALL_ON });
  t.after(h.close);
  const good = [
    { headers: { 'X-Campaign': 'spring', 'List-Unsubscribe': '<mailto:u@example.net>', 'Disposition-Notification-To': 'me@example.com' } },
    { cc: { email: 'c@example.net' }, bcc: ['b@example.net', { name: 'B2', email: 'b2@example.net' }], replyTo: 'r@example.net' },
    { html: '<p>See you at noon.</p>< not a tag >', inlineImages: [{ contentBase64: 'PGgxPmhpPC9oMT4=', mimeType: 'text/html', cid: 'x' }] },
    { attachments: [{ filename: 'a.bin', mimeType: 'multipart/mixed', contentBase64: 'AAAA' }] },
  ];
  for (const extra of good) {
    const r = await h.call('send_message', { account: 'personal', ...BASE, ...extra });
    assert.equal(r.isError, false, `${JSON.stringify(extra)} -> ${JSON.stringify(r.body)}`);
  }
});

test('wrapped base64 is cleaned up and sent, not refused', async (t) => {
  const h = await startMulti({ accounts: ALL_ON });
  t.after(h.close);
  const r = await h.call('send_message', { account: 'personal', ...BASE, attachments: [{ filename: 'n.txt', mimeType: 'text/plain', contentBase64: 'aGVs\nbG8g\r\nd29y bGQ=' }] });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const raw = b64urlDecode(h.fake.calls.find((c) => c.method === 'messages.send').params.requestBody.raw);
  assert.match(raw, /aGVsbG8gd29ybGQ=/);
  assert.deepEqual(normalizeComposeArgs({ attachments: [{ contentBase64: 'a b\nc' }] }).attachments[0].contentBase64, 'abc');
});

test('validateComposeArgs is quiet for a plain message', () => {
  assert.doesNotThrow(() => validateComposeArgs(BASE, null));
});
