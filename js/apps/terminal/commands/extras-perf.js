/**
 * js/apps/terminal/commands/extras-perf.js — vmstat and iostat.
 *
 * Both read the same simulated process table that backs `ps`, `top` and
 * System Monitor, so their numbers move with everything else on screen
 * instead of being decorative.
 *
 * Where a figure has no backing at all — block-device queues, interrupt
 * counts — the man page says so rather than letting the number pass for a
 * measurement.
 */

import { procs } from '../../../core/procs.js';
import { users } from '../../../core/users.js';
import { env } from '../../../core/env.js';
import { device } from '../../../core/device.js';
import { KERNEL } from './extras-x11.js';
import { ok, fail, wait, aborted, pad0 } from './util.js';

/* ------------------------------------------------------------------ *
 * shared
 * ------------------------------------------------------------------ */

/**
 * Collect output for a command that may either stream to the terminal or be
 * piped. Streaming commands write as they go when stdout is a tty; when the
 * output is captured they accumulate instead, so `vmstat 1 3 | tail -1` works.
 *
 * @param {object} ctx
 * @returns {{write(text: string): void, text(): string}}
 */
function sink(ctx) {
  let buffer = '';
  const tty = ctx.stdoutIsTTY !== false;
  return {
    write(text) {
      if (tty) ctx.term.write(text);
      else buffer += text;
    },
    text() {
      return buffer;
    },
  };
}

/** `08/18/2026` — sysstat's date column. */
function sysstatDate(d) {
  return `${pad0(d.getMonth() + 1)}/${pad0(d.getDate())}/${d.getFullYear()}`;
}

/**
 * A deterministic pseudo-random value in [0,1) derived from a seed, so
 * "cumulative" counters grow smoothly instead of jumping about.
 * @param {number} seed
 * @returns {number}
 */
function jitter(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Split system CPU time into the categories vmstat and iostat report.
 * @returns {{us:number, sy:number, id:number, wa:number, st:number, ni:number}}
 */
function cpuSplit() {
  const busy = procs.totals().cpu;
  const sy = Math.min(busy, busy * 0.34 + 0.2);
  const us = Math.max(0, busy - sy);
  const wa = Math.min(2, busy * 0.08);
  const ni = busy * 0.02;
  return { us, sy, ni, wa, st: 0, id: Math.max(0, 100 - us - sy - wa - ni) };
}

/* ================================================================== *
 * vmstat
 * ================================================================== */

/**
 * Column widths. procps prints the narrow layout until a figure no longer
 * fits — a machine with more than about 10 GiB of RAM overflows the 7-column
 * memory fields — and then `-w` is the documented answer. This picks the wide
 * layout automatically in that case so the columns never run together.
 */
const VM_NARROW = { r: 2, b: 3, mem: 7, swap: 5, io: 6, sys: 5, cpu: 3 };
const VM_WIDE = { r: 4, b: 5, mem: 13, swap: 5, io: 6, sys: 5, cpu: 4 };

/**
 * procps prints the narrow header as fixed strings, so those are reproduced
 * verbatim; only the wide layout is ruled off arithmetically.
 */
const VM_HEADER_1 =
  'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----';
const VM_HEADER_2 =
  ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st';

/** Centre a group label over `width` columns, one of which is the separator. */
function vmGroup(label, width) {
  const dashes = Math.max(0, width - 1 - label.length);
  const left = Math.ceil(dashes / 2);
  return ` ${'-'.repeat(left)}${label}${'-'.repeat(dashes - left)}`;
}

/** The two header lines for a given layout. */
function vmHeaders(w) {
  if (w === VM_NARROW) return `${VM_HEADER_1}\n${VM_HEADER_2}\n`;

  const procsWidth = w.r + w.b;
  const procsDashes = Math.max(0, procsWidth - 'procs'.length);
  const line1 =
    '-'.repeat(Math.floor(procsDashes / 2)) + 'procs' + '-'.repeat(Math.ceil(procsDashes / 2)) +
    vmGroup('memory', w.mem * 4) +
    vmGroup('swap', w.swap * 2) +
    vmGroup('io', w.io * 2) +
    vmGroup('system', w.sys * 2) +
    vmGroup('cpu', w.cpu * 5);
  const labels = [
    ['r', w.r], ['b', w.b],
    ['swpd', w.mem], ['free', w.mem], ['buff', w.mem], ['cache', w.mem],
    ['si', w.swap], ['so', w.swap],
    ['bi', w.io], ['bo', w.io],
    ['in', w.sys], ['cs', w.sys],
    ['us', w.cpu], ['sy', w.cpu], ['id', w.cpu], ['wa', w.cpu], ['st', w.cpu],
  ];
  const line2 = labels.map(([name, width]) => name.padStart(width)).join('');
  return `${line1}\n${line2}\n`;
}

/**
 * The seventeen figures of one vmstat sample, in column order.
 * @param {number} unit divisor: 1 for KiB, 1024 for MiB
 * @returns {number[]}
 */
function vmstatCells(unit) {
  const t = procs.totals();
  const c = cpuSplit();
  const counters = procs.counters();
  const memTotalKb = t.memTotalMb * 1024;
  const usedKb = t.memUsedMb * 1024;
  const buffKb = Math.round(memTotalKb * 0.019);
  const cacheKb = Math.round(memTotalKb * 0.41);
  const freeKb = Math.max(0, memTotalKb - usedKb - buffKb - cacheKb);
  const seconds = Math.floor(procs.uptime());
  const f = (n) => Math.round(n / unit);

  return [
    Math.max(1, Math.round(t.cpu / 25)),
    0,
    f(t.swapUsedMb * 1024), f(freeKb), f(buffKb), f(cacheKb),
    0, 0,
    Math.round(31 + jitter(seconds) * 12),
    Math.round(22 + jitter(seconds + 7) * 40),
    Math.round(95 + jitter(seconds + 3) * 60),
    Math.round(counters.contextSwitches / Math.max(1, seconds)),
    Math.round(c.us), Math.round(c.sy), Math.round(c.id), Math.round(c.wa), Math.round(c.st),
  ];
}

/**
 * One vmstat sample row.
 * @param {number} unit
 * @param {object} w column widths
 * @returns {string}
 */
function vmstatRow(unit, w) {
  const widths = [
    w.r, w.b, w.mem, w.mem, w.mem, w.mem, w.swap, w.swap,
    w.io, w.io, w.sys, w.sys, w.cpu, w.cpu, w.cpu, w.cpu, w.cpu,
  ];
  return vmstatCells(unit)
    .map((value, i) => String(value).padStart(widths[i]))
    .join('');
}

/** True when the memory figures no longer fit the narrow layout. */
function needsWide(unit) {
  const cells = vmstatCells(unit).slice(2, 6);
  return cells.some((n) => String(n).length >= VM_NARROW.mem);
}

/** `vmstat -s` — the one-figure-per-line summary. */
function vmstatStats() {
  const t = procs.totals();
  const c = cpuSplit();
  const counters = procs.counters();
  const memTotalKb = t.memTotalMb * 1024;
  const usedKb = t.memUsedMb * 1024;
  const buffKb = Math.round(memTotalKb * 0.019);
  const cacheKb = Math.round(memTotalKb * 0.41);
  const up = Math.floor(procs.uptime());
  const ticks = (pct) => Math.round(up * 100 * (pct / 100) * procs.cores);

  const rows = [
    [memTotalKb, 'K total memory'],
    [usedKb, 'K used memory'],
    [Math.round(usedKb * 0.62), 'K active memory'],
    [Math.round(usedKb * 0.31), 'K inactive memory'],
    [Math.max(0, memTotalKb - usedKb - buffKb - cacheKb), 'K free memory'],
    [buffKb, 'K buffer memory'],
    [cacheKb, 'K swap cache'],
    [t.swapTotalMb * 1024, 'K total swap'],
    [t.swapUsedMb * 1024, 'K used swap'],
    [(t.swapTotalMb - t.swapUsedMb) * 1024, 'K free swap'],
    [ticks(c.us), 'non-nice user cpu ticks'],
    [ticks(c.ni), 'nice user cpu ticks'],
    [ticks(c.sy), 'system cpu ticks'],
    [ticks(c.id), 'idle cpu ticks'],
    [ticks(c.wa), 'IO-wait cpu ticks'],
    [0, 'IRQ cpu ticks'],
    [0, 'softirq cpu ticks'],
    [0, 'stolen cpu ticks'],
    [Math.round(up * 31), 'pages paged in'],
    [Math.round(up * 22), 'pages paged out'],
    [0, 'pages swapped in'],
    [0, 'pages swapped out'],
    [Math.round(counters.contextSwitches / 4), 'interrupts'],
    [counters.contextSwitches, 'CPU context switches'],
    [Math.round(counters.bootTime / 1000), 'boot time'],
    [counters.forksTotal, 'forks'],
  ];
  const width = Math.max(...rows.map(([n]) => String(n).length));
  return `${rows.map(([n, label]) => `${String(n).padStart(width + 6)} ${label}`).join('\n')}\n`;
}

const vmstatCommand = {
  name: 'vmstat',
  aliases: [],
  synopsis: 'vmstat [-a] [-s] [-w] [-S unit] [delay [count]]',
  description: 'Report virtual memory statistics',
  man: `NAME
       vmstat - report virtual memory statistics

SYNOPSIS
       vmstat [options] [delay [count]]

DESCRIPTION
       Reports information about processes, memory, paging, block IO, traps,
       disks and CPU activity.

       The first report gives averages since the last reboot; every later one
       covers the preceding delay.

       Here the process, memory and CPU columns come from the same simulated
       process table that drives ps, top and System Monitor, so they move
       together and respond to anything you start or kill. The block IO and
       interrupt columns are modelled, because nothing in this desktop touches
       a block device: the virtual filesystem lives in memory and is persisted
       to localStorage.

OPTIONS
       -a, --active      Show active and inactive memory.
       -s, --stats       Display a table of memory statistics.
       -w, --wide        Wide output. This is selected automatically when a
                         memory figure would not fit the narrow columns, so
                         they never run together.
       -S, --unit k|K|m|M
                         Switch output between 1000, 1024, 1000000 and 1048576
                         bytes.
       -V, --version     Print version.

       delay             Seconds between updates.
       count             Number of updates before exiting.

EXIT STATUS
       0  success
       1  a malformed argument, or interrupted with Ctrl+C`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('-V') || argv.includes('--version')) {
      return ok('vmstat from procps-ng 4.0.4\n');
    }
    if (argv.includes('-h') || argv.includes('--help')) {
      return ok([
        'Usage:',
        ' vmstat [options] [delay [count]]',
        '',
        'Options:',
        ' -a, --active           active/inactive memory',
        ' -s, --stats            event counter statistics',
        ' -w, --wide             wide output',
        ' -S, --unit <char>      define display unit',
        '',
      ].join('\n'));
    }
    if (argv.includes('-s') || argv.includes('--stats')) return ok(vmstatStats());

    let unit = 1;
    const operands = [];
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-S' || a === '--unit') {
        const u = argv[i + 1];
        i += 1;
        unit = u === 'm' ? 1000 : u === 'M' ? 1024 : u === 'k' ? 1000 / 1024 : 1;
        continue;
      }
      if (a.startsWith('-')) continue;
      operands.push(a);
    }

    const delay = operands.length > 0 ? Number(operands[0]) : 0;
    const count = operands.length > 1 ? Number(operands[1]) : 0;

    if (operands.length > 0 && (!Number.isFinite(delay) || delay <= 0)) {
      return fail(`vmstat: delay must be a positive integer\n`, 1);
    }

    const wide = argv.includes('-w') || argv.includes('--wide') || needsWide(unit);
    const widths = wide ? VM_WIDE : VM_NARROW;
    const header = vmHeaders(widths);
    if (!delay) return ok(`${header}${vmstatRow(unit, widths)}\n`);

    const out = sink(ctx);
    out.write(header);
    let printed = 0;
    while (!aborted(ctx.signal)) {
      out.write(`${vmstatRow(unit, widths)}\n`);
      printed += 1;
      if (count && printed >= count) break;
      await wait(delay * 1000, ctx.signal);
    }
    return { stdout: out.text(), stderr: '', code: aborted(ctx.signal) ? 130 : 0 };
  },
};

/* ================================================================== *
 * iostat
 * ================================================================== */

/** The simulated block devices, matching what `lsblk` and `df` show. */
const BLOCK_DEVICES = [
  { name: 'nvme0n1', share: 1 },
  { name: 'loop0', share: 0.02 },
  { name: 'loop1', share: 0.02 },
];

const iostatCommand = {
  name: 'iostat',
  aliases: [],
  synopsis: 'iostat [-c] [-d] [-h] [-k|-m] [-x] [interval [count]]',
  description: 'Report CPU and device I/O statistics',
  man: `NAME
       iostat - report CPU statistics and input/output statistics for devices
       and partitions

SYNOPSIS
       iostat [options] [interval [count]]

DESCRIPTION
       Prints a CPU utilisation report followed by a device utilisation
       report.

       The CPU report is real in the sense that matters here: it is the same
       load the process table, top and System Monitor are showing, split into
       user/system/iowait the way the kernel does.

       The device report is modelled. This desktop's filesystem is a
       JavaScript object tree persisted to localStorage, so there is no block
       queue to measure — the counters grow smoothly with uptime rather than
       reflecting any real transfer.

OPTIONS
       -c            CPU report only.
       -d            Device report only.
       -h            Human readable device names and sizes.
       -k            Display statistics in kilobytes per second (default).
       -m            Display statistics in megabytes per second.
       -x            Extended statistics.
       -V            Print version.

EXIT STATUS
       0  success
       1  a malformed argument`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('-V') || argv.includes('--version')) {
      return ok('sysstat version 12.6.1\n(C) Sebastien Godard (sysstat <at> orange.fr)\n');
    }

    const cpuOnly = argv.includes('-c');
    const devOnly = argv.includes('-d');
    const mega = argv.includes('-m');
    const extended = argv.includes('-x');
    const operands = argv.filter((a) => !a.startsWith('-'));
    const interval = operands.length ? Number(operands[0]) : 0;
    const count = operands.length > 1 ? Number(operands[1]) : 0;

    if (operands.length && (!Number.isFinite(interval) || interval <= 0)) {
      return fail('iostat: Invalid interval\n', 1);
    }

    await device.ready();
    const cores = device.cores() || procs.cores;
    const now = new Date();
    const banner =
      `Linux ${KERNEL} (${env.host || users.hostname}) \t${sysstatDate(now)} \t_${device.arch()}_\t(${cores} CPU)\n`;

    const build = () => {
      const parts = [];
      if (!devOnly) {
        const c = cpuSplit();
        parts.push('');
        parts.push('avg-cpu:  %user   %nice %system %iowait  %steal   %idle');
        parts.push(
          c.us.toFixed(2).padStart(15) +
          c.ni.toFixed(2).padStart(8) +
          c.sy.toFixed(2).padStart(8) +
          c.wa.toFixed(2).padStart(8) +
          c.st.toFixed(2).padStart(8) +
          c.id.toFixed(2).padStart(8),
        );
      }
      if (!cpuOnly) {
        const up = Math.max(1, procs.uptime());
        parts.push('');
        if (extended) {
          parts.push('Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz  aqu-sz  %util');
        } else {
          parts.push('Device             tps    kB_read/s    kB_wrtn/s    kB_dscd/s    kB_read    kB_wrtn    kB_dscd');
        }
        for (const dev of BLOCK_DEVICES) {
          const readKb = Math.round(up * 88 * dev.share);
          const writeKb = Math.round(up * 142 * dev.share);
          const tps = (4.21 * dev.share).toFixed(2);
          if (extended) {
            parts.push(
              dev.name.padEnd(9) +
              (1.9 * dev.share).toFixed(2).padStart(9) +
              (readKb / up).toFixed(2).padStart(10) +
              (0.4 * dev.share).toFixed(2).padStart(9) +
              (17.2 * dev.share).toFixed(2).padStart(7) +
              (0.31).toFixed(2).padStart(8) +
              (readKb / up / Math.max(0.01, 1.9 * dev.share)).toFixed(2).padStart(9) +
              (2.31 * dev.share).toFixed(2).padStart(8) +
              (writeKb / up).toFixed(2).padStart(10) +
              (1.1 * dev.share).toFixed(2).padStart(9) +
              (32.2 * dev.share).toFixed(2).padStart(7) +
              (0.44).toFixed(2).padStart(8) +
              (writeKb / up / Math.max(0.01, 2.31 * dev.share)).toFixed(2).padStart(9) +
              (0.01).toFixed(2).padStart(8) +
              (0.42 * dev.share).toFixed(2).padStart(7),
            );
          } else {
            const scale = mega ? 1024 : 1;
            parts.push(
              dev.name.padEnd(9) +
              tps.padStart(13) +
              (readKb / up / scale).toFixed(2).padStart(13) +
              (writeKb / up / scale).toFixed(2).padStart(13) +
              (0).toFixed(2).padStart(13) +
              String(Math.round(readKb / scale)).padStart(11) +
              String(Math.round(writeKb / scale)).padStart(11) +
              '0'.padStart(11),
            );
          }
        }
      }
      parts.push('');
      return `${parts.join('\n')}\n`;
    };

    if (!interval) return ok(`${banner}${build()}`);

    const out = sink(ctx);
    out.write(banner);
    let printed = 0;
    while (!aborted(ctx.signal)) {
      out.write(build());
      printed += 1;
      if (count && printed >= count) break;
      await wait(interval * 1000, ctx.signal);
    }
    return { stdout: out.text(), stderr: '', code: aborted(ctx.signal) ? 130 : 0 };
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const perfCommands = [
  vmstatCommand,
  iostatCommand,
];

export default perfCommands;
