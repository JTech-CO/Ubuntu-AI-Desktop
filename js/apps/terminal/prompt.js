/**
 * js/apps/terminal/prompt.js — PS1 rendering (ARCHITECTURE §17, "Prompt").
 *
 * Reproduces Ubuntu's stock interactive prompt exactly:
 *
 *   ubuntu@ubuntu-ai:~/Documents$
 *   └── bold green ──┘│└─ bold blue ─┘└ plain
 *
 * which comes from the PS1 that `/home/ubuntu/.bashrc` sets for a colour
 * terminal. Root shells switch the user@host segment to bold red and `\$`
 * renders as `#`.
 */

import { contract, basename } from '../../core/path.js';
import { ansiToNodes, stripAnsi } from './ansi.js';

/** Ubuntu 24.04 `.bashrc`, `color_prompt=yes` branch (title escape omitted). */
export const DEFAULT_PS1 =
  '\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ';

/** Same shape, red user@host — what you get after `sudo -i`. */
export const ROOT_PS1 =
  '\\[\\033[01;31m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ';

/** Continuation prompt for an unterminated quote or a trailing `\`. */
export const DEFAULT_PS2 = '> ';

/** `set -x` trace prompt. */
export const DEFAULT_PS4 = '+ ';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Bash reports itself as 5.2.21(1)-release on Noble. */
export const BASH_VERSION = '5.2.21';
export const BASH_VERSION_FULL = '5.2.21(1)-release';

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Normalise whatever the caller passes into the fields the escapes need.
 * @param {object} session
 * @returns {object}
 */
function viewOf(session) {
  const s = session || {};
  const user = s.user || 'ubuntu';
  const home = s.home || (user === 'root' ? '/root' : `/home/${user}`);
  return {
    user,
    home,
    host: s.host || 'ubuntu-ai',
    cwd: s.cwd || home,
    jobs: Array.isArray(s.jobs) ? s.jobs.filter((j) => j && j.state !== 'Done').length : 0,
    histNumber: Array.isArray(s.history) ? s.history.length + 1 : 1,
    cmdNumber: typeof s.cmdNumber === 'number' ? s.cmdNumber : 1,
    isRoot: user === 'root',
    shellName: 'bash',
    now: s.now instanceof Date ? s.now : new Date(),
  };
}

/**
 * Expand a bash PS1/PS2 string. `\[` and `\]` are non-printing markers and are
 * dropped; the ANSI they wrap is kept so `ansiToNodes` can colour it.
 * @param {string} ps
 * @param {object} session
 * @returns {string} a string that may contain ANSI escapes
 */
export function expandPS1(ps, session) {
  const v = viewOf(session);
  const src = typeof ps === 'string' ? ps : '';
  let out = '';
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }

    const k = src[i + 1];
    i += 2;

    switch (k) {
      case undefined: out += '\\'; break;
      case 'a': out += '\u0007'; break;
      case 'e': out += '\u001B'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '[': break;                       /* non-printing region start */
      case ']': break;                       /* non-printing region end   */
      case 'u': out += v.user; break;
      case 'h': out += v.host.split('.')[0]; break;
      case 'H': out += v.host; break;
      case 's': out += v.shellName; break;
      case 'v': out += BASH_VERSION; break;
      case 'V': out += BASH_VERSION_FULL; break;
      case 'j': out += String(v.jobs); break;
      case 'l': out += 'pts/0'; break;
      case '!': out += String(v.histNumber); break;
      case '#': out += String(v.cmdNumber); break;
      case '$': out += v.isRoot ? '#' : '$'; break;
      case 'w': out += contract(v.cwd, v.home); break;
      case 'W': {
        const short = contract(v.cwd, v.home);
        out += short === '~' || short === '/' ? short : basename(v.cwd);
        break;
      }
      case 'd':
        out += `${DAYS[v.now.getDay()]} ${MONTHS[v.now.getMonth()]} ${pad2(v.now.getDate())}`;
        break;
      case 't':
        out += `${pad2(v.now.getHours())}:${pad2(v.now.getMinutes())}:${pad2(v.now.getSeconds())}`;
        break;
      case 'T': {
        const h12 = v.now.getHours() % 12 || 12;
        out += `${pad2(h12)}:${pad2(v.now.getMinutes())}:${pad2(v.now.getSeconds())}`;
        break;
      }
      case 'A':
        out += `${pad2(v.now.getHours())}:${pad2(v.now.getMinutes())}`;
        break;
      case '@': {
        const h12 = v.now.getHours() % 12 || 12;
        out += `${pad2(h12)}:${pad2(v.now.getMinutes())} ${v.now.getHours() < 12 ? 'AM' : 'PM'}`;
        break;
      }
      case 'D': {
        // \D{format} — only the handful of strftime codes bash users reach for.
        if (src[i] === '{') {
          const end = src.indexOf('}', i + 1);
          const fmt = end < 0 ? '' : src.slice(i + 1, end);
          i = end < 0 ? src.length : end + 1;
          out += strftime(fmt || '%X', v.now);
        } else {
          out += strftime('%X', v.now);
        }
        break;
      }
      default:
        if (k >= '0' && k <= '7') {
          // \nnn octal escape
          let oct = k;
          while (oct.length < 3 && src[i] >= '0' && src[i] <= '7') {
            oct += src[i];
            i += 1;
          }
          out += String.fromCharCode(Number.parseInt(oct, 8));
        } else {
          out += `\\${k}`;
        }
        break;
    }
  }

  return out;
}

/**
 * Minimal strftime for `\D{…}`.
 * @param {string} fmt
 * @param {Date} d
 * @returns {string}
 */
function strftime(fmt, d) {
  return String(fmt).replace(/%([%aAbBdHIjmMpSyYXFT])/g, (m, code) => {
    switch (code) {
      case '%': return '%';
      case 'a': return DAYS[d.getDay()];
      case 'A': return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
      case 'b': return MONTHS[d.getMonth()];
      case 'B': return ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'][d.getMonth()];
      case 'd': return pad2(d.getDate());
      case 'H': return pad2(d.getHours());
      case 'I': return pad2(d.getHours() % 12 || 12);
      case 'j': return String(Math.ceil((d - new Date(d.getFullYear(), 0, 0)) / 86400000));
      case 'm': return pad2(d.getMonth() + 1);
      case 'M': return pad2(d.getMinutes());
      case 'p': return d.getHours() < 12 ? 'AM' : 'PM';
      case 'S': return pad2(d.getSeconds());
      case 'y': return pad2(d.getFullYear() % 100);
      case 'Y': return String(d.getFullYear());
      case 'F': return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      case 'T':
      case 'X': return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      default: return m;
    }
  });
}

/**
 * The prompt string for a session, as ANSI text.
 * @param {object} session
 * @returns {string}
 */
export function renderPrompt(session) {
  const s = session || {};
  const custom = typeof s.ps1 === 'string' && s.ps1 !== '' ? s.ps1 : null;
  const ps = custom || ((s.user || 'ubuntu') === 'root' ? ROOT_PS1 : DEFAULT_PS1);
  return expandPS1(ps, s);
}

/**
 * The continuation prompt for a session.
 * @param {object} session
 * @returns {string}
 */
export function renderPS2(session) {
  const s = session || {};
  const ps = typeof s.ps2 === 'string' && s.ps2 !== '' ? s.ps2 : DEFAULT_PS2;
  return expandPS1(ps, s);
}

/**
 * The prompt as safe DOM.
 * @param {object} session
 * @returns {DocumentFragment}
 */
export function promptNodes(session) {
  return ansiToNodes(renderPrompt(session));
}

/**
 * The prompt with colour removed — used to measure the cursor column.
 * @param {object} session
 * @returns {string}
 */
export function promptText(session) {
  return stripAnsi(renderPrompt(session));
}

/**
 * gnome-terminal's window/tab title, which comes from the `\e]0;…\a` escape
 * Ubuntu's `.bashrc` prepends to PS1.
 * @param {object} session
 * @returns {string} e.g. `ubuntu@ubuntu-ai: ~/Documents`
 */
export function titleFor(session) {
  const v = viewOf(session);
  return `${v.user}@${v.host.split('.')[0]}: ${contract(v.cwd, v.home)}`;
}
