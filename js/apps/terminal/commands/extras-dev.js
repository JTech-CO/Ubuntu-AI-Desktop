/**
 * js/apps/terminal/commands/extras-dev.js — the developer-facing utilities:
 * strace, ldd, getconf, dpkg-architecture and update-alternatives.
 *
 * strace and ldd are the two commands that cannot lie here. There is no
 * kernel and no ptrace(2), and nothing on the virtual filesystem is an ELF
 * object, so both report exactly that instead of printing a convincing
 * transcript. getconf and dpkg-architecture answer from the host: the real
 * logical core count and the real CPU architecture.
 */

import { procs } from '../../../core/procs.js';
import { env } from '../../../core/env.js';
import { fs } from '../../../core/fs.js';
import { device } from '../../../core/device.js';
import { ok, fail, isRoot } from './util.js';

/* ================================================================== *
 * strace
 * ================================================================== */

const straceCommand = {
  name: 'strace',
  aliases: [],
  synopsis: 'strace [-f] [-p PID] [-e EXPR] COMMAND [ARG]...',
  description: 'Trace system calls and signals',
  man: `NAME
       strace - trace system calls and signals

SYNOPSIS
       strace [options] command [args]
       strace -p pid

DESCRIPTION
       strace works by attaching to a process with ptrace(2) and intercepting
       every system call it makes.

       This desktop has neither. There is no kernel, no ptrace, and no
       process making system calls: 'ls', 'cat' and the rest are JavaScript
       functions that call the virtual filesystem in js/core/fs.js directly,
       and the process table that ps and top read is a simulation kept in
       memory.

       So strace refuses. Printing a plausible-looking openat/read/write
       transcript would be inventing data, and this command exists precisely
       to tell you the truth about what the emulator is.

       If you want to see what a command actually did, the honest tools are
       the ones that read real state: ls, stat and find over the virtual
       filesystem, ps and lsof over the process table, and the browser's own
       developer console over the JavaScript.

EXIT STATUS
       1  always`,

  async run(ctx) {
    const target = ctx.argv.filter((a) => !a.startsWith('-'));
    const attach = ctx.argv.includes('-p');
    const what = attach ? 'attach to a process' : target.length ? `trace "${target[0]}"` : 'trace anything';
    return fail(
      `strace: cannot ${what}: ptrace(2) is not available.\n` +
      'strace: this desktop has no kernel and no real processes — commands are JavaScript\n' +
      'strace: functions calling js/core/fs.js, so there are no system calls to intercept.\n' +
      'strace: try ltrace-free alternatives that read real state: ps, lsof, stat, find.\n',
      1,
    );
  },
};

/* ================================================================== *
 * ldd
 * ================================================================== */

const lddCommand = {
  name: 'ldd',
  aliases: [],
  synopsis: 'ldd [OPTION]... FILE...',
  description: 'Print shared object dependencies',
  man: `NAME
       ldd - print shared object dependencies

SYNOPSIS
       ldd [option]... file...

DESCRIPTION
       ldd prints the shared objects a program or shared library needs.

       Nothing on this filesystem is an ELF binary. \`apt install\` really does
       create a file under /usr/bin so that \`which\` finds it afterwards, but
       that file is a marker, not machine code, and the commands themselves
       are JavaScript modules loaded by the browser.

       So every existing, executable file here answers "not a dynamic
       executable" — which is exactly what real ldd says about a file that is
       not a dynamically linked ELF object, and it is the true answer rather
       than a convenient one.

OPTIONS
       -v, --verbose    Print all information (accepted, changes nothing).
       -u, --unused     Print unused direct dependencies.
       --version        Print the version.

EXIT STATUS
       0  the file was inspected
       1  the file could not be found`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--version')) {
      return ok('ldd (Ubuntu GLIBC 2.39-0ubuntu8.3) 2.39\n');
    }
    const operands = argv.filter((a) => !a.startsWith('-'));
    if (!operands.length) {
      return fail('ldd: missing file arguments\nTry `ldd --help\' for more information.\n', 1);
    }

    const many = operands.length > 1;
    const out = [];
    const err = [];
    let code = 0;

    for (const spec of operands) {
      const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec, env.home));
      let stat = null;
      try {
        stat = fs.stat(target);
      } catch {
        stat = null;
      }
      if (!stat) {
        err.push(`ldd: ${spec}: No such file or directory`);
        code = 1;
        continue;
      }
      if (many) out.push(`${spec}:`);
      if (stat.isDir) {
        err.push(`ldd: ${spec}: not regular file`);
        code = 1;
        continue;
      }
      if ((stat.mode & 0o111) === 0) {
        err.push(`ldd: warning: you do not have execution permission for \`${target}'`);
      }
      out.push('\tnot a dynamic executable');
    }

    return {
      stdout: out.length ? `${out.join('\n')}\n` : '',
      stderr: err.length ? `${err.join('\n')}\n` : '',
      code,
    };
  },
};

/* ================================================================== *
 * getconf
 * ================================================================== */

/**
 * The POSIX configuration variables getconf answers for. Values that depend
 * on the host are computed; the rest are glibc 2.39 on Linux constants.
 * @returns {Map<string, string|number>}
 */
function getconfTable() {
  const cores = device.cores() || procs.cores;
  const bits = device.arch() === 'i686' ? 32 : 64;
  const triplet = device.arch() === 'aarch64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
  return new Map(Object.entries({
    ARG_MAX: 2097152,
    CHAR_BIT: 8,
    CHAR_MAX: 127,
    CHAR_MIN: -128,
    CHILD_MAX: 30963,
    CLK_TCK: 100,
    GNU_LIBC_VERSION: 'glibc 2.39',
    GNU_LIBPTHREAD_VERSION: 'NPTL 2.39',
    HOST_NAME_MAX: 64,
    INT_MAX: 2147483647,
    INT_MIN: -2147483648,
    LEVEL1_DCACHE_LINESIZE: 64,
    LEVEL1_ICACHE_LINESIZE: 64,
    LINE_MAX: 2048,
    LINK_MAX: 65000,
    LOGIN_NAME_MAX: 256,
    LONG_BIT: bits,
    MB_LEN_MAX: 16,
    NAME_MAX: 255,
    NGROUPS_MAX: 65536,
    OPEN_MAX: 1024,
    PAGESIZE: 4096,
    PAGE_SIZE: 4096,
    PATH_MAX: 4096,
    PTHREAD_KEYS_MAX: 1024,
    PTHREAD_STACK_MIN: 16384,
    SHRT_MAX: 32767,
    SSIZE_MAX: 32767,
    TZNAME_MAX: 6,
    WORD_BIT: 32,
    _NPROCESSORS_CONF: cores,
    _NPROCESSORS_ONLN: cores,
    _POSIX_VERSION: 200809,
    _POSIX2_VERSION: 200809,
    _XOPEN_VERSION: 700,
    LFS_CFLAGS: '',
    LFS_LDFLAGS: '',
    LFS_LIBS: '',
    POSIX_V7_LP64_OFF64_CFLAGS: '-m64',
    LIBDIR: `/usr/lib/${triplet}`,
  }));
}

const getconfCommand = {
  name: 'getconf',
  aliases: [],
  synopsis: 'getconf [-a] [VARIABLE] [PATHNAME]',
  description: 'Query system configuration variables',
  man: `NAME
       getconf - query system configuration variables

SYNOPSIS
       getconf [-a]
       getconf variable [pathname]

DESCRIPTION
       Prints the value of a POSIX or glibc configuration variable.

       _NPROCESSORS_ONLN and _NPROCESSORS_CONF report the host's real logical
       core count, read from navigator.hardwareConcurrency. LONG_BIT and
       LIBDIR follow the host architecture. Everything else is the constant
       glibc 2.39 on Linux compiles in, which is genuinely fixed rather than
       measured.

OPTIONS
       -a, --all    Print every variable and its value.

EXIT STATUS
       0  the variable was printed
       1  the variable is unknown`,

  async run(ctx) {
    await device.ready();
    const table = getconfTable();
    const argv = ctx.argv;

    if (argv.includes('-a') || argv.includes('--all') || argv.length === 0) {
      if (argv.length === 0) {
        return fail('Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n', 1);
      }
      const width = Math.max(...Array.from(table.keys(), (k) => k.length)) + 2;
      const lines = [];
      for (const [key, value] of table) lines.push(`${key.padEnd(width)}${value}`);
      return ok(`${lines.join('\n')}\n`);
    }

    const name = argv.find((a) => !a.startsWith('-'));
    if (!name) return fail('getconf: missing variable name\n', 1);
    if (!table.has(name)) {
      return fail(`getconf: unknown variable '${name}'\n`, 1);
    }
    return ok(`${table.get(name)}\n`);
  },
};

/* ================================================================== *
 * dpkg-architecture
 * ================================================================== */

/**
 * Map the host architecture onto the Debian names dpkg uses.
 * @returns {{deb:string, gnuCpu:string, bits:string, multiarch:string}}
 */
function debArch() {
  const arch = device.arch();
  if (arch === 'aarch64') {
    return { deb: 'arm64', gnuCpu: 'aarch64', bits: '64', multiarch: 'aarch64-linux-gnu' };
  }
  if (arch === 'i686') {
    return { deb: 'i386', gnuCpu: 'i686', bits: '32', multiarch: 'i386-linux-gnu' };
  }
  return { deb: 'amd64', gnuCpu: 'x86_64', bits: '64', multiarch: 'x86_64-linux-gnu' };
}

/** Every DEB_* variable, in dpkg's own order. */
function archVariables() {
  const a = debArch();
  const out = new Map();
  for (const role of ['BUILD', 'HOST', 'TARGET']) {
    out.set(`DEB_${role}_ARCH`, a.deb);
    out.set(`DEB_${role}_ARCH_ABI`, 'base');
    out.set(`DEB_${role}_ARCH_BITS`, a.bits);
    out.set(`DEB_${role}_ARCH_CPU`, a.deb === 'i386' ? 'i386' : a.deb);
    out.set(`DEB_${role}_ARCH_ENDIAN`, 'little');
    out.set(`DEB_${role}_ARCH_LIBC`, 'gnu');
    out.set(`DEB_${role}_ARCH_OS`, 'linux');
    out.set(`DEB_${role}_GNU_CPU`, a.gnuCpu);
    out.set(`DEB_${role}_GNU_SYSTEM`, 'linux-gnu');
    out.set(`DEB_${role}_GNU_TYPE`, a.multiarch);
    out.set(`DEB_${role}_MULTIARCH`, a.multiarch);
  }
  return out;
}

const dpkgArchitectureCommand = {
  name: 'dpkg-architecture',
  aliases: [],
  synopsis: 'dpkg-architecture [-l] [-q VARIABLE] [-L]',
  description: 'Set and determine the architecture for package building',
  man: `NAME
       dpkg-architecture - set and determine the architecture for package
       building

SYNOPSIS
       dpkg-architecture [option...] [command]

DESCRIPTION
       Prints the architecture variables a Debian build uses.

       The architecture is the host's real one, taken from the browser's
       user-agent client hints where they are available and from the
       user-agent string otherwise — so an Apple Silicon Mac reports arm64
       and a PC reports amd64, rather than a baked-in constant.

OPTIONS
       -l, --list          Print the variables and values (the default).
       -q VARIABLE         Print one variable's value.
       -L, --list-known    Print the architectures dpkg knows about.

EXIT STATUS
       0  success
       1  an unknown variable was requested`,

  async run(ctx) {
    await device.ready();
    const argv = ctx.argv;
    const vars = archVariables();

    if (argv.includes('-L') || argv.includes('--list-known')) {
      return ok([
        'amd64', 'arm64', 'armel', 'armhf', 'i386', 'mips64el', 'ppc64el',
        'riscv64', 's390x', '',
      ].join('\n'));
    }

    const qIndex = argv.findIndex((a) => a === '-q');
    if (qIndex >= 0) {
      const name = argv[qIndex + 1];
      if (!name || !vars.has(name)) {
        return fail(`dpkg-architecture: error: unknown variable ${name || ''}\n`, 1);
      }
      return ok(`${vars.get(name)}\n`);
    }

    const lines = [];
    for (const [key, value] of vars) lines.push(`${key}=${value}`);
    return ok(`${lines.join('\n')}\n`);
  },
};


/* ================================================================== *
 * update-alternatives
 * ================================================================== */

const ALT_DIR = '/var/lib/dpkg/alternatives';

/**
 * The alternatives groups this desktop ships, matching what a stock Ubuntu
 * 24.04 desktop install registers.
 * @type {{name:string, link:string, slave:string,
 *         options:{path:string, priority:number, slave:string}[]}[]}
 */
const ALTERNATIVES = [
  {
    name: 'editor',
    link: '/usr/bin/editor',
    slave: 'editor.1.gz /usr/share/man/man1/editor.1.gz',
    options: [
      { path: '/bin/nano', priority: 40, slave: '/usr/share/man/man1/nano.1.gz' },
      { path: '/usr/bin/vim.tiny', priority: 15, slave: '/usr/share/man/man1/vim.1.gz' },
    ],
  },
  {
    name: 'pager',
    link: '/usr/bin/pager',
    slave: 'pager.1.gz /usr/share/man/man1/pager.1.gz',
    options: [
      { path: '/bin/less', priority: 77, slave: '/usr/share/man/man1/less.1.gz' },
      { path: '/bin/more', priority: 50, slave: '/usr/share/man/man1/more.1.gz' },
    ],
  },
  {
    name: 'x-terminal-emulator',
    link: '/usr/bin/x-terminal-emulator',
    slave: 'x-terminal-emulator.1.gz /usr/share/man/man1/x-terminal-emulator.1.gz',
    options: [
      { path: '/usr/bin/gnome-terminal.wrapper', priority: 40, slave: '/usr/share/man/man1/gnome-terminal.1.gz' },
    ],
  },
  {
    name: 'x-www-browser',
    link: '/usr/bin/x-www-browser',
    slave: '',
    options: [
      { path: '/usr/bin/firefox', priority: 40, slave: '' },
    ],
  },
  {
    name: 'awk',
    link: '/usr/bin/awk',
    slave: 'awk.1.gz /usr/share/man/man1/awk.1.gz',
    options: [
      { path: '/usr/bin/mawk', priority: 5, slave: '/usr/share/man/man1/mawk.1.gz' },
    ],
  },
];

/** @param {string} name @returns {object|null} */
function findAlternative(name) {
  return ALTERNATIVES.find((a) => a.name === name) || null;
}

/** The highest-priority option — dpkg's "best" value. */
function bestOption(group) {
  return group.options.reduce((best, o) => (o.priority > best.priority ? o : best), group.options[0]);
}

/**
 * The current selection: a manual choice recorded under /var/lib/dpkg, or
 * automatic mode picking the highest priority.
 * @param {object} group
 * @returns {{mode:string, value:string}}
 */
function selection(group) {
  try {
    const text = fs.readFile(`${ALT_DIR}/${group.name}`);
    const lines = String(text).split('\n');
    if (lines[0] === 'manual' && lines[1]) return { mode: 'manual', value: lines[1] };
  } catch {
    /* no recorded selection: automatic mode */
  }
  return { mode: 'auto', value: bestOption(group).path };
}

const updateAlternativesCommand = {
  name: 'update-alternatives',
  aliases: [],
  synopsis: 'update-alternatives --display|--list|--query|--get-selections|--set NAME PATH|--auto NAME',
  description: 'Maintain symbolic links determining default commands',
  man: `NAME
       update-alternatives - maintain symbolic links determining default
       commands

SYNOPSIS
       update-alternatives --display NAME
       update-alternatives --list NAME
       update-alternatives --query NAME
       update-alternatives --get-selections
       update-alternatives --set NAME PATH
       update-alternatives --auto NAME

DESCRIPTION
       Shows and changes which program each alternatives group points at.

       The groups are the ones a stock Ubuntu 24.04 desktop registers:
       editor, pager, x-terminal-emulator, x-www-browser and awk.

       --set and --auto really do record the choice, in ${ALT_DIR}/NAME on the
       virtual filesystem, which is the same path dpkg uses — so the change
       persists and --display reflects it afterwards. Both need root, and
       without it print dpkg's own permission error.

       The links themselves are informational. Running 'editor' does not
       dispatch through /usr/bin/editor here, because commands are resolved by
       name in the shell rather than by walking PATH to a real file.

OPTIONS
       --display NAME       Show the group's links and options.
       --list NAME          List the option paths, one per line.
       --query NAME         Show the group in machine-readable form.
       --get-selections     List every group, its mode and its value.
       --set NAME PATH      Select PATH manually (root).
       --auto NAME          Return the group to automatic mode (root).

EXIT STATUS
       0  success
       1  no such group or path
       2  permission denied`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--version')) {
      return ok('Debian update-alternatives version 1.22.6.\n');
    }

    const verb = argv.find((a) => a.startsWith('--'));
    const rest = argv.filter((a) => !a.startsWith('--'));

    if (verb === '--get-selections') {
      const lines = ALTERNATIVES.map((group) => {
        const sel = selection(group);
        return `${group.name.padEnd(31)}${sel.mode.padEnd(9)}${sel.value}`;
      });
      return ok(`${lines.join('\n')}\n`);
    }

    if (!verb) {
      return fail(
        'update-alternatives: error: need --display, --query, --list, --get-selections, ' +
        '--config, --set, --set-selections, --install, --remove, --all, --remove-all or --auto\n',
        2,
      );
    }

    const group = findAlternative(rest[0]);
    if (!group) {
      return fail(`update-alternatives: error: no alternatives for ${rest[0] || ''}\n`, 2);
    }
    const sel = selection(group);

    if (verb === '--list') {
      return ok(`${group.options.map((o) => o.path).join('\n')}\n`);
    }

    if (verb === '--display') {
      const out = [`${group.name} - ${sel.mode} mode`];
      out.push(`  link best version is ${bestOption(group).path}`);
      out.push(`  link currently points to ${sel.value}`);
      out.push(`  link ${group.name} is ${group.link}`);
      if (group.slave) out.push(`  slave ${group.slave.split(' ')[0]} is ${group.slave.split(' ')[1]}`);
      for (const option of group.options) {
        out.push(`${option.path} - priority ${option.priority}`);
        if (option.slave) out.push(`  slave ${group.slave.split(' ')[0]}: ${option.slave}`);
      }
      return ok(`${out.join('\n')}\n`);
    }

    if (verb === '--query') {
      const out = [`Name: ${group.name}`, `Link: ${group.link}`];
      if (group.slave) {
        out.push('Slaves:');
        out.push(` ${group.slave}`);
      }
      out.push(`Status: ${sel.mode}`);
      out.push(`Best: ${bestOption(group).path}`);
      out.push(`Value: ${sel.value}`);
      for (const option of group.options) {
        out.push('');
        out.push(`Alternative: ${option.path}`);
        out.push(`Priority: ${option.priority}`);
        if (option.slave) {
          out.push('Slaves:');
          out.push(` ${group.slave.split(' ')[0]} ${option.slave}`);
        }
      }
      out.push('');
      return ok(`${out.join('\n')}\n`);
    }

    if (verb === '--set' || verb === '--auto' || verb === '--config') {
      if (!isRoot(ctx)) {
        return fail(
          `update-alternatives: error: unable to create new file '${ALT_DIR}/${group.name}.dpkg-tmp': Permission denied\n`,
          2,
        );
      }
      if (verb === '--config') {
        return fail(
          'update-alternatives: --config needs an interactive selection menu, which this\n' +
          'update-alternatives: terminal cannot present mid-command. Use --set NAME PATH.\n',
          2,
        );
      }
      try {
        if (!fs.exists(ALT_DIR)) fs.mkdir(ALT_DIR, { parents: true });
      } catch (e) {
        return fail(`update-alternatives: error: cannot create ${ALT_DIR}: ${e && e.message ? e.message : 'error'}\n`, 2);
      }

      if (verb === '--auto') {
        try {
          if (fs.exists(`${ALT_DIR}/${group.name}`)) fs.unlink(`${ALT_DIR}/${group.name}`);
        } catch {
          /* already gone */
        }
        return ok(`update-alternatives: using ${bestOption(group).path} to provide ${group.link} (${group.name}) in auto mode\n`);
      }

      const wanted = rest[1];
      const option = group.options.find((o) => o.path === wanted);
      if (!option) {
        return fail(`update-alternatives: error: alternative ${wanted || ''} for ${group.name} not registered; not setting\n`, 2);
      }
      fs.writeFile(`${ALT_DIR}/${group.name}`, `manual\n${option.path}\n`);
      return ok(`update-alternatives: using ${option.path} to provide ${group.link} (${group.name}) in manual mode\n`);
    }

    return fail(`update-alternatives: error: unknown argument '${verb}'\n`, 2);
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const devCommands = [
  straceCommand,
  lddCommand,
  getconfCommand,
  dpkgArchitectureCommand,
  updateAlternativesCommand,
];

export default devCommands;
