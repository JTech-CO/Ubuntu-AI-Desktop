/**
 * js/apps/monitor/processes.js — the "Processes" tab of System Monitor.
 *
 * A sortable, filterable table fed from `procs.list()` and refreshed once a
 * second. Rows are keyed by pid and mutated in place, so a refresh never
 * disturbs the scroll offset or the current selection — the same behaviour
 * real GNOME System Monitor gets from its GtkTreeModel.
 */

import { h, clear, on } from '../../core/dom.js';
import { procs } from '../../core/procs.js';
import { users } from '../../core/users.js';
import { dialog } from '../../core/dialog.js';
import { formatBinary } from './charts.js';

/** Process RSS is tracked in MiB; the table renders bytes. */
const MIB = 1024 * 1024;

/** Signal numbers used by the process menu. */
const SIGKILL = 9;
const SIGTERM = 15;
const SIGSTOP = 19;
const SIGCONT = 18;

/** GNOME's five priority buckets, derived from the nice value. */
function priorityLabel(nice) {
  if (nice <= -15) return 'Very High';
  if (nice <= -5) return 'High';
  if (nice < 5) return 'Normal';
  if (nice < 15) return 'Low';
  return 'Very Low';
}

/** Symbolic icon per well-known process, generic cog otherwise. */
const ICON_PATHS = {
  'gnome-shell': 'M4 5h16v11H4z M9 19h6',
  'gnome-terminal-': 'M3 5h18v14H3z M7 10l3 2-3 2 M13 14h4',
  nautilus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  Xorg: 'M4 5h16v11H4z M9 19h6',
  systemd: 'M12 4v16 M4 8l8 4 8-4',
  snapd: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z',
  pipewire: 'M4 12a8 8 0 0 1 16 0 M8 12a4 4 0 0 1 8 0 M12 12v6',
  wireplumber: 'M4 12a8 8 0 0 1 16 0 M8 12a4 4 0 0 1 8 0 M12 12v6',
  NetworkManager: 'M2 8.5a15 15 0 0 1 20 0 M5 12a11 11 0 0 1 14 0 M8.5 15.5a6 6 0 0 1 7 0 M12 19h.01',
  bluetoothd: 'M7 7l10 10-5 4V3l5 4L7 17',
  cron: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
  'dbus-daemon': 'M12 3v18 M5 8l7-4 7 4 M5 16l7 4 7-4',
};

const GENERIC_ICON =
  'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z ' +
  'M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L14.9 3h-3.8l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.6h3.8l.4-2.6c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4z';

const SVG_NS = 'http://www.w3.org/2000/svg';

function procIcon(name) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', '16');
  node.setAttribute('height', '16');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.6');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  node.classList.add('mon-proc__icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name] || GENERIC_ICON);
  node.appendChild(path);
  return node;
}

/* ------------------------------------------------------------------ *
 * simulated per-process disk accounting
 * ------------------------------------------------------------------ */

/** @type {Map<number, {read:number, write:number, rate:number}>} */
const diskIo = new Map();

/** Read-only accessor — safe to call from a sort comparator. */
function diskFor(proc) {
  let entry = diskIo.get(proc.pid);
  if (!entry) {
    // Daemons that genuinely touch the disk get a believable head start.
    const heavy = /journald|snapd|tracker|dpkg|apt|nautilus|gnome-shell|Xorg/.test(proc.name);
    entry = {
      read: proc.kernel ? 0 : Math.random() * (heavy ? 4.2e8 : 6e6),
      write: proc.kernel ? 0 : Math.random() * (heavy ? 9e7 : 8e5),
      rate: heavy ? 1 : 0.12,
    };
    diskIo.set(proc.pid, entry);
  }
  return entry;
}

let lastDiskTick = 0;

/**
 * Accumulate simulated disk traffic. Driven by wall-clock time rather than by
 * the number of refreshes, so re-sorting or filtering the table does not
 * inflate the counters.
 * @param {object[]} list
 */
function advanceDisk(list) {
  const now = Date.now();
  if (now - lastDiskTick < 900) {
    for (const proc of list) diskFor(proc);
    return;
  }
  const seconds = lastDiskTick === 0 ? 1 : Math.min(5, (now - lastDiskTick) / 1000);
  lastDiskTick = now;
  for (const proc of list) {
    const entry = diskFor(proc);
    if (proc.kernel) continue;
    entry.read += Math.random() * 22000 * entry.rate * (1 + proc.cpu / 20) * seconds;
    entry.write += Math.random() * 7000 * entry.rate * (1 + proc.cpu / 40) * seconds;
  }
}

/* ------------------------------------------------------------------ *
 * column model
 * ------------------------------------------------------------------ */

const COLUMNS = [
  {
    id: 'name',
    label: 'Process Name',
    align: 'left',
    value: (p) => p.name,
    compare: (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  },
  { id: 'user', label: 'User', align: 'left', value: (p) => p.user, compare: (a, b) => a.user.localeCompare(b.user) },
  { id: 'cpu', label: '% CPU', align: 'right', value: (p) => String(Math.round(p.cpu)), compare: (a, b) => a.cpu - b.cpu },
  { id: 'pid', label: 'ID', align: 'right', value: (p) => String(p.pid), compare: (a, b) => a.pid - b.pid },
  {
    id: 'mem',
    label: 'Memory',
    align: 'right',
    value: (p) => (p.mem > 0 ? formatBinary(p.mem * MIB) : 'N/A'),
    compare: (a, b) => a.mem - b.mem,
  },
  {
    id: 'read',
    label: 'Disk read',
    align: 'right',
    value: (p) => (p.kernel ? 'N/A' : formatBinary(diskFor(p).read)),
    compare: (a, b) => diskFor(a).read - diskFor(b).read,
  },
  {
    id: 'write',
    label: 'Disk write',
    align: 'right',
    value: (p) => (p.kernel ? 'N/A' : formatBinary(diskFor(p).write)),
    compare: (a, b) => diskFor(a).write - diskFor(b).write,
  },
  { id: 'priority', label: 'Priority', align: 'left', value: (p) => priorityLabel(p.nice), compare: (a, b) => a.nice - b.nice },
];

const VIEWS = [
  { id: 'all', label: 'All Processes' },
  { id: 'user', label: 'My Processes' },
  { id: 'active', label: 'Active Processes' },
];

/* ------------------------------------------------------------------ *
 * a small popup menu, scoped to this tab
 * ------------------------------------------------------------------ */

function buildMenu(items) {
  const menu = h('div.mon-menu', { role: 'menu' });
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(h('div.mon-menu__separator', { role: 'separator' }));
      continue;
    }
    const button = h('button.mon-menu__item', {
      type: 'button',
      role: 'menuitem',
      disabled: item.disabled === true,
    });
    button.appendChild(h('span.mon-menu__label', { text: item.label }));
    if (item.checked) button.classList.add('is-checked');
    button.addEventListener('click', () => {
      menu.dispatchEvent(new CustomEvent('mon-menu-close', { bubbles: true }));
      if (typeof item.onClick === 'function') item.onClick();
    });
    menu.appendChild(button);
  }
  return menu;
}

/* ------------------------------------------------------------------ *
 * the tab
 * ------------------------------------------------------------------ */

/**
 * @param {{root: HTMLElement}} host the tab is mounted inside `host.root`
 * @returns {{el: HTMLElement, update(): void, show(): void, destroy(): void}}
 */
export function createProcessesTab() {
  let sortColumn = 'name';
  let sortAscending = true;
  let view = 'all';
  let query = '';
  let selectedPid = null;

  /** @type {Map<number, {tr: HTMLElement, cells: HTMLElement[]}>} */
  const rows = new Map();

  const searchEntry = h('input.mon-search__input', {
    type: 'search',
    placeholder: 'Search for open files or processes',
    'aria-label': 'Search processes',
  });

  const viewButton = h('button.mon-button.mon-button--menu', { type: 'button' });
  const viewLabel = h('span', { text: VIEWS[0].label });
  viewButton.appendChild(viewLabel);
  viewButton.appendChild(h('span.mon-button__arrow', { 'aria-hidden': 'true', text: '▾' }));

  const endButton = h('button.mon-button.mon-button--destructive', {
    type: 'button',
    text: 'End Process',
    disabled: true,
  });

  const toolbar = h(
    'div.mon-toolbar',
    {},
    h('div.mon-search', {}, h('span.mon-search__icon', { 'aria-hidden': 'true', text: '⌕' }), searchEntry),
    h('div.mon-toolbar__spacer'),
    viewButton,
    endButton,
  );

  const headRow = h('tr');
  const headCells = new Map();
  for (const column of COLUMNS) {
    const cell = h('th', {
      class: `is-${column.align}`,
      scope: 'col',
      'data-column': column.id,
      tabindex: '0',
      role: 'columnheader',
    });
    cell.appendChild(h('span.mon-th__label', { text: column.label }));
    cell.appendChild(h('span.mon-th__sort', { 'aria-hidden': 'true' }));
    headCells.set(column.id, cell);
    headRow.appendChild(cell);
  }

  const tbody = h('tbody');
  const table = h('table.mon-table', {}, h('thead', {}, headRow), tbody);
  const scroller = h('div.mon-table-scroll', {}, table);

  const statusBar = h('div.mon-statusbar');
  const statusText = h('span', { text: '' });
  statusBar.appendChild(statusText);

  const el = h('div.mon-tab.mon-tab--processes', {}, toolbar, scroller, statusBar);

  /* --- menus ---------------------------------------------------- */

  let openMenuEl = null;

  function closeMenu() {
    if (!openMenuEl) return;
    openMenuEl.remove();
    openMenuEl = null;
  }

  function showMenu(items, x, y) {
    closeMenu();
    const menu = buildMenu(items);
    menu.addEventListener('mon-menu-close', closeMenu);
    el.appendChild(menu);
    const bounds = el.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(4, x - bounds.left), Math.max(4, bounds.width - width - 4));
    const top = Math.min(Math.max(4, y - bounds.top), Math.max(4, bounds.height - height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    openMenuEl = menu;
  }

  const offDocDown = on(
    document,
    'pointerdown',
    (ev) => {
      if (openMenuEl && !openMenuEl.contains(ev.target)) closeMenu();
    },
    true,
  );
  const offDocKey = on(document, 'keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });

  /* --- process actions ------------------------------------------ */

  function selected() {
    return selectedPid === null ? null : procs.get(selectedPid);
  }

  async function confirmSignal(proc, mode) {
    const verb = mode === 'kill' ? 'kill' : 'end';
    const Verb = mode === 'kill' ? 'Kill' : 'End';
    const ok = await dialog.confirm({
      title: `Are you sure you want to ${verb} the selected process “${proc.name}” (PID ${proc.pid})?`,
      body:
        `${Verb}ing a process may destroy data, break the session or introduce a ` +
        `security risk. Only unresponsive processes should be ${verb}ed.`,
      okLabel: `${Verb} Process`,
      destructive: true,
    });
    if (!ok) return;
    procs.kill(proc.pid, mode === 'kill' ? SIGKILL : SIGTERM);
    if (selectedPid === proc.pid) setSelection(null);
    update();
  }

  function showProperties(proc) {
    const started = new Date(proc.startedAt);
    const cpuSeconds = Math.floor(proc.cpuTime);
    const hours = Math.floor(cpuSeconds / 3600);
    const minutes = Math.floor((cpuSeconds % 3600) / 60);
    const seconds = cpuSeconds % 60;
    const body = [
      `Process Name\t${proc.name}`,
      `User\t\t${proc.user}`,
      `Status\t\t${stateLabel(proc.state)}`,
      `Memory\t\t${proc.mem > 0 ? formatBinary(proc.mem * MIB) : 'N/A'}`,
      `Virtual Memory\t${formatBinary(proc.mem * MIB * 6.2)}`,
      `Resident Memory\t${formatBinary(proc.mem * MIB)}`,
      `Started\t\t${started.toLocaleString('en-GB')}`,
      `CPU\t\t${Math.round(proc.cpu)}%`,
      `CPU Time\t${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
      `Priority\t\t${priorityLabel(proc.nice)} (nice ${proc.nice})`,
      `Threads\t\t${proc.threads}`,
      `Parent PID\t${proc.ppid}`,
      '',
      `Command Line`,
      proc.cmd,
    ].join('\n');
    dialog.alert({ title: `${proc.name} (PID ${proc.pid})`, body, okLabel: 'Close' });
  }

  function stateLabel(state) {
    switch (state) {
      case 'R':
        return 'Running';
      case 'T':
        return 'Stopped';
      case 'Z':
        return 'Zombie';
      case 'D':
        return 'Uninterruptible';
      case 'I':
        return 'Idle';
      default:
        return 'Sleeping';
    }
  }

  function processMenuItems(proc) {
    return [
      { label: 'Stop', disabled: proc.state === 'T', onClick: () => { procs.kill(proc.pid, SIGSTOP); update(); } },
      { label: 'Continue', disabled: proc.state !== 'T', onClick: () => { procs.kill(proc.pid, SIGCONT); update(); } },
      { separator: true },
      { label: 'End Process', onClick: () => confirmSignal(proc, 'end') },
      { label: 'Kill Process', onClick: () => confirmSignal(proc, 'kill') },
      { separator: true },
      { label: 'Properties', onClick: () => showProperties(proc) },
    ];
  }

  /* --- selection & sorting -------------------------------------- */

  function setSelection(pid) {
    selectedPid = pid;
    for (const [key, record] of rows) {
      record.tr.classList.toggle('is-selected', key === pid);
      record.tr.setAttribute('aria-selected', key === pid ? 'true' : 'false');
    }
    endButton.disabled = pid === null;
  }

  function applySortIndicators() {
    for (const [id, cell] of headCells) {
      const active = id === sortColumn;
      cell.classList.toggle('is-sorted', active);
      cell.setAttribute('aria-sort', active ? (sortAscending ? 'ascending' : 'descending') : 'none');
      const marker = cell.querySelector('.mon-th__sort');
      if (marker) marker.textContent = active ? (sortAscending ? '▲' : '▼') : '';
    }
  }

  function setSort(columnId) {
    if (sortColumn === columnId) sortAscending = !sortAscending;
    else {
      sortColumn = columnId;
      // Numeric columns are far more useful descending first.
      sortAscending = columnId === 'name' || columnId === 'user' || columnId === 'priority';
    }
    applySortIndicators();
    update();
  }

  for (const [id, cell] of headCells) {
    cell.addEventListener('click', () => setSort(id));
    cell.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        setSort(id);
      }
    });
  }

  searchEntry.addEventListener('input', () => {
    query = searchEntry.value.trim().toLowerCase();
    update();
  });

  viewButton.addEventListener('click', () => {
    const rect = viewButton.getBoundingClientRect();
    showMenu(
      VIEWS.map((v) => ({
        label: v.label,
        checked: v.id === view,
        onClick: () => {
          view = v.id;
          viewLabel.textContent = v.label;
          update();
        },
      })),
      rect.left,
      rect.bottom + 4,
    );
  });

  endButton.addEventListener('click', () => {
    const proc = selected();
    if (proc) confirmSignal(proc, 'end');
  });

  tbody.addEventListener('click', (ev) => {
    const tr = ev.target instanceof Element ? ev.target.closest('tr[data-pid]') : null;
    if (!tr) return;
    setSelection(Number(tr.dataset.pid));
  });

  tbody.addEventListener('dblclick', (ev) => {
    const tr = ev.target instanceof Element ? ev.target.closest('tr[data-pid]') : null;
    if (!tr) return;
    const proc = procs.get(Number(tr.dataset.pid));
    if (proc) showProperties(proc);
  });

  tbody.addEventListener('contextmenu', (ev) => {
    const tr = ev.target instanceof Element ? ev.target.closest('tr[data-pid]') : null;
    if (!tr) return;
    ev.preventDefault();
    const pid = Number(tr.dataset.pid);
    setSelection(pid);
    const proc = procs.get(pid);
    if (proc) showMenu(processMenuItems(proc), ev.clientX, ev.clientY);
  });

  /* --- refresh --------------------------------------------------- */

  function passesFilter(proc) {
    if (view === 'user' && proc.user !== users.current.name) return false;
    if (view === 'active' && !(proc.cpu > 0.05 || proc.state === 'R')) return false;
    if (query !== '') {
      if (!proc.name.toLowerCase().includes(query) && !proc.cmd.toLowerCase().includes(query) && String(proc.pid) !== query) {
        return false;
      }
    }
    return true;
  }

  function makeRow(proc) {
    const tr = h('tr', { role: 'row', tabindex: '-1', 'data-pid': String(proc.pid), 'aria-selected': 'false' });
    const cells = [];
    COLUMNS.forEach((column, index) => {
      const td = h('td', { class: `is-${column.align}` });
      if (index === 0) {
        const label = h('span.mon-proc__name');
        td.appendChild(procIcon(proc.name));
        td.appendChild(label);
        cells.push(label);
      } else {
        cells.push(td);
      }
      tr.appendChild(td);
    });
    return { tr, cells };
  }

  function update() {
    const all = procs.list();
    const visible = all.filter(passesFilter);
    const column = COLUMNS.find((c) => c.id === sortColumn) || COLUMNS[0];
    visible.sort((a, b) => {
      const result = column.compare(a, b);
      if (result !== 0) return sortAscending ? result : -result;
      return a.pid - b.pid;
    });

    const seen = new Set();
    let previous = null;
    for (const proc of visible) {
      seen.add(proc.pid);
      let record = rows.get(proc.pid);
      if (!record) {
        record = makeRow(proc);
        rows.set(proc.pid, record);
      }
      COLUMNS.forEach((col, index) => {
        const text = col.value(proc);
        const node = record.cells[index];
        if (node.textContent !== text) node.textContent = text;
      });
      record.tr.classList.toggle('is-stopped', proc.state === 'T');
      record.tr.classList.toggle('is-selected', proc.pid === selectedPid);
      record.tr.setAttribute('aria-selected', proc.pid === selectedPid ? 'true' : 'false');
      record.tr.title = proc.cmd;

      // Reorder without touching untouched nodes, so scroll position holds.
      const expected = previous === null ? tbody.firstChild : previous.nextSibling;
      if (expected !== record.tr) tbody.insertBefore(record.tr, expected);
      previous = record.tr;
    }

    for (const [pid, record] of rows) {
      if (seen.has(pid)) continue;
      record.tr.remove();
      rows.delete(pid);
      diskIo.delete(pid);
    }

    if (selectedPid !== null && !seen.has(selectedPid)) setSelection(null);
    else endButton.disabled = selectedPid === null;

    // `% CPU` is top-style — percent of one core — so the summary states how
    // many cores that is out of. Both the core count and the memory total come
    // from the real machine through `procs`/`device.js`.
    const totals = procs.totals();
    statusText.textContent =
      `${visible.length} of ${all.length} processes shown · ` +
      `${totals.threadCount} threads on ${procs.cores} ` +
      `${procs.cores === 1 ? 'CPU' : 'CPUs'} · ` +
      `Memory ${formatBinary(totals.memUsedMb * MIB)} of ${formatBinary(totals.memTotalMb * MIB)} · ` +
      `Load average: ${totals.load.map((v) => v.toFixed(2)).join(', ')}`;
  }

  applySortIndicators();
  update();

  return {
    el,
    update,
    show() {
      update();
    },
    destroy() {
      closeMenu();
      offDocDown();
      offDocKey();
      rows.clear();
      clear(tbody);
    },
  };
}
