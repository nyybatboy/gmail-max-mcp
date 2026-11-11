// Per-call account context.
//
// In multi-account mode every Gmail call runs inside runWithAccount(account, fn).
// lib/auth.js and lib/gmail.js read currentAccount() to pick the right token,
// OAuth client and cached API client, so the ~60 wrappers in lib/gmail.js keep
// their signatures. With no context (single-account mode, the default) both
// modules behave exactly as they always have.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/**
 * account: { label, dir, tokenPath, credentialsPath, profilePath }
 * (see accountPaths in lib/accounts.js)
 */
export function runWithAccount(account, fn) {
  return als.run(account, fn);
}

export function currentAccount() {
  return als.getStore() || null;
}
