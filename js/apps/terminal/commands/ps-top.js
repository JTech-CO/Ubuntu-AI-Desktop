/**
 * js/apps/terminal/commands/ps-top.js — process table commands.
 *
 * ps (default / aux / -ef), top (live full-screen refresh), kill, pkill,
 * killall and pidof, all backed by `js/core/procs.js`. Column widths and
 * header spellings match procps-ng 4.0.4 as shipped in Ubuntu 24.04.1 LTS.
 */

import { procs } from '../../../core/procs.js';
import { env } from '../../../core/env.js';
import {
  CSI, RESET, REVERSE, ok, fail, wait, aborted, onKey, termCols, termRows,
  currentUser, MONTHS_SHORT, pad0,
} from './util.js';

/** Signal names accepted by kill/pkill/killall, in `kill -l` order. */
export const SIGNALS = [
  'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1',
  'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP',
  'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR',
  'SYS',
];

/**
 * Resolve a signal spec (`9`, `KILL`, `SIGKILL`) to its number.
 * @param {string} spec
 * @returns {number} the signal number, or -1 when unknown
 */
export function signalNumber(spec) {
  const raw = String(spec).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n >= 0 && n <= 64 ? n : -1;
  }
  const name = raw.toUpperCase().replace(/^SIG/, '');
  const idx = SIGNALS.indexOf(name);
  return idx >= 0 ? idx + 1 : -1;
}

/** Virtual size in KiB derived from the resident set, like a real mapping. */
function vsz(p) {
  if (p.mem <= 0) return 0;
  return Math.round(p.mem * 1024 * 2.6 + 141000);
}

/** Resident set in KiB. */
function rss(p) {
  return Math.round(p.mem * 1024);
}

/** The controlling terminal for a process; only the shell's children have one. */
function ttyOf(p) {
  return p.tty || '?';
}

/**
 * procps STAT field: state letter plus the `<N Ls l+` modifier flags.
 * @param {object} p
 * @returns {string}
 */
function statOf(p) {
  let s = p.state || 'S';
  if (p.kernel || p.nice < 0) s += '<';
  else if (p.nice > 0) s += 'N';
  if (p.ppid === 1 || p.pid === 1) s += 's';
  if (p.threads > 1) s += 'l';
  if (ttyOf(p) !== '?') s += '+';
  return s;
}

/** `09:14` for today, `Aug17` for anything older — exactly what ps prints. */
function startOf(p) {
  const d = new Date(p.startedAt);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad0(d.getHours())}:${pad0(d.getMinutes())}`;
  return `${MONTHS_SHORT[d.getMonth()]}${pad0(d.getDate())}`;
}

/** `0:03` — minutes:seconds of accumulated CPU time (`ps aux`). */
function cpuTimeShort(p) {
  const total = Math.floor(p.cpuTime);
  return `${Math.floor(total / 60)}:${pad0(total % 60)}`;
}

/** `00:00:03` — hours:minutes:seconds (`ps`, `ps -ef`). */
function cpuTimeLong(p) {
  const total = Math.floor(p.cpuTime);
  return `${pad0(Math.floor(total / 3600))}:${pad0(Math.floor((total % 3600) / 60))}:${pad0(total % 60)}`;
}

/** `0:12.34` — top's TIME+ column. */
function cpuTimePlus(p) {
  const total = p.cpuTime;
  const mins = Math.floor(total / 60);
  const secs = total - mins * 60;
  return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
}

/**
 * The process list a terminal command should see: everything in `procs`, plus
 * the interactive bash and the command itself, which really do exist.
 * @param {string} self the name of the running command
 * @returns {object[]} ordered by pid
 */
export function processList(self) {
  const list = procs.list();
  const user = currentUser();
  const bashPid = env.pid;
  const selfPid = bashPid + 11;
  const started = procs.bootTime + 9_600_000;
  list.push({
    pid: bashPid, ppid: 2413, user, name: 'bash', cmd: 'bash',
    cpu: 0.0, mem: 4.6, state: 'S', startedAt: started, cpuTime: 0.31,
    nice: 0, prio: 20, threads: 1, kernel: false, tty: 'pts/0',
  });
  if (self) {
    list.push({
      pid: selfPid, ppid: bashPid, user, name: self, cmd: self,
      cpu: 0.0, mem: 3.8, state: 'R', startedAt: Date.now(), cpuTime: 0,
      nice: 0, prio: 20, threads: 1, kernel: false, tty: 'pts/0',
    });
  }
  return list.sort((a, b) => a.pid - b.pid);
}

/* ------------------------------------------------------------------ *
 * ps
 * ------------------------------------------------------------------ */

function psDefault(list) {
  const rows = [`${'PID'.padStart(7)} ${'TTY'.padEnd(8)} ${'TIME'.padStart(8)} CMD`];
  for (const p of list) {
    if (ttyOf(p) === '?') continue;
    rows.push(`${String(p.pid).padStart(7)} ${ttyOf(p).padEnd(8)} ${cpuTimeLong(p).padStart(8)} ${p.name}`);
  }
  return `${rows.join('\n')}\n`;
}

function psAux(list, totalMem) {
  const rows = [
    `${'USER'.padEnd(8)} ${'PID'.padStart(7)} ${'%CPU'.padStart(4)} ${'%MEM'.padStart(4)} `
    + `${'VSZ'.padStart(6)} ${'RSS'.padStart(5)} ${'TTY'.padEnd(8)} ${'STAT'.padEnd(4)} `
    + `${'START'.padEnd(5)} ${'TIME'.padStart(6)} COMMAND`,
  ];
  for (const p of list) {
    const memPct = totalMem > 0 ? (p.mem / totalMem) * 100 : 0;
    rows.push(
      `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${p.cpu.toFixed(1).padStart(4)} `
      + `${memPct.toFixed(1).padStart(4)} ${String(vsz(p)).padStart(6)} ${String(rss(p)).padStart(5)} `
      + `${ttyOf(p).padEnd(8)} ${statOf(p).padEnd(4)} ${startOf(p).padEnd(5)} `
      + `${cpuTimeShort(p).padStart(6)} ${p.kernel ? `[${p.name}]` : p.cmd}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

function psEf(list) {
  const rows = [
    `${'UID'.padEnd(8)} ${'PID'.padStart(7)} ${'PPID'.padStart(7)} ${'C'.padStart(2)} `
    + `${'STIME'.padEnd(5)} ${'TTY'.padEnd(8)} ${'TIME'.padStart(8)} CMD`,
  ];
  for (const p of list) {
    rows.push(
      `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)} `
      + `${String(Math.round(p.cpu)).padStart(2)} ${startOf(p).padEnd(5)} ${ttyOf(p).padEnd(8)} `
      + `${cpuTimeLong(p).padStart(8)} ${p.kernel ? `[${p.name}]` : p.cmd}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * top
 * ------------------------------------------------------------------ */

/**
 * Render one full `top` screen.
 * @param {number} cols terminal width
 * @param {number} rows terminal height
 * @param {string} sortKey `cpu` or `mem`
 * @returns {string}
 */
export function renderTop(cols, rows, sortKey = 'cpu') {
  const totals = procs.totals();
  const list = processList('top');
  const now = new Date();

  const upSecs = Math.floor(procs.uptime());
  const upDays = Math.floor(upSecs / 86400);
  const upHours = Math.floor((upSecs % 86400) / 3600);
  const upMins = Math.floor((upSecs % 3600) / 60);
  const upText = upDays > 0
    ? `${upDays} day${upDays === 1 ? '' : 's'}, ${upHours}:${pad0(upMins)}`
    : upHours > 0 ? `${String(upHours).padStart(2)}:${pad0(upMins)}` : `${upMins} min`;

  const running = list.filter((p) => p.state === 'R').length;
  const stopped = list.filter((p) => p.state === 'T').length;
  const zombie = list.filter((p) => p.state === 'Z').length;
  const sleeping = list.length - running - stopped - zombie;

  const us = Math.min(99.9, totals.cpu * 0.72);
  const sy = Math.min(99.9, totals.cpu * 0.25);
  const wa = Math.min(9.9, totals.cpu * 0.02);
  const si = Math.min(9.9, totals.cpu * 0.01);
  const id = Math.max(0, 100 - us - sy - wa - si);

  const memTotal = totals.memTotalMb;
  const memUsed = totals.memUsedMb;
  const buff = Math.round(memTotal * 0.21);
  const memFree = Math.max(0, memTotal - memUsed - buff);
  const avail = Math.max(0, memFree + buff * 0.92);
  const swapTotal = totals.swapTotalMb;
  const swapUsed = totals.swapUsedMb;

  const out = [];
  out.push(`top - ${pad0(now.getHours())}:${pad0(now.getMinutes())}:${pad0(now.getSeconds())} up ${upText},  1 user,  load average: ${totals.load.map((l) => l.toFixed(2)).join(', ')}`);
  out.push(`Tasks: ${String(list.length).padStart(3)} total, ${String(running).padStart(3)} running, ${String(sleeping).padStart(3)} sleeping, ${String(stopped).padStart(3)} stopped, ${String(zombie).padStart(3)} zombie`);
  out.push(`%Cpu(s): ${us.toFixed(1).padStart(4)} us, ${sy.toFixed(1).padStart(4)} sy, ${(0).toFixed(1).padStart(4)} ni, ${id.toFixed(1).padStart(4)} id, ${wa.toFixed(1).padStart(4)} wa, ${(0).toFixed(1).padStart(4)} hi, ${si.toFixed(1).padStart(4)} si, ${(0).toFixed(1).padStart(4)} st`);
  out.push(`MiB Mem :${memTotal.toFixed(1).padStart(9)} total,${memFree.toFixed(1).padStart(9)} free,${memUsed.toFixed(1).padStart(9)} used,${buff.toFixed(1).padStart(9)} buff/cache`);
  out.push(`MiB Swap:${swapTotal.toFixed(1).padStart(9)} total,${(swapTotal - swapUsed).toFixed(1).padStart(9)} free,${swapUsed.toFixed(1).padStart(9)} used.${avail.toFixed(1).padStart(9)} avail Mem`);
  out.push('');

  const header = `${'PID'.padStart(7)} ${'USER'.padEnd(9)} ${'PR'.padStart(2)} ${'NI'.padStart(3)} `
    + `${'VIRT'.padStart(7)} ${'RES'.padStart(6)} ${'SHR'.padStart(6)} S ${'%CPU'.padStart(5)} `
    + `${'%MEM'.padStart(5)} ${'TIME+'.padStart(9)} COMMAND`;
  out.push(`${REVERSE}${header.padEnd(cols).slice(0, cols)}${RESET}`);

  const sorted = list.slice().sort((a, b) => (sortKey === 'mem' ? b.mem - a.mem : b.cpu - a.cpu || b.mem - a.mem));
  const limit = Math.max(1, rows - out.length - 1);
  for (const p of sorted.slice(0, limit)) {
    const pr = p.kernel || p.nice < 0 ? '0' : '20';
    const ni = p.kernel ? '-20' : String(p.nice);
    const memPct = memTotal > 0 ? (p.mem / memTotal) * 100 : 0;
    const row = `${String(p.pid).padStart(7)} ${p.user.slice(0, 9).padEnd(9)} ${pr.padStart(2)} ${ni.padStart(3)} `
      + `${String(vsz(p)).padStart(7)} ${String(rss(p)).padStart(6)} ${String(Math.round(rss(p) * 0.32)).padStart(6)} `
      + `${(p.state || 'S')[0]} ${p.cpu.toFixed(1).padStart(5)} ${memPct.toFixed(1).padStart(5)} `
      + `${cpuTimePlus(p).padStart(9)} ${p.name}`;
    out.push(row.slice(0, cols));
  }
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const psTopCommands = [
  {
    name: 'ps',
    aliases: [],
    synopsis: 'ps [aux] [-ef] [-e] [-p PID]',
    description: 'Report a snapshot of the current processes',
    man: `NAME
       ps - report a snapshot of the current processes

SYNOPSIS
       ps [options]

DESCRIPTION
       ps displays information about a selection of the active processes. If
       you want a repetitive update of the selection and the displayed
       information, use top instead.

       By default ps selects all processes with the same effective user ID as
       the current user and associated with the same terminal as the invoker.

OPTIONS
       a      Lift the "only yourself" restriction (BSD syntax).
       u      Display user-oriented format (BSD syntax).
       x      Lift the "must have a tty" restriction (BSD syntax).
       -e, -A Select all processes.
       -f     Do full-format listing.
       -p PIDLIST
              Select by process ID.`,
    async run(ctx) {
      const argv = ctx.argv;
      const bsd = argv.filter((a) => !a.startsWith('-')).join('');
      const flags = argv.filter((a) => a.startsWith('-')).join('');
      const wantAll = /[ax]/.test(bsd) || /[eA]/.test(flags);
      const wantUser = /u/.test(bsd);
      const wantFull = /f/.test(flags);

      let list = processList('ps');
      const pIdx = argv.findIndex((a) => a === '-p' || a === '--pid');
      if (pIdx >= 0 && argv[pIdx + 1]) {
        const wanted = new Set(argv[pIdx + 1].split(/[, ]+/).map(Number));
        list = list.filter((p) => wanted.has(p.pid));
      }

      if (wantUser) return ok(psAux(list, procs.totals().memTotalMb));
      if (wantFull) return ok(psEf(list));
      if (wantAll) {
        const rows = [`${'PID'.padStart(7)} ${'TTY'.padEnd(8)} ${'TIME'.padStart(8)} CMD`];
        for (const p of list) {
          rows.push(`${String(p.pid).padStart(7)} ${ttyOf(p).padEnd(8)} ${cpuTimeLong(p).padStart(8)} ${p.name}`);
        }
        return ok(`${rows.join('\n')}\n`);
      }
      return ok(psDefault(list));
    },
  },

  {
    name: 'top',
    aliases: [],
    synopsis: 'top [-b] [-n LIMIT] [-o FIELD]',
    description: 'Display Linux processes',
    man: `NAME
       top - display Linux processes

SYNOPSIS
       top [options]

DESCRIPTION
       The top program provides a dynamic real-time view of a running system.
       It can display system summary information as well as a list of processes
       currently being managed by the Linux kernel.

       Press q or Ctrl+C to quit.

OPTIONS
       -b     Batch mode: send output to stdout without redrawing the screen.
       -n LIMIT
              Redraw LIMIT times, then exit.
       -o FIELD
              Sort by FIELD; %CPU (the default) or %MEM.`,
    async run(ctx) {
      const argv = ctx.argv;
      const batch = argv.includes('-b');
      let limit = Infinity;
      let sortKey = 'cpu';
      for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '-n' && argv[i + 1]) { limit = Math.max(1, Number(argv[i + 1]) || 1); i += 1; }
        else if (argv[i] === '-o' && argv[i + 1]) { sortKey = /mem/i.test(argv[i + 1]) ? 'mem' : 'cpu'; i += 1; }
      }

      const cols = termCols(ctx);
      const rows = termRows(ctx);

      if (batch) {
        const frames = [];
        const count = Number.isFinite(limit) ? limit : 1;
        for (let i = 0; i < count; i += 1) {
          frames.push(renderTop(cols, rows, sortKey));
          if (i < count - 1) {
            await wait(1000, ctx.signal);
            if (aborted(ctx.signal)) break;
          }
        }
        return ok(frames.join('\n'));
      }

      let quit = false;
      const off = onKey(ctx.term, (key) => {
        const k = String(key).toLowerCase();
        if (k === 'q') quit = true;
        else if (k === 'm') sortKey = 'mem';
        else if (k === 'p') sortKey = 'cpu';
      });

      try {
        let drawn = 0;
        while (!quit && !aborted(ctx.signal) && drawn < limit) {
          ctx.term.clear();
          ctx.term.write(renderTop(cols, rows, sortKey));
          drawn += 1;
          if (drawn >= limit) break;
          await wait(1000, ctx.signal);
        }
      } finally {
        if (off) off();
      }
      ctx.term.clear();
      return { stdout: '', stderr: '', code: 0 };
    },
  },

  {
    name: 'kill',
    aliases: [],
    synopsis: 'kill [-s SIGNAL | -SIGNAL] PID...',
    description: 'Send a signal to a process',
    man: `NAME
       kill - send a signal to a process

SYNOPSIS
       kill [-s signal|-p] [-q value] [-a] [--] pid|name...
       kill -l [signal]

DESCRIPTION
       The default signal for kill is TERM. Use -l or -L to list available
       signals. Particularly useful signals include HUP, INT, KILL, STOP, CONT
       and 0.

OPTIONS
       -s, --signal SIGNAL
              The signal to send, by name or number.
       -l, --list
              List signal names.`,
    async run(ctx) {
      const argv = ctx.argv.slice();
      if (argv.length === 0) {
        return fail('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n', 2);
      }
      if (argv[0] === '-l' || argv[0] === '--list') {
        const names = SIGNALS.map((s, i) => `${String(i + 1).padStart(2)}) SIG${s.padEnd(7)}`);
        const lines = [];
        for (let i = 0; i < names.length; i += 4) lines.push(names.slice(i, i + 4).join('').replace(/\s+$/, ''));
        return ok(`${lines.join('\n')}\n`);
      }

      let signal = 15;
      const pids = [];
      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-s' || a === '--signal' || a === '-n') {
          const n = signalNumber(argv[i + 1] || '');
          if (n < 0) return fail(`kill: ${argv[i + 1]}: invalid signal specification\n`, 1);
          signal = n;
          i += 1;
        } else if (/^-[A-Za-z]/.test(a)) {
          const n = signalNumber(a.slice(1));
          if (n < 0) return fail(`bash: kill: ${a.slice(1)}: invalid signal specification\n`, 1);
          signal = n;
        } else if (/^-\d+$/.test(a)) {
          signal = Number(a.slice(1));
        } else if (a !== '--') {
          pids.push(a);
        }
      }
      if (pids.length === 0) {
        return fail('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n', 2);
      }

      const errors = [];
      for (const raw of pids) {
        const pid = Number(raw);
        if (!Number.isFinite(pid)) {
          errors.push(`bash: kill: ${raw}: arguments must be process or job IDs`);
          continue;
        }
        if (!procs.kill(pid, signal)) {
          errors.push(`bash: kill: (${pid}) - No such process`);
        }
      }
      if (errors.length) return fail(`${errors.join('\n')}\n`, 1);
      return ok('');
    },
  },

  {
    name: 'pkill',
    aliases: [],
    synopsis: 'pkill [-SIGNAL] [-f] [-u USER] PATTERN',
    description: 'Signal processes based on name and other attributes',
    man: `NAME
       pkill - signal processes based on name and other attributes

SYNOPSIS
       pkill [options] pattern

DESCRIPTION
       pkill will send the specified signal (by default SIGTERM) to each
       process instead of listing them on stdout.

OPTIONS
       -SIGNAL, --signal SIGNAL
              Defines the signal to send to each matched process.
       -f, --full
              The pattern is matched against the full command line.
       -u, --euid USER
              Only match processes whose effective user ID is listed.
       -x, --exact
              Only match processes whose name exactly matches the pattern.`,
    async run(ctx) {
      const argv = ctx.argv;
      let signal = 15;
      let full = false;
      let exact = false;
      let user = '';
      let pattern = '';
      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-f' || a === '--full') full = true;
        else if (a === '-x' || a === '--exact') exact = true;
        else if (a === '-u' || a === '--euid') { user = argv[i + 1] || ''; i += 1; }
        else if (a === '-signal' || a === '--signal') { signal = signalNumber(argv[i + 1] || ''); i += 1; }
        else if (/^-[A-Za-z]+$/.test(a) && signalNumber(a.slice(1)) > 0) signal = signalNumber(a.slice(1));
        else if (/^-\d+$/.test(a)) signal = Number(a.slice(1));
        else if (!a.startsWith('-')) pattern = a;
      }
      if (pattern === '') {
        return fail('pkill: no matching criteria specified\nTry `pkill --help\' for more information.\n', 2);
      }

      let matches = full ? procs.search(pattern) : procs.find(pattern);
      if (!full && matches.length === 0 && !exact) {
        const re = new RegExp(pattern);
        matches = procs.list().filter((p) => re.test(p.name));
      }
      if (user) matches = matches.filter((p) => p.user === user);
      if (matches.length === 0) return { stdout: '', stderr: '', code: 1 };
      for (const p of matches) procs.kill(p.pid, signal);
      return ok('');
    },
  },

  {
    name: 'killall',
    aliases: [],
    synopsis: 'killall [-SIGNAL] NAME...',
    description: 'Kill processes by name',
    man: `NAME
       killall - kill processes by name

SYNOPSIS
       killall [-Z CONTEXT] [-u USER] [-y TIME] [-o TIME] [-eIgiqrvw] [-s SIGNAL|-SIGNAL] NAME...

DESCRIPTION
       killall sends a signal to all processes running any of the specified
       commands. If no signal name is specified, SIGTERM is sent.

OPTIONS
       -s, --signal SIGNAL
              Send this signal instead of SIGTERM.
       -q, --quiet
              Do not complain if no processes were killed.
       -v, --verbose
              Report if the signal was successfully sent.`,
    async run(ctx) {
      const argv = ctx.argv;
      let signal = 15;
      let quiet = false;
      let verbose = false;
      const names = [];
      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-s' || a === '--signal') { signal = signalNumber(argv[i + 1] || ''); i += 1; }
        else if (a === '-q' || a === '--quiet') quiet = true;
        else if (a === '-v' || a === '--verbose') verbose = true;
        else if (/^-[A-Za-z]+$/.test(a) && signalNumber(a.slice(1)) > 0) signal = signalNumber(a.slice(1));
        else if (/^-\d+$/.test(a)) signal = Number(a.slice(1));
        else if (!a.startsWith('-')) names.push(a);
      }
      if (names.length === 0) return fail('killall: usage: killall [OPTION]... [--] NAME...\n', 1);

      const out = [];
      const errors = [];
      for (const name of names) {
        const matches = procs.find(name);
        if (matches.length === 0) {
          if (!quiet) errors.push(`${name}: no process found`);
          continue;
        }
        for (const p of matches) {
          procs.kill(p.pid, signal);
          if (verbose) out.push(`Killed ${p.name}(${p.pid}) with signal ${signal}`);
        }
      }
      if (errors.length) return { stdout: out.join('\n'), stderr: `${errors.join('\n')}\n`, code: 1 };
      return ok(out.length ? `${out.join('\n')}\n` : '');
    },
  },

  {
    name: 'pidof',
    aliases: [],
    synopsis: 'pidof [-s] [-x] PROGRAM...',
    description: 'Find the process ID of a running program',
    man: `NAME
       pidof - find the process ID of a running program

SYNOPSIS
       pidof [options] [program...]

DESCRIPTION
       pidof finds the process IDs of the named programs. It prints those IDs
       on the standard output.

OPTIONS
       -s, --single-shot
              Only return one PID.
       -x     Also return PIDs of shells running the named scripts.
       -q     Quiet mode, only set the exit code.`,
    async run(ctx) {
      const argv = ctx.argv;
      const single = argv.includes('-s') || argv.includes('--single-shot');
      const quiet = argv.includes('-q');
      const names = argv.filter((a) => !a.startsWith('-'));
      if (names.length === 0) return { stdout: '', stderr: '', code: 1 };

      const pids = [];
      for (const name of names) {
        for (const p of procs.find(name)) pids.push(p.pid);
      }
      if (pids.length === 0) return { stdout: '', stderr: '', code: 1 };
      const sorted = pids.sort((a, b) => b - a);
      if (quiet) return { stdout: '', stderr: '', code: 0 };
      return ok(`${(single ? [sorted[0]] : sorted).join(' ')}\n`);
    },
  },

  {
    name: 'pgrep',
    aliases: [],
    synopsis: 'pgrep [-l] [-f] [-u USER] PATTERN',
    description: 'Look up processes based on name and other attributes',
    man: `NAME
       pgrep - look up processes based on name and other attributes

SYNOPSIS
       pgrep [options] pattern

DESCRIPTION
       pgrep looks through the currently running processes and lists the
       process IDs which match the selection criteria to stdout.

OPTIONS
       -l, --list-name
              List the process name as well as the process ID.
       -f, --full
              The pattern is matched against the full command line.
       -a, --list-full
              List the full command line as well as the process ID.
       -u, --euid USER
              Only match processes whose effective user ID is listed.`,
    async run(ctx) {
      const argv = ctx.argv;
      let full = false;
      let listName = false;
      let listFull = false;
      let user = '';
      let pattern = '';
      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-f' || a === '--full') full = true;
        else if (a === '-l' || a === '--list-name') listName = true;
        else if (a === '-a' || a === '--list-full') listFull = true;
        else if (a === '-u' || a === '--euid') { user = argv[i + 1] || ''; i += 1; }
        else if (!a.startsWith('-')) pattern = a;
      }
      if (pattern === '') {
        return fail('pgrep: no matching criteria specified\nTry `pgrep --help\' for more information.\n', 2);
      }
      let matches = full ? procs.search(pattern) : procs.search(pattern).filter((p) => p.name.includes(pattern));
      if (matches.length === 0) matches = procs.find(pattern);
      if (user) matches = matches.filter((p) => p.user === user);
      if (matches.length === 0) return { stdout: '', stderr: '', code: 1 };
      const lines = matches.map((p) => {
        if (listFull) return `${p.pid} ${p.cmd}`;
        if (listName) return `${p.pid} ${p.name}`;
        return String(p.pid);
      });
      return ok(`${lines.join('\n')}\n`);
    },
  },
];

export { CSI };
export default psTopCommands;
