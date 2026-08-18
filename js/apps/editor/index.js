/**
 * js/apps/editor/index.js — GNOME Text Editor (ARCHITECTURE §16, §18).
 *
 * Tabbed documents over `fs`, a line-number gutter that stays aligned through
 * soft wrapping, current-line highlighting, find & replace with live match
 * counts, word wrap, font zoom, and an unsaved-changes guard on close.
 *
 * The visible text comes from a real <textarea>; a mirror element underneath it
 * carries the current-line and search highlights, and is measured to give the
 * gutter its per-line heights.
 */

import { h, svg, clear, on } from '../../core/dom.js';
import * as path from '../../core/path.js';
import { fs, FsError } from '../../core/fs.js';
import { bus } from '../../core/bus.js';
import { dialog } from '../../core/dialog.js';
import { store } from '../../core/store.js';
import { chooseFile } from './chooser.js';
import { createFindBar } from './find.js';

const MIN_FONT = 9;
const MAX_FONT = 30;
const DEFAULT_FONT = 14;

const ICON_OPEN = ['M3.8 6.6c0-.77.63-1.4 1.4-1.4h3.6c.41 0 .8.18 1.07.5l1.1 1.3h7.4c.77 0 1.4.63 1.4 1.4v2.1H3.8z', 'M3.8 10.5h17.4l-2.1 8a1.4 1.4 0 0 1-1.35 1.05H5.2a1.4 1.4 0 0 1-1.4-1.4z'];
const ICON_NEW = ['M12 5v14', 'M5 12h14'];
const ICON_SAVE = ['M5.6 4.4h9.6l3.4 3.4v11.8a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1z', 'M8.2 4.4v5h6.2v-5', 'M8.2 19.6v-6h7.6v6'];
const ICON_SEARCH = ['M10.8 4.4a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8z', 'M15.5 15.5l4.3 4.3'];
const ICON_MENU = ['M4.5 7.5h15', 'M4.5 12h15', 'M4.5 16.5h15'];
const APP_ICON = [
  'M6.4 2.8h7.6l5.6 5.6v12.8a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 21.2V4.2a1.4 1.4 0 0 1 1.4-1.4z',
  'M14 2.8v5.8h5.6',
  'M8.4 12.6h7.2',
  'M8.4 16h7.2',
  'M8.4 19.2h4.4',
];

/** Instance state, keyed by window instance id. */
const sessions = new Map();

let untitledCounter = 0;

function countWords(text) {
  const matched = text.match(/[^\s]+/g);
  return matched ? matched.length : 0;
}

/** Replace a range, preserving the browser's native undo stack. */
function replaceRange(ta, start, end, text, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const value = ta.value;
    ta.value = value.slice(0, start) + text + value.slice(end);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (typeof selStart === 'number') ta.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
}

/* ------------------------------------------------------------------ *
 * a small Adwaita popover menu
 * ------------------------------------------------------------------ */

let openPopover = null;

function closePopover() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
  }
}

function showMenu(anchor, items) {
  closePopover();
  const menu = h('div.gedit-menu', { role: 'menu' });

  for (const item of items) {
    if (item.separator) {
      menu.appendChild(h('div.gedit-menu__sep'));
      continue;
    }
    const button = h('button.gedit-menu__item', { type: 'button', role: 'menuitem' });
    button.appendChild(h('span.gedit-menu__check', { text: item.checked ? '✓' : '' }));
    button.appendChild(h('span.gedit-menu__label', { text: item.label }));
    if (item.accel) button.appendChild(h('span.gedit-menu__accel', { text: item.accel }));
    if (item.disabled) button.disabled = true;
    button.addEventListener('click', () => {
      closePopover();
      if (typeof item.onClick === 'function') item.onClick();
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);
  openPopover = menu;

  const rect = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(rect.right - size.width, window.innerWidth - size.width - 6))}px`;
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - size.height - 6)}px`;

  const dismiss = (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Escape') return;
    if (ev.type === 'mousedown' && menu.contains(ev.target)) return;
    closePopover();
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  document.addEventListener('mousedown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
}

/* ------------------------------------------------------------------ *
 * mount
 * ------------------------------------------------------------------ */

function mount(root, ctx) {
  const state = {
    docs: [],
    activeIndex: -1,
    wrap: store.get('editor:wrap', true) !== false,
    lineNumbers: store.get('editor:lineNumbers', true) !== false,
    fontSize: Number(store.get('editor:fontSize', DEFAULT_FONT)) || DEFAULT_FONT,
    forceClose: false,
    disposers: [],
  };
  sessions.set(ctx.instanceId, state);

  /* --- chrome ------------------------------------------------------- */

  function toolButton(label, iconPaths, title, accel) {
    const button = h('button.gedit-tool', { type: 'button', title: accel ? `${title} (${accel})` : title, 'aria-label': title });
    button.appendChild(svg(iconPaths, { size: 16, strokeWidth: 1.7 }));
    if (label) button.appendChild(h('span', { text: label }));
    return button;
  }

  const openButton = toolButton('Open', ICON_OPEN, 'Open a File', 'Ctrl+O');
  const newButton = toolButton('', ICON_NEW, 'New Document', 'Ctrl+N');
  const saveButton = toolButton('Save', ICON_SAVE, 'Save', 'Ctrl+S');
  const findButton = toolButton('', ICON_SEARCH, 'Find and Replace', 'Ctrl+F');
  const menuButton = toolButton('', ICON_MENU, 'Main Menu', '');

  const toolbar = h(
    'div.gedit__toolbar',
    {},
    openButton,
    newButton,
    h('div.gedit__toolbar-spacer'),
    saveButton,
    findButton,
    menuButton,
  );

  const tabsRow = h('div.gedit__tabs', { role: 'tablist' });
  const gutter = h('div.gedit__gutter');
  const gutterInner = h('div.gedit__gutter-inner');
  gutter.appendChild(gutterInner);

  const mirrorInner = h('div.gedit__mirror-inner', { 'aria-hidden': 'true' });
  const mirror = h('div.gedit__mirror', { 'aria-hidden': 'true' }, mirrorInner);
  const textarea = h('textarea.gedit__input', {
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    'aria-label': 'Document text',
  });
  const area = h('div.gedit__area', {}, mirror, textarea);
  const view = h('div.gedit__view', {}, gutter, area);

  const statusCounts = h('span.gedit__status-item');
  const statusPosition = h('span.gedit__status-item', { text: 'Ln 1, Col 1' });
  const statusWrap = h('span.gedit__status-item');
  const statusZoom = h('span.gedit__status-item');
  const statusBar = h(
    'div.gedit__status',
    {},
    h('div.gedit__status-left', {}, statusCounts),
    h('div.gedit__status-right', {}, statusWrap, statusZoom, statusPosition),
  );

  const container = h('div.gedit', {}, toolbar, tabsRow);
  root.appendChild(container);

  const find = createFindBar({
    textarea,
    onMatchesChanged() {
      scheduleRender();
    },
    onReveal(offset) {
      revealOffset(offset);
    },
    onClose() {
      scheduleRender();
    },
  });

  container.appendChild(find.element);
  container.appendChild(view);
  container.appendChild(statusBar);

  /* --- layout bookkeeping -------------------------------------------- */

  const layout = { starts: [0], tops: [0], heights: [] };
  let renderHandle = 0;

  function computeStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
  }

  function offsetToPosition(offset) {
    const starts = layout.starts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, column: offset - starts[low] };
  }

  function applyPreferences() {
    container.style.setProperty('--gedit-font-size', `${state.fontSize}px`);
    container.classList.toggle('is-wrapped', state.wrap);
    textarea.setAttribute('wrap', state.wrap ? 'soft' : 'off');
    gutter.hidden = !state.lineNumbers;
    statusWrap.textContent = state.wrap ? 'Wrap on' : 'Wrap off';
    statusZoom.textContent = `${state.fontSize} px`;
    store.set('editor:wrap', state.wrap);
    store.set('editor:lineNumbers', state.lineNumbers);
    store.set('editor:fontSize', state.fontSize);
  }

  /**
   * Rebuild the mirror (one block per logical line, with <mark> for search
   * hits), then measure it so the gutter rows line up with wrapped text.
   */
  function render() {
    renderHandle = 0;
    const text = textarea.value;
    layout.starts = computeStarts(text);
    const rows = text.split('\n');

    const matches = find.matches();
    const all = find.allMatches();
    const currentMatch = find.currentIndex() >= 0 ? all[find.currentIndex()] : null;
    const caretLine = offsetToPosition(textarea.selectionStart).line;

    mirrorInner.style.width = `${textarea.clientWidth}px`;

    clear(mirrorInner);
    const fragment = document.createDocumentFragment();
    let matchCursor = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const lineStart = layout.starts[i];
      const lineEnd = lineStart + rows[i].length;
      const line = h('div.gedit__line');
      if (i === caretLine && textarea.selectionStart === textarea.selectionEnd) line.classList.add('is-current');

      while (matchCursor < matches.length && matches[matchCursor].end <= lineStart) matchCursor += 1;

      let cursor = lineStart;
      let scan = matchCursor;
      while (scan < matches.length && matches[scan].start < lineEnd) {
        const match = matches[scan];
        const from = Math.max(match.start, lineStart);
        const to = Math.min(match.end, lineEnd);
        if (from > cursor) line.appendChild(document.createTextNode(text.slice(cursor, from)));
        if (to > from) {
          const isCurrent = currentMatch && currentMatch.start === match.start && currentMatch.end === match.end;
          line.appendChild(
            h('mark', { class: isCurrent ? 'gedit__mark is-current' : 'gedit__mark', text: text.slice(from, to) }),
          );
        }
        cursor = to;
        scan += 1;
      }
      if (cursor < lineEnd) line.appendChild(document.createTextNode(text.slice(cursor, lineEnd)));

      fragment.appendChild(line);
    }

    mirrorInner.appendChild(fragment);
    syncGutter(rows.length);
    syncScroll();
  }

  function syncGutter(count) {
    const lineNodes = mirrorInner.children;
    const heights = new Array(count);
    const tops = new Array(count + 1);
    let running = 0;

    for (let i = 0; i < count; i += 1) {
      const node = lineNodes[i];
      const height = node ? node.offsetHeight : 0;
      heights[i] = height;
      tops[i] = running;
      running += height;
    }
    tops[count] = running;
    layout.heights = heights;
    layout.tops = tops;

    if (!state.lineNumbers) return;

    while (gutterInner.childElementCount > count) gutterInner.removeChild(gutterInner.lastChild);
    if (gutterInner.childElementCount < count) {
      const fragment = document.createDocumentFragment();
      for (let i = gutterInner.childElementCount; i < count; i += 1) {
        fragment.appendChild(h('div.gedit__gutter-line', { text: String(i + 1) }));
      }
      gutterInner.appendChild(fragment);
    }

    const caretLine = offsetToPosition(textarea.selectionStart).line;
    for (let i = 0; i < count; i += 1) {
      const node = gutterInner.children[i];
      node.style.height = `${heights[i]}px`;
      node.classList.toggle('is-current', i === caretLine);
    }
    gutter.style.width = `${Math.max(46, 22 + String(count).length * 9)}px`;
  }

  function scheduleRender() {
    if (renderHandle) return;
    renderHandle = window.requestAnimationFrame(render);
  }

  function syncScroll() {
    mirrorInner.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    gutterInner.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }

  function revealOffset(offset) {
    const position = offsetToPosition(offset);
    const top = layout.tops[position.line] === undefined ? 0 : layout.tops[position.line];
    const height = layout.heights[position.line] || 20;
    const viewport = textarea.clientHeight;
    if (top < textarea.scrollTop) textarea.scrollTop = Math.max(0, top - 24);
    else if (top + height > textarea.scrollTop + viewport) textarea.scrollTop = top + height - viewport + 24;
    syncScroll();
  }

  function updateStatus() {
    const text = textarea.value;
    const position = offsetToPosition(textarea.selectionStart);
    statusPosition.textContent = `Ln ${position.line + 1}, Col ${position.column + 1}`;

    const characters = text.length;
    const words = countWords(text);
    const selectionLength = Math.abs(textarea.selectionEnd - textarea.selectionStart);
    statusCounts.textContent = selectionLength > 0
      ? `${selectionLength} selected · ${characters} characters · ${words} words`
      : `${characters} characters · ${words} words`;
  }

  /* --- documents ------------------------------------------------------ */

  function activeDoc() {
    return state.activeIndex >= 0 ? state.docs[state.activeIndex] : null;
  }

  function displayName(doc) {
    return doc.path ? path.basename(doc.path) : doc.name;
  }

  function updateTitle() {
    const doc = activeDoc();
    if (!doc) {
      ctx.setTitle('Text Editor');
      return;
    }
    ctx.setTitle(`${doc.dirty ? '• ' : ''}${displayName(doc)} — Text Editor`);
  }

  function renderTabs() {
    clear(tabsRow);
    tabsRow.hidden = state.docs.length === 0;

    state.docs.forEach((doc, index) => {
      const tab = h('div.gedit-tab', {
        role: 'tab',
        title: doc.path ? path.contract(doc.path, fs.HOME) : displayName(doc),
      });
      if (index === state.activeIndex) tab.classList.add('is-active');
      tab.appendChild(h('span.gedit-tab__dot', { text: doc.dirty ? '•' : '' }));
      tab.appendChild(h('span.gedit-tab__label', { text: displayName(doc) }));

      const close = h('button.gedit-tab__close', { type: 'button', text: '✕', title: 'Close Document', 'aria-label': 'Close' });
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void closeTab(index);
      });
      tab.appendChild(close);

      tab.addEventListener('mousedown', (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          void closeTab(index);
        } else if (ev.button === 0) {
          activate(index);
        }
      });
      tabsRow.appendChild(tab);
    });
  }

  function stashActive() {
    const doc = activeDoc();
    if (!doc) return;
    doc.content = textarea.value;
    doc.selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
    doc.scrollTop = textarea.scrollTop;
  }

  function activate(index) {
    if (index !== state.activeIndex) stashActive();

    if (index < 0 || index >= state.docs.length) {
      state.activeIndex = -1;
      textarea.value = '';
      textarea.disabled = true;
      container.classList.add('is-empty');
      renderTabs();
      updateTitle();
      render();
      updateStatus();
      return;
    }

    state.activeIndex = index;
    const doc = state.docs[index];
    textarea.disabled = false;
    container.classList.remove('is-empty');
    textarea.value = doc.content;
    renderTabs();
    updateTitle();
    render();

    const selection = doc.selection || { start: 0, end: 0 };
    textarea.setSelectionRange(Math.min(selection.start, doc.content.length), Math.min(selection.end, doc.content.length));
    textarea.scrollTop = doc.scrollTop || 0;
    syncScroll();
    updateStatus();
    find.refresh();
    textarea.focus();
  }

  function newDocument(content = '') {
    untitledCounter += 1;
    state.docs.push({
      path: null,
      name: `Untitled Document ${untitledCounter}`,
      content,
      saved: content,
      dirty: content !== '',
      selection: { start: 0, end: 0 },
      scrollTop: 0,
    });
    activate(state.docs.length - 1);
  }

  async function openPath(target) {
    const resolved = fs.resolve(target);
    const existing = state.docs.findIndex((doc) => doc.path === resolved);
    if (existing >= 0) {
      activate(existing);
      return true;
    }

    let content;
    try {
      if (fs.isDir(resolved)) {
        await dialog.alert({ title: 'Unable to open', body: `${path.basename(resolved)} is a folder.` });
        return false;
      }
      content = fs.readFile(resolved);
    } catch (err) {
      const message = err instanceof FsError ? err.message : (err && err.message) || String(err);
      await dialog.alert({
        title: `Could not open ${path.basename(resolved)}`,
        body: `${path.contract(resolved, fs.HOME)}: ${message}`,
      });
      return false;
    }

    state.docs.push({
      path: resolved,
      name: path.basename(resolved),
      content,
      saved: content,
      dirty: false,
      selection: { start: 0, end: 0 },
      scrollTop: 0,
    });
    activate(state.docs.length - 1);
    return true;
  }

  async function openDialog() {
    const doc = activeDoc();
    const start = doc && doc.path ? path.dirname(doc.path) : fs.HOME;
    const chosen = await chooseFile({ mode: 'open', start });
    if (chosen) await openPath(chosen);
  }

  function writeDoc(doc, target) {
    try {
      fs.writeFile(target, doc.content);
    } catch (err) {
      const message = err instanceof FsError ? err.message : (err && err.message) || String(err);
      void dialog.alert({ title: 'Unable to save', body: `${path.contract(target, fs.HOME)}: ${message}` });
      return false;
    }
    doc.path = target;
    doc.name = path.basename(target);
    doc.saved = doc.content;
    doc.dirty = false;
    renderTabs();
    updateTitle();
    return true;
  }

  async function saveAs() {
    const doc = activeDoc();
    if (!doc) return false;
    stashActive();

    const chosen = await chooseFile({
      mode: 'save',
      start: doc.path ? path.dirname(doc.path) : fs.HOME,
      name: displayName(doc),
    });
    if (!chosen) return false;

    if (fs.lexists(chosen) && chosen !== doc.path) {
      const replace = await dialog.confirm({
        title: `A file named "${path.basename(chosen)}" already exists. Do you want to replace it?`,
        body: `The file already exists in "${path.contract(path.dirname(chosen), fs.HOME)}". Replacing it will overwrite its contents.`,
        okLabel: 'Replace',
        destructive: true,
      });
      if (!replace) return false;
    }
    return writeDoc(doc, chosen);
  }

  async function saveActive() {
    const doc = activeDoc();
    if (!doc) return false;
    stashActive();
    if (!doc.path) return saveAs();
    return writeDoc(doc, doc.path);
  }

  async function closeTab(index) {
    const doc = state.docs[index];
    if (!doc) return true;
    if (index === state.activeIndex) stashActive();

    if (doc.dirty) {
      const discard = await dialog.confirm({
        title: `Save changes to document "${displayName(doc)}" before closing?`,
        body: 'If you don’t save, changes will be permanently lost.',
        okLabel: 'Close without Saving',
        cancelLabel: 'Cancel',
        destructive: true,
      });
      if (!discard) return false;
    }

    state.docs.splice(index, 1);
    if (state.docs.length === 0) {
      state.activeIndex = -1;
      newDocument();
    } else {
      state.activeIndex = -1;
      activate(Math.min(index, state.docs.length - 1));
    }
    return true;
  }

  /* --- menus and zoom -------------------------------------------------- */

  function setFontSize(size) {
    state.fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, size));
    applyPreferences();
    render();
  }

  async function showProperties() {
    const doc = activeDoc();
    if (!doc) return;
    stashActive();
    const text = doc.content;
    const lines = text === '' ? 0 : text.split('\n').length;
    await dialog.alert({
      title: 'Document Properties',
      body:
        `Name: ${displayName(doc)}\n` +
        `Location: ${doc.path ? path.contract(path.dirname(doc.path), fs.HOME) : 'Not saved yet'}\n` +
        `Characters: ${text.length}\n` +
        `Words: ${countWords(text)}\n` +
        `Lines: ${lines}\n` +
        `Encoding: UTF-8\nLine ending: Unix/Linux (LF)`,
    });
  }

  function openMainMenu() {
    showMenu(menuButton, [
      { label: 'Save As…', accel: 'Ctrl+Shift+S', onClick: () => void saveAs(), disabled: state.activeIndex < 0 },
      { label: 'Close Document', accel: 'Ctrl+W', onClick: () => void closeTab(state.activeIndex), disabled: state.activeIndex < 0 },
      { separator: true },
      { label: 'Find…', accel: 'Ctrl+F', onClick: () => find.open('find', textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)) },
      { label: 'Find and Replace…', accel: 'Ctrl+H', onClick: () => find.open('replace', textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)) },
      { separator: true },
      {
        label: 'Word Wrap',
        checked: state.wrap,
        onClick: () => {
          state.wrap = !state.wrap;
          applyPreferences();
          render();
        },
      },
      {
        label: 'Line Numbers',
        checked: state.lineNumbers,
        onClick: () => {
          state.lineNumbers = !state.lineNumbers;
          applyPreferences();
          render();
        },
      },
      { separator: true },
      { label: 'Zoom In', accel: 'Ctrl++', onClick: () => setFontSize(state.fontSize + 1) },
      { label: 'Zoom Out', accel: 'Ctrl+−', onClick: () => setFontSize(state.fontSize - 1) },
      { label: 'Reset Zoom', accel: 'Ctrl+0', onClick: () => setFontSize(DEFAULT_FONT) },
      { separator: true },
      { label: 'Document Properties', onClick: () => void showProperties(), disabled: state.activeIndex < 0 },
    ]);
  }

  /* --- events ------------------------------------------------------------ */

  const offOpen = on(openButton, 'click', () => void openDialog());
  const offNew = on(newButton, 'click', () => newDocument());
  const offSave = on(saveButton, 'click', () => void saveActive());
  const offFind = on(findButton, 'click', () => {
    find.open('find', textarea.value.slice(textarea.selectionStart, textarea.selectionEnd));
  });
  const offMenu = on(menuButton, 'click', openMainMenu);

  const offInput = on(textarea, 'input', () => {
    const doc = activeDoc();
    if (doc) {
      doc.content = textarea.value;
      const dirty = doc.content !== doc.saved;
      if (dirty !== doc.dirty) {
        doc.dirty = dirty;
        renderTabs();
        updateTitle();
      }
    }
    scheduleRender();
    updateStatus();
    find.refresh();
  });

  const offScroll = on(textarea, 'scroll', syncScroll);

  const offCaret = ['keyup', 'click', 'select', 'focus'].map((name) =>
    on(textarea, name, () => {
      updateStatus();
      scheduleRender();
    }),
  );

  const offSelectionChange = on(document, 'selectionchange', () => {
    if (document.activeElement !== textarea) return;
    updateStatus();
    scheduleRender();
  });

  const offTab = on(textarea, 'keydown', (ev) => {
    if (ev.key !== 'Tab' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    if (value.slice(start, end).indexOf('\n') < 0 && !ev.shiftKey) {
      ev.preventDefault();
      replaceRange(textarea, start, end, '\t');
      return;
    }

    ev.preventDefault();
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to < 0) to = value.length;
    const rows = value.slice(from, to).split('\n');
    const next = rows.map((row) => {
      if (ev.shiftKey) return row.replace(/^(\t| {1,4})/, '');
      return `\t${row}`;
    });
    const joined = next.join('\n');
    replaceRange(textarea, from, to, joined, from, from + joined.length);
  });

  const offKeys = on(root, 'keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;

    if (!mod) {
      if (ev.key === 'Escape' && find.isOpen()) {
        ev.preventDefault();
        find.close();
      } else if (ev.key === 'F3') {
        ev.preventDefault();
        if (ev.shiftKey) find.previous();
        else find.next();
      }
      return;
    }

    const key = ev.key.toLowerCase();
    const selection = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);

    if (key === 's' && ev.shiftKey) {
      ev.preventDefault();
      ev.stopPropagation();
      void saveAs();
    } else if (key === 's') {
      ev.preventDefault();
      ev.stopPropagation();
      void saveActive();
    } else if (key === 'o') {
      ev.preventDefault();
      ev.stopPropagation();
      void openDialog();
    } else if (key === 'n') {
      ev.preventDefault();
      ev.stopPropagation();
      newDocument();
    } else if (key === 'w') {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.activeIndex >= 0) void closeTab(state.activeIndex);
    } else if (key === 'f') {
      ev.preventDefault();
      ev.stopPropagation();
      find.open('find', selection);
    } else if (key === 'h') {
      ev.preventDefault();
      ev.stopPropagation();
      find.open('replace', selection);
    } else if (key === 'g') {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) find.previous();
      else find.next();
    } else if (key === '=' || key === '+') {
      ev.preventDefault();
      ev.stopPropagation();
      setFontSize(state.fontSize + 1);
    } else if (key === '-') {
      ev.preventDefault();
      ev.stopPropagation();
      setFontSize(state.fontSize - 1);
    } else if (key === '0') {
      ev.preventDefault();
      ev.stopPropagation();
      setFontSize(DEFAULT_FONT);
    }
  });

  const offResize = on(window, 'resize', () => scheduleRender());

  const offFsChange = bus.on('fs:change', (payload) => {
    if (!payload || !payload.path) return;
    const doc = state.docs.find((d) => d.path === payload.path);
    if (!doc || doc.dirty) return;
    try {
      const fresh = fs.readFile(payload.path);
      if (fresh === doc.content) return;
      doc.content = fresh;
      doc.saved = fresh;
      if (doc === activeDoc()) {
        const caret = textarea.selectionStart;
        textarea.value = fresh;
        textarea.setSelectionRange(Math.min(caret, fresh.length), Math.min(caret, fresh.length));
        render();
        updateStatus();
      }
    } catch {
      /* the file was removed; keep the buffer as it stands */
    }
  });

  state.disposers.push(
    offOpen, offNew, offSave, offFind, offMenu, offInput, offScroll,
    offSelectionChange, offTab, offKeys, offResize, offFsChange,
    ...offCaret,
    () => find.destroy(),
    () => {
      if (renderHandle) window.cancelAnimationFrame(renderHandle);
      closePopover();
    },
  );

  /* --- boot ------------------------------------------------------------- */

  applyPreferences();

  const initial = ctx.args && (ctx.args.path || ctx.args.file);
  if (initial) {
    void openPath(initial).then((ok) => {
      if (!ok && state.docs.length === 0) newDocument();
    });
  } else {
    newDocument(ctx.args && typeof ctx.args.content === 'string' ? ctx.args.content : '');
  }

  state.api = {
    openPath,
    newDocument,
    saveActive,
    relayout: () => {
      scheduleRender();
      syncScroll();
    },
    focus: () => textarea.focus(),
  };
}

/* ------------------------------------------------------------------ *
 * app definition
 * ------------------------------------------------------------------ */

export default {
  id: 'editor',
  name: 'Text Editor',
  genericName: 'Text Editor',
  icon: () => svg(APP_ICON, { size: 24, strokeWidth: 1.5, class: 'app-icon-editor' }),
  pinned: true,
  singleton: false,
  width: 860,
  height: 620,
  minWidth: 460,
  minHeight: 300,
  resizable: true,
  themeClass: 'app-editor',
  darkChrome: false,

  mount,

  onFocus(ctx) {
    const state = sessions.get(ctx.instanceId);
    if (state && state.api) state.api.focus();
  },

  onResize(ctx) {
    const state = sessions.get(ctx.instanceId);
    if (state && state.api) state.api.relayout();
  },

  onClose(ctx) {
    const state = sessions.get(ctx.instanceId);
    if (!state) return true;

    const dirty = state.docs.filter((doc) => doc.dirty);
    if (dirty.length > 0 && !state.forceClose) {
      const names = dirty.map((doc) => (doc.path ? path.basename(doc.path) : doc.name));
      dialog
        .confirm({
          title: 'Save Changes?',
          body:
            dirty.length === 1
              ? `"${names[0]}" contains unsaved changes. Changes which are not saved will be permanently lost.`
              : `${dirty.length} open documents contain unsaved changes. Changes which are not saved will be permanently lost.`,
          okLabel: 'Discard',
          cancelLabel: 'Cancel',
          destructive: true,
        })
        .then((discard) => {
          if (!discard) return;
          state.forceClose = true;
          ctx.close();
        });
      return false;
    }

    for (const dispose of state.disposers) {
      try {
        dispose();
      } catch {
        /* already detached */
      }
    }
    sessions.delete(ctx.instanceId);
    return true;
  },
};
