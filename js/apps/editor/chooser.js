/**
 * js/apps/editor/chooser.js — a GTK4 FileChooser-shaped dialog over `fs`.
 *
 * Used by the Text Editor for Open and Save As. Resolves to an absolute path,
 * or `null` when the user cancels. Every filename reaches the DOM through
 * `textContent`.
 *
 * Sibling of `js/apps/editor/index.js`.
 */

import { h, svg, clear, on } from '../../core/dom.js';
import * as path from '../../core/path.js';
import { fs, FsError } from '../../core/fs.js';

const FOLDER_ICON = 'M3.6 6.4c0-.8.65-1.45 1.45-1.45h3.6c.42 0 .82.18 1.09.5l1.1 1.3h7.2c.8 0 1.45.65 1.45 1.45v9.2c0 .8-.65 1.45-1.45 1.45H5.05c-.8 0-1.45-.65-1.45-1.45z';
const FILE_ICON = ['M6.2 3.6h7L18.4 8.8v11.4c0 .66-.54 1.2-1.2 1.2H6.2c-.66 0-1.2-.54-1.2-1.2V4.8c0-.66.54-1.2 1.2-1.2z', 'M13.2 3.6v5.2h5.2'];

const PLACES = [
  { label: 'Home', dir: '/home/ubuntu' },
  { label: 'Desktop', dir: '/home/ubuntu/Desktop' },
  { label: 'Documents', dir: '/home/ubuntu/Documents' },
  { label: 'Downloads', dir: '/home/ubuntu/Downloads' },
  { label: 'Projects', dir: '/home/ubuntu/Projects' },
  { label: 'Pictures', dir: '/home/ubuntu/Pictures' },
  { label: 'Videos', dir: '/home/ubuntu/Videos' },
  { label: 'Other Locations', dir: '/' },
];

/** GNOME shows SI units: 1 kB = 1000 bytes. */
function formatSize(bytes) {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatTime(mtime) {
  const date = new Date(mtime);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getTime() - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
}

/**
 * Open the file chooser.
 *
 * @param {{mode?:'open'|'save', start?:string, name?:string, title?:string,
 *          acceptLabel?:string}} [options]
 * @returns {Promise<string|null>} an absolute path, or null when cancelled
 */
export function chooseFile(options = {}) {
  const mode = options.mode === 'save' ? 'save' : 'open';
  const acceptLabel = options.acceptLabel || (mode === 'save' ? 'Save' : 'Open');
  const title = options.title || (mode === 'save' ? 'Save As' : 'Open File');

  return new Promise((resolve) => {
    let cwd = options.start && fs.isDir(options.start) ? fs.resolve(options.start) : fs.HOME;
    let selected = null;
    let showHidden = false;
    let settled = false;

    const crumbs = h('div.chooser__crumbs');
    const list = h('div.chooser__list', { role: 'listbox', tabindex: '0' });
    const errorLine = h('div.chooser__error', { hidden: true });
    const nameInput = h('input.chooser__name-input', {
      type: 'text',
      value: options.name || '',
      spellcheck: 'false',
      'aria-label': 'File name',
    });
    const nameRow = h('div.chooser__name', {}, h('label.chooser__name-label', { text: 'Name' }), nameInput);
    if (mode !== 'save') nameRow.hidden = true;

    const cancelButton = h('button.chooser__button', { type: 'button', text: 'Cancel' });
    const acceptButton = h('button.chooser__button.chooser__button--suggested', { type: 'button', text: acceptLabel });
    const sidebar = h('div.chooser__sidebar');

    const chooser = h(
      'div.chooser',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.chooser__header', {}, cancelButton, h('span.chooser__title', { text: title }), acceptButton),
      h('div.chooser__body', {}, sidebar, h('div.chooser__main', {}, crumbs, list, errorLine, nameRow)),
    );
    const backdrop = h('div.chooser-backdrop', {}, chooser);

    function finish(value) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.remove('is-in');
      window.setTimeout(() => backdrop.remove(), 140);
      resolve(value);
    }

    function showError(message) {
      errorLine.hidden = false;
      errorLine.textContent = message;
    }

    function clearError() {
      errorLine.hidden = true;
      errorLine.textContent = '';
    }

    function renderCrumbs() {
      clear(crumbs);
      const home = fs.HOME;
      const inHome = cwd === home || cwd.startsWith(`${home}/`);
      const segments = inHome
        ? [{ label: 'Home', dir: home }].concat(
          path.split(path.relative(home, cwd)).filter(Boolean).map((name, index, all) => ({
            label: name,
            dir: path.join(home, all.slice(0, index + 1).join('/')),
          })),
        )
        : [{ label: '/', dir: '/' }].concat(
          path.split(cwd).map((name, index, all) => ({
            label: name,
            dir: `/${all.slice(0, index + 1).join('/')}`,
          })),
        );

      segments.forEach((segment, index) => {
        const button = h('button.chooser__crumb', { type: 'button', text: segment.label });
        if (index === segments.length - 1) button.classList.add('is-current');
        button.addEventListener('click', () => navigate(segment.dir));
        crumbs.appendChild(button);
      });
    }

    function selectRow(row, entry) {
      selected = entry;
      for (const other of list.querySelectorAll('.chooser__row')) other.classList.remove('is-selected');
      if (row) row.classList.add('is-selected');
      if (mode === 'save' && entry && !entry.isDir) nameInput.value = entry.name;
      clearError();
    }

    function render() {
      clear(list);
      selected = null;
      renderCrumbs();

      let entries;
      try {
        entries = fs.readdir(cwd, { withStats: true });
      } catch (err) {
        showError(err instanceof FsError ? err.message : String(err));
        return;
      }

      const visible = entries
        .filter((entry) => showHidden || !entry.name.startsWith('.'))
        .sort(compareEntries);

      if (cwd !== '/') {
        const up = h('button.chooser__row.chooser__row--up', { type: 'button' });
        up.appendChild(svg(FOLDER_ICON, { size: 18, filled: true, class: 'chooser__icon chooser__icon--dir' }));
        up.appendChild(h('span.chooser__row-name', { text: '..' }));
        up.appendChild(h('span.chooser__row-size', { text: 'Parent folder' }));
        up.addEventListener('dblclick', () => navigate(path.dirname(cwd)));
        up.addEventListener('click', () => navigate(path.dirname(cwd)));
        list.appendChild(up);
      }

      if (visible.length === 0) {
        list.appendChild(h('p.chooser__empty', { text: 'This folder is empty' }));
        return;
      }

      for (const entry of visible) {
        const row = h('div.chooser__row', { role: 'option', tabindex: '-1' });
        row.appendChild(
          entry.isDir
            ? svg(FOLDER_ICON, { size: 18, filled: true, class: 'chooser__icon chooser__icon--dir' })
            : svg(FILE_ICON, { size: 18, strokeWidth: 1.5, class: 'chooser__icon' }),
        );
        row.appendChild(h('span.chooser__row-name', { text: entry.name }));
        row.appendChild(
          h('span.chooser__row-size', { text: entry.isDir ? '' : formatSize(entry.size) }),
        );
        row.appendChild(h('span.chooser__row-time', { text: formatTime(entry.mtime) }));

        row.addEventListener('click', () => selectRow(row, entry));
        row.addEventListener('dblclick', () => {
          if (entry.isDir) navigate(entry.path);
          else accept();
        });
        list.appendChild(row);
      }
    }

    function navigate(dir) {
      if (!fs.isDir(dir)) {
        showError(`${path.basename(dir)}: Not a directory`);
        return;
      }
      cwd = fs.resolve(dir);
      render();
      for (const button of sidebar.querySelectorAll('.chooser__place')) {
        button.classList.toggle('is-current', button.dataset.dir === cwd);
      }
    }

    function accept() {
      if (mode === 'save') {
        const raw = nameInput.value.trim();
        if (raw === '') {
          showError('Enter a name for the file.');
          nameInput.focus();
          return;
        }
        const target = path.isAbsolute(raw) || raw.startsWith('~')
          ? fs.resolve(raw)
          : path.join(cwd, raw);
        if (fs.isDir(target)) {
          showError(`${path.basename(target)} is a folder.`);
          return;
        }
        finish(target);
        return;
      }

      if (!selected) {
        showError('Select a file to open.');
        return;
      }
      if (selected.isDir) {
        navigate(selected.path);
        return;
      }
      finish(selected.path);
    }

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(null);
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        accept();
        return;
      }
      if (ev.key.toLowerCase() === 'h' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        showHidden = !showHidden;
        render();
      }
    }

    for (const place of PLACES) {
      const button = h('button.chooser__place', {
        type: 'button',
        text: place.label,
        dataset: { dir: place.dir },
      });
      button.addEventListener('click', () => navigate(place.dir));
      sidebar.appendChild(button);
    }

    on(cancelButton, 'click', () => finish(null));
    on(acceptButton, 'click', accept);
    on(nameInput, 'keydown', (ev) => ev.stopPropagation());
    on(backdrop, 'mousedown', (ev) => {
      if (ev.target === backdrop) finish(null);
    });

    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKey, true);
    navigate(cwd);

    void backdrop.offsetHeight;
    backdrop.classList.add('is-in');

    if (mode === 'save') {
      nameInput.focus();
      const dot = nameInput.value.lastIndexOf('.');
      nameInput.setSelectionRange(0, dot > 0 ? dot : nameInput.value.length);
    } else {
      list.focus();
    }
  });
}
