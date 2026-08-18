/**
 * js/shell/dock.js — the Ubuntu dock (Dash to Dock) — ARCHITECTURE §15.
 *
 * Pinned apps first, then running-but-unpinned apps, Trash pinned at the
 * bottom with a live item badge, and the Show Applications button below it,
 * exactly like Ubuntu's default layout.
 *
 * Indicators follow Yaru: up to three small dots on the inner edge for the
 * number of open windows, replaced by an accent bar when the app is focused.
 *
 * Reacts to `win:open`, `win:close`, `win:focus`, `win:minimize`,
 * `win:restore`, `fs:trash`, `fs:change` and `settings:change`.
 */

import { h, svg, clear } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { fs } from '../core/fs.js';
import { dialog } from '../core/dialog.js';
import { wm } from './window-manager.js';
import { apps as registeredApps, getApp } from '../apps/registry.js';
import { shellSettings, shellIcons } from './system-menu.js';
import { openMenu as openContextMenu } from './context-menu.js';
import { overview } from './overview.js';

const MAX_DOTS = 3;
const EDGE_REVEAL = 4;
const HIDE_DELAY = 380;

const MENU_ICON = {
  newWindow: ['M3.6 6.2h16.8v11.6H3.6z', 'M3.6 9.6h16.8', 'M12 11.8v3.8', 'M10.1 13.7h3.8'],
  pin: ['M14 3.4 20.6 10l-2.7 1.3-4.3 5.6-1.3-1.3-5-5L8.6 9l5.4-4.3z', 'M9.3 14.7 4.4 19.6'],
  unpin: ['M14 3.4 20.6 10l-2.7 1.3-4.3 5.6-1.3-1.3-5-5L8.6 9l5.4-4.3z', 'M9.3 14.7 4.4 19.6', 'M3.4 3.4 20.6 20.6'],
  quit: ['M6.4 6.4 17.6 17.6', 'M17.6 6.4 6.4 17.6'],
  open: ['M4.5 6.6h5.2l1.8 2.2h8V18H4.5z'],
  empty: ['M4.5 6.6h15', 'M9.4 6.6V4.4h5.2v2.2', 'M6.6 6.6l.9 13h9l.9-13'],
  apps: [
    'M4.2 4.2h5.4v5.4H4.2z', 'M14.4 4.2h5.4v5.4h-5.4z',
    'M4.2 14.4h5.4v5.4H4.2z', 'M14.4 14.4h5.4v5.4h-5.4z',
  ],
};

let root = null;
let listEl = null;
let trashButton = null;
let trashBadge = null;
let installed = false;
let frameHandle = 0;
let revealed = true;
let hideTimer = 0;
let menuOpen = false;
let lastGeometry = '';

/* ------------------------------------------------------------------ *
 * settings-derived geometry
 * ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function position() {
  return shellSettings.get('dockPosition') === 'bottom' ? 'bottom' : 'left';
}

function iconSize() {
  return clamp(Math.round(Number(shellSettings.get('dockIconSize')) || 48), 16, 64);
}

function autohideEnabled() {
  return shellSettings.get('dockAutohide') === true;
}

/**
 * Publish the dock geometry the way `window-chrome.js` reads it: the
 * `--dock-width` custom property plus `data-dock-position` and
 * `data-dock-autohide` on `<html>`. `wm.relayout()` re-runs the work-area
 * calculation afterwards so maximized windows follow the panel.
 */
function applyGeometry() {
  if (!root) return;
  const pos = position();
  const icon = iconSize();
  const panel = icon + 24; // Yaru: a 48px icon inside a 72px panel
  const hidden = autohideEnabled();

  const signature = `${pos}|${panel}|${hidden}`;
  if (signature === lastGeometry) return;
  lastGeometry = signature;

  root.dataset.position = pos;
  root.classList.toggle('dock--autohide', hidden);

  const html = document.documentElement;
  html.dataset.dockPosition = pos;
  html.dataset.dockAutohide = hidden ? 'true' : 'false';

  const css = html.style;
  css.setProperty('--dock-icon-size', `${icon}px`);
  css.setProperty('--dock-width', `${panel}px`);
  css.setProperty('--dock-size', `${panel}px`);
  css.setProperty('--dock-reserved-left', pos === 'left' && !hidden ? `${panel}px` : '0px');
  css.setProperty('--dock-reserved-bottom', pos === 'bottom' && !hidden ? `${panel}px` : '0px');

  // The work area changed, so maximized and tiled windows must follow it.
  if (typeof wm.relayout === 'function') wm.relayout();
}

/* ------------------------------------------------------------------ *
 * pinning
 * ------------------------------------------------------------------ */

function defaultPins() {
  return registeredApps.filter((a) => a && a.pinned && a.id !== 'trash').map((a) => a.id);
}

/** @returns {string[]} the pinned app ids, in dock order */
export function pinnedIds() {
  const stored = shellSettings.get('dockPinned', null);
  if (Array.isArray(stored)) return stored.filter((id) => id !== 'trash');
  return defaultPins();
}

/** @param {string} appId @returns {boolean} */
export function isPinned(appId) {
  return pinnedIds().includes(appId);
}

/** @param {string} appId */
export function pin(appId) {
  if (appId === 'trash' || isPinned(appId)) return;
  shellSettings.set('dockPinned', pinnedIds().concat([appId]));
  scheduleRender();
}

/** @param {string} appId */
export function unpin(appId) {
  if (!isPinned(appId)) return;
  shellSettings.set('dockPinned', pinnedIds().filter((id) => id !== appId));
  scheduleRender();
}

/* ------------------------------------------------------------------ *
 * window state
 * ------------------------------------------------------------------ */

function snapshot() {
  let instances = [];
  try {
    instances = wm.instances() || [];
  } catch (err) {
    console.warn('[dock] wm.instances() failed:', err);
  }
  let activeId = null;
  try {
    activeId = wm.active();
  } catch {
    activeId = null;
  }

  const byApp = new Map();
  const order = [];
  for (const inst of instances) {
    if (!inst || !inst.appId) continue;
    if (!byApp.has(inst.appId)) {
      byApp.set(inst.appId, []);
      order.push(inst.appId);
    }
    byApp.get(inst.appId).push(inst);
  }
  return { byApp, order, activeId: activeId === null || activeId === undefined ? null : String(activeId) };
}

/** Pinned apps followed by any running app that is not pinned. */
function dockApps(state) {
  const out = [];
  const seen = new Set(['trash']);
  for (const id of pinnedIds()) {
    if (seen.has(id)) continue;
    const app = getApp(id);
    if (app) {
      out.push(app);
      seen.add(id);
    }
  }
  for (const id of state.order) {
    if (seen.has(id)) continue;
    const app = getApp(id);
    if (app) {
      out.push(app);
      seen.add(id);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * item construction
 * ------------------------------------------------------------------ */

function appIcon(app) {
  if (typeof app.icon === 'function') {
    try {
      const produced = app.icon();
      if (produced instanceof Node) return produced;
    } catch (err) {
      console.warn(`[dock] icon factory for "${app.id}" threw:`, err);
    }
  }
  if (app.icon instanceof Node) return app.icon;
  return h('span.dock__icon-fallback', { text: String(app.name || app.id || '?').slice(0, 1).toUpperCase() });
}

function buildItem({ id, name, iconNode, count, active, badge, onActivate, onMenu }) {
  const button = h('button.dock__item', {
    type: 'button',
    dataset: { appId: id, count: String(count) },
    'aria-label': name,
    'aria-pressed': active ? 'true' : 'false',
    class: [count > 0 ? 'dock__item--running' : null, active ? 'dock__item--active' : null],
  });

  button.appendChild(h('span.dock__icon', { 'aria-hidden': 'true' }, iconNode));

  const dots = h('span.dock__dots', { 'aria-hidden': 'true' });
  for (let i = 0; i < Math.min(count, MAX_DOTS); i += 1) dots.appendChild(h('i.dock__dot'));
  button.appendChild(dots);
  button.appendChild(h('span.dock__bar', { 'aria-hidden': 'true' }));

  if (badge && badge > 0) {
    button.appendChild(h('span.dock__badge', { text: badge > 99 ? '99+' : String(badge) }));
  }

  button.appendChild(h('span.dock__tooltip', { role: 'tooltip' }, h('span.dock__tooltip-text', { text: name })));

  button.addEventListener('click', (ev) => {
    ev.preventDefault();
    onActivate(ev, button);
  });
  button.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onMenu(ev, button);
  });
  button.addEventListener('auxclick', (ev) => {
    // Middle click always opens a fresh window, like GNOME.
    if (ev.button !== 1) return;
    ev.preventDefault();
    wm.open(id);
  });

  return button;
}

/** Where a menu anchored to `button` should appear, given the dock edge. */
function anchorFor(button) {
  const rect = button.getBoundingClientRect();
  const dockRect = root.getBoundingClientRect();
  if (position() === 'bottom') return { x: rect.left, y: dockRect.top - 6 };
  return { x: dockRect.right + 6, y: rect.top - 6 };
}

function openDockMenu(button, items) {
  const { x, y } = anchorFor(button);
  // openContextMenu() closes any previous menu first, which fires that menu's
  // onClose — so the flag is raised only once the new menu is really up.
  openContextMenu(x, y, items, {
    dark: true,
    minWidth: 210,
    onClose: () => {
      menuOpen = false;
      if (autohideEnabled()) scheduleHide();
    },
  });
  menuOpen = true;
}

function focusInstance(inst) {
  if (inst.minimized) wm.restore(inst.id);
  wm.focus(inst.id);
}

function windowItems(app, instances, activeId) {
  return instances.map((inst) => ({
    label: inst.title || app.name,
    checked: String(inst.id) === activeId,
    onClick: () => focusInstance(inst),
  }));
}

function activateApp(app, instances, activeId, button) {
  if (instances.length === 0) {
    wm.open(app.id);
    return;
  }
  if (instances.length === 1) {
    const inst = instances[0];
    if (inst.minimized) focusInstance(inst);
    else if (String(inst.id) === activeId) wm.minimize(inst.id);
    else wm.focus(inst.id);
    return;
  }
  openDockMenu(button, [
    { header: true, label: app.name },
    ...windowItems(app, instances, activeId),
  ]);
}

function appMenuItems(app, instances, activeId) {
  const items = [
    { header: true, label: app.name },
    {
      label: 'New Window',
      icon: MENU_ICON.newWindow[0],
      accel: app.id === 'terminal' ? 'Ctrl+Alt+T' : '',
      onClick: () => wm.open(app.id),
    },
  ];

  if (instances.length > 0) {
    items.push({ separator: true });
    items.push(...windowItems(app, instances, activeId));
  }

  items.push({ separator: true });
  const pinned = isPinned(app.id);
  items.push({
    label: pinned ? 'Unpin from Dash' : 'Pin to Dash',
    icon: pinned ? MENU_ICON.unpin[0] : MENU_ICON.pin[0],
    onClick: () => (pinned ? unpin(app.id) : pin(app.id)),
  });
  items.push({
    label: instances.length > 1 ? `Quit ${instances.length} Windows` : 'Quit',
    icon: MENU_ICON.quit[0],
    accel: instances.length > 0 ? 'Alt+F4' : '',
    disabled: instances.length === 0,
    onClick: () => {
      for (const inst of instances.slice()) wm.close(inst.id);
    },
  });
  return items;
}

/* ------------------------------------------------------------------ *
 * trash
 * ------------------------------------------------------------------ */

function trashCount() {
  try {
    return fs.listTrash().length;
  } catch (err) {
    console.warn('[dock] fs.listTrash() failed:', err);
    return 0;
  }
}

async function emptyTrash() {
  const count = trashCount();
  if (count === 0) return;
  const ok = await dialog.confirm({
    title: 'Empty all items from Trash?',
    body: 'All items in the Trash will be permanently deleted.',
    okLabel: 'Empty Trash',
    destructive: true,
  });
  if (!ok) return;
  try {
    fs.emptyTrash();
  } catch (err) {
    console.error('[dock] emptying the trash failed:', err);
  }
  updateTrashBadge();
}

function updateTrashBadge() {
  if (!trashButton) return;
  const count = trashCount();
  trashButton.dataset.count = String(count);
  trashButton.classList.toggle('dock__item--running', count > 0);
  if (!trashBadge) return;
  if (count > 0) {
    trashBadge.textContent = count > 99 ? '99+' : String(count);
    trashBadge.hidden = false;
  } else {
    trashBadge.textContent = '';
    trashBadge.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

function render() {
  if (!root || !listEl) return;
  frameHandle = 0;

  const state = snapshot();
  clear(listEl);

  for (const app of dockApps(state)) {
    const instances = state.byApp.get(app.id) || [];
    const active = instances.some((i) => String(i.id) === state.activeId);
    listEl.appendChild(buildItem({
      id: app.id,
      name: app.name || app.id,
      iconNode: appIcon(app),
      count: instances.length,
      active,
      onActivate: (ev, button) => activateApp(app, instances, state.activeId, button),
      onMenu: (ev, button) => openDockMenu(button, appMenuItems(app, instances, state.activeId)),
    }));
  }

  applyGeometry();
}

/** Queue a re-render on the next animation frame (coalesces bursts of events). */
export function scheduleRender() {
  if (frameHandle || !root) return;
  frameHandle = requestAnimationFrame(render);
}

/* ------------------------------------------------------------------ *
 * autohide
 * ------------------------------------------------------------------ */

function setRevealed(next) {
  if (revealed === next) return;
  revealed = next;
  if (root) root.classList.toggle('dock--revealed', next);
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = 0;
    if (!autohideEnabled() || menuOpen) return;
    setRevealed(false);
  }, HIDE_DELAY);
}

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

function onPointerMove(ev) {
  if (!root || !autohideEnabled()) return;

  const pos = position();
  const atEdge = pos === 'bottom'
    ? ev.clientY >= window.innerHeight - EDGE_REVEAL
    : ev.clientX <= EDGE_REVEAL;

  if (atEdge) {
    cancelHide();
    setRevealed(true);
    return;
  }
  if (!revealed || menuOpen) return;

  const rect = root.getBoundingClientRect();
  const inside =
    ev.clientX >= rect.left - 2 && ev.clientX <= rect.right + 2 &&
    ev.clientY >= rect.top - 2 && ev.clientY <= rect.bottom + 2;
  if (inside) cancelHide();
  else scheduleHide();
}

function applyAutohide() {
  if (!root) return;
  const enabled = autohideEnabled();
  root.classList.toggle('dock--autohide', enabled);
  document.removeEventListener('mousemove', onPointerMove);
  cancelHide();
  if (enabled) {
    document.addEventListener('mousemove', onPointerMove);
    setRevealed(false);
  } else {
    setRevealed(true);
  }
  applyGeometry();
}

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

/**
 * Build the dock and wire it to the bus. Safe to call more than once.
 * @returns {HTMLElement} the dock element
 */
export function install() {
  if (root && root.isConnected) {
    scheduleRender();
    return root;
  }

  root = h('nav.dock', { id: 'dock', 'aria-label': 'Dock', dataset: { position: 'left' } });
  listEl = h('div.dock__apps', { role: 'list' });

  trashBadge = h('span.dock__badge', { hidden: true });
  trashButton = h('button.dock__item.dock__item--trash', {
    type: 'button',
    dataset: { appId: 'trash', count: '0' },
    'aria-label': 'Trash',
  },
  h('span.dock__icon', { 'aria-hidden': 'true' }, shellIcons.trash()),
  trashBadge,
  h('span.dock__tooltip', { role: 'tooltip' }, h('span.dock__tooltip-text', { text: 'Trash' })));

  trashButton.addEventListener('click', (ev) => {
    ev.preventDefault();
    wm.open('trash');
  });
  trashButton.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const count = trashCount();
    openDockMenu(trashButton, [
      { header: true, label: 'Trash' },
      { label: 'Open', icon: MENU_ICON.open[0], onClick: () => wm.open('trash') },
      { separator: true },
      {
        label: 'Empty Trash…',
        icon: MENU_ICON.empty[0],
        disabled: count === 0,
        onClick: () => { emptyTrash(); },
      },
    ]);
  });

  const showApps = h('button.dock__item.dock__item--apps', {
    type: 'button',
    'aria-label': 'Show Applications',
  },
  h('span.dock__icon', { 'aria-hidden': 'true' }, svg(MENU_ICON.apps, { size: 22, strokeWidth: 1.7 })),
  h('span.dock__tooltip', { role: 'tooltip' }, h('span.dock__tooltip-text', { text: 'Show Applications' })));
  showApps.addEventListener('click', (ev) => {
    ev.preventDefault();
    overview.toggleAppGrid();
  });

  root.appendChild(h('div.dock__inner', {},
    listEl,
    h('div.dock__spacer'),
    h('div.dock__separator', { 'aria-hidden': 'true' }),
    h('div.dock__pinned', {}, trashButton, showApps)));

  document.body.appendChild(root);

  root.addEventListener('mouseenter', cancelHide);
  root.addEventListener('mouseleave', () => {
    if (autohideEnabled()) scheduleHide();
  });
  root.addEventListener('contextmenu', (ev) => ev.preventDefault());

  if (!installed) {
    installed = true;
    for (const event of ['win:open', 'win:close', 'win:focus', 'win:minimize', 'win:restore', 'win:maximize', 'win:unmaximize']) {
      bus.on(event, scheduleRender);
    }
    bus.on('fs:trash', updateTrashBadge);
    bus.on('fs:change', (payload) => {
      if (!payload) return;
      if (payload.op === 'unlink' || payload.op === 'restore' || payload.op === 'rmdir') updateTrashBadge();
    });
    bus.on('settings:change', (payload) => {
      if (!payload) return;
      if (payload.key === 'dockAutohide') applyAutohide();
      else if (payload.key === 'dockPosition' || payload.key === 'dockIconSize') {
        applyGeometry();
        scheduleRender();
      } else if (payload.key === 'dockPinned') scheduleRender();
      else if (payload.key === 'accent') scheduleRender();
    });
    window.addEventListener('resize', applyGeometry);
  }

  applyGeometry();
  applyAutohide();
  render();
  updateTrashBadge();
  return root;
}

/** Alias so `main.js` can import every shell installer side by side. */
export const installDock = install;

/** Grouped handle for main.js, Settings and the keybindings module. */
export const dock = {
  install,
  refresh: scheduleRender,
  pin,
  unpin,
  isPinned,
  pinnedIds,
  /** @returns {HTMLElement|null} */
  get element() {
    return root;
  },
  /** Force the dock into view (used by the reveal shortcut and the overview). */
  reveal() {
    cancelHide();
    setRevealed(true);
  },
  /** Allow autohide to take the dock away again. */
  unreveal() {
    if (autohideEnabled()) scheduleHide();
  },
  /** @returns {number} items currently in the trash */
  trashCount,
  emptyTrash,
};
