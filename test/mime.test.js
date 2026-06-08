import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRawMessage } from '../lib/mime.js';

function decode(raw) {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

test('text-only body auto-renders to multipart/alternative, plain part before html part', () => {
  const raw = decode(buildRawMessage({ to: 'a@b.com', subject: 'Hi', text: 'Hello there\n\nSecond para' }));
  assert.match(raw, /Content-Type: multipart\/alternative/);
  const plainIdx = raw.indexOf('text/plain');
  const htmlIdx = raw.indexOf('text/html');
  assert.ok(plainIdx > -1 && htmlIdx > -1, 'both parts present');
  assert.ok(plainIdx < htmlIdx, 'plain part precedes html part (RFC 2046 ordering)');
  assert.match(raw, /<div dir=3D"ltr">/, 'auto-rendered Gmail-style html, QP-encoded');
});

test('plaintextOnly forces a bare text/plain message (no html part)', () => {
  const raw = decode(buildRawMessage({ to: 'a@b.com', subject: 'Hi', text: 'Hello', plaintextOnly: true }));
  assert.match(raw, /Content-Type: text\/plain/);
  assert.doesNotMatch(raw, /multipart\/alternative/);
  assert.doesNotMatch(raw, /text\/html/);
});

test('explicit html is respected and the auto-renderer does not fire', () => {
  const raw = decode(buildRawMessage({ to: 'a@b.com', subject: 'Hi', text: 'plain fallback', html: '<p>custom</p>' }));
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /<p>custom<\/p>/);
  assert.doesNotMatch(raw, /<div dir=3D"ltr">/, 'our auto-render markup is absent');
});

test('every encoded line stays under the RFC 5322 998-octet limit', () => {
  const long = 'word '.repeat(500); // one ~2500-char paragraph
  const raw = decode(buildRawMessage({ to: 'a@b.com', subject: 'x', text: long }));
  for (const line of raw.split(/\r\n/)) {
    assert.ok(line.length <= 998, `line exceeded 998 octets: ${line.length}`);
  }
});

test('attachments wrap the alternative in multipart/mixed', () => {
  const raw = decode(buildRawMessage({
    to: 'a@b.com', subject: 'x', text: 'body text',
    attachments: [{ filename: 'a.txt', contentBase64: Buffer.from('hi').toString('base64'), mimeType: 'text/plain' }],
  }));
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-Disposition: attachment; filename="a.txt"/);
});

test('threaded reply headers survive auto-render', () => {
  const raw = decode(buildRawMessage({
    to: 'a@b.com', subject: 'Re: x', text: 'a reply body',
    inReplyTo: '<parent@mail>', references: '<root@mail> <parent@mail>', threadId: 't123',
  }));
  assert.match(raw, /In-Reply-To: <parent@mail>/);
  assert.match(raw, /References: <root@mail> <parent@mail>/);
  assert.match(raw, /multipart\/alternative/);
});
