/**
 * js/apps/imageviewer/surface.js — the Image Viewer's drawing surface.
 *
 * Owns one `<img>` and the affine state applied to it: zoom, pan, rotation and
 * the two mirror flips. Everything is a single CSS `transform`, so the browser
 * composites it and no pixel is ever copied in JavaScript.
 *
 * The transform is `translate(tx, ty) rotate(deg) scale(sx, sy)`, applied to an
 * element whose *centre* already sits at the centre of the viewport. Because
 * `translate` is outermost, `tx`/`ty` are plain screen pixels, which makes
 * pointer-anchored zooming a two-line calculation:
 *
 *     screen = centre + t + R·S·v          (v = a point in image space)
 *     t' = p + k·(t − p)                   (k = newScale / oldScale)
 *
 * Nothing here reads the filesystem; the controller hands it a URL.
 */

import { h, on } from '../../core/dom.js';

/** The zoom ladder eog steps through with + and −. */
const ZOOM_STEPS = [
  0.05, 0.07, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.66, 0.75, 1,
  1.25, 1.5, 2, 3, 4, 5, 7, 10, 15, 20,
];

const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Build the surface.
 *
 * @param {{
 *   onChange?: () => void,
 *   onLoad?: (size: {w:number, h:number}) => void,
 *   onError?: () => void,
 *   onActivate?: () => void,
 * }} [callbacks]
 * @returns {object} the surface handle
 */
export function createSurface(callbacks = {}) {
  const onChange = typeof callbacks.onChange === 'function' ? callbacks.onChange : () => {};
  const onLoad = typeof callbacks.onLoad === 'function' ? callbacks.onLoad : () => {};
  const onError = typeof callbacks.onError === 'function' ? callbacks.onError : () => {};

  const img = h('img.eog-image', { alt: '', draggable: 'false', decoding: 'async' });
  const stage = h('div.eog-stage', {}, img);
  const element = h('div.eog-view', { tabindex: '-1' }, stage);

  const cleanups = [];

  /** Natural pixel size of the decoded image. */
  let natural = { w: 0, h: 0 };
  let loaded = false;
  /** 'fit' recomputes the scale on every resize; 'free' keeps it. */
  let mode = 'fit';
  let scale = 1;
  let rotation = 0;
  let flipX = false;
  let flipY = false;
  let tx = 0;
  let ty = 0;
  let drag = null;

  /* --- geometry ---------------------------------------------------- */

  /**
   * The size to fit into. `clientWidth`/`clientHeight` rather than
   * `getBoundingClientRect()`, because the window manager scales a window while
   * it opens — the bounding rect would be mid-animation and the first fit would
   * settle on a scale that is a few percent too small.
   * @returns {{w:number, h:number}}
   */
  function viewport() {
    const w = element.clientWidth;
    const h2 = element.clientHeight;
    if (w > 0 && h2 > 0) return { w, h: h2 };
    const rect = element.getBoundingClientRect();
    return { w: w || rect.width || 0, h: h2 || rect.height || 0 };
  }

  /** True when the image is quarter-turned, so width and height swap. */
  function quartered() {
    return rotation === 90 || rotation === 270;
  }

  /** The on-screen bounding box of the image at the current scale. */
  function displayed() {
    const w = quartered() ? natural.h : natural.w;
    const h2 = quartered() ? natural.w : natural.h;
    return { w: w * scale, h: h2 * scale };
  }

  /**
   * The scale that fits the (possibly rotated) image inside the viewport.
   * eog's "Best Fit" never enlarges an image that already fits.
   * @returns {number}
   */
  function fitScale() {
    if (!loaded || natural.w === 0 || natural.h === 0) return 1;
    const view = viewport();
    if (view.w <= 0 || view.h <= 0) return 1;
    const w = quartered() ? natural.h : natural.w;
    const h2 = quartered() ? natural.w : natural.h;
    const margin = 24;
    const available = { w: Math.max(32, view.w - margin), h: Math.max(32, view.h - margin) };
    return clamp(Math.min(available.w / w, available.h / h2, 1), MIN_ZOOM, MAX_ZOOM);
  }

  /** Keep the image from being dragged out of sight. */
  function clampPan() {
    const view = viewport();
    const box = displayed();
    const maxX = Math.max(0, (box.w - view.w) / 2);
    const maxY = Math.max(0, (box.h - view.h) / 2);
    tx = clamp(tx, -maxX, maxX);
    ty = clamp(ty, -maxY, maxY);
  }

  /** @returns {boolean} true when the image overflows the viewport */
  function pannable() {
    if (!loaded) return false;
    const view = viewport();
    const box = displayed();
    return box.w - view.w > 1 || box.h - view.h > 1;
  }

  function paint() {
    clampPan();
    img.style.width = `${natural.w}px`;
    img.style.height = `${natural.h}px`;
    // `translate(-50%, -50%)` is outermost, so it is a constant screen-pixel
    // offset that parks the element's centre on the view's centre (the element
    // itself is pinned at left:50%/top:50%). Everything after it therefore
    // operates around that centre, which is what makes `tx`/`ty` plain pixels.
    img.style.transform =
      `translate(-50%, -50%) ` +
      `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) ` +
      `rotate(${rotation}deg) ` +
      `scale(${(scale * (flipX ? -1 : 1)).toFixed(5)}, ${(scale * (flipY ? -1 : 1)).toFixed(5)})`;
    element.classList.toggle('eog-view--pannable', pannable());
    element.classList.toggle('eog-view--dragging', drag !== null);
    // Past 4x, show the real pixels instead of a smeared interpolation.
    element.classList.toggle('eog-view--pixelated', scale >= 4);
    onChange();
  }

  /* --- zoom -------------------------------------------------------- */

  /**
   * @param {number} next desired scale
   * @param {{x:number, y:number}|null} [anchor] pointer position in client
   *        coordinates; the image point beneath it stays put
   */
  function applyScale(next, anchor = null) {
    if (!loaded) return;
    const target = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(target - scale) < 1e-6) return;
    const k = target / scale;

    if (anchor) {
      const rect = element.getBoundingClientRect();
      const px = anchor.x - (rect.left + rect.width / 2);
      const py = anchor.y - (rect.top + rect.height / 2);
      tx = px + k * (tx - px);
      ty = py + k * (ty - py);
    } else {
      tx *= k;
      ty *= k;
    }
    scale = target;
    mode = 'free';
    paint();
  }

  function stepZoom(direction, anchor) {
    if (!loaded) return;
    if (direction > 0) {
      const next = ZOOM_STEPS.find((s) => s > scale + 1e-6);
      applyScale(next === undefined ? MAX_ZOOM : next, anchor);
    } else {
      let next = MIN_ZOOM;
      for (const s of ZOOM_STEPS) {
        if (s < scale - 1e-6) next = s;
      }
      applyScale(next, anchor);
    }
  }

  function fitToWindow() {
    mode = 'fit';
    tx = 0;
    ty = 0;
    scale = fitScale();
    paint();
  }

  function actualSize() {
    if (!loaded) return;
    mode = 'free';
    const k = 1 / scale;
    tx *= k;
    ty *= k;
    scale = 1;
    paint();
  }

  /* --- pointer ------------------------------------------------------ */

  cleanups.push(
    on(element, 'wheel', (ev) => {
      if (!loaded) return;
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        const factor = Math.exp(-ev.deltaY * 0.0022);
        applyScale(scale * factor, { x: ev.clientX, y: ev.clientY });
        return;
      }
      if (!pannable()) return;
      ev.preventDefault();
      tx -= ev.deltaX;
      ty -= ev.deltaY;
      mode = 'free';
      paint();
    }, { passive: false }),
  );

  cleanups.push(
    on(element, 'pointerdown', (ev) => {
      if (ev.button !== 0 || !loaded || !pannable()) return;
      ev.preventDefault();
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, tx, ty };
      try {
        element.setPointerCapture(ev.pointerId);
      } catch {
        /* capture is a nicety; the move handler works without it */
      }
      paint();
    }),
  );

  cleanups.push(
    on(element, 'pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      ev.preventDefault();
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      tx = drag.tx + dx;
      ty = drag.ty + dy;
      mode = 'free';
      paint();
    }),
  );

  const endDrag = (ev) => {
    if (!drag || (ev && ev.pointerId !== undefined && ev.pointerId !== drag.id)) return;
    try {
      element.releasePointerCapture(drag.id);
    } catch {
      /* already released */
    }
    drag = null;
    paint();
  };
  cleanups.push(on(element, 'pointerup', endDrag));
  cleanups.push(on(element, 'pointercancel', endDrag));

  cleanups.push(
    on(img, 'dragstart', (ev) => {
      // Never let the browser start a native drag of the data URL.
      ev.preventDefault();
    }),
  );

  /* --- loading ------------------------------------------------------ */

  cleanups.push(
    on(img, 'load', () => {
      loaded = true;
      natural = {
        w: img.naturalWidth || img.width || 0,
        h: img.naturalHeight || img.height || 0,
      };
      if (natural.w === 0 || natural.h === 0) {
        // An SVG with no intrinsic size: give it the eog default canvas.
        natural = { w: natural.w || 512, h: natural.h || 512 };
      }
      element.classList.add('eog-view--loaded');
      fitToWindow();
      onLoad({ ...natural });
      // One more pass after the next frame, so an image that decoded while the
      // window was still opening ends up fitted to the settled size.
      requestAnimationFrame(() => {
        if (loaded && mode === 'fit') {
          scale = fitScale();
          paint();
        }
      });
    }),
  );

  cleanups.push(
    on(img, 'error', () => {
      loaded = false;
      natural = { w: 0, h: 0 };
      element.classList.remove('eog-view--loaded');
      onError();
    }),
  );

  return {
    element,

    /**
     * Point the surface at a URL. Resets every transform, like opening a new
     * image in eog does.
     * @param {string} url a `data:` or `blob:` URL
     */
    setImage(url) {
      loaded = false;
      natural = { w: 0, h: 0 };
      rotation = 0;
      flipX = false;
      flipY = false;
      tx = 0;
      ty = 0;
      scale = 1;
      mode = 'fit';
      element.classList.remove('eog-view--loaded');
      img.style.transform = '';
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.src = String(url);
      onChange();
    },

    /** Drop the current image and show nothing. */
    clearImage() {
      loaded = false;
      natural = { w: 0, h: 0 };
      element.classList.remove('eog-view--loaded');
      img.removeAttribute('src');
      img.style.transform = '';
      onChange();
    },

    /** @param {string} text the accessible name for the image */
    setAlt(text) {
      img.alt = String(text || '');
    },

    /** @returns {boolean} */
    isLoaded: () => loaded,
    /** @returns {{w:number, h:number}} */
    natural: () => ({ ...natural }),
    /** @returns {number} the effective scale, 1 meaning 1:1 */
    zoom: () => scale,
    /** @returns {'fit'|'free'} */
    zoomMode: () => mode,
    /** @returns {number} 0, 90, 180 or 270 */
    rotation: () => rotation,
    /** @returns {{x:boolean, y:boolean}} */
    flips: () => ({ x: flipX, y: flipY }),
    /** @returns {boolean} */
    pannable,

    zoomIn: (anchor) => stepZoom(1, anchor || null),
    zoomOut: (anchor) => stepZoom(-1, anchor || null),
    setZoom: (value, anchor) => applyScale(Number(value), anchor || null),
    fitToWindow,
    actualSize,

    /**
     * @param {number} degrees a multiple of 90; positive turns clockwise
     */
    rotateBy(degrees) {
      if (!loaded) return;
      const delta = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
      rotation = (rotation + delta) % 360;
      // A quarter turn swaps the flip axes, so the mirror stays where the eye
      // expects it after rotating a flipped image.
      if (delta === 90 || delta === 270) {
        const swap = flipX;
        flipX = flipY;
        flipY = swap;
      }
      tx = 0;
      ty = 0;
      if (mode === 'fit') scale = fitScale();
      paint();
    },

    /** Mirror across the vertical axis. */
    flipHorizontal() {
      if (!loaded) return;
      flipX = !flipX;
      paint();
    },

    /** Mirror across the horizontal axis. */
    flipVertical() {
      if (!loaded) return;
      flipY = !flipY;
      paint();
    },

    /** Undo every rotation, flip, pan and zoom. */
    resetTransform() {
      rotation = 0;
      flipX = false;
      flipY = false;
      tx = 0;
      ty = 0;
      fitToWindow();
    },

    /**
     * Scroll the image by a keyboard step.
     * @param {number} dx
     * @param {number} dy
     * @returns {boolean} true when the pan actually moved something
     */
    panBy(dx, dy) {
      if (!pannable()) return false;
      const before = `${tx},${ty}`;
      tx += dx;
      ty += dy;
      mode = 'free';
      paint();
      return `${tx},${ty}` !== before;
    },

    /** Recompute the fit after the window changed size. */
    relayout() {
      if (!loaded) return;
      if (mode === 'fit') scale = fitScale();
      paint();
    },

    destroy() {
      for (const off of cleanups) off();
      cleanups.length = 0;
      img.removeAttribute('src');
    },
  };
}
