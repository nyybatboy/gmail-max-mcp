import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeHeader(value) {
  // RFC 2047 encoded-word for non-ASCII headers
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatAddress(addr) {
  if (!addr) return null;
  if (typeof addr === 'string') return addr;
  if (addr.name) return `${encodeHeader(addr.name)} <${addr.email}>`;
  return addr.email;
}

function formatAddressList(addrs) {
  if (!addrs) return null;
  const list = Array.isArray(addrs) ? addrs : [addrs];
  return list.map(formatAddress).filter(Boolean).join(', ');
}

function chunk(s, n = 76) {
  const lines = [];
  for (let i = 0; i < s.length; i += n) lines.push(s.slice(i, i + n));
  return lines.join('\r\n');
}

function quotedPrintable(text) {
  // Conservative QP for plaintext
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F=\x7F-\xFF]/g, c =>
      '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
    .replace(/(.{75})/g, '$1=\r\n');
}

function readAttachment(att) {
  // att: { filename, content (base64 string) } OR { path } OR { filename, contentBase64 }
  if (att.path) {
    const buf = fs.readFileSync(att.path);
    return {
      filename: att.filename || path.basename(att.path),
      mimeType: att.mimeType || guessMime(att.path),
      data: buf.toString('base64'),
    };
  }
  if (att.contentBase64 || att.content) {
    return {
      filename: att.filename || 'attachment.bin',
      mimeType: att.mimeType || 'application/octet-stream',
      data: att.contentBase64 || att.content,
    };
  }
  throw new Error(`attachment must have .path or .contentBase64`);
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html',
    '.json': 'application/json', '.xml': 'application/xml',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  };
  return map[ext] || 'application/octet-stream';
}

// ---------- Plaintext -> Gmail-style HTML rendering ----------

const _HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => _HTML_ESC[c]);
}

// Auto-link explicit http(s) URLs. Runs on already-escaped text, so an `&` inside a
// query string is already `&amp;` (valid in both the href and the visible text).
// Trailing sentence punctuation / entities are kept outside the link.
function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+/g, (match) => {
    let url = match, trail = '';
    const t = url.match(/(?:&[a-z]+;|[.,;:!?)\]])+$/i);
    if (t) { trail = t[0]; url = url.slice(0, url.length - trail.length); }
    return `<a href="${url}">${url}</a>${trail}`;
  });
}

/**
 * Heal machine hard-wraps. A human typing into Gmail compose writes each paragraph as
 * one logical line; an agent that hard-wraps prose at ~70 chars produces a frozen
 * narrow column. This rejoins continuation lines within a paragraph while preserving
 * intentional structure (blank lines, addresses, list items, signoffs). Conservative
 * by design: it only joins when the next line clearly continues prose (long enough
 * previous line, no sentence-terminating punctuation, next line starts lowercase).
 */
export function normalizeBody(text) {
  if (!text) return '';
  const norm = String(text).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  return norm.split(/\n{2,}/).map(block => {
    const out = [];
    for (const line of block.split('\n')) {
      if (out.length === 0) { out.push(line); continue; }
      const prev = out[out.length - 1].replace(/\s+$/, '');
      const next = line.replace(/^\s+/, '');
      const joinable =
        prev.length >= 45 &&                  // short prev = likely an intentional line
        !/[.!?]["')\]]?$/.test(prev) &&       // sentence end = a legitimate break
        /^[a-z]/.test(next);                  // next line continues prose
      if (joinable) out[out.length - 1] = `${prev} ${next}`;
      else out.push(line);
    }
    return out.join('\n');
  }).join('\n\n');
}

/**
 * Render plaintext to HTML matching Gmail web compose output:
 *   <div dir="ltr"><div>para one</div><div><br></div><div>para two</div></div>
 * Blank-line-separated blocks become paragraph <div>s; single newlines within a block
 * become <br> (intentional line structure: addresses, list items). URLs auto-link.
 * The result reflows to the reader's viewport like any normal email.
 */
export function htmlFromText(text) {
  const norm = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!norm) return '<div dir="ltr"></div>';
  const blocks = norm.split(/\n{2,}/).map(block => {
    if (block.trim() === '') return '<div><br></div>';
    const inner = block.split('\n').map(line => linkify(escapeHtml(line))).join('<br>');
    return `<div>${inner}</div>`;
  });
  return `<div dir="ltr">${blocks.join('<div><br></div>')}</div>`;
}

/**
 * Build a raw RFC2822 message ready for Gmail's `raw` field.
 *
 * @param {Object} m
 * @param {string|Object|Array} m.to
 * @param {string|Object|Array} [m.cc]
 * @param {string|Object|Array} [m.bcc]
 * @param {string|Object} [m.from]            override From (must be a verified send-as alias)
 * @param {string|Object} [m.replyTo]
 * @param {string} m.subject
 * @param {string} [m.text]                   plaintext body
 * @param {string} [m.html]                   HTML body
 * @param {Array}  [m.attachments]            [{ path } | { filename, contentBase64, mimeType }]
 * @param {string} [m.inReplyTo]              Message-Id of the parent (for threaded replies)
 * @param {Array}  [m.references]             list of Message-Ids (older first)
 * @param {Object} [m.headers]                additional raw headers
 * @returns {string} base64url-encoded raw message
 */
export function buildRawMessage(m) {
  // Auto-render: a text-only body becomes a multipart/alternative message with a
  // Gmail-style HTML part plus the cleaned text as the plain-text fallback — the modern
  // norm, instead of bare text/plain. Opt out with `plaintextOnly`; override by supplying
  // `html`. This is the single chokepoint every send/draft/update path funnels through.
  if (m.text && !m.html && !m.plaintextOnly) {
    const normalized = normalizeBody(m.text);
    m = { ...m, text: normalized, html: htmlFromText(normalized) };
  }

  const boundaryMixed = `mixed_${crypto.randomBytes(8).toString('hex')}`;
  const boundaryAlt = `alt_${crypto.randomBytes(8).toString('hex')}`;
  const hasAttachments = m.attachments && m.attachments.length > 0;
  const hasBothBodies = m.text && m.html;

  const headers = [];
  headers.push(`MIME-Version: 1.0`);
  if (m.from) headers.push(`From: ${formatAddress(m.from)}`);
  headers.push(`To: ${formatAddressList(m.to)}`);
  if (m.cc) headers.push(`Cc: ${formatAddressList(m.cc)}`);
  if (m.bcc) headers.push(`Bcc: ${formatAddressList(m.bcc)}`);
  if (m.replyTo) headers.push(`Reply-To: ${formatAddress(m.replyTo)}`);
  headers.push(`Subject: ${encodeHeader(m.subject || '')}`);
  if (m.inReplyTo) headers.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references) {
    const refs = Array.isArray(m.references) ? m.references.join(' ') : m.references;
    headers.push(`References: ${refs}`);
  }
  if (m.headers) {
    for (const [k, v] of Object.entries(m.headers)) headers.push(`${k}: ${v}`);
  }

  const bodyParts = [];

  function bodyContent() {
    if (hasBothBodies) {
      const parts = [];
      parts.push(`--${boundaryAlt}`);
      parts.push(`Content-Type: text/plain; charset="UTF-8"`);
      parts.push(`Content-Transfer-Encoding: quoted-printable`);
      parts.push('');
      parts.push(quotedPrintable(m.text));
      parts.push(`--${boundaryAlt}`);
      parts.push(`Content-Type: text/html; charset="UTF-8"`);
      parts.push(`Content-Transfer-Encoding: quoted-printable`);
      parts.push('');
      parts.push(quotedPrintable(m.html));
      parts.push(`--${boundaryAlt}--`);
      return {
        contentTypeHeader: `multipart/alternative; boundary="${boundaryAlt}"`,
        body: parts.join('\r\n'),
      };
    }
    if (m.html) {
      return {
        contentTypeHeader: `text/html; charset="UTF-8"`,
        transferEncoding: 'quoted-printable',
        body: quotedPrintable(m.html),
      };
    }
    return {
      contentTypeHeader: `text/plain; charset="UTF-8"`,
      transferEncoding: 'quoted-printable',
      body: quotedPrintable(m.text || ''),
    };
  }

  if (hasAttachments) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);
    headers.push('');
    bodyParts.push(`--${boundaryMixed}`);
    const inner = bodyContent();
    bodyParts.push(`Content-Type: ${inner.contentTypeHeader}`);
    if (inner.transferEncoding) bodyParts.push(`Content-Transfer-Encoding: ${inner.transferEncoding}`);
    bodyParts.push('');
    bodyParts.push(inner.body);
    for (const att of m.attachments) {
      const a = readAttachment(att);
      bodyParts.push(`--${boundaryMixed}`);
      bodyParts.push(`Content-Type: ${a.mimeType}; name="${a.filename}"`);
      bodyParts.push(`Content-Disposition: attachment; filename="${a.filename}"`);
      bodyParts.push(`Content-Transfer-Encoding: base64`);
      bodyParts.push('');
      bodyParts.push(chunk(a.data));
    }
    bodyParts.push(`--${boundaryMixed}--`);
  } else {
    const inner = bodyContent();
    headers.push(`Content-Type: ${inner.contentTypeHeader}`);
    if (inner.transferEncoding) headers.push(`Content-Transfer-Encoding: ${inner.transferEncoding}`);
    headers.push('');
    bodyParts.push(inner.body);
  }

  const raw = headers.join('\r\n') + '\r\n' + bodyParts.join('\r\n');
  return b64url(raw);
}
