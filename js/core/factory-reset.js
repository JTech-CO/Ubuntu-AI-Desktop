/**
 * factory-reset.js — put the machine back to a fresh install.
 *
 * Restores everything the desktop persists: the filesystem (IndexedDB), and
 * the wallpaper, accent, dock geometry, shell toggles, saved session, browser
 * history and bookmarks, shell history and one-off prompt flags (localStorage).
 * After this the desktop is what a first-time visitor sees.
 *
 * WHY THE RELOAD
 * --------------
 * State lives in three places at once: storage, the in-memory module
 * singletons (fs, procs, env, settings) and the DOM of every open window.
 * Clearing storage alone leaves the other two stale. A reload is the only way
 * to guarantee all three agree.
 *
 * WHY THE FLAG
 * ------------
 * js/main.js saves the filesystem when the page is hidden or unloaded. During
 * the reset's own reload that save would write the old tree straight back and
 * the reset would silently do nothing. `isWiping()` tells main.js to stand
 * down, and `fsPersist.disable()` makes any other save a no-op.
 *
 * WHY A READER TAB MAY NOT RESET
 * ------------------------------
 * Storage is shared by every tab of the desktop. A reader (another tab owns
 * the desktop, see js/core/writer-lock.js) wiping it would destroy the other
 * tab's data from under it, so `run()` throws `READ_ONLY` there instead.
 */

import { store } from './store.js';
import { fsPersist } from './fs-persist.js';

/** Keys that survive a normal reset because losing them only annoys the user. */
const KEEP_BY_DEFAULT = ['apikey'];

let wiping = false;

/** @returns {boolean} true while a deliberate wipe is in flight */
export function isWiping() {
  return wiping;
}

/** @returns {boolean} false in a reader tab, where `run()` would throw */
export function canRun() {
  return !fsPersist.isReadOnly() && !store.isReadOnly();
}

/**
 * Wipe persisted state and restart the desktop.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.keepApiKey=true] keep the Gemini key; pass false for
 *   a true factory wipe
 * @param {boolean} [opts.reload=true] reload afterwards; pass false only if the
 *   caller reloads itself
 * @returns {Promise<{cleared: string[], kept: string[]}>}
 * @throws {Error} `READ_ONLY` when this tab is not the one that owns the desktop
 */
export async function run({ keepApiKey = true, reload = true } = {}) {
  if (!canRun()) throw new Error('READ_ONLY');

  wiping = true;
  fsPersist.disable();

  const preserve = new Map();
  if (keepApiKey) {
    for (const key of KEEP_BY_DEFAULT) {
      const value = store.get(key, null);
      if (value !== null) preserve.set(key, value);
    }
  }

  const clearedKeys = store.keys().filter((k) => !preserve.has(k));
  store.clear();
  for (const [key, value] of preserve) store.set(key, value);

  // The filesystem is the bulk of what is being wiped; name it in the result
  // even though it is not a localStorage key.
  await fsPersist.clear();
  const cleared = clearedKeys.includes('fs') ? clearedKeys : ['fs', ...clearedKeys];

  if (reload) window.location.reload();
  return { cleared, kept: Array.from(preserve.keys()) };
}

export const factoryReset = { run, isWiping, canRun };
export default factoryReset;
