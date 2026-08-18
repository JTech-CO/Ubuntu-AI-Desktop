/**
 * js/shell/overview.js — the Activities overview (ARCHITECTURE §15).
 *
 * Blurs and scales the desktop behind a scrim, lays live window thumbnails out
 * in a responsive grid with captions and close buttons, shows a three-slot
 * workspace strip, an app grid paged like GNOME's, and a search entry that
 * filters apps live and offers a "search in Files" row.
 *
 * Workspaces are simulated on top of the window manager: switching away from a
 * workspace minimizes its windows and switching back restores exactly the ones
 * the overview minimized, so a user-minimized window stays minimized.
 */

import { h, svg, clear } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { wm } from './window-manager.js';
import { apps as registeredApps, getApp } from '../apps/registry.js';

const WORKSPACE_COUNT = 3;
const PAGE_COLUMNS = 6;
const PAGE_ROWS = 4;
const PAGE_SIZE = PAGE_COLUMNS * PAGE_ROWS;

const ICON = {
  search: ['M11 18.4a7.4 7.4 0 1 0 0-14.8 7.4 7.4 0 0 0 0 14.8', 'M16.4 16.4 20.6 20.6'],
  close: ['M7 7l10 10', 'M17 7 7 17'],
  files: ['M3.6 6.4h5.6l1.9 2.4h9.3v10.8H3.6z'],
  apps: [
    'M4.2 4.2h5.4v5.4H4.2z', 'M14.4 4.2h5.4v5.4h-5.4z',
    'M4.2 14.4h5.4v5.4H4.2z', 'M14.4 14.4h5.4v5.4h-5.4z',
  ],
  windows: ['M3.6 5.4h16.8v13.2H3.6z', 'M3.6 9h16.8'],
};

/** @type {'windows'|'apps'} */
let mode = 'windows';
let open = false;
let installed = false;
let pageIndex = 0;
let currentWorkspace = 0;
let searchTerm = '';
let relayoutHandle = 0;

/** instanceId -> workspace index */
const workspaceOf = new Map();
/** instance ids the overview minimized itself (so it may restore them) */
const autoMinimized = new Set();

let root = null;
let searchInput = null;
let workspaceStrip = null;
let windowsGrid = null;
let resultsPane = null;
let appsPane = null;
let pagerEl = null;
let gridToggle = null;
let emptyLabel = null;

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function appIconNode(app, fallbackLabel) {
  if (app && typeof app.icon === 'function') {
    try {
      const produced = app.icon();
      if (produced instanceof Node) return produced;
    } catch (err) {
      console.warn(`[overview] icon factory for "${app && app.id}" threw:`, err);
    }
  }
  if (app && app.icon instanceof Node) return app.icon;
  const label = String((app && app.name) || fallbackLabel || '?');
  return h('span.ov-icon-fallback', { text: label.slice(0, 1).toUpperCase() });
}

function instances() {
  try {
    return wm.instances() || [];
  } catch (err) {
    console.warn('[overview] wm.instances() failed:', err);
    return [];
  }
}

function workspaceIndexOf(instanceId) {
  const key = String(instanceId);
  if (!workspaceOf.has(key)) workspaceOf.set(key, currentWorkspace);
  return workspaceOf.get(key);
}

function instancesOnWorkspace(index) {
  return instances().filter((inst) => workspaceIndexOf(inst.id) === index);
}

function cssEscape(value) {
  const str = String(value);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
  return str.replace(/["\\]/g, '\\$&');
}

/**
 * Find the live DOM element of a window instance. `wm.instances()` hands the
 * frame over directly; the attribute probe is the fallback for a window
 * manager that only publishes markup.
 * @param {string|number} instanceId
 * @returns {HTMLElement|null}
 */
function windowElement(instanceId) {
  const key = String(instanceId);
  for (const inst of instances()) {
    if (String(inst.id) !== key) continue;
    if (inst.win instanceof HTMLElement && inst.win.isConnected) return inst.win;
    break;
  }

  const esc = cssEscape(instanceId);
  const selectors = [
    `[data-instance-id="${esc}"]`,
    `[data-instance="${esc}"]`,
    `[data-window-id="${esc}"]`,
    `.window[data-id="${esc}"]`,
    `#window-${esc}`,
    `#win-${esc}`,
  ];
  for (const selector of selectors) {
    let node = null;
    try {
      node = document.querySelector(selector);
    } catch {
      node = null;
    }
    if (node && !root.contains(node)) return node;
  }
  return null;
}

/**
 * Snapshot a window into a scaled, inert clone that fits `frame`.
 * @param {HTMLElement} source
 * @param {HTMLElement} frame
 */
function paintPreview(source, frame) {
  clear(frame);
  const rect = source.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const boxWidth = Math.max(1, frame.clientWidth);
  const boxHeight = Math.max(1, frame.clientHeight);
  const scale = Math.min(boxWidth / width, boxHeight / height);

  const clone = source.cloneNode(true);
  clone.removeAttribute('id');
  for (const node of clone.querySelectorAll('[id]')) node.removeAttribute('id');
  for (const node of clone.querySelectorAll('[tabindex]')) node.setAttribute('tabindex', '-1');

  // cloneNode() copies canvas elements but not their bitmaps.
  const sourceCanvases = source.querySelectorAll('canvas');
  const cloneCanvases = clone.querySelectorAll('canvas');
  for (let i = 0; i < sourceCanvases.length && i < cloneCanvases.length; i += 1) {
    try {
      const ctx = cloneCanvases[i].getContext('2d');
      if (ctx && sourceCanvases[i].width > 0 && sourceCanvases[i].height > 0) {
        ctx.drawImage(sourceCanvases[i], 0, 0);
      }
    } catch {
      /* tainted or context-less canvas — leave the clone blank */
    }
  }

  clone.classList.add('ov-thumb__clone');
  clone.setAttribute('aria-hidden', 'true');
  clone.style.position = 'absolute';
  clone.style.right = 'auto';
  clone.style.bottom = 'auto';
  clone.style.left = '0';
  clone.style.top = '0';
  clone.style.margin = '0';
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.maxWidth = 'none';
  clone.style.maxHeight = 'none';
  clone.style.transform = `scale(${scale})`;
  clone.style.transformOrigin = '0 0';
  clone.style.pointerEvents = 'none';

  const holder = h('div.ov-thumb__holder');
  holder.style.width = `${Math.round(width * scale)}px`;
  holder.style.height = `${Math.round(height * scale)}px`;
  holder.appendChild(clone);
  frame.appendChild(holder);
}

/** Second pass: measure every thumbnail frame and paint its scaled clone. */
function layoutPreviews() {
  relayoutHandle = 0;
  if (!open || !windowsGrid) return;
  for (const frame of windowsGrid.querySelectorAll('.ov-thumb__frame')) {
    const id = frame.dataset.instanceId;
    const source = id ? windowElement(id) : null;
    if (source) paintPreview(source, frame);
    else {
      clear(frame);
      frame.appendChild(h('div.ov-thumb__placeholder', { text: frame.dataset.title || '' }));
    }
  }
}

function scheduleLayout() {
  if (relayoutHandle) return;
  relayoutHandle = requestAnimationFrame(layoutPreviews);
}

/* ------------------------------------------------------------------ *
 * workspaces
 * ------------------------------------------------------------------ */

/**
 * Move to a workspace, minimizing the windows that belong to the others.
 * @param {number} index 0-based
 */
export function switchWorkspace(index) {
  const target = Math.max(0, Math.min(WORKSPACE_COUNT - 1, Number(index) || 0));
  if (target === currentWorkspace) return;
  currentWorkspace = target;

  for (const inst of instances()) {
    const key = String(inst.id);
    const ws = workspaceIndexOf(inst.id);
    if (ws === target) {
      if (autoMinimized.has(key)) {
        autoMinimized.delete(key);
        wm.restore(inst.id);
      }
    } else if (!inst.minimized) {
      autoMinimized.add(key);
      wm.minimize(inst.id);
    }
  }
  render();
}

function renderWorkspaces() {
  clear(workspaceStrip);
  for (let i = 0; i < WORKSPACE_COUNT; i += 1) {
    const list = instancesOnWorkspace(i);
    const tile = h('button.ov-workspace', {
      type: 'button',
      role: 'tab',
      'aria-selected': i === currentWorkspace ? 'true' : 'false',
      'aria-label': `Workspace ${i + 1}`,
      class: i === currentWorkspace ? 'ov-workspace--current' : null,
    });
    const mini = h('span.ov-workspace__mini', { 'aria-hidden': 'true' });
    for (const inst of list.slice(0, 6)) {
      mini.appendChild(h('i.ov-workspace__chip', { title: inst.title || '' }));
    }
    tile.appendChild(mini);
    tile.appendChild(h('span.ov-workspace__index', { text: String(i + 1) }));
    tile.addEventListener('click', (ev) => {
      ev.stopPropagation();
      switchWorkspace(i);
    });
    workspaceStrip.appendChild(tile);
  }
}

/* ------------------------------------------------------------------ *
 * window thumbnails
 * ------------------------------------------------------------------ */

function buildThumb(inst) {
  const app = getApp(inst.appId);
  const title = inst.title || (app && app.name) || String(inst.appId);

  const frame = h('div.ov-thumb__frame', {
    dataset: { instanceId: String(inst.id), title },
  });

  const closeButton = h('button.ov-thumb__close', {
    type: 'button',
    'aria-label': `Close ${title}`,
    title: 'Close Window',
  }, svg(ICON.close, { size: 15, strokeWidth: 2 }));
  closeButton.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    wm.close(inst.id);
    render();
  });

  const caption = h('div.ov-thumb__caption', {},
    h('span.ov-thumb__icon', { 'aria-hidden': 'true' }, appIconNode(app, title)),
    h('span.ov-thumb__title', { text: title }));

  const tile = h('button.ov-thumb', {
    type: 'button',
    'aria-label': title,
    class: inst.minimized ? 'ov-thumb--minimized' : null,
  }, frame, closeButton, caption);

  tile.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    close();
    if (inst.minimized) wm.restore(inst.id);
    wm.focus(inst.id);
  });

  return tile;
}

function renderWindows() {
  clear(windowsGrid);
  const list = instancesOnWorkspace(currentWorkspace);
  if (list.length === 0) {
    emptyLabel.textContent = 'No open windows on this workspace';
    emptyLabel.hidden = false;
    return;
  }
  emptyLabel.hidden = true;
  windowsGrid.dataset.count = String(list.length);
  for (const inst of list) windowsGrid.appendChild(buildThumb(inst));
  scheduleLayout();
}

/* ------------------------------------------------------------------ *
 * app grid + search
 * ------------------------------------------------------------------ */

function allApps() {
  return registeredApps
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

function launch(appId) {
  close();
  wm.open(appId);
}

function buildAppTile(app) {
  const tile = h('button.ov-app', { type: 'button', dataset: { appId: app.id }, 'aria-label': app.name || app.id },
    h('span.ov-app__icon', { 'aria-hidden': 'true' }, appIconNode(app)),
    h('span.ov-app__name', { text: app.name || app.id }));
  if (app.genericName && app.genericName !== app.name) tile.title = `${app.name} — ${app.genericName}`;
  tile.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    launch(app.id);
  });
  return tile;
}

function pageCount(total) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function renderPager(total) {
  clear(pagerEl);
  const pages = pageCount(total);
  if (pages <= 1) {
    pagerEl.hidden = true;
    return;
  }
  pagerEl.hidden = false;
  for (let i = 0; i < pages; i += 1) {
    const dot = h('button.ov-pager__dot', {
      type: 'button',
      'aria-label': `Page ${i + 1} of ${pages}`,
      'aria-current': i === pageIndex ? 'true' : 'false',
      class: i === pageIndex ? 'ov-pager__dot--current' : null,
    });
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pageIndex = i;
      render();
    });
    pagerEl.appendChild(dot);
  }
}

function renderApps() {
  const list = allApps();
  const pages = pageCount(list.length);
  if (pageIndex >= pages) pageIndex = pages - 1;
  if (pageIndex < 0) pageIndex = 0;

  clear(appsPane);
  const grid = h('div.ov-app-grid', { role: 'list' });
  grid.style.setProperty('--ov-columns', String(PAGE_COLUMNS));
  for (const app of list.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)) {
    grid.appendChild(buildAppTile(app));
  }
  appsPane.appendChild(grid);
  renderPager(list.length);
}

function matches(app, needle) {
  const haystack = [app.name, app.genericName, app.id].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

function renderSearch() {
  clear(resultsPane);
  const needle = searchTerm.trim().toLowerCase();
  const found = allApps().filter((app) => matches(app, needle));

  const filesRow = h('button.ov-result-row', { type: 'button' },
    h('span.ov-result-row__icon', { 'aria-hidden': 'true' }, svg(ICON.files, { size: 20, strokeWidth: 1.6 })),
    h('span.ov-result-row__text', {},
      h('span.ov-result-row__title', { text: `Search for “${searchTerm.trim()}” in Files` }),
      h('span.ov-result-row__subtitle', { text: 'Files' })));
  filesRow.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const term = searchTerm.trim();
    close();
    wm.open('files', { search: term, query: term });
  });

  if (found.length > 0) {
    resultsPane.appendChild(h('div.ov-results__heading', { text: 'Applications' }));
    const grid = h('div.ov-app-grid.ov-app-grid--results', { role: 'list' });
    grid.style.setProperty('--ov-columns', String(Math.min(PAGE_COLUMNS, Math.max(1, found.length))));
    for (const app of found) grid.appendChild(buildAppTile(app));
    resultsPane.appendChild(grid);
  } else {
    resultsPane.appendChild(h('div.ov-results__empty', { text: 'No results found' }));
  }

  resultsPane.appendChild(h('div.ov-results__heading', { text: 'Search' }));
  resultsPane.appendChild(filesRow);
}

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */

function render() {
  if (!root) return;
  const searching = searchTerm.trim().length > 0;
  const showApps = mode === 'apps' && !searching;

  root.dataset.mode = searching ? 'search' : mode;
  renderWorkspaces();

  windowsGrid.parentElement.hidden = searching || showApps;
  resultsPane.hidden = !searching;
  appsPane.hidden = !showApps;

  if (searching) {
    pagerEl.hidden = true;
    renderSearch();
  } else if (showApps) {
    renderApps(); // renderPager decides whether the dots are shown
  } else {
    pagerEl.hidden = true;
    renderWindows();
  }

  if (gridToggle) {
    gridToggle.setAttribute('aria-pressed', showApps ? 'true' : 'false');
    gridToggle.classList.toggle('ov-grid-toggle--on', showApps);
    gridToggle.title = showApps ? 'Show Windows' : 'Show Applications';
  }
}

/* ------------------------------------------------------------------ *
 * events
 * ------------------------------------------------------------------ */

function onKeyDown(ev) {
  if (!open) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    if (searchTerm.trim().length > 0) {
      searchTerm = '';
      if (searchInput) searchInput.value = '';
      render();
      return;
    }
    close();
    return;
  }
  if (mode === 'apps' && !searchTerm && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
    const total = allApps().length;
    const pages = pageCount(total);
    if (pages <= 1) return;
    ev.preventDefault();
    pageIndex = (pageIndex + (ev.key === 'ArrowRight' ? 1 : -1) + pages) % pages;
    render();
    return;
  }
  // Typing anywhere in the overview goes to the search entry, like GNOME.
  if (
    searchInput &&
    document.activeElement !== searchInput &&
    ev.key.length === 1 &&
    !ev.ctrlKey && !ev.metaKey && !ev.altKey
  ) {
    searchInput.focus();
  }
}

function onBackgroundClick(ev) {
  if (ev.target === ev.currentTarget) close();
}

function onWheel(ev) {
  if (mode !== 'apps' || searchTerm) return;
  const pages = pageCount(allApps().length);
  if (pages <= 1) return;
  ev.preventDefault();
  const step = ev.deltaY > 0 || ev.deltaX > 0 ? 1 : -1;
  pageIndex = Math.max(0, Math.min(pages - 1, pageIndex + step));
  render();
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

/**
 * Enter the overview.
 * @param {{apps?: boolean}} [options] `apps: true` opens straight into the app grid
 */
export function openOverview(options = {}) {
  if (!root) install();
  if (options.apps === true) mode = 'apps';
  if (open) {
    render();
    return;
  }
  open = true;
  mode = options.apps === true ? 'apps' : 'windows';
  searchTerm = '';
  if (searchInput) searchInput.value = '';

  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
  document.documentElement.dataset.overview = 'true';
  document.body.classList.add('overview-active');

  render();
  void root.offsetHeight;
  root.classList.add('overview--open');

  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', scheduleLayout);
  bus.emit('shell:popover', { id: 'overview' });
  bus.emit('overview:open', {});

  if (searchInput) searchInput.focus();
  scheduleLayout();
}

/** Leave the overview. */
export function close() {
  if (!open || !root) return;
  open = false;
  root.classList.remove('overview--open');
  root.setAttribute('aria-hidden', 'true');
  delete document.documentElement.dataset.overview;
  document.body.classList.remove('overview-active');

  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', scheduleLayout);

  setTimeout(() => {
    if (open || !root) return;
    root.hidden = true;
    clear(windowsGrid);
  }, 260);

  bus.emit('overview:close', {});
}

/** @returns {boolean} */
export function isOpen() {
  return open;
}

/** Toggle the overview in its window view. */
export function toggle() {
  if (open && mode === 'windows' && !searchTerm) close();
  else if (open) {
    mode = 'windows';
    searchTerm = '';
    if (searchInput) searchInput.value = '';
    render();
  } else openOverview();
}

/** Open the overview directly in the app grid (Super+A / Show Applications). */
export function openAppGrid() {
  if (!open) {
    openOverview({ apps: true });
    return;
  }
  mode = 'apps';
  searchTerm = '';
  if (searchInput) searchInput.value = '';
  render();
}

/** Toggle between the app grid and the window view, closing when already there. */
export function toggleAppGrid() {
  if (open && mode === 'apps' && !searchTerm) {
    close();
    return;
  }
  openAppGrid();
}

/** Focus (opening the overview first when needed) the search entry. */
export function focusSearch() {
  if (!open) openOverview();
  if (searchInput) searchInput.focus();
}

/** @returns {number} the 0-based active workspace */
export function activeWorkspace() {
  return currentWorkspace;
}

/**
 * Build the overview and wire it to the bus. Safe to call more than once.
 * @returns {HTMLElement}
 */
export function install() {
  if (root && root.isConnected) return root;

  searchInput = h('input.ov-search__input', {
    type: 'search',
    placeholder: 'Search',
    'aria-label': 'Search applications and files',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value;
    render();
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const first = resultsPane.querySelector('.ov-app, .ov-result-row');
    if (first) first.click();
  });
  searchInput.addEventListener('click', (ev) => ev.stopPropagation());

  const searchBox = h('div.ov-search', {},
    h('span.ov-search__icon', { 'aria-hidden': 'true' }, svg(ICON.search, { size: 17, strokeWidth: 1.8 })),
    searchInput);

  workspaceStrip = h('div.overview__workspaces', { role: 'tablist', 'aria-label': 'Workspaces' });
  windowsGrid = h('div.overview__grid');
  emptyLabel = h('div.overview__empty', { hidden: true });
  const windowsPane = h('div.overview__windows', {}, windowsGrid, emptyLabel);
  resultsPane = h('div.overview__results', { hidden: true });
  appsPane = h('div.overview__apps', { hidden: true });
  pagerEl = h('div.ov-pager', { role: 'tablist', 'aria-label': 'App grid pages', hidden: true });

  gridToggle = h('button.ov-grid-toggle', {
    type: 'button',
    'aria-label': 'Show Applications',
    'aria-pressed': 'false',
    title: 'Show Applications',
  }, svg(ICON.apps, { size: 20, strokeWidth: 1.7 }));
  gridToggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    mode = mode === 'apps' ? 'windows' : 'apps';
    searchTerm = '';
    if (searchInput) searchInput.value = '';
    render();
  });

  const body = h('div.overview__body', {}, windowsPane, resultsPane, appsPane);
  body.addEventListener('click', onBackgroundClick);
  body.addEventListener('wheel', onWheel, { passive: false });
  windowsPane.addEventListener('click', onBackgroundClick);
  windowsGrid.addEventListener('click', onBackgroundClick);

  const scrim = h('div.overview__scrim', { 'aria-hidden': 'true' });
  scrim.addEventListener('click', () => close());

  root = h('div.overview', {
    id: 'overview',
    role: 'dialog',
    'aria-label': 'Activities',
    'aria-hidden': 'true',
    hidden: true,
  },
  scrim,
  h('div.overview__content', {},
    h('div.overview__head', {}, searchBox),
    workspaceStrip,
    body,
    h('div.overview__foot', {}, pagerEl, gridToggle)));

  document.body.appendChild(root);

  if (!installed) {
    installed = true;
    bus.on('win:open', (payload) => {
      if (payload && payload.instanceId !== undefined) {
        workspaceOf.set(String(payload.instanceId), currentWorkspace);
      }
      if (open) render();
    });
    bus.on('win:close', (payload) => {
      if (payload && payload.instanceId !== undefined) {
        workspaceOf.delete(String(payload.instanceId));
        autoMinimized.delete(String(payload.instanceId));
      }
      if (open) render();
    });
    for (const event of ['win:focus', 'win:minimize', 'win:restore', 'win:maximize', 'win:unmaximize']) {
      bus.on(event, () => {
        if (open) render();
      });
    }
    bus.on('shell:popover', (payload) => {
      if (payload && payload.id === 'session') close();
    });
  }

  return root;
}

/** Alias so `main.js` can import every shell installer side by side. */
export const installOverview = install;

/** Grouped handle used by the dock, the top bar and the keybindings module. */
export const overview = {
  install,
  open: openOverview,
  close,
  toggle,
  isOpen,
  openAppGrid,
  toggleAppGrid,
  focusSearch,
  switchWorkspace,
  activeWorkspace,
  /** @returns {number} */
  workspaceCount: () => WORKSPACE_COUNT,
  /** @returns {HTMLElement|null} */
  get element() {
    return root;
  },
};
