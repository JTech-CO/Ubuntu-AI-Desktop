/**
 * js/apps/terminal/commands/system.js — system identity, time, accounts,
 * privileges and documentation.
 *
 * Aggregates the hardware/service commands from `system-hw.js`, the process
 * commands from `ps-top.js` and the fetch tools from `fetch.js` into the single
 * default-exported array the command index consumes.
 */

import { fs } from '../../../core/fs.js';
import { env } from '../../../core/env.js';
import { users } from '../../../core/users.js';
import { procs } from '../../../core/procs.js';
import { device } from '../../../core/device.js';
import { store } from '../../../core/store.js';
import { execute, getCommand, commandNames } from '../shell.js';
import {
  BOLD, RESET, REVERSE, ok, fail, isRoot, privilege, currentUser,
  MONTHS_SHORT, MONTHS_LONG, DAYS_SHORT, DAYS_LONG, pad0, tzAbbr, numericOffset,
  termCols, wrap, humanSize,
} from './util.js';
import hwCommands from './system-hw.js';
import psTopCommands from './ps-top.js';
import fetchCommands from './fetch.js';

/**
 * uname(2) fields for the emulated kernel.
 *
 * The kernel identity is the emulator's own fiction, but the machine hardware
 * name is not: it is the host's real architecture from `device.js`, so `uname
 * -m`, `arch`, `lscpu` and `/proc/cpuinfo` all agree about which instruction
 * set this is.
 */
const KERNEL = {
  sysname: 'Linux',
  release: '6.8.0-45-generic',
  version: '#45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024',
  get machine() { return device.arch(); },
  get processor() { return device.arch(); },
  get platform() { return device.arch(); },
  os: 'GNU/Linux',
};

/* ------------------------------------------------------------------ *
 * strftime
 * ------------------------------------------------------------------ */

/** ISO-8601 week number and week-based year. */
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
  return {
    week: 1 + Math.round((t.getTime() - firstThursday.getTime()) / 604800000),
    year: t.getFullYear(),
  };
}

/** Zero-based day of the year. */
function yday(d) {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

const STRFTIME_RE = /%([-_0^#]*)(\d*)(:?)([a-zA-Z%])/g;

/**
 * GNU date(1) format expansion.
 * @param {string} format
 * @param {Date} date
 * @param {boolean} [utc] render in UTC (`date -u`)
 * @returns {string}
 */
export function strftime(format, date, utc = false) {
  const d = utc ? new Date(date.getTime() + date.getTimezoneOffset() * 60000) : date;
  const zoneName = utc ? 'UTC' : tzAbbr(date);
  const zoneNum = utc ? '+0000' : numericOffset(date);
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

  const emit = (value, width, padChar, flags) => {
    let text = String(value);
    if (flags.includes('-')) return text;
    const fill = flags.includes('_') ? ' ' : flags.includes('0') ? '0' : padChar;
    if (width > text.length) text = text.padStart(width, fill);
    if (flags.includes('^')) text = text.toUpperCase();
    return text;
  };

  return String(format).replace(STRFTIME_RE, (match, flags, widthStr, colon, conv) => {
    const width = widthStr === '' ? 0 : Number(widthStr);
    const w = (dflt) => (width || dflt);
    switch (conv) {
      case 'a': return emit(DAYS_SHORT[d.getDay()], width, ' ', flags);
      case 'A': return emit(DAYS_LONG[d.getDay()], width, ' ', flags);
      case 'b': case 'h': return emit(MONTHS_SHORT[d.getMonth()], width, ' ', flags);
      case 'B': return emit(MONTHS_LONG[d.getMonth()], width, ' ', flags);
      case 'c': return strftime('%a %b %e %I:%M:%S %p %Z %Y', date, utc);
      case 'C': return emit(Math.floor(d.getFullYear() / 100), w(2), '0', flags);
      case 'd': return emit(d.getDate(), w(2), '0', flags);
      case 'D': return strftime('%m/%d/%y', date, utc);
      case 'e': return emit(d.getDate(), w(2), ' ', flags);
      case 'F': return strftime('%Y-%m-%d', date, utc);
      case 'g': return emit(isoWeek(d).year % 100, w(2), '0', flags);
      case 'G': return emit(isoWeek(d).year, w(4), '0', flags);
      case 'H': return emit(h24, w(2), '0', flags);
      case 'I': return emit(h12, w(2), '0', flags);
      case 'j': return emit(yday(d) + 1, w(3), '0', flags);
      case 'k': return emit(h24, w(2), ' ', flags);
      case 'l': return emit(h12, w(2), ' ', flags);
      case 'm': return emit(d.getMonth() + 1, w(2), '0', flags);
      case 'M': return emit(d.getMinutes(), w(2), '0', flags);
      case 'n': return '\n';
      case 'N': return emit(String(d.getMilliseconds() * 1e6).padStart(9, '0'), 0, '0', flags);
      case 'p': return emit(h24 < 12 ? 'AM' : 'PM', width, ' ', flags);
      case 'P': return emit(h24 < 12 ? 'am' : 'pm', width, ' ', flags);
      case 'q': return String(Math.floor(d.getMonth() / 3) + 1);
      case 'r': return strftime('%I:%M:%S %p', date, utc);
      case 'R': return strftime('%H:%M', date, utc);
      case 's': return String(Math.floor(date.getTime() / 1000));
      case 'S': return emit(d.getSeconds(), w(2), '0', flags);
      case 't': return '\t';
      case 'T': return strftime('%H:%M:%S', date, utc);
      case 'u': return String(d.getDay() === 0 ? 7 : d.getDay());
      case 'U': return emit(Math.floor((yday(d) + 7 - d.getDay()) / 7), w(2), '0', flags);
      case 'V': return emit(isoWeek(d).week, w(2), '0', flags);
      case 'w': return String(d.getDay());
      case 'W': return emit(Math.floor((yday(d) + 7 - ((d.getDay() + 6) % 7)) / 7), w(2), '0', flags);
      case 'x': return strftime('%m/%d/%Y', date, utc);
      case 'X': return strftime('%I:%M:%S %p', date, utc);
      case 'y': return emit(d.getFullYear() % 100, w(2), '0', flags);
      case 'Y': return emit(d.getFullYear(), width, ' ', flags);
      case 'z': return colon ? `${zoneNum.slice(0, 3)}:${zoneNum.slice(3)}` : zoneNum;
      case 'Z': return emit(zoneName, width, ' ', flags);
      case '%': return '%';
      default: return match;
    }
  });
}

/**
 * Parse the argument of `date -d`.
 * @param {string} spec
 * @returns {Date|null}
 */
function parseDateSpec(spec) {
  const raw = String(spec).trim();
  if (raw === '' || raw === 'now') return new Date();
  if (raw === 'today') return new Date();
  if (raw === 'tomorrow') return new Date(Date.now() + 86400000);
  if (raw === 'yesterday') return new Date(Date.now() - 86400000);
  if (/^@-?\d+(\.\d+)?$/.test(raw)) return new Date(Number(raw.slice(1)) * 1000);
  const relative = /^([-+]?\d+)\s+(second|minute|hour|day|week|month|year)s?(\s+ago)?$/i.exec(raw);
  if (relative) {
    const units = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
    const sign = relative[3] ? -1 : 1;
    return new Date(Date.now() + sign * Number(relative[1]) * units[relative[2].toLowerCase()]);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/* ------------------------------------------------------------------ *
 * cal
 * ------------------------------------------------------------------ */

/**
 * One 20-column month block: title, weekday header and six week rows.
 * @param {number} year
 * @param {number} month zero-based
 * @param {{showYear?:boolean, today?:Date, mondayFirst?:boolean}} [opts]
 * @returns {string[]} 8 lines, each 20 printable columns
 */
export function monthBlock(year, month, opts = {}) {
  const { showYear = true, today = new Date(), mondayFirst = false } = opts;
  const title = showYear ? `${MONTHS_LONG[month]} ${year}` : MONTHS_LONG[month];
  const pad = Math.max(0, Math.floor((20 - title.length) / 2));
  const lines = [`${' '.repeat(pad)}${title}`.padEnd(20)];

  const names = mondayFirst
    ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
    : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  lines.push(names.join(' '));

  const first = new Date(year, month, 1);
  const offset = mondayFirst ? (first.getDay() + 6) % 7 : first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isCurrent = today.getFullYear() === year && today.getMonth() === month;

  let day = 1 - offset;
  for (let week = 0; week < 6; week += 1) {
    const cells = [];
    for (let col = 0; col < 7; col += 1) {
      if (day < 1 || day > daysInMonth) cells.push('  ');
      else if (isCurrent && day === today.getDate()) cells.push(`${REVERSE}${String(day).padStart(2)}${RESET}`);
      else cells.push(String(day).padStart(2));
      day += 1;
    }
    lines.push(cells.join(' '));
  }
  return lines;
}

/**
 * Lay month blocks out side by side, three per row, the way cal(1) does.
 * @param {string[][]} blocks
 * @param {number} perRow
 * @returns {string}
 */
function layoutBlocks(blocks, perRow) {
  const out = [];
  for (let i = 0; i < blocks.length; i += perRow) {
    const group = blocks.slice(i, i + perRow);
    const height = Math.max(...group.map((b) => b.length));
    for (let row = 0; row < height; row += 1) {
      out.push(group.map((b) => (b[row] === undefined ? ' '.repeat(20) : b[row])).join('  ').replace(/\s+$/, ''));
    }
    if (i + perRow < blocks.length) out.push('');
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * man
 * ------------------------------------------------------------------ */

/**
 * Render a command object as a classic roff-style manual page.
 * @param {object} cmd a command object per ARCHITECTURE §17
 * @param {number} cols terminal width
 * @returns {string}
 */
export function renderMan(cmd, cols) {
  const width = Math.min(Math.max(cols, 60), 100);
  const upper = `${cmd.name.toUpperCase()}(1)`;
  const centre = 'User Commands';
  const gap1 = Math.max(1, Math.floor((width - upper.length * 2 - centre.length) / 2));
  const gap2 = Math.max(1, width - upper.length * 2 - centre.length - gap1);
  const head = `${upper}${' '.repeat(gap1)}${centre}${' '.repeat(gap2)}${upper}`;

  const body = [];
  const source = typeof cmd.man === 'string' && cmd.man.trim() !== '' ? cmd.man : '';

  if (source && /^[A-Z][A-Z0-9 ]*$/m.test(source)) {
    for (const line of source.split('\n')) {
      if (/^[A-Z][A-Z0-9 ]*$/.test(line)) body.push(`${BOLD}${line}${RESET}`);
      else body.push(line);
    }
  } else {
    body.push(`${BOLD}NAME${RESET}`);
    body.push(`       ${cmd.name} - ${cmd.description || ''}`);
    body.push('');
    body.push(`${BOLD}SYNOPSIS${RESET}`);
    body.push(`       ${cmd.synopsis || cmd.name}`);
    body.push('');
    body.push(`${BOLD}DESCRIPTION${RESET}`);
    const text = source || cmd.description || `${cmd.name} is part of the Ubuntu AI Desktop terminal.`;
    for (const line of wrap(text, width - 14)) body.push(`       ${line}`);
    if (Array.isArray(cmd.aliases) && cmd.aliases.length > 0) {
      body.push('');
      body.push(`${BOLD}ALIASES${RESET}`);
      body.push(`       ${cmd.aliases.join(', ')}`);
    }
  }

  const footVersion = 'GNU coreutils 9.4';
  const footDate = 'September 2024';
  const fgap1 = Math.max(1, Math.floor((width - footVersion.length - footDate.length - upper.length) / 2));
  const fgap2 = Math.max(1, width - footVersion.length - footDate.length - upper.length - fgap1);
  const foot = `${footVersion}${' '.repeat(fgap1)}${footDate}${' '.repeat(fgap2)}${upper}`;

  return `${head}\n\n${body.join('\n')}\n\n${foot}\n`;
}

/* ------------------------------------------------------------------ *
 * sudo / su
 * ------------------------------------------------------------------ */

const SUDO_LECTURE = `We trust you have received the usual lecture from the local System
Administrator. It usually boils down to these three things:

    #1) Respect the privacy of others.
    #2) Think before you type.
    #3) With great power comes great responsibility.
`;

/** POSIX single-quote a token so `execute` re-tokenises it identically. */
function shellQuote(token) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${String(token).split("'").join("'\\''")}'`;
}

/**
 * Run a command line as root, restoring the previous privilege level after.
 * @param {string[]} argv
 * @param {object} ctx
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 */
async function runAsRoot(argv, ctx) {
  privilege.enter();
  try {
    const line = argv.map(shellQuote).join(' ');
    const result = await execute(line, ctx);
    return {
      stdout: (result && result.stdout) || '',
      stderr: (result && result.stderr) || '',
      code: result && typeof result.code === 'number' ? result.code : 0,
    };
  } finally {
    privilege.exit();
  }
}

/**
 * Prompt for the sudo password, honouring the 15 minute timestamp cache.
 * @param {object} ctx
 * @param {string} promptUser
 * @returns {Promise<boolean>}
 */
async function authenticate(ctx, promptUser) {
  if (users.sudoUnlocked) return true;
  if (!store.get('sudoLectured', false)) {
    ctx.term.write(`${SUDO_LECTURE}\n`);
    store.set('sudoLectured', true);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await ctx.term.ask(`[sudo] password for ${promptUser}: `, { password: true });
    if (answer === null || answer === undefined) {
      ctx.term.writeLine('sudo: 1 incorrect password attempt');
      return false;
    }
    if (users.unlockSudo(answer)) return true;
    ctx.term.writeLine('Sorry, try again.');
  }
  ctx.term.writeLine('sudo: 3 incorrect password attempts');
  return false;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * Parse `/proc/meminfo` into a `field -> kilobytes` map, exactly as procps
 * does. Falls back to the process table when the file cannot be read, so
 * `free` still prints something coherent if `/proc` has been unmounted from
 * under it.
 *
 * @param {object} ctx command context
 * @returns {Map<string, number>}
 */
function readMeminfo(ctx) {
  const out = new Map();
  let text = '';
  try {
    text = ctx.fs.readFile('/proc/meminfo');
  } catch {
    text = '';
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_0-9()]+):\s+(\d+)/.exec(line);
    if (match) out.set(match[1], Number(match[2]));
  }
  if (out.has('MemTotal')) return out;

  const totals = procs.totals();
  out.set('MemTotal', totals.memTotalMb * 1024);
  out.set('MemFree', Math.max(0, (totals.memTotalMb - totals.memUsedMb) * 1024));
  out.set('MemAvailable', out.get('MemFree'));
  out.set('Buffers', 0);
  out.set('Cached', 0);
  out.set('SReclaimable', 0);
  out.set('Shmem', 0);
  out.set('SwapTotal', totals.swapTotalMb * 1024);
  out.set('SwapFree', Math.max(0, (totals.swapTotalMb - totals.swapUsedMb) * 1024));
  return out;
}

/**
 * The host's own locale as a glibc locale name, e.g. `ko-KR` -> `ko_KR.utf8`.
 * Used so `locale -a` lists the locale the machine is really set to alongside
 * the ones every Ubuntu install ships.
 * @returns {string}
 */
function hostLocaleName() {
  const tag = device.info().locale.language || '';
  const match = /^([A-Za-z]{2,3})(?:-([A-Za-z]{2}|\d{3}))?/.exec(tag);
  if (!match) return '';
  const language = match[1].toLowerCase();
  return match[2] ? `${language}_${match[2].toUpperCase()}.utf8` : `${language}.utf8`;
}

/** @type {object[]} */
const coreSystemCommands = [
  {
    name: 'uname',
    aliases: [],
    synopsis: 'uname [OPTION]...',
    description: 'Print system information',
    man: `NAME
       uname - print system information

SYNOPSIS
       uname [OPTION]...

DESCRIPTION
       Print certain system information. With no OPTION, same as -s.

OPTIONS
       -a, --all
              print all information, in the following order, except omit -p and
              -i if unknown

       -s, --kernel-name
              print the kernel name

       -n, --nodename
              print the network node hostname

       -r, --kernel-release
              print the kernel release

       -v, --kernel-version
              print the kernel version

       -m, --machine
              print the machine hardware name

       -p, --processor
              print the processor type

       -i, --hardware-platform
              print the hardware platform

       -o, --operating-system
              print the operating system`,
    async run(ctx) {
      const argv = ctx.argv;
      const want = { s: false, n: false, r: false, v: false, m: false, p: false, i: false, o: false };
      let any = false;
      let all = false;

      for (const arg of argv) {
        if (arg === '--all') { all = true; any = true; continue; }
        if (arg.startsWith('--')) {
          const map = {
            '--kernel-name': 's', '--nodename': 'n', '--kernel-release': 'r',
            '--kernel-version': 'v', '--machine': 'm', '--processor': 'p',
            '--hardware-platform': 'i', '--operating-system': 'o',
          };
          if (map[arg]) { want[map[arg]] = true; any = true; continue; }
          if (arg === '--help') return ok(`Usage: uname [OPTION]...\nPrint certain system information.  With no OPTION, same as -s.\n`);
          if (arg === '--version') return ok('uname (GNU coreutils) 9.4\n');
          return fail(`uname: unrecognized option '${arg}'\nTry 'uname --help' for more information.\n`, 1);
        }
        if (arg.startsWith('-') && arg.length > 1) {
          for (const ch of arg.slice(1)) {
            if (ch === 'a') { all = true; any = true; continue; }
            if (Object.prototype.hasOwnProperty.call(want, ch)) { want[ch] = true; any = true; continue; }
            return fail(`uname: invalid option -- '${ch}'\nTry 'uname --help' for more information.\n`, 1);
          }
        }
      }

      if (all) for (const key of Object.keys(want)) want[key] = true;
      if (!any) want.s = true;

      const parts = [];
      if (want.s) parts.push(KERNEL.sysname);
      if (want.n) parts.push(env.host);
      if (want.r) parts.push(KERNEL.release);
      if (want.v) parts.push(KERNEL.version);
      if (want.m) parts.push(KERNEL.machine);
      if (want.p) parts.push(KERNEL.processor);
      if (want.i) parts.push(KERNEL.platform);
      if (want.o) parts.push(KERNEL.os);
      return ok(`${parts.join(' ')}\n`);
    },
  },

  {
    name: 'arch',
    aliases: [],
    synopsis: 'arch',
    description: 'Print machine hardware name',
    man: `NAME
       arch - print machine hardware name (same as uname -m)

SYNOPSIS
       arch [OPTION]...

DESCRIPTION
       Print machine architecture.`,
    async run() {
      return ok(`${KERNEL.machine}\n`);
    },
  },

  {
    name: 'nproc',
    aliases: [],
    synopsis: 'nproc [--all] [--ignore=N]',
    description: 'Print the number of processing units available',
    man: `NAME
       nproc - print the number of processing units available

SYNOPSIS
       nproc [OPTION]...

DESCRIPTION
       Print the number of processing units available to the current process,
       which may be less than the number of online processors.

OPTIONS
       --all         print the number of installed processors
       --ignore=N    if possible, exclude N processing units`,
    async run(ctx) {
      const ignoreArg = ctx.argv.find((a) => a.startsWith('--ignore='));
      const ignore = ignoreArg ? Number(ignoreArg.slice(9)) || 0 : 0;
      return ok(`${Math.max(1, procs.cores - ignore)}\n`);
    },
  },

  {
    name: 'whoami',
    aliases: [],
    synopsis: 'whoami',
    description: 'Print effective user name',
    man: `NAME
       whoami - print effective user name

SYNOPSIS
       whoami [OPTION]...

DESCRIPTION
       Print the user name associated with the current effective user ID. Same
       as id -un.`,
    async run() {
      return ok(`${currentUser()}\n`);
    },
  },

  {
    name: 'id',
    aliases: [],
    synopsis: 'id [OPTION]... [USER]',
    description: 'Print real and effective user and group IDs',
    man: `NAME
       id - print real and effective user and group IDs

SYNOPSIS
       id [OPTION]... [USER]

DESCRIPTION
       Print user and group information for the specified USER, or (when USER
       is omitted) for the current user.

OPTIONS
       -g, --group    print only the effective group ID
       -G, --groups   print all group IDs
       -n, --name     print a name instead of a number
       -u, --user     print only the effective user ID
       -r, --real     print the real ID instead of the effective ID`,
    async run(ctx) {
      const argv = ctx.argv;
      const flags = argv.filter((a) => a.startsWith('-')).join('');
      const target = argv.find((a) => !a.startsWith('-')) || currentUser();
      const account = users.lookup(target);
      if (!account) return fail(`id: '${target}': no such user\n`, 1);

      const groups = users.groupsOf(account.name);
      const wantName = /n/.test(flags) || argv.includes('--name');
      if (/u/.test(flags) || argv.includes('--user')) {
        return ok(`${wantName ? account.name : account.uid}\n`);
      }
      if (/G/.test(flags) || argv.includes('--groups')) {
        return ok(`${groups.map((g) => (wantName ? g.name : g.gid)).join(' ')}\n`);
      }
      if (/g/.test(flags) || argv.includes('--group')) {
        const primary = groups[0] || { name: account.name, gid: account.gid };
        return ok(`${wantName ? primary.name : primary.gid}\n`);
      }
      const groupList = groups.map((g) => `${g.gid}(${g.name})`).join(',');
      const primaryName = groups.length ? groups[0].name : account.name;
      return ok(`uid=${account.uid}(${account.name}) gid=${account.gid}(${primaryName}) groups=${groupList}\n`);
    },
  },

  {
    name: 'groups',
    aliases: [],
    synopsis: 'groups [USER]...',
    description: 'Print the groups a user is in',
    man: `NAME
       groups - print the groups a user is in

SYNOPSIS
       groups [OPTION]... [USERNAME]...

DESCRIPTION
       Print group memberships for each USERNAME or, if no USERNAME is
       specified, for the current process (which may differ if the groups
       database has changed).`,
    async run(ctx) {
      const targets = ctx.argv.filter((a) => !a.startsWith('-'));
      if (targets.length === 0) {
        return ok(`${users.groupsOf(currentUser()).map((g) => g.name).join(' ')}\n`);
      }
      const out = [];
      const errors = [];
      for (const name of targets) {
        if (!users.lookup(name)) {
          errors.push(`groups: '${name}': no such user`);
          continue;
        }
        const list = users.groupsOf(name).map((g) => g.name).join(' ');
        out.push(targets.length > 1 ? `${name} : ${list}` : list);
      }
      if (errors.length) return { stdout: out.join('\n'), stderr: `${errors.join('\n')}\n`, code: 1 };
      return ok(`${out.join('\n')}\n`);
    },
  },

  {
    name: 'hostname',
    aliases: [],
    synopsis: 'hostname [-a|-d|-f|-i|-I|-s] [NAME]',
    description: 'Show or set the system host name',
    man: `NAME
       hostname - show or set the system's host name

SYNOPSIS
       hostname [-a|--alias] [-d|--domain] [-f|--fqdn|--long] [-i|--ip-address]
                [-I|--all-ip-addresses] [-s|--short] [NAME]

DESCRIPTION
       hostname is used to display the system's DNS name, and to display or set
       its hostname or NIS domain name.

OPTIONS
       -f, --fqdn, --long    Display the FQDN.
       -s, --short           Display the short host name.
       -d, --domain          Display the name of the DNS domain.
       -i, --ip-address      Display the network address(es) of the host name.
       -I, --all-ip-addresses
                             Display all network addresses of the host.`,
    async run(ctx) {
      const argv = ctx.argv;
      const host = env.host;
      if (argv.includes('-I') || argv.includes('--all-ip-addresses')) return ok('192.168.1.42 172.17.0.1 \n');
      if (argv.includes('-i') || argv.includes('--ip-address')) return ok('192.168.1.42\n');
      if (argv.includes('-f') || argv.includes('--fqdn') || argv.includes('--long')) return ok(`${host}\n`);
      if (argv.includes('-s') || argv.includes('--short')) return ok(`${host.split('.')[0]}\n`);
      if (argv.includes('-d') || argv.includes('--domain')) return ok('\n');
      if (argv.includes('-a') || argv.includes('--alias')) return ok('\n');

      const name = argv.find((a) => !a.startsWith('-'));
      if (name) {
        if (!isRoot(ctx)) return fail('hostname: you must be root to change the host name\n', 1);
        env.set('HOSTNAME', name);
        users.hostname = name;
        return ok('');
      }
      return ok(`${host}\n`);
    },
  },

  {
    name: 'uptime',
    aliases: [],
    synopsis: 'uptime [-p] [-s]',
    description: 'Tell how long the system has been running',
    man: `NAME
       uptime - tell how long the system has been running

SYNOPSIS
       uptime [options]

DESCRIPTION
       uptime gives a one line display of the following information: the
       current time, how long the system has been running, how many users are
       currently logged on, and the system load averages for the past 1, 5 and
       15 minutes.

OPTIONS
       -p, --pretty   show uptime in pretty format
       -s, --since    system up since, in yyyy-mm-dd HH:MM:SS format`,
    async run(ctx) {
      const total = Math.floor(procs.uptime());
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const mins = Math.floor((total % 3600) / 60);

      if (ctx.argv.includes('-s') || ctx.argv.includes('--since')) {
        return ok(`${strftime('%Y-%m-%d %H:%M:%S', new Date(procs.bootTime))}\n`);
      }
      if (ctx.argv.includes('-p') || ctx.argv.includes('--pretty')) {
        const parts = [];
        if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
        if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
        parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
        return ok(`up ${parts.join(', ')}\n`);
      }

      const upText = days > 0
        ? `${days} day${days === 1 ? '' : 's'}, ${String(hours).padStart(2)}:${pad0(mins)}`
        : hours > 0 ? `${String(hours).padStart(2)}:${pad0(mins)}` : `${mins} min`;
      const load = procs.totals().load.map((l) => l.toFixed(2)).join(', ');
      const now = new Date();
      return ok(` ${pad0(now.getHours())}:${pad0(now.getMinutes())}:${pad0(now.getSeconds())} up ${upText},  1 user,  load average: ${load}\n`);
    },
  },

  {
    name: 'date',
    aliases: [],
    synopsis: 'date [OPTION]... [+FORMAT]',
    description: 'Print or set the system date and time',
    man: `NAME
       date - print or set the system date and time

SYNOPSIS
       date [OPTION]... [+FORMAT]
       date [-u|--utc|--universal] [MMDDhhmm[[CC]YY][.ss]]

DESCRIPTION
       Display date and time in the given FORMAT.

OPTIONS
       -d, --date=STRING
              display time described by STRING, not 'now'

       -u, --utc, --universal
              print or set Coordinated Universal Time (UTC)

       -R, --rfc-email
              output date and time in RFC 5322 format

       -I[FMT], --iso-8601[=FMT]
              output date/time in ISO 8601 format; FMT may be date, hours,
              minutes, seconds or ns

       -s, --set=STRING
              set time described by STRING

FORMAT
       %%  a literal %          %a  locale's abbreviated weekday name
       %A  full weekday name    %b  abbreviated month name
       %B  full month name      %c  locale's date and time
       %d  day of month (01)    %D  date; same as %m/%d/%y
       %e  day of month, space  %F  full date; same as %Y-%m-%d
       %H  hour (00..23)        %I  hour (01..12)
       %j  day of year          %m  month (01..12)
       %M  minute (00..59)      %N  nanoseconds
       %p  AM or PM             %r  12-hour clock time
       %R  24-hour hour:minute  %s  seconds since the Epoch
       %S  second (00..60)      %T  time; same as %H:%M:%S
       %u  day of week (1..7)   %V  ISO week number
       %y  last two digits      %Y  year
       %z  +hhmm numeric zone   %Z  alphabetic time zone abbreviation`,
    async run(ctx) {
      const argv = ctx.argv;
      let when = new Date();
      let utc = false;
      let format = '';

      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-u' || a === '--utc' || a === '--universal') utc = true;
        else if (a === '-d' || a === '--date') {
          const parsed = parseDateSpec(argv[i + 1] || '');
          if (!parsed) return fail(`date: invalid date '${argv[i + 1] || ''}'\n`, 1);
          when = parsed;
          i += 1;
        } else if (a.startsWith('--date=')) {
          const parsed = parseDateSpec(a.slice(7));
          if (!parsed) return fail(`date: invalid date '${a.slice(7)}'\n`, 1);
          when = parsed;
        } else if (a === '-R' || a === '--rfc-email') {
          format = '+%a, %d %b %Y %H:%M:%S %z';
        } else if (a === '-I' || a === '--iso-8601') {
          format = '+%Y-%m-%d';
        } else if (a.startsWith('-I') || a.startsWith('--iso-8601=')) {
          const kind = a.startsWith('-I') ? a.slice(2) : a.slice(11);
          if (kind === 'hours') format = '+%Y-%m-%dT%H%:z';
          else if (kind === 'minutes') format = '+%Y-%m-%dT%H:%M%:z';
          else if (kind === 'seconds') format = '+%Y-%m-%dT%H:%M:%S%:z';
          else if (kind === 'ns') format = '+%Y-%m-%dT%H:%M:%S,%N%:z';
          else format = '+%Y-%m-%d';
        } else if (a === '-s' || a === '--set' || a.startsWith('--set=')) {
          return fail('date: cannot set date: Operation not permitted\n', 1);
        } else if (a.startsWith('+')) {
          format = a;
        }
      }

      if (format === '') format = '+%a %b %e %I:%M:%S %p %Z %Y';
      return ok(`${strftime(format.slice(1), when, utc)}\n`);
    },
  },

  {
    name: 'cal',
    aliases: ['ncal'],
    synopsis: 'cal [-3] [-y] [-m] [[MONTH] YEAR]',
    description: 'Display a calendar',
    man: `NAME
       cal - display a calendar

SYNOPSIS
       cal [options] [[[day] month] year]

DESCRIPTION
       cal displays a simple calendar. If no arguments are specified, the
       current month is displayed. Today is shown in reverse video.

OPTIONS
       -1, --one      Display single month output (the default).
       -3, --three    Display the previous, current and next month.
       -y, --year     Display a calendar for the whole current year.
       -m, --monday   Display Monday as the first day of the week.
       -s, --sunday   Display Sunday as the first day of the week.`,
    async run(ctx) {
      const argv = ctx.argv;
      const today = new Date();
      const mondayFirst = argv.includes('-m') || argv.includes('--monday');
      const numbers = argv.filter((a) => /^\d+$/.test(a)).map(Number);

      let year = today.getFullYear();
      let month = today.getMonth();
      let wholeYear = argv.includes('-y') || argv.includes('--year');

      if (numbers.length === 1) {
        year = numbers[0];
        wholeYear = true;
      } else if (numbers.length >= 2) {
        month = numbers[0] - 1;
        year = numbers[1];
        if (month < 0 || month > 11) return fail(`cal: ${numbers[0]} is not a month number (1..12)\n`, 1);
      }

      if (wholeYear) {
        const blocks = [];
        for (let m = 0; m < 12; m += 1) blocks.push(monthBlock(year, m, { showYear: false, today, mondayFirst }));
        const title = String(year);
        const header = `${' '.repeat(Math.max(0, Math.floor((64 - title.length) / 2)))}${title}`;
        return ok(`${header}\n${layoutBlocks(blocks, 3)}\n`);
      }

      if (argv.includes('-3') || argv.includes('--three')) {
        const blocks = [-1, 0, 1].map((delta) => {
          const d = new Date(year, month + delta, 1);
          return monthBlock(d.getFullYear(), d.getMonth(), { today, mondayFirst });
        });
        return ok(`${layoutBlocks(blocks, 3)}\n`);
      }

      return ok(`${monthBlock(year, month, { today, mondayFirst }).join('\n')}\n`);
    },
  },

  {
    name: 'free',
    aliases: [],
    synopsis: 'free [-b|-k|-m|-g|-h] [-t]',
    description: 'Display amount of free and used memory in the system',
    man: `NAME
       free - display amount of free and used memory in the system

SYNOPSIS
       free [options]

DESCRIPTION
       free displays the total amount of free and used physical and swap memory
       in the system, as well as the buffers and caches used by the kernel.

OPTIONS
       -b, --bytes    Display the amount of memory in bytes.
       -k, --kibi     Display the amount of memory in kibibytes (the default).
       -m, --mebi     Display the amount of memory in mebibytes.
       -g, --gibi     Display the amount of memory in gibibytes.
       -h, --human    Show all output fields automatically scaled.
       -t, --total    Display a line showing the column totals.
       -w, --wide     Switch to the wide mode (separate buffers and cache).`,
    async run(ctx) {
      const argv = ctx.argv;
      const MB = 1024 * 1024;

      // Real free(1) is a thin formatter over /proc/meminfo, and so is this
      // one: MemTotal there is the host's real RAM figure from device.js, and
      // reading the same file is what guarantees the two never disagree.
      const mem = readMeminfo(ctx);
      const kb = (name) => (mem.has(name) ? mem.get(name) * 1024 : 0);

      const totalB = kb('MemTotal');
      const freeB = kb('MemFree');
      const buffB = kb('Buffers') + kb('Cached') + kb('SReclaimable');
      const sharedB = kb('Shmem');
      const availB = kb('MemAvailable');
      // procps-ng's definition, to the letter.
      const usedB = Math.max(0, totalB - freeB - buffB);
      const swapTotalB = kb('SwapTotal');
      const swapFreeB = kb('SwapFree');
      const swapUsedB = Math.max(0, swapTotalB - swapFreeB);

      let scale = 1024;
      let human = false;
      if (argv.includes('-h') || argv.includes('--human')) human = true;
      else if (argv.includes('-b') || argv.includes('--bytes')) scale = 1;
      else if (argv.includes('-m') || argv.includes('--mebi')) scale = MB;
      else if (argv.includes('-g') || argv.includes('--gibi')) scale = 1024 * MB;

      const cell = (bytes) => (human ? humanSize(bytes) : String(Math.round(bytes / scale)));
      const row = (label, values) => (
        `${label.padEnd(7)}${values[0].padStart(13)}${values.slice(1).map((v) => v.padStart(12)).join('')}`
      );

      const lines = [
        row('', ['total', 'used', 'free', 'shared', 'buff/cache', 'available']),
        row('Mem:', [cell(totalB), cell(usedB), cell(freeB), cell(sharedB), cell(buffB), cell(availB)]),
        row('Swap:', [cell(swapTotalB), cell(swapUsedB), cell(swapFreeB)]),
      ];
      if (argv.includes('-t') || argv.includes('--total')) {
        lines.push(row('Total:', [
          cell(totalB + swapTotalB),
          cell(usedB + swapUsedB),
          cell(freeB + swapFreeB),
        ]));
      }
      return ok(`${lines.join('\n')}\n`);
    },
  },

  {
    name: 'which',
    aliases: [],
    synopsis: 'which [-a] PROGRAM...',
    description: 'Locate a command',
    man: `NAME
       which - locate a command

SYNOPSIS
       which [-a] filename ...

DESCRIPTION
       which returns the pathnames of the files which would be executed in the
       current environment, had its arguments been given as commands. It does
       so by searching the PATH for executable files matching the names of the
       arguments.

OPTIONS
       -a     print all matching pathnames of each argument`,
    async run(ctx) {
      const argv = ctx.argv;
      const all = argv.includes('-a');
      const names = argv.filter((a) => !a.startsWith('-'));
      if (names.length === 0) return { stdout: '', stderr: '', code: 0 };

      const dirs = String(env.get('PATH') || '').split(':').filter(Boolean);
      const found = [];
      let missing = false;
      for (const name of names) {
        const hits = [];
        for (const dir of dirs) {
          const candidate = `${dir}/${name}`;
          try {
            if (fs.exists(candidate) && fs.isFile(candidate)) hits.push(candidate);
          } catch {
            /* unreadable PATH entry — skip, like the real tool */
          }
          if (hits.length > 0 && !all) break;
        }
        if (hits.length === 0) missing = true;
        found.push(...(all ? hits : hits.slice(0, 1)));
      }
      return { stdout: found.length ? `${found.join('\n')}\n` : '', stderr: '', code: missing ? 1 : 0 };
    },
  },

  {
    name: 'whereis',
    aliases: [],
    synopsis: 'whereis [-b] [-m] [-s] NAME...',
    description: 'Locate the binary, source and manual page files for a command',
    man: `NAME
       whereis - locate the binary, source, and manual page files for a command

SYNOPSIS
       whereis [options] [-BMS directory... -f] name...

DESCRIPTION
       whereis locates the binary, source and manual files for the specified
       command names.

OPTIONS
       -b     Search only for binaries.
       -m     Search only for manuals and infos.
       -s     Search only for sources.`,
    async run(ctx) {
      const argv = ctx.argv;
      const onlyBin = argv.includes('-b');
      const onlyMan = argv.includes('-m');
      const onlySrc = argv.includes('-s');
      const names = argv.filter((a) => !a.startsWith('-'));
      if (names.length === 0) return ok('');

      const binDirs = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/usr/games'];
      const out = [];
      for (const name of names) {
        const parts = [];
        if (!onlyMan && !onlySrc) {
          for (const dir of binDirs) {
            const candidate = `${dir}/${name}`;
            try {
              if (fs.exists(candidate) && fs.isFile(candidate)) parts.push(candidate);
            } catch {
              /* skip */
            }
          }
        }
        if (!onlyBin && !onlySrc && getCommand(name)) {
          parts.push(`/usr/share/man/man1/${name}.1.gz`);
        }
        out.push(`${name}:${parts.length ? ` ${parts.join(' ')}` : ''}`);
      }
      return ok(`${out.join('\n')}\n`);
    },
  },

  {
    name: 'man',
    aliases: [],
    synopsis: 'man [SECTION] PAGE...',
    description: 'An interface to the system reference manuals',
    man: `NAME
       man - an interface to the system reference manuals

SYNOPSIS
       man [man options] [[section] page ...] ...

DESCRIPTION
       man is the system's manual pager. Each page argument given to man is
       normally the name of a program, utility or function. The manual page
       associated with each of these arguments is then found and displayed.

OPTIONS
       -k, --apropos
              Search the short descriptions for the keyword.

       -f, --whatis
              Display a short description of the page.

       -w, --where
              Print the location of the manual file.`,
    async run(ctx) {
      const argv = ctx.argv;
      const positional = argv.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
      const cols = termCols(ctx);

      if (argv.includes('-k') || argv.includes('--apropos')) {
        const needle = (positional[0] || '').toLowerCase();
        const hits = commandNames()
          .map((n) => getCommand(n))
          .filter((c, i, arr) => c && arr.findIndex((o) => o && o.name === c.name) === i)
          .filter((c) => c.name.includes(needle) || String(c.description || '').toLowerCase().includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (hits.length === 0) return fail(`${needle}: nothing appropriate.\n`, 16);
        return ok(`${hits.map((c) => `${c.name} (1)${' '.repeat(Math.max(1, 20 - c.name.length))}- ${c.description || ''}`).join('\n')}\n`);
      }

      if (positional.length === 0) {
        return fail("What manual page do you want?\nFor example, try 'man man'.\n", 1);
      }

      const blocks = [];
      const errors = [];
      for (const name of positional) {
        const cmd = getCommand(name);
        if (!cmd) {
          errors.push(`No manual entry for ${name}`);
          continue;
        }
        if (argv.includes('-w') || argv.includes('--where')) {
          blocks.push(`/usr/share/man/man1/${cmd.name}.1.gz`);
          continue;
        }
        if (argv.includes('-f') || argv.includes('--whatis')) {
          blocks.push(`${cmd.name} (1)${' '.repeat(Math.max(1, 20 - cmd.name.length))}- ${cmd.description || ''}`);
          continue;
        }
        blocks.push(renderMan(cmd, cols));
      }
      if (errors.length && blocks.length === 0) return fail(`${errors.join('\n')}\n`, 16);
      return { stdout: blocks.join('\n'), stderr: errors.length ? `${errors.join('\n')}\n` : '', code: errors.length ? 16 : 0 };
    },
  },

  {
    name: 'sudo',
    aliases: [],
    synopsis: 'sudo [-u USER] [-k] [-v] [-l] COMMAND [ARG]...',
    description: 'Execute a command as another user',
    man: `NAME
       sudo - execute a command as another user

SYNOPSIS
       sudo -h | -K | -k | -V
       sudo -v [-Bknp] [-u user]
       sudo -l [-Bknp] [-U user] [-u user] [command]
       sudo [-BbEHnPS] [-p prompt] [-u user] [VAR=value] [-i|-s] [command]

DESCRIPTION
       sudo allows a permitted user to execute a command as the superuser or
       another user, as specified by the security policy.

       sudo requires that users authenticate themselves with a password by
       default. Once a user has been authenticated, a timestamp is updated and
       the user may then use sudo without a password for a short period of time
       (15 minutes unless overridden in sudoers).

OPTIONS
       -k, --reset-timestamp
              Invalidate the user's cached credentials.

       -v, --validate
              Update the user's cached credentials without running a command.

       -l, --list
              List the allowed commands for the invoking user.

       -u, --user USER
              Run the command as a user other than the default target user.

       -i, --login
              Run the shell specified by the target user's password entry as a
              login shell.

       -s, --shell
              Run the shell specified by the SHELL environment variable.`,
    async run(ctx) {
      const argv = ctx.argv.slice();
      let targetUser = 'root';
      let loginShell = false;
      let i = 0;

      for (; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--') { i += 1; break; }
        if (a === '-k' || a === '--reset-timestamp' || a === '-K') {
          users.lockSudo();
          if (argv.length === 1) return ok('');
          continue;
        }
        if (a === '-v' || a === '--validate') {
          const okAuth = await authenticate(ctx, currentUser());
          return okAuth ? ok('') : { stdout: '', stderr: '', code: 1 };
        }
        if (a === '-V' || a === '--version') {
          return ok('Sudo version 1.9.15p5\nSudoers policy plugin version 1.9.15p5\nSudoers file grammar version 50\nSudoers I/O plugin version 1.9.15p5\n');
        }
        if (a === '-h' || a === '--help') {
          return ok('usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo [-ABbEHnPS] [-g group] [-h host] [-p prompt] [-u user] [VAR=value] [-i|-s] [command [arg ...]]\n');
        }
        if (a === '-l' || a === '--list') {
          const okAuth = await authenticate(ctx, currentUser());
          if (!okAuth) return { stdout: '', stderr: '', code: 1 };
          return ok([
            `Matching Defaults entries for ${currentUser()} on ${env.host}:`,
            '    env_reset, mail_badpass,',
            '    secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin,',
            '    use_pty',
            '',
            `User ${currentUser()} may run the following commands on ${env.host}:`,
            '    (ALL : ALL) ALL',
            '',
          ].join('\n'));
        }
        if (a === '-u' || a === '--user') { targetUser = argv[i + 1] || 'root'; i += 1; continue; }
        if (a.startsWith('--user=')) { targetUser = a.slice(7); continue; }
        if (a === '-i' || a === '--login' || a === '-s' || a === '--shell') { loginShell = true; continue; }
        if (a === '-E' || a === '-H' || a === '-b' || a === '-n' || a === '-S' || a === '-P') continue;
        if (a === '-p' || a === '--prompt') { i += 1; continue; }
        break;
      }

      const rest = argv.slice(i);

      if (rest.length === 0 && !loginShell) {
        return fail([
          'usage: sudo -h | -K | -k | -V',
          'usage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]',
          'usage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command [arg ...]]',
          'usage: sudo [-ABbEHnPS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i|-s] [command [arg ...]]',
          '',
        ].join('\n'), 1);
      }

      if (!users.lookup(targetUser)) {
        return fail(`sudo: unknown user ${targetUser}\nsudo: error initializing audit plugin sudoers_audit\n`, 1);
      }

      const authenticated = await authenticate(ctx, currentUser());
      if (!authenticated) return { stdout: '', stderr: '', code: 1 };

      if (rest.length === 0) {
        privilege.enter();
        env.set('USER', 'root');
        env.set('LOGNAME', 'root');
        env.set('HOME', '/root');
        if (loginShell) env.setCwd('/root');
        return ok('');
      }

      return runAsRoot(rest, ctx);
    },
  },

  {
    name: 'su',
    aliases: [],
    synopsis: 'su [-] [-c COMMAND] [USER]',
    description: 'Run a command with substitute user and group ID',
    man: `NAME
       su - run a command with substitute user and group ID

SYNOPSIS
       su [options] [-] [user [argument...]]

DESCRIPTION
       su allows commands to be run with a substitute user and group ID. When
       called without arguments su defaults to running an interactive shell as
       root. Type exit or logout to return to your own account.

OPTIONS
       -, -l, --login
              Start the shell as a login shell.

       -c, --command COMMAND
              Pass COMMAND to the shell with the -c option.`,
    async run(ctx) {
      const argv = ctx.argv.slice();
      let login = false;
      let command = null;
      const positional = [];
      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-' || a === '-l' || a === '--login') login = true;
        else if (a === '-c' || a === '--command') { command = argv.slice(i + 1); i = argv.length; }
        else if (!a.startsWith('-')) positional.push(a);
      }
      const target = positional[0] || 'root';
      const account = users.lookup(target);
      if (!account) return fail(`su: user ${target} does not exist or the user entry does not contain all the required fields\n`, 1);

      if (!users.sudoUnlocked) {
        const answer = await ctx.term.ask('Password: ', { password: true });
        if (answer === null || answer === undefined || !users.unlockSudo(answer)) {
          ctx.term.writeLine('su: Authentication failure');
          return { stdout: '', stderr: '', code: 1 };
        }
      }

      if (command && command.length > 0) return runAsRoot(command, ctx);

      privilege.enter();
      env.set('USER', account.name);
      env.set('LOGNAME', account.name);
      env.set('HOME', account.home);
      if (login) env.setCwd(account.home);
      return ok('');
    },
  },

  {
    name: 'tty',
    aliases: [],
    synopsis: 'tty [-s]',
    description: 'Print the file name of the terminal connected to standard input',
    man: `NAME
       tty - print the file name of the terminal connected to standard input

SYNOPSIS
       tty [OPTION]...

DESCRIPTION
       Print the file name of the terminal connected to standard input.

OPTIONS
       -s, --silent, --quiet
              print nothing, only return an exit status`,
    async run(ctx) {
      if (ctx.argv.includes('-s') || ctx.argv.includes('--silent') || ctx.argv.includes('--quiet')) {
        return ok('');
      }
      return ok('/dev/pts/0\n');
    },
  },

  {
    name: 'stty',
    aliases: [],
    synopsis: 'stty [-a] [-g] [SETTING]...',
    description: 'Print or change terminal characteristics',
    man: `NAME
       stty - change and print terminal line settings

SYNOPSIS
       stty [-F DEVICE | --file=DEVICE] [SETTING]...
       stty [-F DEVICE | --file=DEVICE] [-a|--all]
       stty [-F DEVICE | --file=DEVICE] [-g|--save]

DESCRIPTION
       Print or change terminal characteristics.

OPTIONS
       -a, --all      print all current settings in human-readable form
       -g, --save     print all current settings in a stty-readable form`,
    async run(ctx) {
      const argv = ctx.argv;
      const cols = termCols(ctx);
      if (argv.includes('-g') || argv.includes('--save')) {
        return ok('4500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0\n');
      }
      if (argv.includes('-a') || argv.includes('--all')) {
        return ok([
          `speed 38400 baud; rows 24; columns ${cols}; line = 0;`,
          'intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>;',
          'eol2 = <undef>; swtch = <undef>; start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R;',
          'werase = ^W; lnext = ^V; discard = ^O; min = 1; time = 0;',
          '-parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts',
          '-ignbrk brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon -ixoff',
          '-iuclc -ixany -imaxbel iutf8',
          'opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt0 ff0',
          'isig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt',
          'echoctl echoke -flusho -extproc',
          '',
        ].join('\n'));
      }
      if (argv.filter((a) => !a.startsWith('-')).length > 0) return ok('');
      return ok('speed 38400 baud; line = 0;\n-brkint -imaxbel iutf8\n');
    },
  },

  {
    name: 'locale',
    aliases: [],
    synopsis: 'locale [-a] [-m] [NAME]...',
    description: 'Get locale-specific information',
    man: `NAME
       locale - get locale-specific information

SYNOPSIS
       locale [-a|-m]
       locale [-ck] name...

DESCRIPTION
       The locale command displays information about the current locale, or all
       locales, to standard output.

OPTIONS
       -a, --all-locales   Write names of all available locales.
       -m, --charmaps      Write names of all available charmaps.`,
    async run(ctx) {
      const argv = ctx.argv;
      if (argv.includes('-a') || argv.includes('--all-locales')) {
        // Every Ubuntu install has these; the host's own locale is added
        // because that one is a real fact about this machine.
        const generated = ['C', 'C.utf8', 'en_US.utf8', 'POSIX'];
        const host = hostLocaleName();
        if (host && !generated.includes(host)) generated.push(host);
        return ok(`${generated.sort().join('\n')}\n`);
      }
      if (argv.includes('-m') || argv.includes('--charmaps')) {
        return ok(['ANSI_X3.110-1983', 'ASCII', 'ISO-8859-1', 'ISO-8859-15', 'UTF-8', ''].join('\n'));
      }
      const lang = env.get('LANG') || 'en_US.UTF-8';
      const categories = ['LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY',
        'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE',
        'LC_MEASUREMENT', 'LC_IDENTIFICATION'];
      const names = argv.filter((a) => !a.startsWith('-'));
      if (names.length > 0) {
        return ok(`${names.map((n) => env.get(n) || (n === 'LANG' ? lang : lang)).join('\n')}\n`);
      }
      const lines = [`LANG=${lang}`, 'LANGUAGE='];
      for (const cat of categories) lines.push(`${cat}="${lang}"`);
      lines.push('LC_ALL=');
      return ok(`${lines.join('\n')}\n`);
    },
  },
];

/** @type {object[]} */
const systemCommands = [
  ...coreSystemCommands,
  ...psTopCommands,
  ...hwCommands,
  ...fetchCommands,
];

export default systemCommands;
