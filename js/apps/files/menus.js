/**
 * js/apps/files/menus.js — Nautilus popovers and context menus.
 *
 * The right-click menus are built for the shared `openMenu()` builder
 * (ARCHITECTURE §15); the header-bar popovers (sort & view, the primary
 * hamburger menu and Preferences) are Adwaita popovers built here because they
 * carry radio marks and switches rather than plain menu rows.
 */

import { h } from '../../core/dom.js';
import { openMenu } from '../../shell/context-menu.js';
import { symbolic } from './icons.js';
import { canUndo, undoLabel } from './operations.js';
import { openerFor, isTextLike } from './format.js';

const SORT_KEYS = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
  { key: 'type', label: 'Type' },
  { key: 'modified', label: 'Modified' },
];

/* ------------------------------------------------------------------ *
 * popover plumbing
 * ------------------------------------------------------------------ */

let openPopoverHandle = null;

/**
 * Show an Adwaita popover anchored under an element.
 * @param {HTMLElement} anchor
 * @param {HTMLElement} content
 * @param {{align?: 'start'|'end', width?: number}} [opts]
 * @returns {{close: () => void, element: HTMLElement}}
 */
export function openPopover(anchor, content, opts = {}) {
  closePopover();
  const popover = h('div.files-popover', { role: 'menu' }, content);
  if (opts.width) popover.style.width = `${opts.width}px`;
  document.body.appendChild(popover);

  const rect = anchor.getBoundingClientRect();
  const size = popover.getBoundingClientRect();
  const margin = 8;
  let left = opts.align === 'start' ? rect.left : rect.right - size.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin));
  let top = rect.bottom + 6;
  if (top + size.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - size.height - 6);
  }
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;

  const onDown = (ev) => {
    if (!popover.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) closePopover();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closePopover();
    }
  };
  const onResize = () => closePopover();

  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);

  openPopoverHandle = {
    element: popover,
    close() {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      popover.remove();
      openPopoverHandle = null;
    },
  };
  void popover.offsetHeight;
  popover.classList.add('is-in');
  return openPopoverHandle;
}

/** Close whichever popover is open. */
export function closePopover() {
  if (openPopoverHandle) openPopoverHandle.close();
}

function popRow(label, { accel = '', icon = '', selected = false, onClick, dim = false } = {}) {
  const button = h('button.files-popover__row', { type: 'button', role: 'menuitem' });
  const mark = h('span.files-popover__mark');
  if (selected) mark.appendChild(symbolic('check', 14));
  button.appendChild(mark);
  if (icon) button.appendChild(h('span.files-popover__icon', {}, symbolic(icon, 16)));
  button.appendChild(h('span.files-popover__label', { text: label }));
  if (accel) button.appendChild(h('span.files-popover__accel', { text: accel }));
  if (dim) button.classList.add('is-dim');
  button.addEventListener('click', () => {
    closePopover();
    if (typeof onClick === 'function') onClick();
  });
  return button;
}

function popSwitch(label, value, onToggle) {
  const track = h('span.files-switch', { class: value ? 'is-on' : '' }, h('span.files-switch__knob'));
  const button = h(
    'button.files-popover__row.files-popover__row--switch',
    { type: 'button', role: 'switch', 'aria-checked': value ? 'true' : 'false' },
    h('span.files-popover__label', { text: label }),
    track,
  );
  button.addEventListener('click', () => {
    const next = !button.getAttribute('aria-checked').startsWith('t');
    button.setAttribute('aria-checked', next ? 'true' : 'false');
    track.classList.toggle('is-on', next);
    onToggle(next);
  });
  return button;
}

function popSeparator() {
  return h('div.files-popover__separator');
}

function popTitle(text) {
  return h('div.files-popover__title', { text });
}

/* ------------------------------------------------------------------ *
 * header-bar popovers
 * ------------------------------------------------------------------ */

/**
 * The "sort & view" popover: sort key radios plus reverse / hidden switches.
 * @param {object} app the Files controller facade
 * @param {HTMLElement} anchor
 */
export function openSortPopover(app, anchor) {
  const box = h('div.files-popover__box');
  box.appendChild(popTitle('Sort'));
  const sort = app.sort();
  for (const item of SORT_KEYS) {
    box.appendChild(
      popRow(item.label, {
        selected: sort.key === item.key,
        onClick: () => app.setSortKey(item.key),
      }),
    );
  }
  box.appendChild(popSeparator());
  box.appendChild(popSwitch('Reverse Order', sort.reverse, (value) => app.setSortReverse(value)));
  box.appendChild(popSwitch('Show Hidden Files', app.prefs().showHidden, (value) => app.setShowHidden(value)));
  box.appendChild(popSwitch('Sort Folders before Files', app.prefs().foldersFirst, (value) => app.setFoldersFirst(value)));
  openPopover(anchor, box, { align: 'end', width: 232 });
}

/**
 * The primary (hamburger) menu.
 * @param {object} app
 * @param {HTMLElement} anchor
 */
export function openMainMenu(app, anchor) {
  const box = h('div.files-popover__box');
  box.appendChild(popRow('New Folder', { accel: 'Ctrl+Shift+N', onClick: () => app.newFolder() }));
  box.appendChild(popRow('New Document', { onClick: () => app.newDocument() }));
  box.appendChild(popSeparator());
  box.appendChild(popRow('Select All', { accel: 'Ctrl+A', onClick: () => app.selectAll() }));
  box.appendChild(
    popRow(canUndo() ? undoLabel() : 'Undo', {
      accel: 'Ctrl+Z',
      dim: !canUndo(),
      onClick: () => {
        if (canUndo()) app.undo();
      },
    }),
  );
  box.appendChild(popSeparator());
  box.appendChild(popRow('Open in Terminal', { onClick: () => app.openTerminalHere() }));
  box.appendChild(popRow('Properties', { accel: 'Ctrl+I', onClick: () => app.showProperties() }));
  box.appendChild(popSeparator());
  box.appendChild(
    popRow('Preferences', {
      onClick: () => {
        // Re-anchor so the preferences popover replaces this one in place.
        openPreferences(app, anchor);
      },
    }),
  );
  openPopover(anchor, box, { align: 'end', width: 250 });
}

/**
 * The Files preferences popover — every switch here changes real behaviour.
 * @param {object} app
 * @param {HTMLElement} anchor
 */
export function openPreferences(app, anchor) {
  const prefs = app.prefs();
  const box = h('div.files-popover__box');
  box.appendChild(popTitle('Preferences'));
  box.appendChild(popSwitch('Sort Folders before Files', prefs.foldersFirst, (v) => app.setFoldersFirst(v)));
  box.appendChild(popSwitch('Show Hidden and Backup Files', prefs.showHidden, (v) => app.setShowHidden(v)));
  box.appendChild(popSwitch('Show Text Previews in Icons', prefs.previews, (v) => app.setPreviews(v)));
  box.appendChild(popSwitch('Ask before Emptying the Trash', prefs.confirmTrash, (v) => app.setConfirmTrash(v)));
  box.appendChild(popSeparator());
  box.appendChild(popTitle('View'));
  box.appendChild(popRow('Grid View', { selected: app.mode() === 'grid', onClick: () => app.setMode('grid') }));
  box.appendChild(popRow('List View', { selected: app.mode() === 'list', onClick: () => app.setMode('list') }));
  openPopover(anchor, box, { align: 'end', width: 268 });
}

/* ------------------------------------------------------------------ *
 * context menus
 * ------------------------------------------------------------------ */

function openWithSubmenu(app, entry) {
  const items = [];
  const opener = openerFor(entry.name);
  if (entry.isDir) {
    items.push({ label: 'Files', onClick: () => app.openEntry(entry) });
    items.push({ label: 'Terminal', onClick: () => app.openTerminalAt(entry.path) });
    return items;
  }
  // An image is what the Image Viewer is for, so it leads the list and is the
  // default the double click already picked.
  if (typeof app.isImageEntry === 'function' && app.isImageEntry(entry)) {
    items.push({
      label: 'Image Viewer',
      onClick: () => app.openEntryWith(entry, 'image'),
    });
    items.push({ separator: true });
    items.push({ label: 'Text Editor', onClick: () => app.openEntryWith(entry, 'editor') });
    items.push({ label: 'Code - OSS', onClick: () => app.openEntryWith(entry, 'code') });
    return items;
  }
  if (isTextLike(entry.name)) {
    items.push({
      label: 'Text Editor',
      onClick: () => app.openEntryWith(entry, 'editor'),
    });
    items.push({
      label: 'Code - OSS',
      onClick: () => app.openEntryWith(entry, 'code'),
    });
  } else {
    items.push({
      label: 'Text Editor',
      onClick: () => app.openEntryWith(entry, 'editor'),
    });
  }
  if (!opener) {
    items.push({ separator: true });
    items.push({ label: 'Other Application…', onClick: () => app.reportNoApplication(entry) });
  }
  return items;
}

/**
 * Right-click menu for an item in the Files window.
 * @param {object} app
 * @param {object} entry
 * @param {number} x
 * @param {number} y
 */
export function openItemMenu(app, entry, x, y) {
  const selection = app.selection();
  const many = selection.length > 1;
  const items = [];

  items.push({ label: many ? `Open ${selection.length} Items` : 'Open', accel: 'Return', onClick: () => app.openSelection() });
  if (entry.isDir) {
    items.push({ label: 'Open in New Window', onClick: () => app.openInNewWindow(entry) });
    items.push({ label: 'Open in Terminal', onClick: () => app.openTerminalAt(entry.path) });
  }
  if (!many) items.push({ label: 'Open With', submenu: openWithSubmenu(app, entry) });
  items.push({ separator: true });
  items.push({ label: 'Cut', accel: 'Ctrl+X', onClick: () => app.cutSelection() });
  items.push({ label: 'Copy', accel: 'Ctrl+C', onClick: () => app.copySelection() });
  if (entry.isDir && !many) {
    items.push({ label: 'Paste Into Folder', disabled: !app.canPaste(), onClick: () => app.pasteInto(entry.path) });
  }
  items.push({ separator: true });
  items.push({ label: 'Rename…', accel: 'F2', disabled: many, onClick: () => app.renameSelected() });
  items.push({ label: 'Move to Trash', accel: 'Delete', onClick: () => app.trashSelection() });
  items.push({ label: 'Delete Permanently', accel: 'Shift+Delete', onClick: () => app.deleteSelection() });
  items.push({ separator: true });
  items.push({ label: 'Properties', accel: 'Ctrl+I', onClick: () => app.showProperties() });
  openMenu(x, y, items);
}

/**
 * Right-click menu for empty space in the Files window.
 * @param {object} app
 * @param {number} x
 * @param {number} y
 */
export function openEmptyMenu(app, x, y) {
  const sort = app.sort();
  const items = [
    { label: 'New Folder', accel: 'Ctrl+Shift+N', onClick: () => app.newFolder() },
    { label: 'New Document', onClick: () => app.newDocument() },
    { separator: true },
    { label: 'Paste', accel: 'Ctrl+V', disabled: !app.canPaste(), onClick: () => app.pasteHere() },
    { label: 'Select All', accel: 'Ctrl+A', onClick: () => app.selectAll() },
    { separator: true },
    {
      label: 'Sort By',
      submenu: SORT_KEYS.map((item) => ({
        label: sort.key === item.key ? `${item.label} ✓` : item.label,
        onClick: () => app.setSortKey(item.key),
      })).concat([
        { separator: true },
        {
          label: sort.reverse ? 'Reverse Order ✓' : 'Reverse Order',
          onClick: () => app.setSortReverse(!sort.reverse),
        },
      ]),
    },
    {
      label: app.prefs().showHidden ? 'Show Hidden Files ✓' : 'Show Hidden Files',
      accel: 'Ctrl+H',
      onClick: () => app.setShowHidden(!app.prefs().showHidden),
    },
    { separator: true },
    { label: 'Open in Terminal', onClick: () => app.openTerminalHere() },
    { label: 'Properties', accel: 'Ctrl+I', onClick: () => app.showFolderProperties() },
  ];
  if (canUndo()) {
    items.splice(2, 0, { label: undoLabel(), accel: 'Ctrl+Z', onClick: () => app.undo() });
  }
  openMenu(x, y, items);
}

/**
 * Right-click menu inside the Trash window.
 * @param {object} app the Trash controller facade
 * @param {object|null} entry null for empty space
 * @param {number} x
 * @param {number} y
 */
export function openTrashMenu(app, entry, x, y) {
  if (!entry) {
    openMenu(x, y, [
      { label: 'Restore All', disabled: app.count() === 0, onClick: () => app.restoreAll() },
      { label: 'Empty Trash', disabled: app.count() === 0, onClick: () => app.emptyTrash() },
      { separator: true },
      { label: 'Select All', accel: 'Ctrl+A', onClick: () => app.selectAll() },
    ]);
    return;
  }
  const many = app.selection().length > 1;
  openMenu(x, y, [
    { label: many ? `Restore ${app.selection().length} Items` : 'Restore', onClick: () => app.restoreSelection() },
    { separator: true },
    { label: 'Delete Permanently', accel: 'Delete', onClick: () => app.deleteSelection() },
    { separator: true },
    { label: 'Properties', accel: 'Ctrl+I', onClick: () => app.showProperties() },
  ]);
}

/**
 * The sidebar row menu (Files only).
 * @param {object} app
 * @param {object} place
 * @param {number} x
 * @param {number} y
 */
export function openPlaceMenu(app, place, x, y) {
  const items = [
    { label: 'Open', onClick: () => app.navigate(place.path) },
    { label: 'Open in New Window', onClick: () => app.openPathInNewWindow(place.path) },
  ];
  if (place.id !== 'trash' && place.id !== 'other') {
    items.push({ separator: true });
    items.push({ label: 'Open in Terminal', onClick: () => app.openTerminalAt(place.path) });
  }
  if (place.id === 'trash') {
    items.push({ separator: true });
    items.push({ label: 'Empty Trash', onClick: () => app.emptyTrash() });
  }
  openMenu(x, y, items);
}
