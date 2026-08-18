/**
 * js/shell/context-menu.js — reusable Adwaita popover menu (ARCHITECTURE §15).
 *
 * Public API:
 *   openMenu(x, y, items, opts)  -> HTMLElement (the root menu level)
 *   closeMenu()
 *   isMenuOpen()
 *
 * Item shape:
 *   { label, icon, accel, disabled, separator, checked, onClick, submenu }
 *
 * `icon` may be an Element, a factory returning an Element, an SVG path string
 * (`'M4 6h16…'`) or a short text glyph. `submenu` is a nested item array (or a
 * function returning one, evaluated lazily when the submenu opens).
 *
 * Every label/accel is written with `textContent`; nothing here touches
 * `innerHTML`.
 */

import { h, svg } from '../core/dom.js';

const SUBMENU_OPEN_DELAY = 240;
const SUBMENU_CLOSE_DELAY = 150;
const EDGE_GAP = 8;

/** Looks like SVG path data rather than a text glyph. */
const PATH_RE = /^[Mm]\s*-?[\d.]/;

/**
 * Open menu levels, root first. Each level owns its own DOM element.
 * @type {{el: HTMLElement, buttons: HTMLElement[], anchor: HTMLElement|null, dark: boolean}[]}
 */
const levels = [];

let hoverTimer = 0;
let documentBound = false;
let restoreFocus = null;
let closedCallback = null;

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function cancelHoverTimer() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = 0;
  }
}

function buildIcon(icon) {
  const slot = h('span.ctx-item__icon', { 'aria-hidden': 'true' });
  if (icon === null || icon === undefined || icon === '') return slot;

  if (icon instanceof Node) {
    slot.appendChild(icon);
    return slot;
  }
  if (typeof icon === 'function') {
    try {
      const produced = icon();
      if (produced instanceof Node) slot.appendChild(produced);
    } catch (err) {
      console.warn('[context-menu] icon factory threw:', err);
    }
    return slot;
  }
  const str = String(icon);
  if (PATH_RE.test(str)) {
    slot.appendChild(svg(str, { size: 16, strokeWidth: 1.6 }));
  } else {
    slot.textContent = str;
  }
  return slot;
}

function checkGlyph() {
  return svg('M20 6.5 9.4 17.1 4 11.7', { size: 15, strokeWidth: 2 });
}

function chevronGlyph() {
  return svg('M9.5 5.5 16 12l-6.5 6.5', { size: 14, strokeWidth: 1.8 });
}

function resolveSubmenu(spec) {
  if (typeof spec === 'function') {
    try {
      const produced = spec();
      return Array.isArray(produced) ? produced : [];
    } catch (err) {
      console.error('[context-menu] submenu factory threw:', err);
      return [];
    }
  }
  return Array.isArray(spec) ? spec : [];
}

function enabledButtons(level) {
  return level.buttons.filter((b) => !b.disabled);
}

function focusAt(level, delta, fromIndex) {
  const list = enabledButtons(level);
  if (list.length === 0) return;
  let idx = fromIndex;
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  const next = (idx + delta + list.length * 2) % list.length;
  list[next].focus();
}

/* ------------------------------------------------------------------ *
 * level lifecycle
 * ------------------------------------------------------------------ */

function destroyLevel(level) {
  if (!level) return;
  const { el } = level;
  el.classList.remove('ctx-menu--in');
  el.classList.add('ctx-menu--out');
  setTimeout(() => el.remove(), 120);
}

/**
 * Close every level deeper than `index` (0 = root).
 * @param {number} index
 */
function closeLevelsAbove(index) {
  while (levels.length > index + 1) {
    const level = levels.pop();
    if (level.anchor) level.anchor.setAttribute('aria-expanded', 'false');
    destroyLevel(level);
  }
}

function unbindDocument() {
  if (!documentBound) return;
  documentBound = false;
  document.removeEventListener('mousedown', onDocumentPointerDown, true);
  document.removeEventListener('contextmenu', onDocumentContextMenu, true);
  document.removeEventListener('wheel', onDocumentScroll, true);
  document.removeEventListener('scroll', onDocumentScroll, true);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', onDocumentScroll);
}

function bindDocument() {
  if (documentBound) return;
  documentBound = true;
  document.addEventListener('mousedown', onDocumentPointerDown, true);
  document.addEventListener('contextmenu', onDocumentContextMenu, true);
  document.addEventListener('wheel', onDocumentScroll, { capture: true, passive: true });
  document.addEventListener('scroll', onDocumentScroll, { capture: true, passive: true });
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onDocumentScroll);
}

function insideMenu(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return levels.some((level) => level.el.contains(node));
}

function onDocumentPointerDown(ev) {
  if (insideMenu(ev.target)) return;
  closeMenu();
}

function onDocumentContextMenu(ev) {
  if (insideMenu(ev.target)) {
    // A right-click inside the menu should not open the browser menu either.
    ev.preventDefault();
    return;
  }
  closeMenu();
}

function onDocumentScroll(ev) {
  if (ev && insideMenu(ev.target)) return;
  closeMenu();
}

function onWindowBlur() {
  closeMenu();
}

/* ------------------------------------------------------------------ *
 * keyboard
 * ------------------------------------------------------------------ */

function levelIndexOf(el) {
  return levels.findIndex((level) => level.el === el);
}

function onLevelKeyDown(ev) {
  const level = levels[levelIndexOf(ev.currentTarget)];
  if (!level) return;
  const list = enabledButtons(level);
  const current = list.indexOf(document.activeElement);

  switch (ev.key) {
    case 'ArrowDown':
      ev.preventDefault();
      focusAt(level, 1, current);
      return;
    case 'ArrowUp':
      ev.preventDefault();
      focusAt(level, -1, current);
      return;
    case 'Home':
      ev.preventDefault();
      if (list.length) list[0].focus();
      return;
    case 'End':
      ev.preventDefault();
      if (list.length) list[list.length - 1].focus();
      return;
    case 'ArrowRight': {
      const button = document.activeElement;
      if (button && button.dataset && button.dataset.hasSubmenu === '1') {
        ev.preventDefault();
        cancelHoverTimer();
        const idx = levelIndexOf(level.el);
        closeLevelsAbove(idx);
        const sub = openSubmenu(idx, button);
        if (sub) {
          const first = enabledButtons(sub)[0];
          if (first) first.focus();
        }
      }
      return;
    }
    case 'ArrowLeft': {
      const idx = levelIndexOf(level.el);
      if (idx > 0) {
        ev.preventDefault();
        const parentAnchor = level.anchor;
        closeLevelsAbove(idx - 1);
        if (parentAnchor && parentAnchor.isConnected) parentAnchor.focus();
      }
      return;
    }
    case 'Escape':
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      return;
    case 'Tab':
      ev.preventDefault();
      closeMenu();
      return;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * building
 * ------------------------------------------------------------------ */

function buildLevel(items, dark, anchor) {
  const menu = h('div.ctx-menu', {
    role: 'menu',
    tabindex: '-1',
    class: dark ? 'ctx-menu--dark' : null,
  });

  const buttons = [];
  const list = Array.isArray(items) ? items : [];

  for (const item of list) {
    if (!item) continue;

    if (item.separator) {
      menu.appendChild(h('div.ctx-sep', { role: 'separator' }));
      continue;
    }

    if (item.header) {
      menu.appendChild(h('div.ctx-header', { text: String(item.label === undefined ? '' : item.label) }));
      continue;
    }

    const hasSubmenu = item.submenu !== undefined && item.submenu !== null;
    const isCheck = item.checked !== undefined;

    const button = h('button.ctx-item', {
      type: 'button',
      role: isCheck ? 'menuitemcheckbox' : 'menuitem',
      tabindex: '-1',
      disabled: item.disabled === true,
      dataset: { hasSubmenu: hasSubmenu ? '1' : '0' },
    });
    if (isCheck) button.setAttribute('aria-checked', item.checked ? 'true' : 'false');
    if (hasSubmenu) {
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', 'false');
    }

    if (isCheck && !item.icon) {
      const slot = h('span.ctx-item__icon', { 'aria-hidden': 'true' });
      if (item.checked) slot.appendChild(checkGlyph());
      button.appendChild(slot);
    } else {
      button.appendChild(buildIcon(item.icon));
    }

    button.appendChild(h('span.ctx-item__label', { text: String(item.label === undefined ? '' : item.label) }));

    if (hasSubmenu) {
      button.appendChild(h('span.ctx-item__arrow', { 'aria-hidden': 'true' }, chevronGlyph()));
    } else if (item.accel) {
      button.appendChild(h('span.ctx-item__accel', { text: String(item.accel) }));
    }

    if (item.disabled !== true) {
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (hasSubmenu) {
          cancelHoverTimer();
          const idx = levelIndexOf(menu);
          closeLevelsAbove(idx);
          const sub = openSubmenu(idx, button);
          if (sub) {
            const first = enabledButtons(sub)[0];
            if (first) first.focus();
          }
          return;
        }
        closeMenu();
        if (typeof item.onClick === 'function') {
          try {
            item.onClick(item);
          } catch (err) {
            console.error('[context-menu] item handler threw:', err);
          }
        }
      });

      button.addEventListener('mouseenter', () => {
        cancelHoverTimer();
        button.focus();
        const idx = levelIndexOf(menu);
        if (idx < 0) return;
        if (hasSubmenu) {
          hoverTimer = setTimeout(() => {
            hoverTimer = 0;
            closeLevelsAbove(idx);
            openSubmenu(idx, button);
          }, SUBMENU_OPEN_DELAY);
        } else if (levels.length > idx + 1) {
          hoverTimer = setTimeout(() => {
            hoverTimer = 0;
            closeLevelsAbove(idx);
          }, SUBMENU_CLOSE_DELAY);
        }
      });
    }

    button.__ctxSubmenu = hasSubmenu ? item.submenu : null;
    menu.appendChild(button);
    buttons.push(button);
  }

  menu.addEventListener('keydown', onLevelKeyDown);
  menu.addEventListener('contextmenu', (ev) => ev.preventDefault());

  return { el: menu, buttons, anchor: anchor || null, dark };
}

function clampVertically(el, top) {
  const vh = window.innerHeight;
  const height = el.offsetHeight;
  if (height > vh - EDGE_GAP * 2) {
    el.style.maxHeight = `${vh - EDGE_GAP * 2}px`;
    return EDGE_GAP;
  }
  let value = top;
  if (value + height > vh - EDGE_GAP) value = vh - EDGE_GAP - height;
  if (value < EDGE_GAP) value = EDGE_GAP;
  return value;
}

function positionRoot(el, x, y) {
  const vw = window.innerWidth;
  const width = el.offsetWidth;
  let left = x;
  if (left + width > vw - EDGE_GAP) left = x - width;
  if (left < EDGE_GAP) left = EDGE_GAP;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(clampVertically(el, y))}px`;
}

function positionSubmenu(el, parentLevel, anchor) {
  const vw = window.innerWidth;
  const parentRect = parentLevel.el.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const width = el.offsetWidth;

  let left = parentRect.right - 5;
  if (left + width > vw - EDGE_GAP) left = parentRect.left - width + 5;
  if (left < EDGE_GAP) left = EDGE_GAP;

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(clampVertically(el, anchorRect.top - 6))}px`;
}

/**
 * Open the submenu owned by `anchor`, which lives in level `parentIndex`.
 * @param {number} parentIndex
 * @param {HTMLElement} anchor
 * @returns {object|null} the newly pushed level record
 */
function openSubmenu(parentIndex, anchor) {
  const parentLevel = levels[parentIndex];
  if (!parentLevel) return null;
  const items = resolveSubmenu(anchor.__ctxSubmenu);
  if (items.length === 0) return null;

  const level = buildLevel(items, parentLevel.dark, anchor);
  document.body.appendChild(level.el);
  levels.push(level);
  anchor.setAttribute('aria-expanded', 'true');

  positionSubmenu(level.el, parentLevel, anchor);
  void level.el.offsetHeight;
  level.el.classList.add('ctx-menu--in');
  return level;
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

/**
 * Open a context menu at viewport coordinates.
 *
 * @param {number} x
 * @param {number} y
 * @param {Array<{label?:string, icon?:any, accel?:string, disabled?:boolean,
 *                separator?:boolean, header?:boolean, checked?:boolean,
 *                onClick?:Function, submenu?:any}>} items
 * @param {{dark?:boolean, minWidth?:number, onClose?:Function}} [opts]
 * @returns {HTMLElement|null} the root menu element
 */
export function openMenu(x, y, items, opts = {}) {
  closeMenu();

  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return null;

  const active = document.activeElement;
  restoreFocus = active && typeof active.focus === 'function' ? active : null;
  closedCallback = typeof opts.onClose === 'function' ? opts.onClose : null;

  const level = buildLevel(list, opts.dark === true, null);
  if (opts.minWidth) level.el.style.minWidth = `${Number(opts.minWidth)}px`;

  document.body.appendChild(level.el);
  levels.push(level);
  bindDocument();

  positionRoot(level.el, Number(x) || 0, Number(y) || 0);
  void level.el.offsetHeight;
  level.el.classList.add('ctx-menu--in');

  const first = enabledButtons(level)[0];
  if (first) first.focus();
  else level.el.focus();

  return level.el;
}

/** Close the whole menu stack. Safe to call when nothing is open. */
export function closeMenu() {
  cancelHoverTimer();
  if (levels.length === 0) {
    unbindDocument();
    return;
  }
  while (levels.length > 0) destroyLevel(levels.pop());
  unbindDocument();

  const callback = closedCallback;
  const previous = restoreFocus;
  closedCallback = null;
  restoreFocus = null;

  if (previous && previous.isConnected && document.activeElement === document.body) {
    try {
      previous.focus();
    } catch {
      /* element became unfocusable — ignore */
    }
  }
  if (callback) {
    try {
      callback();
    } catch (err) {
      console.error('[context-menu] onClose handler threw:', err);
    }
  }
}

/** @returns {boolean} true while any level is on screen */
export function isMenuOpen() {
  return levels.length > 0;
}
