/**
 * js/apps/files/icons.js — Yaru-style iconography for the Files and Trash apps.
 *
 * Everything is inline SVG built with `createElementNS`; nothing here ever
 * touches `innerHTML`. Two families are provided:
 *
 *   - `symbolic(name)` — 16px Adwaita-style monochrome stroke icons for the
 *     header bar and the sidebar (they inherit `currentColor`).
 *   - `entryIcon(entry)` — full-colour 96px mimetype icons: the Yaru folder in
 *     Ubuntu orange (#E95420) and a paper sheet with a folded corner plus a
 *     type-coloured badge for files.
 */

import { fs } from '../../core/fs.js';
import { h } from '../../core/dom.js';
import { hasTextPreview } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

/** Yaru folder palette. */
const FOLDER_FRONT = '#E95420';
const FOLDER_BACK = '#C0431B';

/** Paper-sheet palette (Yaru "text-x-generic"). */
const PAGE_FILL = '#FCFCFC';
const PAGE_EDGE = '#B9B4AF';
const PAGE_FOLD = '#DAD5D0';

/** Badge colours per icon kind. */
const KIND_COLOUR = {
  text: '#5E5C64',
  code: '#0073E5',
  image: '#B34CB3',
  audio: '#7764D8',
  video: '#308280',
  archive: '#A6791E',
  package: '#E95420',
  disc: '#5E5C64',
  pdf: '#DA3450',
  font: '#657B69',
  binary: '#4B8501',
  unknown: '#8E8E8E',
};

function make(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

function svgRoot(size, viewBox) {
  const root = make('svg', {
    viewBox,
    width: String(size),
    height: String(size),
    'aria-hidden': 'true',
    focusable: 'false',
  });
  return root;
}

/* ------------------------------------------------------------------ *
 * symbolic icons (16px, stroke, currentColor)
 * ------------------------------------------------------------------ */

/** 24x24 stroke paths, Adwaita symbolic shapes. */
const SYMBOLIC = {
  back: ['M15 4.5 7.5 12 15 19.5'],
  forward: ['M9 4.5 16.5 12 9 19.5'],
  up: ['M12 20V5', 'M5.5 11.5 12 5l6.5 6.5'],
  home: ['M3 11.2 12 3.5l9 7.7', 'M5.6 9.4V20h12.8V9.4'],
  desktop: ['M3.5 5h17a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M9 20h6', 'M12 16.5V20'],
  documents: ['M6.5 3h7.2L18 7.3V21H6.5z', 'M13.4 3v4.4H18'],
  downloads: ['M12 3.5v10', 'M8 10l4 4 4-4', 'M4 16v3.2a1.3 1.3 0 0 0 1.3 1.3h13.4a1.3 1.3 0 0 0 1.3-1.3V16'],
  music: ['M9.5 18.2V5.6l10-2v12.6', 'M9.5 9.6l10-2'],
  pictures: [
    'M3.5 5h17a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    'M3 16.5 9 10.5l4.2 4.2 3-2.8L21 16.4',
  ],
  videos: ['M2.5 6.5h12.2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M15.7 12.4 22 8.6v6.8z'],
  trash: ['M4 6.5h16', 'M9.2 6.5V4.2h5.6v2.3', 'M6.4 6.5 7.5 20.3h9L17.6 6.5', 'M10.2 10.3v6.4', 'M13.8 10.3v6.4'],
  folder: ['M3.5 7.4a1.6 1.6 0 0 1 1.6-1.6h4.1l2.2 2.4h9.1a1.6 1.6 0 0 1 1.6 1.6v8.8a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z'],
  computer: [
    'M3.5 5h17a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    'M8 20h8',
    'M12 16.5V20',
    'M6 8.5h6',
  ],
  drive: ['M3.5 6.5h17a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 16V8a1.5 1.5 0 0 1 1.5-1.5z', 'M18 12h.01'],
  search: ['M10.8 4a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6z', 'M15.8 15.8 20.5 20.5'],
  grid: ['M4 4h6.2v6.2H4z', 'M13.8 4H20v6.2h-6.2z', 'M4 13.8h6.2V20H4z', 'M13.8 13.8H20V20h-6.2z'],
  list: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h16'],
  sort: ['M4 6.5h13', 'M4 12h9', 'M4 17.5h5', 'M17 13.5v6', 'M14.5 17l2.5 2.5 2.5-2.5'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  check: ['M5 12.5 10 17.5 19.5 7'],
  restore: ['M4 12a8 8 0 1 0 2.6-5.9', 'M4 4.5V10h5.5'],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 11v6', 'M12 7.6h.01'],
  warning: ['M12 3.8 21 19.5H3z', 'M12 9.5v5', 'M12 17.4h.01'],
  editIcon: ['M4 20h4.2L19 9.2a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8z'],
  terminal: ['M3.5 4.5h17a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z', 'M6.5 9 10 12l-3.5 3', 'M12.5 15.5h5'],
  star: ['M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8z'],
};

/**
 * Monochrome symbolic icon that inherits the current text colour.
 * @param {string} name key of the internal symbolic table
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function symbolic(name, size = 16) {
  const paths = SYMBOLIC[name] || SYMBOLIC.folder;
  const root = svgRoot(size, '0 0 24 24');
  root.setAttribute('fill', 'none');
  root.setAttribute('stroke', 'currentColor');
  root.setAttribute('stroke-width', '1.7');
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  root.classList.add('files-symbolic');
  for (const d of paths) root.appendChild(make('path', { d }));
  return root;
}

/* ------------------------------------------------------------------ *
 * folder emblems (drawn white inside the folder front)
 * ------------------------------------------------------------------ */

const EMBLEMS = {
  home: ['M3 11.2 12 3.5l9 7.7', 'M5.6 9.4V20h12.8V9.4'],
  desktop: SYMBOLIC.desktop,
  documents: SYMBOLIC.documents,
  downloads: SYMBOLIC.downloads,
  music: SYMBOLIC.music,
  pictures: SYMBOLIC.pictures,
  videos: SYMBOLIC.videos,
  templates: ['M4 5h16v14H4z', 'M4 9.5h16', 'M9 9.5V19'],
  publicShare: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M3.5 12h17', 'M12 3.5c2.6 2.6 2.6 14.4 0 17', 'M12 3.5c-2.6 2.6-2.6 14.4 0 17'],
};

/** Home-relative folder name -> emblem key. */
const SPECIAL_FOLDERS = {
  Desktop: 'desktop',
  Documents: 'documents',
  Downloads: 'downloads',
  Music: 'music',
  Pictures: 'pictures',
  Videos: 'videos',
  Templates: 'templates',
  Public: 'publicShare',
};

const FOLDER_BACK_PATH =
  'M10 9h13.8a4 4 0 0 1 3.1 1.5L30 14h24a5 5 0 0 1 5 5v30a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5z';
const FOLDER_FRONT_PATH = 'M5 20h54v29a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V20z';

/**
 * The Yaru folder icon, optionally carrying a white emblem.
 * @param {number} [size]
 * @param {string} [emblem] key of the emblem table
 * @returns {SVGElement}
 */
export function folderIcon(size = 96, emblem = '') {
  const root = svgRoot(size, '0 0 64 64');
  root.classList.add('files-icon', 'files-icon--folder');
  root.appendChild(make('path', { d: FOLDER_BACK_PATH, fill: FOLDER_BACK }));
  root.appendChild(make('path', { d: FOLDER_FRONT_PATH, fill: FOLDER_FRONT }));
  root.appendChild(make('path', { d: 'M5 20h54v1.6H5z', fill: '#FFFFFF', 'fill-opacity': '0.22' }));

  const paths = EMBLEMS[emblem];
  if (paths) {
    const g = make('g', {
      transform: 'translate(20.5 25.5) scale(0.96)',
      fill: 'none',
      stroke: '#FFFFFF',
      'stroke-opacity': '0.62',
      'stroke-width': '1.9',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    for (const d of paths) g.appendChild(make('path', { d }));
    root.appendChild(g);
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * file icons
 * ------------------------------------------------------------------ */

const PAGE_PATH = 'M14 5h22.5L50 18.5V55a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z';
const PAGE_FOLD_PATH = 'M36.5 5 50 18.5H40.5a4 4 0 0 1-4-4z';

/** Small white glyphs drawn inside the type badge (12x12 authoring box). */
const BADGE_GLYPHS = {
  text: ['M2.5 3h7', 'M2.5 6h7', 'M2.5 9h4.5'],
  code: ['M4.4 3 1.6 6l2.8 3', 'M7.6 3l2.8 3-2.8 3'],
  image: ['M1.5 2.5h9v7h-9z', 'M1.8 8 4.6 5.2l2 2 1.5-1.4 2.1 2.2'],
  audio: ['M4.4 9.2V2.8l5.2-1v6.2', 'M4.4 4.6l5.2-1'],
  video: ['M1.6 3h5.6v6H1.6z', 'M7.7 6l2.8-1.7v3.4z'],
  archive: ['M1.6 3h8.8v6.4H1.6z', 'M1.6 3 6 1.2 10.4 3', 'M6 4.2v3'],
  package: ['M1.6 3.6 6 1.4l4.4 2.2v5L6 10.8 1.6 8.6z', 'M1.6 3.6 6 5.8l4.4-2.2', 'M6 5.8v5'],
  disc: ['M6 1.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z', 'M6 4.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z'],
  pdf: ['M2.6 9.4c2.6-1 4.4-4 4.8-6.4.3-1.6-1.6-1.7-1.4 0 .3 2.6 2.2 5.4 4.4 6.2'],
  font: ['M2.4 9.6 6 2.2l3.6 7.4', 'M3.8 7h4.4'],
  binary: ['M2.2 2.6h3v6.8h-3z', 'M6.8 2.6h3v6.8h-3z'],
  unknown: ['M4 4.2a2 2 0 1 1 2.6 1.9c-.5.2-.8.6-.8 1.2v.4', 'M5.9 9.4h.01'],
};

/**
 * A paper sheet with a folded corner and a type-coloured badge.
 * @param {string} kind icon kind from `format.kindFor`
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function fileIcon(kind, size = 96) {
  const root = svgRoot(size, '0 0 64 64');
  root.classList.add('files-icon', 'files-icon--file');
  root.appendChild(make('path', { d: PAGE_PATH, fill: PAGE_FILL, stroke: PAGE_EDGE, 'stroke-width': '1.2' }));
  root.appendChild(make('path', { d: PAGE_FOLD_PATH, fill: PAGE_FOLD }));

  const colour = KIND_COLOUR[kind] || KIND_COLOUR.unknown;
  if (kind === 'text') {
    const g = make('g', { stroke: '#9A9996', 'stroke-width': '2', 'stroke-linecap': 'round' });
    for (const y of [28, 34, 40, 46]) {
      g.appendChild(make('path', { d: `M18 ${y}h${y === 46 ? 16 : 28}` }));
    }
    root.appendChild(g);
    return root;
  }

  root.appendChild(make('circle', { cx: '23', cy: '47', r: '12', fill: colour }));
  const glyph = BADGE_GLYPHS[kind] || BADGE_GLYPHS.unknown;
  const g = make('g', {
    transform: 'translate(17 41)',
    fill: 'none',
    stroke: '#FFFFFF',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  for (const d of glyph) g.appendChild(make('path', { d }));
  root.appendChild(g);
  return root;
}

/** A small arrow emblem marking symbolic links, drawn bottom-left. */
function linkEmblem(size) {
  const root = svgRoot(size, '0 0 64 64');
  root.classList.add('files-icon__emblem');
  root.appendChild(make('circle', { cx: '14', cy: '50', r: '11', fill: '#FFFFFF', stroke: '#B9B4AF', 'stroke-width': '1.2' }));
  root.appendChild(
    make('path', {
      d: 'M9 50h9M14.5 45.5 19 50l-4.5 4.5',
      fill: 'none',
      stroke: '#5E5C64',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
  return root;
}

/**
 * A device icon for the "Other Locations" computer entry.
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function driveIcon(size = 96) {
  const root = svgRoot(size, '0 0 64 64');
  root.classList.add('files-icon', 'files-icon--drive');
  root.appendChild(make('rect', { x: '6', y: '14', width: '52', height: '36', rx: '5', fill: '#5E5C64' }));
  root.appendChild(make('rect', { x: '10', y: '18', width: '44', height: '24', rx: '2.5', fill: '#2C001E' }));
  root.appendChild(make('circle', { cx: '48', cy: '46', r: '2.6', fill: '#E95420' }));
  return root;
}

/**
 * The Yaru trash icon used by the sidebar Trash row and the Trash window.
 * @param {number} [size]
 * @param {boolean} [full]
 * @returns {SVGElement}
 */
export function trashIcon(size = 96, full = false) {
  const root = svgRoot(size, '0 0 64 64');
  root.classList.add('files-icon', 'files-icon--trash');
  root.appendChild(make('path', { d: 'M22 8h20a3 3 0 0 1 3 3v3H19v-3a3 3 0 0 1 3-3z', fill: '#5E5C64' }));
  root.appendChild(make('rect', { x: '12', y: '14', width: '40', height: '5', rx: '2.5', fill: '#3D3846' }));
  root.appendChild(
    make('path', {
      d: 'M16 19h32l-3 34a4 4 0 0 1-4 3.6H23A4 4 0 0 1 19 53z',
      fill: full ? '#77767B' : '#9A9996',
    }),
  );
  const bars = make('g', { stroke: '#F6F5F4', 'stroke-width': '2.6', 'stroke-linecap': 'round', opacity: '0.75' });
  bars.appendChild(make('path', { d: 'M27 27v22' }));
  bars.appendChild(make('path', { d: 'M37 27v22' }));
  root.appendChild(bars);
  if (full) root.appendChild(make('path', { d: 'M20 19h24l-1.2 6H21.2z', fill: '#E95420' }));
  return root;
}

/* ------------------------------------------------------------------ *
 * text preview thumbnails
 * ------------------------------------------------------------------ */

const PREVIEW_LINES = 9;
const PREVIEW_COLS = 30;

/**
 * A miniature "page of text" thumbnail for .txt/.md/.py/.js, showing the first
 * lines of the file. Content is inserted with `textContent` only.
 * @param {{path:string, name:string}} entry
 * @param {number} [size]
 * @returns {HTMLElement|null} null when the file cannot be previewed
 */
export function textThumbnail(entry, size = 96) {
  if (!entry || !hasTextPreview(entry.name)) return null;
  let content = '';
  try {
    content = fs.readFile(entry.path);
  } catch {
    return null;
  }
  if (typeof content !== 'string' || content.trim() === '') return null;

  const box = h('div.files-thumb', { style: { width: `${size}px`, height: `${size}px` } });
  const sheet = h('div.files-thumb__sheet');
  const lines = content.split('\n').slice(0, PREVIEW_LINES);
  for (const raw of lines) {
    const line = h('div.files-thumb__line');
    const text = raw.replace(/\t/g, '  ').slice(0, PREVIEW_COLS);
    line.textContent = text === '' ? ' ' : text;
    sheet.appendChild(line);
  }
  box.appendChild(sheet);
  box.appendChild(h('div.files-thumb__fold'));
  return box;
}

/* ------------------------------------------------------------------ *
 * dispatch
 * ------------------------------------------------------------------ */

/**
 * The full-colour icon for a view entry, including the symlink emblem and the
 * text-preview thumbnail when one is available.
 * @param {object} entry normalized view entry
 * @param {{size?:number, previews?:boolean, home?:string}} [opts]
 * @returns {HTMLElement} a positioned wrapper element
 */
export function entryIcon(entry, opts = {}) {
  const size = opts.size === undefined ? 96 : opts.size;
  const wrap = h('div.files-icon-box', { style: { width: `${size}px`, height: `${size}px` } });

  if (entry.kind === 'trash') {
    wrap.appendChild(trashIcon(size, true));
  } else if (entry.kind === 'drive') {
    wrap.appendChild(driveIcon(size));
  } else if (entry.isDir) {
    const home = opts.home || fs.HOME;
    let emblem = '';
    if (entry.path === home) emblem = 'home';
    else if (entry.path.startsWith(`${home}/`)) {
      const rest = entry.path.slice(home.length + 1);
      if (!rest.includes('/')) emblem = SPECIAL_FOLDERS[rest] || '';
    }
    wrap.appendChild(folderIcon(size, emblem));
  } else {
    const thumb = opts.previews === false ? null : textThumbnail(entry, size);
    if (thumb) wrap.appendChild(thumb);
    else wrap.appendChild(fileIcon(entry.kind, size));
  }

  if (entry.isLink) wrap.appendChild(linkEmblem(size));
  if (entry.broken) wrap.classList.add('files-icon-box--broken');
  return wrap;
}
