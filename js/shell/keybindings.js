/**
 * js/shell/keybindings.js — global shell shortcuts (ARCHITECTURE §15).
 *
 * `BINDINGS` is the table the Settings app renders under
 * Keyboard → Keyboard Shortcuts; the categories and descriptions match the
 * strings GNOME 46 actually shows there.
 *
 * A shortcut never fires while focus sits in a text entry, a textarea or a
 * contenteditable region — except the Super combos and Alt+Tab, which GNOME
 * also grabs unconditionally.
 */

import { bus } from '../core/bus.js';
import { dialog } from '../core/dialog.js';
import { wm } from './window-manager.js';
import { overview } from './overview.js';
import { systemMenu, lockScreen, takeScreenshot, isLocked } from './system-menu.js';
import { topBar } from './top-bar.js';
import { closeMenu as closeContextMenu, isMenuOpen } from './context-menu.js';
import { runDialog } from './run-dialog.js';

const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'password', 'email', 'url', 'tel', 'number', 'date',
  'datetime-local', 'month', 'time', 'week', '',
]);

const KEY_ALIASES = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Escape',
  PrintScreen: 'Print',
  Print: 'Print',
  ' ': 'Space',
  Spacebar: 'Space',
};

let installed = false;
let superArmed = false;
let showingDesktop = false;
const desktopMinimized = new Set();

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

function activeInstance() {
  try {
    return wm.active();
  } catch {
    return null;
  }
}

function instances() {
  try {
    return wm.instances() || [];
  } catch {
    return [];
  }
}

/**
 * Super+D — minimize everything, then bring the same windows back.
 * Delegates to the window manager when it implements the toggle itself.
 */
function toggleShowDesktop() {
  if (typeof wm.showDesktop === 'function') {
    wm.showDesktop();
    return;
  }
  const list = instances();
  if (!showingDesktop) {
    desktopMinimized.clear();
    for (const inst of list) {
      if (inst.minimized) continue;
      desktopMinimized.add(String(inst.id));
      wm.minimize(inst.id);
    }
    showingDesktop = desktopMinimized.size > 0;
    return;
  }
  for (const inst of list) {
    if (desktopMinimized.has(String(inst.id))) wm.restore(inst.id);
  }
  desktopMinimized.clear();
  showingDesktop = false;
}

function withActive(fn) {
  const id = activeInstance();
  if (id === null || id === undefined) return;
  fn(id);
}

/* ------------------------------------------------------------------ *
 * the binding table
 * ------------------------------------------------------------------ */

/**
 * @type {ReadonlyArray<{id:string, keys:string, description:string,
 *                       category:string, allowInInput:boolean, run:Function}>}
 */
export const BINDINGS = Object.freeze([
  {
    id: 'overview',
    keys: 'Super',
    description: 'Show the overview',
    category: 'System',
    allowInInput: true,
    run: () => overview.toggle(),
  },
  {
    id: 'show-applications',
    keys: 'Super+A',
    description: 'Show all applications',
    category: 'System',
    allowInInput: true,
    run: () => overview.openAppGrid(),
  },
  {
    id: 'notification-list',
    keys: 'Super+V',
    description: 'Show the notification list',
    category: 'System',
    allowInInput: true,
    run: () => topBar.toggleCalendar(),
  },
  {
    id: 'system-menu',
    keys: 'Super+S',
    description: 'Show the system menu',
    category: 'System',
    allowInInput: true,
    run: () => systemMenu.toggle(),
  },
  {
    id: 'lock-screen',
    keys: 'Super+L',
    description: 'Lock screen',
    category: 'System',
    allowInInput: true,
    run: () => lockScreen(),
  },
  {
    id: 'run-command',
    keys: 'Alt+F2',
    description: 'Show the run command prompt',
    category: 'System',
    // GNOME grabs Alt+F2 unconditionally, including from inside a text entry.
    allowInInput: true,
    run: () => runDialog.toggle(),
  },
  {
    id: 'switch-windows',
    keys: 'Alt+Tab',
    description: 'Switch windows',
    category: 'Navigation',
    allowInInput: true,
    run: () => wm.cycle(1),
  },
  {
    id: 'switch-windows-backward',
    keys: 'Alt+Shift+Tab',
    description: 'Switch windows backwards',
    category: 'Navigation',
    allowInInput: true,
    run: () => wm.cycle(-1),
  },
  {
    id: 'show-desktop',
    keys: 'Super+D',
    description: 'Hide all normal windows',
    category: 'Navigation',
    allowInInput: true,
    run: toggleShowDesktop,
  },
  {
    id: 'close-window',
    keys: 'Alt+F4',
    description: 'Close window',
    category: 'Windows',
    allowInInput: false,
    run: () => withActive((id) => wm.close(id)),
  },
  {
    id: 'maximize-window',
    keys: 'Super+Up',
    description: 'Maximize window',
    category: 'Windows',
    allowInInput: true,
    run: () => withActive((id) => wm.maximize(id)),
  },
  {
    id: 'restore-window',
    keys: 'Super+Down',
    description: 'Restore window',
    category: 'Windows',
    allowInInput: true,
    run: () => withActive((id) => wm.unmaximize(id)),
  },
  {
    id: 'tile-left',
    keys: 'Super+Left',
    description: 'View split on left',
    category: 'Windows',
    allowInInput: true,
    run: () => withActive((id) => wm.tile(id, 'left')),
  },
  {
    id: 'tile-right',
    keys: 'Super+Right',
    description: 'View split on right',
    category: 'Windows',
    allowInInput: true,
    run: () => withActive((id) => wm.tile(id, 'right')),
  },
  {
    id: 'launch-terminal',
    keys: 'Ctrl+Alt+T',
    description: 'Launch terminal',
    category: 'Launchers',
    allowInInput: false,
    run: () => wm.open('terminal'),
  },
  {
    id: 'screenshot',
    keys: 'Print',
    description: 'Take a screenshot',
    category: 'Screenshots',
    allowInInput: false,
    run: () => takeScreenshot(),
  },
]);

/** @type {Map<string, object>} */
const byCombo = new Map();
for (const binding of BINDINGS) {
  if (binding.keys !== 'Super') byCombo.set(binding.keys, binding);
}

/**
 * The binding table grouped for display, in GNOME's own category order.
 * @returns {{category: string, items: {id:string, keys:string, description:string}[]}[]}
 */
export function bindingGroups() {
  const order = ['Launchers', 'Navigation', 'Screenshots', 'System', 'Windows'];
  const groups = new Map();
  for (const binding of BINDINGS) {
    if (!groups.has(binding.category)) groups.set(binding.category, []);
    groups.get(binding.category).push({
      id: binding.id,
      keys: binding.keys,
      description: binding.description,
    });
  }
  return order
    .filter((name) => groups.has(name))
    .map((name) => ({ category: name, items: groups.get(name) }));
}

/* ------------------------------------------------------------------ *
 * event handling
 * ------------------------------------------------------------------ */

function isTextEntry(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(node.type || '').toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return node.getAttribute && node.getAttribute('role') === 'textbox';
}

function normalizeKey(ev) {
  const key = ev.key;
  if (key === undefined || key === null) return '';
  if (KEY_ALIASES[key]) return KEY_ALIASES[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function comboOf(ev) {
  const key = normalizeKey(ev);
  if (!key || key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta' || key === 'OS') {
    return '';
  }
  const parts = [];
  if (ev.ctrlKey) parts.push('Ctrl');
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');
  if (ev.metaKey) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

/** Shell shortcuts stand down while a modal dialog or the lock screen is up. */
function shellBusy() {
  return isLocked() || dialog.isOpen();
}

function onKeyDown(ev) {
  if (ev.key === 'Meta' || ev.key === 'OS') {
    superArmed = !ev.repeat && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !shellBusy();
    return;
  }
  superArmed = false;

  if (shellBusy()) return;

  const combo = comboOf(ev);
  if (!combo) return;

  const binding = byCombo.get(combo);
  if (!binding) return;
  if (!binding.allowInInput && isTextEntry(document.activeElement)) return;
  // While the run dialog is up it owns the keyboard, exactly as in GNOME —
  // apart from Alt+F2 itself, which dismisses it again.
  if (binding.id !== 'run-command' && runDialog.isOpen()) return;

  ev.preventDefault();
  ev.stopPropagation();
  if (isMenuOpen()) closeContextMenu();

  try {
    binding.run();
  } catch (err) {
    console.error(`[keybindings] "${binding.id}" failed:`, err);
  }
  bus.emit('shell:shortcut', { id: binding.id, keys: binding.keys });
}

function onKeyUp(ev) {
  if (ev.key !== 'Meta' && ev.key !== 'OS') return;
  if (!superArmed) return;
  superArmed = false;
  if (shellBusy()) return;
  ev.preventDefault();
  overview.toggle();
  bus.emit('shell:shortcut', { id: 'overview', keys: 'Super' });
}

function disarmSuper() {
  superArmed = false;
}

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

/**
 * Register the global shortcuts. Safe to call more than once.
 * @returns {ReadonlyArray<object>} the binding table
 */
export function install() {
  if (installed) return BINDINGS;
  installed = true;

  // Built eagerly so its stylesheet is in place before the first Alt+F2.
  runDialog.install();

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('mousedown', disarmSuper, true);
  document.addEventListener('wheel', disarmSuper, { capture: true, passive: true });
  window.addEventListener('blur', disarmSuper);

  // Any user-driven window change invalidates the Super+D pairing.
  for (const event of ['win:open', 'win:close']) {
    bus.on(event, () => {
      showingDesktop = false;
      desktopMinimized.clear();
    });
  }

  return BINDINGS;
}

/** Remove every global listener. */
export function uninstall() {
  if (!installed) return;
  installed = false;
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('keyup', onKeyUp, true);
  document.removeEventListener('mousedown', disarmSuper, true);
  document.removeEventListener('wheel', disarmSuper, true);
  window.removeEventListener('blur', disarmSuper);
}

/** Alias so `main.js` can import every shell installer side by side. */
export const installKeybindings = install;

/** Grouped handle for main.js and the Settings app. */
export const keybindings = {
  install,
  uninstall,
  bindings: BINDINGS,
  groups: bindingGroups,
  /** @param {string} id @returns {object|undefined} */
  get: (id) => BINDINGS.find((b) => b.id === id),
};
