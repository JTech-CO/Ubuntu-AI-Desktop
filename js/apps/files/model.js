/**
 * js/apps/files/model.js — turning the filesystem into view entries.
 *
 * The Files window and the search results are both built from these helpers, so
 * the entry shape stays identical everywhere: an `fs` stat plus the display
 * fields the view needs (label, kind, type comment, size label).
 */

import { fs } from '../../core/fs.js';
import { basename, dirname } from '../../core/path.js';
import { kindFor, typeLabelFor, formatSize } from './format.js';

/** A simulated 50 GB root filesystem, of which ~12.4 GB is the OS itself. */
export const DISK_TOTAL = 50 * 1000 * 1000 * 1000;
export const DISK_BASE_USED = 12.4 * 1000 * 1000 * 1000;

/** The synthetic location id used by the "Other Locations" page. */
export const OTHER = 'other:';

/**
 * Bytes still available on the simulated root filesystem.
 * @returns {number}
 */
export function freeBytes() {
  let used = DISK_BASE_USED;
  try {
    used += fs.du('/');
  } catch {
    used += 0;
  }
  return Math.max(0, DISK_TOTAL - used);
}

/**
 * @param {string} p
 * @returns {number} number of direct children, 0 when unreadable
 */
export function childCount(p) {
  try {
    return fs.readdir(p).length;
  } catch {
    return 0;
  }
}

/**
 * Convert an `fs` stat object into a view entry.
 * @param {object} stat from `fs.readdir(dir, { withStats: true })` or `fs.lstat`
 * @param {object} [extra] extra fields merged into the entry
 * @returns {object}
 */
export function entryFromStat(stat, extra = {}) {
  const isLink = stat.isLink;
  let isDir = stat.isDir;
  let broken = false;
  if (isLink) {
    try {
      isDir = fs.stat(stat.path).isDir;
    } catch {
      isDir = false;
      broken = true;
    }
  }
  const count = isDir ? childCount(stat.path) : 0;
  const typeText = typeLabelFor(stat.name, isDir);
  return {
    key: stat.name,
    name: stat.name,
    label: stat.name,
    path: stat.path,
    type: stat.type,
    isDir,
    isLink,
    broken,
    size: isDir ? count : stat.size,
    sizeLabel: isDir ? `${count} ${count === 1 ? 'item' : 'items'}` : formatSize(stat.size),
    mtime: stat.mtime,
    mode: stat.mode,
    hidden: stat.name.startsWith('.'),
    kind: broken ? 'unknown' : kindFor(stat.name, isDir),
    typeLabel: broken ? 'Broken link' : isLink ? `Link to ${typeText}` : typeText,
    ...extra,
  };
}

/**
 * @param {string} p absolute path
 * @param {object} [extra]
 * @returns {object|null} null when the path is gone
 */
export function entryFromPath(p, extra = {}) {
  try {
    return entryFromStat(fs.lstat(p), extra);
  } catch {
    return null;
  }
}

/**
 * List a directory as view entries.
 * @param {string} dir absolute directory
 * @param {boolean} showHidden
 * @returns {object[]}
 */
export function listEntries(dir, showHidden) {
  let stats = [];
  try {
    stats = fs.readdir(dir, { withStats: true });
  } catch {
    return [];
  }
  const out = [];
  for (const stat of stats) {
    if (!showHidden && stat.name.startsWith('.')) continue;
    out.push(entryFromStat(stat));
  }
  return out;
}

/**
 * The "Other Locations" page: the simulated Computer and the mounted root
 * volume, both of which open the filesystem root.
 * @returns {object[]}
 */
export function otherLocationEntries() {
  const free = freeBytes();
  const base = {
    type: 'dir',
    isDir: true,
    isLink: false,
    broken: false,
    mtime: Date.now(),
    mode: 0o755,
    hidden: false,
    kind: 'drive',
    size: 0,
  };
  return [
    {
      ...base,
      key: 'computer',
      name: 'Computer',
      label: 'Computer',
      path: '/',
      sizeLabel: '',
      typeLabel: 'Filesystem root',
      subtitle: '/',
    },
    {
      ...base,
      key: 'volume',
      name: 'Ubuntu 24.04.1 LTS',
      label: 'Ubuntu 24.04.1 LTS',
      path: '/',
      sizeLabel: formatSize(DISK_TOTAL),
      typeLabel: `${formatSize(free)} free of ${formatSize(DISK_TOTAL)}`,
      subtitle: '/dev/sda2',
    },
  ];
}

/**
 * Recursive search below a folder, matching the basename like Nautilus does.
 * @param {string} base absolute directory
 * @param {string} query
 * @param {{showHidden?: boolean, limit?: number, maxDepth?: number}} [opts]
 * @returns {object[]}
 */
export function searchEntries(base, query, { showHidden = false, limit = 400, maxDepth = 6 } = {}) {
  const needle = String(query).trim().toLowerCase();
  if (needle === '') return [];
  let paths = [];
  try {
    paths = fs.walk(base, { includeHidden: showHidden, maxDepth });
  } catch {
    return [];
  }
  const out = [];
  for (const p of paths) {
    if (p === base) continue;
    if (p === fs.TRASH_ROOT || p.startsWith(`${fs.TRASH_ROOT}/`)) continue;
    if (!basename(p).toLowerCase().includes(needle)) continue;
    const entry = entryFromPath(p, { subtitle: dirname(p) });
    if (!entry) continue;
    entry.key = p;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Total size in bytes of a set of entries, recursing into folders.
 * @param {object[]} entries
 * @returns {number}
 */
export function totalSizeOf(entries) {
  let total = 0;
  for (const entry of entries) {
    try {
      total += entry.isDir ? fs.du(entry.path) : fs.stat(entry.path).size;
    } catch {
      total += 0;
    }
  }
  return total;
}
