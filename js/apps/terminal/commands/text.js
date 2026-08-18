/**
 * js/apps/terminal/commands/text.js — text processing commands (ARCHITECTURE §17).
 *
 * echo printf grep egrep fgrep sed sort uniq cut tr rev tee diff nl less more
 * paste column fold split join comm shuf
 *
 * Every command follows the §17 command object contract and returns
 * `{ stdout, stderr, code }`. Error phrasing and output formats match the GNU
 * coreutils / grep / sed / diffutils builds shipped in Ubuntu 24.04 LTS.
 */

import * as pathmod from '../../../core/path.js';
import { C } from '../ansi.js';

/* ================================================================== *
 * ANSI palette
 * ================================================================== */

function sgr(name, fallback) {
  const value = C && C[name];
  return typeof value === 'string' ? value : fallback;
}

const RESET = sgr('reset', '\u001b[0m');
const BOLD = sgr('bold', '\u001b[1m');
const RED = sgr('red', '\u001b[31m');
const GREEN = sgr('green', '\u001b[32m');
const MAGENTA = sgr('magenta', '\u001b[35m');
const CYAN = sgr('cyan', '\u001b[36m');

/* GREP_COLORS defaults: mt=01;31 fn=35 ln=32 se=36 */
const GC_MATCH = BOLD + RED;
const GC_FILE = MAGENTA;
const GC_LINE = GREEN;
const GC_SEP = CYAN;

/* ================================================================== *
 * shared helpers
 * ================================================================== */

function padLeft(s, w) {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function padRight(s, w) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function ok(stdout = '') {
  return { stdout, stderr: '', code: 0 };
}

function result(outLines, errLines, code) {
  return { stdout: outLines.join(''), stderr: errLines.join(''), code };
}

function phrase(err) {
  if (err && typeof err.message === 'string' && err.message !== '') return err.message;
  return 'No such file or directory';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termCols(ctx) {
  const t = ctx && ctx.term;
  if (t) {
    for (const key of ['cols', 'columns', 'width']) {
      const n = Number(t[key]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  const fromEnv = Number(ctx && ctx.env && typeof ctx.env.get === 'function' ? ctx.env.get('COLUMNS') : NaN);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 80;
}

function termRows(ctx) {
  const t = ctx && ctx.term;
  if (t) {
    for (const key of ['rows', 'lines', 'height']) {
      const n = Number(t[key]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return 24;
}

function isTTY(ctx) {
  if (!ctx) return false;
  if (ctx.isTTY !== undefined) return Boolean(ctx.isTTY);
  if (ctx.piped !== undefined) return !ctx.piped;
  return Boolean(ctx.term);
}

function cwdOf(ctx) {
  if (ctx && typeof ctx.cwd === 'string' && ctx.cwd !== '') return ctx.cwd;
  return ctx && ctx.env ? ctx.env.cwd : '/home/ubuntu';
}

function abs(ctx, p) {
  return ctx.fs.resolve(p, cwdOf(ctx));
}

/** GNU en_US.UTF-8 collation: punctuation ignored at the primary level. */
function collate(a, b) {
  const ka = a.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
  const kb = b.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
  if (ka !== kb) return ka < kb ? -1 : 1;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** See files.js — kept in sync deliberately so the two modules stay standalone. */
function optParse(argv, valueFlags = '') {
  const flags = new Set();
  const values = Object.create(null);
  const longs = Object.create(null);
  const operands = [];
  let bad = null;
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (literal) {
      operands.push(a);
      continue;
    }
    if (a === '--') {
      literal = true;
      continue;
    }
    if (a.length > 2 && a.slice(0, 2) === '--') {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      longs[name] = eq < 0 ? true : a.slice(eq + 1);
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j += 1) {
        const ch = a[j];
        if (valueFlags.indexOf(ch) >= 0) {
          const rest = a.slice(j + 1);
          if (rest !== '') {
            values[ch] = rest;
          } else {
            i += 1;
            values[ch] = i < argv.length ? argv[i] : '';
          }
          j = a.length;
          break;
        }
        if (!/[A-Za-z0-9]/.test(ch)) {
          if (bad === null) bad = ch;
          continue;
        }
        flags.add(ch);
      }
      continue;
    }
    operands.push(a);
  }
  return { flags, values, longs, operands, bad };
}

function splitLines(text) {
  if (text === '') return { lines: [], trailing: true };
  const trailing = text.charCodeAt(text.length - 1) === 10;
  const body = trailing ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailing };
}

function joinLines(lines, trailing = true) {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailing ? '\n' : '');
}

/**
 * Read operands as text, falling back to stdin.
 * @returns {{items: Array<{name: string, text: string}>, errors: string[], code: number}}
 */
function readInputs(ctx, operands, cmd) {
  const items = [];
  const errors = [];
  let code = 0;
  const names = operands.length === 0 ? ['-'] : operands;

  for (const name of names) {
    if (name === '-') {
      items.push({ name: '-', text: ctx.stdin || '' });
      continue;
    }
    const target = abs(ctx, name);
    try {
      if (ctx.fs.isDir(target)) {
        errors.push(`${cmd}: ${name}: Is a directory\n`);
        code = cmd === 'grep' ? code : 1;
        continue;
      }
      items.push({ name, text: ctx.fs.readFile(target) });
    } catch (err) {
      errors.push(`${cmd}: ${name}: ${phrase(err)}\n`);
      code = cmd === 'grep' ? 2 : 1;
    }
  }
  return { items, errors, code };
}

/** Backslash escapes shared by echo -e, printf and tr. */
function unescape(str) {
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch !== '\\' || i + 1 >= str.length) {
      out += ch;
      continue;
    }
    i += 1;
    const esc = str[i];
    switch (esc) {
      case 'a': out += '\u0007'; break;
      case 'b': out += '\b'; break;
      case 'e': out += '\u001b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '0': {
        let digits = '';
        while (digits.length < 3 && /[0-7]/.test(str[i + 1] || '')) {
          i += 1;
          digits += str[i];
        }
        out += String.fromCharCode(parseInt(digits || '0', 8));
        break;
      }
      case 'x': {
        let digits = '';
        while (digits.length < 2 && /[0-9A-Fa-f]/.test(str[i + 1] || '')) {
          i += 1;
          digits += str[i];
        }
        out += digits === '' ? '\\x' : String.fromCharCode(parseInt(digits, 16));
        break;
      }
      default:
        out += `\\${esc}`;
    }
  }
  return out;
}

/* ================================================================== *
 * POSIX regular expressions -> JavaScript RegExp
 * ================================================================== */

const POSIX_CLASSES = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\u000b\\f\\r',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
  word: '0-9A-Za-z_',
};

/** Translate a POSIX bracket expression starting at `start`. */
function readBracket(pat, start) {
  let i = start + 1;
  let out = '[';
  if (pat[i] === '^') {
    out += '^';
    i += 1;
  }
  if (pat[i] === ']') {
    out += '\\]';
    i += 1;
  }
  while (i < pat.length && pat[i] !== ']') {
    if (pat[i] === '[' && pat[i + 1] === ':') {
      const end = pat.indexOf(':]', i + 2);
      if (end > 0) {
        const name = pat.slice(i + 2, end);
        out += POSIX_CLASSES[name] !== undefined ? POSIX_CLASSES[name] : '';
        i = end + 2;
        continue;
      }
    }
    if (pat[i] === '\\') {
      out += '\\\\';
      i += 1;
      continue;
    }
    if (pat[i] === '^' || pat[i] === '[') {
      out += `\\${pat[i]}`;
      i += 1;
      continue;
    }
    out += pat[i];
    i += 1;
  }
  if (i >= pat.length) return { source: '\\[', next: start + 1 };
  return { source: `${out}]`, next: i + 1 };
}

/**
 * @param {string} pat POSIX pattern
 * @param {boolean} extended true for ERE (-E), false for BRE
 * @returns {string} JavaScript RegExp source
 */
function posixToJs(pat, extended) {
  let out = '';
  let i = 0;
  const meta = '(){}|+?';
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '\\') {
      const nx = pat[i + 1];
      if (nx === undefined) {
        out += '\\\\';
        i += 1;
        continue;
      }
      if (nx === '<' || nx === '>' || nx === 'b') {
        out += '\\b';
        i += 2;
        continue;
      }
      if (nx === 'B') {
        out += '\\B';
        i += 2;
        continue;
      }
      if ('wWsSdD'.indexOf(nx) >= 0 || /[1-9]/.test(nx)) {
        out += `\\${nx}`;
        i += 2;
        continue;
      }
      if (meta.indexOf(nx) >= 0) {
        out += extended ? `\\${nx}` : nx;
        i += 2;
        continue;
      }
      out += escapeRe(nx);
      i += 2;
      continue;
    }
    if (ch === '[') {
      const cls = readBracket(pat, i);
      out += cls.source;
      i = cls.next;
      continue;
    }
    if (meta.indexOf(ch) >= 0) {
      out += extended ? ch : `\\${ch}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Build a RegExp from a grep/sed pattern.
 * @param {string} pattern
 * @param {{extended?: boolean, fixed?: boolean, word?: boolean, insensitive?: boolean, global?: boolean}} opts
 */
function buildRegExp(pattern, opts = {}) {
  let source = opts.fixed ? escapeRe(pattern) : posixToJs(pattern, Boolean(opts.extended));
  if (opts.word) source = `(?<![0-9A-Za-z_])(?:${source})(?![0-9A-Za-z_])`;
  if (opts.line) source = `^(?:${source})$`;
  let flags = '';
  if (opts.insensitive) flags += 'i';
  if (opts.global) flags += 'g';
  return new RegExp(source, flags);
}

/* ================================================================== *
 * interactive pager (shared by less and more)
 * ================================================================== */

/**
 * Attach a key source. Prefers the terminal's own hook, falls back to a
 * capture-phase document listener so the readline layer never sees the keys.
 * @param {object} ctx
 * @param {(key: string) => void} handler
 * @returns {(() => void)|null} detach function, or null when no source exists
 */
function attachKeys(ctx, handler) {
  const t = ctx && ctx.term;
  if (t && typeof t.onKey === 'function') {
    const off = t.onKey((ev) => handler(typeof ev === 'string' ? ev : ev && ev.key));
    if (typeof off === 'function') return off;
    if (typeof t.offKey === 'function') return () => t.offKey(handler);
    return () => {};
  }
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return null;
  const listener = (ev) => {
    if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta') return;
    ev.preventDefault();
    ev.stopPropagation();
    handler(ev.ctrlKey && ev.key === 'c' ? 'q' : ev.key);
  };
  document.addEventListener('keydown', listener, true);
  return () => document.removeEventListener('keydown', listener, true);
}

/**
 * Page `text` through the terminal.
 * @param {object} ctx
 * @param {string} text
 * @param {'less'|'more'} mode
 * @param {string} label file name shown by `more`
 */
async function pageThrough(ctx, text, mode, label) {
  const t = ctx && ctx.term;
  if (!t || typeof t.write !== 'function' || !isTTY(ctx)) return ok(text);

  const { lines } = splitLines(text);
  const height = Math.max(2, termRows(ctx) - 1);
  if (lines.length === 0) return ok('');

  let pending = null;
  const detach = attachKeys(ctx, (key) => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(key);
    }
  });
  if (!detach) return ok(text);

  const nextKey = () =>
    new Promise((resolve) => {
      pending = resolve;
      if (ctx.signal) {
        if (ctx.signal.aborted) resolve('q');
        else ctx.signal.addEventListener('abort', () => resolve('q'), { once: true });
      }
    });

  let drawn = 0;
  const draw = (count) => {
    const from = drawn;
    const to = Math.min(lines.length, drawn + count);
    if (to > from) t.write(`${lines.slice(from, to).join('\n')}\n`);
    drawn = to;
  };
  const redraw = (from, count) => {
    drawn = Math.max(0, from);
    draw(count);
  };

  try {
    draw(height);
    for (;;) {
      const atEnd = drawn >= lines.length;
      if (mode === 'more' && atEnd) break;
      const percent = Math.floor((drawn / lines.length) * 100);
      t.write(mode === 'more' ? `--More--(${percent}%)` : atEnd ? '(END)' : ':');
      const key = await nextKey();
      t.write('\n');
      if (key === 'q' || key === 'Q' || key === 'Escape') break;
      if (key === ' ' || key === 'PageDown' || key === 'f') {
        if (atEnd) break;
        draw(height);
      } else if (key === 'Enter' || key === 'j' || key === 'ArrowDown') {
        if (atEnd) {
          if (mode === 'more') break;
        } else {
          draw(1);
        }
      } else if (key === 'b' || key === 'PageUp') {
        redraw(drawn - height * 2, height);
      } else if (key === 'k' || key === 'ArrowUp') {
        redraw(drawn - height - 1, height);
      } else if (key === 'g' || key === 'Home') {
        redraw(0, height);
      } else if (key === 'G' || key === 'End') {
        draw(lines.length);
      } else if (key === 'h') {
        t.write(
          mode === 'less'
            ? 'SPACE  forward one window   b  back one window\nj / k  forward / back one line\ng / G  start / end          q  quit\n'
            : 'SPACE  next page   Enter  next line   q  quit\n',
        );
      }
    }
  } finally {
    detach();
  }
  if (mode === 'more' && label) return ok('');
  return ok('');
}

/* ================================================================== *
 * echo / printf
 * ================================================================== */

const echo = {
  name: 'echo',
  aliases: [],
  synopsis: 'echo [SHORT-OPTION]... [STRING]...',
  description: 'Display a line of text',
  man: `NAME
       echo - display a line of text

SYNOPSIS
       echo [SHORT-OPTION]... [STRING]...

DESCRIPTION
       Echo the STRING(s) to standard output.

       -n     do not output the trailing newline
       -e     enable interpretation of backslash escapes
       -E     disable interpretation of backslash escapes (default)`,

  async run(ctx) {
    const argv = ctx.argv.slice();
    let noNewline = false;
    let escapes = false;
    while (argv.length > 0 && /^-[neE]+$/.test(argv[0])) {
      for (const ch of argv[0].slice(1)) {
        if (ch === 'n') noNewline = true;
        else if (ch === 'e') escapes = true;
        else if (ch === 'E') escapes = false;
      }
      argv.shift();
    }
    let text = argv.join(' ');
    if (escapes) {
      const cut = text.indexOf('\\c');
      if (cut >= 0) return ok(unescape(text.slice(0, cut)));
      text = unescape(text);
    }
    return ok(noNewline ? text : `${text}\n`);
  },
};

const PRINTF_SPEC = /^%([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*))?([diouxXfFeEgGcsb%])/;

function formatOne(flags, width, precision, conv, arg, errors) {
  const leftAlign = flags.indexOf('-') >= 0;
  const zeroPad = flags.indexOf('0') >= 0 && !leftAlign;
  const plus = flags.indexOf('+') >= 0;
  const space = flags.indexOf(' ') >= 0;
  const alt = flags.indexOf('#') >= 0;
  let body = '';

  const numeric = (raw) => {
    const s = String(raw === undefined ? '' : raw).trim();
    if (s === '') return 0;
    if (/^'/.test(s)) return s.charCodeAt(1) || 0;
    const n = Number(s);
    if (!Number.isFinite(n)) {
      errors.push(`printf: '${raw}': expected a numeric value\n`);
      return 0;
    }
    return n;
  };

  switch (conv) {
    case 'd':
    case 'i': {
      const n = Math.trunc(numeric(arg));
      body = String(Math.abs(n));
      if (precision !== null) body = padLeft(body, precision).replace(/ /g, '0');
      body = (n < 0 ? '-' : plus ? '+' : space ? ' ' : '') + body;
      break;
    }
    case 'u': {
      const n = Math.trunc(numeric(arg));
      body = String(n < 0 ? n >>> 0 : n);
      break;
    }
    case 'o': {
      const n = Math.trunc(numeric(arg));
      body = (alt ? '0' : '') + Math.abs(n).toString(8);
      break;
    }
    case 'x':
    case 'X': {
      const n = Math.trunc(numeric(arg));
      body = Math.abs(n).toString(16);
      if (conv === 'X') body = body.toUpperCase();
      if (alt && n !== 0) body = (conv === 'X' ? '0X' : '0x') + body;
      break;
    }
    case 'f':
    case 'F': {
      const n = numeric(arg);
      body = Math.abs(n).toFixed(precision === null ? 6 : precision);
      body = (n < 0 ? '-' : plus ? '+' : space ? ' ' : '') + body;
      break;
    }
    case 'e':
    case 'E': {
      const n = numeric(arg);
      body = n.toExponential(precision === null ? 6 : precision);
      if (conv === 'E') body = body.toUpperCase();
      break;
    }
    case 'g':
    case 'G': {
      const n = numeric(arg);
      body = String(Number(n.toPrecision(precision === null ? 6 : Math.max(1, precision))));
      if (conv === 'G') body = body.toUpperCase();
      break;
    }
    case 'c':
      body = String(arg === undefined ? '' : arg).slice(0, 1);
      break;
    case 'b':
      body = unescape(String(arg === undefined ? '' : arg));
      break;
    case 's':
    default:
      body = String(arg === undefined ? '' : arg);
      if (precision !== null) body = body.slice(0, precision);
      break;
  }

  if (width !== null && body.length < width) {
    if (leftAlign) return padRight(body, width);
    if (zeroPad && 'dioxXufFeEgG'.indexOf(conv) >= 0) {
      const sign = /^[-+ ]/.test(body) ? body[0] : '';
      const rest = sign ? body.slice(1) : body;
      return sign + '0'.repeat(width - body.length) + rest;
    }
    return padLeft(body, width);
  }
  return body;
}

const printf = {
  name: 'printf',
  aliases: [],
  synopsis: 'printf FORMAT [ARGUMENT]...',
  description: 'Format and print data',
  man: `NAME
       printf - format and print data

SYNOPSIS
       printf FORMAT [ARGUMENT]...

DESCRIPTION
       Print ARGUMENT(s) according to FORMAT. FORMAT controls the output as in
       C printf and supports the conversions diouxXfeEgGcsb and %%, the flags
       -+ #0, a field width and a precision. Backslash escapes \\n \\t \\\\ \\a
       \\b \\f \\r \\v \\0NNN and \\xHH are interpreted in FORMAT.

       The FORMAT string is reused as necessary to consume all ARGUMENTs.`,

  async run(ctx) {
    if (ctx.argv.length === 0) {
      return {
        stdout: '',
        stderr: "printf: usage: printf [-v var] format [arguments]\n",
        code: 2,
      };
    }
    const format = ctx.argv[0];
    const args = ctx.argv.slice(1);
    const errors = [];
    let out = '';
    let argIndex = 0;
    let consumedAny = false;
    let stop = false;

    const runOnce = () => {
      let i = 0;
      while (i < format.length) {
        const ch = format[i];
        if (ch === '\\') {
          const chunk = format.slice(i, i + 5);
          const decoded = unescape(chunk);
          /* Re-scan a single escape sequence to know how many chars it ate. */
          let len = 2;
          if (/^\\0[0-7]{1,3}/.test(chunk)) len = /^\\0[0-7]{1,3}/.exec(chunk)[0].length;
          else if (/^\\x[0-9A-Fa-f]{1,2}/.test(chunk)) len = /^\\x[0-9A-Fa-f]{1,2}/.exec(chunk)[0].length;
          if (format.slice(i, i + 2) === '\\c') {
            stop = true;
            return;
          }
          out += unescape(format.slice(i, i + len));
          void decoded;
          i += len;
          continue;
        }
        if (ch === '%') {
          const m = PRINTF_SPEC.exec(format.slice(i));
          if (!m) {
            out += ch;
            i += 1;
            continue;
          }
          if (m[4] === '%') {
            out += '%';
            i += m[0].length;
            continue;
          }
          let width = m[2] === undefined ? null : m[2] === '*' ? Math.trunc(Number(args[argIndex++]) || 0) : Number(m[2]);
          let precision = m[3] === undefined ? null : m[3] === '*' ? Math.trunc(Number(args[argIndex++]) || 0) : Number(m[3]);
          const arg = args[argIndex];
          argIndex += 1;
          consumedAny = true;
          out += formatOne(m[1], width, precision, m[4], arg, errors);
          i += m[0].length;
          continue;
        }
        out += ch;
        i += 1;
      }
    };

    runOnce();
    while (!stop && consumedAny && argIndex < args.length) {
      const before = argIndex;
      runOnce();
      if (argIndex === before) break;
    }

    return { stdout: out, stderr: errors.join(''), code: errors.length ? 1 : 0 };
  },
};

/* ================================================================== *
 * grep / egrep / fgrep
 * ================================================================== */

function grepFormatLine(opts, name, lineNo, sep, text) {
  let prefix = '';
  if (opts.showName) {
    prefix += opts.color ? `${GC_FILE}${name}${RESET}${GC_SEP}${sep}${RESET}` : `${name}${sep}`;
  }
  if (opts.number) {
    prefix += opts.color ? `${GC_LINE}${lineNo}${RESET}${GC_SEP}${sep}${RESET}` : `${lineNo}${sep}`;
  }
  return `${prefix}${text}\n`;
}

function grepHighlight(line, regexes, color) {
  if (!color) return line;
  const spans = [];
  for (const re of regexes) {
    const g = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : `${re.flags}g`);
    let m = g.exec(line);
    while (m !== null) {
      if (m[0] !== '') spans.push([m.index, m.index + m[0].length]);
      if (m.index === g.lastIndex) g.lastIndex += 1;
      m = g.exec(line);
    }
  }
  if (spans.length === 0) return line;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span.slice());
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += line.slice(pos, s) + GC_MATCH + line.slice(s, e) + RESET;
    pos = e;
  }
  return out + line.slice(pos);
}

async function grepRun(ctx, defaults) {
  const p = optParse(ctx.argv, 'eAB Cfm'.replace(' ', ''));
  const f = p.flags;
  const L = p.longs;

  const colorWhen = L.color === undefined ? (L.colour === undefined ? 'never' : L.colour) : L.color;
  const opts = {
    insensitive: f.has('i') || f.has('y') || L['ignore-case'] === true,
    invert: f.has('v') || L['invert-match'] === true,
    number: f.has('n') || L['line-number'] === true,
    count: f.has('c') || L.count === true,
    filesWithMatches: f.has('l') || L['files-with-matches'] === true,
    filesWithout: f.has('L') || L['files-without-match'] === true,
    recursive: f.has('r') || f.has('R') || L.recursive === true,
    extended: defaults.extended || f.has('E') || L['extended-regexp'] === true,
    fixed: defaults.fixed || f.has('F') || L['fixed-strings'] === true,
    word: f.has('w') || L['word-regexp'] === true,
    line: f.has('x') || L['line-regexp'] === true,
    onlyMatching: f.has('o') || L['only-matching'] === true,
    quiet: f.has('q') || L.quiet === true || L.silent === true,
    noMessages: f.has('s') || L['no-messages'] === true,
    forceName: f.has('H') || L['with-filename'] === true,
    noName: f.has('h') || L['no-filename'] === true,
    color: colorWhen === true || colorWhen === 'always' || colorWhen === 'auto' ? (colorWhen === 'auto' ? isTTY(ctx) : true) : false,
    showName: false,
  };

  let after = 0;
  let before = 0;
  if (p.values.A !== undefined) after = Number(p.values.A) || 0;
  if (p.values.B !== undefined) before = Number(p.values.B) || 0;
  if (p.values.C !== undefined) {
    after = Number(p.values.C) || 0;
    before = after;
  }
  if (typeof L.after === 'string') after = Number(L.after) || 0;
  if (typeof L.before === 'string') before = Number(L.before) || 0;
  if (typeof L.context === 'string') {
    after = Number(L.context) || 0;
    before = after;
  }
  const maxCount = p.values.m !== undefined ? Number(p.values.m) : Infinity;

  const patterns = [];
  if (p.values.e !== undefined) patterns.push(...String(p.values.e).split('\n'));
  if (typeof L.regexp === 'string') patterns.push(...L.regexp.split('\n'));
  if (typeof L.file === 'string' || p.values.f !== undefined) {
    const fname = typeof L.file === 'string' ? L.file : p.values.f;
    try {
      patterns.push(...ctx.fs.readFile(abs(ctx, fname)).replace(/\n$/, '').split('\n'));
    } catch (err) {
      return { stdout: '', stderr: `grep: ${fname}: ${phrase(err)}\n`, code: 2 };
    }
  }

  const operands = p.operands.slice();
  if (patterns.length === 0) {
    if (operands.length === 0) {
      return {
        stdout: '',
        stderr: `Usage: ${defaults.name} [OPTION]... PATTERNS [FILE]...\nTry '${defaults.name} --help' for more information.\n`,
        code: 2,
      };
    }
    patterns.push(...operands.shift().split('\n'));
  }

  let regexes;
  try {
    regexes = patterns.map((pat) =>
      buildRegExp(pat, {
        extended: opts.extended,
        fixed: opts.fixed,
        word: opts.word,
        line: opts.line,
        insensitive: opts.insensitive,
      }),
    );
  } catch (err) {
    return { stdout: '', stderr: `grep: ${err && err.message ? err.message : 'invalid regular expression'}\n`, code: 2 };
  }

  /* Expand recursive directory operands. */
  const targets = [];
  const errors = [];
  let code = 1;

  const pushFile = (name) => targets.push(name);
  const walkDir = (display, absPath) => {
    let names;
    try {
      names = ctx.fs.readdir(absPath);
    } catch (err) {
      if (!opts.noMessages) errors.push(`grep: ${display}: ${phrase(err)}\n`);
      code = 2;
      return;
    }
    for (const name of names) {
      const childDisplay = display === '/' ? `/${name}` : `${display}/${name}`;
      const childAbs = absPath === '/' ? `/${name}` : `${absPath}/${name}`;
      if (ctx.fs.isDir(childAbs)) walkDir(childDisplay, childAbs);
      else pushFile(childDisplay);
    }
  };

  if (operands.length === 0) {
    if (opts.recursive) walkDir('.', abs(ctx, '.'));
    else targets.push('-');
  } else {
    for (const name of operands) {
      const target = abs(ctx, name);
      if (opts.recursive && ctx.fs.isDir(target)) walkDir(name.replace(/\/+$/, '') || name, target);
      else if (ctx.fs.isDir(target)) {
        if (!opts.noMessages) errors.push(`grep: ${name}: Is a directory\n`);
      } else targets.push(name);
    }
  }

  opts.showName = opts.forceName || (!opts.noName && (targets.length > 1 || (opts.recursive && operands.length !== 1)));
  if (opts.noName) opts.showName = false;

  const out = [];

  for (const name of targets) {
    let text;
    if (name === '-') {
      text = ctx.stdin || '';
    } else {
      try {
        text = ctx.fs.readFile(abs(ctx, name));
      } catch (err) {
        if (!opts.noMessages) errors.push(`grep: ${name}: ${phrase(err)}\n`);
        code = 2;
        continue;
      }
    }

    const { lines } = splitLines(text);
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      const matched = regexes.some((re) => re.test(lines[i]));
      if (matched !== opts.invert) hits.push(i);
      if (hits.length >= maxCount) break;
    }

    if (hits.length > 0 && code !== 2) code = 0;
    if (opts.quiet) {
      if (hits.length > 0) return { stdout: '', stderr: '', code: 0 };
      continue;
    }
    if (opts.filesWithMatches) {
      if (hits.length > 0) out.push(opts.color ? `${GC_FILE}${name}${RESET}\n` : `${name}\n`);
      continue;
    }
    if (opts.filesWithout) {
      if (hits.length === 0) out.push(`${name}\n`);
      continue;
    }
    if (opts.count) {
      out.push(grepFormatLine(opts, name, '', ':', String(hits.length)));
      continue;
    }

    if (opts.onlyMatching) {
      for (const idx of hits) {
        for (const re of regexes) {
          const g = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : `${re.flags}g`);
          let m = g.exec(lines[idx]);
          while (m !== null) {
            if (m[0] !== '') {
              out.push(grepFormatLine(opts, name, idx + 1, ':', opts.color ? GC_MATCH + m[0] + RESET : m[0]));
            }
            if (m.index === g.lastIndex) g.lastIndex += 1;
            m = g.exec(lines[idx]);
          }
        }
      }
      continue;
    }

    /* Build the printable set including context. */
    const wanted = new Map();
    for (const idx of hits) {
      wanted.set(idx, true);
      for (let k = 1; k <= before; k += 1) if (idx - k >= 0 && !wanted.has(idx - k)) wanted.set(idx - k, false);
      for (let k = 1; k <= after; k += 1) if (idx + k < lines.length && !wanted.has(idx + k)) wanted.set(idx + k, false);
    }
    for (const idx of hits) wanted.set(idx, true);

    const indices = Array.from(wanted.keys()).sort((a, b) => a - b);
    let previous = -2;
    for (const idx of indices) {
      if ((before > 0 || after > 0) && previous >= 0 && idx > previous + 1) out.push('--\n');
      const isMatch = wanted.get(idx);
      const body = isMatch && !opts.invert ? grepHighlight(lines[idx], regexes, opts.color) : lines[idx];
      out.push(grepFormatLine(opts, name, idx + 1, isMatch ? ':' : '-', body));
      previous = idx;
    }
  }

  return result(out, errors, code);
}

const grep = {
  name: 'grep',
  aliases: [],
  synopsis: 'grep [OPTION]... PATTERNS [FILE]...',
  description: 'Print lines that match patterns',
  man: `NAME
       grep - print lines that match patterns

SYNOPSIS
       grep [OPTION]... PATTERNS [FILE]...

DESCRIPTION
       Search for PATTERNS in each FILE. PATTERNS is one or more patterns
       separated by newline characters.

       -E, --extended-regexp     PATTERNS are extended regular expressions
       -F, --fixed-strings       PATTERNS are strings
       -i, --ignore-case         ignore case distinctions
       -v, --invert-match        select non-matching lines
       -w, --word-regexp         match only whole words
       -x, --line-regexp         match only whole lines
       -c, --count               print only a count of selected lines per FILE
       -l, --files-with-matches  print only names of FILEs with selected lines
       -L, --files-without-match print only names of FILEs with no selected lines
       -n, --line-number         print line number with output lines
       -o, --only-matching       show only nonempty parts of lines that match
       -q, --quiet, --silent     suppress all normal output
       -r, --recursive           read all files under each directory
       -A NUM                    print NUM lines of trailing context
       -B NUM                    print NUM lines of leading context
       -C NUM                    print NUM lines of output context
           --color[=WHEN]        use markers to highlight the matching strings

EXIT STATUS
       0 if a line is selected, 1 if no lines were selected, 2 if an error
       occurred.`,
  run(ctx) {
    return grepRun(ctx, { name: 'grep', extended: false, fixed: false });
  },
};

const egrep = {
  name: 'egrep',
  aliases: [],
  synopsis: 'egrep [OPTION]... PATTERNS [FILE]...',
  description: 'Print lines that match extended regular expressions',
  man: `NAME
       egrep - print lines matching extended regular expressions

SYNOPSIS
       egrep [OPTION]... PATTERNS [FILE]...

DESCRIPTION
       Equivalent to grep -E. See grep(1) for the full option list.`,
  run(ctx) {
    return grepRun(ctx, { name: 'egrep', extended: true, fixed: false });
  },
};

const fgrep = {
  name: 'fgrep',
  aliases: [],
  synopsis: 'fgrep [OPTION]... PATTERNS [FILE]...',
  description: 'Print lines that match fixed strings',
  man: `NAME
       fgrep - print lines matching fixed strings

SYNOPSIS
       fgrep [OPTION]... PATTERNS [FILE]...

DESCRIPTION
       Equivalent to grep -F. See grep(1) for the full option list.`,
  run(ctx) {
    return grepRun(ctx, { name: 'fgrep', extended: false, fixed: true });
  },
};

/* ================================================================== *
 * sed
 * ================================================================== */

/** Read a delimited section starting after `start`, honouring backslash escapes. */
function readDelimited(script, start, delim) {
  let out = '';
  let i = start;
  while (i < script.length) {
    const ch = script[i];
    if (ch === '\\' && i + 1 < script.length) {
      if (script[i + 1] === delim) {
        out += delim;
        i += 2;
        continue;
      }
      out += ch + script[i + 1];
      i += 2;
      continue;
    }
    if (ch === delim) return { text: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  return { text: out, next: -1 };
}

function parseAddress(script, i, extended) {
  const ch = script[i];
  if (ch === '$') return { addr: { type: 'last' }, next: i + 1 };
  if (/[0-9]/.test(ch)) {
    let digits = '';
    while (i < script.length && /[0-9]/.test(script[i])) {
      digits += script[i];
      i += 1;
    }
    return { addr: { type: 'line', value: Number(digits) }, next: i };
  }
  if (ch === '/' || ch === '\\') {
    let delim = '/';
    let start = i + 1;
    if (ch === '\\') {
      delim = script[i + 1];
      start = i + 2;
    }
    const section = readDelimited(script, start, delim);
    if (section.next < 0) return { addr: null, next: i };
    let next = section.next;
    let insensitive = false;
    while (script[next] === 'I' || script[next] === 'M') {
      if (script[next] === 'I') insensitive = true;
      next += 1;
    }
    return {
      addr: { type: 'regex', re: buildRegExp(section.text, { extended, insensitive }) },
      next,
    };
  }
  return { addr: null, next: i };
}

/**
 * Parse a sed script into command descriptors.
 * @returns {{cmds: object[], error: string|null}}
 */
function parseSedScript(script, extended) {
  const cmds = [];
  let i = 0;
  while (i < script.length) {
    while (i < script.length && (script[i] === ';' || script[i] === '\n' || script[i] === ' ' || script[i] === '\t')) i += 1;
    if (i >= script.length) break;
    if (script[i] === '#') {
      while (i < script.length && script[i] !== '\n') i += 1;
      continue;
    }

    let addr1 = null;
    let addr2 = null;
    const first = parseAddress(script, i, extended);
    if (first.addr) {
      addr1 = first.addr;
      i = first.next;
      if (script[i] === ',') {
        const second = parseAddress(script, i + 1, extended);
        if (!second.addr) return { cmds, error: 'unexpected `,\'' };
        addr2 = second.addr;
        i = second.next;
      }
    }

    let negate = false;
    while (script[i] === '!' || script[i] === ' ') {
      if (script[i] === '!') negate = true;
      i += 1;
    }

    const letter = script[i];
    i += 1;
    const cmd = { addr1, addr2, negate, type: letter, active: false };

    if (letter === 's') {
      const delim = script[i];
      if (delim === undefined) return { cmds, error: 'unterminated `s\' command' };
      const pattern = readDelimited(script, i + 1, delim);
      if (pattern.next < 0) return { cmds, error: 'unterminated `s\' command' };
      const replacement = readDelimited(script, pattern.next, delim);
      if (replacement.next < 0) return { cmds, error: 'unterminated `s\' command' };
      i = replacement.next;
      let flags = '';
      while (i < script.length && /[gGiIpmMe0-9]/.test(script[i])) {
        flags += script[i];
        i += 1;
      }
      const occurrence = /[0-9]+/.exec(flags);
      cmd.global = flags.indexOf('g') >= 0;
      cmd.print = flags.indexOf('p') >= 0;
      cmd.occurrence = occurrence ? Number(occurrence[0]) : 1;
      try {
        cmd.re = buildRegExp(pattern.text, {
          extended,
          insensitive: flags.indexOf('i') >= 0 || flags.indexOf('I') >= 0,
          global: true,
        });
      } catch (err) {
        return { cmds, error: err && err.message ? err.message : 'invalid regular expression' };
      }
      cmd.replacement = replacement.text;
    } else if (letter === 'y') {
      const delim = script[i];
      const from = readDelimited(script, i + 1, delim);
      const to = readDelimited(script, from.next, delim);
      if (from.next < 0 || to.next < 0) return { cmds, error: 'unterminated `y\' command' };
      if (from.text.length !== to.text.length) {
        return { cmds, error: 'strings for `y\' command are different lengths' };
      }
      cmd.from = from.text;
      cmd.to = to.text;
      i = to.next;
    } else if (letter === 'q' || letter === 'Q') {
      while (i < script.length && /[0-9 ]/.test(script[i])) i += 1;
    } else if (letter === 'a' || letter === 'i' || letter === 'c') {
      while (script[i] === ' ' || script[i] === '\\') i += 1;
      let text = '';
      while (i < script.length && script[i] !== '\n' && script[i] !== ';') {
        text += script[i];
        i += 1;
      }
      cmd.text = text;
    } else if (letter === undefined) {
      break;
    } else if ('dpPnN=blhHgGxrwtT{}'.indexOf(letter) < 0) {
      return { cmds, error: `unknown command: \`${letter}'` };
    }
    cmds.push(cmd);
  }
  return { cmds, error: null };
}

/** Expand `&`, `\1`..`\9` and escapes in a sed replacement. */
function sedReplacement(replacement, match) {
  let out = '';
  for (let i = 0; i < replacement.length; i += 1) {
    const ch = replacement[i];
    if (ch === '\\' && i + 1 < replacement.length) {
      i += 1;
      const nx = replacement[i];
      if (/[1-9]/.test(nx)) {
        const group = match[Number(nx)];
        out += group === undefined ? '' : group;
      } else if (nx === 'n') out += '\n';
      else if (nx === 't') out += '\t';
      else if (nx === 'r') out += '\r';
      else if (nx === '&') out += '&';
      else if (nx === '\\') out += '\\';
      else out += nx;
      continue;
    }
    if (ch === '&') {
      out += match[0];
      continue;
    }
    out += ch;
  }
  return out;
}

function sedSubstitute(line, cmd) {
  const re = new RegExp(cmd.re.source, cmd.re.flags.indexOf('g') >= 0 ? cmd.re.flags : `${cmd.re.flags}g`);
  let out = '';
  let last = 0;
  let count = 0;
  let changed = false;
  let m = re.exec(line);
  while (m !== null) {
    count += 1;
    const eligible = cmd.global ? count >= cmd.occurrence : count === cmd.occurrence;
    if (eligible) {
      out += line.slice(last, m.index) + sedReplacement(cmd.replacement, m);
      last = m.index + m[0].length;
      changed = true;
    }
    if (m[0] === '') {
      if (re.lastIndex >= line.length) break;
      re.lastIndex += 1;
    }
    if (!cmd.global && count >= cmd.occurrence) break;
    m = re.exec(line);
  }
  return { text: out + line.slice(last), changed };
}

const sed = {
  name: 'sed',
  aliases: [],
  synopsis: 'sed [OPTION]... {script} [input-file]...',
  description: 'Stream editor for filtering and transforming text',
  man: `NAME
       sed - stream editor for filtering and transforming text

SYNOPSIS
       sed [OPTION]... {script-only-if-no-other-script} [input-file]...

DESCRIPTION
       sed copies the input to standard output, applying the script to each
       line. Supported commands: s (with the g, i, p and numeric flags),
       d, p, q, y and =. Addresses may be a line number, $ for the last line,
       a /regexp/ match, or a N,M range; a trailing ! negates them.

       -n, --quiet, --silent    suppress automatic printing of pattern space
       -e script                add the script to the commands to be executed
       -f script-file           add the contents of script-file to the commands
       -i[SUFFIX], --in-place   edit files in place
       -E, -r                   use extended regular expressions
       -s, --separate           consider files as separate rather than as a
                                single continuous stream`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'ef');
    const quiet = p.flags.has('n') || p.longs.quiet === true || p.longs.silent === true;
    const extended = p.flags.has('E') || p.flags.has('r') || p.longs['regexp-extended'] === true;
    const inPlace = p.flags.has('i') || p.longs['in-place'] !== undefined;
    const separate = p.flags.has('s') || p.longs.separate === true || inPlace;

    let script = '';
    if (p.values.e !== undefined) script = p.values.e;
    else if (typeof p.longs.expression === 'string') script = p.longs.expression;
    if (p.values.f !== undefined || typeof p.longs.file === 'string') {
      const fname = p.values.f !== undefined ? p.values.f : p.longs.file;
      try {
        script += (script ? '\n' : '') + ctx.fs.readFile(abs(ctx, fname));
      } catch (err) {
        return { stdout: '', stderr: `sed: couldn't open file ${fname}: ${phrase(err)}\n`, code: 1 };
      }
    }

    const operands = p.operands.slice();
    if (script === '') {
      if (operands.length === 0) {
        return {
          stdout: '',
          stderr: 'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n',
          code: 1,
        };
      }
      script = operands.shift();
    }

    const parsed = parseSedScript(script, extended);
    if (parsed.error) {
      return { stdout: '', stderr: `sed: -e expression #1, char ${script.length}: ${parsed.error}\n`, code: 1 };
    }
    const cmds = parsed.cmds;

    const read = readInputs(ctx, operands, 'sed');
    const out = [];
    let code = read.code;

    const groups = separate || read.items.length <= 1
      ? read.items.map((item) => [item])
      : [read.items];

    for (const group of groups) {
      const text = group.map((item) => item.text).join('');
      const { lines, trailing } = splitLines(text);
      const produced = [];
      for (const cmd of cmds) cmd.active = false;

      let quit = false;
      for (let index = 0; index < lines.length && !quit; index += 1) {
        let pattern = lines[index];
        const lineNo = index + 1;
        const isLast = index === lines.length - 1;
        let deleted = false;

        const addrHit = (addr) => {
          if (!addr) return true;
          if (addr.type === 'line') return addr.value === lineNo;
          if (addr.type === 'last') return isLast;
          return addr.re.test(pattern);
        };

        for (const cmd of cmds) {
          let selected;
          if (cmd.addr2) {
            if (!cmd.active) {
              if (addrHit(cmd.addr1)) {
                cmd.active = true;
                selected = true;
                if (cmd.addr2.type === 'line' && cmd.addr2.value <= lineNo) cmd.active = false;
              } else {
                selected = false;
              }
            } else {
              selected = true;
              if (addrHit(cmd.addr2)) cmd.active = false;
            }
          } else {
            selected = addrHit(cmd.addr1);
          }
          if (cmd.negate) selected = !selected;
          if (!selected) continue;

          if (cmd.type === 's') {
            const sub = sedSubstitute(pattern, cmd);
            pattern = sub.text;
            if (sub.changed && cmd.print) produced.push(pattern);
          } else if (cmd.type === 'd') {
            deleted = true;
            break;
          } else if (cmd.type === 'p') {
            produced.push(pattern);
          } else if (cmd.type === 'P') {
            produced.push(pattern.split('\n')[0]);
          } else if (cmd.type === '=') {
            produced.push(String(lineNo));
          } else if (cmd.type === 'y') {
            let mapped = '';
            for (const ch of pattern) {
              const at = cmd.from.indexOf(ch);
              mapped += at < 0 ? ch : cmd.to[at];
            }
            pattern = mapped;
          } else if (cmd.type === 'i') {
            produced.push(cmd.text);
          } else if (cmd.type === 'a') {
            if (!quiet) produced.push(pattern);
            produced.push(cmd.text);
            deleted = true;
            break;
          } else if (cmd.type === 'c') {
            produced.push(cmd.text);
            deleted = true;
            break;
          } else if (cmd.type === 'q' || cmd.type === 'Q') {
            if (!quiet && cmd.type === 'q') produced.push(pattern);
            deleted = true;
            quit = true;
            break;
          }
        }
        if (!deleted && !quiet) produced.push(pattern);
      }

      const rendered = joinLines(produced, produced.length ? trailing || true : true);
      if (inPlace && group.length === 1 && group[0].name !== '-') {
        try {
          ctx.fs.writeFile(abs(ctx, group[0].name), rendered);
        } catch (err) {
          read.errors.push(`sed: couldn't write ${group[0].name}: ${phrase(err)}\n`);
          code = 4;
        }
      } else {
        out.push(rendered);
      }
    }

    return { stdout: out.join(''), stderr: read.errors.join(''), code };
  },
};

/* ================================================================== *
 * sort
 * ================================================================== */

function parseHumanNumber(s) {
  const m = /^\s*([+-]?[0-9]*\.?[0-9]+)\s*([KMGTPEZY]?)i?B?/i.exec(s);
  if (!m) return 0;
  const units = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6 };
  return Number(m[1]) * (units[m[2].toUpperCase()] || 1);
}

function parseLeadingNumber(s) {
  const m = /^\s*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** Split a line into sort fields. Without -t, fields keep their leading blanks. */
function sortFields(line, sep) {
  if (sep !== null) return line.split(sep);
  const fields = line.match(/[ \t]*[^ \t]+/g);
  return fields === null ? [] : fields;
}

function keyOf(line, key, sep) {
  if (!key) return line;
  const fields = sortFields(line, sep);
  const startField = Math.max(1, key.f1);
  const endField = key.f2 === null ? fields.length : Math.min(key.f2, fields.length);
  if (startField > fields.length) return '';
  let chunk = fields.slice(startField - 1, endField).join(sep === null ? '' : sep);
  if (key.c1 > 1) chunk = chunk.slice(key.c1 - 1);
  if (key.f2 !== null && key.c2 !== null) {
    const before = fields.slice(startField - 1, endField - 1).join(sep === null ? '' : sep).length;
    chunk = chunk.slice(0, before + key.c2 - (key.c1 > 1 ? key.c1 - 1 : 0));
  }
  return chunk;
}

function parseKeyDef(spec) {
  const m = /^(\d+)(?:\.(\d+))?([bdfghinrMV]*)(?:,(\d+)(?:\.(\d+))?([bdfghinrMV]*))?$/.exec(spec);
  if (!m) return null;
  return {
    f1: Number(m[1]),
    c1: m[2] ? Number(m[2]) : 1,
    o1: m[3] || '',
    f2: m[4] ? Number(m[4]) : null,
    c2: m[5] ? Number(m[5]) : null,
    o2: m[6] || '',
  };
}

const sort = {
  name: 'sort',
  aliases: [],
  synopsis: 'sort [OPTION]... [FILE]...',
  description: 'Sort lines of text files',
  man: `NAME
       sort - sort lines of text files

SYNOPSIS
       sort [OPTION]... [FILE]...

DESCRIPTION
       Write sorted concatenation of all FILE(s) to standard output.

       -b, --ignore-leading-blanks  ignore leading blanks
       -f, --ignore-case            fold lower case to upper case characters
       -h, --human-numeric-sort     compare human readable numbers (2K 1G)
       -k, --key=KEYDEF             sort via a key; KEYDEF gives location and type
       -n, --numeric-sort           compare according to string numerical value
       -o, --output=FILE            write result to FILE instead of standard output
       -r, --reverse                reverse the result of comparisons
       -t, --field-separator=SEP    use SEP instead of non-blank to blank transition
       -u, --unique                 output only the first of an equal run`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'kto');
    const numeric = p.flags.has('n') || p.longs['numeric-sort'] === true;
    const human = p.flags.has('h') || p.longs['human-numeric-sort'] === true;
    const reverse = p.flags.has('r') || p.longs.reverse === true;
    const unique = p.flags.has('u') || p.longs.unique === true;
    const fold = p.flags.has('f') || p.longs['ignore-case'] === true;
    const ignoreBlanks = p.flags.has('b') || p.longs['ignore-leading-blanks'] === true;

    let sep = null;
    if (p.values.t !== undefined) sep = unescape(p.values.t);
    else if (typeof p.longs['field-separator'] === 'string') sep = unescape(p.longs['field-separator']);

    const keySpecs = [];
    if (p.values.k !== undefined) keySpecs.push(p.values.k);
    if (typeof p.longs.key === 'string') keySpecs.push(p.longs.key);
    const keys = [];
    for (const spec of keySpecs) {
      const parsed = parseKeyDef(spec);
      if (!parsed) return { stdout: '', stderr: `sort: invalid number at field start: invalid count at start of '${spec}'\n`, code: 2 };
      keys.push(parsed);
    }

    const outFile = p.values.o !== undefined ? p.values.o : typeof p.longs.output === 'string' ? p.longs.output : null;

    const read = readInputs(ctx, p.operands, 'sort');
    const lines = [];
    for (const item of read.items) {
      const split = splitLines(item.text);
      lines.push(...split.lines);
    }

    const prepare = (value, opts) => {
      let v = value;
      if (ignoreBlanks || opts.indexOf('b') >= 0) v = v.replace(/^[ \t]+/, '');
      if (fold || opts.indexOf('f') >= 0) v = v.toUpperCase();
      return v;
    };

    const compareValues = (a, b, opts) => {
      const useNumeric = numeric || opts.indexOf('n') >= 0;
      const useHuman = human || opts.indexOf('h') >= 0;
      if (useNumeric) {
        const d = parseLeadingNumber(a) - parseLeadingNumber(b);
        if (d !== 0) return d < 0 ? -1 : 1;
        return 0;
      }
      if (useHuman) {
        const d = parseHumanNumber(a) - parseHumanNumber(b);
        if (d !== 0) return d < 0 ? -1 : 1;
        return 0;
      }
      return collate(a, b);
    };

    const compare = (a, b) => {
      if (keys.length) {
        for (const key of keys) {
          const opts = key.o1 + key.o2;
          const va = prepare(keyOf(a, key, sep), opts);
          const vb = prepare(keyOf(b, key, sep), opts);
          let d = compareValues(va, vb, opts);
          if (opts.indexOf('r') >= 0) d = -d;
          if (d !== 0) return d;
        }
        return compareValues(prepare(a, ''), prepare(b, ''), '');
      }
      return compareValues(prepare(a, ''), prepare(b, ''), '');
    };

    const sorted = lines.slice().sort(compare);
    if (reverse) sorted.reverse();

    const final = [];
    for (const line of sorted) {
      if (unique && final.length > 0 && compare(final[final.length - 1], line) === 0) continue;
      final.push(line);
    }

    const text = joinLines(final);
    if (outFile) {
      try {
        ctx.fs.writeFile(abs(ctx, outFile), text);
      } catch (err) {
        return { stdout: '', stderr: `sort: open failed: ${outFile}: ${phrase(err)}\n`, code: 2 };
      }
      return { stdout: '', stderr: read.errors.join(''), code: read.code };
    }
    return { stdout: text, stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * uniq
 * ================================================================== */

const uniq = {
  name: 'uniq',
  aliases: [],
  synopsis: 'uniq [OPTION]... [INPUT [OUTPUT]]',
  description: 'Report or omit repeated lines',
  man: `NAME
       uniq - report or omit repeated lines

SYNOPSIS
       uniq [OPTION]... [INPUT [OUTPUT]]

DESCRIPTION
       Filter adjacent matching lines from INPUT, writing to OUTPUT. Note that
       uniq does not detect repeated lines unless they are adjacent; sort the
       input first.

       -c, --count           prefix lines by the number of occurrences
       -d, --repeated        only print duplicate lines, one for each group
       -D                    print all duplicate lines
       -f, --skip-fields=N   avoid comparing the first N fields
       -i, --ignore-case     ignore differences in case when comparing
       -s, --skip-chars=N    avoid comparing the first N characters
       -u, --unique          only print unique lines`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'fsw');
    const showCount = p.flags.has('c') || p.longs.count === true;
    const onlyDup = p.flags.has('d') || p.longs.repeated === true;
    const allDup = p.flags.has('D');
    const onlyUnique = p.flags.has('u') || p.longs.unique === true;
    const insensitive = p.flags.has('i') || p.longs['ignore-case'] === true;
    const skipFields = Number(p.values.f !== undefined ? p.values.f : p.longs['skip-fields']) || 0;
    const skipChars = Number(p.values.s !== undefined ? p.values.s : p.longs['skip-chars']) || 0;

    const operands = p.operands.slice();
    const outFile = operands.length > 1 ? operands[1] : null;
    const read = readInputs(ctx, operands.slice(0, 1), 'uniq');
    const { lines, trailing } = splitLines(read.items.map((i) => i.text).join(''));

    const keyFor = (line) => {
      let v = line;
      if (skipFields > 0) {
        const fields = v.match(/[ \t]*[^ \t]+/g) || [];
        v = fields.slice(skipFields).join('');
      }
      if (skipChars > 0) v = v.slice(skipChars);
      return insensitive ? v.toLowerCase() : v;
    };

    const groups = [];
    for (const line of lines) {
      const key = keyFor(line);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.members.push(line);
      else groups.push({ key, members: [line] });
    }

    const out = [];
    for (const group of groups) {
      const n = group.members.length;
      if (onlyDup && n < 2) continue;
      if (onlyUnique && n > 1) continue;
      if (allDup) {
        if (n < 2) continue;
        for (const member of group.members) out.push(member);
        continue;
      }
      out.push(showCount ? `${padLeft(String(n), 7)} ${group.members[0]}` : group.members[0]);
    }

    const text = joinLines(out, out.length ? trailing || true : true);
    if (outFile) {
      try {
        ctx.fs.writeFile(abs(ctx, outFile), text);
      } catch (err) {
        return { stdout: '', stderr: `uniq: ${outFile}: ${phrase(err)}\n`, code: 1 };
      }
      return { stdout: '', stderr: read.errors.join(''), code: read.code };
    }
    return { stdout: text, stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * cut
 * ================================================================== */

/** Parse `1,3-5,7-` into a membership predicate. */
function parseRanges(spec) {
  const ranges = [];
  for (const part of String(spec).split(',')) {
    if (part === '') continue;
    const m = /^(\d*)(-?)(\d*)$/.exec(part.trim());
    if (!m) return null;
    const lo = m[1] === '' ? 1 : Number(m[1]);
    if (m[2] === '') {
      if (m[1] === '') return null;
      ranges.push([lo, lo]);
    } else {
      ranges.push([lo, m[3] === '' ? Infinity : Number(m[3])]);
    }
  }
  if (ranges.length === 0) return null;
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

const cut = {
  name: 'cut',
  aliases: [],
  synopsis: 'cut OPTION... [FILE]...',
  description: 'Remove sections from each line of files',
  man: `NAME
       cut - remove sections from each line of files

SYNOPSIS
       cut OPTION... [FILE]...

DESCRIPTION
       Print selected parts of lines from each FILE to standard output.

       -b, --bytes=LIST         select only these bytes
       -c, --characters=LIST    select only these characters
       -d, --delimiter=DELIM    use DELIM instead of TAB for field delimiter
       -f, --fields=LIST        select only these fields
       -s, --only-delimited     do not print lines not containing delimiters
           --complement         complement the set of selected bytes/fields
           --output-delimiter=STRING  use STRING as the output delimiter`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'bcfd');
    const complement = p.longs.complement === true;
    const onlyDelimited = p.flags.has('s') || p.longs['only-delimited'] === true;
    const delim = p.values.d !== undefined ? unescape(p.values.d) : typeof p.longs.delimiter === 'string' ? unescape(p.longs.delimiter) : '\t';
    const outDelim = typeof p.longs['output-delimiter'] === 'string' ? unescape(p.longs['output-delimiter']) : delim;

    const listF = p.values.f !== undefined ? p.values.f : p.longs.fields;
    const listC = p.values.c !== undefined ? p.values.c : p.longs.characters;
    const listB = p.values.b !== undefined ? p.values.b : p.longs.bytes;

    let mode = null;
    let spec = null;
    if (typeof listF === 'string') {
      mode = 'f';
      spec = listF;
    } else if (typeof listC === 'string') {
      mode = 'c';
      spec = listC;
    } else if (typeof listB === 'string') {
      mode = 'b';
      spec = listB;
    }
    if (mode === null) {
      return {
        stdout: '',
        stderr: "cut: you must specify a list of bytes, characters, or fields\nTry 'cut --help' for more information.\n",
        code: 1,
      };
    }
    const inRange = parseRanges(spec);
    if (!inRange) {
      return { stdout: '', stderr: `cut: invalid byte, character or field list\n`, code: 1 };
    }
    const selected = (n) => (complement ? !inRange(n) : inRange(n));

    const read = readInputs(ctx, p.operands, 'cut');
    const out = [];
    for (const item of read.items) {
      const { lines, trailing } = splitLines(item.text);
      const rendered = lines.map((line) => {
        if (mode === 'f') {
          if (line.indexOf(delim) < 0) return onlyDelimited ? null : line;
          const fields = line.split(delim);
          const picked = fields.filter((_, idx) => selected(idx + 1));
          return picked.join(outDelim);
        }
        const chars = mode === 'c' ? Array.from(line) : line.split('');
        return chars.filter((_, idx) => selected(idx + 1)).join('');
      });
      out.push(joinLines(rendered.filter((l) => l !== null), rendered.length ? trailing || true : true));
    }
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * tr
 * ================================================================== */

const TR_CLASSES = {
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  alnum: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  space: ' \t\n\u000b\f\r',
  blank: ' \t',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  print: null,
  graph: null,
  cntrl: null,
  xdigit: '0123456789ABCDEFabcdef',
};

/** Expand a tr SET into an explicit character list. */
function expandSet(set) {
  const src = unescape(set);
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '[' && src[i + 1] === ':') {
      const end = src.indexOf(':]', i + 2);
      if (end > 0) {
        const name = src.slice(i + 2, end);
        if (TR_CLASSES[name] !== undefined && TR_CLASSES[name] !== null) {
          out += TR_CLASSES[name];
        } else if (name === 'print') {
          for (let c = 32; c < 127; c += 1) out += String.fromCharCode(c);
        } else if (name === 'graph') {
          for (let c = 33; c < 127; c += 1) out += String.fromCharCode(c);
        } else if (name === 'cntrl') {
          for (let c = 0; c < 32; c += 1) out += String.fromCharCode(c);
          out += String.fromCharCode(127);
        }
        i = end + 2;
        continue;
      }
    }
    if (src[i] === '[' && src[i + 2] === '*') {
      const end = src.indexOf(']', i + 3);
      if (end > 0) {
        const count = Number(src.slice(i + 3, end)) || 0;
        out += src[i + 1].repeat(count);
        i = end + 1;
        continue;
      }
    }
    if (src[i + 1] === '-' && i + 2 < src.length && src[i + 2] !== ']') {
      const from = src.charCodeAt(i);
      const to = src.charCodeAt(i + 2);
      if (to >= from) {
        for (let c = from; c <= to; c += 1) out += String.fromCharCode(c);
        i += 3;
        continue;
      }
    }
    out += src[i];
    i += 1;
  }
  return out;
}

const tr = {
  name: 'tr',
  aliases: [],
  synopsis: 'tr [OPTION]... SET1 [SET2]',
  description: 'Translate or delete characters',
  man: `NAME
       tr - translate or delete characters

SYNOPSIS
       tr [OPTION]... SET1 [SET2]

DESCRIPTION
       Translate, squeeze, and/or delete characters from standard input,
       writing to standard output. SETs accept ranges (a-z), the character
       classes [:upper:] [:lower:] [:digit:] [:space:] [:alpha:] [:punct:]
       [:alnum:] [:blank:] [:xdigit:] [:print:] [:graph:] [:cntrl:], the
       repeat form [c*n], and backslash escapes.

       -c, -C, --complement   use the complement of SET1
       -d, --delete           delete characters in SET1, do not translate
       -s, --squeeze-repeats  replace each sequence of a repeated character
                              that is listed in the last SET with a single one
       -t, --truncate-set1    first truncate SET1 to length of SET2`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const complement = p.flags.has('c') || p.flags.has('C') || p.longs.complement === true;
    const del = p.flags.has('d') || p.longs.delete === true;
    const squeeze = p.flags.has('s') || p.longs['squeeze-repeats'] === true;
    const truncate = p.flags.has('t') || p.longs['truncate-set1'] === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "tr: missing operand\nTry 'tr --help' for more information.\n",
        code: 1,
      };
    }
    if (!del && !squeeze && p.operands.length < 2) {
      return {
        stdout: '',
        stderr: `tr: missing operand after '${p.operands[0]}'\nTwo strings must be given when translating.\n`,
        code: 1,
      };
    }

    let set1 = expandSet(p.operands[0]);
    let set2 = p.operands.length > 1 ? expandSet(p.operands[1]) : '';
    if (truncate && set2.length > 0 && set1.length > set2.length) set1 = set1.slice(0, set2.length);

    const inSet1 = (ch) => (complement ? set1.indexOf(ch) < 0 : set1.indexOf(ch) >= 0);
    const squeezeSet = del && set2 !== '' ? set2 : p.operands.length > 1 && !del ? set2 : set1;
    const inSqueeze = (ch) =>
      squeezeSet === set1 && complement ? squeezeSet.indexOf(ch) < 0 : squeezeSet.indexOf(ch) >= 0;

    const text = ctx.stdin || '';
    let out = '';
    let previous = null;

    for (const ch of text) {
      let emitted = null;
      if (del && inSet1(ch)) {
        previous = null;
        continue;
      }
      if (!del && set2 !== '' && inSet1(ch)) {
        const idx = complement ? set2.length - 1 : set1.indexOf(ch);
        emitted = set2[Math.min(idx, set2.length - 1)];
      } else {
        emitted = ch;
      }
      if (squeeze && previous === emitted && inSqueeze(emitted)) continue;
      out += emitted;
      previous = emitted;
    }
    return ok(out);
  },
};

/* ================================================================== *
 * rev / tee
 * ================================================================== */

const rev = {
  name: 'rev',
  aliases: [],
  synopsis: 'rev [FILE]...',
  description: 'Reverse lines characterwise',
  man: `NAME
       rev - reverse lines characterwise

SYNOPSIS
       rev [OPTION]... [FILE]...

DESCRIPTION
       Copy the specified files to standard output, reversing the order of
       characters in every line. If no files are specified, read standard input.`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const read = readInputs(ctx, p.operands, 'rev');
    const out = [];
    for (const item of read.items) {
      const { lines, trailing } = splitLines(item.text);
      out.push(joinLines(lines.map((l) => Array.from(l).reverse().join('')), lines.length ? trailing || true : true));
    }
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

const tee = {
  name: 'tee',
  aliases: [],
  synopsis: 'tee [OPTION]... [FILE]...',
  description: 'Read from standard input and write to standard output and files',
  man: `NAME
       tee - read from standard input and write to standard output and files

SYNOPSIS
       tee [OPTION]... [FILE]...

DESCRIPTION
       Copy standard input to each FILE, and also to standard output.

       -a, --append              append to the given FILEs, do not overwrite
       -i, --ignore-interrupts   ignore interrupt signals`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const append = p.flags.has('a') || p.longs.append === true;
    const text = ctx.stdin || '';
    const errors = [];
    let code = 0;

    for (const name of p.operands) {
      if (name === '-') continue;
      try {
        ctx.fs.writeFile(abs(ctx, name), text, { append });
      } catch (err) {
        errors.push(`tee: ${name}: ${phrase(err)}\n`);
        code = 1;
      }
    }
    return { stdout: text, stderr: errors.join(''), code };
  },
};

/* ================================================================== *
 * diff
 * ================================================================== */

/**
 * Longest common subsequence edit script.
 * @returns {Array<{op: 'equal'|'delete'|'insert', a?: number, b?: number}>}
 */
function diffScript(a, b) {
  const n = a.length;
  const m = b.length;
  const MAX_CELLS = 4000000;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    /* Degrade to a positional diff for very large inputs. */
    const script = [];
    const len = Math.max(n, m);
    for (let i = 0; i < len; i += 1) {
      if (i < n && i < m && a[i] === b[i]) script.push({ op: 'equal', a: i, b: i });
      else {
        if (i < n) script.push({ op: 'delete', a: i });
        if (i < m) script.push({ op: 'insert', b: i });
      }
    }
    return script;
  }

  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const script = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      script.push({ op: 'equal', a: i, b: j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      script.push({ op: 'delete', a: i });
      i += 1;
    } else {
      script.push({ op: 'insert', b: j });
      j += 1;
    }
  }
  while (i < n) {
    script.push({ op: 'delete', a: i });
    i += 1;
  }
  while (j < m) {
    script.push({ op: 'insert', b: j });
    j += 1;
  }
  return script;
}

/** Collapse an edit script into change hunks. */
function diffHunks(script) {
  const hunks = [];
  let current = null;
  for (const step of script) {
    if (step.op === 'equal') {
      if (current) {
        hunks.push(current);
        current = null;
      }
      continue;
    }
    if (!current) current = { deletes: [], inserts: [], aStart: null, bStart: null };
    if (step.op === 'delete') {
      if (current.aStart === null) current.aStart = step.a;
      current.deletes.push(step.a);
    } else {
      if (current.bStart === null) current.bStart = step.b;
      current.inserts.push(step.b);
    }
    if (current.aStart === null) current.aStart = step.a !== undefined ? step.a : null;
  }
  if (current) hunks.push(current);
  return hunks;
}

function diffRange(list, offset) {
  if (list.length === 0) return String(offset);
  const first = list[0] + 1;
  const last = list[list.length - 1] + 1;
  return first === last ? String(first) : `${first},${last}`;
}

function diffTimestamp(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const oa = Math.abs(off);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}000000 ` +
    `${sign}${p2(Math.floor(oa / 60))}${p2(oa % 60)}`
  );
}

function unifiedDiff(aLines, bLines, script, context, nameA, nameB, timeA, timeB) {
  const out = [];
  const rows = [];
  for (const step of script) {
    if (step.op === 'equal') rows.push({ tag: ' ', text: aLines[step.a], a: step.a, b: step.b });
    else if (step.op === 'delete') rows.push({ tag: '-', text: aLines[step.a], a: step.a, b: null });
    else rows.push({ tag: '+', text: bLines[step.b], a: null, b: step.b });
  }

  const groups = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].tag === ' ') {
      i += 1;
      continue;
    }
    let start = i;
    let end = i;
    while (end < rows.length) {
      if (rows[end].tag !== ' ') {
        end += 1;
        continue;
      }
      let run = 0;
      while (end + run < rows.length && rows[end + run].tag === ' ') run += 1;
      if (run > context * 2 || end + run >= rows.length) break;
      end += run;
    }
    start = Math.max(0, start - context);
    end = Math.min(rows.length, end + context);
    const last = groups[groups.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else groups.push({ start, end });
    i = end;
  }

  if (groups.length === 0) return '';

  out.push(`--- ${nameA}\t${timeA}\n`);
  out.push(`+++ ${nameB}\t${timeB}\n`);
  for (const group of groups) {
    const slice = rows.slice(group.start, group.end);
    let aStart = null;
    let bStart = null;
    let aCount = 0;
    let bCount = 0;
    for (const row of slice) {
      if (row.a !== null) {
        if (aStart === null) aStart = row.a;
        aCount += 1;
      }
      if (row.b !== null) {
        if (bStart === null) bStart = row.b;
        bCount += 1;
      }
    }
    const aHead = aCount === 0 ? `${aStart === null ? 0 : aStart},0` : aCount === 1 ? `${aStart + 1}` : `${aStart + 1},${aCount}`;
    const bHead = bCount === 0 ? `${bStart === null ? 0 : bStart},0` : bCount === 1 ? `${bStart + 1}` : `${bStart + 1},${bCount}`;
    out.push(`@@ -${aHead} +${bHead} @@\n`);
    for (const row of slice) out.push(`${row.tag}${row.text}\n`);
  }
  return out.join('');
}

const diff = {
  name: 'diff',
  aliases: [],
  synopsis: 'diff [OPTION]... FILES',
  description: 'Compare files line by line',
  man: `NAME
       diff - compare files line by line

SYNOPSIS
       diff [OPTION]... FILES

DESCRIPTION
       Compare FILES line by line.

       -q, --brief              report only when files differ
       -i, --ignore-case        ignore case differences in file contents
       -w, --ignore-all-space   ignore all white space
       -b, --ignore-space-change  ignore changes in the amount of white space
       -u, -U NUM, --unified[=NUM]  output NUM (default 3) lines of unified context
       -s, --report-identical-files  report when two files are the same

EXIT STATUS
       0 if inputs are the same, 1 if different, 2 if trouble.`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'U');
    const brief = p.flags.has('q') || p.longs.brief === true;
    const ignoreCase = p.flags.has('i') || p.longs['ignore-case'] === true;
    const ignoreAllSpace = p.flags.has('w') || p.longs['ignore-all-space'] === true;
    const ignoreSpaceChange = p.flags.has('b') || p.longs['ignore-space-change'] === true;
    const reportSame = p.flags.has('s') || p.longs['report-identical-files'] === true;
    const unified = p.flags.has('u') || p.flags.has('U') || p.longs.unified !== undefined;
    let context = 3;
    if (p.values.U !== undefined) context = Number(p.values.U) || 0;
    if (typeof p.longs.unified === 'string') context = Number(p.longs.unified) || 0;

    if (p.operands.length < 2) {
      return {
        stdout: '',
        stderr: `diff: missing operand after '${p.operands[0] || 'diff'}'\ndiff: Try 'diff --help' for more information.\n`,
        code: 2,
      };
    }

    const readOne = (name) => {
      if (name === '-') return { text: ctx.stdin || '', mtime: Date.now() };
      const target = abs(ctx, name);
      return { text: ctx.fs.readFile(target), mtime: ctx.fs.lstat(target).mtime };
    };

    let fileA;
    let fileB;
    try {
      fileA = readOne(p.operands[0]);
    } catch (err) {
      return { stdout: '', stderr: `diff: ${p.operands[0]}: ${phrase(err)}\n`, code: 2 };
    }
    try {
      fileB = readOne(p.operands[1]);
    } catch (err) {
      return { stdout: '', stderr: `diff: ${p.operands[1]}: ${phrase(err)}\n`, code: 2 };
    }

    const nameA = p.operands[0];
    const nameB = p.operands[1];
    const aLines = splitLines(fileA.text).lines;
    const bLines = splitLines(fileB.text).lines;

    const normalize = (line) => {
      let v = line;
      if (ignoreCase) v = v.toLowerCase();
      if (ignoreAllSpace) v = v.replace(/\s+/g, '');
      else if (ignoreSpaceChange) v = v.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, '');
      return v;
    };
    const keyA = aLines.map(normalize);
    const keyB = bLines.map(normalize);

    const script = diffScript(keyA, keyB);
    const different = script.some((s) => s.op !== 'equal');

    if (!different) {
      if (reportSame) return ok(`Files ${nameA} and ${nameB} are identical\n`);
      return ok('');
    }
    if (brief) return { stdout: `Files ${nameA} and ${nameB} differ\n`, stderr: '', code: 1 };

    if (unified) {
      const text = unifiedDiff(
        aLines,
        bLines,
        script,
        context,
        nameA,
        nameB,
        diffTimestamp(fileA.mtime),
        diffTimestamp(fileB.mtime),
      );
      return { stdout: text, stderr: '', code: 1 };
    }

    /* Default (normal) diff output. */
    const out = [];
    let aPos = 0;
    let bPos = 0;
    let i = 0;
    while (i < script.length) {
      const step = script[i];
      if (step.op === 'equal') {
        aPos = step.a + 1;
        bPos = step.b + 1;
        i += 1;
        continue;
      }
      const deletes = [];
      const inserts = [];
      while (i < script.length && script[i].op !== 'equal') {
        if (script[i].op === 'delete') deletes.push(script[i].a);
        else inserts.push(script[i].b);
        i += 1;
      }
      if (deletes.length && inserts.length) {
        out.push(`${diffRange(deletes, aPos)}c${diffRange(inserts, bPos)}\n`);
        for (const idx of deletes) out.push(`< ${aLines[idx]}\n`);
        out.push('---\n');
        for (const idx of inserts) out.push(`> ${bLines[idx]}\n`);
      } else if (deletes.length) {
        out.push(`${diffRange(deletes, aPos)}d${bPos}\n`);
        for (const idx of deletes) out.push(`< ${aLines[idx]}\n`);
      } else {
        out.push(`${aPos}a${diffRange(inserts, bPos)}\n`);
        for (const idx of inserts) out.push(`> ${bLines[idx]}\n`);
      }
      if (deletes.length) aPos = deletes[deletes.length - 1] + 1;
      if (inserts.length) bPos = inserts[inserts.length - 1] + 1;
    }
    return { stdout: out.join(''), stderr: '', code: 1 };
  },
};

/* ================================================================== *
 * nl
 * ================================================================== */

const nl = {
  name: 'nl',
  aliases: [],
  synopsis: 'nl [OPTION]... [FILE]...',
  description: 'Number lines of files',
  man: `NAME
       nl - number lines of files

SYNOPSIS
       nl [OPTION]... [FILE]...

DESCRIPTION
       Write each FILE to standard output, with line numbers added.

       -b, --body-numbering=STYLE   use STYLE for numbering body lines
                                    a (all), t (nonempty, default), n (none),
                                    pBRE (only lines matching BRE)
       -i, --line-increment=NUMBER  line number increment at each line
       -n, --number-format=FORMAT   ln (left), rn (right, default), rz (zeros)
       -s, --number-separator=STRING  add STRING after (possible) line number
       -v, --starting-line-number=NUMBER  first line number on each page
       -w, --number-width=NUMBER    use NUMBER columns for line numbers`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'bnsvwi');
    const style = p.values.b !== undefined ? p.values.b : typeof p.longs['body-numbering'] === 'string' ? p.longs['body-numbering'] : 't';
    const format = p.values.n !== undefined ? p.values.n : typeof p.longs['number-format'] === 'string' ? p.longs['number-format'] : 'rn';
    const sep = p.values.s !== undefined ? unescape(p.values.s) : typeof p.longs['number-separator'] === 'string' ? unescape(p.longs['number-separator']) : '\t';
    const width = Number(p.values.w !== undefined ? p.values.w : p.longs['number-width']) || 6;
    const increment = Number(p.values.i !== undefined ? p.values.i : p.longs['line-increment']) || 1;
    let counter = Number(p.values.v !== undefined ? p.values.v : p.longs['starting-line-number']);
    if (!Number.isFinite(counter)) counter = 1;

    let bodyRe = null;
    if (style[0] === 'p') {
      try {
        bodyRe = buildRegExp(style.slice(1), { extended: false });
      } catch {
        bodyRe = null;
      }
    }

    const read = readInputs(ctx, p.operands, 'nl');
    const out = [];
    for (const item of read.items) {
      const { lines, trailing } = splitLines(item.text);
      const rendered = lines.map((line) => {
        let numbered;
        if (style === 'a') numbered = true;
        else if (style === 'n') numbered = false;
        else if (bodyRe) numbered = bodyRe.test(line);
        else numbered = line.trim() !== '';

        if (!numbered) return `${' '.repeat(width)}${sep.replace(/\t/g, '\t')}${line}`.replace(new RegExp(`^ {${width}}`), ' '.repeat(width));
        const raw = String(counter);
        counter += increment;
        let field;
        if (format === 'ln') field = padRight(raw, width);
        else if (format === 'rz') field = raw.padStart(width, '0');
        else field = padLeft(raw, width);
        return `${field}${sep}${line}`;
      });
      out.push(joinLines(rendered, lines.length ? trailing || true : true));
    }
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * less / more
 * ================================================================== */

const less = {
  name: 'less',
  aliases: [],
  synopsis: 'less [OPTION]... [FILE]...',
  description: 'Opposite of more — page through text one screen at a time',
  man: `NAME
       less - opposite of more

SYNOPSIS
       less [OPTION]... [FILE]...

DESCRIPTION
       less is a program similar to more, but it allows backward movement in
       the file as well as forward movement.

COMMANDS
       SPACE, f, PageDown   Scroll forward one window
       RETURN, j, Down      Scroll forward one line
       b, PageUp            Scroll backward one window
       k, Up                Scroll backward one line
       g / G, Home / End    Go to the first / last line
       h                    Display a short help summary
       q, Q, ESC            Exit

       -N, --LINE-NUMBERS   Display line numbers
       -S, --chop-long-lines  Do not wrap long lines`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const numbers = p.flags.has('N') || p.longs['LINE-NUMBERS'] === true;
    const read = readInputs(ctx, p.operands, 'less');
    if (read.errors.length && read.items.length === 0) {
      return { stdout: '', stderr: read.errors.join(''), code: 1 };
    }
    let text = read.items.map((i) => i.text).join('');
    if (numbers) {
      const { lines, trailing } = splitLines(text);
      text = joinLines(lines.map((l, i) => `${padLeft(String(i + 1), 6)} ${l}`), trailing || true);
    }
    const paged = await pageThrough(ctx, text, 'less', p.operands[0] || '');
    return { stdout: paged.stdout, stderr: read.errors.join(''), code: read.code };
  },
};

const more = {
  name: 'more',
  aliases: [],
  synopsis: 'more [OPTION]... [FILE]...',
  description: 'Display the contents of a file in a terminal',
  man: `NAME
       more - display the contents of a file in a terminal

SYNOPSIS
       more [OPTION]... [FILE]...

DESCRIPTION
       more is a filter for paging through text one screenful at a time.

COMMANDS
       SPACE      Display next screenful
       RETURN     Display next line
       b          Skip backwards one screenful
       q          Quit

       -NUMBER    The number of lines per screenful`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const read = readInputs(ctx, p.operands, 'more');
    if (read.errors.length && read.items.length === 0) {
      return { stdout: '', stderr: read.errors.join(''), code: 1 };
    }
    const text = read.items.map((i) => i.text).join('');
    const paged = await pageThrough(ctx, text, 'more', p.operands[0] || '');
    return { stdout: paged.stdout, stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * paste / column / fold
 * ================================================================== */

const paste = {
  name: 'paste',
  aliases: [],
  synopsis: 'paste [OPTION]... [FILE]...',
  description: 'Merge lines of files',
  man: `NAME
       paste - merge lines of files

SYNOPSIS
       paste [OPTION]... [FILE]...

DESCRIPTION
       Write lines consisting of the sequentially corresponding lines from each
       FILE, separated by TABs, to standard output.

       -d, --delimiters=LIST   reuse characters from LIST instead of TABs
       -s, --serial            paste one file at a time instead of in parallel
       -z, --zero-terminated   line delimiter is NUL, not newline`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'd');
    const serial = p.flags.has('s') || p.longs.serial === true;
    const rawDelims = p.values.d !== undefined ? p.values.d : typeof p.longs.delimiters === 'string' ? p.longs.delimiters : '\t';
    const delims = unescape(rawDelims) || '\t';

    const read = readInputs(ctx, p.operands, 'paste');
    const columns = read.items.map((item) => splitLines(item.text).lines);
    const out = [];

    if (serial) {
      columns.forEach((lines, index) => {
        void index;
        const parts = [];
        lines.forEach((line, i) => {
          if (i > 0) parts.push(delims[(i - 1) % delims.length]);
          parts.push(line);
        });
        out.push(`${parts.join('')}\n`);
      });
    } else {
      const height = Math.max(0, ...columns.map((c) => c.length));
      for (let row = 0; row < height; row += 1) {
        const parts = [];
        columns.forEach((lines, index) => {
          if (index > 0) parts.push(delims[(index - 1) % delims.length]);
          parts.push(lines[row] === undefined ? '' : lines[row]);
        });
        out.push(`${parts.join('')}\n`);
      }
    }
    return result(out, read.errors, read.code);
  },
};

const column = {
  name: 'column',
  aliases: [],
  synopsis: 'column [OPTION]... [FILE]...',
  description: 'Columnate lists',
  man: `NAME
       column - columnate lists

SYNOPSIS
       column [OPTION]... [FILE]...

DESCRIPTION
       The column utility formats its input into multiple columns. Rows are
       filled before columns.

       -t, --table              create a table
       -s, --separator=SEP      possible table delimiters
       -o, --output-separator=STRING  columns separator for table output
       -c, --output-width=WIDTH output width in characters
       -x, --fillrows           fill rows before columns`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'soc');
    const table = p.flags.has('t') || p.longs.table === true;
    const fillRows = p.flags.has('x') || p.longs.fillrows === true;
    const sep = p.values.s !== undefined ? p.values.s : typeof p.longs.separator === 'string' ? p.longs.separator : null;
    const outSep = p.values.o !== undefined ? p.values.o : typeof p.longs['output-separator'] === 'string' ? p.longs['output-separator'] : '  ';
    const width = Number(p.values.c !== undefined ? p.values.c : p.longs['output-width']) || termCols(ctx);

    const read = readInputs(ctx, p.operands, 'column');
    const lines = splitLines(read.items.map((i) => i.text).join('')).lines.filter((l) => l !== '');
    const out = [];

    if (table) {
      const rows = lines.map((line) => (sep === null ? line.split(/\s+/).filter((c) => c !== '') : line.split(sep)));
      const cols = Math.max(0, ...rows.map((r) => r.length));
      const widths = [];
      for (let c = 0; c < cols; c += 1) {
        widths.push(Math.max(0, ...rows.map((r) => (r[c] === undefined ? 0 : r[c].length))));
      }
      for (const row of rows) {
        const cells = row.map((cell, c) => (c === row.length - 1 ? cell : padRight(cell, widths[c])));
        out.push(`${cells.join(outSep)}\n`);
      }
      return result(out, read.errors, read.code);
    }

    if (lines.length === 0) return result(out, read.errors, read.code);
    const cellWidth = Math.max(...lines.map((l) => l.length)) + 2;
    const cols = Math.max(1, Math.floor(width / cellWidth));
    const rows = Math.ceil(lines.length / cols);

    for (let r = 0; r < rows; r += 1) {
      const parts = [];
      for (let c = 0; c < cols; c += 1) {
        const index = fillRows ? r * cols + c : c * rows + r;
        if (index >= lines.length) continue;
        parts.push(padRight(lines[index], cellWidth));
      }
      out.push(`${parts.join('').replace(/\s+$/, '')}\n`);
    }
    return result(out, read.errors, read.code);
  },
};

const fold = {
  name: 'fold',
  aliases: [],
  synopsis: 'fold [OPTION]... [FILE]...',
  description: 'Wrap each input line to fit in specified width',
  man: `NAME
       fold - wrap each input line to fit in specified width

SYNOPSIS
       fold [OPTION]... [FILE]...

DESCRIPTION
       Wrap input lines in each FILE, writing to standard output.

       -b, --bytes    count bytes rather than columns
       -s, --spaces   break at spaces
       -w, --width=WIDTH  use WIDTH columns instead of 80`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'w');
    const spaces = p.flags.has('s') || p.longs.spaces === true;
    let width = Number(p.values.w !== undefined ? p.values.w : p.longs.width);
    if (!Number.isFinite(width) || width < 1) width = 80;

    const read = readInputs(ctx, p.operands, 'fold');
    const out = [];
    for (const item of read.items) {
      const { lines, trailing } = splitLines(item.text);
      const folded = [];
      for (const line of lines) {
        let rest = line;
        if (rest === '') {
          folded.push('');
          continue;
        }
        while (rest.length > width) {
          let cut = width;
          if (spaces) {
            const idx = rest.lastIndexOf(' ', width - 1);
            if (idx > 0) cut = idx + 1;
          }
          folded.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        folded.push(rest);
      }
      out.push(joinLines(folded, lines.length ? trailing || true : true));
    }
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * split
 * ================================================================== */

function suffixFor(index, length, numeric) {
  if (numeric) return String(index).padStart(length, '0');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let n = index;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = alphabet[n % 26] + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function parseSizeArg(raw) {
  const m = /^(\d+)([bkKmMgG]?)(B?)$/.exec(String(raw));
  if (!m) return null;
  const base = m[3] === 'B' ? 1000 : 1024;
  const mult = { '': 1, b: 512, k: base, K: base, m: base ** 2, M: base ** 2, g: base ** 3, G: base ** 3 }[m[2]];
  return Number(m[1]) * mult;
}

const split = {
  name: 'split',
  aliases: [],
  synopsis: 'split [OPTION]... [FILE [PREFIX]]',
  description: 'Split a file into pieces',
  man: `NAME
       split - split a file into pieces

SYNOPSIS
       split [OPTION]... [FILE [PREFIX]]

DESCRIPTION
       Output pieces of FILE to PREFIXaa, PREFIXab, ...; default size is 1000
       lines, and the default PREFIX is 'x'.

       -a, --suffix-length=N   generate suffixes of length N (default 2)
       -b, --bytes=SIZE        put SIZE bytes per output file
       -d                      use numeric suffixes starting at 0
       -l, --lines=NUMBER      put NUMBER lines per output file
           --additional-suffix=SUFFIX  append an additional SUFFIX
       -n, --number=CHUNKS     generate CHUNKS output files
           --verbose           print a diagnostic just before each output file`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'ablnd'.replace('d', ''));
    const numeric = p.flags.has('d') || p.longs['numeric-suffixes'] !== undefined;
    const verbose = p.longs.verbose === true;
    const suffixLength = Number(p.values.a !== undefined ? p.values.a : p.longs['suffix-length']) || 2;
    const extraSuffix = typeof p.longs['additional-suffix'] === 'string' ? p.longs['additional-suffix'] : '';

    const bytesArg = p.values.b !== undefined ? p.values.b : p.longs.bytes;
    const linesArg = p.values.l !== undefined ? p.values.l : p.longs.lines;
    const chunksArg = p.values.n !== undefined ? p.values.n : p.longs.number;

    const operands = p.operands.slice();
    const source = operands.length ? operands[0] : '-';
    const prefix = operands.length > 1 ? operands[1] : 'x';

    let text;
    if (source === '-') {
      text = ctx.stdin || '';
    } else {
      try {
        text = ctx.fs.readFile(abs(ctx, source));
      } catch (err) {
        return { stdout: '', stderr: `split: cannot open '${source}' for reading: ${phrase(err)}\n`, code: 1 };
      }
    }

    const pieces = [];
    if (typeof bytesArg === 'string') {
      const size = parseSizeArg(bytesArg);
      if (!size) return { stdout: '', stderr: `split: invalid number of bytes: '${bytesArg}'\n`, code: 1 };
      for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
    } else if (typeof chunksArg === 'string') {
      const chunks = Number(chunksArg);
      if (!Number.isFinite(chunks) || chunks < 1) {
        return { stdout: '', stderr: `split: invalid number of chunks: '${chunksArg}'\n`, code: 1 };
      }
      const size = Math.ceil(text.length / chunks);
      for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
    } else {
      const perFile = Number(typeof linesArg === 'string' ? linesArg : 1000);
      if (!Number.isFinite(perFile) || perFile < 1) {
        return { stdout: '', stderr: `split: invalid number of lines: '${linesArg}'\n`, code: 1 };
      }
      const { lines } = splitLines(text);
      for (let i = 0; i < lines.length; i += perFile) {
        pieces.push(joinLines(lines.slice(i, i + perFile)));
      }
    }

    if (pieces.length === 0) return ok('');

    const out = [];
    const errors = [];
    let code = 0;
    pieces.forEach((piece, index) => {
      const name = `${prefix}${suffixFor(index, suffixLength, numeric)}${extraSuffix}`;
      try {
        ctx.fs.writeFile(abs(ctx, name), piece);
        if (verbose) out.push(`creating file '${name}'\n`);
      } catch (err) {
        errors.push(`split: ${name}: ${phrase(err)}\n`);
        code = 1;
      }
    });
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * join / comm / shuf
 * ================================================================== */

const join = {
  name: 'join',
  aliases: [],
  synopsis: 'join [OPTION]... FILE1 FILE2',
  description: 'Join lines of two files on a common field',
  man: `NAME
       join - join lines of two files on a common field

SYNOPSIS
       join [OPTION]... FILE1 FILE2

DESCRIPTION
       For each pair of input lines with identical join fields, write a line to
       standard output. The default join field is the first, delimited by
       blanks.

       -1 FIELD          join on this FIELD of file 1
       -2 FIELD          join on this FIELD of file 2
       -a FILENUM        also print unpairable lines from file FILENUM
       -e EMPTY          replace missing input fields with EMPTY
       -t CHAR           use CHAR as input and output field separator
       -v FILENUM        like -a FILENUM, but suppress joined output lines
       -i, --ignore-case ignore differences in case when comparing fields`,

  async run(ctx) {
    const p = optParse(ctx.argv, '12aevt');
    const field1 = Number(p.values['1']) || 1;
    const field2 = Number(p.values['2']) || 1;
    const sep = p.values.t !== undefined ? unescape(p.values.t) : null;
    const empty = p.values.e !== undefined ? p.values.e : '';
    const insensitive = p.flags.has('i') || p.longs['ignore-case'] === true;
    const showUnpaired = new Set();
    const onlyUnpaired = new Set();
    if (p.values.a !== undefined) showUnpaired.add(String(p.values.a));
    if (p.values.v !== undefined) onlyUnpaired.add(String(p.values.v));

    if (p.operands.length < 2) {
      return { stdout: '', stderr: 'join: missing operand\nTry \'join --help\' for more information.\n', code: 1 };
    }

    const load = (name) => {
      const text = name === '-' ? ctx.stdin || '' : ctx.fs.readFile(abs(ctx, name));
      return splitLines(text).lines.map((line) => (sep === null ? line.split(/\s+/).filter((c) => c !== '') : line.split(sep)));
    };

    let a;
    let b;
    try {
      a = load(p.operands[0]);
    } catch (err) {
      return { stdout: '', stderr: `join: ${p.operands[0]}: ${phrase(err)}\n`, code: 1 };
    }
    try {
      b = load(p.operands[1]);
    } catch (err) {
      return { stdout: '', stderr: `join: ${p.operands[1]}: ${phrase(err)}\n`, code: 1 };
    }

    const outSep = sep === null ? ' ' : sep;
    const keyOfRow = (row, index) => {
      const value = row[index - 1];
      const v = value === undefined ? '' : value;
      return insensitive ? v.toLowerCase() : v;
    };
    const rest = (row, index) => row.filter((_, i) => i !== index - 1);

    const out = [];
    const pairedA = new Set();
    const pairedB = new Set();

    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < b.length; j += 1) {
        if (a[i].length === 0 || b[j].length === 0) continue;
        if (keyOfRow(a[i], field1) !== keyOfRow(b[j], field2)) continue;
        pairedA.add(i);
        pairedB.add(j);
        if (onlyUnpaired.size > 0) continue;
        const cells = [a[i][field1 - 1] === undefined ? empty : a[i][field1 - 1]]
          .concat(rest(a[i], field1))
          .concat(rest(b[j], field2));
        out.push(`${cells.join(outSep)}\n`);
      }
    }

    if (showUnpaired.has('1') || onlyUnpaired.has('1')) {
      a.forEach((row, i) => {
        if (!pairedA.has(i) && row.length) out.push(`${row.join(outSep)}\n`);
      });
    }
    if (showUnpaired.has('2') || onlyUnpaired.has('2')) {
      b.forEach((row, j) => {
        if (!pairedB.has(j) && row.length) out.push(`${row.join(outSep)}\n`);
      });
    }

    return ok(out.join(''));
  },
};

const comm = {
  name: 'comm',
  aliases: [],
  synopsis: 'comm [OPTION]... FILE1 FILE2',
  description: 'Compare two sorted files line by line',
  man: `NAME
       comm - compare two sorted files line by line

SYNOPSIS
       comm [OPTION]... FILE1 FILE2

DESCRIPTION
       Compare sorted files FILE1 and FILE2 line by line. With no options,
       produce three-column output: lines only in FILE1, lines only in FILE2,
       and lines in both files.

       -1                suppress column 1 (lines unique to FILE1)
       -2                suppress column 2 (lines unique to FILE2)
       -3                suppress column 3 (lines that appear in both files)
           --total       output a summary`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const hide1 = p.flags.has('1');
    const hide2 = p.flags.has('2');
    const hide3 = p.flags.has('3');
    const total = p.longs.total === true;

    if (p.operands.length < 2) {
      return { stdout: '', stderr: "comm: missing operand\nTry 'comm --help' for more information.\n", code: 1 };
    }

    const load = (name) => {
      const text = name === '-' ? ctx.stdin || '' : ctx.fs.readFile(abs(ctx, name));
      return splitLines(text).lines;
    };

    let a;
    let b;
    try {
      a = load(p.operands[0]);
    } catch (err) {
      return { stdout: '', stderr: `comm: ${p.operands[0]}: ${phrase(err)}\n`, code: 1 };
    }
    try {
      b = load(p.operands[1]);
    } catch (err) {
      return { stdout: '', stderr: `comm: ${p.operands[1]}: ${phrase(err)}\n`, code: 1 };
    }

    const out = [];
    let i = 0;
    let j = 0;
    let only1 = 0;
    let only2 = 0;
    let both = 0;
    const col2 = hide1 ? '' : '\t';
    const col3 = (hide1 ? '' : '\t') + (hide2 ? '' : '\t');

    while (i < a.length || j < b.length) {
      if (j >= b.length || (i < a.length && a[i] < b[j])) {
        only1 += 1;
        if (!hide1) out.push(`${a[i]}\n`);
        i += 1;
      } else if (i >= a.length || b[j] < a[i]) {
        only2 += 1;
        if (!hide2) out.push(`${col2}${b[j]}\n`);
        j += 1;
      } else {
        both += 1;
        if (!hide3) out.push(`${col3}${a[i]}\n`);
        i += 1;
        j += 1;
      }
    }
    if (total) out.push(`${only1}\t${only2}\t${both}\ttotal\n`);
    return ok(out.join(''));
  },
};

const shuf = {
  name: 'shuf',
  aliases: [],
  synopsis: 'shuf [OPTION]... [FILE]',
  description: 'Generate random permutations',
  man: `NAME
       shuf - generate random permutations

SYNOPSIS
       shuf [OPTION]... [FILE]
       shuf -e [OPTION]... [ARG]...
       shuf -i LO-HI [OPTION]...

DESCRIPTION
       Write a random permutation of the input lines to standard output.

       -e, --echo               treat each ARG as an input line
       -i, --input-range=LO-HI  treat each number LO through HI as an input line
       -n, --head-count=COUNT   output at most COUNT lines
       -r, --repeat             output lines can be repeated
       -z, --zero-terminated    line delimiter is NUL, not newline`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'in');
    const echoMode = p.flags.has('e') || p.longs.echo === true;
    const repeat = p.flags.has('r') || p.longs.repeat === true;
    const rangeArg = p.values.i !== undefined ? p.values.i : p.longs['input-range'];
    const countArg = p.values.n !== undefined ? p.values.n : p.longs['head-count'];

    let source = [];
    if (echoMode) {
      source = p.operands.slice();
    } else if (typeof rangeArg === 'string') {
      const m = /^(\d+)-(\d+)$/.exec(rangeArg);
      if (!m) return { stdout: '', stderr: `shuf: invalid input range: '${rangeArg}'\n`, code: 1 };
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (hi < lo) return { stdout: '', stderr: `shuf: invalid input range: '${rangeArg}'\n`, code: 1 };
      for (let n = lo; n <= hi; n += 1) source.push(String(n));
    } else {
      const read = readInputs(ctx, p.operands, 'shuf');
      if (read.code !== 0) return { stdout: '', stderr: read.errors.join(''), code: read.code };
      source = splitLines(read.items.map((i) => i.text).join('')).lines;
    }

    if (source.length === 0) return ok('');

    const limit = Number.isFinite(Number(countArg)) && countArg !== undefined ? Number(countArg) : repeat ? source.length : source.length;

    const out = [];
    if (repeat) {
      for (let k = 0; k < limit; k += 1) out.push(source[Math.floor(Math.random() * source.length)]);
    } else {
      const pool = source.slice();
      for (let k = pool.length - 1; k > 0; k -= 1) {
        const swap = Math.floor(Math.random() * (k + 1));
        const tmp = pool[k];
        pool[k] = pool[swap];
        pool[swap] = tmp;
      }
      out.push(...pool.slice(0, Math.max(0, limit)));
    }
    return ok(joinLines(out));
  },
};

/* ================================================================== *
 * export
 * ================================================================== */

export default [
  echo,
  printf,
  grep,
  egrep,
  fgrep,
  sed,
  sort,
  uniq,
  cut,
  tr,
  rev,
  tee,
  diff,
  nl,
  less,
  more,
  paste,
  column,
  fold,
  split,
  join,
  comm,
  shuf,
];
