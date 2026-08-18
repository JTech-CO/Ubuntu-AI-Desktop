/**
 * js/core/store.js — namespaced localStorage wrapper (ARCHITECTURE §3).
 *
 * Every key is stored under the `uad:` prefix. Values are JSON encoded.
 * All operations are defensive: a disabled/full/foreign localStorage never
 * throws out of this module — reads fall back, writes silently no-op.
 */

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

/** In-memory fallback used when localStorage is unavailable (private mode, file://). */
const memory = new Map();
let backendChecked = false;
let backendOk = false;

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
  const ls = backend();
  if (ls) {
    try {
      return ls.getItem(fullKey);
    } catch {
      return null;
    }
  }
  return memory.has(fullKey) ? memory.get(fullKey) : null;
}

function rawSet(fullKey, raw) {
  const ls = backend();
  if (ls) {
    try {
      ls.setItem(fullKey, raw);
      return true;
    } catch (err) {
      // QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED — degrade quietly.
      console.warn(`[store] could not persist "${fullKey}":`, err && err.name ? err.name : err);
      memory.set(fullKey, raw);
      return false;
    }
  }
  memory.set(fullKey, raw);
  return true;
}

function rawRemove(fullKey) {
  const ls = backend();
  if (ls) {
    try {
      ls.removeItem(fullKey);
    } catch {
      /* ignore */
    }
  }
  memory.delete(fullKey);
}

function rawKeys() {
  const out = [];
  const ls = backend();
  if (ls) {
    try {
      for (let i = 0; i < ls.length; i += 1) {
        const k = ls.key(i);
        if (typeof k === 'string' && k.startsWith(PREFIX)) out.push(k);
      }
    } catch {
      /* ignore */
    }
  }
  for (const k of memory.keys()) {
    if (!out.includes(k)) out.push(k);
  }
  return out;
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
   * @returns {boolean} true when the write reached the real backend
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
    return rawGet(PREFIX + key) !== null;
  },
};
