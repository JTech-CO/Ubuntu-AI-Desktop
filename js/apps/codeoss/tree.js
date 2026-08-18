/**
 * js/apps/codeoss/tree.js — the Code-OSS Explorer tree.
 *
 * Reads directly from `js/core/fs.js`, re-renders on the `fs:change` bus event,
 * and exposes a context menu (New File / New Folder / Rename / Delete) that
 * performs real filesystem operations. Every label is written with
 * `textContent`; filenames never touch innerHTML.
 */

import { h, svg, clear, delegate, on } from '../../core/dom.js';
import * as path from '../../core/path.js';
import { fs, FsError } from '../../core/fs.js';
import { bus } from '../../core/bus.js';
import { dialog } from '../../core/dialog.js';

const CHEVRON = 'M9 6l6 6-6 6';

const FOLDER = 'M3.6 6.2c0-.77.63-1.4 1.4-1.4h3.7c.42 0 .82.19 1.09.51l1.1 1.29h7.1c.77 0 1.4.63 1.4 1.4v9.4c0 .77-.63 1.4-1.4 1.4H5c-.77 0-1.4-.63-1.4-1.4z';
const FOLDER_OPEN = 'M3.6 6.2c0-.77.63-1.4 1.4-1.4h3.7c.42 0 .82.19 1.09.51l1.1 1.29h7.1c.77 0 1.4.63 1.4 1.4v1.2H3.6zM3.6 9.9h17.2l-2 8.1a1.4 1.4 0 0 1-1.36 1.04H5a1.4 1.4 0 0 1-1.4-1.4z';

const FILE_PATHS = [
  'M6 3.6h7.2L18.4 8.8v11.6a1.2 1.2 0 0 1-1.2 1.2H6a1.2 1.2 0 0 1-1.2-1.2V4.8A1.2 1.2 0 0 1 6 3.6z',
  'M13.2 3.6v5.2h5.2',
];

/** Extension -> icon tint class (mirrors the Seti palette VS Code ships with). */
const ICON_KIND = {
  py: 'py', pyc: 'py',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts',
  json: 'json', jsonc: 'json', lock: 'json',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
  css: 'css', scss: 'css', less: 'css',
  md: 'md', markdown: 'md', rst: 'md',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  java: 'java', class: 'java',
  txt: 'txt', log: 'txt', cfg: 'txt', ini: 'txt', conf: 'txt',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml',
  gitignore: 'git',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', ico: 'img',
};

/**
 * @param {string} name file name
 * @returns {string} an icon tint class suffix
 */
export function fileIconKind(name) {
  const base = String(name || '').toLowerCase();
  if (base === 'makefile' || base === 'dockerfile') return 'sh';
  if (base === 'license' || base === 'readme') return 'md';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1) : base.replace(/^\./, '');
  return ICON_KIND[ext] || 'default';
}

/**
 * Build the icon for a tree row or an editor tab.
 * @param {string} name
 * @param {{dir?:boolean, open?:boolean}} [opts]
 * @returns {SVGElement}
 */
export function fileIcon(name, opts = {}) {
  if (opts.dir) {
    return svg(opts.open ? FOLDER_OPEN : FOLDER, {
      size: 16,
      filled: true,
      class: 'tree-icon tree-icon--folder',
    });
  }
  return svg(FILE_PATHS, {
    size: 16,
    strokeWidth: 1.4,
    class: `tree-icon tree-icon--file tree-icon--${fileIconKind(name)}`,
  });
}

/** Directories first, then files, both case-insensitively. */
function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.name < b.name ? -1 : 1;
}

/* ------------------------------------------------------------------ *
 * a small VS Code style context menu
 * ------------------------------------------------------------------ */

let openMenuEl = null;

function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

/**
 * @param {number} x viewport x
 * @param {number} y viewport y
 * @param {{label?:string, separator?:boolean, disabled?:boolean, onClick?:Function}[]} items
 */
export function openTreeMenu(x, y, items) {
  closeMenu();
  const menu = h('div.codeoss-menu', { role: 'menu' });
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(h('div.codeoss-menu__sep'));
      continue;
    }
    const button = h('button.codeoss-menu__item', {
      type: 'button',
      role: 'menuitem',
      text: item.label,
      disabled: item.disabled === true,
    });
    button.addEventListener('click', () => {
      closeMenu();
      if (typeof item.onClick === 'function') item.onClick();
    });
    menu.appendChild(button);
  }

  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  openMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const dismiss = (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Escape') return;
    if (ev.type === 'mousedown' && menu.contains(ev.target)) return;
    closeMenu();
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
    window.removeEventListener('blur', dismiss);
  };
  document.addEventListener('mousedown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
  window.addEventListener('blur', dismiss);
}

/* ------------------------------------------------------------------ *
 * tree controller
 * ------------------------------------------------------------------ */

/**
 * @param {{root?:string, onOpenFile?:(p:string)=>void, onSelect?:(p:string, isDir:boolean)=>void,
 *          onError?:(message:string)=>void}} [options]
 * @returns {{element:HTMLElement, refresh:Function, reveal:Function, select:Function,
 *            setRoot:Function, getRoot:Function, getSelected:Function, destroy:Function}}
 */
export function createTree(options = {}) {
  let rootPath = options.root || '/home/ubuntu/Projects';
  const onOpenFile = typeof options.onOpenFile === 'function' ? options.onOpenFile : () => {};
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  const expanded = new Set([rootPath]);
  let selected = null;
  let refreshTimer = 0;

  const body = h('div.tree__body', { role: 'tree', tabindex: '0' });
  const element = h('div.tree', {}, body);

  function report(err) {
    const message = err instanceof FsError ? `${err.path}: ${err.message}` : (err && err.message) || String(err);
    onError(message);
  }

  function rowFor(entry, depth) {
    const isDir = entry.isDir;
    const isOpen = isDir && expanded.has(entry.path);
    const row = h('div.tree-row', {
      role: 'treeitem',
      dataset: { path: entry.path, dir: isDir ? '1' : '0' },
      'aria-expanded': isDir ? String(isOpen) : undefined,
      title: entry.path,
      style: { paddingLeft: `${4 + depth * 10}px` },
    });
    if (entry.path === selected) row.classList.add('is-selected');

    const twisty = h('span.tree-row__twisty');
    if (isDir) {
      const chevron = svg(CHEVRON, { size: 14, strokeWidth: 1.8 });
      if (isOpen) chevron.classList.add('is-open');
      twisty.appendChild(chevron);
    }
    row.appendChild(twisty);
    row.appendChild(fileIcon(entry.name, { dir: isDir, open: isOpen }));
    row.appendChild(h('span.tree-row__label', { text: entry.name }));
    return row;
  }

  function renderInto(container, dirPath, depth) {
    let entries;
    try {
      entries = fs.readdir(dirPath, { withStats: true });
    } catch (err) {
      report(err);
      return;
    }
    const visible = entries.filter((e) => e.name !== '.' && e.name !== '..').sort(compareEntries);
    for (const entry of visible) {
      container.appendChild(rowFor(entry, depth));
      if (entry.isDir && expanded.has(entry.path)) renderInto(container, entry.path, depth + 1);
    }
  }

  function render() {
    const scroll = body.scrollTop;
    clear(body);

    if (!fs.isDir(rootPath)) {
      body.appendChild(
        h('p.tree__empty', { text: `${path.contract(rootPath, fs.HOME)} does not exist.` }),
      );
      return;
    }

    const header = h('div.tree__root', {
      dataset: { path: rootPath, dir: '1' },
      text: path.basename(rootPath).toUpperCase(),
    });
    body.appendChild(header);
    renderInto(body, rootPath, 0);
    body.scrollTop = scroll;
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      render();
    }, 60);
  }

  function setSelected(p) {
    selected = p;
    for (const row of element.querySelectorAll('.tree-row')) {
      row.classList.toggle('is-selected', row.dataset.path === p);
    }
  }

  /** Directory a new item created from `p` should land in. */
  function targetDir(p) {
    if (!p) return rootPath;
    return fs.isDir(p) ? p : path.dirname(p);
  }

  async function createEntry(p, kind) {
    const parent = targetDir(p);
    const name = await dialog.prompt({
      title: kind === 'dir' ? 'New Folder' : 'New File',
      body: `Create in ${path.contract(parent, fs.HOME)}`,
      placeholder: kind === 'dir' ? 'folder-name' : 'file-name.txt',
    });
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed === '') return;
    if (trimmed.includes('/')) {
      onError('A name cannot contain "/".');
      return;
    }
    const full = path.join(parent, trimmed);
    if (fs.lexists(full)) {
      onError(`${trimmed} already exists.`);
      return;
    }
    try {
      if (kind === 'dir') fs.mkdir(full, { parents: true });
      else fs.writeFile(full, '');
      expanded.add(parent);
      render();
      setSelected(full);
      if (kind === 'file') onOpenFile(full);
    } catch (err) {
      report(err);
    }
  }

  async function renameEntry(p) {
    if (!p || p === rootPath) return;
    const current = path.basename(p);
    const next = await dialog.prompt({ title: 'Rename', body: `Rename ${current} to:`, value: current });
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === current) return;
    if (trimmed.includes('/')) {
      onError('A name cannot contain "/".');
      return;
    }
    const dest = path.join(path.dirname(p), trimmed);
    if (fs.lexists(dest)) {
      onError(`${trimmed} already exists.`);
      return;
    }
    try {
      fs.mv(p, dest);
      if (expanded.delete(p)) expanded.add(dest);
      render();
      setSelected(dest);
    } catch (err) {
      report(err);
    }
  }

  async function deleteEntry(p) {
    if (!p || p === rootPath) return;
    const name = path.basename(p);
    const ok = await dialog.confirm({
      title: `Are you sure you want to delete '${name}'?`,
      body: 'You can restore this item from the Trash.',
      okLabel: 'Move to Trash',
      destructive: true,
    });
    if (!ok) return;
    try {
      fs.trash(p);
      expanded.delete(p);
      if (selected === p) selected = null;
      render();
    } catch (err) {
      report(err);
    }
  }

  function menuFor(p) {
    const isDir = Boolean(p) && fs.isDir(p);
    const isRoot = p === rootPath;
    return [
      !isDir && p ? { label: 'Open', onClick: () => onOpenFile(p) } : null,
      !isDir && p ? { separator: true } : null,
      { label: 'New File…', onClick: () => { void createEntry(p, 'file'); } },
      { label: 'New Folder…', onClick: () => { void createEntry(p, 'dir'); } },
      { separator: true },
      { label: 'Rename…', disabled: !p || isRoot, onClick: () => { void renameEntry(p); } },
      { label: 'Delete', disabled: !p || isRoot, onClick: () => { void deleteEntry(p); } },
    ].filter(Boolean);
  }

  const offClick = delegate(body, '.tree-row', 'click', (ev, row) => {
    const p = row.dataset.path;
    const isDir = row.dataset.dir === '1';
    setSelected(p);
    onSelect(p, isDir);
    if (isDir) {
      if (expanded.has(p)) expanded.delete(p);
      else expanded.add(p);
      render();
    } else {
      onOpenFile(p);
    }
  });

  const offMenu = on(body, 'contextmenu', (ev) => {
    ev.preventDefault();
    const row = ev.target instanceof Element ? ev.target.closest('.tree-row, .tree__root') : null;
    const p = row ? row.dataset.path : rootPath;
    if (row && row.classList.contains('tree-row')) setSelected(p);
    openTreeMenu(ev.clientX, ev.clientY, menuFor(p));
  });

  const offKeys = on(body, 'keydown', (ev) => {
    if (!selected) return;
    if (ev.key === 'F2') {
      ev.preventDefault();
      void renameEntry(selected);
    } else if (ev.key === 'Delete') {
      ev.preventDefault();
      void deleteEntry(selected);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (fs.isDir(selected)) {
        if (expanded.has(selected)) expanded.delete(selected);
        else expanded.add(selected);
        render();
      } else {
        onOpenFile(selected);
      }
    }
  });

  const offBus = bus.on('fs:change', scheduleRefresh);
  const offTrash = bus.on('fs:trash', scheduleRefresh);

  render();

  return {
    element,

    refresh() {
      render();
    },

    /** Expand every ancestor of `p` and select it. */
    reveal(p) {
      if (!p) return;
      let dir = fs.isDir(p) ? p : path.dirname(p);
      const chain = [];
      while (dir && dir.startsWith(rootPath)) {
        chain.push(dir);
        if (dir === rootPath) break;
        dir = path.dirname(dir);
      }
      for (const d of chain) expanded.add(d);
      render();
      setSelected(p);
      const row = element.querySelector(`.tree-row[data-path="${CSS.escape(p)}"]`);
      if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    },

    select: setSelected,

    setRoot(p) {
      rootPath = p;
      expanded.clear();
      expanded.add(rootPath);
      selected = null;
      render();
    },

    getRoot() {
      return rootPath;
    },

    getSelected() {
      return selected;
    },

    destroy() {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      offClick();
      offMenu();
      offKeys();
      offBus();
      offTrash();
      closeMenu();
    },
  };
}
