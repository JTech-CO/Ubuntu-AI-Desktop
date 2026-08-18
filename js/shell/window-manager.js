/**
 * js/shell/window-manager.js — GNOME 46 / Mutter-style window manager.
 *
 * ARCHITECTURE §14. Windows are built dynamically from `window-chrome.js`;
 * there is no per-app window markup in index.html. One instance record per
 * open window holds its geometry, its process id, its app hooks and the list
 * of listener teardowns that run when it closes — nothing leaks.
 *
 * Split across four files in this folder:
 *   window-chrome.js       frame DOM + screen geometry
 *   window-interaction.js  header drag, edge snapping, resize handles
 *   window-instance.js     instance records, `ctx`, cascade, process spawn
 *   window-manager.js      lifecycle, focus stack, tiling, the `wm` API
 */

import { on } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { procs } from '../core/procs.js';
import {
  buildFrame,
  workArea,
  invalidateWorkArea,
  clampRect,
  applyRect,
  halfRect,
  dockIconRect,
  setMaximizeState,
} from './window-chrome.js';
import { installInteractions, beginDrag, beginResize, hidePreview } from './window-interaction.js';
import {
  createInstance,
  cascadeRect,
  initialSize,
  onceAnimationEnd,
  callHook,
  publicView,
} from './window-instance.js';

/** Base stacking index; every focus bumps `zTop` past it. */
const Z_BASE = 10;

/** @type {Map<string, object>} appId -> app definition */
const registry = new Map();

/** @type {Map<string, object>} instanceId -> instance record */
const live = new Map();

/** Instance ids, most recently focused first. */
let focusOrder = [];

let zTop = Z_BASE;
let instanceCounter = 0;
let cascadeCounter = 0;
let activeId = null;
let layerEl = null;
let desktopShown = false;

/* ------------------------------------------------------------------ *
 * Layer
 * ------------------------------------------------------------------ */

/** The absolutely positioned host for every window, created on demand. */
function ensureLayer() {
  if (layerEl && layerEl.isConnected) return layerEl;
  layerEl =
    document.querySelector('.window-layer') ||
    document.querySelector('#window-layer') ||
    document.querySelector('#windows-container');
  if (!layerEl) {
    layerEl = document.createElement('div');
    layerEl.className = 'window-layer';
    document.body.appendChild(layerEl);
  } else {
    layerEl.classList.add('window-layer');
  }
  return layerEl;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Resolve an instanceId — or an appId, which maps to that app's most recently
 * focused window — to a single instance record.
 * @param {string} id
 * @returns {object|null}
 */
function resolve(id) {
  if (!id) return null;
  const key = String(id);
  const direct = live.get(key);
  if (direct) return direct;
  for (const instanceId of focusOrder) {
    const inst = live.get(instanceId);
    if (inst && inst.appId === key) return inst;
  }
  for (const inst of live.values()) {
    if (inst.appId === key) return inst;
  }
  return null;
}

/** Every open window, most recently focused first. */
function orderedInstances() {
  const out = [];
  for (const id of focusOrder) {
    const inst = live.get(id);
    if (inst && !inst.closing) out.push(inst);
  }
  for (const inst of live.values()) {
    if (!inst.closing && !out.includes(inst)) out.push(inst);
  }
  return out;
}

function promote(id) {
  focusOrder = focusOrder.filter((entry) => entry !== id);
  focusOrder.unshift(id);
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function setRect(inst, rect) {
  inst.rect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  };
  applyRect(inst.win, inst.rect);
}

/** Remember the geometry a maximized or tiled window falls back to. */
function rememberRestore(inst) {
  if (!inst.restoreRect) inst.restoreRect = { ...inst.rect };
}

/**
 * Leave the maximized/tiled state for an explicit rectangle.
 * @param {object} inst
 * @param {{x:number,y:number,w:number,h:number}} [rect]
 */
function unmaximizeInternal(inst, rect) {
  const wasSnapped = inst.maximized || inst.tiled;
  const area = workArea();
  const target = rect || inst.restoreRect || {
    x: area.x + 64,
    y: area.y + 48,
    w: Math.round(area.w * 0.66),
    h: Math.round(area.h * 0.66),
  };

  inst.maximized = false;
  inst.tiled = null;
  inst.restoreRect = null;
  inst.win.classList.remove('window--maximized', 'window--tiled', 'window--tiled-left', 'window--tiled-right');
  setMaximizeState(inst.btnMaximize, false);
  setRect(inst, clampRect(target, area));

  if (wasSnapped) bus.emit('win:unmaximize', { appId: inst.appId, instanceId: inst.id });
}

/* ------------------------------------------------------------------ *
 * Focus
 * ------------------------------------------------------------------ */

function blurInstance(inst) {
  if (!inst) return;
  inst.win.classList.remove('window--focused');
  callHook(inst, 'onBlur');
}

/** Raise, mark focused, fire `onFocus` and emit `win:focus`. */
function focusInternal(inst) {
  if (!inst || inst.closing) return false;

  zTop += 1;
  inst.win.style.zIndex = String(zTop);
  promote(inst.id);

  if (activeId === inst.id && inst.win.classList.contains('window--focused')) return true;

  const previous = activeId && activeId !== inst.id ? live.get(activeId) : null;
  if (previous) blurInstance(previous);

  activeId = inst.id;
  inst.win.classList.add('window--focused');
  desktopShown = false;
  callHook(inst, 'onFocus');
  bus.emit('win:focus', { appId: inst.appId, instanceId: inst.id });
  return true;
}

/** Give focus to the topmost window that is still visible. */
function focusNextVisible() {
  for (const inst of orderedInstances()) {
    if (!inst.minimized) {
      focusInternal(inst);
      return;
    }
  }
  if (activeId) {
    const previous = live.get(activeId);
    if (previous) blurInstance(previous);
  }
  activeId = null;
}

/* ------------------------------------------------------------------ *
 * Minimize flight path
 * ------------------------------------------------------------------ */

/**
 * Point the minimize/restore keyframes at this window's dock icon by writing
 * the translation and scale the animation interpolates towards.
 * @param {object} inst
 */
function setFlightVars(inst) {
  const target = dockIconRect(inst.appId);
  const rect = inst.rect;
  const tx = target.x + target.w / 2 - (rect.x + rect.w / 2);
  const ty = target.y + target.h / 2 - (rect.y + rect.h / 2);
  const scale = Math.max(0.04, Math.min(0.3, target.w / Math.max(1, rect.w)));
  inst.win.style.setProperty('--wm-fly-x', `${Math.round(tx)}px`);
  inst.win.style.setProperty('--wm-fly-y', `${Math.round(ty)}px`);
  inst.win.style.setProperty('--wm-fly-scale', String(Math.round(scale * 1000) / 1000));
}

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

function destroy(inst) {
  // A window closed mid-drag (Alt+F4, an app closing itself) must not leave
  // the document-level drag state behind.
  if (inst.drag) {
    inst.drag = null;
    document.documentElement.classList.remove('wm-dragging');
    hidePreview();
  }

  for (const off of inst.cleanups) {
    try {
      off();
    } catch (err) {
      console.error('[wm] listener teardown threw:', err);
    }
  }
  inst.cleanups.length = 0;

  if (inst.observer) {
    inst.observer.disconnect();
    inst.observer = null;
  }

  live.delete(inst.id);
  focusOrder = focusOrder.filter((id) => id !== inst.id);
  if (activeId === inst.id) activeId = null;

  const win = inst.win;
  win.classList.remove('window--focused');
  win.classList.add('window--closing');
  win.style.pointerEvents = 'none';
  onceAnimationEnd(win, () => {
    if (win.isConnected) win.remove();
  });

  bus.emit('win:close', { appId: inst.appId, instanceId: inst.id });
  if (inst.pid) procs.kill(inst.pid, 15);

  focusNextVisible();
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export const wm = {
  /**
   * Register an app definition (ARCHITECTURE §16). Re-registering an id
   * replaces the previous definition.
   * @param {object} appDef
   * @returns {object} the stored definition
   */
  register(appDef) {
    if (!appDef || typeof appDef !== 'object' || !appDef.id) {
      throw new TypeError('wm.register: appDef requires an `id`');
    }
    if (typeof appDef.mount !== 'function') {
      throw new TypeError(`wm.register: app "${appDef.id}" has no mount(root, ctx)`);
    }
    registry.set(String(appDef.id), appDef);
    return appDef;
  },

  /** @param {string} appId @returns {object|null} the registered definition */
  getApp(appId) {
    return registry.get(String(appId)) || null;
  },

  /** @returns {object[]} every registered app definition */
  registered() {
    return Array.from(registry.values());
  },

  /**
   * Open a window. Singleton apps focus their existing instance instead.
   * @param {string} appId
   * @param {object} [args] forwarded to the app as `ctx.args`
   * @returns {string|null} instanceId, or null when the app is unknown
   */
  open(appId, args = {}) {
    const app = registry.get(String(appId));
    if (!app) {
      console.warn(`[wm] open: no app registered as "${appId}"`);
      return null;
    }

    if (app.singleton === true) {
      const existing = resolve(app.id);
      if (existing) {
        existing.args = args;
        existing.ctx.args = args;
        wm.restore(existing.id);
        return existing.id;
      }
    }

    const layer = ensureLayer();
    instanceCounter += 1;
    const instanceId = `${app.id}-${instanceCounter}`;
    const frame = buildFrame(app, instanceId);
    const area = workArea();
    const size = initialSize(app, area);
    const rect = cascadeRect(size.w, size.h, area, cascadeCounter);
    cascadeCounter += 1;

    const inst = createInstance({ app, instanceId, args, frame, rect, wm });
    const ctx = inst.ctx;
    applyRect(frame.win, rect);
    live.set(instanceId, inst);

    inst.cleanups.push(
      on(frame.win, 'pointerdown', () => focusInternal(inst), true),
      on(frame.header, 'pointerdown', (ev) => beginDrag(inst, ev)),
      on(frame.header, 'dblclick', (ev) => {
        if (ev.target.closest && ev.target.closest('.window__controls')) return;
        if (app.resizable === false) return;
        wm.toggleMaximize(instanceId);
      }),
      on(frame.btnMinimize, 'click', () => wm.minimize(instanceId)),
      on(frame.btnClose, 'click', () => wm.close(instanceId)),
    );
    if (frame.btnMaximize) {
      inst.cleanups.push(on(frame.btnMaximize, 'click', () => wm.toggleMaximize(instanceId)));
    }
    for (const handle of frame.handles) {
      const dir = handle.dataset.dir;
      inst.cleanups.push(on(handle, 'pointerdown', (ev) => beginResize(inst, dir, ev)));
    }

    layer.appendChild(frame.win);

    try {
      app.mount(frame.content, ctx);
    } catch (err) {
      console.error(`[wm] ${app.id}.mount() threw:`, err);
      frame.content.textContent = `Failed to start ${app.name || app.id}: ${err && err.message ? err.message : err}`;
      frame.content.classList.add('window__content--error');
    }

    if (typeof app.onResize === 'function' && typeof ResizeObserver === 'function') {
      inst.observer = new ResizeObserver(() => {
        if (inst.closing || inst.minimized) return;
        callHook(inst, 'onResize');
      });
      inst.observer.observe(frame.content);
    }

    frame.win.classList.add('window--opening');
    onceAnimationEnd(frame.win, () => frame.win.classList.remove('window--opening'));

    focusInternal(inst);
    bus.emit('win:open', { appId: app.id, instanceId });
    return instanceId;
  },

  /**
   * Close a window. `onClose(ctx)` may return `false` to veto.
   * @param {string} id instanceId or appId
   * @returns {boolean} true when the window actually closed
   */
  close(id) {
    const inst = resolve(id);
    if (!inst || inst.closing) return false;
    if (callHook(inst, 'onClose') === false) return false;
    inst.closing = true;
    destroy(inst);
    return true;
  },

  /**
   * Close every window of an app (dock → Quit).
   * @param {string} appId
   * @returns {number} how many closed
   */
  closeApp(appId) {
    const key = String(appId);
    let closed = 0;
    for (const inst of Array.from(live.values())) {
      if (inst.appId === key && wm.close(inst.id)) closed += 1;
    }
    return closed;
  },

  /** Close every window (session end). */
  closeAll() {
    for (const inst of Array.from(live.values())) wm.close(inst.id);
  },

  /**
   * Raise and focus a window, un-minimising it first if needed.
   * @param {string} id instanceId or appId
   * @returns {boolean}
   */
  focus(id) {
    const inst = resolve(id);
    if (!inst) return false;
    if (inst.minimized) return wm.restore(inst.id);
    return focusInternal(inst);
  },

  /**
   * Fly the window towards its dock icon and hide it.
   * @param {string} id
   * @returns {boolean}
   */
  minimize(id) {
    const inst = resolve(id);
    if (!inst || inst.closing || inst.minimized) return false;

    inst.minimized = true;
    setFlightVars(inst);
    if (activeId === inst.id) {
      blurInstance(inst);
      activeId = null;
    } else {
      inst.win.classList.remove('window--focused');
    }

    const win = inst.win;
    win.classList.remove('window--restoring');
    win.classList.add('window--minimizing');
    onceAnimationEnd(win, () => {
      win.classList.remove('window--minimizing');
      if (inst.minimized) win.classList.add('window--hidden');
    });

    bus.emit('win:minimize', { appId: inst.appId, instanceId: inst.id });
    focusNextVisible();
    return true;
  },

  /**
   * Un-minimise (reversing the flight animation) and focus.
   * @param {string} id
   * @returns {boolean}
   */
  restore(id) {
    const inst = resolve(id);
    if (!inst || inst.closing) return false;
    if (!inst.minimized) return focusInternal(inst);

    inst.minimized = false;
    setFlightVars(inst);
    const win = inst.win;
    win.classList.remove('window--hidden', 'window--minimizing');
    win.classList.add('window--restoring');
    onceAnimationEnd(win, () => win.classList.remove('window--restoring'));

    bus.emit('win:restore', { appId: inst.appId, instanceId: inst.id });
    focusInternal(inst);
    return true;
  },

  /**
   * Fill the work area — below the top bar, right of the dock.
   * @param {string} id
   * @returns {boolean}
   */
  maximize(id) {
    const inst = resolve(id);
    if (!inst || inst.closing || inst.app.resizable === false || inst.maximized) return false;

    rememberRestore(inst);
    inst.maximized = true;
    inst.tiled = null;
    const area = workArea();
    inst.win.classList.remove('window--tiled', 'window--tiled-left', 'window--tiled-right');
    inst.win.classList.add('window--maximized');
    setMaximizeState(inst.btnMaximize, true);
    setRect(inst, { x: area.x, y: area.y, w: area.w, h: area.h });
    bus.emit('win:maximize', { appId: inst.appId, instanceId: inst.id });
    return true;
  },

  /**
   * Return a maximized or tiled window to its remembered geometry.
   * @param {string} id
   * @returns {boolean}
   */
  unmaximize(id) {
    const inst = resolve(id);
    if (!inst || inst.closing) return false;
    if (!inst.maximized && !inst.tiled) return false;
    unmaximizeInternal(inst, inst.restoreRect);
    return true;
  },

  /** @param {string} id @returns {boolean} */
  toggleMaximize(id) {
    const inst = resolve(id);
    if (!inst || inst.closing) return false;
    return inst.maximized || inst.tiled ? wm.unmaximize(inst.id) : wm.maximize(inst.id);
  },

  /**
   * Half-tile a window (Super+Left / Super+Right).
   * @param {string} id
   * @param {'left'|'right'} side
   * @returns {boolean}
   */
  tile(id, side) {
    const inst = resolve(id);
    if (!inst || inst.closing || inst.app.resizable === false) return false;
    const edge = side === 'right' ? 'right' : 'left';
    if (inst.tiled === edge) return false;

    rememberRestore(inst);
    const wasMaximized = inst.maximized;
    inst.maximized = false;
    inst.tiled = edge;
    inst.win.classList.remove('window--maximized', 'window--tiled-left', 'window--tiled-right');
    inst.win.classList.add('window--tiled', `window--tiled-${edge}`);
    setMaximizeState(inst.btnMaximize, false);
    setRect(inst, halfRect(edge, workArea()));
    if (wasMaximized) bus.emit('win:unmaximize', { appId: inst.appId, instanceId: inst.id });
    focusInternal(inst);
    return true;
  },

  /** @param {string} appId @returns {boolean} true when the app has a window open */
  isOpen(appId) {
    const key = String(appId);
    for (const inst of live.values()) {
      if (inst.appId === key && !inst.closing) return true;
    }
    return false;
  },

  /**
   * Open windows, most recently focused first.
   * @returns {{id:string, appId:string, title:string, minimized:boolean,
   *            maximized:boolean, tiled:string|null, focused:boolean,
   *            win:HTMLElement, root:HTMLElement}[]}
   */
  instances() {
    return orderedInstances().map((inst) => publicView(inst, activeId));
  },

  /** @param {string} id @returns {object|null} one `instances()` entry */
  get(id) {
    const inst = resolve(id);
    return inst ? publicView(inst, activeId) : null;
  },

  /** @returns {string|null} the focused instanceId */
  active() {
    if (!activeId) return null;
    const inst = live.get(activeId);
    return inst && !inst.minimized ? inst.id : null;
  },

  /** @param {string} id @param {string} title @returns {boolean} */
  setTitle(id, title) {
    const inst = resolve(id);
    if (!inst) return false;
    const text = title === null || title === undefined ? '' : String(title);
    inst.title = text;
    inst.titleEl.textContent = text;
    inst.win.setAttribute('aria-label', text);
    return true;
  },

  /**
   * Alt+Tab, in most-recently-focused order.
   * @param {number} [dir] 1 forwards, -1 backwards
   * @returns {string|null} the newly focused instanceId
   */
  cycle(dir = 1) {
    const order = orderedInstances();
    if (order.length === 0) return null;
    if (order.length === 1) {
      wm.restore(order[0].id);
      return order[0].id;
    }
    const step = dir < 0 ? order.length - 1 : 1;
    const target = order[step % order.length];
    wm.restore(target.id);
    return target.id;
  },

  /**
   * Super+D — minimise everything, or bring it all back.
   * @returns {boolean} true when the toggle did something
   */
  showDesktop() {
    const visible = orderedInstances().filter((inst) => !inst.minimized);
    if (visible.length > 0) {
      for (const id of visible.map((inst) => inst.id)) wm.minimize(id);
      desktopShown = true;
      return true;
    }
    if (!desktopShown) return false;
    const hidden = orderedInstances();
    for (let i = hidden.length - 1; i >= 0; i -= 1) wm.restore(hidden[i].id);
    desktopShown = false;
    return true;
  },

  /** @returns {{x:number,y:number,w:number,h:number}} the current work area */
  workArea() {
    return workArea();
  },

  /** Re-apply every window's layout after the shell chrome changed size. */
  relayout() {
    invalidateWorkArea();
    const area = workArea();
    for (const inst of live.values()) {
      if (inst.closing) continue;
      if (inst.maximized) setRect(inst, { x: area.x, y: area.y, w: area.w, h: area.h });
      else if (inst.tiled) setRect(inst, halfRect(inst.tiled, area));
      else setRect(inst, clampRect(inst.rect, area));
    }
  },
};

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

installInteractions({
  focus: focusInternal,
  setRect,
  unmaximize: unmaximizeInternal,
  commitSnap: (inst, mode) => {
    if (mode === 'max') wm.maximize(inst.id);
    else wm.tile(inst.id, mode);
  },
  nextZ: () => {
    zTop += 1;
    return zTop;
  },
  layer: ensureLayer,
});

window.addEventListener('resize', () => {
  wm.relayout();
});

bus.on('settings:change', (payload) => {
  if (!payload) return;
  if (payload.key === 'dock-position' || payload.key === 'dock-size' || payload.key === 'dock-autohide') {
    wm.relayout();
  }
});

export default wm;
