/**
 * js/shell/run-dialog.js — GNOME's Alt+F2 "Enter a Command" dialog.
 *
 * A single rounded entry floating near the top of the screen, no window
 * chrome, Escape or a click outside to dismiss. It resolves what you type in
 * the same order GNOME does:
 *
 *   1. a registered application (by id or by name)
 *   2. a known desktop launcher name (nautilus, gnome-terminal, gedit, …)
 *   3. any terminal command, run through the shell
 *
 * plus the two GNOME built-ins: `r` / `restart` restarts the shell, and `lg`
 * opens Looking Glass, which lives in the sibling `run-dialog-glass.js`.
 *
 * A command that matches nothing leaves the dialog open with GNOME's red
 * underline rather than closing and silently doing nothing.
 *
 * Everything typed by the user reaches the DOM through `textContent` or the
 * helpers in core/dom.js. Nothing here builds markup from input.
 */

import { h, clear } from '../core/dom.js';
import { store } from '../core/store.js';
import { notify } from '../core/notify.js';
import { bus } from '../core/bus.js';
import { apps, getApp } from '../apps/registry.js';
import { wm } from './window-manager.js';
import { showLookingGlass } from './run-dialog-glass.js';
import {
  execute, createSession, commandNames, builtinNames, hasCommand,
} from '../apps/terminal/shell.js';

/** Desktop launcher names Ubuntu ships, mapped to the app that answers them. */
const LAUNCHERS = {
  nautilus: 'files',
  'gnome-files': 'files',
  'org.gnome.nautilus': 'files',
  'gnome-terminal': 'terminal',
  'org.gnome.terminal': 'terminal',
  'x-terminal-emulator': 'terminal',
  firefox: 'firefox',
  'x-www-browser': 'firefox',
  gedit: 'editor',
  'gnome-text-editor': 'editor',
  'org.gnome.texteditor': 'editor',
  editor: 'editor',
  code: 'codeoss',
  'code-oss': 'codeoss',
  eog: 'imageviewer',
  loupe: 'imageviewer',
  'org.gnome.loupe': 'imageviewer',
  'gnome-calculator': 'calculator',
  'org.gnome.calculator': 'calculator',
  'gnome-system-monitor': 'monitor',
  'gnome-control-center': 'settings',
  'gnome-settings': 'settings',
};

const HISTORY_KEY = 'run-history';
const HISTORY_MAX = 24;

/** The stylesheet is loaded by this module so index.html needs no edit. */
const STYLESHEET = new URL('../../css/shell/run-dialog.css', import.meta.url).href;

let installed = false;
let root = null;
let input = null;
let ghostTyped = null;
let ghostRest = null;
let panel = null;
let entryRow = null;
let session = null;
let historyIndex = -1;
let draft = '';

/* ------------------------------------------------------------------ *
 * history
 * ------------------------------------------------------------------ */

/** @returns {string[]} most recent first */
function history() {
  const saved = store.get(HISTORY_KEY, null);
  return Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : [];
}

/** @param {string} command */
function remember(command) {
  const text = String(command).trim();
  if (!text) return;
  const list = history().filter((entry) => entry !== text);
  list.unshift(text);
  store.set(HISTORY_KEY, list.slice(0, HISTORY_MAX));
}

/* ------------------------------------------------------------------ *
 * resolution
 * ------------------------------------------------------------------ */

/**
 * Match an application by id or display name, case-insensitively.
 * @param {string} text
 * @returns {string|null} the app id
 */
function resolveApp(text) {
  const wanted = String(text).trim().toLowerCase();
  if (!wanted) return null;
  for (const app of apps) {
    if (app.id.toLowerCase() === wanted) return app.id;
    if (String(app.name).toLowerCase() === wanted) return app.id;
  }
  return null;
}

/**
 * Match a desktop launcher name, tolerating a `.desktop` suffix.
 * @param {string} text
 * @returns {string|null} the app id
 */
function resolveLauncher(text) {
  const wanted = String(text).trim().toLowerCase().replace(/\.desktop$/, '');
  const appId = LAUNCHERS[wanted];
  return appId && getApp(appId) ? appId : null;
}

/** Everything the entry can complete against, sorted and de-duplicated. */
function completionPool() {
  const set = new Set();
  for (const app of apps) {
    set.add(app.id);
    set.add(String(app.name).toLowerCase());
  }
  for (const name of Object.keys(LAUNCHERS)) set.add(name);
  try {
    for (const name of commandNames()) set.add(name);
    for (const name of builtinNames()) set.add(name);
  } catch {
    /* the command table is still loading; app names alone will do */
  }
  set.add('lg');
  set.add('restart');
  return Array.from(set).sort();
}

/**
 * The completion for a partially typed command: the shortest candidate that
 * starts with it, breaking ties alphabetically.
 * @param {string} text
 * @returns {string} the whole completed word, or '' when there is none
 */
function completionFor(text) {
  const typed = String(text);
  if (!typed || /\s/.test(typed)) return '';
  const lower = typed.toLowerCase();
  let best = '';
  for (const candidate of completionPool()) {
    if (!candidate.toLowerCase().startsWith(lower)) continue;
    if (candidate.length === typed.length) continue;
    if (!best || candidate.length < best.length) best = candidate;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * running
 * ------------------------------------------------------------------ */

/** Flash the entry red the way GNOME does for an unknown command. */
function showError(message) {
  if (!panel) return;
  panel.classList.remove('run-dialog--error');
  // Reflow so the animation restarts on a repeated failure.
  void panel.offsetWidth;
  panel.classList.add('run-dialog--error');
  const hint = panel.querySelector('.run-dialog__hint');
  if (hint) hint.textContent = message;
  if (input) input.select();
}

/** Clear the error state on the next keystroke. */
function clearError() {
  if (!panel) return;
  panel.classList.remove('run-dialog--error');
  const hint = panel.querySelector('.run-dialog__hint');
  if (hint) hint.textContent = 'Press Enter to run, Tab to complete, Escape to close';
}

/**
 * Run a command line through the shell and report the result in a
 * notification, which is where GNOME puts the output of a failed Alt+F2 run.
 *
 * @param {string} line
 */
async function runThroughShell(line) {
  if (!session) session = createSession();
  let result;
  try {
    result = await execute(line, { session, capture: true });
  } catch (err) {
    notify.show({
      app: 'Run a Command',
      title: line,
      body: err && err.message ? err.message : 'The command failed.',
      icon: '⚠',
      timeout: 8000,
    });
    return;
  }

  const text = `${result.stdout || ''}${result.stderr || ''}`
    // Commands emit SGR sequences for the terminal; a notification is plain.
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    .trim();

  if (!text && result.code === 0) return;

  notify.show({
    app: 'Run a Command',
    title: line,
    body: text.length > 900 ? `${text.slice(0, 900)}…` : text || `Exited with status ${result.code}`,
    icon: result.code === 0 ? '▸' : '⚠',
    timeout: result.code === 0 ? 6000 : 10000,
  });
}

/**
 * Resolve and run whatever is in the entry.
 * @param {string} raw
 */
async function submit(raw) {
  const line = String(raw).trim();
  if (!line) return;

  const first = line.split(/\s+/)[0];

  /* --- GNOME's own commands ------------------------------------- */
  if (line === 'r' || line === 'restart') {
    remember(line);
    close();
    bus.emit('session:restart', {});
    window.location.reload();
    return;
  }
  if (line === 'lg') {
    remember(line);
    showLookingGlass(panel, entryRow);
    return;
  }

  /* --- an application ------------------------------------------- */
  const appId = resolveApp(line) || resolveLauncher(first);
  if (appId) {
    remember(line);
    close();
    wm.open(appId);
    return;
  }

  /* --- a terminal command --------------------------------------- */
  let known = false;
  try {
    known = hasCommand(first) || builtinNames().includes(first);
  } catch {
    known = false;
  }
  if (!known) {
    showError(`Command not found: ${first}`);
    return;
  }

  remember(line);
  close();
  await runThroughShell(line);
}

/* ------------------------------------------------------------------ *
 * the entry
 * ------------------------------------------------------------------ */

/** Redraw the ghost suffix under the input. */
function refreshGhost() {
  if (!input || !ghostTyped || !ghostRest) return;
  const value = input.value;
  const completion = completionFor(value);
  ghostTyped.textContent = value;
  ghostRest.textContent = completion ? completion.slice(value.length) : '';
  // A scrolled entry would put the ghost out of alignment, so hide it.
  ghostRest.hidden = input.scrollLeft > 0;
}

/** Accept the ghost suffix. */
function acceptGhost() {
  if (!input) return false;
  const completion = completionFor(input.value);
  if (!completion) return false;
  input.value = completion;
  input.setSelectionRange(completion.length, completion.length);
  refreshGhost();
  return true;
}

/** Step through the run history. */
function stepHistory(direction) {
  const list = history();
  if (!list.length) return;
  if (historyIndex === -1) draft = input.value;
  const next = historyIndex + direction;
  if (next < -1) return;
  if (next >= list.length) return;
  historyIndex = next;
  input.value = historyIndex === -1 ? draft : list[historyIndex];
  input.setSelectionRange(input.value.length, input.value.length);
  refreshGhost();
}

function onInputKeyDown(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    close();
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    ev.stopPropagation();
    submit(input.value);
    return;
  }
  if (ev.key === 'Tab') {
    ev.preventDefault();
    ev.stopPropagation();
    acceptGhost();
    return;
  }
  if ((ev.key === 'ArrowRight' || ev.key === 'End') &&
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length) {
    if (acceptGhost()) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    return;
  }
  if (ev.key === 'ArrowUp') {
    // Older entries have higher indices; -1 is the draft the user was typing.
    ev.preventDefault();
    ev.stopPropagation();
    stepHistory(1);
    return;
  }
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    ev.stopPropagation();
    stepHistory(-1);
    return;
  }
  // Every other key is the user editing; drop the error state.
  clearError();
  // Shell shortcuts must not fire while the entry has focus.
  ev.stopPropagation();
}

/** Escape typed anywhere in the overlay (Looking Glass has no entry). */
function onRootKeyDown(ev) {
  if (ev.key !== 'Escape') return;
  ev.preventDefault();
  ev.stopPropagation();
  close();
}

function onRootPointerDown(ev) {
  if (panel && panel.contains(ev.target)) return;
  close();
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

function ensureStylesheet() {
  // index.html links this stylesheet like every other one (ARCHITECTURE §1).
  // Compare resolved hrefs rather than looking for our own marker attribute,
  // or the static link is missed and the file is fetched and parsed twice.
  for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
    if (link.href === STYLESHEET) return;
  }
  const link = h('link', { rel: 'stylesheet', href: STYLESHEET });
  link.setAttribute('data-run-dialog-style', '');
  document.head.appendChild(link);
}

function build() {
  ensureStylesheet();

  root = h('div.run-dialog-layer', {
    role: 'presentation',
    hidden: '',
  });

  panel = h('div.run-dialog', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Enter a Command',
  });

  ghostTyped = h('span.run-dialog__ghost-typed');
  ghostRest = h('span.run-dialog__ghost-rest');

  input = h('input.run-dialog__input', {
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-label': 'Command',
    on: {
      input: () => {
        historyIndex = -1;
        clearError();
        refreshGhost();
      },
      keydown: onInputKeyDown,
      scroll: refreshGhost,
    },
  });

  entryRow = h('div.run-dialog__entry',
    h('div.run-dialog__ghost', { 'aria-hidden': 'true' }, ghostTyped, ghostRest),
    input);

  panel.appendChild(entryRow);
  panel.appendChild(h('div.run-dialog__hint', {
    text: 'Press Enter to run, Tab to complete, Escape to close',
  }));

  root.appendChild(panel);
  root.addEventListener('keydown', onRootKeyDown, true);
  root.addEventListener('mousedown', onRootPointerDown);
  document.body.appendChild(root);
}

/**
 * Create the dialog and its listeners. Safe to call more than once.
 * @returns {void}
 */
export function install() {
  if (installed) return;
  installed = true;
  build();
  // A restart or power-off must not leave the dialog floating over the shell.
  bus.on('session:poweroff', () => close());
  bus.on('session:lock', () => close());
}

/** @returns {boolean} */
export function isOpen() {
  return Boolean(root) && !root.hidden;
}

/**
 * Show the dialog, or move focus back to it when it is already up.
 * @returns {void}
 */
export function open() {
  install();
  if (!root) return;

  panel.classList.remove('run-dialog--glass', 'run-dialog--error');
  const glass = panel.querySelector('.run-dialog__glass');
  if (glass) glass.remove();
  entryRow.hidden = false;
  clearError();

  input.value = '';
  historyIndex = -1;
  draft = '';
  refreshGhost();

  root.hidden = false;
  // Force a reflow so the transition has a starting frame, then reveal.
  // Deliberately not requestAnimationFrame: a throttled or unpainted tab never
  // runs the callback, and the dialog would stay at opacity 0 forever.
  void root.offsetWidth;
  root.classList.add('run-dialog-layer--in');
  input.focus();
  bus.emit('shell:run-dialog', { open: true });
}

/**
 * Hide the dialog.
 * @returns {void}
 */
export function close() {
  if (!root || root.hidden) return;
  root.classList.remove('run-dialog-layer--in');
  root.hidden = true;
  const glass = panel && panel.querySelector('.run-dialog__glass');
  if (glass) glass.remove();
  if (input) input.blur();
  bus.emit('shell:run-dialog', { open: false });
}

/** Toggle, which is what a repeated Alt+F2 should do. */
export function toggle() {
  if (isOpen()) close();
  else open();
}

/** Remove the dialog and its listeners entirely. */
export function uninstall() {
  if (!installed) return;
  installed = false;
  if (root) {
    root.removeEventListener('keydown', onRootKeyDown, true);
    root.removeEventListener('mousedown', onRootPointerDown);
    clear(root);
    root.remove();
  }
  root = null;
  panel = null;
  input = null;
  entryRow = null;
  ghostTyped = null;
  ghostRest = null;
}

/** Grouped handle, matching the other shell modules. */
export const runDialog = { install, uninstall, open, close, toggle, isOpen };

export default runDialog;
