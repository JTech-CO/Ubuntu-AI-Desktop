/**
 * js/core/store.js — namespaced localStorage wrapper (ARCHITECTURE §3).
 *
 * Every key is stored under the `uad:` prefix. Values are JSON encoded.
 * Nothing here throws: a disabled, full or foreign localStorage falls back.
 *
 * Holds the small things — settings, the API key, the saved session. The
 * filesystem lives in IndexedDB (js/core/fs-persist.js); localStorage's
 * ~5 MiB per-origin cap is far too small for it.
 *
 * THE OVERLAY
 * -----------
 * `overlay` holds values that were written this session but are NOT on disk:
 * either because the write failed (quota), or because this tab is a reader
 * that must not write (another tab owns the desktop). Reads consult the
 * overlay first, so the tab stays self-consistent — it sees what it just set —
 * even though nothing it sets will survive a reload.
 *
 * (Before the overlay was consulted on read, a failed write left the stale
 * on-disk value visible for the rest of the session: you set a value, and
 * reading it back returned the old one.)
 */

import { bus } from './bus.js';

const PREFIX = 'uad:';

/** Reserved top-level keys used across the app (ARCHITECTURE §3). */
export const RESERVED_KEYS = Object.freeze([
  'fs',
  'settings',
  'apikey',
  'history',
  'wallpaper',
  'trash',
  'firstrun',
]);

/** Values written this session that are not on disk. `null` marks a removal. */
const overlay = new Map();
/** Keys whose last write failed, so recovery can be announced once. */
const failing = new Set();

let backendChecked = false;
let backendOk = false;
let readOnly = false;

function backend() {
  if (!backendChecked) {
    backendChecked = true;
    try {
      const ls = globalThis.localStorage;
      const probe = `${PREFIX}__probe__`;
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      backendOk = true;
    } catch {
      backendOk = false;
      console.warn('[store] localStorage unavailable — falling back to memory storage');
    }
  }
  return backendOk ? globalThis.localStorage : null;
}

function rawGet(fullKey) {
  if (overlay.has(fullKey)) return overlay.get(fullKey);
  const ls = backend();
  if (!ls) return null;
  try {
    return ls.getItem(fullKey);
  } catch {
    return null;
  }
}

function rawSet(fullKey, raw) {
  const ls = backend();
  if (!ls || readOnly) {
    overlay.set(fullKey, raw);
    // Keeping it in memory is the intended behaviour in both cases, not a
    // failure: without localStorage there is nowhere else, and a reader tab
    // is not allowed to write.
    return true;
  }
  try {
    ls.setItem(fullKey, raw);
    overlay.delete(fullKey);
    if (failing.delete(fullKey)) {
      bus.emit('storage:recovered', { target: fullKey.slice(PREFIX.length), backend: 'localStorage' });
    }
    return true;
  } catch (err) {
    // QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED.
    overlay.set(fullKey, raw);
    console.warn(`[store] could not persist "${fullKey}":`, err && err.name ? err.name : err);
    if (!failing.has(fullKey)) {
      failing.add(fullKey);
      bus.emit('storage:error', {
        target: fullKey.slice(PREFIX.length),
        backend: 'localStorage',
        quota: true,
        name: (err && err.name) || 'Error',
        message: String((err && err.message) || err),
      });
    }
    return false;
  }
}

function rawRemove(fullKey) {
  const ls = backend();
  if (!ls || readOnly) {
    // Shadow the on-disk value for this session without touching the disk.
    if (ls) overlay.set(fullKey, null);
    else overlay.delete(fullKey);
    return;
  }
  try {
    ls.removeItem(fullKey);
  } catch {
    /* ignore */
  }
  overlay.delete(fullKey);
  failing.delete(fullKey);
}

function rawKeys() {
  const out = new Set();
  const ls = backend();
  if (ls) {
    try {
      for (let i = 0; i < ls.length; i += 1) {
        const k = ls.key(i);
        if (typeof k === 'string' && k.startsWith(PREFIX)) out.add(k);
      }
    } catch {
      /* ignore */
    }
  }
  for (const [k, v] of overlay) {
    if (v === null) out.delete(k);
    else out.add(k);
  }
  return Array.from(out);
}

export const store = {
  /**
   * @param {string} key un-prefixed key
   * @param {any} [fallback] returned on miss or on malformed JSON
   * @returns {any}
   */
  get(key, fallback = null) {
    const raw = rawGet(PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  },

  /**
   * @param {string} key un-prefixed key
   * @param {any} value JSON-serialisable value
   * @returns {boolean} false only when a write to real storage failed; the
   *   value is still readable for the rest of this session
   */
  set(key, value) {
    let raw;
    try {
      raw = JSON.stringify(value);
    } catch (err) {
      console.warn(`[store] value for "${key}" is not serialisable:`, err);
      return false;
    }
    if (raw === undefined) raw = 'null';
    return rawSet(PREFIX + key, raw);
  },

  /** @param {string} key un-prefixed key */
  remove(key) {
    rawRemove(PREFIX + key);
  },

  /** @returns {string[]} un-prefixed keys owned by this app */
  keys() {
    return rawKeys().map((k) => k.slice(PREFIX.length));
  },

  /** Remove every `uad:` key. Foreign localStorage entries are left alone. */
  clear() {
    for (const full of rawKeys()) rawRemove(full);
  },

  /** @param {string} key @returns {boolean} */
  has(key) {
    const raw = rawGet(PREFIX + key);
    return raw !== null && raw !== undefined;
  },

  /**
   * Stop writing to disk; keep changes in memory for this session only.
   * Used when another tab owns the desktop (js/core/writer-lock.js).
   * @param {boolean} value
   */
  setReadOnly(value) {
    readOnly = Boolean(value);
  },

  /** @returns {boolean} */
  isReadOnly() {
    return readOnly;
  },
};
