// Credential guard for multi-account mode.
//
// Two tools touch local files: get_attachment (savePath writes a file) and the
// compose tools (attachments[].path, inlineImages[].path read a file and mail
// it). In multi-account mode the folders that hold credentials (the config
// directory with the shared OAuth client and accounts.json, and every account
// folder with its token) are off limits to both:
//   - a file inside them is never read as an attachment, so a token cannot be
//     mailed;
//   - nothing is ever written inside them, so a token cannot be replaced.
// Everywhere else, saves go where they are told and overwrite, exactly as in
// single-account mode. Paths are resolved the way the operating system resolves
// them (symlinks followed before ".."), so a symlink cannot smuggle a path in.
// Single-account mode carries no account context, so none of this applies there.
import fs from 'node:fs';
import path from 'node:path';

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
    this.userActionable = true;
  }
}

/**
 * The real location a path names, resolved as the OS would: the deepest
 * existing prefix of the path as written (no lexical ".." folding) goes through
 * realpath, which follows each symlink before applying the next ".."; any
 * not-yet-existing remainder is appended. A final component that is a symlink
 * (even a dangling one) is followed to where a write would land.
 */
export function canonicalPath(p, { followLast = true } = {}) {
  const raw = path.isAbsolute(String(p)) ? String(p) : `${process.cwd()}${path.sep}${p}`;
  const parts = raw.split(/[\\/]+/);
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join(path.sep) || path.sep;
    let real;
    try {
      real = fs.realpathSync.native(prefix);
    } catch (err) {
      if (err.code === 'ENOENT' && i === parts.length && followLast) {
        // A dangling symlink: a write would create its target.
        try {
          const link = fs.readlinkSync(prefix);
          const target = path.isAbsolute(link) ? link : `${parts.slice(0, i - 1).join(path.sep)}${path.sep}${link}`;
          return canonicalPath(target, { followLast: false });
        } catch { /* not a symlink: fall through to the parent */ }
      }
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      continue;
    }
    return path.resolve(real, ...parts.slice(i));
  }
  return path.resolve(raw);
}

// Case-insensitive on purpose: the default macOS and Windows filesystems ignore
// case. On a case-sensitive filesystem this can only over-refuse.
export function inside(target, root) {
  const rel = path.relative(root.toLowerCase(), target.toLowerCase());
  // "..x" is a name inside the root; only ".." itself or "../..." leaves it.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Canonical credential folders: the config directory and every account folder. */
export function protectedRoots(configDir, accountDirs) {
  return [configDir, ...accountDirs].map((d) => canonicalPath(d));
}

export function assertReadable(file, roots) {
  const target = canonicalPath(file);
  if (roots.some((r) => inside(target, r))) {
    throw new GuardError(`Refused: ${file} is inside gmail-max's own configuration (accounts file, tokens, OAuth client). It cannot be attached or read through this server.`);
  }
}

export function assertWritable(file, roots) {
  const target = canonicalPath(file);
  if (roots.some((r) => inside(target, r))) {
    throw new GuardError(`Refused: ${file} is inside gmail-max's own configuration (accounts file, tokens, OAuth client). Save attachments somewhere else.`);
  }
}
