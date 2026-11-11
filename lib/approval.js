// The "ask" permission: what the user is shown, how their answer is read, and
// what the model is told when an action does not run. Pure functions plus one
// argument validator for the compose tools.
//
// Standard for the send dialog: everything that leaves the account is shown.
// Every recipient header (including duplicates), Reply-To, any extra header,
// every attachment with where its bytes come from, the body the recipient will
// actually see, and the plain-text alternative whenever it differs.
import fs from 'node:fs';
import path from 'node:path';
import { GROUPS, groupOf } from './accounts.js';
import { assertReadable } from './fs-guard.js';
import { guessMime } from './mime.js';

export const BODY_PREVIEW_CHARS = 500;
export const OTHER_ARGS_CHARS = 500;

// Argument keys never shown in a dialog: secrets and bulk binary data.
const REDACT_KEYS = new Set(['encryptedKeyPassword', 'password', 'pkcs12', 'contentBase64', 'content', 'data', 'raw']);

// ---------- small helpers ----------

export function formatAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.map(formatAddress).filter(Boolean).join(', ');
  if (a.email) return a.name ? `${a.name} <${a.email}>` : a.email;
  return '';
}

// ---------- HTML: what the recipient sees ----------
//
// Not a renderer. The rule is to err towards showing too much: only real tags
// (a "<", an optional "/", then a letter) are removed; a "<" followed by
// anything else is text, as it is in a browser. Only <style> and <script>
// contents and comments are dropped (closing tags may carry whitespace, as
// browsers accept). Text hidden by CSS is shown. Anything a browser would hide
// that this cannot follow (an unterminated style, script or comment, CDATA, a
// processing instruction or other "<!" declaration) marks the HTML unusual, and
// the dialog then also shows the source.

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥',
  zwnj: '‌', zwj: '‍', shy: '­',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v; // unknown names stay visible as written
  });
}

const RAWTEXT_BLOCK = /<(style|script)\b[^>]*>[\s\S]*?<\/\1(?=[\s/>])[^>]*>/gi;
const REAL_TAG = /<\/?[A-Za-z][^>]*>/g;
const BLOCK_TAG = /<\/?(p|div|li|ul|ol|tr|table|blockquote|h[1-6]|section|article|header|footer|center|pre)\b[^>]*>|<br\b[^>]*>/gi;
const URL_ATTR = /\b(href|src|srcset|background|action|formaction|poster|cite|longdesc|data|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const HIDING_CSS = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|max-height\s*:\s*0(?![.\d])/i;

/**
 * { text, unusual: [reason], urls: ["tag attr: url"], hidesText }
 */
export function htmlView(html) {
  let s = String(html || '');
  const unusual = [];
  if (/<!--(?![\s\S]*?-->)/.test(s)) unusual.push('an unterminated comment');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(RAWTEXT_BLOCK, '');
  const leftover = s.match(/<(style|script)\b/i);
  if (leftover) unusual.push(`an unterminated <${leftover[1].toLowerCase()}>`);
  if (/<!\[CDATA\[/i.test(s)) unusual.push('a CDATA section');
  if (/<\?/.test(s)) unusual.push('a processing instruction');
  s = s.replace(/<!doctype\b[^>]*>/gi, '');
  if (/<![^-]/.test(s)) unusual.push('a "<!" declaration');
  s = s.replace(/[ \t\r\n]+/g, ' ');
  s = s.replace(BLOCK_TAG, '\n');
  s = s.replace(REAL_TAG, '');
  s = decodeEntities(s)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const urls = [];
  const tagRe = /<([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(String(html || '')))) {
    let a;
    URL_ATTR.lastIndex = 0;
    while ((a = URL_ATTR.exec(m[2]))) urls.push(`${m[1].toLowerCase()} ${a[1].toLowerCase()}: ${a[3] ?? a[4] ?? a[5]}`);
  }
  let c;
  CSS_URL.lastIndex = 0;
  while ((c = CSS_URL.exec(String(html || '')))) urls.push(`css url: ${c[1] ?? c[2] ?? c[3]}`);
  return { text: s, unusual, urls: urls.map(shortenDataUrl), hidesText: HIDING_CSS.test(String(html || '')) };
}

function shortenDataUrl(line) {
  const i = line.indexOf('data:');
  if (i === -1 || line.length < 200) return line;
  return `${line.slice(0, i + 60)}… (data URL, ${line.length - i} characters)`;
}

/** Visible text of an HTML body (see htmlView). */
export function stripHtml(html) {
  return htmlView(html).text;
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function preview(text) {
  const t = String(text || '').trim();
  if (!t) return '(empty)';
  return t.length > BODY_PREVIEW_CHARS ? `${t.slice(0, BODY_PREVIEW_CHARS)}…` : t;
}

function decodeBase64Url(s) {
  if (!s) return '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function leafParts(payload, out = []) {
  if (!payload) return out;
  if (payload.parts?.length) {
    for (const child of payload.parts) leafParts(child, out);
  } else {
    out.push(payload);
  }
  return out;
}

// Every body part of a type (not attachments), joined: a draft can carry more
// than one, and the recipient may see all of them.
function bodiesOfType(payload, mimeType) {
  return leafParts(payload)
    .filter((p) => p.mimeType === mimeType && !p.filename && p.body?.data)
    .map((p) => decodeBase64Url(p.body.data))
    .join('\n');
}

function describePart(p) {
  const size = p.body?.size;
  const name = p.filename ? ` "${p.filename}"` : '';
  return `${p.mimeType || 'unknown type'}${name}${size ? `, ${size} bytes` : ''}`;
}

/** The content type mime.js will put on an attachment or inline image. */
export function effectiveType(att) {
  return att?.mimeType || (att?.path ? guessMime(att.path) : 'application/octet-stream');
}

function fileSource(att) {
  const name = att?.filename || (att?.path ? path.basename(att.path) : 'attachment');
  const type = effectiveType(att);
  if (att?.path) {
    let size = 'file not found';
    try { size = `${fs.statSync(att.path).size} bytes`; } catch { /* shown as not found */ }
    return `${name} (${type}, read from ${att.path}, ${size})`;
  }
  const data = att?.contentBase64 || att?.content;
  if (data) return `${name} (${type}, supplied inline, ${Buffer.from(String(data), 'base64').length} bytes)`;
  return `${name} (${type}, no content)`;
}

// ---------- outgoing message summaries ----------

/**
 * Normalized summary of an outgoing message:
 *   headers: [[name, value], ...] in send order, duplicates kept
 *   attachments, inlineImages: [string]
 *   text, html: the two bodies as sent (either may be empty)
 */
export function outgoingFromArgs(args, defaultFrom) {
  const headers = [];
  headers.push(['From', formatAddress(args.from) || defaultFrom || '(account default)']);
  headers.push(['To', formatAddress(args.to) || '(none)']);
  if (args.cc) headers.push(['Cc', formatAddress(args.cc)]);
  if (args.bcc) headers.push(['Bcc', formatAddress(args.bcc)]);
  if (args.replyTo) headers.push(['Reply-To', formatAddress(args.replyTo)]);
  headers.push(['Subject', args.subject || '(no subject)']);
  if (args.inReplyTo) headers.push(['In-Reply-To', String(args.inReplyTo)]);
  if (args.references) headers.push(['References', Array.isArray(args.references) ? args.references.join(' ') : String(args.references)]);
  for (const [k, v] of Object.entries(args.headers || {})) headers.push([k, String(v)]);
  return {
    headers,
    attachments: (args.attachments || []).map(fileSource),
    inlineImages: (args.inlineImages || []).map(fileSource),
    // A text-only body is rendered to HTML from the same text (lib/mime.js), so
    // the recipient sees the text either way.
    text: args.text || '',
    html: args.html || '',
    plaintextOnly: !!args.plaintextOnly,
  };
}

// Headers a draft carries that say nothing a reader needs to approve.
const STRUCTURAL = new Set(['mime-version', 'content-type', 'content-transfer-encoding', 'date', 'message-id']);

/** Summary of an existing draft (drafts.get format=full). Duplicates are kept. */
export function outgoingFromDraft(draft) {
  const payload = draft?.message?.payload;
  const headers = (payload?.headers || [])
    .filter((h) => !STRUCTURAL.has(String(h.name).toLowerCase()))
    .map((h) => [h.name, h.value]);
  const text = bodiesOfType(payload, 'text/plain');
  const html = bodiesOfType(payload, 'text/html');
  // Every part is listed with its type, bodies included, so nothing is implicit.
  return { headers, parts: leafParts(payload).map(describePart), attachments: [], inlineImages: [], text, html, plaintextOnly: !html };
}

/** First value of a header (case-insensitive), for result echoes. */
export function headerValue(outgoing, name) {
  const h = outgoing.headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
  return h ? h[1] : null;
}

function bodyLines(o) {
  const lines = [];
  const textShown = o.text && !o.html ? o.text : '';
  if (o.html) {
    const view = htmlView(o.html);
    lines.push(`Body (HTML, what most mail apps show), ${view.text.length} characters of text:`, preview(view.text));
    if (view.hidesText) lines.push('', 'NOTE: this HTML has styles that can hide text from the reader; hidden text is included above.');
    if (view.unusual.length) {
      lines.push('', `WARNING: unusual HTML (${view.unusual.join(', ')}); a mail app may show or hide things differently. HTML source, ${o.html.length} characters:`, preview(o.html));
    }
    if (view.urls.length) {
      lines.push('', `Links and remote content (${view.urls.length}):`, ...view.urls.map((u) => `  ${u}`));
    }
    if (o.text && squash(o.text) !== squash(view.text)) {
      lines.push('', `WARNING: the plain-text version differs from the HTML version. Plain text, ${o.text.length} characters:`, preview(o.text));
    }
  } else {
    lines.push(`Body (plain text), ${textShown.length} characters:`, preview(textShown));
  }
  return lines;
}

/** The text block for a message, used in the dialog. */
export function describeOutgoing(o) {
  const lines = [];
  const counts = {};
  for (const [k] of o.headers) counts[k.toLowerCase()] = (counts[k.toLowerCase()] || 0) + 1;
  for (const [k, v] of o.headers) {
    const dup = counts[k.toLowerCase()] > 1 ? `   [this header appears ${counts[k.toLowerCase()]} times]` : '';
    lines.push(`${k}: ${v}${dup}`);
  }
  if (o.attachments.length) lines.push(`Attachments (${o.attachments.length}): ${o.attachments.join('; ')}`);
  if (o.inlineImages.length) lines.push(`Inline images (${o.inlineImages.length}): ${o.inlineImages.join('; ')}`);
  if (o.parts?.length) lines.push(`Parts (${o.parts.length}): ${o.parts.join('; ')}`);
  lines.push('', ...bodyLines(o));
  return lines.join('\n');
}

// ---------- generic (non-send) dialog ----------

// For each tool that can redirect mail, replies or identity, the fields that
// decide what happens. They are printed first and in full; everything else is
// shown after, truncated.
const KEY_FIELDS = {
  create_filter: ['action', 'criteria.from', 'criteria.to'],
  delete_filter: ['id'],
  update_auto_forwarding: ['enabled', 'emailAddress', 'disposition'],
  create_forwarding_address: ['forwardingEmail'],
  delete_forwarding_address: ['forwardingEmail'],
  create_delegate: ['delegateEmail'],
  delete_delegate: ['delegateEmail'],
  // smtpMsa routes the alias's outgoing mail through another server.
  create_send_as: ['sendAsEmail', 'replyToAddress', 'smtpMsa', 'displayName', 'isDefault', 'treatAsAlias'],
  update_send_as: ['sendAsEmail', 'replyToAddress', 'smtpMsa', 'displayName', 'isDefault', 'treatAsAlias'],
  delete_send_as: ['sendAsEmail'],
  verify_send_as: ['sendAsEmail'],
  // The auto-reply goes out in the user's name: its whole body is shown.
  update_vacation: ['enableAutoReply', 'responseSubject', 'responseBodyPlainText', 'responseBodyHtml', 'restrictToContacts', 'restrictToDomain', 'startTime', 'endTime'],
  delete_message: ['id'],
  delete_thread: ['id'],
  batch_delete_messages: [],
  batch_modify_messages: ['addLabelIds', 'removeLabelIds'],
  modify_message: ['id', 'addLabelIds', 'removeLabelIds'],
  modify_thread: ['id', 'addLabelIds', 'removeLabelIds'],
  watch: ['topicName', 'labelIds', 'labelFilterAction'],
};

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}

function dropPath(obj, dotted) {
  const keys = dotted.split('.');
  const clone = JSON.parse(JSON.stringify(obj));
  let o = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!o || typeof o !== 'object') return clone;
    o = o[keys[i]];
  }
  if (o && typeof o === 'object') delete o[keys[keys.length - 1]];
  return clone;
}

const redact = (v) => JSON.stringify(v, (k, x) => (REDACT_KEYS.has(k) ? '[redacted]' : x));

export function describeArgs(tool, args = {}) {
  const lines = [];
  let rest = { ...args };
  for (const f of KEY_FIELDS[tool] || []) {
    const v = getPath(args, f);
    if (v === undefined) continue;
    lines.push(`${f}: ${redact(v)}`);
    rest = dropPath(rest, f);
  }
  // Every list is counted, so a long list can never hide its size.
  for (const [k, v] of Object.entries(args)) {
    if (Array.isArray(v)) lines.push(`${k}: ${v.length} item${v.length === 1 ? '' : 's'}`);
  }
  let other = redact(rest);
  if (other !== '{}') {
    // Name every remaining key before any truncation, so nothing is silent.
    lines.push(`Other argument keys: ${Object.keys(rest).join(', ')}`);
    if (other.length > OTHER_ARGS_CHARS) other = `${other.slice(0, OTHER_ARGS_CHARS)}… (${other.length} characters in total)`;
    lines.push(`Other arguments: ${other}`);
  }
  return lines.join('\n');
}

/** The message shown in the approval dialog. */
export function approvalMessage({ tool, label, address, outgoing, args }) {
  const where = address ? `the "${label}" account (${address})` : `the "${label}" account`;
  if (outgoing) {
    return `gmail-max wants to send an email from ${where}.\n\n${describeOutgoing(outgoing)}`;
  }
  const group = groupOf(tool);
  const what = group ? GROUPS[group].description : '';
  return `gmail-max wants to run ${tool} on ${where}.${what ? `\n${what}` : ''}\n\n${describeArgs(tool, args)}`;
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

/**
 * Read the user's answer. Only an explicit accept with approve === true
 * approves; anything else, including truthy non-booleans, does not.
 * Returns { approved: true } or { approved: false, reason }.
 */
export function interpretAnswer(res) {
  if (res && res.action === 'accept' && res.content && res.content.approve === true) return { approved: true };
  if (res && res.action === 'decline') return { approved: false, reason: 'declined' };
  if (res && res.action === 'accept') return { approved: false, reason: 'declined' };
  return { approved: false, reason: 'no-answer' };
}

// ---------- compose-argument validation (multi-account mode) ----------

// Headers that the dedicated arguments own, or that define the message
// structure. Setting them through `headers` would make the dialog lie.
const RESERVED_HEADERS = new Set([
  'to', 'cc', 'bcc', 'from', 'reply-to', 'sender', 'subject',
  'mime-version', 'content-type', 'content-transfer-encoding',
]);
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const LINE_BREAK = /[\r\n]/;

function stringsIn(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
}

const HEADER_BOUND = ['to', 'cc', 'bcc', 'from', 'replyTo', 'subject', 'inReplyTo', 'references', 'threadId',
  'extraTo', 'extraCc', 'extraBcc', 'fromAlias', 'toMessageId', 'id'];

/**
 * Throws an Error describing the first problem, or returns nothing.
 * roots: fs-guard roots for attachment path reads.
 */
export function validateComposeArgs(args, roots) {
  for (const key of HEADER_BOUND) {
    if (args[key] === undefined) continue;
    for (const s of stringsIn(args[key])) {
      if (LINE_BREAK.test(s)) throw new Error(`Refused: "${key}" contains a line break. Header values must be a single line.`);
    }
  }
  if (args.headers !== undefined) {
    if (!args.headers || typeof args.headers !== 'object' || Array.isArray(args.headers)) throw new Error('Refused: "headers" must be an object of name: value strings.');
    for (const [k, v] of Object.entries(args.headers)) {
      if (!HEADER_NAME.test(k)) throw new Error(`Refused: header name ${JSON.stringify(k)} is not a valid header name.`);
      if (RESERVED_HEADERS.has(k.toLowerCase())) throw new Error(`Refused: "${k}" cannot be set through "headers"; use the dedicated argument (to, cc, bcc, from, replyTo, subject) so it is shown and checked.`);
      if (typeof v !== 'string' || LINE_BREAK.test(v)) throw new Error(`Refused: header "${k}" must be a single-line string.`);
    }
  }
  for (const listKey of ['attachments', 'inlineImages']) {
    for (const att of args[listKey] || []) {
      for (const f of ['filename', 'mimeType', 'cid']) {
        if (typeof att?.[f] === 'string' && (LINE_BREAK.test(att[f]) || att[f].includes('"'))) {
          throw new Error(`Refused: ${listKey} ${f} ${JSON.stringify(att[f])} contains a line break or a quote.`);
        }
      }
      if (att?.path && roots) assertReadable(att.path, roots);
      // A plain type/subtype only: parameters (a boundary, a charset) or a
      // multipart/message type would let a part carry structure the dialog
      // does not show.
      const type = effectiveType(att);
      if (!MIME_TYPE.test(type) || /^(multipart|message)\//i.test(type)) {
        throw new Error(`Refused: ${listKey} mimeType ${JSON.stringify(type)} must be a plain type/subtype such as application/pdf (no parameters, not multipart or message).`);
      }
      if (listKey === 'inlineImages' && !/^image\//i.test(type)) {
        throw new Error(`Refused: inline images must be images; ${JSON.stringify(att?.filename || att?.path || 'this one')} has type ${type}. Give mimeType image/png, image/jpeg, ... or send it as an attachment.`);
      }
      const data = att?.contentBase64 ?? att?.content;
      if (data !== undefined && (typeof data !== 'string' || !BASE64.test(data))) {
        throw new Error(`Refused: ${listKey} content must be base64 (or base64url) with no spaces or line breaks.`);
      }
    }
  }
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
  const alt = isSend ? ` ${draftAlternative(tool, label, draftAllowed)}` : '';
  switch (reason) {
    case 'blocked':
      return isSend
        ? `${verb} Sending from "${label}" is blocked by the user's settings for this account.${alt}`
        : `${verb} ${tool} is blocked by the user's settings for account "${label}".`;
    case 'cannot-ask':
      return isSend
        ? `${verb} Sending from "${label}" needs the user's approval and this client cannot ask for it.${alt}`
        : `${verb} ${tool} on "${label}" needs the user's approval and this client cannot ask for it. The user can do this in Gmail directly.`;
    case 'declined':
      return `${verb} The user declined. ${NO_RETRY}`;
    case 'no-answer':
      // Headless clients often claim they can ask and then cancel; this is the
      // same situation as cannot-ask, so it gets the same way forward.
      return `${verb} No answer from the user.${alt || ' The user can do this in Gmail directly.'} ${NO_RETRY}`;
    case 'abandoned':
      return `${verb} The request was cancelled before the user's approval arrived, so nothing was done. ${NO_RETRY}`;
    case 'changed':
      return `${verb} The draft changed while the user was deciding, so what they approved is no longer what would be sent. ${NO_RETRY}`;
    default:
      return `${verb} ${NO_RETRY}`;
  }
}
