/**
 * registry.js — the application catalogue.
 *
 * Every desktop app is a module under js/apps/<id>/index.js with a default
 * export conforming to ARCHITECTURE §16. This file is the one place that knows
 * the full set; the dock, the overview app grid and the window manager all read
 * from here rather than hard-coding app ids.
 *
 * Order matters: it is the order icons appear in the dock and the app grid.
 */

import terminal from './terminal/index.js';
import files from './files/index.js';
import firefox from './firefox/index.js';
import editor from './editor/index.js';
import imageviewer from './imageviewer/index.js';
import codeoss from './codeoss/index.js';
import settings from './settings/index.js';
import monitor from './monitor/index.js';
import calculator from './calculator/index.js';
import trash from './trash/index.js';

/** Fallback geometry for an app that omits it. */
const DEFAULTS = {
  width: 820,
  height: 560,
  minWidth: 420,
  minHeight: 260,
  resizable: true,
  singleton: false,
  pinned: false,
};

/**
 * Validate an app module and fill in anything optional it left out.
 * A module missing `id`, `name` or `mount` is a real bug, so it is dropped
 * with a clear console error rather than crashing the whole desktop at boot.
 *
 * @param {object} app
 * @param {string} source module specifier, for the error message
 * @returns {object|null}
 */
function normalise(app, source) {
  if (!app || typeof app !== 'object') {
    console.error(`[registry] ${source} has no default export.`);
    return null;
  }
  if (typeof app.id !== 'string' || !app.id) {
    console.error(`[registry] ${source} is missing a string \`id\`.`);
    return null;
  }
  if (typeof app.mount !== 'function') {
    console.error(`[registry] app "${app.id}" is missing mount(root, ctx).`);
    return null;
  }

  const merged = { ...DEFAULTS, ...app };
  if (typeof merged.name !== 'string' || !merged.name) merged.name = app.id;
  if (typeof merged.genericName !== 'string') merged.genericName = merged.name;
  if (typeof merged.themeClass !== 'string') merged.themeClass = `app-${app.id}`;
  return merged;
}

const catalogue = [
  [terminal, './terminal/index.js'],
  [files, './files/index.js'],
  [firefox, './firefox/index.js'],
  [editor, './editor/index.js'],
  [imageviewer, './imageviewer/index.js'],
  [codeoss, './codeoss/index.js'],
  [settings, './settings/index.js'],
  [monitor, './monitor/index.js'],
  [calculator, './calculator/index.js'],
  [trash, './trash/index.js'],
]
  .map(([app, source]) => normalise(app, source))
  .filter(Boolean);

/** @type {object[]} every usable app definition, in dock order */
export const apps = catalogue;

const byId = new Map(catalogue.map((app) => [app.id, app]));

/**
 * @param {string} id
 * @returns {object|null} the app definition, or null when unknown
 */
export function getApp(id) {
  return byId.get(String(id)) || null;
}

/** @returns {object[]} apps pinned to the dock by default */
export function pinnedApps() {
  return catalogue.filter((app) => app.pinned);
}

/**
 * Apps that belong in the overview's app grid. Trash is reachable from the
 * dock and the Files sidebar, so it is not repeated in the grid.
 *
 * @returns {object[]}
 */
export function launchableApps() {
  return catalogue.filter((app) => app.id !== 'trash');
}

export default apps;
