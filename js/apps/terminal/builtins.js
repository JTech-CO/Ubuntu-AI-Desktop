/**
 * js/apps/terminal/builtins.js — shell builtins (ARCHITECTURE §17).
 *
 * These live inside the shell rather than in `./commands/` because every one
 * of them mutates shell state — the working directory, the variable table, the
 * alias table, the job table or the session itself. `echo` is deliberately NOT
 * here: it is a normal command in `./commands/text.js`.
 *
 * Each builtin's `run(bctx)` receives:
 *   { argv, raw, stdin, sh, session, term, signal, write }
 * and returns `{ stdout, stderr, code }`.
 */

import { env } from '../../core/env.js';
import { fs, FsError } from '../../core/fs.js';
import * as path from '../../core/path.js';
import { execute, getCommand, loadAliases } from './shell.js';
import { BASH_VERSION_FULL } from './prompt.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reserved words bash reports as keywords rather than builtins. */
const KEYWORDS = new Set([
  '!', '[[', ']]', '{', '}', 'case', 'do', 'done', 'elif', 'else', 'esac', 'fi',
  'for', 'function', 'if', 'in', 'select', 'then', 'time', 'until', 'while', 'coproc',
]);

/** Commands that live in `/usr/sbin` on a real Ubuntu install. */
const SBIN = new Set([
  'reboot', 'poweroff', 'shutdown', 'halt', 'ifconfig', 'route', 'iptables',
  'useradd', 'usermod', 'userdel', 'groupadd', 'visudo', 'fdisk', 'mkfs',
  'swapon', 'swapoff', 'blkid', 'dhclient', 'service', 'sysctl',
]);

/**
 * Binary → package, the way Ubuntu's `command-not-found` handler resolves it.
 * @type {Readonly<Record<string,string>>}
 */
export const PACKAGE_HINTS = Object.freeze({
  htop: 'htop',
  btop: 'btop',
  glances: 'glances',
  tmux: 'tmux',
  screen: 'screen',
  git: 'git',
  gh: 'gh',
  vim: 'vim',
  nvim: 'neovim',
  emacs: 'emacs',
  zsh: 'zsh',
  fish: 'fish',
  tree: 'tree',
  jq: 'jq',
  ncdu: 'ncdu',
  nmap: 'nmap',
  tcpdump: 'tcpdump',
  iftop: 'iftop',
  iotop: 'iotop',
  ifconfig: 'net-tools',
  netstat: 'net-tools',
  route: 'net-tools',
  arp: 'net-tools',
  dig: 'bind9-dnsutils',
  nslookup: 'bind9-dnsutils',
  traceroute: 'traceroute',
  telnet: 'telnet',
  ssh: 'openssh-client',
  sshfs: 'sshfs',
  rsync: 'rsync',
  docker: 'docker.io',
  podman: 'podman',
  node: 'nodejs',
  npm: 'npm',
  python: 'python3',
  pip: 'python3-pip',
  gcc: 'gcc',
  'g++': 'g++',
  make: 'make',
  cmake: 'cmake',
  java: 'default-jre',
  ruby: 'ruby',
  php: 'php-cli',
  go: 'golang-go',
  rustc: 'rustc',
  cargo: 'cargo',
  cowsay: 'cowsay',
  figlet: 'figlet',
  fortune: 'fortune-mod',
  sl: 'sl',
  lolcat: 'lolcat',
  neofetch: 'neofetch',
  fastfetch: 'fastfetch',
  ffmpeg: 'ffmpeg',
  convert: 'imagemagick',
  unzip: 'unzip',
  zip: 'zip',
  '7z': 'p7zip-full',
  gpg: 'gnupg',
  ansible: 'ansible',
  mysql: 'mysql-client-core-8.0',
  psql: 'postgresql-client-common',
  'redis-cli': 'redis-tools',
  sqlite3: 'sqlite3',
  bat: 'bat',
  fd: 'fd-find',
  rg: 'ripgrep',
  fzf: 'fzf',
  pv: 'pv',
  lshw: 'lshw',
  smartctl: 'smartmontools',
  iostat: 'sysstat',
  strace: 'strace',
  ltrace: 'ltrace',
  gdb: 'gdb',
  valgrind: 'valgrind',
  shellcheck: 'shellcheck',
  pandoc: 'pandoc',
  xclip: 'xclip',
  xsel: 'xsel',
  espeak: 'espeak',
});

/**
 * The stderr text Ubuntu prints for an unknown command.
 * @param {string} name
 * @returns {string}
 */
export function commandNotFound(name) {
  const pkg = PACKAGE_HINTS[name];
  if (pkg) {
    return `Command '${name}' not found, but can be installed with:\nsudo apt install ${pkg}\n`;
  }
  return `${name}: command not found\n`;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function quoteValue(value) {
  return String(value === undefined ? '' : value).replace(/(["$`\\])/g, '\\$1');
}

function quoteSingle(value) {
  return String(value === undefined ? '' : value).split("'").join("'\\''");
}

function ok(stdout = '') {
  return { stdout, stderr: '', code: 0 };
}

function fail(stderr, code = 1) {
  return { stdout: '', stderr, code };
}

function binPathFor(name) {
  return SBIN.has(name) ? `/usr/sbin/${name}` : `/usr/bin/${name}`;
}

function jobMark(session, job) {
  const active = session.jobs.filter((j) => j.state === 'Running' || j.state === 'Stopped');
  const current = active[active.length - 1];
  const previous = active[active.length - 2];
  if (job === current) return '+';
  if (job === previous) return '-';
  return ' ';
}

/** `shopt` option table with Ubuntu 24.04's interactive-bash defaults. */
const SHOPT_DEFAULTS = Object.freeze({
  autocd: false,
  cdable_vars: false,
  cdspell: false,
  checkhash: false,
  checkjobs: false,
  checkwinsize: true,
  cmdhist: true,
  complete_fullquote: true,
  dotglob: false,
  execfail: false,
  expand_aliases: true,
  extglob: false,
  extquote: true,
  failglob: false,
  force_fignore: true,
  globstar: false,
  gnu_errfmt: false,
  histappend: true,
  histreedit: false,
  histverify: false,
  hostcomplete: false,
  huponexit: false,
  interactive_comments: true,
  lithist: false,
  login_shell: false,
  mailwarn: false,
  no_empty_cmd_completion: false,
  nocaseglob: false,
  nocasematch: false,
  nullglob: false,
  progcomp: true,
  promptvars: true,
  shift_verbose: false,
  sourcepath: true,
  xpg_echo: false,
});

function findJob(session, spec) {
  const jobs = session.jobs.filter((j) => j.state === 'Running' || j.state === 'Stopped');
  if (!spec || spec === '%' || spec === '%%' || spec === '%+') return jobs[jobs.length - 1] || null;
  if (spec === '%-') return jobs[jobs.length - 2] || null;
  const n = Number.parseInt(String(spec).replace(/^%/, ''), 10);
  if (!Number.isFinite(n)) return null;
  return session.jobs.find((j) => j.id === n) || null;
}

/* ------------------------------------------------------------------ *
 * the builtins
 * ------------------------------------------------------------------ */

/** @type {Record<string, {name:string, usage:string, summary:string, run:Function}>} */
export const BUILTINS = {
  ':': {
    name: ':',
    usage: ': [arguments]',
    summary: 'Null command. Always succeeds.',
    run() { return ok(); },
  },

  true: {
    name: 'true',
    usage: 'true',
    summary: 'Return a successful result.',
    run() { return ok(); },
  },

  false: {
    name: 'false',
    usage: 'false',
    summary: 'Return an unsuccessful result.',
    run() { return { stdout: '', stderr: '', code: 1 }; },
  },

  cd: {
    name: 'cd',
    usage: 'cd [-L|[-P [-e]] [-@]] [dir]',
    summary: 'Change the shell working directory.',
    run({ argv, session }) {
      const args = argv.filter((a) => a !== '-L' && a !== '-P' && a !== '-e' && a !== '-@');
      if (args.length > 1) return fail('bash: cd: too many arguments\n');

      let target = args[0];
      let echoPath = false;
      if (target === undefined || target === '') target = session.home;
      else if (target === '-') {
        target = env.get('OLDPWD') || session.cwd;
        echoPath = true;
      }

      const abs = path.resolve(session.cwd, path.expandTilde(target, session.home));
      try {
        const st = fs.stat(abs);
        if (!st.isDir) return fail(`bash: cd: ${target}: Not a directory\n`);
      } catch (err) {
        const phrase = err instanceof FsError ? err.message : 'No such file or directory';
        return fail(`bash: cd: ${target}: ${phrase}\n`);
      }

      env.setCwd(abs);
      session.cwd = env.cwd;
      session.vars.set('PWD', env.cwd);
      session.vars.set('OLDPWD', env.get('OLDPWD') || '');
      return ok(echoPath ? `${env.cwd}\n` : '');
    },
  },

  pwd: {
    name: 'pwd',
    usage: 'pwd [-LP]',
    summary: 'Print the name of the current working directory.',
    run({ session }) { return ok(`${session.cwd}\n`); },
  },

  export: {
    name: 'export',
    usage: 'export [-fn] [name[=value] ...] or export -p',
    summary: 'Set export attribute for shell variables.',
    run({ argv, session }) {
      if (argv.length === 0 || (argv.length === 1 && argv[0] === '-p')) {
        const lines = Array.from(session.vars.keys())
          .sort()
          .map((k) => `declare -x ${k}="${quoteValue(session.vars.get(k))}"`);
        return ok(lines.length ? `${lines.join('\n')}\n` : '');
      }

      let stderr = '';
      let code = 0;
      let unexport = false;
      for (const arg of argv) {
        if (arg === '-n') { unexport = true; continue; }
        if (arg === '-p' || arg === '-f') continue;

        const eq = arg.indexOf('=');
        if (eq > 0) {
          const name = arg.slice(0, eq);
          if (!IDENT_RE.test(name)) {
            stderr += `bash: export: \`${arg}': not a valid identifier\n`;
            code = 1;
            continue;
          }
          const value = arg.slice(eq + 1);
          session.vars.set(name, value);
          env.set(name, value);
          continue;
        }
        if (!IDENT_RE.test(arg)) {
          stderr += `bash: export: \`${arg}': not a valid identifier\n`;
          code = 1;
          continue;
        }
        if (unexport) { session.vars.delete(arg); env.unset(arg); continue; }
        if (!session.vars.has(arg)) { session.vars.set(arg, ''); env.set(arg, ''); }
      }
      return { stdout: '', stderr, code };
    },
  },

  unset: {
    name: 'unset',
    usage: 'unset [-f] [-v] [-n] [name ...]',
    summary: 'Unset values and attributes of shell variables and functions.',
    run({ argv, session }) {
      let stderr = '';
      let code = 0;
      for (const arg of argv) {
        if (arg === '-v' || arg === '-f' || arg === '-n') continue;
        if (!IDENT_RE.test(arg)) {
          stderr += `bash: unset: \`${arg}': not a valid identifier\n`;
          code = 1;
          continue;
        }
        session.vars.delete(arg);
        env.unset(arg);
      }
      return { stdout: '', stderr, code };
    },
  },

  alias: {
    name: 'alias',
    usage: 'alias [-p] [name[=value] ... ]',
    summary: 'Define or display aliases.',
    run({ argv, session }) {
      const names = argv.filter((a) => a !== '-p');
      if (names.length === 0) {
        const lines = Array.from(session.aliases.keys())
          .sort()
          .map((k) => `alias ${k}='${quoteSingle(session.aliases.get(k))}'`);
        return ok(lines.length ? `${lines.join('\n')}\n` : '');
      }

      let stdout = '';
      let stderr = '';
      let code = 0;
      for (const arg of names) {
        const eq = arg.indexOf('=');
        if (eq > 0) {
          session.aliases.set(arg.slice(0, eq), arg.slice(eq + 1));
          continue;
        }
        if (session.aliases.has(arg)) {
          stdout += `alias ${arg}='${quoteSingle(session.aliases.get(arg))}'\n`;
        } else {
          stderr += `bash: alias: ${arg}: not found\n`;
          code = 1;
        }
      }
      return { stdout, stderr, code };
    },
  },

  unalias: {
    name: 'unalias',
    usage: 'unalias [-a] name [name ...]',
    summary: 'Remove each NAME from the list of defined aliases.',
    run({ argv, session }) {
      if (argv.includes('-a')) { session.aliases.clear(); return ok(); }
      if (argv.length === 0) return fail('unalias: usage: unalias [-a] name [name ...]\n', 2);
      let stderr = '';
      let code = 0;
      for (const arg of argv) {
        if (!session.aliases.delete(arg)) {
          stderr += `bash: unalias: ${arg}: not found\n`;
          code = 1;
        }
      }
      return { stdout: '', stderr, code };
    },
  },

  source: {
    name: 'source',
    usage: 'source filename [arguments]',
    summary: 'Execute commands from a file in the current shell.',
    async run(bctx) {
      const { argv, sh, session } = bctx;
      if (argv.length === 0) {
        return fail('bash: source: filename argument required\nsource: usage: source filename [arguments]\n', 2);
      }
      const target = path.resolve(session.cwd, path.expandTilde(argv[0], session.home));
      let text;
      try {
        text = fs.readFile(target);
      } catch (err) {
        const phrase = err instanceof FsError ? err.message : 'No such file or directory';
        return fail(`bash: ${argv[0]}: ${phrase}\n`);
      }

      let stdout = '';
      let stderr = '';
      let code = 0;
      let depth = 0;

      // This shell has no control-flow grammar, so compound commands are
      // skipped wholesale rather than exploding across every stock dotfile.
      const OPENS = /^(if|case|for|while|until|select)\b/;
      const CLOSES = /^(fi|esac|done|\})\s*(;|$)/;
      const FUNC = /^[A-Za-z_][A-Za-z0-9_-]*\s*\(\)\s*\{?$/;

      for (const rawLine of String(text).split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;

        const opens = OPENS.test(line) || FUNC.test(line) || /(^|\s)\{$/.test(line);
        const closes = CLOSES.test(line);
        if (depth > 0) {
          if (opens) depth += 1;
          else if (closes) depth -= 1;
          continue;
        }
        if (opens) { depth += 1; continue; }
        if (closes) continue;
        if (/^(then|else|elif|do|;;|\)|\*\))/.test(line)) continue;

        if (sh.signal && sh.signal.aborted) { code = 130; break; }
        const res = await execute(line, {
          session,
          term: sh.term,
          signal: sh.signal,
          capture: true,
          depth: (sh.depth || 0) + 1,
        });
        stdout += res.stdout;
        stderr += res.stderr;
        code = res.code;
      }
      // Re-read alias definitions so `source ~/.bashrc` behaves like a login.
      loadAliases(session);
      return { stdout, stderr, code };
    },
  },

  '.': {
    name: '.',
    usage: '. filename [arguments]',
    summary: 'Execute commands from a file in the current shell.',
    run(bctx) { return BUILTINS.source.run(bctx); },
  },

  exit: {
    name: 'exit',
    usage: 'exit [n]',
    summary: 'Exit the shell.',
    run({ argv, sh, session }) {
      let code = session.lastExit | 0;
      if (argv.length > 0) {
        const n = Number.parseInt(argv[0], 10);
        if (!Number.isFinite(n)) {
          sh.exited = true;
          return fail(`bash: exit: ${argv[0]}: numeric argument required\n`, 2);
        }
        code = ((n % 256) + 256) % 256;
      }
      sh.exited = true;
      session.exited = true;
      return { stdout: '', stderr: '', code };
    },
  },

  logout: {
    name: 'logout',
    usage: 'logout [n]',
    summary: 'Exit a login shell.',
    run(bctx) { return BUILTINS.exit.run(bctx); },
  },

  history: {
    name: 'history',
    usage: 'history [-c] [-d offset] [n]',
    summary: 'Display or manipulate the history list.',
    run({ argv, session }) {
      if (argv[0] === '-c') { session.history.length = 0; return ok(); }
      if (argv[0] === '-d') {
        const n = Number.parseInt(argv[1], 10);
        if (!Number.isFinite(n) || n < 1 || n > session.history.length) {
          return fail(`bash: history: ${argv[1]}: history position out of range\n`);
        }
        session.history.splice(n - 1, 1);
        return ok();
      }

      let entries = session.history.map((cmd, index) => ({ n: index + 1, cmd }));
      if (argv[0] !== undefined) {
        const limit = Number.parseInt(argv[0], 10);
        if (!Number.isFinite(limit)) return fail(`bash: history: ${argv[0]}: numeric argument required\n`, 2);
        entries = entries.slice(-Math.max(0, limit));
      }
      const lines = entries.map((e) => `${String(e.n).padStart(5)}  ${e.cmd}`);
      return ok(lines.length ? `${lines.join('\n')}\n` : '');
    },
  },

  jobs: {
    name: 'jobs',
    usage: 'jobs [-lnprs] [jobspec ...]',
    summary: 'Display status of jobs.',
    run({ argv, session }) {
      const long = argv.includes('-l');
      const active = session.jobs.filter((j) => j.state === 'Running' || j.state === 'Stopped');
      const lines = active.map((job) => {
        const pid = long ? ` ${job.pid}` : '';
        return `[${job.id}]${jobMark(session, job)} ${pid}  ${job.state.padEnd(22)}${job.cmd} &`;
      });
      return ok(lines.length ? `${lines.join('\n')}\n` : '');
    },
  },

  fg: {
    name: 'fg',
    usage: 'fg [job_spec]',
    summary: 'Move job to the foreground.',
    async run({ argv, session }) {
      const job = findJob(session, argv[0]);
      if (!job) return fail(`bash: fg: ${argv[0] || 'current'}: no such job\n`);
      job.state = 'Running';
      const header = `${job.cmd}\n`;
      if (job.promise) {
        try { await job.promise; } catch { /* the job reports its own failure */ }
      }
      return ok(header);
    },
  },

  bg: {
    name: 'bg',
    usage: 'bg [job_spec ...]',
    summary: 'Move jobs to the background.',
    run({ argv, session }) {
      const job = findJob(session, argv[0]);
      if (!job) return fail(`bash: bg: ${argv[0] || 'current'}: no such job\n`);
      job.state = 'Running';
      return ok(`[${job.id}]${jobMark(session, job)} ${job.cmd} &\n`);
    },
  },

  set: {
    name: 'set',
    usage: 'set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [arg ...]',
    summary: 'Set or unset shell options and positional parameters.',
    run({ argv, session }) {
      if (argv.length === 0) {
        const lines = Array.from(session.vars.keys())
          .sort()
          .map((k) => `${k}=${session.vars.get(k)}`);
        return ok(lines.length ? `${lines.join('\n')}\n` : '');
      }

      const OPTIONS = ['allexport', 'braceexpand', 'emacs', 'errexit', 'hashall', 'histexpand',
        'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber',
        'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd', 'physical', 'pipefail',
        'posix', 'privileged', 'verbose', 'vi', 'xtrace'];
      const LONG_TO_SHORT = {
        errexit: 'e', nounset: 'u', xtrace: 'x', verbose: 'v', noglob: 'f',
        noexec: 'n', monitor: 'm', pipefail: 'pipefail', allexport: 'a',
      };

      let stderr = '';
      let code = 0;
      let stdout = '';
      for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '-o' || arg === '+o') {
          const name = argv[i + 1];
          if (name === undefined) {
            stdout += OPTIONS
              .map((o) => `${o.padEnd(16)}${session.opts.has(LONG_TO_SHORT[o] || o) ? 'on' : 'off'}`)
              .join('\n');
            stdout += '\n';
            continue;
          }
          i += 1;
          const flag = LONG_TO_SHORT[name] || name;
          if (arg === '-o') session.opts.add(flag);
          else session.opts.delete(flag);
          continue;
        }
        if (arg === '--') continue;
        if (arg[0] === '-' || arg[0] === '+') {
          const on = arg[0] === '-';
          for (const ch of arg.slice(1)) {
            if (on) session.opts.add(ch);
            else session.opts.delete(ch);
          }
          continue;
        }
        stderr += `bash: set: ${arg}: invalid option name\n`;
        code = 2;
      }
      return { stdout, stderr, code };
    },
  },

  type: {
    name: 'type',
    usage: 'type [-afptP] name [name ...]',
    summary: 'Display information about command type.',
    run({ argv, session }) {
      let mode = '';
      const names = [];
      for (const arg of argv) {
        if (arg === '-t' || arg === '-p' || arg === '-P' || arg === '-a' || arg === '-f') mode = arg;
        else names.push(arg);
      }
      if (names.length === 0) return ok();

      let stdout = '';
      let stderr = '';
      let code = 0;
      for (const name of names) {
        if (session.aliases.has(name)) {
          stdout += mode === '-t'
            ? 'alias\n'
            : `${name} is aliased to \`${session.aliases.get(name)}'\n`;
          continue;
        }
        if (KEYWORDS.has(name)) {
          stdout += mode === '-t' ? 'keyword\n' : `${name} is a shell keyword\n`;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) {
          if (mode === '-p' || mode === '-P') continue;
          stdout += mode === '-t' ? 'builtin\n' : `${name} is a shell builtin\n`;
          continue;
        }
        if (getCommand(name)) {
          const bin = binPathFor(name);
          if (mode === '-t') stdout += 'file\n';
          else if (mode === '-p' || mode === '-P') stdout += `${bin}\n`;
          else stdout += `${name} is ${bin}\n`;
          continue;
        }
        if (mode !== '-t' && mode !== '-p') stderr += `bash: type: ${name}: not found\n`;
        code = 1;
      }
      return { stdout, stderr, code };
    },
  },

  eval: {
    name: 'eval',
    usage: 'eval [arg ...]',
    summary: 'Execute arguments as a shell command.',
    async run({ argv, sh, session }) {
      const line = argv.join(' ');
      if (line.trim() === '') return ok();
      const res = await execute(line, {
        session,
        term: sh.term,
        signal: sh.signal,
        capture: true,
        depth: (sh.depth || 0) + 1,
      });
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    },
  },

  command: {
    name: 'command',
    usage: 'command [-pVv] command [arg ...]',
    summary: 'Execute a simple command or display information about commands.',
    async run({ argv, sh, session }) {
      let mode = '';
      let i = 0;
      while (argv[i] === '-v' || argv[i] === '-V' || argv[i] === '-p') {
        if (argv[i] !== '-p') mode = argv[i];
        i += 1;
      }
      const rest = argv.slice(i);
      if (rest.length === 0) return ok();
      const name = rest[0];

      if (mode === '-v' || mode === '-V') {
        if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) {
          return ok(mode === '-v' ? `${name}\n` : `${name} is a shell builtin\n`);
        }
        if (getCommand(name)) {
          const bin = binPathFor(name);
          return ok(mode === '-v' ? `${bin}\n` : `${name} is ${bin}\n`);
        }
        return { stdout: '', stderr: mode === '-V' ? `bash: command: ${name}: not found\n` : '', code: 1 };
      }

      const res = await execute(rest.join(' '), {
        session,
        term: sh.term,
        signal: sh.signal,
        capture: true,
        noAlias: true,
        depth: (sh.depth || 0) + 1,
      });
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    },
  },

  wait: {
    name: 'wait',
    usage: 'wait [-fn] [id ...]',
    summary: 'Wait for job completion and return exit status.',
    async run({ argv, session }) {
      const targets = argv.length
        ? argv.map((spec) => findJob(session, spec)).filter(Boolean)
        : session.jobs.filter((j) => j.state === 'Running');
      let code = 0;
      for (const job of targets) {
        if (!job.promise) continue;
        try { code = await job.promise; } catch { code = 1; }
      }
      return { stdout: '', stderr: '', code: Number.isFinite(code) ? code : 0 };
    },
  },

  shopt: {
    name: 'shopt',
    usage: 'shopt [-pqsu] [-o] [optname ...]',
    summary: 'Set and unset shell options.',
    run({ argv, session }) {
      if (!session.shopts) session.shopts = new Map(Object.entries(SHOPT_DEFAULTS));
      const opts = session.shopts;

      let action = '';
      let quiet = false;
      const names = [];
      for (const arg of argv) {
        if (arg === '-s') { action = 's'; continue; }
        if (arg === '-u') { action = 'u'; continue; }
        if (arg === '-q') { quiet = true; continue; }
        if (arg === '-p' || arg === '-o') continue;
        names.push(arg);
      }

      if (action === '') {
        const wanted = names.length ? names : Array.from(opts.keys()).sort();
        let stdout = '';
        let stderr = '';
        let code = 0;
        for (const name of wanted) {
          if (!opts.has(name)) {
            stderr += `bash: shopt: ${name}: invalid shell option name\n`;
            code = 1;
            continue;
          }
          if (opts.get(name) === false) code = 1;
          if (!quiet) stdout += `${name.padEnd(15)}\t${opts.get(name) ? 'on' : 'off'}\n`;
        }
        return { stdout, stderr, code };
      }

      let stderr = '';
      let code = 0;
      for (const name of names) {
        if (!opts.has(name)) {
          stderr += `bash: shopt: ${name}: invalid shell option name\n`;
          code = 1;
          continue;
        }
        opts.set(name, action === 's');
      }
      return { stdout: '', stderr, code };
    },
  },

  help: {
    name: 'help',
    usage: 'help [-dms] [pattern ...]',
    summary: 'Display information about builtin commands.',
    run({ argv }) {
      const names = Object.keys(BUILTINS).sort();

      if (argv.length === 0 || argv[0].startsWith('-')) {
        const header =
          `GNU bash, version ${BASH_VERSION_FULL} (x86_64-pc-linux-gnu)\n` +
          'These shell commands are defined internally.  Type `help\' to see this list.\n' +
          'Type `help name\' to find out more about the function `name\'.\n' +
          'Use `info bash\' to find out more about the shell in general.\n' +
          'Use `man -k\' or `info\' to find out more about commands not in this list.\n\n' +
          'A star (*) next to a name means that the command is disabled.\n\n';

        const usages = names.map((n) => BUILTINS[n].usage);
        const width = Math.max(...usages.map((u) => u.length)) + 2;
        const half = Math.ceil(usages.length / 2);
        const rows = [];
        for (let i = 0; i < half; i += 1) {
          const left = usages[i] || '';
          const right = usages[i + half] || '';
          rows.push(` ${left.padEnd(width)}${right}`.replace(/\s+$/, ''));
        }
        return ok(header + rows.join('\n') + '\n');
      }

      let stdout = '';
      let stderr = '';
      let code = 0;
      for (const pattern of argv) {
        const matches = names.filter((n) => n === pattern || n.startsWith(pattern));
        if (matches.length === 0) {
          stderr += `bash: help: no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}' or \`info ${pattern}'.\n`;
          code = 1;
          continue;
        }
        for (const name of matches) {
          const b = BUILTINS[name];
          stdout += `${name}: ${b.usage}\n    ${b.summary}\n`;
        }
      }
      return { stdout, stderr, code };
    },
  },
};

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isBuiltin(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(BUILTINS, name);
}

/** @returns {string[]} builtin names, sorted */
export function builtinNames() {
  return Object.keys(BUILTINS).sort();
}
