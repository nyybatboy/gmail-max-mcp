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

/**
 * mailboxes: { [label]: { email, displayName?, messages?: {id: msg}, drafts?: {id: draft} } }
 * Returns { factory, calls, mailboxes }.
 */
export function makeFakeGmail(mailboxes) {
  const calls = [];
  let seq = 0;

  function client(account) {
    const label = account?.label ?? '(single-account)';
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
        },
        drafts: {
          create: async (p) => {
            rec('drafts.create', p);
            const id = `draft-${label}-${++seq}`;
            box.drafts[id] = { id, message: { id: `m-${id}`, raw: p.requestBody.message.raw } };
            return ok({ id, message: { id: `m-${id}`, labelIds: ['DRAFT'] } });
          },
          get: async (p) => {
            rec('drafts.get', p);
            const d = box.drafts[p.id];
            if (!d) throw notFound(`draft ${p.id}`);
            return ok(d);
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
