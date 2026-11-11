// Filesystem guard for multi-account mode.
//
// Two tools touch local files on the model's say-so: get_attachment (savePath:
// writes a file) and the compose tools (attachments[].path, inlineImages[].path:
// read a file and mail it). Unguarded, the first can overwrite accounts.json and
// silently loosen the permissions; the second can mail a token under an innocent
// filename. In multi-account mode:
//   - reads and writes inside gmail-max's own folders (the config directory and
//     every account folder) are refused, after resolving symlinks;
//   - writes inside the package's own install folder are refused too;
//   - a save never overwrites an existing file (create-only, exclusive).
// Single-account mode carries no account context, so none of this applies there
// and its behaviour is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Canonical absolute path: the real path of the nearest existing ancestor,
 * with the not-yet-existing remainder appended. Follows symlinks, so a link
 * that points into a protected folder is caught.
 */
export function canonicalPath(p) {
  const abs = path.resolve(String(p));
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Case-insensitive on purpose: the default macOS and Windows filesystems ignore
// case, so "Accounts.JSON" is the same file. On a case-sensitive filesystem this
// can only over-refuse, never under-refuse.
function inside(target, root) {
  const rel = path.relative(root.toLowerCase(), target.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** { read: [...], write: [...] } canonical roots for an accounts config. */
export function protectedRoots(configDir, accountDirs) {
  const own = [configDir, ...accountDirs].map(canonicalPath);
  return { read: own, write: [...own, canonicalPath(PACKAGE_ROOT)] };
}

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
    this.userActionable = true;
  }
}

export function assertReadable(file, roots) {
  const target = canonicalPath(file);
  if (roots.read.some((r) => inside(target, r))) {
    throw new GuardError(`Refused: ${file} is inside gmail-max's own configuration (accounts file, tokens, OAuth client). It cannot be attached or read through this server.`);
  }
}

export function assertWritable(file, roots) {
  const target = canonicalPath(file);
  if (roots.write.some((r) => inside(target, r))) {
    throw new GuardError(`Refused: ${file} is inside gmail-max's own configuration or install folder. Save attachments somewhere else.`);
  }
  let exists = false;
  try { fs.lstatSync(file); exists = true; } catch { /* does not exist */ }
  if (exists) throw new GuardError(`Refused: ${file} already exists. In multi-account mode get_attachment never overwrites a file; choose a new path.`);
}

/** Create-only write: fails if anything (including a dangling symlink) is at the path. */
export function writeNewFile(file, buf) {
  fs.writeFileSync(file, buf, { flag: 'wx' });
}
