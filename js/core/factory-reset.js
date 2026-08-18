/**
 * factory-reset.js — put the machine back to a fresh install.
 *
 * Restores everything the desktop persists: the filesystem, the wallpaper and
 * accent, dock geometry, shell toggles, the saved session, browser history and
 * bookmarks, shell history and the one-off prompt flags. After this the
 * desktop is byte-for-byte what a first-time visitor sees.
 *
 * WHY THE RELOAD
 * --------------
 * State lives in three places at once: localStorage, the in-memory module
 * singletons (fs, procs, env, settings) and the DOM of every open window.
 * Clearing storage alone leaves the other two stale, so a wipe that did not
 * reload would show the old tree until something happened to repaint. A reload
 * is the only way to guarantee all three agree.
 *
 * WHY THE FLAG
 * ------------
 * `js/main.js` persists the filesystem on `beforeunload`. Without a way to say
 * "we are wiping on purpose", that handler would run during the reset's own
 * reload and write the state straight back, making the reset silently do
 * nothing. `isWiping()` is how main.js knows to stand down.
 */

import { store } from './store.js';

/** Keys that survive a normal reset because losing them only annoys the user. */
const KEEP_BY_DEFAULT = ['apikey'];

let wiping = false;

/**
 * True while a deliberate wipe is in flight. `js/main.js` checks this in its
 * `beforeunload` handler and skips persisting.
 *
 * @returns {boolean}
 */
export function isWiping() {
  return wiping;
}

/**
 * Wipe persisted state and restart the desktop.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.keepApiKey=true] keep the Gemini key so the user does
 *   not have to paste it again. Pass false for a true factory wipe.
 * @param {boolean} [opts.reload=true] reload the page afterwards. Only pass
 *   false if you are going to reload yourself.
 * @returns {{cleared: string[], kept: string[]}} what was removed and preserved
 */
export function run({ keepApiKey = true, reload = true } = {}) {
  wiping = true;

  const preserve = new Map();
  if (keepApiKey) {
    for (const key of KEEP_BY_DEFAULT) {
      const value = store.get(key, null);
      if (value !== null) preserve.set(key, value);
    }
  }

  const cleared = store.keys();
  store.clear();
  for (const [key, value] of preserve) store.set(key, value);

  const kept = Array.from(preserve.keys());
  if (reload) {
    // A microtask of breathing room so a caller can print its message first.
    window.setTimeout(() => window.location.reload(), 0);
  }

  return {
    cleared: cleared.filter((k) => !preserve.has(k)),
    kept,
  };
}

export const factoryReset = { run, isWiping };
export default factoryReset;
