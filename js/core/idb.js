/**
 * idb.js — the smallest promise wrapper over IndexedDB that this app needs.
 *
 * Two object stores, both out-of-line keyed:
 *
 *   meta    small records, e.g. the filesystem tree under the key 'tree'
 *   blobs   large file contents, keyed by an opaque blob id
 *
 * Deliberately not a general-purpose library. Callers get `openDb()` and
 * `transaction()`; anything richer lives with the one module that needs it
 * (js/core/fs-persist.js).
 */

const DB_NAME = 'ubuntu-ai-desktop';
const DB_VERSION = 1;

export const STORES = Object.freeze({ META: 'meta', BLOBS: 'blobs' });

/**
 * How long boot will wait for the database before giving up. Opening can hang
 * indefinitely when another tab holds an older schema version open and never
 * closes it; the desktop must not sit behind its boot splash forever.
 */
const OPEN_TIMEOUT_MS = 4000;

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

/** @returns {boolean} whether the API exists at all */
export function isAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    // Some privacy modes throw on mere access.
    return false;
  }
}

/**
 * Open (and on first use, create) the database.
 * The promise is cached; a failure clears the cache so a later call retries.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      fn(value);
      return true;
    };
    const timer = setTimeout(
      () => settle(reject, new Error(`IndexedDB did not open within ${OPEN_TIMEOUT_MS} ms`)),
      OPEN_TIMEOUT_MS,
    );

    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      settle(reject, err);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.META)) db.createObjectStore(STORES.META);
      if (!db.objectStoreNames.contains(STORES.BLOBS)) db.createObjectStore(STORES.BLOBS);
    };

    req.onsuccess = () => {
      const db = req.result;
      // A future version opened in another tab asks us to step aside; holding
      // the old connection open would block its upgrade indefinitely.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      // The timeout may already have fired; do not leak the late connection.
      if (!settle(resolve, db)) db.close();
    };

    req.onerror = () => settle(reject, req.error || new Error('IndexedDB open failed'));
  });

  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/**
 * Run `fn(tx)` inside one transaction and resolve once it has COMMITTED —
 * not merely once the requests have been queued. Resolves with whatever `fn`
 * returned, so readers can hand back their request objects and read `.result`
 * after completion.
 *
 * @template T
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: IDBTransaction) => T} fn
 * @returns {Promise<T>}
 */
export async function transaction(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(err);
      return;
    }

    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new DOMException('IndexedDB transaction aborted', 'AbortError'));

    try {
      result = fn(tx);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      reject(err);
    }
  });
}
