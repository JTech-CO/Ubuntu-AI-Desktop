/**
 * js/apps/terminal/commands/extras-users.js — the login and account commands:
 * w, users, last, lastlog, passwd, adduser, useradd and crontab.
 *
 * The account database in js/core/users.js is a fixed table, exactly like the
 * one a fresh Ubuntu install ships with, and it has no mutation API. So the
 * commands that would change it do not pretend to:
 *
 *   - adduser and useradd print the genuine refusal when you are not root,
 *     which is the case almost everyone hits, and explain plainly under sudo
 *     that the account table is compiled in rather than writable.
 *   - passwd runs the real three-prompt flow and verifies the current
 *     password, then says that no hash is stored anywhere in this desktop.
 *
 * crontab is the opposite case: the file really is written to
 * /var/spool/cron/crontabs, so `crontab -l` reads back what you installed.
 * Nothing executes it, and the man page leads with that.
 */

import { procs } from '../../../core/procs.js';
import { users } from '../../../core/users.js';
import { env } from '../../../core/env.js';
import { fs } from '../../../core/fs.js';
import { wm } from '../../../shell/window-manager.js';
import {
  ok, fail, pad0, isRoot, currentUser,
  DAYS_SHORT, MONTHS_SHORT, numericOffset,
} from './util.js';
import { KERNEL } from './extras-x11.js';

/* ------------------------------------------------------------------ *
 * shared session facts
 * ------------------------------------------------------------------ */

/** The graphical session started when the machine booted. */
function loginTime() {
  return new Date(procs.bootTime + 60_000);
}

/** `HH:MM` */
function hhmm(d) {
  return `${pad0(d.getHours())}:${pad0(d.getMinutes())}`;
}

/** `HH:MM:SS` */
function hhmmss(d) {
  return `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}`;
}

/** `Sun Aug 18 06:33` — the wtmp timestamp `last` prints. */
function wtmpStamp(d) {
  return `${DAYS_SHORT[d.getDay()]} ${MONTHS_SHORT[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${hhmm(d)}`;
}

/** `2:41` — uptime's hours:minutes, or `3 days, 2:41`. */
function uptimePhrase() {
  const s = Math.floor(procs.uptime());
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const clock = `${h}:${pad0(m)}`;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}, ${clock}`;
  if (h > 0) return ` ${clock}`;
  return ` ${m} min`;
}

/**
 * The logged-in sessions: the GNOME session on :0 plus one pty per open
 * terminal window, which is what a real box would show.
 * @returns {{user:string, tty:string, from:string, login:Date, idle:string,
 *            jcpu:string, pcpu:string, what:string}[]}
 */
function sessions() {
  const user = users.current.name;
  const boot = loginTime();
  const rows = [{
    user,
    tty: ':0',
    from: ':0',
    login: boot,
    idle: '?xdm?',
    jcpu: '1:23',
    pcpu: '0.02s',
    what: '/usr/libexec/gdm-x-session --run-script env GNOME_SHELL_SESSION_MODE=ubuntu /usr/bin/gnome-session --session=ubuntu',
  }];

  let terminals = 0;
  try {
    terminals = wm.instances().filter((i) => i.appId === 'terminal').length;
  } catch {
    terminals = 1;
  }
  for (let i = 0; i < Math.max(1, terminals); i += 1) {
    rows.push({
      user,
      tty: `pts/${i}`,
      from: '-',
      login: new Date(Date.now() - (i + 1) * 61_000),
      idle: '0.00s',
      jcpu: '0.05s',
      pcpu: '0.01s',
      what: i === 0 ? 'w' : 'bash',
    });
  }
  return rows;
}

/* ================================================================== *
 * w
 * ================================================================== */

const wCommand = {
  name: 'w',
  aliases: [],
  synopsis: 'w [-h] [-s] [-u] [USER]',
  description: 'Show who is logged on and what they are doing',
  man: `NAME
       w - Show who is logged on and what they are doing

SYNOPSIS
       w [options] [user]

DESCRIPTION
       Prints a summary line — current time, uptime, session count and load
       average — followed by one row per logged-in session.

       The graphical session on :0 is the desktop you are looking at, and it
       has been up since the emulator booted. Each open Terminal window adds a
       pty row, so closing a window really does remove a line. The load
       average is the one the process table is maintaining, the same figure
       uptime and top print.

OPTIONS
       -h, --no-header   Do not print the header.
       -s, --short       Omit the login time, JCPU and PCPU columns.
       -u, --no-current  Ignore the username while figuring out the current
                         process and cpu times (accepted, no visible change).

EXIT STATUS
       0  always`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--version') || argv.includes('-V')) return ok('w from procps-ng 4.0.4\n');
    const noHeader = argv.includes('-h') || argv.includes('--no-header');
    const short = argv.includes('-s') || argv.includes('--short');
    const only = argv.find((a) => !a.startsWith('-'));

    const load = procs.load();
    const rows = sessions().filter((r) => !only || r.user === only);
    const out = [];

    if (!noHeader) {
      out.push(
        ` ${hhmmss(new Date())} up ${uptimePhrase()},  ${rows.length} user${rows.length === 1 ? '' : 's'},  ` +
        `load average: ${load.map((n) => n.toFixed(2)).join(', ')}`,
      );
      out.push(short
        ? 'USER     TTY      FROM              IDLE WHAT'
        : 'USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT');
    }

    for (const r of rows) {
      out.push(short
        ? r.user.padEnd(9) + r.tty.padEnd(9) + r.from.padEnd(17) + r.idle.padStart(5) + ' ' + r.what
        : r.user.padEnd(9) + r.tty.padEnd(9) + r.from.padEnd(17) + hhmm(r.login).padEnd(9) +
          r.idle.padStart(6) + ' ' + r.jcpu.padStart(6) + ' ' + r.pcpu.padStart(5) + ' ' + r.what);
    }
    return ok(`${out.join('\n')}\n`);
  },
};

/* ================================================================== *
 * users
 * ================================================================== */

const usersCommand = {
  name: 'users',
  aliases: [],
  synopsis: 'users [FILE]',
  description: 'Print the login names of the users currently logged in',
  man: `NAME
       users - print the user names of users currently logged in to the
       current host

SYNOPSIS
       users [OPTION]... [FILE]

DESCRIPTION
       Prints one name per login session, space separated, on a single line.
       A user with three sessions open appears three times — that is the real
       behaviour, not a bug.

       The sessions are the same ones w and who report: the graphical login
       plus one per open Terminal window.

OPTIONS
       --help      Print usage.
       --version   Print version.

EXIT STATUS
       0  always`,

  async run(ctx) {
    if (ctx.argv.includes('--version')) return ok('users (GNU coreutils) 9.4\n');
    if (ctx.argv.includes('--help')) {
      return ok('Usage: users [OPTION]... [FILE]\nOutput who is currently logged in according to FILE.\n');
    }
    const names = sessions().map((s) => s.user).sort();
    return ok(`${names.join(' ')}\n`);
  },
};

/* ================================================================== *
 * last
 * ================================================================== */

/**
 * A wtmp history: this boot, then a week of earlier sessions, each derived
 * from the boot time so the list is stable between calls.
 * @returns {{name:string, tty:string, host:string, start:Date, end:Date|null,
 *            running:boolean}[]}
 */
function wtmpRecords() {
  const user = users.current.name;
  const boot = new Date(procs.bootTime);
  const rows = [
    { name: user, tty: ':0', host: ':0', start: loginTime(), end: null, running: true },
    { name: 'reboot', tty: 'system boot', host: KERNEL, start: boot, end: null, running: true },
  ];
  for (let day = 1; day <= 6; day += 1) {
    const prevBoot = new Date(procs.bootTime - day * 86400000 - 3600000 * 2);
    const login = new Date(prevBoot.getTime() + 90_000);
    const logout = new Date(login.getTime() + (3 * 3600000) + day * 900000);
    rows.push({ name: user, tty: ':0', host: ':0', start: login, end: logout, running: false });
    rows.push({ name: 'reboot', tty: 'system boot', host: KERNEL, start: prevBoot, end: logout, running: false });
  }
  return rows;
}

/** `(03:36)` — the session duration `last` prints. */
function duration(from, to) {
  const s = Math.max(0, Math.floor((to - from) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `(${pad0(h)}:${pad0(m)})`;
}

const lastCommand = {
  name: 'last',
  aliases: [],
  synopsis: 'last [-n NUM] [-x] [USER]',
  description: 'Show a listing of last logged in users',
  man: `NAME
       last - show a listing of last logged in users

SYNOPSIS
       last [options] [username...]

DESCRIPTION
       Prints the login history, most recent first, followed by the date the
       wtmp file begins.

       The current boot and the current graphical session are real: they are
       the emulator's own boot time and login. The earlier week of records is
       derived from that boot time so the list is stable and internally
       consistent rather than random — there is no persistent wtmp across
       page reloads to read from.

OPTIONS
       -n NUM, -NUM   Show at most NUM records.
       -x             Show shutdown and runlevel entries (accepted; this
                      desktop records neither).
       -R             Suppress the hostname column.
       USER           Only show records for this user.

EXIT STATUS
       0  always`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--version') || argv.includes('-V')) return ok('last from util-linux 2.39.3\n');
    const noHost = argv.includes('-R');

    let limit = 0;
    const names = [];
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-n') { limit = Number(argv[++i]) || 0; continue; }
      if (/^-\d+$/.test(a)) { limit = Number(a.slice(1)); continue; }
      if (a.startsWith('-')) continue;
      names.push(a);
    }

    let records = wtmpRecords();
    if (names.length) records = records.filter((r) => names.includes(r.name));
    if (limit > 0) records = records.slice(0, limit);

    const lines = records.map((r) => {
      const tail = r.running
        ? (r.name === 'reboot' ? '  still running' : '   still logged in')
        : ` - ${hhmm(r.end)}  ${duration(r.start, r.end)}`;
      return r.name.padEnd(9) + r.tty.padEnd(13) + (noHost ? '' : r.host.padEnd(17)) + wtmpStamp(r.start) + tail;
    });

    const begins = wtmpRecords().reduce((min, r) => (r.start < min ? r.start : min), new Date());
    lines.push('');
    lines.push(`wtmp begins ${DAYS_SHORT[begins.getDay()]} ${MONTHS_SHORT[begins.getMonth()]} ${String(begins.getDate()).padStart(2)} ${hhmmss(begins)} ${begins.getFullYear()}`);
    return ok(`${lines.join('\n')}\n`);
  },
};

/* ================================================================== *
 * lastlog
 * ================================================================== */

const lastlogCommand = {
  name: 'lastlog',
  aliases: [],
  synopsis: 'lastlog [-u USER]',
  description: 'Report the most recent login of all users',
  man: `NAME
       lastlog - reports the most recent login of all users or of a given user

SYNOPSIS
       lastlog [options]

DESCRIPTION
       Prints one row per account in /etc/passwd. Service accounts have never
       logged in, and say so — which is the normal state on a real system too,
       since nothing logs in as www-data or systemd-resolve.

       The one human account, ubuntu, shows this session's graphical login.

OPTIONS
       -u, --user LOGIN   Only this account.
       -b, --before DAYS  Only logins older than DAYS.
       -t, --time DAYS    Only logins newer than DAYS.

EXIT STATUS
       0  always`,

  async run(ctx) {
    const argv = ctx.argv;
    let only = null;
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '-u' || argv[i] === '--user') only = argv[i + 1];
      else if (argv[i].startsWith('--user=')) only = argv[i].slice(7);
    }

    const login = loginTime();
    const stamp =
      `${DAYS_SHORT[login.getDay()]} ${MONTHS_SHORT[login.getMonth()]} ${String(login.getDate()).padStart(2)} ` +
      `${hhmmss(login)} ${numericOffset(login)} ${login.getFullYear()}`;

    const lines = ['Username         Port     From             Latest'];
    for (const account of users.list()) {
      if (only && account.name !== only) continue;
      const isHuman = account.name === users.current.name;
      lines.push(
        account.name.padEnd(17) +
        (isHuman ? ':0'.padEnd(9) : ' '.repeat(9)) +
        (isHuman ? ':0'.padEnd(17) : ' '.repeat(17)) +
        (isHuman ? stamp : '**Never logged in**'),
      );
    }
    if (only && lines.length === 1) {
      return fail(`lastlog: Unknown user or range: ${only}\n`, 1);
    }
    return ok(`${lines.join('\n')}\n`);
  },
};

/* ================================================================== *
 * passwd
 * ================================================================== */

const passwdCommand = {
  name: 'passwd',
  aliases: [],
  synopsis: 'passwd [-S] [USER]',
  description: 'Change a user password',
  man: `NAME
       passwd - change user password

SYNOPSIS
       passwd [options] [LOGIN]

DESCRIPTION
       Runs the real three-prompt flow: current password, new password,
       retype. The current password is checked against the same credential
       sudo and the lock screen use, so a wrong answer is rejected exactly as
       it would be on a real machine.

       It then stops and tells you why nothing changed. This desktop stores no
       password hashes at all — the one accepted password is a constant in
       js/core/users.js, /etc/shadow is generated on demand with placeholder
       fields, and there is nowhere to write a new hash to. Printing "password
       updated successfully" would be a lie about the state of the system.

       -S still works, because the status line is information the emulator
       genuinely has.

OPTIONS
       -S, --status    Show the account status line.
       -h, --help      Print usage.

EXIT STATUS
       0  the status was printed
       1  authentication failed, or the password could not be changed`,

  async run(ctx) {
    const argv = ctx.argv;
    const target = argv.find((a) => !a.startsWith('-')) || currentUser();
    const account = users.lookup(target);

    if (!account) return fail(`passwd: user '${target}' does not exist\n`, 1);

    if (argv.includes('-S') || argv.includes('--status')) {
      const d = new Date();
      const date = `${pad0(d.getMonth() + 1)}/${pad0(d.getDate())}/${d.getFullYear()}`;
      const status = account.uid === 0 ? 'L' : account.uid >= 1000 && account.uid < 65534 ? 'P' : 'L';
      return ok(`${account.name} ${status} ${date} 0 99999 7 -1\n`);
    }

    if (target !== currentUser() && !isRoot(ctx)) {
      return fail(`passwd: You may not view or modify password information for ${target}.\n`, 1);
    }

    ctx.term.writeLine(`Changing password for ${target}.`);

    if (!isRoot(ctx)) {
      const current = await ctx.term.ask('Current password: ', { password: true });
      if (current === null || current === undefined || !users.unlockSudo(current)) {
        ctx.term.writeLine('passwd: Authentication token manipulation error');
        return { stdout: '', stderr: 'passwd: password unchanged\n', code: 1 };
      }
    }

    const first = await ctx.term.ask('New password: ', { password: true });
    if (first === null || first === undefined) {
      return { stdout: '', stderr: 'passwd: password unchanged\n', code: 1 };
    }
    if (String(first).length < 8) {
      ctx.term.writeLine('BAD PASSWORD: The password is shorter than 8 characters');
    }
    const second = await ctx.term.ask('Retype new password: ', { password: true });
    if (second !== first) {
      ctx.term.writeLine('Sorry, passwords do not match.');
      return { stdout: '', stderr: 'passwd: Authentication token manipulation error\npasswd: password unchanged\n', code: 1 };
    }

    return fail(
      'passwd: this desktop stores no password hashes. The one accepted password is a\n' +
      'passwd: constant in js/core/users.js and /etc/shadow is generated on demand, so\n' +
      'passwd: there is nowhere to write a new one. Nothing was changed.\n',
      1,
    );
  },
};

/* ================================================================== *
 * adduser / useradd
 * ================================================================== */

/**
 * Build the two account-creation commands. They differ only in wording, and
 * both refuse — the non-root message is the genuine one, and the root message
 * explains the real reason rather than inventing an account.
 *
 * @param {string} name 'adduser' or 'useradd'
 * @returns {object}
 */
function accountCommand(name) {
  const friendly = name === 'adduser';
  return {
    name,
    aliases: [],
    synopsis: `${name} [OPTIONS] LOGIN`,
    description: friendly ? 'Add a user to the system' : 'Create a new user',
    man: `NAME
       ${name} - ${friendly ? 'add a user to the system' : 'create a new user or update default new user information'}

SYNOPSIS
       ${name} [options] LOGIN

DESCRIPTION
       ${friendly
        ? 'adduser is the friendly front end to useradd: it creates the home\n       directory, copies /etc/skel and prompts for the account details.'
        : 'useradd is the low-level utility for adding accounts.'}

       Without root it prints the same refusal the real tool does, which is
       what almost everyone sees.

       With root it stops as well, and says why: the account database lives in
       js/core/users.js as a fixed table with no mutation API — the same list
       of accounts a fresh Ubuntu 24.04 install ships with. /etc/passwd,
       /etc/group and /etc/shadow are generated from it on demand, so a new
       account written to the virtual filesystem would vanish on the next
       read. Half-creating an account that id, su and login would all deny
       existed would be worse than declining.

       Everything that reads accounts — id, groups, getent, lastlog, su — is
       consistent with that one table.

EXIT STATUS
       1  always`,

    async run(ctx) {
      const login = ctx.argv.find((a) => !a.startsWith('-'));
      if (!isRoot(ctx)) {
        return fail(friendly
          ? `${name}: Only root may add a user or group to the system.\n`
          : `${name}: Permission denied.\n${name}: cannot lock /etc/passwd; try again later.\n`,
        1);
      }
      return fail(
        `${name}: cannot create ${login || 'an account'}: the account database in this desktop is a\n` +
        `${name}: fixed table in js/core/users.js with no way to add an entry at runtime.\n` +
        `${name}: /etc/passwd, /etc/group and /etc/shadow are generated from it, so a new\n` +
        `${name}: account would not survive the next read. Nothing was created.\n`,
        1,
      );
    },
  };
}

/* ================================================================== *
 * crontab
 * ================================================================== */

const CRON_DIR = '/var/spool/cron/crontabs';

const crontabCommand = {
  name: 'crontab',
  aliases: [],
  synopsis: 'crontab [-u USER] [-l | -e | -r | FILE]',
  description: 'Maintain the crontab file for a user',
  man: `NAME
       crontab - maintain crontab files for individual users

SYNOPSIS
       crontab [-u user] file
       crontab [-u user] [-l | -r | -e]

DESCRIPTION
       Installs, lists, edits and removes a user's crontab.

       The file is real. It is written to ${CRON_DIR}/USER on the virtual
       filesystem, so \`crontab -l\` reads back exactly what you installed, cat
       can read it, and it survives a reload along with the rest of the
       filesystem.

       Nothing runs it. There is no cron daemon executing jobs in this
       desktop — the \`cron\` process in the process table is part of the
       simulated daemon list, not a scheduler — so an installed crontab is a
       stored file and nothing more. That is stated here rather than left for
       you to discover at 3 a.m.

       -e opens the file in the desktop's Text Editor, which is this
       desktop's $EDITOR.

OPTIONS
       -u USER   Operate on this user's crontab (root only).
       -l        List the current crontab.
       -e        Edit the current crontab.
       -r        Remove the current crontab.
       FILE      Install FILE as the crontab. Use - to read standard input.

EXIT STATUS
       0  success
       1  no crontab, or the file could not be written`,

  async run(ctx) {
    const argv = ctx.argv;
    let who = currentUser();
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-u') {
        const requested = argv[++i];
        if (!isRoot(ctx) && requested !== who) {
          return fail('must be privileged to use -u\n', 1);
        }
        who = requested;
        continue;
      }
      if (a.startsWith('-')) { operands.push(a); continue; }
      operands.push(a);
    }

    const path = `${CRON_DIR}/${who}`;
    const flag = operands.find((a) => a.startsWith('-'));
    const file = operands.find((a) => !a.startsWith('-'));

    const ensureDir = () => {
      try {
        if (!fs.exists(CRON_DIR)) fs.mkdir(CRON_DIR, { parents: true });
        return null;
      } catch (e) {
        return `crontab: cannot create ${CRON_DIR}: ${e && e.message ? e.message : 'error'}\n`;
      }
    };

    if (flag === '-l' || flag === '--list') {
      if (!fs.exists(path)) return fail(`no crontab for ${who}\n`, 1);
      return ok(fs.readFile(path));
    }

    if (flag === '-r' || flag === '--remove') {
      if (!fs.exists(path)) return fail(`no crontab for ${who}\n`, 1);
      fs.unlink(path);
      return ok('');
    }

    if (flag === '-e' || flag === '--edit') {
      const dirError = ensureDir();
      if (dirError) return fail(dirError, 1);
      if (!fs.exists(path)) {
        fs.writeFile(path,
          '# Edit this file to introduce tasks to be run by cron.\n' +
          '#\n' +
          '# m h  dom mon dow   command\n');
      }
      const instance = wm.open('editor', { path });
      if (!instance) return fail('crontab: no editor is available\n', 1);
      return ok(`crontab: installing new crontab into ${path}\ncrontab: note that nothing in this desktop executes cron jobs\n`);
    }

    if (file) {
      const dirError = ensureDir();
      if (dirError) return fail(dirError, 1);
      let text;
      if (file === '-') {
        text = ctx.stdin || '';
      } else {
        const source = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(file, env.home));
        if (!fs.exists(source)) return fail(`crontab: file ${file}: No such file or directory\n`, 1);
        text = fs.readFile(source);
      }
      const bad = String(text).split('\n').findIndex((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) return false;
        if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) return false;
        if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+\S/.test(trimmed)) return false;
        return trimmed.split(/\s+/).length < 6;
      });
      if (bad >= 0) {
        return fail(`crontab: errors in crontab file, line ${bad + 1}, can't install\n`, 1);
      }
      fs.writeFile(path, String(text).endsWith('\n') ? text : `${text}\n`);
      return ok('');
    }

    return fail('usage:  crontab [-u user] file\n\tcrontab [-u user] [ -e | -l | -r ]\n', 1);
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const userCommands = [
  wCommand,
  usersCommand,
  lastCommand,
  lastlogCommand,
  passwdCommand,
  accountCommand('adduser'),
  accountCommand('useradd'),
  crontabCommand,
];

export default userCommands;
