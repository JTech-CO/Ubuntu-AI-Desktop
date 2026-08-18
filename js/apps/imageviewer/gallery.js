/**
 * js/apps/imageviewer/gallery.js — folder scanning and prev/next for the
 * Image Viewer.
 *
 * `js/core/fs.js` stores file content as a string, so images live in the
 * filesystem as **data URLs** (`data:image/png;base64,…`). Two shapes are
 * therefore understood here:
 *
 *   1. any file whose content starts with `data:image/` — handed straight to
 *      an `<img>` as its `src`;
 *   2. `.svg` files holding raw SVG markup — wrapped in a `Blob` and handed to
 *      an `<img>` as a `blob:` URL. That is deliberately *not* an inline
 *      `<svg>` built from the markup: an `<img>` treats SVG as an image
 *      document, so scripts and external references inside it never run, and
 *      no untrusted markup ever reaches the live DOM. (ARCHITECTURE §0.4.)
 *
 * Nothing in this module writes to the DOM.
 */

import { fs } from '../../core/fs.js';
import { basename, dirname, extname, join } from '../../core/path.js';
import { compareNames } from '../files/format.js';

/** Extensions the viewer claims, mapped to the mime type GNOME reports. */
export const IMAGE_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.svgz': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
});

/** The shared-mime-info comments Files and eog show for each type. */
const MIME_LABEL = Object.freeze({
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image',
  'image/bmp': 'Windows BMP image',
  'image/webp': 'WebP image',
  'image/svg+xml': 'SVG image',
  'image/vnd.microsoft.icon': 'Windows icon',
  'image/avif': 'AVIF image',
  'image/tiff': 'TIFF image',
});

/** Matches an optional XML declaration / comments / doctype before `<svg`. */
const SVG_PROLOGUE = /^\s*(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[\s\S]*?>\s*)*<svg[\s>]/i;

/**
 * @param {string} name
 * @returns {string} lowercase extension including the dot, or ''
 */
export function extOf(name) {
  return extname(String(name || '')).toLowerCase();
}

/**
 * @param {string} name
 * @returns {boolean} true when the extension is one the viewer claims
 */
export function isImageName(name) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME, extOf(name));
}

/**
 * Read a file without throwing.
 * @param {string} p
 * @returns {string} '' when the path is unreadable
 */
function readOrEmpty(p) {
  try {
    const text = fs.readFile(p);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} content
 * @returns {boolean} true when the string is a `data:image/…` URL
 */
export function isImageDataUrl(content) {
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(String(content || '').trim());
}

/**
 * True when the string is a standalone SVG document. Validated with
 * `DOMParser` — the parsed document is inspected and thrown away, never
 * inserted anywhere.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isSvgMarkup(content) {
  const text = String(content || '');
  if (!SVG_PROLOGUE.test(text)) return false;
  if (typeof DOMParser !== 'function') return true;
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return false;
    const root = doc.documentElement;
    return Boolean(root) && root.nodeName.toLowerCase() === 'svg';
  } catch {
    return false;
  }
}

/**
 * The mime type carried by a `data:` URL.
 * @param {string} url
 * @returns {string} '' when it is not a data URL
 */
export function mimeOfDataUrl(url) {
  const m = /^data:([a-z0-9.+/-]+)[;,]/i.exec(String(url || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * Decide whether a path holds something the viewer can display, without
 * building a source for it.
 *
 * @param {string} p absolute path
 * @returns {boolean}
 */
export function isImagePath(p) {
  try {
    if (!fs.isFile(p)) return false;
  } catch {
    return false;
  }
  const content = readOrEmpty(p);
  if (isImageDataUrl(content)) return true;
  if (extOf(p) === '.svg' || extOf(p) === '.svgz') return isSvgMarkup(content);
  return false;
}

/**
 * True when a file *claims* to be an image, either by extension or by content.
 * Used for listing a folder, where a stub file with the right extension but no
 * decodable body should still appear (so Prev/Next reaches it and the viewer
 * can show its "cannot be displayed" state, exactly like eog).
 *
 * @param {string} p absolute path
 * @param {string} [name]
 * @returns {boolean}
 */
export function looksLikeImage(p, name) {
  if (isImageName(name === undefined ? basename(p) : name)) return true;
  return isImageDataUrl(readOrEmpty(p));
}

/**
 * Build an `<img>`-ready URL for a path.
 *
 * @param {string} p absolute path
 * @returns {{url: string, mime: string, revoke: (() => void)|null}|null}
 *          null when the file is missing or holds nothing decodable
 */
export function openImageSource(p) {
  let content = '';
  try {
    if (!fs.isFile(p)) return null;
    content = readOrEmpty(p);
  } catch {
    return null;
  }
  const trimmed = content.trim();
  if (trimmed === '') return null;

  if (isImageDataUrl(trimmed)) {
    return { url: trimmed, mime: mimeOfDataUrl(trimmed) || guessMime(p), revoke: null };
  }

  if (isSvgMarkup(content)) {
    if (typeof Blob !== 'function' || typeof URL.createObjectURL !== 'function') return null;
    const blob = new Blob([content], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    return { url, mime: 'image/svg+xml', revoke: () => URL.revokeObjectURL(url) };
  }

  return null;
}

/**
 * A URL that keeps working after the page reloads — used for the wallpaper,
 * where a `blob:` URL would be dead on the next boot. Raw SVG markup becomes a
 * percent-encoded `data:` URL, which also escapes the quotes that would
 * otherwise break a CSS `url("…")` token.
 *
 * @param {string} p absolute path
 * @returns {string|null} null when the file holds no usable image
 */
export function toDataUrl(p) {
  const content = readOrEmpty(p);
  const trimmed = content.trim();
  if (trimmed === '') return null;
  if (isImageDataUrl(trimmed)) return trimmed;
  if (isSvgMarkup(content)) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
  return null;
}

/**
 * @param {string} p
 * @returns {string} the mime type implied by the extension, or ''
 */
export function guessMime(p) {
  return IMAGE_MIME[extOf(p)] || '';
}

/**
 * The human type label eog puts in its properties dialog.
 * @param {string} mime
 * @param {string} [p] used as a fallback when the mime type is unknown
 * @returns {string}
 */
export function typeLabelFor(mime, p = '') {
  const key = String(mime || '').toLowerCase();
  if (MIME_LABEL[key]) return `${MIME_LABEL[key]} (${key})`;
  const guessed = guessMime(p);
  if (guessed && MIME_LABEL[guessed]) return `${MIME_LABEL[guessed]} (${guessed})`;
  if (key) return key;
  return 'Unknown';
}

/**
 * Every displayable image in a directory, sorted the way Files sorts by name
 * (natural order, case-insensitive) so Prev/Next walks the folder in exactly
 * the order the Files window shows.
 *
 * @param {string} dir absolute directory
 * @param {{showHidden?: boolean}} [opts]
 * @returns {string[]} absolute paths
 */
export function listImagesIn(dir, { showHidden = false } = {}) {
  let stats = [];
  try {
    stats = fs.readdir(dir, { withStats: true });
  } catch {
    return [];
  }
  const names = [];
  for (const stat of stats) {
    if (stat.isDir) continue;
    if (!showHidden && stat.name.startsWith('.')) continue;
    if (!looksLikeImage(join(dir, stat.name), stat.name)) continue;
    names.push(stat.name);
  }
  names.sort(compareNames);
  return names.map((name) => join(dir, name));
}

/* ------------------------------------------------------------------ *
 * gallery
 * ------------------------------------------------------------------ */

/**
 * A cursor over every image in one directory.
 *
 * The list is re-read on demand (`reload()`), so a file deleted from the
 * Terminal or the Files window drops out of Prev/Next without the viewer
 * having to be reopened.
 *
 * @param {string} startPath absolute path of the image to start on. A
 *        directory is accepted too, and starts on its first image.
 * @param {{showHidden?: boolean}} [opts]
 * @returns {object} the gallery handle
 */
export function createGallery(startPath, opts = {}) {
  let current = String(startPath || '');
  let dir;
  if (current !== '' && fs.isDir(current)) {
    dir = current;
    current = '';
  } else {
    dir = dirname(current) || fs.HOME;
  }
  /** @type {string[]} */
  let items = [];
  let index = -1;

  function locate() {
    if (items.length === 0) {
      index = -1;
      return;
    }
    if (current === '') {
      index = 0;
      current = items[0];
      return;
    }
    const at = items.indexOf(current);
    if (at >= 0) {
      index = at;
      return;
    }
    // The current file is gone (or was never listable): land on the entry that
    // took its place in the sort order, so Next moves forward rather than
    // jumping back to the start of the folder.
    const fallback = items.findIndex((p) => compareNames(basename(p), basename(current)) >= 0);
    index = fallback === -1 ? items.length - 1 : fallback;
  }

  function reload() {
    items = listImagesIn(dir, opts);
    locate();
    return items.length;
  }

  /**
   * @param {number} i
   * @returns {string} the path now current ('' when the folder is empty)
   */
  function goTo(i) {
    if (items.length === 0) return current;
    const n = items.length;
    index = ((Math.trunc(i) % n) + n) % n;
    current = items[index];
    return current;
  }

  reload();

  return {
    /** @returns {string} the directory being walked */
    dir: () => dir,
    /** @returns {string} the current absolute path */
    path: () => current,
    /** @returns {string[]} a copy of the ordered path list */
    items: () => items.slice(),
    /** @returns {number} zero-based position, -1 when the folder is empty */
    index: () => index,
    /** @returns {number} how many images the folder holds */
    count: () => items.length,
    /** @returns {number} one-based position for the status bar, 0 when empty */
    position: () => (index >= 0 ? index + 1 : 0),
    /** @returns {boolean} */
    hasPrev: () => items.length > 1,
    /** @returns {boolean} */
    hasNext: () => items.length > 1,

    reload,

    /**
     * Point the gallery at another file, re-scanning when it changed folder.
     * @param {string} p
     * @returns {string} the new current path
     */
    setPath(p) {
      const next = String(p || '');
      const nextDir = dirname(next) || fs.HOME;
      current = next;
      if (nextDir !== dir) {
        dir = nextDir;
        reload();
      } else {
        locate();
      }
      return current;
    },

    goTo,

    /** @returns {string} the previous image, wrapping like eog */
    prev() {
      if (items.length === 0) return current;
      if (index < 0) return goTo(items.length - 1);
      return goTo(index - 1);
    },

    /** @returns {string} the next image, wrapping like eog */
    next() {
      if (items.length === 0) return current;
      if (index < 0) return goTo(0);
      return goTo(index + 1);
    },
  };
}
