// Text for the "ask" permission: the dialog shown to the user, and the
// results returned to the model when an action is refused. Pure functions.
import path from 'node:path';
import { GROUPS, groupOf } from './accounts.js';

export const BODY_PREVIEW_CHARS = 500;

export function formatAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.map(formatAddress).filter(Boolean).join(', ');
  if (a.email) return a.name ? `${a.name} <${a.email}>` : a.email;
  return '';
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function preview(text) {
  const t = String(text || '').trim();
  if (!t) return '(empty body)';
  return t.length > BODY_PREVIEW_CHARS ? `${t.slice(0, BODY_PREVIEW_CHARS)}…` : t;
}

function attachmentNames(list) {
  return (list || []).map((a) => a?.filename || (a?.path ? path.basename(a.path) : 'attachment'));
}

function decodeBase64Url(s) {
  if (!s) return '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function findPart(payload, mimeType) {
  if (!payload) return '';
  if (payload.mimeType === mimeType && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const child of payload.parts || []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return '';
}

function partFilenames(payload, out = []) {
  if (!payload) return out;
  if (payload.filename) out.push(payload.filename);
  for (const child of payload.parts || []) partFilenames(child, out);
  return out;
}

/** Summary of an outgoing message for the approval dialog. */
export function describeOutgoing({ from, to, cc, bcc, subject, attachments = [], inlineImages = 0, body }) {
  const lines = [];
  lines.push(`From: ${from || '(account default)'}`);
  lines.push(`To: ${to || '(none)'}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject || '(no subject)'}`);
  if (attachments.length) lines.push(`Attachments: ${attachments.join(', ')}`);
  if (inlineImages) lines.push(`Inline images: ${inlineImages}`);
  lines.push('', preview(body));
  return lines.join('\n');
}

/** Fields of a send_message call, for the dialog. */
export function outgoingFromArgs(args, defaultFrom) {
  return {
    from: formatAddress(args.from) || defaultFrom,
    to: formatAddress(args.to),
    cc: formatAddress(args.cc),
    bcc: formatAddress(args.bcc),
    subject: args.subject,
    attachments: attachmentNames(args.attachments),
    inlineImages: (args.inlineImages || []).length,
    body: args.text || stripHtml(args.html),
  };
}

/** Fields of an existing draft (drafts.get format=full), for the dialog. */
export function outgoingFromDraft(draft) {
  const payload = draft?.message?.payload;
  const headers = Object.fromEntries((payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  return {
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    bcc: headers.bcc,
    subject: headers.subject,
    attachments: partFilenames(payload),
    inlineImages: 0,
    body: findPart(payload, 'text/plain') || stripHtml(findPart(payload, 'text/html')),
  };
}

/** The message shown in the approval dialog. */
export function approvalMessage({ tool, label, address, outgoing, args }) {
  const where = address ? `the "${label}" account (${address})` : `the "${label}" account`;
  if (outgoing) {
    return `gmail-max wants to send an email from ${where}.\n\n${describeOutgoing(outgoing)}`;
  }
  const group = groupOf(tool);
  const what = group ? GROUPS[group].description : '';
  let argText = JSON.stringify(args || {});
  if (argText.length > BODY_PREVIEW_CHARS) argText = `${argText.slice(0, BODY_PREVIEW_CHARS)}…`;
  return `gmail-max wants to run ${tool} on ${where}.${what ? `\n${what}` : ''}\n\nArguments: ${argText}`;
}

export function approvalSchema(tool) {
  const isSend = groupOf(tool) === 'send';
  return {
    type: 'object',
    properties: {
      approve: {
        type: 'boolean',
        title: isSend ? 'Send this message' : 'Allow this action',
        description: isSend
          ? 'Tick and submit to send. Anything else cancels the send.'
          : 'Tick and submit to allow. Anything else cancels.',
        default: false,
      },
    },
    required: ['approve'],
  };
}

// ---------- refusal text returned to the model ----------
// Deliberately never mentions how to change permissions: that is the user's
// decision, and pointing the model at the CLI would invite it to loosen them.

const NO_RETRY = 'Do not retry unless the user asks.';

function draftAlternative(tool, label, draftAllowed) {
  if (tool === 'send_draft') return 'The draft stays in Drafts; the user can send it from Gmail.';
  if (draftAllowed) return `Call create_draft with the same arguments (account "${label}") to leave it in Drafts; the user can send it from Gmail.`;
  return 'The user can send it from Gmail directly.';
}

export function refusalText({ reason, tool, label, draftAllowed = false }) {
  const isSend = groupOf(tool) === 'send';
  const verb = isSend ? 'Not sent.' : 'Not run.';
  switch (reason) {
    case 'blocked':
      return isSend
        ? `${verb} Sending from "${label}" is blocked by the user's settings for this account. ${draftAlternative(tool, label, draftAllowed)}`
        : `${verb} ${tool} is blocked by the user's settings for account "${label}".`;
    case 'cannot-ask':
      return isSend
        ? `${verb} Sending from "${label}" needs the user's approval and this client cannot ask for it. ${draftAlternative(tool, label, draftAllowed)}`
        : `${verb} ${tool} on "${label}" needs the user's approval and this client cannot ask for it. The user can do this in Gmail directly.`;
    case 'declined':
      return `${verb} The user declined. ${NO_RETRY}`;
    case 'no-answer':
      return `${verb} No answer from the user. ${NO_RETRY}`;
    default:
      return `${verb} ${NO_RETRY}`;
  }
}
