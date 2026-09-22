/**
 * fs-persist.js — where the virtual filesystem is saved between visits.
 *
 * WHY NOT localStorage ANY MORE
 * -----------------------------
 * The whole tree used to be one JSON string under `uad:fs`. localStorage caps
 * an origin at about 5 MiB in every major browser, and the screenshot tool
 * stores PNGs as data URLs of 1–4 MB each, so two screenshots were enough to
 * hit the ceiling. Worse, the failure was silent: the write threw, the old
 * snapshot stayed on disk, and the next reload quietly rolled the user back.
 *
 * IndexedDB quotas are measured in gigabytes, and this module surfaces every
 * failure on the bus (`storage:error`) so the shell can tell the user.
 *
 * LAYOUT
 * ------
 * The tree is stored as ONE record, but file contents above a size threshold
 * are pulled out into separate blob records (see js/core/fs.js). A save only
 * writes the blobs whose content actually changed, so ten screenshots on disk
 * do not turn every `ls` — which appends to ~/.bash_history — into a 20 MB
 * rewrite. Tree and blobs are written in a single transaction, so a save is
 * atomic: an interrupted write leaves the previous, consistent state.
 *
 * MIGRATION
 * ---------
 * On first boot after the upgrade, `load()` finds no tree in IndexedDB, reads
 * the legacy `uad:fs` snapshot instead, and the first successful save moves it
 * across and deletes the localStorage copy.
 *
 * FALLBACK
 * --------
 * If IndexedDB cannot be opened at all, saving falls back to localStorage
 * exactly as before — but now a failed write is reported, not swallowed.
 */

import { bus } from './bus.js';
import { store } from './store.js';
import { transaction, STORES } from './idb.js';

/** The pre-IndexedDB snapshot key in localStorage. */
const LEGACY_KEY = 'fs';
const TREE_KEY = 'tree';

/** @type {'pending'|'idb'|'localStorage'} */
let backend = 'pending';
let readOnly = false;
let disabled = false;
let failing = false;

let stats = { savedAt: 0, blobCount: 0, blobChars: 0 };

/* ------------------------------------------------------------------ *
 * failure reporting
 * ------------------------------------------------------------------ */

/**
 * Report a failed save — once per failure streak, so a burst of writes while
 * the disk is full produces one notification rather than one per keystroke.
 * @param {unknown} err
 */
function reportFailure(err) {
  const name = (err && err.name) || 'Error';
  const message = String((err && err.message) || err || 'unknown error');
  const quota = name === 'QuotaExceededError' || /quota|space/i.test(message);
  console.warn('[fs-persist] save failed:', err);
  if (failing) return;
  failing = true;
  bus.emit('storage:error', { target: 'fs', backend, quota, name, message });
}

function reportSuccess() {
  if (!failing) return;
  failing = false;
  bus.emit('storage:recovered', { target: 'fs', backend });
}

/* ------------------------------------------------------------------ *
 * load
 * ------------------------------------------------------------------ */

/**
 * Read the saved filesystem.
 *
 * @returns {Promise<{tree: object|null, blobs: Map<string,string>, source: 'idb'|'legacy'|'none'}>}
 *   `source` says where the tree came from, so the caller knows whether a
 *   migration save is due.
 */
export async function load() {
  try {
    const reqs = await transaction([STORES.META, STORES.BLOBS], 'readonly', (tx) => ({
      tree: tx.objectStore(STORES.META).get(TREE_KEY),
      keys: tx.objectStore(STORES.BLOBS).getAllKeys(),
      values: tx.objectStore(STORES.BLOBS).getAll(),
    }));
    backend = 'idb';

    const blobs = new Map();
    const keys = reqs.keys.result || [];
    const values = reqs.values.result || [];
    // getAllKeys() and getAll() walk the same index in the same order.
    for (let i = 0; i < keys.length; i += 1) {
      if (typeof values[i] === 'string') blobs.set(String(keys[i]), values[i]);
    }

    // A localStorage snapshot that still exists is NEWER than the IndexedDB
    // tree, by construction: every successful IndexedDB save deletes it. So it
    // survives only when it was written afterwards — before the upgrade, or in
    // a session where IndexedDB could not be opened (a timed-out open, say) and
    // saving fell back to localStorage. Preferring the IndexedDB tree here
    // would silently discard everything saved during that fallback session.
    // The IndexedDB blobs are still handed back: none are referenced by an
    // inline tree, so the next save deletes them and writes fresh ones.
    const legacy = store.get(LEGACY_KEY, null);
    if (legacy && typeof legacy === 'object') return { tree: legacy, blobs, source: 'legacy' };

    const tree = reqs.tree.result;
    if (tree && typeof tree === 'object') return { tree, blobs, source: 'idb' };
    return { tree: null, blobs, source: 'none' };
  } catch (err) {
    console.warn('[fs-persist] IndexedDB unavailable; falling back to localStorage:', err);
    backend = 'localStorage';
    bus.emit('storage:degraded', {
      backend,
      message: String((err && err.message) || err),
    });
    const legacy = store.get(LEGACY_KEY, null);
    return {
      tree: legacy && typeof legacy === 'object' ? legacy : null,
      blobs: new Map(),
      source: legacy ? 'legacy' : 'none',
    };
  }
}

/* ------------------------------------------------------------------ *
 * save
 * ------------------------------------------------------------------ */

/**
 * @returns {boolean} true when saves split large contents into blob records.
 *   js/core/fs.js asks before serialising, because the localStorage fallback
 *   has no blob store and needs the whole tree inline.
 */
export function usesBlobs() {
  return backend === 'idb';
}

/**
 * Persist one snapshot.
 *
 * @param {object} snapshot
 * @param {object} [snapshot.tree] tree with large contents replaced by blob refs (IndexedDB)
 * @param {Map<string,string>} [snapshot.puts] blobs to write
 * @param {string[]} [snapshot.deletes] blob ids no longer referenced
 * @param {object} [snapshot.full] the fully inline tree (localStorage fallback)
 * @returns {Promise<boolean>} true when the write committed
 */
export async function save({ tree, puts = new Map(), deletes = [], full } = {}) {
  // Not failures: a reader tab and a mid-reset tab are *supposed* to not write.
  if (disabled || readOnly || backend === 'pending') return false;

  if (backend === 'idb') {
    try {
      await transaction([STORES.META, STORES.BLOBS], 'readwrite', (tx) => {
        const blobStore = tx.objectStore(STORES.BLOBS);
        for (const [id, content] of puts) blobStore.put(content, id);
        for (const id of deletes) blobStore.delete(id);
        tx.objectStore(STORES.META).put(tree, TREE_KEY);
      });
    } catch (err) {
      reportFailure(err);
      return false;
    }
    // The data is safely in IndexedDB now; the legacy copy is stale and is
    // still eating the localStorage quota that settings share.
    if (store.has(LEGACY_KEY)) store.remove(LEGACY_KEY);
    reportSuccess();
    return true;
  }

  // localStorage fallback. store.js already announces failure and recovery for
  // this key on the bus; reporting here as well would notify the user twice.
  return store.set(LEGACY_KEY, full);
}

/**
 * Record what the last save left on disk, for diagnostics (Looking Glass).
 * @param {{blobCount: number, blobChars: number}} s
 */
export function noteStats(s) {
  stats = { savedAt: Date.now(), blobCount: s.blobCount, blobChars: s.blobChars };
}

/* ------------------------------------------------------------------ *
 * wipe
 * ------------------------------------------------------------------ */

/**
 * Delete the saved filesystem entirely — IndexedDB records and any legacy
 * localStorage snapshot. Clears the stores rather than deleting the database,
 * because another open tab holding a connection would block a delete.
 *
 * @returns {Promise<void>}
 */
export async function clear() {
  if (readOnly) throw new Error('READ_ONLY');
  store.remove(LEGACY_KEY);
  if (backend !== 'idb') return;
  try {
    await transaction([STORES.META, STORES.BLOBS], 'readwrite', (tx) => {
      tx.objectStore(STORES.META).clear();
      tx.objectStore(STORES.BLOBS).clear();
    });
  } catch (err) {
    console.warn('[fs-persist] could not clear IndexedDB:', err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * modes
 * ------------------------------------------------------------------ */

/**
 * A reader tab (another tab owns the desktop) must never write: two writers
 * racing on one snapshot means the last one silently wins.
 * @param {boolean} value
 */
export function setReadOnly(value) {
  readOnly = Boolean(value);
}

/** @returns {boolean} */
export function isReadOnly() {
  return readOnly;
}

/** Stop all further saves for the life of the page (factory reset). */
export function disable() {
  disabled = true;
}

/** @returns {{backend: string, readOnly: boolean, failing: boolean, savedAt: number, blobCount: number, blobChars: number}} */
export function info() {
  return { backend, readOnly, failing, ...stats };
}

export const fsPersist = {
  load,
  save,
  clear,
  usesBlobs,
  noteStats,
  setReadOnly,
  isReadOnly,
  disable,
  info,
};

export default fsPersist;
