/**
 * js/apps/files/index.js — Files (Nautilus), ARCHITECTURE §16 and §18.
 *
 * A GNOME 46 Nautilus window: the header bar with real back/forward/up history,
 * a clickable breadcrumb path bar with a Ctrl+L entry mode, search, a grid/list
 * toggle, the sort & view popover and the primary menu; a places sidebar that
 * accepts drops; the shared item view; and a status bar with the item count and
 * free space.
 *
 * Everything is backed by `js/core/fs.js` and re-reads on `fs:change` /
 * `fs:trash`. The pieces live in sibling modules: `headerbar.js`, `sidebar.js`,
 * `view.js`, `model.js`, `operations.js`, `menus.js` and `properties.js`.
 */

import { fs } from '../../core/fs.js';
import { bus } from '../../core/bus.js';
import { store } from '../../core/store.js';
import { h, clear, on } from '../../core/dom.js';
import { dialog } from '../../core/dialog.js';
import { notify } from '../../core/notify.js';
import { wm } from '../../shell/window-manager.js';
import { basename, dirname, join, normalize, isAbsolute, expandTilde, resolve, split } from '../../core/path.js';
import { createFileView } from './view.js';
import { createHeaderBar } from './headerbar.js';
import { createSidebar } from './sidebar.js';
import { folderIcon } from './icons.js';
import * as ops from './operations.js';
import { openProperties, entryForPath } from './properties.js';
import { openSortPopover, openMainMenu, openItemMenu, openEmptyMenu, openPlaceMenu, closePopover } from './menus.js';
import { openerFor, formatSize } from './format.js';
import { OTHER, freeBytes, listEntries, otherLocationEntries, searchEntries, entryFromPath, totalSizeOf } from './model.js';
// Images live in the filesystem as data URLs; the Image Viewer's gallery module
// owns what counts as one and how to turn it into something an <img> can show.
import { looksLikeImage, isImagePath, toDataUrl } from '../imageviewer/gallery.js';

const HOME = fs.HOME;
const PREFS_KEY = 'files:prefs';

/** Candidate app ids, tried in order — `apps/registry.js` owns the real names. */
const EDITOR_IDS = ['text-editor', 'editor', 'texteditor', 'gedit'];
const CODE_IDS = ['code-oss', 'codeoss', 'code', 'vscode'];
const IMAGE_IDS = ['imageviewer', 'image-viewer', 'eog'];
const TERMINAL_IDS = ['terminal', 'gnome-terminal'];
const TRASH_IDS = ['trash'];

/** Largest data URL worth decoding into a grid thumbnail, in characters. */
const THUMB_LIMIT = 4 * 1024 * 1024;

const PLACES = [
  { id: 'home', label: 'Home', icon: 'home', path: HOME, droppable: true },
  { id: 'desktop', label: 'Desktop', icon: 'desktop', path: `${HOME}/Desktop`, droppable: true },
  { id: 'documents', label: 'Documents', icon: 'documents', path: `${HOME}/Documents`, droppable: true },
  { id: 'downloads', label: 'Downloads', icon: 'downloads', path: `${HOME}/Downloads`, droppable: true },
  { id: 'music', label: 'Music', icon: 'music', path: `${HOME}/Music`, droppable: true },
  { id: 'pictures', label: 'Pictures', icon: 'pictures', path: `${HOME}/Pictures`, droppable: true },
  { id: 'videos', label: 'Videos', icon: 'videos', path: `${HOME}/Videos`, droppable: true },
  { id: 'trash', label: 'Trash', icon: 'trash', path: `${fs.TRASH_ROOT}/files`, droppable: true },
  { id: 'other', label: 'Other Locations', icon: 'computer', path: OTHER, droppable: false },
];

/** @type {Map<string, object>} instanceId -> controller */
const instances = new Map();

function loadPrefs() {
  const saved = store.get(PREFS_KEY, null);
  return {
    mode: 'grid',
    sortKey: 'name',
    sortReverse: false,
    showHidden: false,
    foldersFirst: true,
    previews: true,
    confirmTrash: true,
    ...(saved && typeof saved === 'object' ? saved : {}),
  };
}

/** Open the first app id the window manager accepts. */
function openApp(ids, args) {
  for (const id of ids) {
    try {
      const instance = wm.open(id, args);
      if (instance) return instance;
    } catch {
      /* not registered under that id — try the next candidate */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * controller
 * ------------------------------------------------------------------ */

function createFilesApp(root, ctx) {
  const prefs = loadPrefs();
  const state = { location: HOME, history: [HOME], index: 0, query: '' };
  const cleanups = [];
  let refreshTimer = 0;
  let searchTimer = 0;

  const startPath = ctx && ctx.args && typeof ctx.args.path === 'string' ? ctx.args.path : HOME;
  if (fs.isDir(startPath)) {
    state.location = normalize(startPath);
    state.history = [state.location];
  }

  root.classList.add('files-root');

  /* --- header bar -------------------------------------------------- */

  const header = createHeaderBar({
    mode: prefs.mode,
    onBack: () => goBack(),
    onForward: () => goForward(),
    onUp: () => goUp(),
    onCrumb: (p) => navigate(p),
    onPathSubmit: (typed) => submitPath(typed),
    onPathCancel: () => {
      header.setBarMode('crumbs');
      view.focus();
    },
    onSearchToggle: () => toggleSearch(),
    onSearchInput: (text) => {
      state.query = text;
      scheduleSearch();
    },
    onSearchCancel: () => {
      header.setBarMode('crumbs');
      state.query = '';
      refresh();
      view.focus();
    },
    onSearchDown: () => view.focus(),
    onToggleView: () => setMode(prefs.mode === 'grid' ? 'list' : 'grid'),
    onSortMenu: (anchor) => openSortPopover(app, anchor),
    onMainMenu: (anchor) => openMainMenu(app, anchor),
  });

  /* --- sidebar ------------------------------------------------------ */

  const sidebar = createSidebar({
    places: PLACES,
    separatorBefore: ['other'],
    onActivate: (place) => activatePlace(place),
    onMenu: (place, x, y) => openPlaceMenu(app, place, x, y),
    onDrop: (place, paths, ev) => {
      if (place.id === 'trash') void ops.moveToTrash(paths).then(refresh);
      else if (ev.ctrlKey) void ops.copyPathsInto(paths, place.path).then(refresh);
      else void ops.movePaths(paths, place.path).then(refresh);
    },
  });

  function activatePlace(place) {
    if (place.id === 'trash') {
      openApp(TRASH_IDS, {});
      return;
    }
    if (place.id === 'other') {
      navigate(OTHER);
      return;
    }
    if (!fs.isDir(place.path)) {
      void dialog.alert({
        title: `Could not find “${place.label}”`,
        body: `${place.path}: No such file or directory`,
      });
      return;
    }
    navigate(place.path);
  }

  /* --- item view ----------------------------------------------------- */

  const view = createFileView({
    mode: prefs.mode,
    variant: 'files',
    sort: { key: prefs.sortKey, reverse: prefs.sortReverse },
    foldersFirst: prefs.foldersFirst,
    previews: prefs.previews,
    home: HOME,
    onActivate: (entry) => openEntry(entry),
    onSelectionChange: () => updateStatus(),
    onItemMenu: (entry, x, y) => openItemMenu(app, entry, x, y),
    onEmptyMenu: (x, y) => openEmptyMenu(app, x, y),
    onSortChange: (sort) => {
      prefs.sortKey = sort.key;
      prefs.sortReverse = sort.reverse;
      persistPrefs();
    },
    onRenameCommit: (entry, name) => {
      void ops.renamePath(entry.path, name).then(refresh);
    },
    onDrop: (target, paths, ev) => {
      const destination = target ? target.path : state.location;
      if (state.location === OTHER || !fs.isDir(destination)) return;
      if (ev.ctrlKey) void ops.copyPathsInto(paths, destination).then(refresh);
      else void ops.movePaths(paths, destination).then(refresh);
    },
    onTypeSearch: (char) => {
      header.setBarMode('search');
      header.setSearchValue(char);
      state.query = char;
      scheduleSearch();
    },
  });

  /* --- status bar ----------------------------------------------------- */

  const statusLeft = h('div.files-status__left');
  const statusRight = h('div.files-status__right');
  const statusBar = h('div.files-status', {}, statusLeft, statusRight);

  root.appendChild(header.element);
  root.appendChild(
    h('div.files-layout', {}, sidebar.element, h('div.files-content', {}, view.element, statusBar)),
  );

  /* --- location ---------------------------------------------------- */

  function crumbSegments(location) {
    if (location === OTHER) return [{ label: 'Other Locations', path: OTHER, icon: 'computer' }];
    const out = [];
    if (location === HOME || location.startsWith(`${HOME}/`)) {
      out.push({ label: 'Home', path: HOME, icon: 'home' });
      let acc = HOME;
      for (const segment of split(location.slice(HOME.length))) {
        acc = join(acc, segment);
        out.push({ label: segment, path: acc });
      }
      return out;
    }
    out.push({ label: 'Computer', path: '/', icon: 'drive' });
    let acc = '';
    for (const segment of split(location)) {
      acc = `${acc}/${segment}`;
      out.push({ label: segment, path: acc });
    }
    return out;
  }

  function submitPath(typed) {
    const expanded = expandTilde(typed, HOME);
    const target = isAbsolute(expanded) ? normalize(expanded) : resolve(state.location, expanded);
    if (fs.isDir(target)) {
      header.setBarMode('crumbs');
      navigate(target);
      view.focus();
      return;
    }
    if (fs.isFile(target)) {
      header.setBarMode('crumbs');
      const entry = entryFromPath(target);
      if (entry) openEntry(entry);
      return;
    }
    void dialog.alert({ title: 'Unable to access location', body: `${target}: No such file or directory` });
  }

  function pathEntryValue() {
    if (state.location === OTHER) return '/';
    return state.location === '/' ? '/' : `${state.location}/`;
  }

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = 0;
      refresh();
    }, 160);
  }

  function toggleSearch() {
    if (header.barMode() === 'search') {
      header.setBarMode('crumbs');
      state.query = '';
      refresh();
      view.focus();
    } else {
      header.setBarMode('search');
      refresh();
    }
  }

  /* --- navigation ---------------------------------------------------- */

  function navigate(target, { push = true } = {}) {
    const next = target === OTHER ? OTHER : normalize(target);
    if (next !== OTHER && !fs.isDir(next)) {
      void dialog.alert({ title: 'Unable to access location', body: `${next}: No such file or directory` });
      return;
    }
    state.location = next;
    if (push) {
      state.history = state.history.slice(0, state.index + 1);
      if (state.history[state.index] !== next) {
        state.history.push(next);
        state.index = state.history.length - 1;
      }
    }
    if (header.barMode() === 'search') {
      header.setBarMode('crumbs');
      state.query = '';
    }
    view.clearSelection();
    view.resetScroll();
    refresh();
    setWindowTitle();
  }

  function setWindowTitle() {
    if (!ctx || typeof ctx.setTitle !== 'function') return;
    if (state.location === OTHER) ctx.setTitle('Other Locations');
    else if (state.location === HOME) ctx.setTitle('Home');
    else ctx.setTitle(basename(state.location) || '/');
  }

  function goBack() {
    if (state.index <= 0) return;
    state.index -= 1;
    navigate(state.history[state.index], { push: false });
  }

  function goForward() {
    if (state.index >= state.history.length - 1) return;
    state.index += 1;
    navigate(state.history[state.index], { push: false });
  }

  function goUp() {
    if (state.location === OTHER) return;
    if (state.location === '/') {
      navigate(OTHER);
      return;
    }
    navigate(dirname(state.location));
  }

  /* --- listing --------------------------------------------------------- */

  function currentEntries() {
    if (header.barMode() === 'search') {
      const base = state.location === OTHER ? HOME : state.location;
      return searchEntries(base, state.query, { showHidden: prefs.showHidden });
    }
    if (state.location === OTHER) return otherLocationEntries();
    return listEntries(state.location, prefs.showHidden);
  }

  function updateStatus() {
    const total = view.entries().length;
    const selection = view.selection();
    const parts = [`${total} ${total === 1 ? 'item' : 'items'}`];
    if (selection.length > 0) {
      parts.push(`${selection.length} selected (${formatSize(totalSizeOf(selection))})`);
    }
    statusLeft.textContent = parts.join(', ');
    statusRight.textContent = `Free space: ${formatSize(freeBytes())}`;
  }

  function ensureLocationExists() {
    if (state.location === OTHER || fs.isDir(state.location)) return;
    let candidate = dirname(state.location);
    while (candidate !== '/' && !fs.isDir(candidate)) candidate = dirname(candidate);
    state.location = fs.isDir(candidate) ? candidate : HOME;
    state.history = state.history.filter((p) => p === OTHER || fs.isDir(p));
    if (state.history.length === 0) state.history = [state.location];
    state.index = Math.max(0, Math.min(state.index, state.history.length - 1));
    setWindowTitle();
  }

  function updateEmptyState() {
    if (header.barMode() === 'search') {
      view.setEmptyState(
        state.query.trim() === ''
          ? { title: 'Search the Current Folder', body: 'Type to filter the files below this folder.' }
          : { title: 'No Results Found', body: 'Try a different search.' },
      );
    } else if (state.location === OTHER) {
      view.setEmptyState({ title: 'No Locations Found', body: '' });
    } else {
      view.setEmptyState({ title: 'Folder is Empty', body: '' });
    }
  }

  function refresh() {
    ensureLocationExists();
    updateEmptyState();
    view.setEntries(currentEntries());
    header.setCrumbs(crumbSegments(state.location));
    header.setNavState({
      back: state.index > 0,
      forward: state.index < state.history.length - 1,
      up: state.location !== OTHER,
    });
    sidebar.setActive(header.barMode() === 'search' ? '' : state.location);
    updateStatus();
    decorateThumbnails();
  }

  /* --- image thumbnails ------------------------------------------------ */

  /**
   * Grid icons for image files are replaced with the picture itself, the way
   * Nautilus shows a real thumbnail rather than the generic mimetype icon.
   *
   * The view module owns its own rendering, so the swap is done afterwards on
   * the elements it produced and is re-applied by a `MutationObserver` whenever
   * the view redraws (sorting, renaming, mode switches).
   *
   * `path\0mtime` keys the cache, so an edited file gets a fresh thumbnail.
   * @type {Map<string, string|null>}
   */
  const thumbCache = new Map();

  function thumbUrlFor(entry) {
    const key = `${entry.path}\0${entry.mtime}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    let url = null;
    if (Number(entry.size) <= THUMB_LIMIT && isImagePath(entry.path)) url = toDataUrl(entry.path);
    if (thumbCache.size > 240) thumbCache.clear();
    thumbCache.set(key, url);
    return url;
  }

  function decorateThumbnails() {
    if (!prefs.previews || view.mode() !== 'grid') return;
    const byKey = new Map(view.entries().map((entry) => [entry.key, entry]));

    for (const item of view.element.querySelectorAll('.files-item--grid')) {
      const box = item.querySelector('.files-icon-box');
      if (!box || box.dataset.imageThumb === '1') continue;
      const entry = byKey.get(item.dataset.key);
      if (!entry || !isImageEntry(entry)) continue;
      const url = thumbUrlFor(entry);
      if (!url) continue;

      box.dataset.imageThumb = '1';
      // Drop the generic icon but keep the symlink emblem drawn over it.
      for (const child of Array.from(box.children)) {
        if (!child.classList || !child.classList.contains('files-icon__emblem')) child.remove();
      }
      box.insertBefore(
        h(
          'div.files-image-thumb',
          {},
          h('img.files-image-thumb__img', {
            src: url,
            alt: '',
            decoding: 'async',
            draggable: 'false',
          }),
        ),
        box.firstChild,
      );
    }
  }

  const thumbObserver =
    typeof MutationObserver === 'function' ? new MutationObserver(() => decorateThumbnails()) : null;

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      refresh();
    }, 40);
  }

  /* --- opening ---------------------------------------------------------- */

  function openEntry(entry) {
    if (!entry) return;
    if (entry.isDir) {
      navigate(entry.path);
      return;
    }
    if (entry.broken) {
      void dialog.alert({
        title: `Could not display “${entry.label}”`,
        body: 'The link is broken: the file it points to no longer exists.',
      });
      return;
    }
    // Images go to the Image Viewer, never to a text editor that would show
    // the raw data URL.
    if (isImageEntry(entry)) {
      openEntryWith(entry, 'image');
      return;
    }
    const opener = openerFor(entry.name);
    if (opener === null) {
      reportNoApplication(entry);
      return;
    }
    openEntryWith(entry, opener);
  }

  /**
   * @param {object} entry
   * @returns {boolean} true when the Image Viewer can display it
   */
  function isImageEntry(entry) {
    if (!entry || entry.isDir || entry.broken) return false;
    return looksLikeImage(entry.path, entry.name);
  }

  function openEntryWith(entry, which) {
    const ids = which === 'code' ? CODE_IDS : which === 'image' ? IMAGE_IDS : EDITOR_IDS;
    const instance = openApp(ids, {
      path: entry.path,
      file: entry.path,
    });
    if (!instance) {
      void dialog.alert({
        title: 'Could not open the file',
        body: `No application is registered to open “${entry.label}”.`,
      });
    }
  }

  function reportNoApplication(entry) {
    void dialog.alert({
      title: `Could not display “${entry.label}”`,
      body: `There is no application installed for “${entry.typeLabel}” files.`,
    });
  }

  function openTerminalAt(p) {
    const instance = openApp(TERMINAL_IDS, { cwd: p, path: p });
    if (!instance) notify.show({ app: 'Files', title: 'Terminal is not available', timeout: 3000 });
  }

  /* --- operations --------------------------------------------------------- */

  function selectionPaths() {
    return view.selection().map((entry) => entry.path);
  }

  function copySelection() {
    const paths = selectionPaths();
    if (paths.length > 0) ops.copyPaths(paths);
  }

  function cutSelection() {
    const paths = selectionPaths();
    if (paths.length > 0) ops.cutPaths(paths);
  }

  function pasteInto(dir) {
    if (fs.isDir(dir)) void ops.pasteInto(dir).then(refresh);
  }

  function pasteHere() {
    if (state.location !== OTHER) pasteInto(state.location);
  }

  function trashSelection() {
    const paths = selectionPaths();
    if (paths.length > 0) void ops.moveToTrash(paths).then(refresh);
  }

  function deleteSelection() {
    const paths = selectionPaths();
    if (paths.length > 0) void ops.deletePermanently(paths).then(refresh);
  }

  async function createAndRename(maker) {
    if (state.location === OTHER) return;
    const created = await maker(state.location);
    refresh();
    if (!created) return;
    const key = basename(created);
    view.setSelection([key]);
    view.beginRename(key);
  }

  function showProperties() {
    const selection = view.selection();
    if (selection.length === 0) showFolderProperties();
    else openProperties(selection);
  }

  function showFolderProperties() {
    if (state.location === OTHER) return;
    const entry = entryForPath(state.location);
    if (entry) openProperties([entry]);
  }

  /* --- preferences ---------------------------------------------------------- */

  function persistPrefs() {
    store.set(PREFS_KEY, prefs);
  }

  function setMode(mode) {
    prefs.mode = mode === 'list' ? 'list' : 'grid';
    view.setMode(prefs.mode);
    header.setViewIcon(prefs.mode);
    persistPrefs();
  }

  function setShowHidden(value) {
    prefs.showHidden = Boolean(value);
    persistPrefs();
    refresh();
  }

  function setFoldersFirst(value) {
    prefs.foldersFirst = Boolean(value);
    view.setFoldersFirst(prefs.foldersFirst);
    persistPrefs();
  }

  function setPreviews(value) {
    prefs.previews = Boolean(value);
    view.setPreviews(prefs.previews);
    persistPrefs();
  }

  function setConfirmTrash(value) {
    prefs.confirmTrash = Boolean(value);
    persistPrefs();
  }

  function setSortKey(key) {
    prefs.sortKey = key;
    view.setSort({ key, reverse: prefs.sortReverse });
    persistPrefs();
  }

  function setSortReverse(value) {
    prefs.sortReverse = Boolean(value);
    view.setSort({ key: prefs.sortKey, reverse: prefs.sortReverse });
    persistPrefs();
  }

  /* --- keyboard ------------------------------------------------------------- */

  function isTyping(target) {
    return Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
  }

  function onCtrlKey(ev) {
    switch (ev.key) {
      case 'a':
      case 'A':
        view.selectAll();
        return true;
      case 'c':
      case 'C':
        copySelection();
        return true;
      case 'x':
      case 'X':
        cutSelection();
        return true;
      case 'v':
      case 'V':
        pasteHere();
        return true;
      case 'z':
      case 'Z':
        void ops.undo().then(refresh);
        return true;
      case 'h':
      case 'H':
        setShowHidden(!prefs.showHidden);
        return true;
      case 'f':
      case 'F':
        if (header.barMode() !== 'search') toggleSearch();
        else header.focusSearch();
        return true;
      case 'l':
      case 'L':
        header.setBarMode('path', pathEntryValue());
        return true;
      case 'i':
      case 'I':
        showProperties();
        return true;
      case 'r':
      case 'R':
        refresh();
        return true;
      case '1':
        setMode('list');
        return true;
      case '2':
        setMode('grid');
        return true;
      default:
        return false;
    }
  }

  function onKeyDown(ev) {
    if (isTyping(ev.target) || view.isRenaming()) return;

    if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp')) {
      ev.preventDefault();
      if (ev.key === 'ArrowLeft') goBack();
      else if (ev.key === 'ArrowRight') goForward();
      else goUp();
      return;
    }
    if (ev.ctrlKey && ev.shiftKey && (ev.key === 'N' || ev.key === 'n')) {
      ev.preventDefault();
      void createAndRename(ops.createFolder);
      return;
    }
    if (ev.ctrlKey && !ev.altKey && !ev.shiftKey && onCtrlKey(ev)) {
      ev.preventDefault();
      return;
    }

    switch (ev.key) {
      case 'F2':
        ev.preventDefault();
        view.renameSelected();
        return;
      case 'F5':
        ev.preventDefault();
        refresh();
        return;
      case 'Delete':
        ev.preventDefault();
        if (ev.shiftKey) deleteSelection();
        else trashSelection();
        return;
      case 'Escape':
        if (header.barMode() !== 'crumbs') {
          header.setBarMode('crumbs');
          state.query = '';
          refresh();
        } else {
          view.clearSelection();
        }
        return;
      case 'Backspace':
        ev.preventDefault();
        goUp();
        return;
      default:
        break;
    }
  }

  /* --- facade used by the menus ------------------------------------------------ */

  const app = {
    navigate,
    refresh,
    sort: () => view.sort(),
    setSortKey,
    setSortReverse,
    prefs: () => ({ ...prefs }),
    setShowHidden,
    setFoldersFirst,
    setPreviews,
    setConfirmTrash,
    mode: () => view.mode(),
    setMode,
    selection: () => view.selection(),
    selectAll: () => view.selectAll(),
    canPaste: () => ops.hasClipboard(),
    copySelection,
    cutSelection,
    pasteHere,
    pasteInto,
    renameSelected: () => view.renameSelected(),
    trashSelection,
    deleteSelection,
    newFolder: () => void createAndRename(ops.createFolder),
    newDocument: () => void createAndRename(ops.createDocument),
    undo: () => void ops.undo().then(refresh),
    showProperties,
    showFolderProperties,
    openEntry,
    openEntryWith,
    isImageEntry,
    openSelection: () => {
      for (const entry of view.selection().slice(0, 8)) openEntry(entry);
    },
    openInNewWindow: (entry) => openApp(['files'], { path: entry.path }),
    openPathInNewWindow: (p) => openApp(['files'], { path: p }),
    openTerminalAt,
    openTerminalHere: () => openTerminalAt(state.location === OTHER ? HOME : state.location),
    reportNoApplication,
    emptyTrash: () => void ops.emptyTrash({ confirm: prefs.confirmTrash }).then(refresh),
  };

  /* --- start ---------------------------------------------------------------- */

  cleanups.push(on(root, 'keydown', onKeyDown));
  cleanups.push(bus.on('fs:change', scheduleRefresh), bus.on('fs:trash', scheduleRefresh));
  if (thumbObserver) {
    thumbObserver.observe(view.element, { childList: true, subtree: true });
    cleanups.push(() => thumbObserver.disconnect());
  }

  header.setViewIcon(prefs.mode);
  header.setBarMode('crumbs');
  refresh();
  setWindowTitle();

  if (ctx && ctx.args && typeof ctx.args.search === 'string' && ctx.args.search !== '') {
    header.setBarMode('search');
    header.setSearchValue(ctx.args.search);
    state.query = ctx.args.search;
    refresh();
  } else {
    view.focus();
  }

  return {
    focus: () => view.focus(),
    refresh,
    destroy() {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (searchTimer) clearTimeout(searchTimer);
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
  id: 'files',
  name: 'Files',
  genericName: 'File Manager',
  icon: () => folderIcon(48),
  pinned: true,
  singleton: false,
  width: 960,
  height: 620,
  minWidth: 600,
  minHeight: 360,
  resizable: true,
  themeClass: 'app-files',
  darkChrome: false,

  mount(root, ctx) {
    instances.set(ctx.instanceId, createFilesApp(root, ctx));
  },

  onFocus(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (instance) instance.focus();
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
