/**
 * js/shell/window-interaction.js — pointer gestures on a window frame.
 *
 * Sibling of `window-manager.js` (ARCHITECTURE §14): header dragging with
 * Mutter's edge snapping, the translucent snap preview, and the eight resize
 * handles. It owns no window state — the manager passes a small host API once
 * at boot and hands over its instance records unchanged.
 *
 * Instance record fields consumed here:
 *   win, header, rect, restoreRect, maximized, tiled, closing, drag, app
 */

import { on } from '../core/dom.js';
import {
  buildSnapPreview,
  workArea,
  clampRect,
  applyRect,
  halfRect,
  HEADER_HEIGHT,
} from './window-chrome.js';

/** Distance from a screen edge that arms a snap. */
const SNAP_EDGE = 20;

/** Pointer travel before a header press becomes a drag. */
const DRAG_THRESHOLD = 6;

/**
 * @typedef {{
 *   focus: (inst: object) => void,
 *   setRect: (inst: object, rect: object) => void,
 *   unmaximize: (inst: object, rect: object) => void,
 *   commitSnap: (inst: object, mode: 'max'|'left'|'right') => void,
 *   nextZ: () => number,
 *   layer: () => HTMLElement
 * }} InteractionHost
 */

/** @type {InteractionHost|null} */
let host = null;

/** @type {HTMLElement|null} */
let previewEl = null;

/**
 * Wire the gestures to their owning window manager. Called once from
 * `window-manager.js`.
 * @param {InteractionHost} api
 */
export function installInteractions(api) {
  host = api;
}

/* ------------------------------------------------------------------ *
 * Snap preview
 * ------------------------------------------------------------------ */

function ensurePreview() {
  const layer = host.layer();
  if (!previewEl || !previewEl.isConnected) {
    previewEl = buildSnapPreview();
    layer.appendChild(previewEl);
  }
  return previewEl;
}

/**
 * The rectangle a snap mode would commit to.
 * @param {'max'|'left'|'right'} mode
 * @param {{x:number,y:number,w:number,h:number}} area
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function snapRect(mode, area) {
  if (mode === 'max') return { x: area.x, y: area.y, w: area.w, h: area.h };
  if (mode === 'left' || mode === 'right') return halfRect(mode, area);
  return null;
}

function showPreview(inst, mode, area) {
  const rect = snapRect(mode, area);
  if (!rect) {
    hidePreview();
    return;
  }
  const preview = ensurePreview();
  if (!preview.classList.contains('snap-preview--visible')) {
    // The preview sits above every other window but below the dragged one.
    preview.style.zIndex = String(host.nextZ());
    inst.win.style.zIndex = String(host.nextZ());
  }
  applyRect(preview, rect);
  preview.classList.add('snap-preview--visible');
}

/** Hide the snap preview. Also used by the manager when a window dies mid-drag. */
export function hidePreview() {
  if (previewEl) previewEl.classList.remove('snap-preview--visible');
}

/**
 * Which snap the pointer is currently arming.
 * @returns {'max'|'left'|'right'|null}
 */
function detectSnap(clientX, clientY, area) {
  if (clientY <= area.y + SNAP_EDGE) return 'max';
  if (clientX <= area.x + SNAP_EDGE) return 'left';
  if (clientX >= window.innerWidth - SNAP_EDGE) return 'right';
  return null;
}

/* ------------------------------------------------------------------ *
 * Dragging
 * ------------------------------------------------------------------ */

/**
 * Start a header drag. Pointer capture keeps the gesture alive even when the
 * pointer outruns the window.
 * @param {object} inst
 * @param {PointerEvent} ev
 */
export function beginDrag(inst, ev) {
  if (ev.button !== 0 || inst.closing) return;
  if (ev.target.closest && ev.target.closest('.window__controls')) return;

  host.focus(inst);

  const header = inst.header;
  const area = workArea();
  const startRect = { ...inst.rect };

  const state = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    offX: ev.clientX - startRect.x,
    offY: ev.clientY - startRect.y,
    moved: false,
    snap: null,
    area,
  };

  try {
    header.setPointerCapture(ev.pointerId);
  } catch (err) {
    /* pointer capture is best-effort */
  }

  const finish = () => {
    offMove();
    offUp();
    offCancel();
    try {
      header.releasePointerCapture(state.pointerId);
    } catch (err) {
      /* already released */
    }
    inst.win.classList.remove('window--dragging');
    document.documentElement.classList.remove('wm-dragging');
    hidePreview();
    inst.drag = null;
  };

  const onMove = (moveEv) => {
    if (moveEv.pointerId !== state.pointerId) return;
    const dx = moveEv.clientX - state.startX;
    const dy = moveEv.clientY - state.startY;

    if (!state.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      state.moved = true;
      inst.win.classList.add('window--dragging');
      document.documentElement.classList.add('wm-dragging');

      // Dragging a maximized or tiled window restores it under the pointer,
      // keeping the same relative grab point along the header.
      if (inst.maximized || inst.tiled) {
        const restored = inst.restoreRect
          ? { ...inst.restoreRect }
          : {
              x: state.area.x + 60,
              y: state.area.y + 60,
              w: Math.round(state.area.w * 0.6),
              h: Math.round(state.area.h * 0.6),
            };
        const ratio = (state.startX - inst.rect.x) / Math.max(1, inst.rect.w);
        host.unmaximize(inst, {
          x: Math.round(moveEv.clientX - restored.w * ratio),
          y: Math.round(moveEv.clientY - HEADER_HEIGHT / 2),
          w: restored.w,
          h: restored.h,
        });
        state.offX = moveEv.clientX - inst.rect.x;
        state.offY = moveEv.clientY - inst.rect.y;
      }
    }

    host.setRect(
      inst,
      clampRect(
        { x: moveEv.clientX - state.offX, y: moveEv.clientY - state.offY, w: inst.rect.w, h: inst.rect.h },
        state.area,
      ),
    );

    const snap = detectSnap(moveEv.clientX, moveEv.clientY, state.area);
    if (snap !== state.snap) {
      state.snap = snap;
      if (snap) showPreview(inst, snap, state.area);
      else hidePreview();
    }
  };

  const onUp = (upEv) => {
    if (upEv.pointerId !== state.pointerId) return;
    const snap = state.moved ? state.snap : null;
    finish();
    if (snap) host.commitSnap(inst, snap);
  };

  const onCancel = (cancelEv) => {
    if (cancelEv.pointerId !== state.pointerId) return;
    finish();
  };

  const offMove = on(header, 'pointermove', onMove);
  const offUp = on(header, 'pointerup', onUp);
  const offCancel = on(header, 'pointercancel', onCancel);
  inst.drag = state;
}

/* ------------------------------------------------------------------ *
 * Resizing
 * ------------------------------------------------------------------ */

/**
 * Start an edge or corner resize.
 * @param {object} inst
 * @param {'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'} dir
 * @param {PointerEvent} ev
 */
export function beginResize(inst, dir, ev) {
  if (ev.button !== 0 || inst.closing || inst.app.resizable === false) return;
  ev.preventDefault();
  host.focus(inst);

  if (inst.maximized || inst.tiled) host.unmaximize(inst, inst.restoreRect);

  const handle = ev.currentTarget;
  const area = workArea();
  const start = { ...inst.rect };
  const minW = Number(inst.app.minWidth) > 0 ? Number(inst.app.minWidth) : 320;
  const minH = Number(inst.app.minHeight) > 0 ? Number(inst.app.minHeight) : 200;
  const pointerId = ev.pointerId;
  const startX = ev.clientX;
  const startY = ev.clientY;

  try {
    handle.setPointerCapture(pointerId);
  } catch (err) {
    /* best effort */
  }

  inst.win.classList.add('window--resizing');
  document.documentElement.classList.add('wm-dragging');

  const finish = () => {
    offMove();
    offUp();
    offCancel();
    try {
      handle.releasePointerCapture(pointerId);
    } catch (err) {
      /* already released */
    }
    inst.win.classList.remove('window--resizing');
    document.documentElement.classList.remove('wm-dragging');
  };

  const onMove = (moveEv) => {
    if (moveEv.pointerId !== pointerId) return;
    const dx = moveEv.clientX - startX;
    const dy = moveEv.clientY - startY;

    let left = start.x;
    let top = start.y;
    let right = start.x + start.w;
    let bottom = start.y + start.h;

    if (dir.includes('e')) right = start.x + start.w + dx;
    if (dir.includes('w')) left = start.x + dx;
    if (dir.includes('s')) bottom = start.y + start.h + dy;
    if (dir.includes('n')) top = start.y + dy;

    if (right - left < minW) {
      if (dir.includes('w')) left = right - minW;
      else right = left + minW;
    }
    if (bottom - top < minH) {
      if (dir.includes('n')) top = bottom - minH;
      else bottom = top + minH;
    }

    // The header may never be pushed under the top bar.
    if (top < area.y) {
      top = area.y;
      if (bottom - top < minH) bottom = top + minH;
    }

    host.setRect(inst, { x: left, y: top, w: right - left, h: bottom - top });
  };

  const onUp = (upEv) => {
    if (upEv.pointerId !== pointerId) return;
    finish();
  };

  const onCancel = (cancelEv) => {
    if (cancelEv.pointerId !== pointerId) return;
    finish();
  };

  const offMove = on(handle, 'pointermove', onMove);
  const offUp = on(handle, 'pointerup', onUp);
  const offCancel = on(handle, 'pointercancel', onCancel);
}
