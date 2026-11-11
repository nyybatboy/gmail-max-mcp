// Filesystem guard for multi-account mode.
//
// Two tools touch local files on the model's say-so: get_attachment (savePath:
// writes a file) and the compose tools (attachments[].path, inlineImages[].path:
// read a file and mail it). Unguarded, the first can overwrite accounts.json, or
// create a file that runs later (a shell startup file, a launch agent, a client
// config); the second can mail a token under an innocent filename. In
// multi-account mode:
//   - saves go only into the configured save folders (accounts.json
//     "saveFolders"; default ~/Downloads/gmail-max), checked by real path; a
//     relative savePath is resolved against the first save folder;
//   - a save never overwrites anything (create-only, exclusive);
//   - reads and writes inside gmail-max's own folders (the config directory and
//     every account folder) are refused, and writes inside the package folder;
//   - any path with a ".." segment is refused outright.
// Single-account mode carries no account context, so none of this applies there
// and its behaviour is unchanged.
import fs from 'node:fs';
import os from 'node:os';
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
export function inside(target, root) {
  const rel = path.relative(root.toLowerCase(), target.toLowerCase());
  // "..x" is a name inside the root; only ".." itself or "../..." leaves it.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * True if any segment of the path is "..". Such paths are refused outright:
 * path.resolve folds ".." away before symlinks are followed, while the OS
 * follows the symlink first, so the two can disagree about where a path lands.
 */
export function hasDotDot(p) {
  return String(p).split(/[\\/]+/).includes('..');
}

function refuseDotDot(p) {
  if (hasDotDot(p)) throw new GuardError(`Refused: ${p} contains a ".." segment. Use a path without "..".`);
}

/** The default save folder when accounts.json names none: ~/Downloads/gmail-max. */
export function defaultSaveFolder() {
  return path.join(os.homedir(), 'Downloads', 'gmail-max');
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (String(p).startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
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
  refuseDotDot(file);
  const target = canonicalPath(file);
  if (roots.read.some((r) => inside(target, r))) {
    throw new GuardError(`Refused: ${file} is inside gmail-max's own configuration (accounts file, tokens, OAuth client). It cannot be attached or read through this server.`);
  }
}

export function assertWritable(file, roots) {
  refuseDotDot(file);
  const target = canonicalPath(file);
  if (roots.write.some((r) => inside(target, r))) {
    throw new GuardError(`Refused: ${file} is inside gmail-max's own configuration or install folder. Save attachments somewhere else.`);
  }
  let exists = false;
  try { fs.lstatSync(file); exists = true; } catch { /* does not exist */ }
  if (exists) throw new GuardError(`Refused: ${file} already exists. In multi-account mode get_attachment never overwrites a file; choose a new path.`);
}

/**
 * Where a save may go. Returns the absolute path to write, or throws.
 * saveFolders: absolute paths (already ~-expanded); the first one is where a
 * relative savePath lands. The target must be inside a save folder by real
 * path, outside gmail-max's own folders, and must not exist yet.
 */
export function resolveSaveTarget(savePath, saveFolders, roots) {
  if (typeof savePath !== 'string' || !savePath) throw new GuardError('Refused: savePath must be a non-empty string.');
  refuseDotDot(savePath);
  const abs = path.isAbsolute(savePath) ? savePath : path.join(saveFolders[0], savePath);
  const target = canonicalPath(abs);
  if (!saveFolders.some((f) => inside(target, canonicalPath(f)))) {
    throw new GuardError(`Refused: ${savePath} is outside the save folders (${saveFolders.join(', ')}). In multi-account mode attachments are saved only there; a relative savePath is saved under ${saveFolders[0]}. The user can add save folders; the model cannot.`);
  }
  assertWritable(abs, roots);
  // Create the save folder itself on first use (never any other folder).
  for (const f of saveFolders) {
    if (inside(target, canonicalPath(f)) && !fs.existsSync(f)) fs.mkdirSync(f, { recursive: true, mode: 0o700 });
  }
  return abs;
}

/** Create-only write: fails if anything (including a dangling symlink) is at the path. */
export function writeNewFile(file, buf) {
  fs.writeFileSync(file, buf, { flag: 'wx' });
}
