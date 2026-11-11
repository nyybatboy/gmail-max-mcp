// Checks on compose-tool arguments in multi-account mode. Each one exists
// because, without it, the mail that goes out would be malformed (a header
// split by a line break, two To lines, a broken MIME part) or because it
// protects a credential (an attachment path inside gmail-max's own folders).
// Nothing here is about approving mail; a well-formed message is never refused.
import { assertReadable } from './fs-guard.js';

const LINE_BREAK = /[\r\n]/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

// Headers RFC 5322 allows at most once (each has a dedicated argument), and the
// MIME structure headers lib/mime.js writes itself. Repeating one through
// `headers` produces a message with two To lines or two Content-Types.
const RESERVED_HEADERS = new Set([
  'to', 'cc', 'bcc', 'from', 'reply-to', 'sender', 'subject',
  'in-reply-to', 'references', 'message-id', 'date',
  'mime-version', 'content-type', 'content-transfer-encoding',
]);

const HEADER_BOUND = ['to', 'cc', 'bcc', 'from', 'replyTo', 'subject', 'inReplyTo', 'references', 'threadId',
  'extraTo', 'extraCc', 'extraBcc', 'fromAlias', 'toMessageId', 'id'];

// Address shapes lib/mime.js formats correctly: "addr", { email, name? }, or
// (list fields) a flat list of those. A nested list is sent as an empty header;
// an email given as a list is sent to every entry.
const LIST_ADDRESS_FIELDS = ['to', 'cc', 'bcc', 'extraTo', 'extraCc', 'extraBcc'];
const SINGLE_ADDRESS_FIELDS = ['from', 'replyTo', 'fromAlias'];

function validAddress(a) {
  if (typeof a === 'string') return a.trim() !== '';
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (typeof a.email !== 'string' || !a.email.trim()) return false;
  if (a.name !== undefined && typeof a.name !== 'string') return false;
  return Object.keys(a).every((k) => k === 'email' || k === 'name');
}

function stringsIn(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
}

/**
 * Returns a copy of the arguments with whitespace removed from inline base64
 * content (models often wrap it), so the content goes out as clean base64.
 */
export function normalizeComposeArgs(args) {
  const out = { ...args };
  for (const listKey of ['attachments', 'inlineImages']) {
    if (!Array.isArray(args[listKey])) continue;
    out[listKey] = args[listKey].map((att) => {
      if (!att || typeof att !== 'object') return att;
      const a = { ...att };
      for (const k of ['contentBase64', 'content']) if (typeof a[k] === 'string') a[k] = a[k].replace(/\s+/g, '');
      return a;
    });
  }
  return out;
}

/**
 * Throws an Error starting "Refused:" describing the first problem.
 * roots: fs-guard roots for attachment path reads.
 */
export function validateComposeArgs(args, roots) {
  for (const key of LIST_ADDRESS_FIELDS) {
    const v = args[key];
    if (v === undefined) continue;
    const list = Array.isArray(v) ? v : [v];
    if (!list.every(validAddress)) throw new Error(`Refused: "${key}" must be an address string, { email, name }, or a flat list of those.`);
  }
  for (const key of SINGLE_ADDRESS_FIELDS) {
    if (args[key] !== undefined && !validAddress(args[key])) throw new Error(`Refused: "${key}" must be an address string or { email, name }.`);
  }
  if (args.subject !== undefined && typeof args.subject !== 'string') throw new Error('Refused: "subject" must be a string.');
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
      if (RESERVED_HEADERS.has(k.toLowerCase())) throw new Error(`Refused: "${k}" cannot be set through "headers" (it would appear twice); use the dedicated argument (to, cc, bcc, from, replyTo, subject, inReplyTo, references).`);
      if (typeof v !== 'string' || LINE_BREAK.test(v)) throw new Error(`Refused: header "${k}" must be a single-line string.`);
    }
  }
  for (const listKey of ['attachments', 'inlineImages']) {
    for (const att of args[listKey] || []) {
      if (att?.path && roots) assertReadable(att.path, roots);
      for (const f of ['filename', 'mimeType', 'cid']) {
        if (typeof att?.[f] === 'string' && (LINE_BREAK.test(att[f]) || att[f].includes('"'))) {
          throw new Error(`Refused: ${listKey} ${f} ${JSON.stringify(att[f])} contains a line break or a quote.`);
        }
      }
      const data = att?.contentBase64 ?? att?.content;
      if (data !== undefined && (typeof data !== 'string' || !BASE64.test(data))) {
        throw new Error(`Refused: ${listKey} content must be base64 (or base64url).`);
      }
    }
  }
}

export function formatAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.map(formatAddress).filter(Boolean).join(', ');
  if (a.email) return a.name ? `${a.name} <${a.email}>` : a.email;
  return '';
}
