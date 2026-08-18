/**
 * js/apps/monitor/filesystems.js — the "File Systems" tab of System Monitor,
 * and the single mount table that `df`, `lsblk` and this tab all report from.
 *
 * The numbers here are as real as a web page can make them:
 *
 *  - `/` is the emulator's own filesystem. Its capacity is the browser's
 *    storage quota (`navigator.storage.estimate()`), because that is genuinely
 *    all the space this page may occupy. It is *not* the size of the machine's
 *    disk, and it is not labelled as one — the device is `/dev/uad0p1`, a
 *    virtual disk, rather than a pretend `/dev/sda2`. Its usage is the real
 *    byte count of the virtual tree, so writing a file in the Terminal moves
 *    the bar here, in `df` and in the Files status bar together.
 *  - the tmpfs mounts are sized exactly the way systemd sizes them: `/run` and
 *    `/run/user/1000` at 10% of RAM, `/dev/shm` at 50%, `/run/lock` at a fixed
 *    5 MiB. RAM comes from `device.js`, so they track the real machine too.
 *
 * There is no `/boot/efi` and no `efivarfs` row: this page cannot see firmware,
 * so it does not claim to.
 */

import { h } from '../../core/dom.js';
import { bus } from '../../core/bus.js';
import { fs } from '../../core/fs.js';
import { device } from '../../core/device.js';
import { procs } from '../../core/procs.js';
import { formatDecimal } from './charts.js';

const MIB = 1024 * 1024;

/**
 * Capacity used for `/` when the browser refuses to report a storage quota
 * (Safari in private browsing, Firefox with `dom.storage` locked down). It is a
 * placeholder, and callers that can say so — `df` prints a note on stderr —
 * should say so.
 */
export const FALLBACK_ROOT_BYTES = 2 * 1024 * MIB;

/** @returns {boolean} true when `/`'s capacity is the real browser quota */
export function rootCapacityIsReal() {
  return device.diskTotalBytes() > 0;
}

/**
 * Resolve the live mount table.
 *
 * @returns {{device:string, directory:string, type:string, total:number,
 *            used:number, available:number, percent:number}[]}
 */
export function mountTable() {
  let treeBytes = 0;
  try {
    treeBytes = fs.du('/');
  } catch {
    treeBytes = 0;
  }

  const quota = device.diskTotalBytes();
  // The placeholder has to be at least large enough to hold what the tree
  // already contains, or `/` would sit at a nonsensical 100% full.
  const rootTotal = quota > 0 ? quota : Math.max(FALLBACK_ROOT_BYTES, treeBytes * 4);
  const ram = procs.totals().memTotalMb * MIB;

  /** @type {{device:string, directory:string, type:string, total:number, used:number}[]} */
  const specs = [
    { device: '/dev/uad0p1', directory: '/', type: 'ext4', total: rootTotal, used: Math.min(rootTotal, treeBytes) },
    { device: 'tmpfs', directory: '/run', type: 'tmpfs', total: ram * 0.1, used: 2.1 * MIB },
    { device: 'tmpfs', directory: '/dev/shm', type: 'tmpfs', total: ram * 0.5, used: 0 },
    { device: 'tmpfs', directory: '/run/lock', type: 'tmpfs', total: 5 * MIB, used: 4096 },
    { device: 'tmpfs', directory: '/run/user/1000', type: 'tmpfs', total: ram * 0.1, used: 144 * 1024 },
  ];

  return specs.map((mount) => {
    const total = Math.max(0, Math.round(mount.total));
    const used = Math.min(total, Math.max(0, Math.round(mount.used)));
    return {
      device: mount.device,
      directory: mount.directory,
      type: mount.type,
      total,
      used,
      available: Math.max(0, total - used),
      percent: total > 0 ? (used / total) * 100 : 0,
    };
  });
}

const COLUMNS = [
  { id: 'device', label: 'Device', align: 'left' },
  { id: 'directory', label: 'Directory', align: 'left' },
  { id: 'type', label: 'Type', align: 'left' },
  { id: 'total', label: 'Total', align: 'right' },
  { id: 'available', label: 'Available', align: 'right' },
  { id: 'used', label: 'Used', align: 'left' },
];

/**
 * @returns {{el: HTMLElement, update(): void, show(): void, destroy(): void}}
 */
export function createFileSystemsTab() {
  const headRow = h('tr');
  for (const column of COLUMNS) {
    headRow.appendChild(h('th', { class: `is-${column.align}`, scope: 'col', text: column.label }));
  }

  const tbody = h('tbody');
  const table = h('table.mon-table.mon-table--fs', {}, h('thead', {}, headRow), tbody);

  // The capacity of `/` is a browser storage quota, not a disk. Say so on the
  // page rather than letting the number be read as the size of a real drive.
  const note = h('p.mon-fs-note', {
    style: { margin: '10px 4px 0', fontSize: '12px', opacity: '0.7', lineHeight: '1.5' },
    text: '',
  });

  const el = h('div.mon-tab.mon-tab--filesystems', {}, h('div.mon-table-scroll', {}, table), note);

  /** @type {Map<string, {total:HTMLElement, available:HTMLElement, bar:HTMLElement, text:HTMLElement}>} */
  const rows = new Map();

  function ensureRow(mount) {
    let record = rows.get(mount.directory);
    if (record) return record;

    const total = h('td.is-right');
    const available = h('td.is-right');
    const bar = h('span.mon-usage__fill');
    const text = h('span.mon-usage__text');
    const usedCell = h(
      'td.is-left',
      {},
      h('div.mon-usage', {}, h('span.mon-usage__track', {}, bar), text),
    );

    const tr = h(
      'tr',
      {},
      h('td.is-left', { text: mount.device }),
      h('td.is-left', { text: mount.directory }),
      h('td.is-left', { text: mount.type }),
      total,
      available,
      usedCell,
    );
    tbody.appendChild(tr);
    record = { total, available, bar, text };
    rows.set(mount.directory, record);
    return record;
  }

  function update() {
    for (const mount of mountTable()) {
      const record = ensureRow(mount);
      record.total.textContent = formatDecimal(mount.total);
      record.available.textContent = formatDecimal(mount.available);
      const percent = Math.min(100, Math.max(0, mount.percent));
      record.bar.style.width = `${percent.toFixed(1)}%`;
      record.bar.classList.toggle('is-warning', percent >= 85 && percent < 95);
      record.bar.classList.toggle('is-critical', percent >= 95);
      record.text.textContent = `${formatDecimal(mount.used)} (${percent.toFixed(1)}%)`;
    }

    note.textContent = rootCapacityIsReal()
      ? '/dev/uad0p1 is this desktop’s own filesystem. Its capacity is the storage quota '
        + 'the browser grants this page, not the size of the machine’s disk. The tmpfs '
        + 'mounts are sized from real system memory the way systemd sizes them.'
      : 'This browser did not report a storage quota, so the capacity shown for '
        + '/dev/uad0p1 is a placeholder. Its usage, and every tmpfs size, are real.';
  }

  // Writing a file in the Terminal or Files should move the root usage bar.
  const offChange = bus.on('fs:change', () => update());

  update();
  // The storage quota arrives from an async probe; redraw once it lands.
  device.ready().then(() => { if (el.isConnected) update(); }, () => {});

  return {
    el,
    update,
    show() {
      update();
    },
    destroy() {
      offChange();
      rows.clear();
    },
  };
}
