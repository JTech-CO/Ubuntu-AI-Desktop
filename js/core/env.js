/**
 * js/core/env.js — shell environment (ARCHITECTURE §7).
 *
 * One process-wide environment shared by every Terminal instance, matching how
 * the original app behaved. Values are plain strings, exactly like execve(2).
 */

import { normalize, isAbsolute, expandTilde } from './path.js';

const DEFAULTS = {
  SHELL: '/bin/bash',
  PWD: '/home/ubuntu',
  LOGNAME: 'ubuntu',
  HOME: '/home/ubuntu',
  LANG: 'en_US.UTF-8',
  USER: 'ubuntu',
  HOSTNAME: 'ubuntu-ai',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin',
  OLDPWD: '/home/ubuntu',
  SHLVL: '1',
  XDG_SESSION_TYPE: 'wayland',
  XDG_SESSION_CLASS: 'user',
  XDG_SESSION_DESKTOP: 'ubuntu',
  XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
  XDG_MENU_PREFIX: 'gnome-',
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_DATA_DIRS: '/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop',
  XDG_CONFIG_DIRS: '/etc/xdg/xdg-ubuntu:/etc/xdg',
  DESKTOP_SESSION: 'ubuntu',
  GDMSESSION: 'ubuntu',
  GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated',
  GNOME_SHELL_SESSION_MODE: 'ubuntu',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  LESSCLOSE: '/usr/bin/lesspipe %s %s',
  LESSOPEN: '| /usr/bin/lesspipe %s',
  QT_ACCESSIBILITY: '1',
  QT_IM_MODULE: 'ibus',
  GTK_MODULES: 'gail:atk-bridge',
  SYSTEMD_EXEC_PID: '2413',
  _: '/usr/bin/env',
};

/** @type {Map<string, string>} */
const vars = new Map(Object.entries(DEFAULTS));

let exitCode = 0;
let shellPid = 2417;

/** `${VAR}` | `$VAR` | `$?` | `$$` | `$#` | `$0` */
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$(\?|\$|#|0)/g;

export const env = {
  /**
   * @param {string} name
   * @returns {string|undefined}
   */
  get(name) {
    return vars.get(String(name));
  },

  /**
   * @param {string} name
   * @param {any} value coerced to a string
   * @returns {string} the stored value
   */
  set(name, value) {
    const key = String(name);
    const val = value === null || value === undefined ? '' : String(value);
    vars.set(key, val);
    if (key === 'PWD') vars.set('PWD', normalize(val));
    return vars.get(key);
  },

  /** @param {string} name */
  unset(name) {
    vars.delete(String(name));
  },

  /** @param {string} name @returns {boolean} */
  has(name) {
    return vars.has(String(name));
  },

  /** @returns {Record<string,string>} a plain copy, insertion ordered */
  all() {
    const out = {};
    for (const [k, v] of vars) out[k] = v;
    return out;
  },

  /** @returns {string[]} variable names sorted alphabetically (for completion) */
  names() {
    return Array.from(vars.keys()).sort();
  },

  /**
   * Expand `$VAR`, `${VAR}`, `$?`, `$$` and a leading `~`.
   * Unknown variables expand to the empty string, exactly like bash.
   * @param {string} str
   * @returns {string}
   */
  expand(str) {
    if (typeof str !== 'string' || str === '') return '';
    let out = str;

    if (out.charCodeAt(0) === 126 /* '~' */ && (out.length === 1 || out[1] === '/')) {
      out = expandTilde(out, env.home);
    } else if (out === '~-') {
      out = vars.get('OLDPWD') || env.home;
    }

    return out.replace(VAR_RE, (match, braced, bare, special) => {
      const name = braced || bare;
      if (name) {
        const v = vars.get(name);
        return v === undefined ? '' : v;
      }
      switch (special) {
        case '?':
          return String(exitCode);
        case '$':
          return String(shellPid);
        case '#':
          return '0';
        case '0':
          return 'bash';
        default:
          return match;
      }
    });
  },

  /** Current working directory (`$PWD`). */
  get cwd() {
    return vars.get('PWD') || '/home/ubuntu';
  },

  /** Home directory (`$HOME`). */
  get home() {
    return vars.get('HOME') || '/home/ubuntu';
  },

  /** Login name (`$USER`). */
  get user() {
    return vars.get('USER') || 'ubuntu';
  },

  /** Host name (`$HOSTNAME`). */
  get host() {
    return vars.get('HOSTNAME') || 'ubuntu-ai';
  },

  /**
   * Change directory. Does not validate against the filesystem — `cd` checks
   * first and only calls this once the target is known to be a directory.
   * @param {string} p
   * @returns {string} the new cwd
   */
  setCwd(p) {
    const target = normalize(isAbsolute(p) ? p : `${env.cwd}/${p}`);
    vars.set('OLDPWD', env.cwd);
    vars.set('PWD', target);
    return target;
  },

  /** Exit status of the last command (`$?`). */
  get lastExit() {
    return exitCode;
  },

  set lastExit(code) {
    const n = Number(code);
    exitCode = Number.isFinite(n) ? n | 0 : 0;
  },

  /** Pid of the interactive shell (`$$`). */
  get pid() {
    return shellPid;
  },

  set pid(value) {
    const n = Number(value);
    if (Number.isFinite(n)) shellPid = n | 0;
  },

  /** Restore the login environment. */
  reset() {
    vars.clear();
    for (const [k, v] of Object.entries(DEFAULTS)) vars.set(k, v);
    exitCode = 0;
  },
};
