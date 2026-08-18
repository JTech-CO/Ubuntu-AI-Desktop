/**
 * js/apps/terminal/commands/util.js — helpers shared by the system, network,
 * package, AI and misc command modules.
 *
 * Nothing here touches the DOM: commands return text and the terminal renders
 * it through the safe writers, so no value produced by this module can ever
 * reach `innerHTML`.
 */

import { env } from '../../../core/env.js';
import { users } from '../../../core/users.js';

/* ------------------------------------------------------------------ *
 * ANSI SGR
 * ------------------------------------------------------------------ */

/** CSI introducer, built from its code point so no control byte lives in source. */
export const CSI = `${String.fromCharCode(27)}[`;

/** Matches any SGR sequence. */
export const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;
export const UNDER = `${CSI}4m`;
export const REVERSE = `${CSI}7m`;
export const RED = `${CSI}31m`;
export const GREEN = `${CSI}32m`;
export const YELLOW = `${CSI}33m`;
export const BLUE = `${CSI}34m`;
export const MAGENTA = `${CSI}35m`;
export const CYAN = `${CSI}36m`;
export const WHITE = `${CSI}37m`;
export const GRAY = `${CSI}90m`;
export const BRIGHT_WHITE = `${CSI}97m`;
/** Yaru Ubuntu orange #E95420. */
export const ORANGE = `${CSI}38;2;233;84;32m`;

/**
 * Wrap text in an SGR sequence and reset afterwards.
 * @param {string} code the SGR prefix, e.g. `GREEN`
 * @param {string} text
 * @returns {string}
 */
export function paint(code, text) {
  return `${code}${text}${RESET}`;
}

/**
 * Remove every SGR sequence from a string.
 * @param {string} text
 * @returns {string}
 */
export function stripSgr(text) {
  return String(text).replace(SGR_RE, '');
}

/**
 * Printable width of a string, ignoring SGR sequences.
 * @param {string} text
 * @returns {number}
 */
export function visibleLength(text) {
  return stripSgr(text).length;
}

/* ------------------------------------------------------------------ *
 * Command results
 * ------------------------------------------------------------------ */

/**
 * @param {string} [stdout]
 * @returns {{stdout:string, stderr:string, code:number}}
 */
export function ok(stdout = '') {
  return { stdout, stderr: '', code: 0 };
}

/**
 * @param {string} stderr
 * @param {number} [code]
 * @returns {{stdout:string, stderr:string, code:number}}
 */
export function fail(stderr, code = 1) {
  return { stdout: '', stderr, code };
}

/* ------------------------------------------------------------------ *
 * Privilege state
 * ------------------------------------------------------------------ */

let rootDepth = 0;

/**
 * Tracks whether the current command is running with root privileges.
 * `sudo` and `su` push/pop a level around the command they execute.
 */
export const privilege = {
  /** @returns {boolean} */
  get isRoot() {
    return rootDepth > 0 || env.user === 'root';
  },

  /** Enter a root context (sudo / su). */
  enter() {
    rootDepth += 1;
  },

  /** Leave a root context. */
  exit() {
    rootDepth = Math.max(0, rootDepth - 1);
  },

  /** Force back to the unprivileged user (used when a root shell exits). */
  reset() {
    rootDepth = 0;
  },
};

/**
 * True when the command should behave as root.
 * @param {object} [ctx] command context; an explicit `ctx.isRoot` wins
 * @returns {boolean}
 */
export function isRoot(ctx) {
  if (ctx && typeof ctx.isRoot === 'boolean') return ctx.isRoot;
  return privilege.isRoot;
}

/** The name the prompt and `whoami` should report. */
export function currentUser() {
  return privilege.isRoot ? 'root' : env.user || users.current.name;
}

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

/**
 * Abort-aware sleep. Resolves early (never rejects) when the signal fires so
 * callers can simply check `signal.aborted` afterwards.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function wait(ms, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    if (signal) {
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish);
    }
  });
}

/**
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
export function aborted(signal) {
  return Boolean(signal && signal.aborted);
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @param {number} n
 * @param {number} [width]
 * @returns {string}
 */
export function pad0(n, width = 2) {
  return String(Math.abs(Math.trunc(n))).padStart(width, '0');
}

/**
 * Timezone abbreviation from Intl, falling back to a numeric UTC offset.
 * @param {Date} [d]
 * @returns {string}
 */
export function tzAbbr(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
    const name = parts.find((p) => p.type === 'timeZoneName');
    if (name && name.value) return name.value.replace(/^GMT$/, 'UTC');
  } catch {
    /* fall through to the numeric form */
  }
  return numericOffset(d).replace(/^([+-])/, 'UTC$1');
}

/**
 * `+0900` style UTC offset.
 * @param {Date} [d]
 * @returns {string}
 */
export function numericOffset(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${sign}${pad0(Math.floor(Math.abs(off) / 60))}${pad0(Math.abs(off) % 60)}`;
}

/**
 * `Aug 18 09:14:22` — the syslog / journalctl timestamp.
 * @param {Date} d
 * @returns {string}
 */
export function syslogStamp(d) {
  return `${MONTHS_SHORT[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}`;
}

/**
 * `Sun 2026-08-18 09:14:22 KST` — the systemd timestamp.
 * @param {Date} d
 * @param {boolean} [withZone]
 * @returns {string}
 */
export function systemdStamp(d, withZone = true) {
  const base = `${DAYS_SHORT[d.getDay()]} ${d.getFullYear()}-${pad0(d.getMonth() + 1)}-${pad0(d.getDate())} ${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}`;
  return withZone ? `${base} ${tzAbbr(d)}` : base;
}

/**
 * systemd's relative phrasing, e.g. "2h 41min ago".
 * @param {number} ms elapsed milliseconds
 * @returns {string}
 */
export function agoPhrase(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}day${d === 1 ? '' : 's'} ${h}h ago`;
  if (h > 0) return `${h}h ${m}min ago`;
  if (m > 0) return `${m}min ${s % 60}s ago`;
  return `${s}s ago`;
}

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

/**
 * Thousands separator, the way apt and dpkg print byte counts.
 * @param {number} n
 * @returns {string}
 */
export function group(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * `free -h` / `du -h` style human size from a byte count.
 * @param {number} bytes
 * @param {number} [base] 1024 for Ki/Mi/Gi, 1000 for k/M/G
 * @returns {string}
 */
export function humanSize(bytes, base = 1024) {
  const units = base === 1024 ? ['B', 'Ki', 'Mi', 'Gi', 'Ti'] : ['B', 'k', 'M', 'G', 'T'];
  let value = Math.abs(bytes);
  let i = 0;
  while (value >= base && i < units.length - 1) {
    value /= base;
    i += 1;
  }
  const text = i === 0 ? String(Math.round(value)) : value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${bytes < 0 ? '-' : ''}${text}${units[i]}`;
}

/**
 * apt's "1,234 kB" / "12.3 MB" download sizes.
 * @param {number} kb size in kibibytes
 * @returns {string}
 */
export function aptSize(kb) {
  const bytes = kb * 1024;
  if (bytes < 1000) return `${group(bytes)} B`;
  if (bytes < 1000 * 1000) return `${group(bytes / 1000)} kB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/* ------------------------------------------------------------------ *
 * Text layout
 * ------------------------------------------------------------------ */

/**
 * Greedy word wrap.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === '') {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * The terminal width a command should format for.
 * @param {object} ctx
 * @returns {number}
 */
export function termCols(ctx) {
  const term = ctx && ctx.term;
  const cols = term && (term.cols || term.columns || term.width);
  const n = Number(cols);
  return Number.isFinite(n) && n >= 20 ? Math.floor(n) : 80;
}

/**
 * The terminal height a full-screen command should format for.
 * @param {object} ctx
 * @returns {number}
 */
export function termRows(ctx) {
  const term = ctx && ctx.term;
  const rows = term && (term.rows || term.lines || term.height);
  const n = Number(rows);
  return Number.isFinite(n) && n >= 8 ? Math.floor(n) : 24;
}

/**
 * Subscribe to single key presses when the terminal offers a hook. Returns an
 * unsubscribe function, or null when the terminal has no such capability (in
 * which case Ctrl+C via `ctx.signal` remains the way out).
 * @param {object} term
 * @param {(key: string) => void} handler
 * @returns {(() => void)|null}
 */
export function onKey(term, handler) {
  if (!term) return null;
  for (const hook of ['onKey', 'onKeyPress', 'addKeyListener', 'readKeys']) {
    if (typeof term[hook] === 'function') {
      const off = term[hook]((key) => handler(String(key)));
      return typeof off === 'function' ? off : () => {};
    }
  }
  return null;
}

/**
 * Write a block of text through the terminal's line writer.
 * @param {object} term
 * @param {string} text
 */
export function writeBlock(term, text) {
  if (!term) return;
  if (typeof term.write === 'function') term.write(text);
  else if (typeof term.writeLine === 'function') {
    for (const line of String(text).split('\n')) term.writeLine(line);
  }
}
