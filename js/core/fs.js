/**
 * js/core/fs.js — the virtual filesystem (ARCHITECTURE §6).
 *
 * Single source of truth for Terminal, Files, Text Editor, Code-OSS and Trash.
 * Errors are `FsError` with POSIX codes so commands can print the exact GNU
 * coreutils phrasing. Writes emit `fs:change` on the bus and schedule a
 * debounced persist into `store`.
 *
 * Trash follows the freedesktop.org Trash specification: files move to
 * ~/.local/share/Trash/files and a `.trashinfo` file is written alongside in
 * ~/.local/share/Trash/info.
 */

import { bus } from './bus.js';
import { store } from './store.js';
import * as path from './path.js';
import { buildDefaultTree, dirNode, fileNode, linkNode, PROC_GENERATORS } from './fs-tree.js';

const HOME = '/home/ubuntu';
const TRASH_ROOT = `${HOME}/.local/share/Trash`;
const TRASH_FILES = `${TRASH_ROOT}/files`;
const TRASH_INFO = `${TRASH_ROOT}/info`;
const MAX_SYMLINK_HOPS = 40;
const PERSIST_DELAY_MS = 400;
const DIR_SIZE = 4096;

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

const CODE_MESSAGES = {
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  ENOTEMPTY: 'Directory not empty',
  EACCES: 'Permission denied',
  EINVAL: 'Invalid argument',
  ELOOP: 'Too many levels of symbolic links',
  ENOSPC: 'No space left on device',
  EXDEV: 'Invalid cross-device link',
};

/**
 * A POSIX-shaped filesystem error. `message` is the bare GNU phrase so
 * callers can build e.g. `ls: cannot access 'foo': No such file or directory`.
 */
export class FsError extends Error {
  /**
   * @param {string} code POSIX errno name
   * @param {string} [errPath] the offending path
   * @param {string} [message] override for the human phrase
   */
  constructor(code, errPath = '', message = '') {
    super(message || CODE_MESSAGES[code] || code);
    this.name = 'FsError';
    this.code = code;
    this.path = errPath;
  }
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

let root = buildDefaultTree();
let persistTimer = 0;
let suspendPersist = false;

function schedulePersist() {
  if (suspendPersist) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    writeSnapshot();
  }, PERSIST_DELAY_MS);
}

function writeSnapshot() {
  store.set('fs', serialize(root));
}

function change(op, p, to) {
  bus.emit('fs:change', to === undefined ? { op, path: p } : { op, path: p, to });
  schedulePersist();
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function utf8Length(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.codePointAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c < 0x10000) bytes += 3;
    else {
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
}

/** GNU `ls` under en_US.UTF-8: dotfiles first, then case-insensitive. */
function collate(a, b) {
  const da = a.charCodeAt(0) === 46 ? 0 : 1;
  const db = b.charCodeAt(0) === 46 ? 0 : 1;
  if (da !== db) return da - db;
  const ka = (da === 0 ? a.slice(1) : a).toLowerCase();
  const kb = (db === 0 ? b.slice(1) : b).toLowerCase();
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function joinPath(dir, name) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function abs(p) {
  if (typeof p !== 'string' || p === '') throw new FsError('ENOENT', String(p));
  return path.normalize(path.isAbsolute(p) ? p : `/${p}`);
}

/**
 * Walk to a node, resolving symlinks along the way.
 * @param {string} p absolute path
 * @param {boolean} followFinal resolve a trailing symlink
 * @returns {{node: object, path: string}} node plus its fully resolved path
 */
function lookup(p, followFinal = true) {
  const target = abs(p);
  let segments = path.split(target);
  let node = root;
  let resolved = [];
  let hops = 0;
  let i = 0;

  while (i < segments.length) {
    if (node.type !== 'dir') {
      throw new FsError('ENOTDIR', `/${resolved.join('/')}`);
    }
    const name = segments[i];
    if (name === '.') {
      i += 1;
      continue;
    }
    if (name === '..') {
      resolved.pop();
      node = root;
      for (const seg of resolved) node = node.children[seg];
      i += 1;
      continue;
    }
    const child = node.children[name];
    if (!child) throw new FsError('ENOENT', target);

    const isFinal = i === segments.length - 1;
    if (child.type === 'link' && (!isFinal || followFinal)) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) throw new FsError('ELOOP', target);
      const base = resolved.length ? `/${resolved.join('/')}` : '/';
      const linkTarget = path.isAbsolute(child.target)
        ? path.normalize(child.target)
        : path.normalize(joinPath(base, child.target));
      const rest = segments.slice(i + 1);
      segments = path.split(linkTarget).concat(rest);
      node = root;
      resolved = [];
      i = 0;
      continue;
    }

    node = child;
    resolved.push(name);
    i += 1;
  }

  return { node, path: resolved.length ? `/${resolved.join('/')}` : '/' };
}

function tryLookup(p, followFinal = true) {
  try {
    return lookup(p, followFinal);
  } catch {
    return null;
  }
}

/**
 * Resolve the parent directory of a path for a write operation.
 * @param {string} p
 * @returns {{parent: object, parentPath: string, name: string, target: string}}
 */
function parentOf(p) {
  const target = abs(p);
  if (target === '/') throw new FsError('EINVAL', target);
  const parentPath = path.dirname(target);
  const name = path.basename(target);
  const found = lookup(parentPath, true);
  if (found.node.type !== 'dir') throw new FsError('ENOTDIR', parentPath);
  return { parent: found.node, parentPath: found.path, name, target };
}

function isProcPath(p) {
  return p === '/proc' || p.startsWith('/proc/');
}

function sizeOf(node, resolvedPath) {
  if (typeof node.size === 'number') return node.size;
  if (resolvedPath && isProcPath(resolvedPath)) return 0;
  if (node.type === 'dir') return DIR_SIZE;
  if (node.type === 'link') return utf8Length(node.target || '');
  return utf8Length(node.content || '');
}

function statObject(node, resolvedPath, displayPath) {
  return {
    path: displayPath === undefined ? resolvedPath : displayPath,
    name: node.name || path.basename(resolvedPath) || '/',
    type: node.type,
    mode: node.mode,
    owner: node.owner,
    group: node.group,
    size: sizeOf(node, resolvedPath),
    mtime: node.mtime,
    isDir: node.type === 'dir',
    isFile: node.type === 'file',
    isLink: node.type === 'link',
    target: node.type === 'link' ? node.target : undefined,
  };
}

function cloneNode(node) {
  if (node.type === 'dir') {
    const copy = dirNode(node.name, { mode: node.mode, owner: node.owner, group: node.group, mtime: node.mtime });
    for (const [name, child] of Object.entries(node.children)) copy.children[name] = cloneNode(child);
    return copy;
  }
  if (node.type === 'link') {
    return linkNode(node.name, node.target, { owner: node.owner, group: node.group, mtime: node.mtime });
  }
  const copy = fileNode(node.name, node.content, {
    mode: node.mode,
    owner: node.owner,
    group: node.group,
    mtime: node.mtime,
  });
  if (typeof node.size === 'number') copy.size = node.size;
  return copy;
}

function serialize(node) {
  const out = {
    type: node.type,
    name: node.name,
    mode: node.mode,
    owner: node.owner,
    group: node.group,
    mtime: node.mtime,
  };
  if (node.type === 'dir') {
    const children = {};
    for (const [name, child] of Object.entries(node.children)) children[name] = serialize(child);
    out.children = children;
  } else if (node.type === 'link') {
    out.target = node.target;
  } else {
    out.content = node.content;
    if (typeof node.size === 'number') out.size = node.size;
  }
  return out;
}

function deserialize(json, fallbackName = '') {
  if (!json || typeof json !== 'object') throw new FsError('EINVAL', '/');
  const type = json.type === 'dir' || json.type === 'file' || json.type === 'link' ? json.type : null;
  if (!type) throw new FsError('EINVAL', '/');
  const name = typeof json.name === 'string' ? json.name : fallbackName;
  const common = {
    mode: Number.isFinite(json.mode)
      ? json.mode
      : type === 'dir'
        ? 0o755
        : type === 'link'
          ? 0o777
          : 0o644,
    owner: typeof json.owner === 'string' ? json.owner : 'root',
    group: typeof json.group === 'string' ? json.group : 'root',
    mtime: Number.isFinite(json.mtime) ? json.mtime : Date.now(),
  };
  if (type === 'dir') {
    const node = dirNode(name, common);
    const children = json.children && typeof json.children === 'object' ? json.children : {};
    for (const [childName, childJson] of Object.entries(children)) {
      node.children[childName] = deserialize(childJson, childName);
    }
    return node;
  }
  if (type === 'link') {
    const node = linkNode(name, typeof json.target === 'string' ? json.target : '', common);
    node.mode = common.mode;
    return node;
  }
  const node = fileNode(name, typeof json.content === 'string' ? json.content : '', common);
  if (Number.isFinite(json.size)) node.size = json.size;
  return node;
}

function mkdirp(p, opts = {}) {
  const target = abs(p);
  if (target === '/') return root;
  const parts = path.split(target);
  let node = root;
  let walked = '';
  for (const name of parts) {
    walked = joinPath(walked || '/', name);
    if (node.type !== 'dir') throw new FsError('ENOTDIR', walked);
    let child = node.children[name];
    if (child && child.type === 'link') {
      const resolvedLink = tryLookup(walked, true);
      if (!resolvedLink) throw new FsError('ENOENT', walked);
      child = resolvedLink.node;
    }
    if (!child) {
      child = dirNode(name, { mode: opts.mode || 0o755, owner: opts.owner || 'ubuntu', group: opts.group || 'ubuntu' });
      node.children[name] = child;
    } else if (child.type !== 'dir') {
      throw new FsError('ENOTDIR', walked);
    }
    node = child;
  }
  return node;
}

function detach(p) {
  const { parent, name, target } = parentOf(p);
  const node = parent.children[name];
  if (!node) throw new FsError('ENOENT', target);
  delete parent.children[name];
  parent.mtime = Date.now();
  return node;
}

/* ------------------------------------------------------------------ *
 * glob
 * ------------------------------------------------------------------ */

const MAGIC_RE = /[*?[]/;

function segmentToRegExp(seg) {
  let out = '^';
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i];
    if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      let j = i + 1;
      let negate = false;
      if (seg[j] === '!' || seg[j] === '^') {
        negate = true;
        j += 1;
      }
      let body = '';
      if (seg[j] === ']') {
        body += '\\]';
        j += 1;
      }
      while (j < seg.length && seg[j] !== ']') {
        const c = seg[j];
        if (c === '\\' || c === '^' || c === '[') body += `\\${c}`;
        else body += c;
        j += 1;
      }
      if (j >= seg.length) {
        // Unterminated class — treat the bracket literally, like bash does.
        out += '\\[';
        continue;
      }
      out += `[${negate ? '^' : ''}${body}]`;
      i = j;
    } else if (ch === '\\' && i + 1 < seg.length) {
      i += 1;
      out += seg[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function globWalk(node, dirPath, segs, index, results, depth) {
  if (depth > 64) return;
  if (index >= segs.length) {
    results.add(dirPath);
    return;
  }
  const seg = segs[index];

  if (seg === '**') {
    globWalk(node, dirPath, segs, index + 1, results, depth + 1);
    if (node.type !== 'dir') return;
    for (const name of Object.keys(node.children)) {
      if (name.charCodeAt(0) === 46) continue;
      const child = node.children[name];
      if (child.type !== 'dir') continue;
      globWalk(child, joinPath(dirPath, name), segs, index, results, depth + 1);
    }
    return;
  }

  if (node.type !== 'dir') return;
  const literal = !MAGIC_RE.test(seg);
  const re = literal ? null : segmentToRegExp(seg);
  const hidden = seg.charCodeAt(0) === 46;
  const isLast = index === segs.length - 1;

  for (const name of Object.keys(node.children)) {
    if (literal) {
      if (name !== seg) continue;
    } else {
      if (!hidden && name.charCodeAt(0) === 46) continue;
      if (!re.test(name)) continue;
    }
    const childPath = joinPath(dirPath, name);
    if (isLast) {
      results.add(childPath);
      continue;
    }
    let child = node.children[name];
    if (child.type === 'link') {
      const followed = tryLookup(childPath, true);
      if (!followed) continue;
      child = followed.node;
    }
    if (child.type === 'dir') globWalk(child, childPath, segs, index + 1, results, depth + 1);
  }
}

/* ------------------------------------------------------------------ *
 * trash helpers
 * ------------------------------------------------------------------ */

function encodeTrashPath(p) {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function decodeTrashPath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** `2024-08-18T09:41:07` — local time, as the freedesktop spec requires. */
function trashStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`;
}

function parseTrashStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return Date.now();
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  ).getTime();
}

function ensureTrashDirs() {
  mkdirp(TRASH_FILES, { owner: 'ubuntu', group: 'ubuntu' });
  mkdirp(TRASH_INFO, { owner: 'ubuntu', group: 'ubuntu' });
  return {
    files: lookup(TRASH_FILES).node,
    info: lookup(TRASH_INFO).node,
  };
}

function uniqueTrashName(filesDir, infoDir, name) {
  if (!filesDir.children[name] && !infoDir.children[`${name}.trashinfo`]) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${stem}.${n}${ext}`;
    if (!filesDir.children[candidate] && !infoDir.children[`${candidate}.trashinfo`]) return candidate;
  }
  return `${stem}.${Date.now()}${ext}`;
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

export const fs = {
  /** Home directory of the simulated user. */
  HOME,
  /** Absolute path of the freedesktop trash directory. */
  TRASH_ROOT,

  /* --- read ---------------------------------------------------- */

  /**
   * @param {string} p
   * @returns {boolean} true when the path resolves (broken links are false)
   */
  exists(p) {
    return tryLookup(p, true) !== null;
  },

  /**
   * @param {string} p
   * @returns {boolean} true when the path itself exists, link or not
   */
  lexists(p) {
    return tryLookup(p, false) !== null;
  },

  /**
   * Follows symlinks.
   * @param {string} p
   * @returns {object} stat object
   */
  stat(p) {
    const found = lookup(p, true);
    return statObject(found.node, found.path, abs(p));
  },

  /**
   * Does not follow a trailing symlink.
   * @param {string} p
   * @returns {object} stat object
   */
  lstat(p) {
    const found = lookup(p, false);
    return statObject(found.node, found.path, abs(p));
  },

  /**
   * @param {string} p
   * @param {{withStats?: boolean}} [opts]
   * @returns {string[]|object[]} sorted names, or lstat objects
   */
  readdir(p, { withStats = false } = {}) {
    const found = lookup(p, true);
    if (found.node.type !== 'dir') throw new FsError('ENOTDIR', abs(p));
    const names = Object.keys(found.node.children).sort(collate);
    if (!withStats) return names;
    return names.map((name) => {
      const child = found.node.children[name];
      const childPath = joinPath(found.path, name);
      return statObject(child, childPath, joinPath(abs(p), name));
    });
  },

  /**
   * @param {string} p
   * @returns {string} file contents (generated for the live /proc files)
   */
  readFile(p) {
    const found = lookup(p, true);
    if (found.node.type === 'dir') throw new FsError('EISDIR', abs(p));
    const generator = PROC_GENERATORS[found.path];
    if (generator) return generator();
    return found.node.content || '';
  },

  /**
   * @param {string} p
   * @returns {string} the raw link target
   */
  readlink(p) {
    const found = lookup(p, false);
    if (found.node.type !== 'link') throw new FsError('EINVAL', abs(p));
    return found.node.target;
  },

  /** @param {string} p @returns {boolean} */
  isDir(p) {
    const found = tryLookup(p, true);
    return found !== null && found.node.type === 'dir';
  },

  /** @param {string} p @returns {boolean} */
  isFile(p) {
    const found = tryLookup(p, true);
    return found !== null && found.node.type === 'file';
  },

  /** @param {string} p @returns {boolean} */
  isLink(p) {
    const found = tryLookup(p, false);
    return found !== null && found.node.type === 'link';
  },

  /**
   * Recursive size in bytes, counting one block per directory like `du` does.
   * @param {string} p
   * @returns {number}
   */
  du(p) {
    const found = lookup(p, true);
    const walk = (node, nodePath) => {
      if (node.type === 'dir') {
        let total = DIR_SIZE;
        for (const [name, child] of Object.entries(node.children)) {
          total += walk(child, joinPath(nodePath, name));
        }
        return total;
      }
      return sizeOf(node, nodePath);
    };
    return walk(found.node, found.path);
  },

  /**
   * Expand a shell glob. Supports `*`, `?`, `[abc]`, `[a-z]`, `[!abc]` and `**`.
   * Leading dots are only matched by a pattern that starts with a dot.
   * @param {string} pattern
   * @param {string} [cwd]
   * @returns {string[]} absolute paths, sorted
   */
  glob(pattern, cwd = HOME) {
    if (typeof pattern !== 'string' || pattern === '') return [];
    const expanded = path.expandTilde(pattern, HOME);
    const absolute = path.isAbsolute(expanded);
    const base = absolute ? '/' : path.normalize(path.isAbsolute(cwd) ? cwd : `/${cwd}`);

    const raw = expanded.split('/').filter((s) => s !== '');
    const magicAt = raw.findIndex((s) => s === '**' || MAGIC_RE.test(s));

    // No wildcards at all: the pattern is just a path.
    if (magicAt < 0) {
      const literalPath = path.resolve(base, expanded);
      return tryLookup(literalPath, false) ? [literalPath] : [];
    }

    // Resolve the fixed prefix (which may contain `.` or `..`) up front.
    const prefix = raw.slice(0, magicAt).join('/');
    const startPath = path.resolve(base, absolute ? `/${prefix}` : prefix);
    const startNode = tryLookup(startPath, true);
    if (!startNode || startNode.node.type !== 'dir') return [];

    const segs = raw.slice(magicAt);
    const results = new Set();
    globWalk(startNode.node, startNode.path, segs, 0, results, 0);
    return Array.from(results).sort((a, b) => {
      const da = path.dirname(a);
      const db = path.dirname(b);
      if (da !== db) return da < db ? -1 : 1;
      return collate(path.basename(a), path.basename(b));
    });
  },

  /* --- write --------------------------------------------------- */

  /**
   * @param {string} p
   * @param {string} content
   * @param {{append?: boolean, create?: boolean, mode?: number, owner?: string, group?: string}} [opts]
   * @returns {object} stat of the written file
   */
  writeFile(p, content, { append = false, create = true, mode, owner, group } = {}) {
    const { parent, name, target } = parentOf(p);
    const text = content === undefined || content === null ? '' : String(content);
    let node = parent.children[name];

    if (node && node.type === 'link') {
      const followed = tryLookup(target, true);
      if (followed && followed.node.type === 'dir') throw new FsError('EISDIR', target);
      if (followed) node = followed.node;
    }

    if (node) {
      if (node.type === 'dir') throw new FsError('EISDIR', target);
      node.content = append ? (node.content || '') + text : text;
      node.mtime = Date.now();
      if (typeof node.size === 'number') delete node.size;
      if (mode !== undefined) node.mode = mode;
    } else {
      if (!create) throw new FsError('ENOENT', target);
      node = fileNode(name, text, {
        mode: mode === undefined ? 0o644 : mode,
        owner: owner || 'ubuntu',
        group: group || 'ubuntu',
        mtime: Date.now(),
      });
      parent.children[name] = node;
      parent.mtime = Date.now();
    }
    change('write', target);
    return statObject(node, target);
  },

  /**
   * @param {string} p
   * @param {{parents?: boolean, mode?: number}} [opts]
   * @returns {object} stat of the created directory
   */
  mkdir(p, { parents = false, mode = 0o755 } = {}) {
    const target = abs(p);
    if (parents) {
      const node = mkdirp(target, { mode, owner: 'ubuntu', group: 'ubuntu' });
      change('mkdir', target);
      return statObject(node, target);
    }
    const { parent, name } = parentOf(target);
    if (parent.children[name]) throw new FsError('EEXIST', target);
    const node = dirNode(name, { mode, owner: 'ubuntu', group: 'ubuntu', mtime: Date.now() });
    parent.children[name] = node;
    parent.mtime = Date.now();
    change('mkdir', target);
    return statObject(node, target);
  },

  /** @param {string} p */
  rmdir(p) {
    const target = abs(p);
    if (target === '/') throw new FsError('EACCES', target);
    const found = lookup(target, false);
    if (found.node.type !== 'dir') throw new FsError('ENOTDIR', target);
    if (Object.keys(found.node.children).length > 0) throw new FsError('ENOTEMPTY', target);
    detach(target);
    change('rmdir', target);
  },

  /** @param {string} p */
  unlink(p) {
    const target = abs(p);
    const found = lookup(target, false);
    if (found.node.type === 'dir') throw new FsError('EISDIR', target);
    detach(target);
    change('unlink', target);
  },

  /**
   * @param {string} p
   * @param {{recursive?: boolean, force?: boolean}} [opts]
   * @returns {boolean} true when something was removed
   */
  rm(p, { recursive = false, force = false } = {}) {
    const target = abs(p);
    if (target === '/') throw new FsError('EACCES', target, 'it is dangerous to operate recursively on \'/\'');
    const found = tryLookup(target, false);
    if (!found) {
      if (force) return false;
      throw new FsError('ENOENT', target);
    }
    if (found.node.type === 'dir') {
      if (!recursive) throw new FsError('EISDIR', target);
      detach(target);
      change('rmdir', target);
      return true;
    }
    detach(target);
    change('unlink', target);
    return true;
  },

  /**
   * @param {string} src
   * @param {string} dst
   * @param {{recursive?: boolean}} [opts]
   * @returns {string} the absolute destination path
   */
  cp(src, dst, { recursive = false } = {}) {
    const from = abs(src);
    const source = lookup(from, false);
    if (source.node.type === 'dir' && !recursive) throw new FsError('EISDIR', from);

    let to = abs(dst);
    const existing = tryLookup(to, true);
    if (existing && existing.node.type === 'dir') to = joinPath(to, path.basename(from));

    if (source.node.type === 'dir' && (to === from || to.startsWith(`${from}/`))) {
      throw new FsError('EINVAL', to, `cannot copy a directory, '${from}', into itself, '${to}'`);
    }

    const { parent, name } = parentOf(to);
    const copy = cloneNode(source.node);
    copy.name = name;
    copy.mtime = Date.now();
    parent.children[name] = copy;
    parent.mtime = Date.now();
    change('write', to, from);
    return to;
  },

  /**
   * @param {string} src
   * @param {string} dst
   * @returns {string} the absolute destination path
   */
  mv(src, dst) {
    const from = abs(src);
    const source = lookup(from, false);

    let to = abs(dst);
    const existing = tryLookup(to, true);
    if (existing && existing.node.type === 'dir' && to !== from) to = joinPath(to, path.basename(from));

    if (to === from) return to;
    if (source.node.type === 'dir' && to.startsWith(`${from}/`)) {
      throw new FsError('EINVAL', to, `cannot move '${from}' to a subdirectory of itself, '${to}'`);
    }

    const { parent, name } = parentOf(to);
    const target = tryLookup(to, false);
    if (target && target.node.type === 'dir' && source.node.type !== 'dir') {
      throw new FsError('EISDIR', to);
    }

    const node = detach(from);
    node.name = name;
    node.mtime = Date.now();
    parent.children[name] = node;
    parent.mtime = Date.now();
    change('rename', from, to);
    return to;
  },

  /**
   * Create the file when absent, otherwise bump its mtime.
   * @param {string} p
   * @returns {object} stat
   */
  touch(p) {
    const target = abs(p);
    const found = tryLookup(target, true);
    if (found) {
      found.node.mtime = Date.now();
      change('write', target);
      return statObject(found.node, target);
    }
    return fs.writeFile(target, '');
  },

  /**
   * @param {string} target the link destination (stored verbatim)
   * @param {string} p where the link is created
   * @returns {object} stat of the new link
   */
  symlink(target, p) {
    const linkPath = abs(p);
    const { parent, name } = parentOf(linkPath);
    if (parent.children[name]) throw new FsError('EEXIST', linkPath);
    const node = linkNode(name, String(target), { owner: 'ubuntu', group: 'ubuntu', mtime: Date.now() });
    parent.children[name] = node;
    parent.mtime = Date.now();
    change('write', linkPath);
    return statObject(node, linkPath);
  },

  /**
   * @param {string} p
   * @param {number} mode octal number, e.g. 0o755
   * @returns {object} stat
   */
  chmod(p, mode) {
    const found = lookup(p, true);
    const value = Number(mode);
    if (!Number.isFinite(value) || value < 0 || value > 0o7777) throw new FsError('EINVAL', abs(p));
    found.node.mode = value;
    change('chmod', found.path);
    return statObject(found.node, found.path);
  },

  /**
   * @param {string} p
   * @param {string} owner
   * @param {string} [group]
   * @returns {object} stat
   */
  chown(p, owner, group) {
    const found = lookup(p, true);
    if (owner) found.node.owner = String(owner);
    if (group) found.node.group = String(group);
    change('chmod', found.path);
    return statObject(found.node, found.path);
  },

  /* --- trash (freedesktop.org) --------------------------------- */

  /**
   * Move a path into the trash and write its `.trashinfo` metadata.
   * @param {string} p
   * @returns {{name: string, originalPath: string, deletedAt: number}}
   */
  trash(p) {
    const target = abs(p);
    if (target === '/' || target === HOME) throw new FsError('EACCES', target);
    if (target === TRASH_ROOT || target.startsWith(`${TRASH_ROOT}/`)) {
      throw new FsError('EINVAL', target, 'cannot trash the trash');
    }
    const source = lookup(target, false);
    const { files, info } = ensureTrashDirs();

    const trashName = uniqueTrashName(files, info, path.basename(target));
    const deletedAt = Date.now();

    const node = detach(target);
    node.name = trashName;
    node.mtime = deletedAt;
    files.children[trashName] = node;
    files.mtime = deletedAt;

    const trashInfo = `[Trash Info]\nPath=${encodeTrashPath(target)}\nDeletionDate=${trashStamp(deletedAt)}\n`;
    info.children[`${trashName}.trashinfo`] = fileNode(`${trashName}.trashinfo`, trashInfo, {
      mode: 0o600,
      owner: 'ubuntu',
      group: 'ubuntu',
      mtime: deletedAt,
    });
    info.mtime = deletedAt;

    const entry = {
      name: trashName,
      originalPath: target,
      deletedAt,
      type: source.node.type,
      size: sizeOf(source.node, target),
    };
    bus.emit('fs:trash', { path: target, entry });
    change('unlink', target);
    return entry;
  },

  /**
   * @returns {{name:string, originalPath:string, deletedAt:number, type:string, size:number}[]}
   *          newest first
   */
  listTrash() {
    const filesFound = tryLookup(TRASH_FILES, true);
    const infoFound = tryLookup(TRASH_INFO, true);
    if (!filesFound || filesFound.node.type !== 'dir') return [];
    const infoChildren = infoFound && infoFound.node.type === 'dir' ? infoFound.node.children : {};

    const out = [];
    for (const [name, node] of Object.entries(filesFound.node.children)) {
      const meta = infoChildren[`${name}.trashinfo`];
      let originalPath = joinPath(HOME, name);
      let deletedAt = node.mtime;
      if (meta && typeof meta.content === 'string') {
        for (const line of meta.content.split('\n')) {
          if (line.startsWith('Path=')) originalPath = decodeTrashPath(line.slice(5).trim());
          else if (line.startsWith('DeletionDate=')) deletedAt = parseTrashStamp(line.slice(13));
        }
      }
      out.push({
        name,
        originalPath,
        deletedAt,
        type: node.type,
        size: node.type === 'dir' ? fs.du(joinPath(TRASH_FILES, name)) : sizeOf(node, joinPath(TRASH_FILES, name)),
      });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  },

  /**
   * Put a trashed entry back where it came from.
   * @param {string} name the name inside Trash/files
   * @returns {string} the restored absolute path
   */
  restoreFromTrash(name) {
    const trashedPath = joinPath(TRASH_FILES, name);
    lookup(trashedPath, false); // throws ENOENT when the entry is gone
    const entry = fs.listTrash().find((e) => e.name === name);
    const destination = entry ? entry.originalPath : joinPath(HOME, name);

    if (tryLookup(destination, false)) throw new FsError('EEXIST', destination);
    mkdirp(path.dirname(destination), { owner: 'ubuntu', group: 'ubuntu' });

    const node = detach(trashedPath);
    node.name = path.basename(destination);
    node.mtime = Date.now();
    const { parent } = parentOf(destination);
    parent.children[node.name] = node;
    parent.mtime = Date.now();

    const infoPath = joinPath(TRASH_INFO, `${name}.trashinfo`);
    if (tryLookup(infoPath, false)) detach(infoPath);

    change('restore', destination);
    return destination;
  },

  /**
   * Permanently delete one trashed entry.
   * @param {string} name
   * @returns {boolean}
   */
  deleteFromTrash(name) {
    const trashedPath = joinPath(TRASH_FILES, name);
    if (!tryLookup(trashedPath, false)) return false;
    detach(trashedPath);
    const infoPath = joinPath(TRASH_INFO, `${name}.trashinfo`);
    if (tryLookup(infoPath, false)) detach(infoPath);
    change('unlink', trashedPath);
    return true;
  },

  /** Permanently delete everything in the trash. */
  emptyTrash() {
    const { files, info } = ensureTrashDirs();
    const count = Object.keys(files.children).length;
    files.children = Object.create(null);
    info.children = Object.create(null);
    const now = Date.now();
    files.mtime = now;
    info.mtime = now;
    change('unlink', TRASH_FILES);
    return count;
  },

  /* --- lifecycle ------------------------------------------------ */

  /** @returns {object} a plain JSON tree */
  snapshot() {
    return serialize(root);
  },

  /**
   * Replace the whole tree. Falls back to a pristine install on bad input.
   * @param {object} json
   * @returns {boolean} true when the snapshot was accepted
   */
  restore(json) {
    if (!json || typeof json !== 'object' || json.type !== 'dir') {
      fs.reset();
      return false;
    }
    try {
      const rebuilt = deserialize(json, '');
      if (rebuilt.type !== 'dir') throw new FsError('EINVAL', '/');
      root = rebuilt;
      root.name = '';
      // A restored tree may predate directories the app now relies on.
      suspendPersist = true;
      try {
        mkdirp(TRASH_FILES, { owner: 'ubuntu', group: 'ubuntu' });
        mkdirp(TRASH_INFO, { owner: 'ubuntu', group: 'ubuntu' });
      } finally {
        suspendPersist = false;
      }
      bus.emit('fs:change', { op: 'write', path: '/' });
      return true;
    } catch (err) {
      console.warn('[fs] snapshot rejected, rebuilding the default tree:', err);
      fs.reset();
      return false;
    }
  },

  /** Rebuild the pristine Ubuntu tree and persist it immediately. */
  reset() {
    root = buildDefaultTree();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    writeSnapshot();
    bus.emit('fs:change', { op: 'write', path: '/' });
  },

  /** Force an immediate save (writes are normally debounced 400 ms). */
  persist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    writeSnapshot();
  },

  /* --- convenience used across the apps -------------------------- */

  /**
   * Resolve a possibly relative, possibly `~`-prefixed path.
   * @param {string} p
   * @param {string} [cwd]
   * @returns {string} absolute normalized path
   */
  resolve(p, cwd = HOME) {
    return path.resolve(cwd, path.expandTilde(p, HOME));
  },

  /**
   * Depth-first listing of every path under a root — used by search and `find`.
   * @param {string} p
   * @param {{includeHidden?: boolean, maxDepth?: number}} [opts]
   * @returns {string[]} absolute paths, the root itself first
   */
  walk(p, { includeHidden = true, maxDepth = 64 } = {}) {
    const found = lookup(p, true);
    const out = [];
    const visit = (node, nodePath, depth) => {
      out.push(nodePath);
      if (node.type !== 'dir' || depth >= maxDepth) return;
      for (const name of Object.keys(node.children).sort(collate)) {
        if (!includeHidden && name.charCodeAt(0) === 46) continue;
        visit(node.children[name], joinPath(nodePath, name), depth + 1);
      }
    };
    visit(found.node, found.path, 0);
    return out;
  },
};
