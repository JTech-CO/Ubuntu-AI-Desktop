/**
 * js/apps/terminal/commands/extras-lsof.js — lsof and fuser.
 *
 * Both walk the simulated process table that ps, top and System Monitor read,
 * and the socket table that ss and netstat read, so all five agree about what
 * is running and what is listening. The descriptors are derived from what each
 * process is — its working directory, its executable, the C library, the three
 * standard streams — rather than measured from a kernel, because there is no
 * kernel; the man pages say so.
 *
 * `fuser -k` is not decorative: it signals through the same process table kill
 * uses, so it really does end a process.
 */

import { procs } from '../../../core/procs.js';
import { env } from '../../../core/env.js';
import { fs } from '../../../core/fs.js';
import { sockets } from './net.js';
import { ok, fail } from './util.js';

/**
 * The file descriptors a process is holding, derived from what it is.
 * @param {object} proc
 * @returns {{fd:string, type:string, device:string, size:string, node:number, name:string}[]}
 */
function fdsOf(proc) {
  const rows = [
    { fd: 'cwd', type: 'DIR', device: '259,2', size: '4096', node: 2, name: '/' },
    { fd: 'rtd', type: 'DIR', device: '259,2', size: '4096', node: 2, name: '/' },
  ];
  const binary = proc.cmd.split(' ')[0];
  if (binary.startsWith('/')) {
    rows.push({ fd: 'txt', type: 'REG', device: '259,2', size: `${String(64 + (proc.pid % 900))}000`, node: 1000 + proc.pid, name: binary });
    rows.push({ fd: 'mem', type: 'REG', device: '259,2', size: '2125328', node: 3145, name: '/usr/lib/x86_64-linux-gnu/libc.so.6' });
  }
  for (const fd of ['0r', '1w', '2w']) {
    rows.push({ fd, type: 'CHR', device: '1,3', size: '0t0', node: 5, name: '/dev/null' });
  }
  return rows;
}

/* ================================================================== *
 * lsof
 * ================================================================== */

const lsofCommand = {
  name: 'lsof',
  aliases: [],
  synopsis: 'lsof [-p PID] [-u USER] [-c COMMAND] [-i] [-t] [FILE]...',
  description: 'List open files',
  man: `NAME
       lsof - list open files

SYNOPSIS
       lsof [options] [names]

DESCRIPTION
       Lists the files that processes have open. On Linux everything is a
       file, so this also covers directories, devices and sockets.

       In this desktop the process list is the simulated process table, and
       the descriptors are derived from what each process is: its working
       directory, its executable, the C library, the three standard streams,
       and — for daemons that listen — the sockets the 'ss' and 'netstat'
       commands report. They are consistent with the rest of the emulator
       rather than measured from a kernel, because there is no kernel.

OPTIONS
       -p PID       Only this process.
       -u USER      Only files owned by this user.
       -c COMMAND   Only processes whose name begins with COMMAND.
       -i           Only network files.
       -t           Terse: print process ids only, one per line.
       FILE         Only processes holding this path open.

EXIT STATUS
       0  something matched
       1  nothing matched`,

  async run(ctx) {
    const argv = ctx.argv;
    let wantPid = null;
    let wantUser = null;
    let wantCmd = null;
    let netOnly = false;
    let terse = false;
    const paths = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-t') { terse = true; continue; }
      if (a === '-i' || a.startsWith('-i')) { netOnly = true; continue; }
      if (a === '-p') { wantPid = Number(argv[++i]); continue; }
      if (a.startsWith('-p') && a.length > 2) { wantPid = Number(a.slice(2)); continue; }
      if (a === '-u') { wantUser = argv[++i]; continue; }
      if (a.startsWith('-u') && a.length > 2) { wantUser = a.slice(2); continue; }
      if (a === '-c') { wantCmd = argv[++i]; continue; }
      if (a.startsWith('-c') && a.length > 2) { wantCmd = a.slice(2); continue; }
      if (a === '-v' || a === '--version') {
        return ok('lsof version 4.95.0\n');
      }
      if (a === '+D') { paths.push(argv[++i]); continue; }
      if (a.startsWith('-')) continue;
      paths.push(a);
    }

    const rows = [];
    for (const proc of procs.list()) {
      if (wantPid !== null && proc.pid !== wantPid) continue;
      if (wantUser && proc.user !== wantUser) continue;
      if (wantCmd && !proc.name.startsWith(wantCmd)) continue;
      if (netOnly) continue;
      for (const fd of fdsOf(proc)) {
        if (paths.length) {
          const target = paths.map((p) => ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(p, env.home)));
          if (!target.some((t) => fd.name === t || fd.name.startsWith(`${t}/`))) continue;
        }
        rows.push({ proc, ...fd });
      }
    }

    if (netOnly) {
      for (const s of sockets()) {
        if (!s.owner) continue;
        // The socket table carries only { pid, name }; the process table has
        // the owning user, which the FD listing needs.
        const proc = procs.get(s.owner.pid)
          || { pid: s.owner.pid, name: s.owner.name, user: 'root' };
        if (wantPid !== null && proc.pid !== wantPid) continue;
        if (wantUser && proc.user !== wantUser) continue;
        if (wantCmd && !proc.name.startsWith(wantCmd)) continue;
        rows.push({
          proc,
          fd: `${9 + (proc.pid % 20)}u`,
          type: s.v6 ? 'IPv6' : 'IPv4',
          device: String(20000 + (proc.pid % 9000)),
          size: '0t0',
          node: s.proto.toUpperCase(),
          name: s.state === 'LISTEN'
            ? `${s.local} (LISTEN)`
            : s.peer === '0.0.0.0:*' ? s.local : `${s.local}->${s.peer} (${s.state})`,
        });
      }
    }

    if (!rows.length) return { stdout: '', stderr: '', code: 1 };

    if (terse) {
      const seen = [];
      for (const r of rows) if (!seen.includes(r.proc.pid)) seen.push(r.proc.pid);
      return ok(`${seen.join('\n')}\n`);
    }

    // lsof sizes the COMMAND and USER columns to the widest entry rather than
    // truncating, so the table stays readable with long service account names.
    const cmdW = Math.max(7, ...rows.map((r) => r.proc.name.slice(0, 15).length)) + 1;
    const userW = Math.max(4, ...rows.map((r) => String(r.proc.user).length));
    const line = (cmd, pid, user, fd, type, dev, size, node, name) =>
      cmd.padEnd(cmdW) +
      String(pid).padStart(6) + ' ' +
      String(user).padStart(userW) + ' ' +
      String(fd).padStart(4) + ' ' +
      String(type).padStart(9) + ' ' +
      String(dev).padStart(18) + ' ' +
      String(size).padStart(9) + ' ' +
      String(node).padStart(10) + ' ' +
      name;

    const out = [line('COMMAND', 'PID', 'USER', 'FD', 'TYPE', 'DEVICE', 'SIZE/OFF', 'NODE', 'NAME')];
    for (const r of rows) {
      out.push(line(r.proc.name.slice(0, 15), r.proc.pid, r.proc.user, r.fd, r.type, r.device, r.size, r.node, r.name));
    }
    return ok(`${out.join('\n')}\n`);
  },
};

/* ================================================================== *
 * fuser
 * ================================================================== */

const fuserCommand = {
  name: 'fuser',
  aliases: [],
  synopsis: 'fuser [-v] [-m] [-k] NAME... | PORT/PROTO',
  description: 'Identify processes using files or sockets',
  man: `NAME
       fuser - identify processes using files or sockets

SYNOPSIS
       fuser [-v] [-m] [-k] name...

DESCRIPTION
       Prints the process ids of processes using the given files or sockets.
       Each id is followed by an access-type letter: c for current directory,
       e for executable, f for open file, r for root directory.

       Names are matched against the same descriptor set lsof reports, and
       PORT/tcp or PORT/udp is matched against the socket table ss and netstat
       share.

       -k really does signal the matched processes through the emulator's
       process table, so it can end a running job the same way kill does.

OPTIONS
       -v, --verbose   Human readable table with USER, PID, ACCESS and COMMAND.
       -m, --mount     Match every process using the filesystem the name is on.
       -k, --kill      Send SIGKILL to the matched processes.
       -i, --interactive
                       Accepted; there is no prompt because the terminal is
                       not line-buffered here.

EXIT STATUS
       0  at least one process matched
       1  nothing matched`,

  async run(ctx) {
    const argv = ctx.argv;
    const verbose = argv.includes('-v') || argv.includes('--verbose');
    const doKill = argv.includes('-k') || argv.includes('--kill');
    const mount = argv.includes('-m') || argv.includes('--mount');
    const names = argv.filter((a) => !a.startsWith('-'));

    if (!names.length) {
      return fail('fuser: no process specification given\nUsage: fuser [-vmk] name...\n', 1);
    }

    const stdoutLines = [];
    const stderrLines = [];
    const verboseRows = [];
    let matched = false;

    for (const name of names) {
      const portMatch = /^(\d+)\/(tcp|udp)$/i.exec(name);
      const hits = [];

      if (portMatch) {
        const port = portMatch[1];
        const proto = portMatch[2].toLowerCase();
        for (const s of sockets()) {
          if (s.proto !== proto || !s.owner) continue;
          if (!s.local.endsWith(`:${port}`)) continue;
          const proc = procs.get(s.owner.pid)
            || { pid: s.owner.pid, name: s.owner.name, user: 'root' };
          hits.push({ proc, access: 'F....' });
        }
      } else {
        const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(name, env.home));
        if (!mount && !fs.exists(target)) {
          stderrLines.push(`fuser: cannot stat ${name}: No such file or directory`);
          continue;
        }
        for (const proc of procs.list()) {
          for (const fd of fdsOf(proc)) {
            const isHit = mount ? true : fd.name === target || fd.name.startsWith(`${target}/`);
            if (!isHit) continue;
            const access = fd.fd === 'cwd' ? '..c..' : fd.fd === 'txt' ? '...e.' : fd.fd === 'rtd' ? 'r....' : 'F....';
            hits.push({ proc, access });
            break;
          }
        }
      }

      if (!hits.length) {
        stderrLines.push(`${name}:`);
        continue;
      }
      // A process holding two matching descriptors is still one process, and
      // real fuser lists each pid once.
      const seenPids = new Set();
      const unique = hits.filter((hit) => {
        if (seenPids.has(hit.proc.pid)) return false;
        seenPids.add(hit.proc.pid);
        return true;
      });
      matched = true;
      stderrLines.push(`${name}:`);
      stdoutLines.push(unique.map((hit) => String(hit.proc.pid)).join(' '));
      for (const hit of unique) {
        verboseRows.push({ name, ...hit });
        if (doKill) procs.kill(hit.proc.pid, 9);
      }
    }

    if (verbose) {
      const lines = ['                     USER        PID ACCESS COMMAND'];
      let last = '';
      for (const row of verboseRows) {
        const label = row.name === last ? '' : `${row.name}:`;
        last = row.name;
        lines.push(
          label.padEnd(21) +
          row.proc.user.padEnd(11) +
          String(row.proc.pid).padStart(6) + ' ' +
          row.access + ' ' +
          row.proc.name,
        );
      }
      return { stdout: '', stderr: `${lines.join('\n')}\n`, code: matched ? 0 : 1 };
    }

    return {
      stdout: stdoutLines.length ? `${stdoutLines.join('\n')}\n` : '',
      stderr: stderrLines.length ? `${stderrLines.join('\n')}\n` : '',
      code: matched ? 0 : 1,
    };
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const lsofCommands = [
  lsofCommand,
  fuserCommand,
];

export default lsofCommands;
