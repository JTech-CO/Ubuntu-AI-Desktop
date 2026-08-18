/**
 * js/shell/window-chrome.js — window frame construction + screen geometry.
 *
 * Sibling of `window-manager.js` (ARCHITECTURE §14). This module owns the
 * *shape* of a window — the header bar, the three GNOME controls, the eight
 * resize handles — plus every calculation that depends on the shell layout
 * (work area, clamping, the dock icon a minimising window flies towards).
 * `window-manager.js` owns the behaviour.
 *
 * Nothing here touches `innerHTML`; every glyph is a stroked SVG built by
 * `core/dom.js`.
 */

import { h, svg, clear } from '../core/dom.js';
import { bus } from '../core/bus.js';

/** Resize handle directions, in the order they are appended to the frame. */
export const HANDLE_DIRS = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

/** Header bar height. Mirrors `--win-header-height` in css/shell/window.css. */
export const HEADER_HEIGHT = 38;

/** How much of a window must stay inside the viewport when dragged. */
export const MIN_VISIBLE = 96;

const DEFAULT_TOP_BAR = 32;
const DEFAULT_DOCK = 72;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** @type {{x:number,y:number,w:number,h:number,topBar:number,dock:number,dockPosition:string}|null} */
let areaCache = null;

/** Drop the cached work area; recomputed lazily on the next `workArea()`. */
export function invalidateWorkArea() {
  areaCache = null;
}

window.addEventListener('resize', invalidateWorkArea);
bus.on('settings:change', invalidateWorkArea);

/**
 * Read a length-valued custom property off `:root`.
 * @param {string} name e.g. `--top-bar-height`
 * @param {number} fallback used when the property is absent or unparseable
 * @returns {number} pixels
 */
export function readPx(name, fallback) {
  let raw = '';
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (err) {
    return fallback;
  }
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  if (raw.endsWith('rem') || raw.endsWith('em')) return value * 16;
  return value;
}

/**
 * Viewport size. `innerWidth`/`innerHeight` read 0 in a few embedding and
 * print contexts, so the layout box is used as a second opinion before a
 * final sane default — a work area of zero would collapse every window.
 * @returns {{w:number,h:number}}
 */
export function viewport() {
  const w = window.innerWidth || document.documentElement.clientWidth || 1280;
  const h = window.innerHeight || document.documentElement.clientHeight || 800;
  return { w, h };
}

/**
 * The usable desktop rectangle: below the top bar and clear of the dock.
 * Honours `data-dock-position` (`left` | `right` | `bottom`) and
 * `data-dock-autohide` on `<html>` when the Settings app sets them.
 * @returns {{x:number,y:number,w:number,h:number,topBar:number,dock:number,dockPosition:string}}
 */
export function workArea() {
  if (areaCache) return { ...areaCache };

  const topBar = readPx('--top-bar-height', DEFAULT_TOP_BAR);
  const root = document.documentElement;
  const autohide = root.dataset.dockAutohide === 'true';
  const dock = autohide ? 0 : readPx('--dock-width', DEFAULT_DOCK);
  const position = root.dataset.dockPosition || 'left';

  const { w: vw, h: vh } = viewport();

  let x = 0;
  let w = vw;
  let hh = vh - topBar;

  if (position === 'bottom') {
    hh -= dock;
  } else if (position === 'right') {
    w -= dock;
  } else {
    x = dock;
    w -= dock;
  }

  areaCache = {
    x: Math.round(x),
    y: Math.round(topBar),
    w: Math.max(240, Math.round(w)),
    h: Math.max(180, Math.round(hh)),
    topBar: Math.round(topBar),
    dock: Math.round(dock),
    dockPosition: position,
  };
  return { ...areaCache };
}

/**
 * Keep a window on screen: its header may never slide under the top bar and
 * at least `MIN_VISIBLE` pixels must remain grabbable horizontally.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {{x:number,y:number,w:number,h:number}} [area]
 * @returns {{x:number,y:number,w:number,h:number}} a new, rounded rect
 */
export function clampRect(rect, area = workArea()) {
  const { w: vw, h: vh } = viewport();

  const w = Math.max(1, Math.round(rect.w));
  const hh = Math.max(1, Math.round(rect.h));

  const minX = Math.round(MIN_VISIBLE - w);
  const maxX = Math.round(vw - MIN_VISIBLE);
  const minY = area.y;
  const maxY = Math.max(area.y, Math.round(vh - HEADER_HEIGHT));

  let x = Math.round(rect.x);
  let y = Math.round(rect.y);
  if (x < minX) x = minX;
  if (x > maxX) x = maxX;
  if (y < minY) y = minY;
  if (y > maxY) y = maxY;

  return { x, y, w, h: hh };
}

/**
 * Write a rectangle onto a window element.
 * @param {HTMLElement} win
 * @param {{x:number,y:number,w:number,h:number}} rect
 */
export function applyRect(win, rect) {
  win.style.left = `${Math.round(rect.x)}px`;
  win.style.top = `${Math.round(rect.y)}px`;
  win.style.width = `${Math.round(rect.w)}px`;
  win.style.height = `${Math.round(rect.h)}px`;
}

/**
 * Half of the work area, for Super+Left / Super+Right tiling.
 * @param {'left'|'right'} side
 * @param {{x:number,y:number,w:number,h:number}} [area]
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function halfRect(side, area = workArea()) {
  const w = Math.round(area.w / 2);
  return {
    x: side === 'right' ? area.x + (area.w - w) : area.x,
    y: area.y,
    w,
    h: area.h,
  };
}

/**
 * Locate the dock icon a window should fly towards when minimised.
 * The dock module owns its own markup, so several plausible hooks are tried
 * before falling back to the dock's leading edge.
 * @param {string} appId
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function dockIconRect(appId) {
  const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(String(appId))
    : String(appId).replace(/["\\]/g, '\\$&');

  const selectors = [
    `.dock [data-app-id="${safe}"]`,
    `.dock [data-app="${safe}"]`,
    `#dock [data-app-id="${safe}"]`,
    `[data-dock-app="${safe}"]`,
    `.dock__item[data-id="${safe}"]`,
  ];

  for (const sel of selectors) {
    let node = null;
    try {
      node = document.querySelector(sel);
    } catch (err) {
      node = null;
    }
    if (node) {
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
  }

  const area = workArea();
  const view = viewport();
  const size = 48;
  if (area.dockPosition === 'bottom') {
    return { x: Math.round(view.w / 2 - size / 2), y: view.h - size - 8, w: size, h: size };
  }
  if (area.dockPosition === 'right') {
    return { x: view.w - size - 8, y: Math.round(view.h / 2), w: size, h: size };
  }
  return { x: 8, y: Math.round(view.h / 2), w: size, h: size };
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

const ICONS = {
  minimize: ['M3.75 11.25h8.5'],
  maximize: ['M4.25 4.25h7.5v7.5h-7.5z'],
  restore: ['M6 4.25h5.75V10', 'M4.25 6.5h5.5v5.25h-5.5z'],
  close: ['M4.25 4.25l7.5 7.5', 'M11.75 4.25l-7.5 7.5'],
};

/**
 * @param {'minimize'|'maximize'|'restore'|'close'} name
 * @returns {SVGElement}
 */
function makeIcon(name) {
  return svg(ICONS[name], {
    size: 16,
    viewBox: '0 0 16 16',
    strokeWidth: 1.5,
    class: 'window__icon',
  });
}

/**
 * @param {'minimize'|'maximize'|'close'} kind
 * @param {string} label
 * @param {string} iconName
 * @returns {HTMLElement}
 */
function controlButton(kind, label, iconName) {
  const face = h('span.window__button-face', {}, makeIcon(iconName));
  return h(
    `button.window__button.window__button--${kind}`,
    {
      type: 'button',
      title: label,
      'aria-label': label,
      dataset: { control: kind },
    },
    face,
  );
}

/**
 * Swap the maximize control between its "maximize" and "restore" states.
 * @param {HTMLElement|null} btn
 * @param {boolean} maximized
 */
export function setMaximizeState(btn, maximized) {
  if (!btn) return;
  const face = btn.querySelector('.window__button-face');
  if (!face) return;
  clear(face);
  face.appendChild(makeIcon(maximized ? 'restore' : 'maximize'));
  const label = maximized ? 'Restore' : 'Maximize';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/**
 * Build a complete, unattached window frame.
 *
 * @param {object} app app definition (ARCHITECTURE §16)
 * @param {string} instanceId
 * @returns {{
 *   win: HTMLElement, header: HTMLElement, titleEl: HTMLElement,
 *   content: HTMLElement, controls: HTMLElement,
 *   btnMinimize: HTMLElement, btnMaximize: HTMLElement|null,
 *   btnClose: HTMLElement, handles: HTMLElement[]
 * }}
 */
export function buildFrame(app, instanceId) {
  const resizable = app.resizable !== false;
  const title = app.name || app.id;

  const titleEl = h('div.window__title', { text: title });

  const btnMinimize = controlButton('minimize', 'Minimize', 'minimize');
  const btnMaximize = resizable ? controlButton('maximize', 'Maximize', 'maximize') : null;
  const btnClose = controlButton('close', 'Close', 'close');

  const controls = h(
    'div.window__controls',
    {},
    btnMinimize,
    btnMaximize,
    btnClose,
  );

  const header = h('div.window__header', {}, titleEl, controls);
  const content = h('div.window__content', { dataset: { role: 'content' } });

  const handles = resizable
    ? HANDLE_DIRS.map((dir) =>
        h(`div.window__handle.window__handle--${dir}`, { dataset: { dir }, 'aria-hidden': 'true' }),
      )
    : [];

  const win = h('div.window', {
    dataset: { appId: app.id, instanceId },
    tabindex: '-1',
    'aria-label': title,
  });

  win.classList.add(app.darkChrome === true ? 'window--dark' : 'window--light');
  if (app.themeClass) {
    for (const cls of String(app.themeClass).split(/\s+/).filter(Boolean)) win.classList.add(cls);
  }
  if (!resizable) win.classList.add('window--fixed-size');

  win.appendChild(header);
  win.appendChild(content);
  for (const handle of handles) win.appendChild(handle);

  return { win, header, titleEl, content, controls, btnMinimize, btnMaximize, btnClose, handles };
}

/**
 * The translucent tile/maximize preview shown while dragging.
 * @returns {HTMLElement}
 */
export function buildSnapPreview() {
  return h('div.snap-preview', { 'aria-hidden': 'true' });
}
