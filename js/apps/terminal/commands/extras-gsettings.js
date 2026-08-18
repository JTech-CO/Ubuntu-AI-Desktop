/**
 * js/apps/terminal/commands/extras-gsettings.js — the desktop configuration
 * commands: gsettings and dconf.
 *
 * gsettings and dconf are wired straight through to the same settings store
 * the Settings app and the quick-settings menu write to, so
 *
 *     gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
 *
 * really does turn the desktop dark, and flipping the switch in Settings
 * really does change what `gsettings get` returns a moment later. That is the
 * whole point of these two commands existing here.
 *
 * A handful of keys in the schema table have no counterpart in the emulator —
 * cursor themes, touchpad tap-to-click — and those are marked `local`. They
 * still read and write, persisting under the store key `gsettings`, but they
 * change nothing on screen and `--describe` says so.
 */

import { store } from '../../../core/store.js';
import { settings, DEFAULTS, getWallpaper } from '../../settings/state.js';
import { pinnedApps } from '../../registry.js';
import { DESKTOP_IDS } from './extras-xdg.js';
import { ok, fail } from './util.js';

/* ------------------------------------------------------------------ *
 * GVariant text
 * ------------------------------------------------------------------ */

/**
 * Serialise a value the way `gsettings get` prints it.
 * @param {any} value
 * @param {string} type GVariant type code: s b i u d as
 * @returns {string}
 */
function toGVariant(value, type) {
  if (type === 's') return `'${String(value).replace(/'/g, "\\'")}'`;
  if (type === 'b') return value ? 'true' : 'false';
  if (type === 'u') return `uint32 ${Math.round(Number(value))}`;
  if (type === 'i') return String(Math.round(Number(value)));
  if (type === 'd') return Number(value).toFixed(1);
  if (type === 'as') return `[${(value || []).map((v) => `'${v}'`).join(', ')}]`;
  return String(value);
}

/**
 * Parse a GVariant literal the way `gsettings set` accepts it.
 * @param {string} text
 * @param {string} type
 * @returns {{value:any}|{error:string}}
 */
function fromGVariant(text, type) {
  const raw = String(text).trim();
  if (type === 's') {
    const m = /^'(.*)'$/.exec(raw) || /^"(.*)"$/.exec(raw);
    return { value: m ? m[1] : raw };
  }
  if (type === 'b') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: `expected 'true' or 'false'` };
  }
  if (type === 'i' || type === 'u') {
    const n = Number(raw.replace(/^uint32\s+/, ''));
    if (!Number.isFinite(n)) return { error: 'expected an integer' };
    if (type === 'u' && n < 0) return { error: 'value is out of range' };
    return { value: Math.round(n) };
  }
  if (type === 'd') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: 'expected a number' };
    return { value: n };
  }
  if (type === 'as') {
    const inner = /^\[(.*)\]$/.exec(raw);
    if (!inner) return { error: 'expected an array' };
    const items = inner[1].trim() === '' ? [] : inner[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    return { value: items };
  }
  return { value: raw };
}

/* ------------------------------------------------------------------ *
 * the schema table
 * ------------------------------------------------------------------ */

/** Keys with no emulator counterpart are stored here instead. */
function localOverlay() {
  const saved = store.get('gsettings', null);
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

function readLocal(schema, key, fallback) {
  const overlay = localOverlay();
  const id = `${schema}.${key}`;
  return Object.prototype.hasOwnProperty.call(overlay, id) ? overlay[id] : fallback;
}

function writeLocal(schema, key, value) {
  const overlay = localOverlay();
  overlay[`${schema}.${key}`] = value;
  store.set('gsettings', overlay);
}

function clearLocal(schema, key) {
  const overlay = localOverlay();
  delete overlay[`${schema}.${key}`];
  store.set('gsettings', overlay);
}

/**
 * One schema key.
 * @typedef {{key:string, type:string, get:() => any, set?:(v:any) => void,
 *            note?:string}} SchemaKey
 */

/** Build a key backed by a settings-store entry, with optional translation. */
function bound(key, type, settingKey, toG = (v) => v, fromG = (v) => v) {
  return {
    key,
    type,
    get: () => toG(settings.get(settingKey)),
    set: (v) => settings.set(settingKey, fromG(v)),
    reset: () => settings.set(settingKey, DEFAULTS[settingKey]),
    backing: settingKey,
  };
}

/** Build a key with no emulator counterpart: read/write, but inert. */
function local(schema, key, type, fallback, note) {
  return {
    key,
    type,
    get: () => readLocal(schema, key, fallback),
    set: (v) => writeLocal(schema, key, v),
    reset: () => clearLocal(schema, key),
    note: note || 'stored, but nothing in this desktop reads it',
  };
}

/** @type {{schema:string, keys:SchemaKey[]}[]} */
const SCHEMAS = [
  {
    schema: 'org.gnome.desktop.interface',
    keys: [
      bound('color-scheme', 's', 'appearance.style',
        (v) => (v === 'dark' ? 'prefer-dark' : v === 'auto' ? 'default' : 'default'),
        (v) => (v === 'prefer-dark' ? 'dark' : 'light')),
      bound('gtk-theme', 's', 'appearance.accent',
        (v) => (v === 'orange' ? 'Yaru' : `Yaru-${v}`),
        (v) => String(v).replace(/^Yaru-?/, '') || 'orange'),
      bound('clock-format', 's', 'datetime.timeFormat', (v) => v, (v) => v),
      bound('clock-show-seconds', 'b', 'datetime.showSeconds'),
      bound('clock-show-weekday', 'b', 'datetime.showWeekday'),
      bound('clock-show-date', 'b', 'datetime.showDate'),
      bound('show-battery-percentage', 'b', 'power.batteryPercentage'),
      local('org.gnome.desktop.interface', 'icon-theme', 's', 'Yaru'),
      local('org.gnome.desktop.interface', 'cursor-theme', 's', 'Yaru'),
      local('org.gnome.desktop.interface', 'font-name', 's', 'Ubuntu Sans 11'),
      local('org.gnome.desktop.interface', 'document-font-name', 's', 'Sans 11'),
      local('org.gnome.desktop.interface', 'monospace-font-name', 's', 'Ubuntu Sans Mono 13'),
      local('org.gnome.desktop.interface', 'text-scaling-factor', 'd', 1.0),
      local('org.gnome.desktop.interface', 'enable-animations', 'b', true),
      local('org.gnome.desktop.interface', 'toolkit-accessibility', 'b', false),
    ],
  },
  {
    schema: 'org.gnome.desktop.background',
    keys: [
      bound('picture-uri', 's', 'background.id',
        (v) => `file:///usr/share/backgrounds/${getWallpaper(v).id}.png`,
        (v) => String(v).replace(/^.*\//, '').replace(/\.[a-z]+$/i, '')),
      bound('picture-uri-dark', 's', 'background.id',
        (v) => `file:///usr/share/backgrounds/${getWallpaper(v).id}.png`,
        (v) => String(v).replace(/^.*\//, '').replace(/\.[a-z]+$/i, '')),
      local('org.gnome.desktop.background', 'picture-options', 's', 'zoom'),
      local('org.gnome.desktop.background', 'primary-color', 's', '#2c001e'),
    ],
  },
  {
    schema: 'org.gnome.desktop.notifications',
    keys: [
      bound('show-banners', 'b', 'notifications.doNotDisturb', (v) => !v, (v) => !v),
      bound('show-in-lock-screen', 'b', 'notifications.lockScreen'),
    ],
  },
  {
    schema: 'org.gnome.desktop.sound',
    keys: [
      bound('event-sounds', 'b', 'sound.systemSounds'),
      bound('allow-volume-above-100-percent', 'b', 'sound.overAmplification'),
      local('org.gnome.desktop.sound', 'theme-name', 's', 'Yaru'),
    ],
  },
  {
    schema: 'org.gnome.desktop.session',
    keys: [bound('idle-delay', 'u', 'power.blankDelay')],
  },
  {
    schema: 'org.gnome.desktop.screensaver',
    keys: [
      local('org.gnome.desktop.screensaver', 'lock-enabled', 'b', true),
      local('org.gnome.desktop.screensaver', 'lock-delay', 'u', 0),
    ],
  },
  {
    schema: 'org.gnome.desktop.datetime',
    keys: [bound('automatic-timezone', 'b', 'datetime.automaticTimezone')],
  },
  {
    schema: 'org.gnome.desktop.privacy',
    keys: [
      local('org.gnome.desktop.privacy', 'remember-recent-files', 'b', true),
      local('org.gnome.desktop.privacy', 'report-technical-problems', 'b', false),
    ],
  },
  {
    schema: 'org.gnome.desktop.peripherals.touchpad',
    keys: [
      local('org.gnome.desktop.peripherals.touchpad', 'tap-to-click', 'b', true),
      local('org.gnome.desktop.peripherals.touchpad', 'natural-scroll', 'b', true),
    ],
  },
  {
    schema: 'org.gnome.desktop.wm.preferences',
    keys: [
      bound('num-workspaces', 'i', 'multitasking.fixedCount'),
      local('org.gnome.desktop.wm.preferences', 'button-layout', 's', 'appmenu:minimize,maximize,close'),
      local('org.gnome.desktop.wm.preferences', 'titlebar-font', 's', 'Ubuntu Sans Bold 11'),
      local('org.gnome.desktop.wm.preferences', 'focus-mode', 's', 'click'),
    ],
  },
  {
    schema: 'org.gnome.mutter',
    keys: [
      bound('dynamic-workspaces', 'b', 'multitasking.workspaces',
        (v) => v === 'dynamic', (v) => (v ? 'dynamic' : 'fixed')),
      bound('workspaces-only-on-primary', 'b', 'multitasking.allDisplays', (v) => !v, (v) => !v),
      bound('edge-tiling', 'b', 'multitasking.activeEdges'),
      local('org.gnome.mutter', 'experimental-features', 'as', []),
    ],
  },
  {
    schema: 'org.gnome.shell',
    keys: [
      {
        key: 'favorite-apps',
        type: 'as',
        get: () => pinnedApps().map((a) => DESKTOP_IDS[a.id] || `${a.id}.desktop`),
        note: 'read-only here: the dock reads js/apps/registry.js',
      },
      local('org.gnome.shell', 'enabled-extensions', 'as',
        ['ubuntu-dock@ubuntu.com', 'ding@rastersoft.com', 'tiling-assistant@ubuntu.com']),
    ],
  },
  {
    schema: 'org.gnome.shell.extensions.dash-to-dock',
    keys: [
      bound('dock-position', 's', 'dock.position',
        (v) => String(v).toUpperCase(), (v) => String(v).toLowerCase()),
      bound('dash-max-icon-size', 'i', 'dock.iconSize'),
      bound('autohide', 'b', 'dock.autohide'),
      bound('dock-fixed', 'b', 'dock.autohide', (v) => !v, (v) => !v),
      bound('show-trash', 'b', 'dock.showTrash'),
      bound('show-mounts', 'b', 'dock.showMounts'),
    ],
  },
  {
    schema: 'org.gnome.settings-daemon.plugins.power',
    keys: [
      bound('sleep-inactive-ac-timeout', 'i', 'power.suspendDelay'),
      bound('sleep-inactive-ac-type', 's', 'power.automaticSuspend',
        (v) => (v ? 'suspend' : 'nothing'), (v) => v === 'suspend'),
      bound('idle-dim', 'b', 'power.dimScreen'),
      local('org.gnome.settings-daemon.plugins.power', 'power-button-action', 's', 'interactive'),
    ],
  },
];

/** @param {string} name @returns {{schema:string, keys:SchemaKey[]}|null} */
function findSchema(name) {
  return SCHEMAS.find((s) => s.schema === name) || null;
}

/** @returns {{schema:object, entry:SchemaKey}|null} */
function findKey(schemaName, keyName) {
  const schema = findSchema(schemaName);
  if (!schema) return null;
  const entry = schema.keys.find((k) => k.key === keyName);
  return entry ? { schema, entry } : null;
}

/* ================================================================== *
 * gsettings
 * ================================================================== */

const gsettingsCommand = {
  name: 'gsettings',
  aliases: [],
  synopsis: 'gsettings [get|set|reset|list-schemas|list-keys|list-recursively|describe|range] ...',
  description: 'Query and set GSettings keys',
  man: `NAME
       gsettings - GSettings configuration tool

SYNOPSIS
       gsettings list-schemas
       gsettings list-keys SCHEMA
       gsettings list-recursively [SCHEMA]
       gsettings get SCHEMA KEY
       gsettings set SCHEMA KEY VALUE
       gsettings reset SCHEMA KEY
       gsettings describe SCHEMA KEY

DESCRIPTION
       Reads and writes the desktop's GSettings database.

       Most keys are wired to the live desktop. Setting
       org.gnome.desktop.interface color-scheme to 'prefer-dark' switches the
       theme immediately, dash-to-dock dock-position moves the dock, and
       org.gnome.desktop.background picture-uri changes the wallpaper — the
       same writes the Settings app performs, through the same store, emitting
       the same settings:change event.

       A few keys are stored but inert: cursor themes, touchpad behaviour and
       the like have no counterpart in a browser. \`gsettings describe\` marks
       those, so you always know whether a key does anything.

       Values use GVariant syntax: strings are quoted, booleans are true or
       false, and arrays look like ['a', 'b'].

EXIT STATUS
       0  success
       1  no such schema, key, or malformed value`,

  async run(ctx) {
    const [verb, ...rest] = ctx.argv;

    if (!verb || verb === '--help' || verb === '-h') {
      return ok([
        'Usage:',
        '  gsettings [--schemadir SCHEMADIR] COMMAND [ARGS?]',
        '',
        'Commands:',
        '  help                      Show this information',
        '  list-schemas              List installed schemas',
        '  list-keys                 List keys in a schema',
        '  list-recursively          List keys and values, recursively',
        '  range                     Queries the range of a key',
        '  describe                  Queries the description of a key',
        '  get                       Get the value of a key',
        '  set                       Set the value of a key',
        '  reset                     Reset the value of a key',
        '',
      ].join('\n'));
    }
    if (verb === '--version') return ok('2.80.0\n');

    if (verb === 'list-schemas') {
      return ok(`${SCHEMAS.map((s) => s.schema).sort().join('\n')}\n`);
    }

    if (verb === 'list-keys') {
      const schema = findSchema(rest[0]);
      if (!schema) return fail(`No such schema "${rest[0] || ''}"\n`, 1);
      return ok(`${schema.keys.map((k) => k.key).sort().join('\n')}\n`);
    }

    if (verb === 'list-recursively') {
      const list = rest[0] ? [findSchema(rest[0])].filter(Boolean) : SCHEMAS;
      if (rest[0] && !list.length) return fail(`No such schema "${rest[0]}"\n`, 1);
      const lines = [];
      for (const schema of list) {
        for (const entry of schema.keys) {
          lines.push(`${schema.schema} ${entry.key} ${toGVariant(entry.get(), entry.type)}`);
        }
      }
      return ok(`${lines.join('\n')}\n`);
    }

    if (verb === 'get' || verb === 'describe' || verb === 'range' || verb === 'reset') {
      const found = findKey(rest[0], rest[1]);
      if (!findSchema(rest[0])) return fail(`No such schema "${rest[0] || ''}"\n`, 1);
      if (!found) return fail(`No such key "${rest[1] || ''}"\n`, 1);
      const { entry } = found;

      if (verb === 'get') return ok(`${toGVariant(entry.get(), entry.type)}\n`);
      if (verb === 'range') {
        return ok(entry.type === 'b' ? 'type b\n' : `type ${entry.type}\n`);
      }
      if (verb === 'describe') {
        const where = entry.backing
          ? `Live: writing this key changes the desktop (settings key "${entry.backing}").`
          : entry.note
            ? `Inert: ${entry.note}.`
            : 'Inert: stored but unused.';
        return ok(`${where}\n`);
      }
      if (!entry.set && !entry.reset) {
        return fail(`gsettings: key "${entry.key}" is read-only in this desktop\n`, 1);
      }
      if (entry.reset) entry.reset();
      else if (entry.backing) settings.set(entry.backing, undefined);
      return ok('');
    }

    if (verb === 'set') {
      const found = findKey(rest[0], rest[1]);
      if (!findSchema(rest[0])) return fail(`No such schema "${rest[0] || ''}"\n`, 1);
      if (!found) return fail(`No such key "${rest[1] || ''}"\n`, 1);
      const { entry } = found;
      if (!entry.set) {
        return fail(`gsettings: key "${entry.key}" is read-only in this desktop\n`, 1);
      }
      const literal = rest.slice(2).join(' ');
      if (literal === '') return fail('gsettings: a value is required\n', 1);
      const parsed = fromGVariant(literal, entry.type);
      if (parsed.error) {
        return fail(`gsettings: ${literal}: ${parsed.error}\n`, 1);
      }
      entry.set(parsed.value);
      return ok('');
    }

    return fail(`Unknown command ${verb}\n`, 1);
  },
};

/* ================================================================== *
 * dconf
 * ================================================================== */

/** `/org/gnome/desktop/interface/color-scheme` -> schema + key. */
function splitPath(dconfPath) {
  const clean = String(dconfPath).replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = clean.split('/');
  if (parts.length < 2) return null;
  const key = parts.pop();
  return { schema: parts.join('.'), key };
}

const dconfCommand = {
  name: 'dconf',
  aliases: [],
  synopsis: 'dconf read|write|reset|list|dump PATH [VALUE]',
  description: 'Read and write the dconf database directly',
  man: `NAME
       dconf - simple tool for manipulating a dconf database

SYNOPSIS
       dconf read PATH
       dconf write PATH VALUE
       dconf reset PATH
       dconf list DIR
       dconf dump DIR

DESCRIPTION
       dconf reaches the same database gsettings does, but addresses it by
       path rather than by schema, and does not validate against a schema.

       Paths look like /org/gnome/desktop/interface/color-scheme — the schema
       with dots replaced by slashes. A directory path ends in a slash.

       Everything gsettings can change here, dconf can change too, and with
       the same live effect on the desktop.

       \`dconf watch\` is not implemented: it needs a D-Bus signal from a real
       dconf service, and there is none. It says so rather than blocking on a
       stream that would never emit.

EXIT STATUS
       0  success
       1  no such path, or a malformed value`,

  async run(ctx) {
    const [verb, ...rest] = ctx.argv;
    if (!verb || verb === '--help' || verb === '-h') {
      return ok([
        'Usage:',
        '  dconf COMMAND [ARGS…]',
        '',
        'Commands:',
        '  help              Show this information',
        '  read              Read the value of a key',
        '  list              List the contents of a dir',
        '  write             Change the value of a key',
        '  reset             Reset the value of a key or dir',
        '  dump              Dump an entire subpath to stdout',
        '',
      ].join('\n'));
    }
    if (verb === '--version') return ok('0.40.0\n');

    if (verb === 'watch') {
      return fail(
        'dconf: watch needs a change signal from the dconf D-Bus service, and this\n' +
        'dconf: desktop has no D-Bus. Nothing would ever be reported, so nothing is\n' +
        'dconf: pretended. Use `gsettings get` after a change instead.\n',
        1,
      );
    }

    if (verb === 'list') {
      const dir = String(rest[0] || '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '.');
      const children = new Set();
      for (const schema of SCHEMAS) {
        if (dir === '' || schema.schema === dir) {
          if (schema.schema === dir) {
            for (const k of schema.keys) children.add(k.key);
          } else {
            children.add(`${schema.schema.split('.')[0]}/`);
          }
          continue;
        }
        if (schema.schema.startsWith(`${dir}.`)) {
          children.add(`${schema.schema.slice(dir.length + 1).split('.')[0]}/`);
        }
      }
      if (!children.size) return fail(`dconf: no such directory\n`, 1);
      return ok(`${Array.from(children).sort().join('\n')}\n`);
    }

    if (verb === 'dump') {
      const dir = String(rest[0] || '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '.');
      const lines = [];
      for (const schema of SCHEMAS) {
        if (dir !== '' && schema.schema !== dir && !schema.schema.startsWith(`${dir}.`)) continue;
        lines.push(`[${schema.schema.replace(/\./g, '/')}]`);
        for (const entry of schema.keys) {
          lines.push(`${entry.key}=${toGVariant(entry.get(), entry.type)}`);
        }
        lines.push('');
      }
      if (!lines.length) return ok('');
      return ok(`${lines.join('\n')}\n`);
    }

    const parts = splitPath(rest[0] || '');
    if (!parts) return fail('dconf: a key path is required\n', 1);
    const found = findKey(parts.schema, parts.key);
    if (!found) return fail(`dconf: no such key: ${rest[0]}\n`, 1);
    const { entry } = found;

    if (verb === 'read') return ok(`${toGVariant(entry.get(), entry.type)}\n`);

    if (verb === 'write') {
      if (!entry.set) return fail(`dconf: ${rest[0]} is read-only in this desktop\n`, 1);
      const literal = rest.slice(1).join(' ');
      const parsed = fromGVariant(literal, entry.type);
      if (parsed.error) return fail(`dconf: ${literal}: ${parsed.error}\n`, 1);
      entry.set(parsed.value);
      return ok('');
    }

    if (verb === 'reset') {
      if (entry.reset) entry.reset();
      return ok('');
    }

    return fail(`dconf: unknown command ${verb}\n`, 1);
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const gsettingsCommands = [
  gsettingsCommand,
  dconfCommand,
];

export default gsettingsCommands;
