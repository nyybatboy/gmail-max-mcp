import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyRecipients, splitAddressList, extractEmail } from '../lib/gmail.js';

// The user's own identities: authenticated account + one send-as alias.
const SELF = ['owner@example.com', 'owner-alias@example.net'];

// Turn a recipient array into a lowercased email Set so assertions are
// insensitive to display-name formatting / ordering.
const emails = (arr) => new Set((arr || []).map(extractEmail));

// ---------- helpers ----------

test('splitAddressList respects commas inside quoted display names', () => {
  const parsed = splitAddressList('"Lastname, Firstname" <a@x.com>, plain@y.com');
  assert.equal(parsed.length, 2);
  assert.deepEqual(emails(parsed), new Set(['a@x.com', 'plain@y.com']));
});

test('extractEmail pulls the address out of an angle-bracketed name', () => {
  assert.equal(extractEmail('"Account Owner" <owner@example.com>'), 'owner@example.com');
  assert.equal(extractEmail('bare@z.com'), 'bare@z.com');
});

// ---------- self-sent parent (the bug) ----------

const selfSentParent = {
  from: '"Account Owner" <owner@example.com>',
  to: 'Alice <alice@client.com>, Bob <bob@client.com>',
  cc: 'Carol <carol@client.com>',
};

test('reply to a self-sent message addresses the original To recipients, never the user', () => {
  const { to, cc } = buildReplyRecipients({ headers: selfSentParent, replyAll: false, selfAddresses: SELF });
  assert.deepEqual(emails(to), new Set(['alice@client.com', 'bob@client.com']));
  assert.deepEqual(emails(cc), new Set()); // not replyAll -> no Cc
  assert.ok(!emails(to).has('owner@example.com'), 'user not in To');
  assert.ok(!emails(to).has('owner-alias@example.net'), 'alias not in To');
});

test('reply-all to a self-sent message carries the parent Cc and excludes the user + aliases', () => {
  const { to, cc } = buildReplyRecipients({ headers: selfSentParent, replyAll: true, selfAddresses: SELF });
  assert.deepEqual(emails(to), new Set(['alice@client.com', 'bob@client.com']));
  assert.deepEqual(emails(cc), new Set(['carol@client.com']));
  for (const field of [to, cc]) {
    assert.ok(!emails(field).has('owner@example.com'), 'account never a recipient of own reply');
    assert.ok(!emails(field).has('owner-alias@example.net'), 'alias never a recipient of own reply');
  }
});

test('self-sent parent that also Cc\'d the user drops the user from the reply', () => {
  const parent = {
    from: 'owner@example.com',
    to: 'Alice <alice@client.com>',
    cc: 'owner@example.com, Carol <carol@client.com>',
  };
  const { to, cc } = buildReplyRecipients({ headers: parent, replyAll: true, selfAddresses: SELF });
  assert.deepEqual(emails(to), new Set(['alice@client.com']));
  assert.deepEqual(emails(cc), new Set(['carol@client.com']));
});

test('self-sent from a send-as alias still excludes both the alias and the account', () => {
  const parent = {
    from: 'Owner (alias) <owner-alias@example.net>',
    to: 'Dave <dave@client.com>',
    cc: 'owner@example.com',
  };
  const { to, cc } = buildReplyRecipients({ headers: parent, replyAll: true, selfAddresses: SELF });
  assert.deepEqual(emails(to), new Set(['dave@client.com']));
  assert.deepEqual(emails(cc), new Set()); // only self was in Cc
});

// ---------- normal parent (must stay correct) ----------

const normalParent = {
  from: 'Sender <sender@corp.com>',
  to: 'Alice <alice@client.com>, owner@example.com',
  cc: 'Carol <carol@client.com>',
};

test('reply to a normal message addresses the sender', () => {
  const { to, cc } = buildReplyRecipients({ headers: normalParent, replyAll: false, selfAddresses: SELF });
  assert.deepEqual(emails(to), new Set(['sender@corp.com']));
  assert.deepEqual(emails(cc), new Set());
});

test('reply-all to a normal message adds parent To+Cc minus self', () => {
  const { to, cc } = buildReplyRecipients({ headers: normalParent, replyAll: true, selfAddresses: SELF });
  assert.deepEqual(emails(to), new Set(['sender@corp.com']));
  assert.deepEqual(emails(cc), new Set(['alice@client.com', 'carol@client.com']));
  assert.ok(!emails(cc).has('owner@example.com'), 'user excluded from reply-all Cc');
});

test('normal reply honors Reply-To over From', () => {
  const parent = { from: 'Sender <sender@corp.com>', 'reply-to': 'Desk <desk@corp.com>' };
  const { to } = buildReplyRecipients({ headers: parent, replyAll: false, selfAddresses: SELF });
  assert.deepEqual(emails(to), new Set(['desk@corp.com']));
});

// ---------- caller extras + de-dup ----------

test('extraTo / extraCc are appended verbatim and Cc is de-duped against To', () => {
  const parent = {
    from: 'owner@example.com',
    to: 'Alice <alice@client.com>',
    cc: 'alice@client.com, Carol <carol@client.com>', // Alice appears in both
  };
  const { to, cc } = buildReplyRecipients({
    headers: parent, replyAll: true, selfAddresses: SELF,
    extraTo: 'extra@x.com', extraCc: ['cc-extra@y.com'],
  });
  assert.deepEqual(emails(to), new Set(['alice@client.com', 'extra@x.com']));
  // Alice removed from Cc (already in To); Carol + the caller extra remain.
  assert.deepEqual(emails(cc), new Set(['carol@client.com', 'cc-extra@y.com']));
});
