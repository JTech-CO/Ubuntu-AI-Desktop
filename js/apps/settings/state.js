/**
 * js/apps/settings/state.js — the persisted GNOME Settings state.
 *
 * Every panel reads and writes through `settings`, which stores one object
 * under the reserved `settings` key (ARCHITECTURE §3), emits
 * `settings:change` with `{ key, value }` for every write (§2), and applies
 * the visual consequences immediately so the shell reacts live even before it
 * has handled the event.
 */

import { store } from '../../core/store.js';
import { bus } from '../../core/bus.js';

/** Every setting the panels expose, with its shipped default. */
export const DEFAULTS = Object.freeze({
  /* Appearance */
  'appearance.style': 'light',
  'appearance.accent': 'orange',
  'dock.position': 'left',
  'dock.iconSize': 48,
  'dock.autohide': false,
  'dock.showTrash': true,
  'dock.showMounts': true,

  /* Background */
  'background.id': 'noble',

  /* Multitasking */
  'multitasking.workspaces': 'dynamic',
  'multitasking.fixedCount': 4,
  'multitasking.allDisplays': true,
  'multitasking.switcherScope': 'all',
  'multitasking.hotCorner': true,
  'multitasking.activeEdges': true,

  /* Search */
  'search.enabled': true,
  'search.locations.home': true,
  'search.locations.bookmarks': true,
  'search.locations.external': false,
  'search.apps.files': true,
  'search.apps.settings': true,
  'search.apps.terminal': false,
  'search.apps.calculator': true,
  'search.apps.characters': true,

  /* Notifications */
  'notifications.doNotDisturb': false,
  'notifications.lockScreen': true,
  'notifications.apps.files': true,
  'notifications.apps.firefox': true,
  'notifications.apps.terminal': false,
  'notifications.apps.updates': true,
  'notifications.apps.monitor': false,

  /* Displays */
  'displays.orientation': 'landscape',
  'displays.resolution': '1920 × 1080 (16:9)',
  'displays.refresh': '60.00 Hz',
  'displays.scale': 100,
  'displays.fractional': false,
  'displays.nightLight': false,
  'displays.nightLightSchedule': 'sunset',
  'displays.nightLightTemperature': 3700,

  /* Sound */
  'sound.outputVolume': 68,
  'sound.outputMuted': false,
  'sound.overAmplification': false,
  'sound.balance': 0,
  'sound.outputDevice': 'Speakers — Built-in Audio',
  'sound.inputDevice': 'Internal Microphone — Built-in Audio',
  'sound.inputVolume': 42,
  'sound.inputMuted': false,
  'sound.alertSound': 'Drip',
  'sound.systemSounds': true,

  /* Power */
  'power.mode': 'balanced',
  'power.dimScreen': true,
  'power.blankDelay': 300,
  'power.automaticSuspend': true,
  'power.suspendDelay': 1200,
  'power.batteryPercentage': true,
  'power.automaticPowerSaver': true,

  /* Date & Time */
  'datetime.automatic': true,
  'datetime.automaticTimezone': false,
  'datetime.timezone': 'Europe/London',
  'datetime.timeFormat': '24h',
  'datetime.weekNumbers': false,
  'datetime.showSeconds': false,
  'datetime.showWeekday': true,
  'datetime.showDate': true,

  /* Users */
  'users.realName': 'Ubuntu User',
  'users.accountType': 'administrator',
  'users.automaticLogin': false,

  /* Wi-Fi / Network / Bluetooth */
  'wifi.enabled': true,
  'wifi.connected': 'Ubuntu-Guest',
  'network.wiredEnabled': true,
  'network.proxyMode': 'none',
  'network.proxyHost': '',
  'network.proxyPort': 8080,
  'bluetooth.enabled': false,
  'bluetooth.connected': '',

  /* AI */
  'ai.model': 'gemini-2.5-flash',
  'ai.streaming': true,
});

/** The ten Yaru accent colours (ARCHITECTURE §19). */
export const ACCENTS = Object.freeze([
  { id: 'bark', name: 'Bark', hex: '#787859' },
  { id: 'sage', name: 'Sage', hex: '#657b69' },
  { id: 'olive', name: 'Olive', hex: '#4b8501' },
  { id: 'viridian', name: 'Viridian', hex: '#03875b' },
  { id: 'prussiangreen', name: 'Prussian Green', hex: '#308280' },
  { id: 'blue', name: 'Blue', hex: '#0073e5' },
  { id: 'purple', name: 'Purple', hex: '#7764d8' },
  { id: 'magenta', name: 'Magenta', hex: '#b34cb3' },
  { id: 'red', name: 'Red', hex: '#da3450' },
  { id: 'orange', name: 'Orange', hex: '#e95420' },
]);

/**
 * Wallpapers. The `photo` entries are the images the original single-file app
 * shipped with; the `gradient` and `solid` entries are generated in CSS so the
 * desktop still has a usable set of backgrounds with no network at all.
 *
 * @type {{id:string, name:string, kind:'photo'|'gradient'|'solid', css:string}[]}
 */
export const WALLPAPERS = Object.freeze([
  { id: 'bright', name: 'Bright', kind: 'photo', css: 'url("https://i.imgur.com/nbM254Q.jpeg") center / cover no-repeat' },
  { id: 'blue', name: 'Blue', kind: 'photo', css: 'url("https://i.imgur.com/41ZW4eR.jpeg") center / cover no-repeat' },
  { id: 'dusk', name: 'Dusk', kind: 'photo', css: 'url("https://i.imgur.com/6TkhiSr.jpeg") center / cover no-repeat' },
  { id: 'dark', name: 'Dark', kind: 'photo', css: 'url("https://i.imgur.com/IJSySyr.jpeg") center / cover no-repeat' },
  { id: 'shell', name: 'Shell', kind: 'photo', css: 'url("https://i.imgur.com/szYh9qS.jpeg") center / cover no-repeat' },

  {
    id: 'noble',
    name: 'Noble Numbat',
    kind: 'gradient',
    css: 'radial-gradient(ellipse 120% 90% at 28% 22%, #8f2d56 0%, #5b1740 38%, #2c001e 74%, #180010 100%)',
  },
  {
    id: 'warty',
    name: 'Warty Warthog',
    kind: 'gradient',
    css: 'linear-gradient(155deg, #e95420 0%, #b93a24 42%, #772953 78%, #2c001e 100%)',
  },
  {
    id: 'jammy',
    name: 'Jammy Jellyfish',
    kind: 'gradient',
    css: 'linear-gradient(165deg, #77216f 0%, #4a1246 48%, #2c001e 100%)',
  },
  {
    id: 'mantic',
    name: 'Mantic Minotaur',
    kind: 'gradient',
    css: 'linear-gradient(170deg, #1b3b6f 0%, #123054 45%, #0a1626 100%)',
  },
  {
    id: 'viridian',
    name: 'Viridian',
    kind: 'gradient',
    css: 'linear-gradient(160deg, #0b3d2e 0%, #05604a 46%, #021f18 100%)',
  },
  {
    id: 'bark',
    name: 'Bark',
    kind: 'gradient',
    css: 'linear-gradient(160deg, #5a5750 0%, #3b3934 50%, #201f1c 100%)',
  },

  { id: 'solid-aubergine', name: 'Aubergine', kind: 'solid', css: '#2c001e' },
  { id: 'solid-purple', name: 'Ubuntu Purple', kind: 'solid', css: '#772953' },
  { id: 'solid-orange', name: 'Ubuntu Orange', kind: 'solid', css: '#e95420' },
  { id: 'solid-blue', name: 'Blue', kind: 'solid', css: '#0073e5' },
  { id: 'solid-graphite', name: 'Graphite', kind: 'solid', css: '#1e1e1e' },
  { id: 'solid-paper', name: 'Paper', kind: 'solid', css: '#f5f4f2' },
]);

/** @param {string} id @returns {{id:string,name:string,kind:string,css:string}} */
export function getWallpaper(id) {
  return WALLPAPERS.find((w) => w.id === id) || WALLPAPERS.find((w) => w.id === DEFAULTS['background.id']);
}

/** @param {string} id @returns {{id:string,name:string,hex:string}} */
export function getAccent(id) {
  return ACCENTS.find((a) => a.id === id) || ACCENTS[ACCENTS.length - 1];
}

/* ------------------------------------------------------------------ *
 * store facade
 * ------------------------------------------------------------------ */

function readStored() {
  const saved = store.get('settings', null);
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

let cache = { ...DEFAULTS, ...readStored() };

export const settings = {
  /**
   * @param {string} key dotted key from {@link DEFAULTS}
   * @param {any} [fallback]
   * @returns {any}
   */
  get(key, fallback = undefined) {
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    if (fallback !== undefined) return fallback;
    return DEFAULTS[key];
  },

  /**
   * Persist a setting, apply it and announce it.
   * @param {string} key
   * @param {any} value
   * @returns {any} the stored value
   */
  set(key, value) {
    if (cache[key] === value) return value;
    cache[key] = value;
    const persisted = {};
    for (const [k, v] of Object.entries(cache)) {
      if (DEFAULTS[k] !== v) persisted[k] = v;
    }
    store.set('settings', persisted);
    applyOne(key, value);
    bus.emit('settings:change', { key, value });
    return value;
  },

  /** @returns {Record<string, any>} a copy of every effective setting */
  all() {
    return { ...cache };
  },

  /** Restore every default and re-apply. */
  reset() {
    cache = { ...DEFAULTS };
    store.set('settings', {});
    applySettings();
    bus.emit('settings:change', { key: '*', value: null });
  },
};

/* ------------------------------------------------------------------ *
 * applying
 * ------------------------------------------------------------------ */

let mediaQuery = null;
let mediaBound = false;

function prefersDark() {
  if (!mediaQuery && typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }
  return mediaQuery ? mediaQuery.matches : false;
}

function applyTheme() {
  const style = settings.get('appearance.style');
  const dark = style === 'dark' || (style === 'auto' && prefersDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.styleMode = style;

  if (style === 'auto' && mediaQuery && !mediaBound) {
    mediaBound = true;
    const handler = () => {
      if (settings.get('appearance.style') === 'auto') applyTheme();
    };
    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', handler);
    else if (typeof mediaQuery.addListener === 'function') mediaQuery.addListener(handler);
  }
}

function applyAccent() {
  const accent = getAccent(settings.get('appearance.accent'));
  document.documentElement.style.setProperty('--accent', accent.hex);
  document.documentElement.dataset.accent = accent.id;
}

function applyWallpaper() {
  const wallpaper = getWallpaper(settings.get('background.id'));
  document.documentElement.style.setProperty('--wallpaper', wallpaper.css);
  document.documentElement.dataset.wallpaper = wallpaper.id;
  // ARCHITECTURE §3 reserves a top-level `wallpaper` key for the shell.
  store.set('wallpaper', { id: wallpaper.id, kind: wallpaper.kind, css: wallpaper.css });

  const desktop = document.querySelector('.desktop') || document.getElementById('desktop');
  if (desktop instanceof HTMLElement) desktop.style.background = wallpaper.css;
}

function applyDock() {
  const root = document.documentElement;
  root.dataset.dockPosition = String(settings.get('dock.position'));
  root.dataset.dockAutohide = settings.get('dock.autohide') ? 'true' : 'false';
  root.style.setProperty('--dock-icon-size', `${settings.get('dock.iconSize')}px`);
}

/**
 * Apply the visual consequence of a single key.
 * @param {string} key
 */
function applyOne(key) {
  if (key.startsWith('appearance.style')) applyTheme();
  else if (key.startsWith('appearance.accent')) applyAccent();
  else if (key.startsWith('background.')) applyWallpaper();
  else if (key.startsWith('dock.')) applyDock();
}

/** Apply theme, accent, wallpaper and dock geometry all at once. */
export function applySettings() {
  applyTheme();
  applyAccent();
  applyWallpaper();
  applyDock();
}
