/**
 * settings-bridge.js — reconcile the shell's settings with the Settings app's.
 *
 * Two modules independently own overlapping preferences and both persist into
 * the same `settings` store entry, but under different key namespaces:
 *
 *   js/shell/system-menu.js   flat keys      theme, accent, dockPosition, …
 *   js/apps/settings/state.js dotted keys    appearance.style, dock.position, …
 *
 * They also disagree on representation: the shell stores an accent as a hex
 * string, the Settings app stores a Yaru accent id. Left alone, the quick
 * settings toggle and the Settings panel would each apply their own value and
 * silently overwrite one another.
 *
 * Rather than rewrite either module, this bridge mirrors the overlapping keys
 * in both directions on the `settings:change` event, and performs one
 * reconciliation pass at boot so a store written by an older build converges.
 *
 * The Settings app is treated as authoritative at boot because its schema is
 * richer (it has an `auto` style the shell cannot express).
 */

import { bus } from '../core/bus.js';
import { shellSettings } from './system-menu.js';
import { settings, ACCENTS } from '../apps/settings/state.js';

/** Guards against the two writers ping-ponging a change forever. */
let syncing = false;

/**
 * @param {string} id a Yaru accent id
 * @returns {string} the matching hex, falling back to Ubuntu orange
 */
function accentHex(id) {
  const found = ACCENTS.find((a) => a.id === id);
  return found ? found.hex : '#e95420';
}

/**
 * @param {string} hex
 * @returns {string} the matching Yaru accent id, falling back to 'orange'
 */
function accentId(hex) {
  const needle = String(hex || '').toLowerCase();
  const found = ACCENTS.find((a) => a.hex.toLowerCase() === needle);
  return found ? found.id : 'orange';
}

/**
 * Key pairs that mirror straight across with no transform.
 * @type {Array<[string, string]>} [shellKey, settingsKey]
 */
const DIRECT = [
  ['dockPosition', 'dock.position'],
  ['dockIconSize', 'dock.iconSize'],
  ['dockAutohide', 'dock.autohide'],
  ['dnd', 'notifications.doNotDisturb'],
];

/** Write into the shell namespace without triggering the reverse mirror. */
function toShell(key, value) {
  if (shellSettings.get(key) === value) return;
  syncing = true;
  try {
    shellSettings.set(key, value);
  } finally {
    syncing = false;
  }
}

/** Write into the Settings namespace without triggering the reverse mirror. */
function toSettings(key, value) {
  if (settings.get(key) === value) return;
  syncing = true;
  try {
    settings.set(key, value);
  } finally {
    syncing = false;
  }
}

/**
 * Push every overlapping value from the Settings app into the shell.
 * `auto` collapses to whatever it currently resolves to, since the shell's
 * toggle is binary; the Settings app keeps the real `auto` value.
 */
function reconcileFromSettings() {
  const style = settings.get('appearance.style');
  const effective =
    style === 'auto' ? document.documentElement.dataset.theme || 'light' : style;
  toShell('theme', effective === 'dark' ? 'dark' : 'light');
  toShell('accent', accentHex(settings.get('appearance.accent')));
  for (const [shellKey, settingsKey] of DIRECT) {
    toShell(shellKey, settings.get(settingsKey));
  }
}

/**
 * Mirror a single change across the namespaces.
 * @param {{key: string, value: any}} payload
 */
function onChange(payload) {
  if (syncing || !payload || typeof payload.key !== 'string') return;
  const { key, value } = payload;

  // A wholesale reset from the Settings app.
  if (key === '*') {
    reconcileFromSettings();
    return;
  }

  /* --- shell -> Settings ------------------------------------------------ */
  if (key === 'theme') {
    // Don't clobber 'auto' when the resolved theme already matches.
    const style = settings.get('appearance.style');
    const resolved =
      style === 'auto' ? document.documentElement.dataset.theme || 'light' : style;
    if (resolved !== value) toSettings('appearance.style', value === 'dark' ? 'dark' : 'light');
    return;
  }
  if (key === 'accent') {
    toSettings('appearance.accent', accentId(value));
    return;
  }
  for (const [shellKey, settingsKey] of DIRECT) {
    if (key === shellKey) {
      toSettings(settingsKey, value);
      return;
    }
  }

  /* --- Settings -> shell ------------------------------------------------ */
  if (key === 'appearance.style') {
    const effective =
      value === 'auto' ? document.documentElement.dataset.theme || 'light' : value;
    toShell('theme', effective === 'dark' ? 'dark' : 'light');
    return;
  }
  if (key === 'appearance.accent') {
    toShell('accent', accentHex(value));
    return;
  }
  for (const [shellKey, settingsKey] of DIRECT) {
    if (key === settingsKey) {
      toShell(shellKey, value);
      return;
    }
  }
}

let unsubscribe = null;

/**
 * Reconcile once, then keep the two namespaces mirrored.
 * Idempotent — calling it twice does not double-subscribe.
 */
export function install() {
  if (unsubscribe) return;
  reconcileFromSettings();
  unsubscribe = bus.on('settings:change', onChange);
}

/** Stop mirroring. */
export function uninstall() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

export const settingsBridge = { install, uninstall, accentHex, accentId };
export default settingsBridge;
