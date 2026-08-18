/**
 * js/apps/imageviewer/wallpaper.js — "Set as Wallpaper".
 *
 * `js/apps/settings/state.js` models a background as one entry of its shipped
 * `WALLPAPERS` table, keyed by `background.id`, and paints it by writing the
 * `--wallpaper` custom property (which `#wallpaper` in index.html consumes).
 * An arbitrary image from the filesystem is not in that table, so this module
 * adds one extra id — `custom-image` — and keeps its CSS beside the settings
 * under its own store key.
 *
 * Two things then have to happen for it to behave like a real background:
 *
 *   1. When Settings applies `background.id`, `getWallpaper()` does not know
 *      `custom-image` and falls back to the shipped default. So the custom CSS
 *      is repainted right afterwards, and again whenever `settings:change`
 *      announces a background change.
 *   2. At boot, `main.js` calls `applySettings()` synchronously during module
 *      evaluation. A `setTimeout(…, 0)` scheduled while this module is first
 *      imported therefore lands immediately after that call, which is where the
 *      saved custom background is restored.
 *
 * Choosing any shipped wallpaper in Settings clears the custom one, so the two
 * can never disagree.
 */

import { store } from '../../core/store.js';
import { bus } from '../../core/bus.js';
import { settings } from '../settings/state.js';

/** The synthetic `background.id` a filesystem image gets. */
export const CUSTOM_ID = 'custom-image';

/** Store key holding `{ css, path, name, setAt }` for the custom background. */
const STORE_KEY = 'wallpaper.custom';

let installed = false;

/**
 * Quote a URL for a CSS `url("…")` token. Base64 data URLs contain none of
 * these characters, but a percent-free `data:image/svg+xml,…` can, and a
 * stray quote would end the CSS string early.
 *
 * @param {string} url
 * @returns {string}
 */
function cssUrl(url) {
  const escaped = String(url)
    .replace(/[\r\n]+/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `url("${escaped}") center / cover no-repeat`;
}

/**
 * Paint a background immediately, the same way `settings/state.js` does.
 * @param {string} css a complete CSS `background` shorthand
 */
function paint(css) {
  document.documentElement.style.setProperty('--wallpaper', css);
  document.documentElement.dataset.wallpaper = CUSTOM_ID;
  const desktop = document.querySelector('.desktop') || document.getElementById('desktop');
  if (desktop instanceof HTMLElement) desktop.style.background = css;
  // ARCHITECTURE §3 reserves the top-level `wallpaper` key for the shell.
  store.set('wallpaper', { id: CUSTOM_ID, kind: 'photo', css });
}

/** @returns {{css:string, path:string, name:string, setAt:number}|null} */
export function customWallpaper() {
  const saved = store.get(STORE_KEY, null);
  if (!saved || typeof saved !== 'object' || typeof saved.css !== 'string') return null;
  return saved;
}

/**
 * Re-apply the saved custom background, if one is selected.
 * @returns {boolean} true when something was painted
 */
export function restoreCustomWallpaper() {
  if (settings.get('background.id') !== CUSTOM_ID) return false;
  const saved = customWallpaper();
  if (!saved) return false;
  paint(saved.css);
  return true;
}

/**
 * Make an image the desktop background.
 *
 * @param {string} url a `data:` (or `blob:`) URL for the image
 * @param {{path?: string, name?: string}} [meta]
 * @returns {string} the CSS that was applied
 */
export function setWallpaperFromImage(url, meta = {}) {
  const css = cssUrl(url);
  store.set(STORE_KEY, {
    css,
    path: String(meta.path || ''),
    name: String(meta.name || ''),
    setAt: Date.now(),
  });
  // Announce the change first — its own repaint falls back to the shipped
  // default — then paint the real thing over the top.
  settings.set('background.id', CUSTOM_ID);
  paint(css);
  return css;
}

/**
 * Watch for background changes so the custom wallpaper survives, and restore
 * it once at boot. Safe to call more than once.
 */
export function installWallpaperBridge() {
  if (installed) return;
  installed = true;

  bus.on('settings:change', (payload) => {
    const key = payload && payload.key;
    if (key !== 'background.id' && key !== '*' && key !== 'background.custom') return;
    if (settings.get('background.id') === CUSTOM_ID) {
      restoreCustomWallpaper();
      return;
    }
    // A shipped wallpaper was picked: forget the custom one entirely.
    if (customWallpaper()) store.remove(STORE_KEY);
  });

  // `main.js` applies the saved appearance synchronously while this module is
  // still being imported, so the restore has to wait for the current task.
  setTimeout(restoreCustomWallpaper, 0);
}
