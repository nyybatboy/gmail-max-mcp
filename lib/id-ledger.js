// Remembers which account each message/thread/draft ID came from during this
// server session, so a "not found" error can say "that ID came from account X".
//
// This is an error-message improvement, not a safety feature: Gmail already
// rejects an ID that belongs to another mailbox. It never blocks a call, and
// IDs it has not seen (for example from an earlier session) pass untouched.

const ID_KEYS = new Set(['id', 'threadId']);
const ARG_KEYS = ['id', 'toMessageId', 'messageId', 'threadId'];
const MAX_DEPTH = 6;

export class IdLedger {
  constructor({ max = 20000 } = {}) {
    this.max = max;
    this.map = new Map();
  }

  add(id, label) {
    let owners = this.map.get(id);
    if (!owners) {
      owners = new Set();
      this.map.set(id, owners);
      if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    owners.add(label);
  }

  record(label, value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const v of value) this.record(label, v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (ID_KEYS.has(k) && typeof v === 'string' && v) this.add(v, label);
      else if (v && typeof v === 'object') this.record(label, v, depth + 1);
    }
  }

  /** A hint string for a not-found error, or null. */
  hint(label, args, err) {
    if (!isNotFound(err)) return null;
    const candidates = [];
    for (const k of ARG_KEYS) if (typeof args?.[k] === 'string') candidates.push(args[k]);
    if (Array.isArray(args?.ids)) candidates.push(...args.ids.filter((x) => typeof x === 'string'));
    for (const id of candidates) {
      const owners = this.map.get(id);
      if (owners && !owners.has(label)) {
        const other = [...owners][0];
        return `Hint: ID ${id} was returned by account "${other}" earlier in this session, not "${label}". Did you mean account "${other}"?`;
      }
    }
    return null;
  }
}

function isNotFound(err) {
  const codes = [err?.code, err?.status, err?.response?.status, err?.cause?.code, err?.cause?.status, err?.cause?.response?.status];
  return codes.some((c) => c === 404 || c === '404');
}
