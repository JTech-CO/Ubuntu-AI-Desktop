/**
 * writer-lock.js — one tab writes; any other tab of the desktop only reads.
 *
 * THE PROBLEM
 * -----------
 * Every tab restores the filesystem at boot and then saves its own in-memory
 * copy whenever it changes. With two tabs open, each save overwrites the
 * other's: create a file in tab A, touch anything in tab B, and A's file is
 * gone on the next reload. Nothing warned about it.
 *
 * THE RULE
 * --------
 * Exactly one tab — the writer — may save. It holds a Web Lock for as long as
 * it is open; the browser releases it automatically when the tab closes, so a
 * crashed tab can never strand the lock. A tab that boots while another holds
 * it becomes a reader: fully usable, but it saves nothing, and the shell shows
 * a banner saying so with a "Use here" button (the WhatsApp Web pattern).
 *
 * HANDOVER
 * --------
 * "Use here" asks the writer over a BroadcastChannel to flush its pending
 * changes and step down, then waits for the lock. If the writer does not
 * answer in time (a frozen or discarded tab), the lock is stolen instead —
 * losing at most the writer's last unflushed debounce window. Either way the
 * new writer reloads, because its in-memory tree predates the other tab's
 * last save.
 *
 * Browsers without Web Locks (Safari before 15.4) run as a single "solo"
 * writer, which is exactly the old behaviour.
 */

import { bus } from './bus.js';
import { store } from './store.js';
import { fsPersist } from './fs-persist.js';

const LOCK_NAME = 'ubuntu-ai-desktop:writer';
const CHANNEL_NAME = 'ubuntu-ai-desktop:writer';
const HANDOVER_TIMEOUT_MS = 2500;

/** @type {'pending'|'writer'|'reader'|'solo'} */
let role = 'pending';
/** Resolving this releases the held lock. */
let releaseLock = null;
/** @type {BroadcastChannel|null} */
let channel = null;
/** Flushes unsaved work before handing over; installed by main.js. */
let flushHook = async () => {};
let takingOver = false;

function supported() {
  return (
    typeof navigator !== 'undefined' &&
    navigator.locks !== undefined &&
    typeof navigator.locks.request === 'function'
  );
}

/**
 * Keep the lock until handed over or the tab closes.
 * @returns {Promise<void>}
 */
function holdLock() {
  return new Promise((resolve) => {
    releaseLock = resolve;
  });
}

function setRole(next, reason) {
  role = next;
  const reading = next === 'reader';
  store.setReadOnly(reading);
  fsPersist.setReadOnly(reading);
  bus.emit('writer:change', { role, reason });
}

async function onMessage(ev) {
  const msg = ev && ev.data;
  if (!msg || msg.type !== 'handover-request' || role !== 'writer') return;

  // Flush first, while still allowed to write, then step down.
  try {
    await flushHook();
  } catch (err) {
    console.warn('[writer-lock] flush before handover failed:', err);
  }
  setRole('reader', 'handover');
  if (releaseLock) {
    const release = releaseLock;
    releaseLock = null;
    release();
  }
}

/**
 * Decide this tab's role. Call once at boot, before anything is saved.
 * @returns {Promise<'writer'|'reader'|'solo'>}
 */
export async function acquire() {
  if (!supported()) {
    role = 'solo';
    return role;
  }

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = onMessage;
  } catch {
    channel = null; // handover will fall back to stealing
  }

  const granted = await new Promise((resolve) => {
    navigator.locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return holdLock();
      })
      .catch((err) => {
        // Rejects with AbortError when another tab steals the lock from us.
        if (role === 'writer') setRole('reader', 'stolen');
        else resolve(false);
        if (err && err.name !== 'AbortError') console.warn('[writer-lock] lock request failed:', err);
      });
  });

  setRole(granted ? 'writer' : 'reader', granted ? 'boot' : 'other-tab');
  return role;
}

/**
 * Make this tab the writer. Resolves only if it fails; on success the page
 * reloads so it boots from what the previous writer saved.
 * @returns {Promise<void>}
 */
export async function takeOver() {
  if (role !== 'reader' || takingOver) return;
  takingOver = true;

  if (channel) channel.postMessage({ type: 'handover-request' });

  const handedOver = await new Promise((resolve) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), HANDOVER_TIMEOUT_MS);
    navigator.locks
      .request(LOCK_NAME, { signal: abort.signal }, () => {
        clearTimeout(timer);
        resolve(true);
        return holdLock();
      })
      .catch(() => resolve(false));
  });

  if (!handedOver) {
    // The writer did not answer — frozen, discarded, or no BroadcastChannel.
    await new Promise((resolve) => {
      navigator.locks
        .request(LOCK_NAME, { steal: true }, () => {
          resolve();
          return holdLock();
        })
        .catch(() => resolve());
    });
  }

  window.location.reload();
}

/**
 * @param {() => Promise<unknown>} fn called on the writer before it steps down
 */
export function setFlushHook(fn) {
  if (typeof fn === 'function') flushHook = fn;
}

/** @returns {'pending'|'writer'|'reader'|'solo'} */
export function getRole() {
  return role;
}

/** @returns {boolean} whether this tab may save */
export function canWrite() {
  return role === 'writer' || role === 'solo';
}

export const writerLock = { acquire, takeOver, setFlushHook, getRole, canWrite };
export default writerLock;
