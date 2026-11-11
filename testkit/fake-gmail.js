// In-memory stand-in for google.gmail({ version: 'v1' }), one mailbox per
// account. Installed through lib/gmail.js setGmailClientFactory, so tests never
// reach Google. Every call is recorded in `calls` as { account, method, params }.

function notFound(what) {
  const err = new Error(`Requested entity was not found. (${what})`);
  err.code = 404;
  return err;
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function draftPayload({ from, to, subject, text, attachment }) {
  const parts = [{ mimeType: 'text/plain', body: { data: b64url(text) } }];
  if (attachment) parts.push({ mimeType: 'application/pdf', filename: attachment, body: { attachmentId: 'att1' } });
  return {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: to },
      { name: 'Subject', value: subject },
    ],
    parts,
  };
}

export function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * mailboxes: { [label]: { email, displayName?, messages?: {id: msg}, drafts?: {id: draft},
 *                         attachmentData?: base64 string served by attachments.get } }
 * options:  { jitter: true } adds a random 0-15 ms delay to every call;
 *           { mailboxFor: (account) => label } picks the mailbox (default: account.label).
 * Returns { factory, calls, mailboxes }.
 */
export function makeFakeGmail(mailboxes, { jitter = false, mailboxFor } = {}) {
  const calls = [];
  let seq = 0;

  function client(account) {
    const c = rawClient(account);
    if (jitter) {
      const wrap = (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'function') obj[k] = async (...a) => { await sleep(Math.random() * 15); return v(...a); };
          else if (v && typeof v === 'object') wrap(v);
        }
      };
      wrap(c.users);
    }
    return c;
  }

  function rawClient(account) {
    const label = mailboxFor ? mailboxFor(account) : (account?.label ?? '(single-account)');
    const box = mailboxes[label];
    if (!box) throw new Error(`fake-gmail: no mailbox for ${label}`);
    box.messages ??= {};
    box.drafts ??= {};
    box.sent ??= [];
    const rec = (method, params) => calls.push({ account: label, method, params });
    const ok = (data) => ({ data });

    return {
      users: {
        getProfile: async (p) => { rec('getProfile', p); return ok({ emailAddress: box.email, historyId: '1' }); },
        messages: {
          list: async (p) => { rec('messages.list', p); return ok({ messages: Object.keys(box.messages).map((id) => ({ id, threadId: box.messages[id].threadId })) }); },
          get: async (p) => {
            rec('messages.get', p);
            const m = box.messages[p.id];
            if (!m) throw notFound(`message ${p.id}`);
            return ok(m);
          },
          send: async (p) => {
            rec('messages.send', p);
            const id = `sent-${label}-${++seq}`;
            box.sent.push({ id, raw: p.requestBody.raw });
            return ok({ id, threadId: `t-${id}`, labelIds: ['SENT'] });
          },
          delete: async (p) => {
            rec('messages.delete', p);
            if (!box.messages[p.id]) throw notFound(`message ${p.id}`);
            delete box.messages[p.id];
            return ok('');
          },
          trash: async (p) => { rec('messages.trash', p); return ok({ id: p.id, labelIds: ['TRASH'] }); },
          attachments: {
            get: async (p) => { rec('attachments.get', p); return ok({ data: box.attachmentData ?? '', size: 1 }); },
          },
        },
        drafts: {
          create: async (p) => {
            rec('drafts.create', p);
            const id = `draft-${label}-${++seq}`;
            box.drafts[id] = { id, message: { id: `m-${id}`, raw: p.requestBody.message.raw } };
            return ok({ id, message: { id: `m-${id}`, labelIds: ['DRAFT'] } });
          },
          // format 'raw' returns the message bytes. Drafts stored as a parsed
          // payload get a stand-in raw derived from the whole payload, so any
          // change to the payload changes the raw, as with real Gmail.
          get: async (p) => {
            rec('drafts.get', p);
            const d = box.drafts[p.id];
            if (!d) throw notFound(`draft ${p.id}`);
            if (p.format === 'raw') {
              const raw = d.message.raw ?? Buffer.from(JSON.stringify(d.message.payload)).toString('base64url');
              return ok({ id: d.id, message: { id: d.message.id, raw } });
            }
            return ok(d);
          },
          // Replaces the draft: new message id, headers parsed from the raw, a marked body.
          update: async (p) => {
            rec('drafts.update', p);
            if (!box.drafts[p.id]) throw notFound(`draft ${p.id}`);
            const raw = b64urlDecode(p.requestBody.message.raw);
            const hdr = (n) => (raw.match(new RegExp(`^${n}: (.*)$`, 'mi')) || [])[1];
            const mid = `m-updated-${p.id}-${++seq}`;
            box.drafts[p.id] = {
              id: p.id,
              message: { id: mid, payload: draftPayload({ from: hdr('From') || box.email, to: hdr('To'), subject: hdr('Subject'), text: 'UPDATED BODY' }) },
            };
            return ok({ id: p.id, message: { id: mid } });
          },
          send: async (p) => {
            rec('drafts.send', p);
            const d = box.drafts[p.requestBody.id];
            if (!d) throw notFound(`draft ${p.requestBody.id}`);
            delete box.drafts[p.requestBody.id];
            box.sent.push({ id: d.message.id, draft: p.requestBody.id });
            return ok({ id: d.message.id, threadId: `t-${d.message.id}`, labelIds: ['SENT'] });
          },
        },
        labels: {
          list: async (p) => { rec('labels.list', p); return ok({ labels: [{ id: 'INBOX', name: 'INBOX' }] }); },
        },
        settings: {
          sendAs: {
            list: async (p) => {
              rec('settings.sendAs.list', p);
              return ok({ sendAs: [{ sendAsEmail: box.email, displayName: box.displayName || '', isPrimary: true, isDefault: true, signature: '' }] });
            },
          },
          filters: {
            create: async (p) => { rec('settings.filters.create', p); return ok({ id: `filter-${++seq}` }); },
          },
        },
      },
    };
  }

  return { factory: client, calls, mailboxes };
}
