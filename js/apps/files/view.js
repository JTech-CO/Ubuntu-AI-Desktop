/**
 * js/apps/files/view.js — the reusable Nautilus item view.
 *
 * One component renders both the icon grid (96px Yaru icons, two-line labels,
 * text-preview thumbnails) and the sortable list, and owns everything that is
 * purely about *displaying and selecting* items: selection semantics, the
 * rubber-band marquee, keyboard navigation, inline rename and drag and drop.
 *
 * It knows nothing about the filesystem — the host app feeds it normalized
 * entries and reacts to the callbacks. Files and Trash both use it.
 *
 * Entry shape (produced by the host):
 * ```
 * { key, name, label, path, type, isDir, isLink, broken, size, sizeLabel,
 *   mtime, mode, hidden, kind, typeLabel, origin?, deletedAt?, subtitle? }
 * ```
 */

import { h, clear } from '../../core/dom.js';
import { entryIcon } from './icons.js';
import { compareEntries, formatSize, formatModified } from './format.js';

const DRAG_TYPE = 'application/x-uad-paths';
const MARQUEE_THRESHOLD = 4;

/** Column presets. `value` returns a plain string rendered with textContent. */
const COLUMN_SETS = {
  files: [
    { key: 'name', label: 'Name', grow: true, value: (e) => e.label },
    { key: 'size', label: 'Size', width: '110px', align: 'end', value: (e) => e.sizeLabel || formatSize(e.size) },
    { key: 'type', label: 'Type', width: '180px', value: (e) => e.typeLabel },
    { key: 'modified', label: 'Modified', width: '120px', value: (e) => formatModified(e.mtime) },
  ],
  trash: [
    { key: 'name', label: 'Name', grow: true, value: (e) => e.label },
    { key: 'size', label: 'Size', width: '110px', align: 'end', value: (e) => e.sizeLabel || formatSize(e.size) },
    { key: 'origin', label: 'Original Location', width: '230px', value: (e) => e.originLabel || e.origin || '' },
    { key: 'deleted', label: 'Deleted', width: '120px', value: (e) => formatModified(e.deletedAt) },
  ],
};

function noop() {}

/**
 * Build an item view.
 *
 * @param {{
 *   mode?: 'grid'|'list',
 *   variant?: 'files'|'trash',
 *   sort?: {key:string, reverse:boolean},
 *   foldersFirst?: boolean,
 *   previews?: boolean,
 *   iconSize?: number,
 *   home?: string,
 *   onActivate?: (entry: object, ev: Event) => void,
 *   onSelectionChange?: (entries: object[]) => void,
 *   onItemMenu?: (entry: object, x: number, y: number) => void,
 *   onEmptyMenu?: (x: number, y: number) => void,
 *   onSortChange?: (sort: {key:string, reverse:boolean}) => void,
 *   onRenameCommit?: (entry: object, name: string) => void,
 *   onDrop?: (target: object|null, paths: string[], ev: DragEvent) => void,
 *   onDragPaths?: (entries: object[]) => string[],
 *   onTypeSearch?: (char: string) => void,
 * }} options
 * @returns {object} the view handle
 */
export function createFileView(options = {}) {
  const opts = {
    mode: 'grid',
    variant: 'files',
    foldersFirst: true,
    previews: true,
    iconSize: 96,
    onActivate: noop,
    onSelectionChange: noop,
    onItemMenu: noop,
    onEmptyMenu: noop,
    onSortChange: noop,
    onRenameCommit: noop,
    onDrop: noop,
    onDragPaths: null,
    onTypeSearch: null,
    ...options,
  };

  let columns = COLUMN_SETS[opts.variant] || COLUMN_SETS.files;
  let sort = { key: 'name', reverse: false, ...(opts.sort || {}) };
  let mode = opts.mode === 'list' ? 'list' : 'grid';
  let source = [];
  let ordered = [];
  /** @type {Set<string>} selected entry keys */
  const selected = new Set();
  /** @type {Map<string, HTMLElement>} key -> item element */
  const nodes = new Map();
  let cursor = -1;
  let anchor = -1;
  let emptyState = { title: 'Folder is Empty', body: '' };
  let renaming = null;
  let pendingClick = null;
  let marquee = null;
  let destroyed = false;

  /* --- structure ------------------------------------------------- */

  const header = h('div.files-list__header', { role: 'row' });
  const body = h('div.files-view__body');
  const rubber = h('div.files-rubber', { hidden: true });
  const emptyBox = h('div.files-empty');
  // `rubber` lives inside `body` so its absolute coordinates share the items'
  // containing block and stay correct while the view is scrolled; the column
  // header sits inside the scroller (sticky) so it always lines up with the
  // rows, scrollbar or not.
  const scroller = h('div.files-view__scroller', {}, header, body, emptyBox);
  const element = h('div.files-view', { tabindex: '0', role: 'listbox', 'aria-label': 'Files' }, scroller);

  /* --- helpers --------------------------------------------------- */

  function entryFor(key) {
    return ordered.find((e) => e.key === key) || null;
  }

  function selectedEntries() {
    return ordered.filter((e) => selected.has(e.key));
  }

  function emitSelection() {
    opts.onSelectionChange(selectedEntries());
  }

  function applyOrder() {
    ordered = source.slice().sort((a, b) => compareEntries(a, b, sort.key, sort.reverse, opts.foldersFirst));
    for (const key of Array.from(selected)) {
      if (!ordered.some((e) => e.key === key)) selected.delete(key);
    }
    if (cursor >= ordered.length) cursor = ordered.length - 1;
  }

  function markSelection() {
    for (const [key, node] of nodes) {
      const on = selected.has(key);
      node.classList.toggle('is-selected', on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const current = cursor >= 0 && ordered[cursor] ? nodes.get(ordered[cursor].key) : null;
    for (const node of nodes.values()) node.classList.toggle('is-cursor', node === current);
  }

  /* --- rendering ------------------------------------------------- */

  function buildGridItem(entry) {
    const item = h('div.files-item.files-item--grid', {
      dataset: { key: entry.key },
      role: 'option',
      draggable: 'true',
      title: entry.subtitle ? `${entry.label}\n${entry.subtitle}` : entry.label,
    });
    item.appendChild(entryIcon(entry, { size: opts.iconSize, previews: opts.previews, home: opts.home }));
    const label = h('div.files-item__label', { text: entry.label });
    item.appendChild(label);
    return item;
  }

  function buildListItem(entry) {
    const item = h('div.files-item.files-item--row', {
      dataset: { key: entry.key },
      role: 'option',
      draggable: 'true',
      title: entry.subtitle ? `${entry.label}\n${entry.subtitle}` : entry.label,
    });
    for (const column of columns) {
      const cell = h('div.files-cell', { dataset: { column: column.key } });
      if (column.grow) cell.classList.add('files-cell--grow');
      if (column.align === 'end') cell.classList.add('files-cell--end');
      if (!column.grow) cell.style.width = column.width || '120px';
      if (column.key === 'name') {
        cell.appendChild(entryIcon(entry, { size: 16, previews: false, home: opts.home }));
        cell.appendChild(h('span.files-cell__text', { text: column.value(entry) }));
      } else {
        cell.appendChild(h('span.files-cell__text', { text: column.value(entry) }));
      }
      item.appendChild(cell);
    }
    return item;
  }

  function renderHeader() {
    clear(header);
    header.hidden = mode !== 'list';
    if (mode !== 'list') return;
    for (const column of columns) {
      const button = h('button.files-list__col', {
        type: 'button',
        dataset: { sort: column.key },
      });
      button.appendChild(h('span', { text: column.label }));
      button.appendChild(h('span.files-list__sortmark', { text: sort.reverse ? '▾' : '▴' }));
      if (column.grow) button.classList.add('files-list__col--grow');
      else button.style.width = column.width || '120px';
      if (column.align === 'end') button.classList.add('files-list__col--end');
      if (sort.key === column.key) button.classList.add('is-active');
      button.addEventListener('click', () => {
        const next = sort.key === column.key ? { key: column.key, reverse: !sort.reverse } : { key: column.key, reverse: false };
        setSort(next);
        opts.onSortChange({ ...next });
      });
      header.appendChild(button);
    }
  }

  function render() {
    if (destroyed) return;
    commitRename(false);
    clear(body);
    nodes.clear();
    body.classList.toggle('files-grid', mode === 'grid');
    body.classList.toggle('files-list', mode === 'list');
    element.classList.toggle('files-view--grid', mode === 'grid');
    element.classList.toggle('files-view--list', mode === 'list');
    renderHeader();
    body.appendChild(rubber);

    const frag = document.createDocumentFragment();
    for (const entry of ordered) {
      const node = mode === 'grid' ? buildGridItem(entry) : buildListItem(entry);
      nodes.set(entry.key, node);
      frag.appendChild(node);
    }
    body.appendChild(frag);

    clear(emptyBox);
    if (ordered.length === 0) {
      emptyBox.hidden = false;
      emptyBox.appendChild(h('div.files-empty__title', { text: emptyState.title }));
      if (emptyState.body) emptyBox.appendChild(h('div.files-empty__body', { text: emptyState.body }));
    } else {
      emptyBox.hidden = true;
    }
    markSelection();
  }

  /* --- selection ------------------------------------------------- */

  function setSelectionKeys(keys) {
    selected.clear();
    for (const key of keys) selected.add(key);
    markSelection();
    emitSelection();
  }

  function selectIndex(index, { additive = false, range = false } = {}) {
    if (index < 0 || index >= ordered.length) return;
    const entry = ordered[index];
    if (range && anchor >= 0) {
      const from = Math.min(anchor, index);
      const to = Math.max(anchor, index);
      if (!additive) selected.clear();
      for (let i = from; i <= to; i += 1) selected.add(ordered[i].key);
    } else if (additive) {
      if (selected.has(entry.key)) selected.delete(entry.key);
      else selected.add(entry.key);
      anchor = index;
    } else {
      selected.clear();
      selected.add(entry.key);
      anchor = index;
    }
    cursor = index;
    markSelection();
    emitSelection();
  }

  function scrollIntoView(index) {
    const entry = ordered[index];
    if (!entry) return;
    const node = nodes.get(entry.key);
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }

  /* --- pointer --------------------------------------------------- */

  function indexOfNode(node) {
    const key = node && node.dataset ? node.dataset.key : '';
    return ordered.findIndex((e) => e.key === key);
  }

  function onMouseDown(ev) {
    if (ev.button === 1) return;
    element.focus({ preventScroll: true });
    const item = ev.target.closest ? ev.target.closest('.files-item') : null;

    if (!item) {
      if (ev.button === 0 && !ev.ctrlKey && !ev.shiftKey) {
        setSelectionKeys([]);
        cursor = -1;
        anchor = -1;
        markSelection();
      }
      if (ev.button === 0) startMarquee(ev);
      return;
    }

    const index = indexOfNode(item);
    if (index < 0) return;
    const entry = ordered[index];

    if (ev.button === 2) {
      if (!selected.has(entry.key)) selectIndex(index, {});
      return;
    }
    if (ev.ctrlKey) {
      selectIndex(index, { additive: true });
      return;
    }
    if (ev.shiftKey) {
      selectIndex(index, { range: true });
      return;
    }
    if (selected.has(entry.key) && selected.size > 1) {
      // Defer to mouseup so dragging a multi-selection keeps it intact.
      pendingClick = index;
      return;
    }
    selectIndex(index, {});
  }

  function onMouseUp(ev) {
    if (pendingClick === null) return;
    const item = ev.target.closest ? ev.target.closest('.files-item') : null;
    const index = pendingClick;
    pendingClick = null;
    if (item && indexOfNode(item) === index && !ev.ctrlKey && !ev.shiftKey) selectIndex(index, {});
  }

  function onDoubleClick(ev) {
    const item = ev.target.closest ? ev.target.closest('.files-item') : null;
    if (!item) return;
    const index = indexOfNode(item);
    if (index < 0) return;
    pendingClick = null;
    opts.onActivate(ordered[index], ev);
  }

  function onContextMenu(ev) {
    ev.preventDefault();
    const item = ev.target.closest ? ev.target.closest('.files-item') : null;
    if (item) {
      const index = indexOfNode(item);
      if (index >= 0) {
        if (!selected.has(ordered[index].key)) selectIndex(index, {});
        opts.onItemMenu(ordered[index], ev.clientX, ev.clientY);
        return;
      }
    }
    opts.onEmptyMenu(ev.clientX, ev.clientY);
  }

  /* --- marquee --------------------------------------------------- */

  function bodyPoint(ev) {
    const rect = body.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function startMarquee(ev) {
    const origin = bodyPoint(ev);
    marquee = {
      origin,
      additive: ev.ctrlKey || ev.shiftKey,
      base: new Set(selected),
      active: false,
      move: null,
      up: null,
    };
    marquee.move = (moveEv) => {
      if (!marquee) return;
      const point = bodyPoint(moveEv);
      const dx = point.x - marquee.origin.x;
      const dy = point.y - marquee.origin.y;
      if (!marquee.active && Math.abs(dx) < MARQUEE_THRESHOLD && Math.abs(dy) < MARQUEE_THRESHOLD) return;
      marquee.active = true;
      moveEv.preventDefault();
      const left = Math.min(marquee.origin.x, point.x);
      const top = Math.min(marquee.origin.y, point.y);
      const width = Math.abs(dx);
      const height = Math.abs(dy);
      rubber.hidden = false;
      rubber.style.left = `${left}px`;
      rubber.style.top = `${top}px`;
      rubber.style.width = `${width}px`;
      rubber.style.height = `${height}px`;

      const next = marquee.additive ? new Set(marquee.base) : new Set();
      for (const entry of ordered) {
        const node = nodes.get(entry.key);
        if (!node) continue;
        const hit =
          node.offsetLeft < left + width &&
          node.offsetLeft + node.offsetWidth > left &&
          node.offsetTop < top + height &&
          node.offsetTop + node.offsetHeight > top;
        if (hit) next.add(entry.key);
      }
      selected.clear();
      for (const key of next) selected.add(key);
      markSelection();
    };
    marquee.up = () => {
      if (!marquee) return;
      window.removeEventListener('mousemove', marquee.move, true);
      window.removeEventListener('mouseup', marquee.up, true);
      const wasActive = marquee.active;
      marquee = null;
      rubber.hidden = true;
      rubber.style.width = '0px';
      rubber.style.height = '0px';
      if (wasActive) emitSelection();
    };
    window.addEventListener('mousemove', marquee.move, true);
    window.addEventListener('mouseup', marquee.up, true);
  }

  /* --- keyboard -------------------------------------------------- */

  function columnsPerRow() {
    if (mode === 'list' || ordered.length === 0) return 1;
    const firstNode = nodes.get(ordered[0].key);
    if (!firstNode) return 1;
    const top = firstNode.offsetTop;
    let count = 0;
    for (const entry of ordered) {
      const node = nodes.get(entry.key);
      if (!node) continue;
      if (node.offsetTop !== top) break;
      count += 1;
    }
    return Math.max(1, count);
  }

  function moveCursor(delta, ev) {
    if (ordered.length === 0) return;
    const start = cursor < 0 ? (delta > 0 ? -1 : ordered.length) : cursor;
    let next = start + delta;
    if (next < 0) next = 0;
    if (next > ordered.length - 1) next = ordered.length - 1;
    if (ev.shiftKey) {
      if (anchor < 0) anchor = cursor < 0 ? next : cursor;
      selectIndex(next, { range: true });
    } else {
      selectIndex(next, {});
    }
    scrollIntoView(next);
  }

  function onKeyDown(ev) {
    if (renaming) return;
    const perRow = columnsPerRow();
    switch (ev.key) {
      case 'ArrowRight':
        ev.preventDefault();
        moveCursor(1, ev);
        return;
      case 'ArrowLeft':
        ev.preventDefault();
        moveCursor(-1, ev);
        return;
      case 'ArrowDown':
        ev.preventDefault();
        moveCursor(perRow, ev);
        return;
      case 'ArrowUp':
        ev.preventDefault();
        moveCursor(-perRow, ev);
        return;
      case 'Home':
        ev.preventDefault();
        if (ordered.length) {
          selectIndex(0, { range: ev.shiftKey });
          scrollIntoView(0);
        }
        return;
      case 'End':
        ev.preventDefault();
        if (ordered.length) {
          selectIndex(ordered.length - 1, { range: ev.shiftKey });
          scrollIntoView(ordered.length - 1);
        }
        return;
      case 'Enter': {
        const targets = selectedEntries();
        if (targets.length > 0) {
          ev.preventDefault();
          for (const entry of targets.slice(0, 8)) opts.onActivate(entry, ev);
        }
        return;
      }
      case ' ':
        if (ev.ctrlKey && cursor >= 0) {
          ev.preventDefault();
          selectIndex(cursor, { additive: true });
        }
        return;
      default:
        break;
    }
    if (
      typeof opts.onTypeSearch === 'function' &&
      ev.key.length === 1 &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      ev.key !== ' '
    ) {
      ev.preventDefault();
      opts.onTypeSearch(ev.key);
    }
  }

  /* --- inline rename --------------------------------------------- */

  function commitRename(accept) {
    if (!renaming) return;
    const { entry, input, host, previous } = renaming;
    renaming = null;
    const value = input.value.trim();
    input.remove();
    if (host.isConnected) {
      clear(host);
      for (const node of previous) host.appendChild(node);
    }
    element.focus({ preventScroll: true });
    if (accept && value !== '' && value !== entry.label) opts.onRenameCommit(entry, value);
  }

  /**
   * Start an inline rename with the basename (extension excluded) selected,
   * exactly like Nautilus's F2.
   * @param {string} key
   */
  function beginRename(key) {
    const entry = entryFor(key);
    if (!entry) return;
    const node = nodes.get(key);
    if (!node) return;
    commitRename(false);
    const host = mode === 'grid' ? node.querySelector('.files-item__label') : node.querySelector('.files-cell--grow');
    if (!host) return;

    const previous = Array.from(host.childNodes);
    const input = h('input.files-rename', {
      type: 'text',
      value: entry.label,
      spellcheck: 'false',
      autocomplete: 'off',
    });
    clear(host);
    host.appendChild(input);
    renaming = { entry, input, host, previous };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitRename(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        commitRename(false);
      }
    });
    input.addEventListener('blur', () => commitRename(true));
    input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());

    input.focus();
    const dot = entry.label.lastIndexOf('.');
    const stemEnd = dot > 0 ? dot : entry.label.length;
    input.setSelectionRange(0, stemEnd);
  }

  /* --- drag and drop --------------------------------------------- */

  function dragPaths() {
    const entries = selectedEntries();
    if (typeof opts.onDragPaths === 'function') return opts.onDragPaths(entries);
    return entries.map((e) => e.path);
  }

  function onDragStart(ev) {
    const item = ev.target.closest ? ev.target.closest('.files-item') : null;
    if (!item) return;
    const index = indexOfNode(item);
    if (index < 0) return;
    if (!selected.has(ordered[index].key)) selectIndex(index, {});
    const paths = dragPaths();
    if (paths.length === 0) {
      ev.preventDefault();
      return;
    }
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    ev.dataTransfer.setData('text/plain', paths.join('\n'));
    item.classList.add('is-dragging');
  }

  function onDragEnd(ev) {
    const item = ev.target.closest ? ev.target.closest('.files-item') : null;
    if (item) item.classList.remove('is-dragging');
    clearDropMarks();
  }

  function clearDropMarks() {
    for (const node of nodes.values()) node.classList.remove('is-drop-target');
    element.classList.remove('files-view--drop');
  }

  function dropTargetFor(ev) {
    const item = ev.target.closest ? ev.target.closest('.files-item') : null;
    if (!item) return null;
    const index = indexOfNode(item);
    if (index < 0) return null;
    const entry = ordered[index];
    if (!entry.isDir || selected.has(entry.key)) return null;
    return entry;
  }

  function onDragOver(ev) {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes(DRAG_TYPE)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
    clearDropMarks();
    const target = dropTargetFor(ev);
    if (target) {
      const node = nodes.get(target.key);
      if (node) node.classList.add('is-drop-target');
    } else {
      element.classList.add('files-view--drop');
    }
  }

  function onDragLeave(ev) {
    if (ev.target === element || !element.contains(ev.relatedTarget)) clearDropMarks();
  }

  function onDropEvent(ev) {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes(DRAG_TYPE)) return;
    ev.preventDefault();
    const target = dropTargetFor(ev);
    clearDropMarks();
    let paths = [];
    try {
      paths = JSON.parse(ev.dataTransfer.getData(DRAG_TYPE));
    } catch {
      paths = [];
    }
    if (!Array.isArray(paths) || paths.length === 0) return;
    opts.onDrop(target, paths, ev);
  }

  /* --- wiring ---------------------------------------------------- */

  scroller.addEventListener('mousedown', onMouseDown);
  scroller.addEventListener('mouseup', onMouseUp);
  scroller.addEventListener('dblclick', onDoubleClick);
  scroller.addEventListener('contextmenu', onContextMenu);
  element.addEventListener('keydown', onKeyDown);
  element.addEventListener('dragstart', onDragStart);
  element.addEventListener('dragend', onDragEnd);
  element.addEventListener('dragover', onDragOver);
  element.addEventListener('dragleave', onDragLeave);
  element.addEventListener('drop', onDropEvent);

  /* --- public handle --------------------------------------------- */

  function setSort(next) {
    sort = { key: next.key || 'name', reverse: Boolean(next.reverse) };
    applyOrder();
    render();
  }

  return {
    /** @type {HTMLElement} */
    element,

    /**
     * Replace the item list, preserving the selection by key.
     * @param {object[]} list
     */
    setEntries(list) {
      source = Array.isArray(list) ? list.slice() : [];
      applyOrder();
      render();
      emitSelection();
    },

    /** @returns {object[]} entries in display order */
    entries() {
      return ordered.slice();
    },

    /** @param {'grid'|'list'} next */
    setMode(next) {
      const value = next === 'list' ? 'list' : 'grid';
      if (value === mode) return;
      mode = value;
      render();
    },

    /** @returns {'grid'|'list'} */
    mode() {
      return mode;
    },

    setSort,

    /** @returns {{key:string, reverse:boolean}} */
    sort() {
      return { ...sort };
    },

    /** @param {boolean} value */
    setFoldersFirst(value) {
      opts.foldersFirst = Boolean(value);
      applyOrder();
      render();
    },

    /** @param {boolean} value */
    setPreviews(value) {
      opts.previews = Boolean(value);
      render();
    },

    /** @param {{title:string, body?:string}} state */
    setEmptyState(state) {
      emptyState = { title: state.title || '', body: state.body || '' };
      if (ordered.length === 0) render();
    },

    /** @returns {object[]} */
    selection: selectedEntries,

    /** @returns {string[]} */
    selectedPaths() {
      return selectedEntries().map((e) => e.path);
    },

    /** @param {string[]} keys */
    setSelection(keys) {
      setSelectionKeys(Array.isArray(keys) ? keys : []);
      const first = ordered.findIndex((e) => selected.has(e.key));
      cursor = first;
      anchor = first;
      markSelection();
      if (first >= 0) scrollIntoView(first);
    },

    selectAll() {
      selected.clear();
      for (const entry of ordered) selected.add(entry.key);
      markSelection();
      emitSelection();
    },

    clearSelection() {
      selected.clear();
      cursor = -1;
      anchor = -1;
      markSelection();
      emitSelection();
    },

    beginRename,

    /** Start renaming the single selected item, if there is exactly one. */
    renameSelected() {
      const items = selectedEntries();
      if (items.length !== 1) return false;
      beginRename(items[0].key);
      return true;
    },

    /** @returns {boolean} */
    isRenaming() {
      return renaming !== null;
    },

    cancelRename() {
      commitRename(false);
    },

    focus() {
      element.focus({ preventScroll: true });
    },

    /** Scroll back to the top — used after navigating. */
    resetScroll() {
      scroller.scrollTop = 0;
    },

    /** @param {object[]} cols column descriptors, see COLUMN_SETS */
    setColumns(cols) {
      columns = Array.isArray(cols) && cols.length ? cols : COLUMN_SETS.files;
      render();
    },

    destroy() {
      destroyed = true;
      commitRename(false);
      if (marquee) marquee.up();
      clear(body);
      nodes.clear();
      element.remove();
    },
  };
}

export { COLUMN_SETS, DRAG_TYPE };
