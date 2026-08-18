/**
 * js/apps/trash/index.js — the Nautilus Trash window (ARCHITECTURE §16, §18).
 *
 * Reuses the Files item view component, backed by `fs.listTrash()`. Carries the
 * Nautilus trash bar (Restore All / Empty Trash), per-item Restore and Delete
 * Permanently, and reacts live to `fs:trash` and `fs:change`.
 */

import { fs } from '../../core/fs.js';
import { bus } from '../../core/bus.js';
import { store } from '../../core/store.js';
import { h, clear, on } from '../../core/dom.js';
import { dialog } from '../../core/dialog.js';
import { basename, dirname, join } from '../../core/path.js';
import { createFileView } from '../files/view.js';
import { symbolic, trashIcon } from '../files/icons.js';
import { openProperties } from '../files/properties.js';
import { openTrashMenu, closePopover, openPopover } from '../files/menus.js';
import { kindFor, typeLabelFor, formatSize } from '../files/format.js';
import * as ops from '../files/operations.js';

const HOME = fs.HOME;
const TRASH_FILES = `${fs.TRASH_ROOT}/files`;
const PREFS_KEY = 'trash:prefs';

/** @type {Map<string, object>} instanceId -> controller */
const instances = new Map();

function loadPrefs() {
  const saved = store.get(PREFS_KEY, null);
  return {
    mode: 'list',
    sortKey: 'deleted',
    sortReverse: true,
    ...(saved && typeof saved === 'object' ? saved : {}),
  };
}

function shortOrigin(p) {
  const parent = dirname(p);
  if (parent === HOME) return 'Home';
  if (parent.startsWith(`${HOME}/`)) return `~${parent.slice(HOME.length)}`;
  return parent;
}

function childCount(p) {
  try {
    return fs.readdir(p).length;
  } catch {
    return 0;
  }
}

/**
 * Convert a `fs.listTrash()` record into a view entry.
 * @param {{name:string, originalPath:string, deletedAt:number, type:string, size:number}} item
 * @returns {object}
 */
function entryFromTrash(item) {
  const path = join(TRASH_FILES, item.name);
  const label = basename(item.originalPath) || item.name;
  const isDir = item.type === 'dir';
  let mode = isDir ? 0o755 : 0o644;
  try {
    mode = fs.lstat(path).mode;
  } catch {
    mode = isDir ? 0o755 : 0o644;
  }
  return {
    key: item.name,
    name: item.name,
    label,
    path,
    type: item.type,
    isDir,
    isLink: item.type === 'link',
    broken: false,
    size: item.size,
    sizeLabel: isDir ? `${childCount(path)} ${childCount(path) === 1 ? 'item' : 'items'}` : formatSize(item.size),
    mtime: item.deletedAt,
    deletedAt: item.deletedAt,
    origin: item.originalPath,
    originLabel: shortOrigin(item.originalPath),
    subtitle: item.originalPath,
    mode,
    hidden: label.startsWith('.'),
    kind: kindFor(label, isDir),
    typeLabel: typeLabelFor(label, isDir),
  };
}

function createTrashApp(root, ctx) {
  const prefs = loadPrefs();
  const cleanups = [];
  let refreshTimer = 0;

  root.classList.add('files-root', 'files-root--trash');

  /* --- header bar --------------------------------------------------- */

  function iconButton(iconName, label, handler) {
    const button = h('button.files-btn', { type: 'button', title: label, 'aria-label': label });
    button.appendChild(symbolic(iconName, 16));
    button.addEventListener('click', (ev) => handler(ev, button));
    return button;
  }

  const title = h('div.files-headerbar__title', { text: 'Trash' });
  const viewButton = iconButton(prefs.mode === 'grid' ? 'list' : 'grid', 'Toggle View', () =>
    setMode(prefs.mode === 'grid' ? 'list' : 'grid'),
  );
  const sortButton = iconButton('sort', 'Sort Options', (ev, button) => openSortMenu(button));

  const headerBar = h(
    'div.files-headerbar',
    {},
    h('div.files-headerbar__nav', {}, h('span.files-headerbar__icon', {}, trashIcon(22, true))),
    h('div.files-bar', {}, title),
    h('div.files-headerbar__end', {}, viewButton, sortButton),
  );

  /* --- info bar ------------------------------------------------------ */

  const infoText = h('div.files-infobar__text');
  const restoreButton = h('button.files-infobar__button', { type: 'button', text: 'Restore' });
  const deleteButton = h('button.files-infobar__button.is-destructive', { type: 'button', text: 'Delete Permanently' });
  const restoreAllButton = h('button.files-infobar__button', { type: 'button', text: 'Restore All' });
  const emptyButton = h('button.files-infobar__button.is-destructive', { type: 'button', text: 'Empty Trash' });
  const infoBar = h(
    'div.files-infobar',
    {},
    h('span.files-infobar__icon', {}, symbolic('info', 16)),
    infoText,
    h('div.files-infobar__actions', {}, restoreButton, deleteButton, restoreAllButton, emptyButton),
  );

  /* --- view ----------------------------------------------------------- */

  const view = createFileView({
    mode: prefs.mode,
    variant: 'trash',
    sort: { key: prefs.sortKey, reverse: prefs.sortReverse },
    foldersFirst: false,
    previews: false,
    home: HOME,
    onActivate: (entry) => offerRestore(entry),
    onSelectionChange: () => updateBars(),
    onItemMenu: (entry, x, y) => openTrashMenu(app, entry, x, y),
    onEmptyMenu: (x, y) => openTrashMenu(app, null, x, y),
    onSortChange: (sort) => {
      prefs.sortKey = sort.key;
      prefs.sortReverse = sort.reverse;
      store.set(PREFS_KEY, prefs);
    },
    onDragPaths: () => [],
  });
  view.setEmptyState({ title: 'Trash is Empty', body: '' });

  const statusLeft = h('div.files-status__left');
  const statusRight = h('div.files-status__right');
  const statusBar = h('div.files-status', {}, statusLeft, statusRight);

  root.appendChild(headerBar);
  root.appendChild(h('div.files-layout.files-layout--plain', {}, h('div.files-content', {}, infoBar, view.element, statusBar)));

  /* --- state ---------------------------------------------------------- */

  function items() {
    try {
      return fs.listTrash();
    } catch {
      return [];
    }
  }

  function refresh() {
    const list = items().map(entryFromTrash);
    view.setEntries(list);
    updateBars();
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      refresh();
    }, 40);
  }

  function updateBars() {
    const all = view.entries();
    const selection = view.selection();
    const count = all.length;
    infoText.textContent =
      count === 0
        ? 'Trash is empty'
        : `${count} ${count === 1 ? 'item' : 'items'} in Trash — items keep their original location until restored`;
    infoBar.classList.toggle('has-selection', selection.length > 0);
    restoreButton.hidden = selection.length === 0;
    deleteButton.hidden = selection.length === 0;
    restoreAllButton.hidden = selection.length > 0 || count === 0;
    emptyButton.hidden = selection.length > 0 || count === 0;

    const parts = [`${count} ${count === 1 ? 'item' : 'items'}`];
    if (selection.length > 0) {
      const bytes = selection.reduce((sum, entry) => sum + (entry.size || 0), 0);
      parts.push(`${selection.length} selected (${formatSize(bytes)})`);
    }
    statusLeft.textContent = parts.join(', ');
    let total = 0;
    for (const entry of all) total += entry.size || 0;
    statusRight.textContent = count === 0 ? '' : `Total: ${formatSize(total)}`;
  }

  /* --- actions ---------------------------------------------------------- */

  function selectionNames() {
    return view.selection().map((entry) => entry.key);
  }

  function selectionLabels() {
    return view.selection().map((entry) => entry.label);
  }

  function restoreSelection() {
    const names = selectionNames();
    if (names.length === 0) return;
    void ops.restoreFromTrash(names).then(refresh);
  }

  function restoreAll() {
    const names = view.entries().map((entry) => entry.key);
    if (names.length === 0) return;
    void ops.restoreFromTrash(names).then(refresh);
  }

  function deleteSelection() {
    const names = selectionNames();
    if (names.length === 0) return;
    void ops.deleteFromTrash(names, { labels: selectionLabels() }).then(refresh);
  }

  function emptyTrash() {
    void ops.emptyTrash({ confirm: true }).then(refresh);
  }

  async function offerRestore(entry) {
    const ok = await dialog.confirm({
      title: `Restore “${entry.label}” to open it?`,
      body: `Items in the Trash cannot be opened. “${entry.label}” will be restored to ${shortOrigin(entry.origin)}.`,
      okLabel: 'Restore',
    });
    if (!ok) return;
    await ops.restoreFromTrash([entry.key]);
    refresh();
  }

  function showProperties() {
    const selection = view.selection();
    if (selection.length === 0) return;
    openProperties(selection);
  }

  function setMode(mode) {
    prefs.mode = mode === 'list' ? 'list' : 'grid';
    view.setMode(prefs.mode);
    clear(viewButton);
    viewButton.appendChild(symbolic(prefs.mode === 'grid' ? 'list' : 'grid', 16));
    viewButton.title = prefs.mode === 'grid' ? 'List View' : 'Grid View';
    store.set(PREFS_KEY, prefs);
  }

  function openSortMenu(anchor) {
    const sort = view.sort();
    const box = h('div.files-popover__box');
    box.appendChild(h('div.files-popover__title', { text: 'Sort' }));
    const options = [
      { key: 'name', label: 'Name' },
      { key: 'size', label: 'Size' },
      { key: 'origin', label: 'Original Location' },
      { key: 'deleted', label: 'Deleted' },
    ];
    for (const option of options) {
      const button = h('button.files-popover__row', { type: 'button', role: 'menuitem' });
      const mark = h('span.files-popover__mark');
      if (sort.key === option.key) mark.appendChild(symbolic('check', 14));
      button.appendChild(mark);
      button.appendChild(h('span.files-popover__label', { text: option.label }));
      button.addEventListener('click', () => {
        closePopover();
        prefs.sortKey = option.key;
        view.setSort({ key: option.key, reverse: prefs.sortReverse });
        store.set(PREFS_KEY, prefs);
      });
      box.appendChild(button);
    }
    box.appendChild(h('div.files-popover__separator'));
    const reverse = h('button.files-popover__row', { type: 'button', role: 'menuitem' });
    const reverseMark = h('span.files-popover__mark');
    if (sort.reverse) reverseMark.appendChild(symbolic('check', 14));
    reverse.appendChild(reverseMark);
    reverse.appendChild(h('span.files-popover__label', { text: 'Reverse Order' }));
    reverse.addEventListener('click', () => {
      closePopover();
      prefs.sortReverse = !prefs.sortReverse;
      view.setSort({ key: prefs.sortKey, reverse: prefs.sortReverse });
      store.set(PREFS_KEY, prefs);
    });
    box.appendChild(reverse);
    openPopover(anchor, box, { align: 'end', width: 224 });
  }

  /* --- keyboard ---------------------------------------------------------- */

  function onKeyDown(ev) {
    const target = ev.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (ev.ctrlKey && (ev.key === 'a' || ev.key === 'A')) {
      ev.preventDefault();
      view.selectAll();
      return;
    }
    if (ev.ctrlKey && (ev.key === 'i' || ev.key === 'I')) {
      ev.preventDefault();
      showProperties();
      return;
    }
    if (ev.key === 'Delete') {
      ev.preventDefault();
      deleteSelection();
      return;
    }
    if (ev.key === 'Escape') {
      view.clearSelection();
      return;
    }
    if (ev.key === 'F5') {
      ev.preventDefault();
      refresh();
    }
  }

  /* --- facade for the context menu ----------------------------------------- */

  const app = {
    count: () => view.entries().length,
    selection: () => view.selection(),
    selectAll: () => view.selectAll(),
    restoreSelection,
    restoreAll,
    deleteSelection,
    emptyTrash,
    showProperties,
  };

  restoreButton.addEventListener('click', restoreSelection);
  deleteButton.addEventListener('click', deleteSelection);
  restoreAllButton.addEventListener('click', restoreAll);
  emptyButton.addEventListener('click', emptyTrash);

  cleanups.push(on(root, 'keydown', onKeyDown));
  cleanups.push(
    bus.on('fs:trash', () => scheduleRefresh()),
    bus.on('fs:change', () => scheduleRefresh()),
  );

  setMode(prefs.mode);
  refresh();
  view.focus();
  if (ctx && typeof ctx.setTitle === 'function') ctx.setTitle('Trash');

  return {
    focus: () => view.focus(),
    refresh,
    destroy() {
      if (refreshTimer) clearTimeout(refreshTimer);
      closePopover();
      for (const off of cleanups) off();
      view.destroy();
      clear(root);
    },
  };
}

/* ------------------------------------------------------------------ *
 * app module (ARCHITECTURE §16)
 * ------------------------------------------------------------------ */

export default {
  id: 'trash',
  name: 'Trash',
  genericName: 'Trash',
  icon: () => trashIcon(48, true),
  pinned: true,
  singleton: true,
  width: 820,
  height: 540,
  minWidth: 520,
  minHeight: 320,
  resizable: true,
  themeClass: 'app-trash',
  darkChrome: false,

  mount(root, ctx) {
    instances.set(ctx.instanceId, createTrashApp(root, ctx));
  },

  onFocus(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (instance) {
      instance.refresh();
      instance.focus();
    }
  },

  onBlur() {
    closePopover();
  },

  onResize() {
    closePopover();
  },

  onClose(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (instance) instance.destroy();
    instances.delete(ctx.instanceId);
  },
};
