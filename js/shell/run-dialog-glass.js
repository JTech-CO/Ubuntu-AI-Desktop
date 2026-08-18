/**
 * js/shell/run-dialog-glass.js — the Looking Glass readout behind Alt+F2's
 * `lg` command.
 *
 * GNOME's Looking Glass is a GJS inspector attached to a live gnome-shell.
 * There is no GJS here, so rather than imitate an inspector that could not
 * inspect anything, this shows what the emulator genuinely knows about
 * itself: the windows the window manager is holding, the process table ps and
 * top read, a walk of the virtual filesystem, and how many bytes of
 * localStorage the whole desktop occupies.
 *
 * Every value goes into the DOM through `textContent`.
 */

import { h } from '../core/dom.js';
import { fs } from '../core/fs.js';
import { env } from '../core/env.js';
import { procs } from '../core/procs.js';
import { users } from '../core/users.js';
import { gemini } from '../services/gemini.js';
import { settings } from '../apps/settings/state.js';
import { wm } from './window-manager.js';
import { commandNames, builtinNames } from '../apps/terminal/shell.js';

/**
 * Walk a filesystem snapshot, counting what is in it.
 * @param {object} node
 * @param {{dirs:number, files:number, links:number, bytes:number}} acc
 * @returns {{dirs:number, files:number, links:number, bytes:number}}
 */
function countTree(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'dir') {
    acc.dirs += 1;
    for (const child of Object.values(node.children || {})) countTree(child, acc);
  } else if (node.type === 'link') {
    acc.links += 1;
  } else {
    acc.files += 1;
    acc.bytes += typeof node.content === 'string' ? node.content.length : 0;
  }
  return acc;
}

/** `1.2 MiB` */
function human(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * How much localStorage this desktop occupies.
 *
 * Read straight from `localStorage` rather than through `store`, because the
 * question is how many bytes are on disk, and `store` deliberately hides both
 * the key prefix and the serialised form.
 *
 * @returns {{keys:number, bytes:number}}
 */
function storageFootprint() {
  let keys = 0;
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('uad:')) continue;
      keys += 1;
      bytes += key.length + (localStorage.getItem(key) || '').length;
    }
  } catch {
    /* storage can be unavailable in private mode */
  }
  return { keys, bytes };
}

/** `2h 41m` */
function uptimePhrase() {
  const s = Math.floor(procs.uptime());
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${hrs}h ${min}m`;
  if (hrs > 0) return `${hrs}h ${min}m`;
  return `${min}m ${s % 60}s`;
}

/**
 * The rows Looking Glass shows, as [section, label, value] triples.
 * @returns {{section:string, rows:[string, string][]}[]}
 */
function lookingGlassData() {
  const instances = (() => {
    try {
      return wm.instances() || [];
    } catch {
      return [];
    }
  })();
  const active = (() => {
    try {
      return wm.active();
    } catch {
      return null;
    }
  })();
  const totals = procs.totals();
  const tree = countTree(fs.snapshot(), { dirs: 0, files: 0, links: 0, bytes: 0 });
  const footprint = storageFootprint();
  let external = 0;
  let builtins = 0;
  try {
    external = commandNames().length;
    builtins = builtinNames().length;
  } catch {
    external = 0;
    builtins = 0;
  }

  const windowRows = instances.length
    ? instances.map((inst) => [
      String(inst.id),
      `${inst.title || inst.appId}${String(inst.id) === String(active) ? '  (focused)' : ''}` +
      `${inst.minimized ? '  (minimized)' : ''}${inst.maximized ? '  (maximized)' : ''}`,
    ])
    : [['—', 'no windows open']];

  return [
    {
      section: 'Shell',
      rows: [
        ['GNOME Shell', '46.0 — emulated in the browser, no GJS'],
        ['Uptime', uptimePhrase()],
        ['Style', `${settings.get('appearance.style')}, accent ${settings.get('appearance.accent')}`],
        ['Windows open', String(instances.length)],
      ],
    },
    { section: 'Windows', rows: windowRows },
    {
      section: 'Processes',
      rows: [
        ['Table size', `${totals.procCount} processes, ${totals.threadCount} threads`],
        ['Load average', totals.load.map((n) => n.toFixed(2)).join('  ')],
        ['CPU', `${totals.cpu.toFixed(1)}% of ${procs.cores} cores`],
        ['Memory', `${(totals.memUsedMb / 1024).toFixed(2)} GiB of ${(totals.memTotalMb / 1024).toFixed(2)} GiB`],
        ['Swap', `${totals.swapUsedMb} MiB of ${totals.swapTotalMb} MiB`],
      ],
    },
    {
      section: 'Filesystem',
      rows: [
        ['Directories', String(tree.dirs)],
        ['Files', String(tree.files)],
        ['Symlinks', String(tree.links)],
        ['Content', human(tree.bytes)],
        ['localStorage', `${human(footprint.bytes)} across ${footprint.keys} keys`],
      ],
    },
    {
      section: 'Session',
      rows: [
        ['User', `${env.user}@${users.hostname}`],
        ['Working directory', env.cwd],
        ['Commands', `${external} external, ${builtins} builtins`],
        ['Gemini API key', gemini.hasKey() ? 'configured' : 'not configured'],
        ['Debug handle', 'window.UAD — fs, wm, procs, env, bus, store, gemini'],
      ],
    },
  ];
}

/**
 * Replace the dialog body with the Looking Glass readout.
 * @param {HTMLElement} panel the .run-dialog element
 * @param {HTMLElement} entryRow the entry to hide while the readout is up
 */
export function showLookingGlass(panel, entryRow) {
  if (!panel) return;
  panel.classList.add('run-dialog--glass');
  if (entryRow) entryRow.hidden = true;

  const body = h('div.run-dialog__glass', { role: 'document', tabindex: '-1' });
  body.appendChild(h('div.run-dialog__glass-title', { text: 'Looking Glass' }));

  for (const group of lookingGlassData()) {
    body.appendChild(h('div.run-dialog__glass-section', { text: group.section }));
    const list = h('dl.run-dialog__glass-list');
    for (const [label, value] of group.rows) {
      list.appendChild(h('dt', { text: label }));
      list.appendChild(h('dd', { text: value }));
    }
    body.appendChild(list);
  }

  body.appendChild(h('div.run-dialog__glass-hint', { text: 'Press Escape to close' }));

  const existing = panel.querySelector('.run-dialog__glass');
  if (existing) existing.remove();
  panel.appendChild(body);
  body.focus();
}

