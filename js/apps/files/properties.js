/**
 * js/apps/files/properties.js — the Nautilus Properties dialog.
 *
 * Shows name, type, size (recursive `fs.du` for folders), location, owner,
 * modification time and a permissions editor that offers both the octal value
 * and the symbolic rwx grid, writing straight through `fs.chmod`.
 */

import { fs } from '../../core/fs.js';
import { h, clear } from '../../core/dom.js';
import { basename, dirname } from '../../core/path.js';
import { entryIcon } from './icons.js';
import {
  formatSizeDetailed,
  formatFullTime,
  modeToOctal,
  modeToSymbolic,
  typeLabelFor,
  kindFor,
} from './format.js';

const PERM_BITS = [
  { key: 'read', label: 'Read', bit: 4 },
  { key: 'write', label: 'Write', bit: 2 },
  { key: 'execute', label: 'Execute', bit: 1 },
];

const PERM_CLASSES = [
  { key: 'owner', label: 'Owner', shift: 6 },
  { key: 'group', label: 'Group', shift: 3 },
  { key: 'others', label: 'Others', shift: 0 },
];

function row(label, valueNode) {
  return h(
    'div.files-props__row',
    {},
    h('div.files-props__key', { text: label }),
    typeof valueNode === 'string' ? h('div.files-props__value', { text: valueNode }) : valueNode,
  );
}

function locationLabel(p, home) {
  const parent = dirname(p);
  if (parent === home) return 'Home';
  if (parent.startsWith(`${home}/`)) return `~${parent.slice(home.length)}`;
  return parent;
}

function countChildren(p) {
  try {
    return fs.readdir(p).length;
  } catch {
    return 0;
  }
}

/**
 * Build the permissions section for a single path.
 * @param {string} p
 * @param {number} initialMode
 * @returns {HTMLElement}
 */
function buildPermissions(p, initialMode) {
  let mode = initialMode;
  const section = h('div.files-props__section');
  section.appendChild(h('h3.files-props__title', { text: 'Permissions' }));

  const symbolicOut = h('code.files-props__mono');
  const octalInput = h('input.files-props__octal', {
    type: 'text',
    value: modeToOctal(mode),
    maxlength: '4',
    inputmode: 'numeric',
    spellcheck: 'false',
    'aria-label': 'Octal permissions',
  });

  /** @type {Map<string, HTMLInputElement>} */
  const boxes = new Map();

  function syncDisplay() {
    let type = 'file';
    try {
      type = fs.lstat(p).type;
    } catch {
      type = 'file';
    }
    symbolicOut.textContent = modeToSymbolic(mode, type);
    octalInput.value = modeToOctal(mode);
    for (const cls of PERM_CLASSES) {
      for (const bit of PERM_BITS) {
        const box = boxes.get(`${cls.key}.${bit.key}`);
        if (box) box.checked = Boolean((mode >> cls.shift) & bit.bit);
      }
    }
  }

  function applyMode(next) {
    const value = Number(next);
    if (!Number.isFinite(value) || value < 0 || value > 0o7777) {
      syncDisplay();
      return;
    }
    try {
      fs.chmod(p, value);
      mode = value;
    } catch {
      /* keep the previous value; fs already rejected it */
    }
    syncDisplay();
  }

  const grid = h('div.files-props__perms');
  grid.appendChild(h('div.files-props__permhead'));
  for (const bit of PERM_BITS) grid.appendChild(h('div.files-props__permhead', { text: bit.label }));
  for (const cls of PERM_CLASSES) {
    grid.appendChild(h('div.files-props__permlabel', { text: cls.label }));
    for (const bit of PERM_BITS) {
      const box = h('input', { type: 'checkbox', 'aria-label': `${cls.label} ${bit.label}` });
      box.addEventListener('change', () => {
        const next = box.checked ? mode | (bit.bit << cls.shift) : mode & ~(bit.bit << cls.shift);
        applyMode(next);
      });
      boxes.set(`${cls.key}.${bit.key}`, box);
      grid.appendChild(h('div.files-props__permcell', {}, box));
    }
  }
  section.appendChild(grid);

  octalInput.addEventListener('change', () => {
    const parsed = parseInt(octalInput.value.trim(), 8);
    applyMode(Number.isNaN(parsed) ? mode : parsed);
  });
  octalInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      octalInput.blur();
    }
  });

  section.appendChild(
    h(
      'div.files-props__permfoot',
      {},
      h('label.files-props__octalbox', {}, h('span', { text: 'Octal' }), octalInput),
      h('div.files-props__symbolic', {}, symbolicOut),
    ),
  );

  syncDisplay();
  return section;
}

/**
 * Open the Properties dialog for one or more entries.
 * @param {object[]} entries normalized view entries
 * @returns {{close: () => void}|null}
 */
export function openProperties(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length === 0) return null;

  const home = fs.HOME;
  const single = list.length === 1 ? list[0] : null;

  const card = h('div.files-props', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Properties' });
  const backdrop = h('div.files-props-backdrop', {}, card);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.remove('is-in');
    setTimeout(() => backdrop.remove(), 140);
  }
  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  }

  const titleText = single ? `${single.label} Properties` : `${list.length} items Properties`;
  const headerBar = h(
    'div.files-props__header',
    {},
    h('h2.files-props__heading', { text: titleText }),
    h('button.files-props__close', { type: 'button', 'aria-label': 'Close', text: '×' }),
  );
  headerBar.querySelector('.files-props__close').addEventListener('click', close);
  card.appendChild(headerBar);

  const bodyBox = h('div.files-props__body');
  card.appendChild(bodyBox);

  /* --- identity ---------------------------------------------------- */

  const iconEntry = single || { ...list[0], label: `${list.length} items` };
  const identity = h(
    'div.files-props__identity',
    {},
    entryIcon(iconEntry, { size: 72, previews: false, home }),
    h(
      'div.files-props__ident-text',
      {},
      h('div.files-props__name', { text: single ? single.label : `${list.length} items` }),
      h('div.files-props__subtitle', {
        text: single ? single.typeLabel : 'Multiple items',
      }),
    ),
  );
  bodyBox.appendChild(identity);

  /* --- details ----------------------------------------------------- */

  const details = h('div.files-props__section');
  bodyBox.appendChild(details);

  function totalSize(items) {
    let total = 0;
    for (const item of items) {
      try {
        total += item.isDir ? fs.du(item.path) : fs.stat(item.path).size;
      } catch {
        total += item.size || 0;
      }
    }
    return total;
  }

  if (single) {
    let stat = null;
    try {
      stat = fs.lstat(single.path);
    } catch {
      stat = null;
    }
    const type = single.isDir ? 'Folder' : typeLabelFor(single.name, false);
    details.appendChild(row('Name', single.label));
    details.appendChild(row('Type', single.isLink ? `Link to ${type}` : type));
    if (single.isLink) {
      let target = '';
      try {
        target = fs.readlink(single.path);
      } catch {
        target = '';
      }
      if (target) details.appendChild(row('Link target', target));
    }
    if (single.isDir) {
      const count = countChildren(single.path);
      details.appendChild(
        row('Contents', `${count} ${count === 1 ? 'item' : 'items'}, totalling ${formatSizeDetailed(totalSize([single]))}`),
      );
    } else {
      details.appendChild(row('Size', formatSizeDetailed(totalSize([single]))));
    }
    details.appendChild(row('Location', locationLabel(single.path, home)));
    details.appendChild(row('Owner', stat ? `${stat.owner} (${stat.owner})` : 'ubuntu (ubuntu)'));
    details.appendChild(row('Group', stat ? stat.group : 'ubuntu'));
    details.appendChild(row('Modified', formatFullTime(single.mtime)));
    if (single.deletedAt) details.appendChild(row('Deleted', formatFullTime(single.deletedAt)));
    if (single.origin) details.appendChild(row('Original location', single.origin));
  } else {
    const folders = list.filter((e) => e.isDir).length;
    const files = list.length - folders;
    const parts = [];
    if (folders > 0) parts.push(`${folders} ${folders === 1 ? 'folder' : 'folders'}`);
    if (files > 0) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`);
    details.appendChild(row('Contents', parts.join(', ')));
    details.appendChild(row('Total size', formatSizeDetailed(totalSize(list))));
    details.appendChild(row('Location', locationLabel(list[0].path, home)));
  }

  /* --- permissions -------------------------------------------------- */

  if (single) {
    let mode = single.mode;
    try {
      mode = fs.lstat(single.path).mode;
    } catch {
      mode = single.mode;
    }
    if (Number.isFinite(Number(mode))) bodyBox.appendChild(buildPermissions(single.path, Number(mode)));
  }

  /* --- footer -------------------------------------------------------- */

  const footer = h('div.files-props__footer');
  const closeButton = h('button.files-props__button', { type: 'button', text: 'Close' });
  closeButton.addEventListener('click', close);
  footer.appendChild(closeButton);
  card.appendChild(footer);

  backdrop.addEventListener('mousedown', (ev) => {
    if (ev.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  void backdrop.offsetHeight;
  backdrop.classList.add('is-in');
  closeButton.focus();

  return { close };
}

/**
 * Build a normalized entry for an arbitrary path so the Properties dialog can
 * be opened for a folder the user is currently browsing.
 * @param {string} p absolute path
 * @returns {object|null}
 */
export function entryForPath(p) {
  let stat = null;
  try {
    stat = fs.lstat(p);
  } catch {
    return null;
  }
  const name = basename(p) || '/';
  const isDir = stat.isDir || (stat.isLink && fs.isDir(p));
  return {
    key: p,
    name,
    label: name,
    path: p,
    type: stat.type,
    isDir,
    isLink: stat.isLink,
    broken: stat.isLink && !fs.exists(p),
    size: stat.size,
    mtime: stat.mtime,
    mode: stat.mode,
    hidden: name.startsWith('.'),
    kind: kindFor(name, isDir),
    typeLabel: typeLabelFor(name, isDir),
  };
}

/** Remove any Properties dialog still on screen (used when a window closes). */
export function closeAllProperties() {
  for (const node of Array.from(document.querySelectorAll('.files-props-backdrop'))) {
    clear(node);
    node.remove();
  }
}
