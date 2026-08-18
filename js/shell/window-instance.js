/**
 * js/shell/window-instance.js — window instance records and their helpers.
 *
 * Sibling of `window-manager.js` (ARCHITECTURE §14). Everything here is
 * either pure or depends only on its arguments, so the manager stays focused
 * on the stacking order, the snap states and the public `wm` API.
 */

import { procs } from '../core/procs.js';
import { clampRect } from './window-chrome.js';

/** Cascade offset applied to each newly opened window. */
export const CASCADE_STEP = 32;
export const CASCADE_SLOTS = 8;

/**
 * Coerce an app-supplied dimension, falling back when it is missing or bad.
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
export function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Run `fn` once the element's own animation ends. `animationend` bubbles, so
 * an animation inside the mounted app would otherwise fire this early; the
 * target check filters those out. The timeout is the safety net for browsers
 * that skip animations entirely (reduced motion, background tabs).
 * @param {HTMLElement} node
 * @param {() => void} fn
 * @param {number} [fallbackMs]
 */
export function onceAnimationEnd(node, fn, fallbackMs = 420) {
  let done = false;
  const finish = (ev) => {
    if (ev && ev.target !== node) return;
    if (done) return;
    done = true;
    node.removeEventListener('animationend', finish);
    window.clearTimeout(timer);
    fn();
  };
  const timer = window.setTimeout(finish, fallbackMs);
  node.addEventListener('animationend', finish);
}

/**
 * Invoke an app hook defensively — a throwing app must not break the shell.
 * @param {object} inst
 * @param {'onFocus'|'onBlur'|'onResize'|'onClose'} name
 * @returns {any} the hook's return value, or undefined
 */
export function callHook(inst, name) {
  const fn = inst.app && inst.app[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return fn.call(inst.app, inst.ctx);
  } catch (err) {
    console.error(`[wm] ${inst.appId}.${name}() threw:`, err);
    return undefined;
  }
}

/**
 * The outward-facing shape of an instance (`wm.instances()`, `wm.get()`).
 * @param {object} inst
 * @param {string|null} activeId
 * @returns {{id:string, appId:string, title:string, minimized:boolean,
 *            maximized:boolean, tiled:string|null, focused:boolean,
 *            win:HTMLElement, root:HTMLElement}}
 */
export function publicView(inst, activeId) {
  return {
    id: inst.id,
    appId: inst.appId,
    title: inst.title,
    minimized: inst.minimized,
    maximized: inst.maximized,
    tiled: inst.tiled,
    focused: activeId === inst.id && !inst.minimized,
    win: inst.win,
    root: inst.content,
  };
}

/**
 * The size a window opens at: the app's preference, clamped to its own
 * minimums and to the work area.
 * @param {object} app
 * @param {{w:number,h:number}} area
 * @returns {{w:number,h:number}}
 */
export function initialSize(app, area) {
  const minW = num(app.minWidth, 320);
  const minH = num(app.minHeight, 200);
  return {
    w: Math.min(Math.max(num(app.width, 820), minW), Math.max(minW, area.w - 32), area.w),
    h: Math.min(Math.max(num(app.height, 560), minH), Math.max(minH, area.h - 32), area.h),
  };
}

/**
 * Deterministic opening position: each window steps 32px down-right from the
 * centre of the work area and wraps after `CASCADE_SLOTS` — never random.
 * @param {number} w
 * @param {number} h
 * @param {{x:number,y:number,w:number,h:number}} area
 * @param {number} counter monotonically increasing open count
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function cascadeRect(w, h, area, counter) {
  const availX = Math.max(0, area.w - w);
  const availY = Math.max(0, area.h - h);
  const slots = Math.max(
    1,
    Math.min(CASCADE_SLOTS, Math.floor(Math.min(availX, availY) / CASCADE_STEP) + 1),
  );
  const slot = counter % slots;
  const band = ((slots - 1) * CASCADE_STEP) / 2;

  return clampRect(
    {
      x: area.x + Math.round(availX / 2 - band) + slot * CASCADE_STEP,
      y: area.y + Math.round(availY / 2 - band) + slot * CASCADE_STEP,
      w,
      h,
    },
    area,
  );
}

/**
 * Register the app's simulated process and tie it to the window, so closing
 * the window reaps it (`core/procs.js` listens for `win:close`). An app may
 * override the defaults with a `proc: { name, cmd, cpu, mem, ppid }` field.
 * @param {object} app
 * @param {string} instanceId
 * @returns {number} pid
 */
export function spawnFor(app, instanceId) {
  const spec = app.proc && typeof app.proc === 'object' ? app.proc : {};
  const pid = procs.spawn({
    name: spec.name || app.procName || app.id,
    cmd: spec.cmd || app.procCmd || `/usr/bin/${app.id}`,
    user: spec.user || 'ubuntu',
    cpu: Number.isFinite(spec.cpu) ? spec.cpu : 0.6,
    mem: Number.isFinite(spec.mem) ? spec.mem : 92,
    // Parented to gnome-shell (pid 1387), like a real GNOME session launcher.
    ppid: Number.isFinite(spec.ppid) ? spec.ppid : 1387,
  });
  procs.bindWindow(instanceId, pid);
  return pid;
}

/**
 * Build the instance record and the `ctx` object handed to every app hook
 * (ARCHITECTURE §16). The process is spawned here so `ctx.pid` is already
 * valid when `mount(root, ctx)` runs.
 *
 * @param {{app:object, instanceId:string, args:object, frame:object,
 *          rect:{x:number,y:number,w:number,h:number}, wm:object}} spec
 * @returns {object} the instance record, with `.ctx` populated
 */
export function createInstance({ app, instanceId, args, frame, rect, wm }) {
  const inst = {
    id: instanceId,
    appId: app.id,
    app,
    args,
    title: app.name || app.id,
    win: frame.win,
    header: frame.header,
    titleEl: frame.titleEl,
    content: frame.content,
    btnMaximize: frame.btnMaximize,
    rect,
    restoreRect: null,
    minimized: false,
    maximized: false,
    tiled: null,
    closing: false,
    drag: null,
    pid: 0,
    observer: null,
    cleanups: [],
    ctx: null,
  };

  const ctx = {
    instanceId,
    appId: app.id,
    args,
    win: frame.win,
    root: frame.content,
    pid: 0,
    setTitle: (t) => wm.setTitle(instanceId, t),
    close: () => wm.close(instanceId),
    minimize: () => wm.minimize(instanceId),
    maximize: () => wm.maximize(instanceId),
    unmaximize: () => wm.unmaximize(instanceId),
    toggleMaximize: () => wm.toggleMaximize(instanceId),
    restore: () => wm.restore(instanceId),
    focus: () => wm.focus(instanceId),
  };

  const pid = spawnFor(app, instanceId);
  inst.pid = pid;
  ctx.pid = pid;
  inst.ctx = ctx;
  return inst;
}
