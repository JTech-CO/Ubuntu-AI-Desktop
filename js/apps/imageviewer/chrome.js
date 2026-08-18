/**
 * js/apps/imageviewer/chrome.js — the Image Viewer's furniture.
 *
 * The Eye of GNOME header bar (name, prev/next, zoom, hamburger), the bottom
 * status bar, the empty state, the properties dialog and the app icon.
 *
 * Every string that comes from the filesystem — file names, paths, type
 * labels — is written with `textContent` through `js/core/dom.js`, never
 * `innerHTML` (ARCHITECTURE §0.4).
 */

import { h, svg, clear, on } from '../../core/dom.js';

/* ------------------------------------------------------------------ *
 * icons
 * ------------------------------------------------------------------ */

const PATHS = {
  prev: 'M15 5 8 12l7 7',
  next: 'M9 5l7 7-7 7',
  zoomIn: ['M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8', 'M15.6 15.6 20 20', 'M11 8.4v5.2', 'M8.4 11h5.2'],
  zoomOut: ['M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8', 'M15.6 15.6 20 20', 'M8.4 11h5.2'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  rotateRight: ['M20 5v5h-5', 'M19.3 10a7.6 7.6 0 1 0-.6 5.4'],
  fullscreen: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  broken: [
    'M3.4 5.6h17.2v12.8H3.4z',
    'M3.4 15.2 8.6 10l3.6 3.6',
    'M14 12.6l2.6-2.6 4 4',
    'M15.6 8.4h.01',
  ],
};

/**
 * The Image Viewer application icon: a Yaru-ish photo frame with a sun and a
 * hill, drawn from primitives so it needs no external asset.
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function viewerIcon(size = 24) {
  return svg(
    [
      'M3.5 5.2h17a1 1 0 0 1 1 1v11.6a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V6.2a1 1 0 0 1 1-1z',
      'M2.5 16.4 8.9 10l4.4 4.4 2.7-2.7 5.5 5.5',
      'M8.2 9.4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
    ],
    { size, strokeWidth: 1.6, class: 'app-icon app-icon--imageviewer' },
  );
}

/* ------------------------------------------------------------------ *
 * header bar
 * ------------------------------------------------------------------ */

function headerButton(label, icon, handler, extraClass = '') {
  const button = h(`button.eog-btn${extraClass}`, {
    type: 'button',
    title: label,
    'aria-label': label,
  }, svg(icon, { size: 18, strokeWidth: 1.7 }));
  button.addEventListener('click', handler);
  return button;
}

/**
 * Build the header bar.
 *
 * @param {{
 *   onPrev: () => void,
 *   onNext: () => void,
 *   onZoomIn: () => void,
 *   onZoomOut: () => void,
 *   onRotate: () => void,
 *   onFullscreen: () => void,
 *   onMenu: (anchor: HTMLElement) => void,
 * }} handlers
 * @returns {object} the header handle
 */
export function createHeader(handlers) {
  const title = h('div.eog-title__name', { text: 'Image Viewer' });
  const subtitle = h('div.eog-title__sub', { text: '' });

  const prev = headerButton('Previous Image', PATHS.prev, handlers.onPrev);
  const next = headerButton('Next Image', PATHS.next, handlers.onNext);
  const zoomOut = headerButton('Zoom Out', PATHS.zoomOut, handlers.onZoomOut);
  const zoomIn = headerButton('Zoom In', PATHS.zoomIn, handlers.onZoomIn);
  const rotate = headerButton('Rotate Right', PATHS.rotateRight, handlers.onRotate);
  const full = headerButton('Fullscreen', PATHS.fullscreen, handlers.onFullscreen);
  const menu = headerButton('Main Menu', PATHS.menu, () => handlers.onMenu(menu));

  const element = h(
    'div.eog-header',
    {},
    h('div.eog-header__start', {}, h('div.eog-linked', {}, prev, next)),
    h('div.eog-title', {}, title, subtitle),
    h(
      'div.eog-header__end',
      {},
      h('div.eog-linked', {}, zoomOut, zoomIn),
      rotate,
      full,
      menu,
    ),
  );

  return {
    element,
    menuAnchor: menu,

    /**
     * @param {string} name
     * @param {string} [sub]
     */
    setTitle(name, sub = '') {
      title.textContent = String(name || '');
      subtitle.textContent = String(sub || '');
      subtitle.hidden = String(sub || '') === '';
    },

    /** @param {boolean} enabled */
    setNavEnabled(enabled) {
      prev.disabled = !enabled;
      next.disabled = !enabled;
    },

    /** @param {boolean} enabled */
    setImageActionsEnabled(enabled) {
      zoomIn.disabled = !enabled;
      zoomOut.disabled = !enabled;
      rotate.disabled = !enabled;
    },
  };
}

/* ------------------------------------------------------------------ *
 * status bar
 * ------------------------------------------------------------------ */

/**
 * The bottom status bar: dimensions, file size, zoom percentage and position.
 * @returns {object} the status-bar handle
 */
export function createStatusBar() {
  const dimensions = h('span.eog-status__cell', { text: '' });
  const size = h('span.eog-status__cell', { text: '' });
  const zoom = h('span.eog-status__cell.eog-status__cell--zoom', { text: '' });
  const position = h('span.eog-status__cell.eog-status__cell--position', { text: '' });

  const element = h(
    'div.eog-status',
    { role: 'status', 'aria-live': 'polite' },
    h('div.eog-status__group', {}, dimensions, size),
    h('div.eog-status__group', {}, zoom, position),
  );

  return {
    element,

    /**
     * @param {{dimensions?: string, size?: string, zoom?: string, position?: string}} values
     */
    set(values = {}) {
      dimensions.textContent = values.dimensions === undefined ? '' : String(values.dimensions);
      size.textContent = values.size === undefined ? '' : String(values.size);
      zoom.textContent = values.zoom === undefined ? '' : String(values.zoom);
      position.textContent = values.position === undefined ? '' : String(values.position);
    },
  };
}

/* ------------------------------------------------------------------ *
 * empty state
 * ------------------------------------------------------------------ */

/**
 * The "could not be displayed" page eog shows in place of an image.
 * @returns {object} the empty-state handle
 */
export function createEmptyState() {
  const heading = h('h2.eog-empty__title', { text: 'No Image' });
  const body = h('p.eog-empty__body', { text: '' });
  const actions = h('div.eog-empty__actions');
  const element = h(
    'div.eog-empty',
    { hidden: true },
    h('div.eog-empty__icon', { 'aria-hidden': 'true' }, svg(PATHS.broken, { size: 64, strokeWidth: 1.2 })),
    heading,
    body,
    actions,
  );

  return {
    element,

    /**
     * @param {{title: string, body?: string,
     *          actions?: {label: string, onClick: () => void}[]}} spec
     */
    show(spec) {
      heading.textContent = String(spec.title || '');
      body.textContent = String(spec.body || '');
      clear(actions);
      for (const action of spec.actions || []) {
        const button = h('button.eog-empty__button', { type: 'button', text: action.label });
        button.addEventListener('click', action.onClick);
        actions.appendChild(button);
      }
      element.hidden = false;
    },

    hide() {
      element.hidden = true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * properties dialog
 * ------------------------------------------------------------------ */

function propRow(label, value) {
  return h(
    'div.eog-props__row',
    {},
    h('div.eog-props__key', { text: label }),
    h('div.eog-props__value', { text: value === undefined || value === null ? '' : String(value) }),
  );
}

/**
 * The eog "Image Properties" dialog.
 *
 * @param {{name:string, location:string, path:string, type:string,
 *          dimensions:string, size:string, modified:string, zoom:string}} info
 * @returns {HTMLElement} the backdrop element
 */
export function openPropertiesDialog(info) {
  const card = h('div.eog-props', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Image Properties',
    tabindex: '-1',
  });
  const backdrop = h('div.eog-props-backdrop', {}, card);

  let closed = false;
  const offKey = on(document, 'keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
  }, true);

  function close() {
    if (closed) return;
    closed = true;
    offKey();
    backdrop.classList.remove('is-in');
    setTimeout(() => backdrop.remove(), 140);
  }

  const closeButton = h('button.eog-props__close', {
    type: 'button',
    'aria-label': 'Close',
    text: '×',
  });
  closeButton.addEventListener('click', close);

  card.appendChild(
    h(
      'div.eog-props__header',
      {},
      h('h2.eog-props__heading', { text: 'Image Properties' }),
      closeButton,
    ),
  );

  const body = h('div.eog-props__body');
  body.appendChild(propRow('Name', info.name));
  body.appendChild(propRow('Location', info.location));
  body.appendChild(propRow('Full Path', info.path));
  body.appendChild(propRow('Type', info.type));
  body.appendChild(propRow('Dimensions', info.dimensions));
  body.appendChild(propRow('Size', info.size));
  body.appendChild(propRow('Modified', info.modified));
  body.appendChild(propRow('Zoom', info.zoom));
  card.appendChild(body);

  const dismiss = h('button.eog-props__done', { type: 'button', text: 'Close' });
  dismiss.addEventListener('click', close);
  card.appendChild(h('div.eog-props__actions', {}, dismiss));

  backdrop.addEventListener('mousedown', (ev) => {
    if (ev.target === backdrop) close();
  });

  const layer = document.getElementById('dialog-layer') || document.body;
  layer.appendChild(backdrop);
  void backdrop.offsetHeight;
  backdrop.classList.add('is-in');
  card.focus();
  return backdrop;
}
