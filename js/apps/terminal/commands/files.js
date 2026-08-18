/**
 * js/apps/terminal/commands/files.js — filesystem commands (ARCHITECTURE §17).
 *
 * ls mkdir rmdir rm cp mv touch ln cat tac head tail wc find tree du df stat
 * file chmod chown realpath basename dirname readlink mktemp
 *
 * Every command follows the §17 command object contract and returns
 * `{ stdout, stderr, code }`. Error phrasing matches GNU coreutils 9.4 as
 * shipped in Ubuntu 24.04 LTS.
 */

import { bus } from '../../../core/bus.js';
import * as pathmod from '../../../core/path.js';
import { mountTable as monitorMountTable, rootCapacityIsReal } from '../../monitor/filesystems.js';
import { C } from '../ansi.js';

/* ================================================================== *
 * ANSI palette — resolved defensively so a differently shaped `C`
 * (functions instead of strings) cannot break the command library.
 * ================================================================== */

function sgr(name, fallback) {
  const value = C && C[name];
  return typeof value === 'string' ? value : fallback;
}

const RESET = sgr('reset', '\u001b[0m');
const BOLD = sgr('bold', '\u001b[1m');
const RED = sgr('red', '\u001b[31m');
const GREEN = sgr('green', '\u001b[32m');
const YELLOW = sgr('yellow', '\u001b[33m');
const BLUE = sgr('blue', '\u001b[34m');
const MAGENTA = sgr('magenta', '\u001b[35m');
const CYAN = sgr('cyan', '\u001b[36m');

/* LS_COLORS categories from Ubuntu's default dircolors database. */
const ARCHIVE_RE =
  /\.(tar|tgz|taz|tbz|tbz2|txz|tzst|zip|z|gz|bz|bz2|xz|zst|lz|lz4|lzma|lzh|lha|arj|7z|rar|deb|rpm|jar|war|ear|sar|iso|cab|cpio|rz|alz|ace|zoo|dz|apk)$/i;
const IMAGE_RE =
  /\.(jpg|jpeg|jxl|mjpg|mjpeg|gif|bmp|pbm|pgm|ppm|tga|xbm|xpm|tif|tiff|png|svg|svgz|mng|pcx|webp|ico|mp4|m4v|mkv|webm|ogm|mpg|mpeg|avi|mov|wmv|flv|qt|nuv|rm|rmvb|asf|vob|ogv)$/i;
const AUDIO_RE = /\.(aac|au|flac|m4a|mid|midi|mka|mp3|mpc|ogg|ra|wav|oga|opus|spx|xspf)$/i;

/* ================================================================== *
 * generic helpers
 * ================================================================== */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SIX_MONTHS_MS = 15778476000;
const DIR_SIZE = 4096;

/** @param {number|string} n @param {number} w */
function pad0(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** @param {string} s @param {number} w */
function padLeft(s, w) {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

/** @param {string} s @param {number} w */
function padRight(s, w) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Result shorthands. */
function ok(stdout = '') {
  return { stdout, stderr: '', code: 0 };
}

function result(outLines, errLines, code) {
  return {
    stdout: outLines.join(''),
    stderr: errLines.join(''),
    code,
  };
}

/** GNU error phrase carried by an FsError, with a safe default. */
function phrase(err) {
  if (err && typeof err.message === 'string' && err.message !== '') return err.message;
  return 'No such file or directory';
}

/** Terminal width in columns (§17 `ctx.term`). */
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

/** Terminal height in rows. */
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

/**
 * "Is stdout a terminal", the equivalent of coreutils' `isatty(1)` check.
 *
 * The shell sets `stdoutIsTTY` to false whenever a command's output is piped,
 * redirected into a file, or captured by `$(...)`. Both `--color=auto` and the
 * default output format depend on it.
 */
function isTTY(ctx) {
  if (!ctx) return false;
  if (ctx.stdoutIsTTY !== undefined) return Boolean(ctx.stdoutIsTTY);
  if (ctx.isTTY !== undefined) return Boolean(ctx.isTTY);
  if (ctx.piped !== undefined) return !ctx.piped;
  return Boolean(ctx.term);
}

function cwdOf(ctx) {
  if (ctx && typeof ctx.cwd === 'string' && ctx.cwd !== '') return ctx.cwd;
  return ctx && ctx.env ? ctx.env.cwd : '/home/ubuntu';
}

/** Resolve an operand to an absolute path (handles `~` and relatives). */
function abs(ctx, p) {
  return ctx.fs.resolve(p, cwdOf(ctx));
}

/**
 * Minimal POSIX option parser.
 * @param {string[]} argv
 * @param {string} valueFlags short flags that consume an argument
 * @returns {{flags: Set<string>, values: Record<string,string>, longs: Record<string,string|boolean>, operands: string[], bad: string|null}}
 */
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

/** Shell-quote for `find -exec`. */
function shellQuote(s) {
  return `'${String(s).split("'").join("'\\''")}'`;
}

/** GNU en_US.UTF-8 collation: punctuation is ignored at the primary level. */
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

/** `ls -h` / `du -h` / `df -h` sizes: <10 keeps one decimal, rounds up. */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return String(Math.round(n));
  const units = ['K', 'M', 'G', 'T', 'P', 'E'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  if (value < 10) return `${(Math.ceil(value * 10) / 10).toFixed(1)}${units[i]}`;
  return `${Math.ceil(value)}${units[i]}`;
}

/** Disk blocks in 1K units, ext4-style 4K allocation. */
function blocks1k(st) {
  if (st.isLink) return 0;
  if (st.isDir) return 4;
  const size = Number(st.size) || 0;
  if (size === 0) return 0;
  return Math.ceil(size / 4096) * 4;
}

/** Stable synthetic inode number derived from the resolved path. */
function inodeOf(p) {
  let h = 2166136261;
  const s = String(p);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 262145 + ((h >>> 0) % 3932159);
}

/** `-rwxr-xr-x` style permission string. */
function permString(mode, type) {
  const m = Number(mode) || 0;
  let out = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
  for (let i = 2; i >= 0; i -= 1) {
    const bits = (m >> (i * 3)) & 7;
    out += bits & 4 ? 'r' : '-';
    out += bits & 2 ? 'w' : '-';
    let x = bits & 1 ? 'x' : '-';
    if (i === 2 && m & 0o4000) x = bits & 1 ? 's' : 'S';
    if (i === 1 && m & 0o2000) x = bits & 1 ? 's' : 'S';
    if (i === 0 && m & 0o1000) x = bits & 1 ? 't' : 'T';
    out += x;
  }
  return out;
}

/** `Aug 18 09:41` or `Jan  5  2024` for entries older than six months. */
function lsTime(ms, now) {
  const d = new Date(ms);
  const day = padLeft(String(d.getDate()), 2);
  const recent = ms > now - SIX_MONTHS_MS && ms < now + 3600000;
  if (recent) return `${MONTHS[d.getMonth()]} ${day} ${pad0(d.getHours())}:${pad0(d.getMinutes())}`;
  return `${MONTHS[d.getMonth()]} ${day}  ${d.getFullYear()}`;
}

/** `2024-08-18 09:41:07.123456789 +0900` for `stat`. */
function statTime(ms) {
  const d = new Date(ms);
  const offMin = -d.getTimezoneOffset();
  const sign = offMin < 0 ? '-' : '+';
  const oa = Math.abs(offMin);
  const nanos = `${pad0(d.getMilliseconds(), 3)}000000`;
  return (
    `${d.getFullYear()}-${pad0(d.getMonth() + 1)}-${pad0(d.getDate())} ` +
    `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}.${nanos} ` +
    `${sign}${pad0(Math.floor(oa / 60))}${pad0(oa % 60)}`
  );
}

/** Number of hard links a directory would report: 2 + subdirectory count. */
function linkCount(ctx, p, st) {
  if (!st.isDir) return 1;
  try {
    const kids = ctx.fs.readdir(p, { withStats: true });
    let dirs = 0;
    for (const k of kids) if (k.isDir) dirs += 1;
    return 2 + dirs;
  } catch {
    return 2;
  }
}

/** Fully resolve every symlink component of a path. */
function realpathOf(fsx, p) {
  const segs = pathmod.split(pathmod.normalize(p));
  let out = '/';
  for (let i = 0; i < segs.length; i += 1) {
    let next = out === '/' ? `/${segs[i]}` : `${out}/${segs[i]}`;
    let hops = 0;
    while (hops < 40 && fsx.isLink(next)) {
      let target;
      try {
        target = fsx.readlink(next);
      } catch {
        break;
      }
      next = pathmod.isAbsolute(target)
        ? pathmod.normalize(target)
        : pathmod.normalize(`${pathmod.dirname(next)}/${target}`);
      hops += 1;
    }
    out = next;
  }
  return out;
}

/** Prompt through `ctx.term.ask`; missing terminal means "yes". */
async function confirm(ctx, promptText) {
  if (!ctx.term || typeof ctx.term.ask !== 'function') return true;
  const answer = await ctx.term.ask(promptText, {});
  return /^\s*y/i.test(String(answer === null || answer === undefined ? '' : answer));
}

/** Split text into lines, remembering whether the last line was terminated. */
function splitLines(text) {
  if (text === '') return { lines: [], trailing: true };
  const trailing = text.charCodeAt(text.length - 1) === 10;
  const body = trailing ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailing };
}

/**
 * Read the operands of a text command, falling back to stdin.
 * @returns {{items: Array<{name: string, text: string}>, errors: string[], code: number, usedStdin: boolean}}
 */
function readInputs(ctx, operands, cmd, style = 'plain') {
  const items = [];
  const errors = [];
  let code = 0;
  let usedStdin = false;
  const names = operands.length === 0 ? ['-'] : operands;

  for (const name of names) {
    if (name === '-') {
      items.push({ name: '-', text: ctx.stdin || '' });
      usedStdin = true;
      continue;
    }
    const target = abs(ctx, name);
    try {
      if (ctx.fs.isDir(target)) {
        if (style === 'open') errors.push(`${cmd}: error reading '${name}': Is a directory\n`);
        else errors.push(`${cmd}: ${name}: Is a directory\n`);
        code = 1;
        if (cmd === 'wc') items.push({ name, text: '' });
        continue;
      }
      items.push({ name, text: ctx.fs.readFile(target) });
    } catch (err) {
      if (style === 'open') errors.push(`${cmd}: cannot open '${name}' for reading: ${phrase(err)}\n`);
      else errors.push(`${cmd}: ${name}: ${phrase(err)}\n`);
      code = 1;
    }
  }
  return { items, errors, code, usedStdin };
}

/* ================================================================== *
 * ls
 * ================================================================== */

function colorFor(ctx, entryPath, st) {
  if (st.isLink) {
    return ctx.fs.exists(entryPath) ? BOLD + CYAN : BOLD + RED;
  }
  if (st.isDir) return BOLD + BLUE;
  if ((Number(st.mode) & 0o111) !== 0) return BOLD + GREEN;
  if (ARCHIVE_RE.test(st.name)) return BOLD + RED;
  if (IMAGE_RE.test(st.name)) return BOLD + MAGENTA;
  if (AUDIO_RE.test(st.name)) return CYAN;
  return '';
}

function classifySuffix(st) {
  if (st.isDir) return '/';
  if (st.isLink) return '@';
  if ((Number(st.mode) & 0o111) !== 0) return '*';
  return '';
}

/** Build the rendered name for one entry: `{ text, len }`. */
function renderName(ctx, entry, opts) {
  let name = entry.name;
  let suffix = '';
  if (opts.classify) suffix = classifySuffix(entry.st);
  const paint = opts.color ? colorFor(ctx, entry.path, entry.st) : '';
  const body = paint ? `${paint}${name}${RESET}` : name;
  return { text: body + suffix, len: name.length + suffix.length };
}

/** Column-major layout exactly like GNU ls. */
function columnize(cells, width) {
  const n = cells.length;
  if (n === 0) return '';
  const minLen = Math.min(...cells.map((c) => c.len));
  let cols = Math.max(1, Math.floor((width + 2) / (minLen + 2)));
  cols = Math.min(cols, n);

  for (; cols > 1; cols -= 1) {
    const rows = Math.ceil(n / cols);
    /* Skip layouts whose last column would be empty — GNU never picks those. */
    if ((cols - 1) * rows >= n) continue;
    const widths = [];
    let total = 0;
    for (let c = 0; c < cols; c += 1) {
      let w = 0;
      for (let r = 0; r < rows; r += 1) {
        const idx = c * rows + r;
        if (idx < n && cells[idx].len > w) w = cells[idx].len;
      }
      widths.push(w);
      total += w;
    }
    total += 2 * (cols - 1);
    if (total <= width) {
      return renderGrid(cells, rows, cols, widths);
    }
  }
  return cells.map((c) => `${c.text}\n`).join('');
}

function renderGrid(cells, rows, cols, widths) {
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      const idx = c * rows + r;
      if (idx >= cells.length) continue;
      const cell = cells[idx];
      const last = c === cols - 1 || idx + rows >= cells.length;
      line += cell.text;
      if (!last) line += ' '.repeat(widths[c] - cell.len + 2);
    }
    out.push(`${line}\n`);
  }
  return out.join('');
}

function longFormat(ctx, entries, opts) {
  const rows = [];
  const now = Date.now();
  let totalBlocks = 0;

  for (const e of entries) {
    const st = e.st;
    totalBlocks += blocks1k(st);
    const size = opts.human ? humanSize(st.size) : String(st.size);
    const row = {
      inode: opts.inode ? String(inodeOf(e.path)) : '',
      mode: permString(st.mode, st.type),
      links: String(linkCount(ctx, e.path, st)),
      owner: st.owner || 'ubuntu',
      group: st.group || 'ubuntu',
      size,
      time: lsTime(st.mtime, now),
      name: renderName(ctx, e, opts),
      link: '',
    };
    if (st.isLink) {
      let target = '';
      try {
        target = ctx.fs.readlink(e.path);
      } catch {
        target = '';
      }
      row.link = target;
    }
    rows.push(row);
  }

  const wi = Math.max(0, ...rows.map((r) => r.inode.length));
  const wl = Math.max(1, ...rows.map((r) => r.links.length));
  const wo = Math.max(1, ...rows.map((r) => r.owner.length));
  const wg = Math.max(1, ...rows.map((r) => r.group.length));
  const ws = Math.max(1, ...rows.map((r) => r.size.length));

  const out = [];
  if (opts.showTotal) out.push(`total ${opts.human ? humanSize(totalBlocks * 1024) : totalBlocks}\n`);
  for (const r of rows) {
    let line = '';
    if (opts.inode) line += `${padLeft(r.inode, wi)} `;
    line += `${r.mode} ${padLeft(r.links, wl)} ${padRight(r.owner, wo)} ${padRight(r.group, wg)} `;
    line += `${padLeft(r.size, ws)} ${r.time} ${r.name.text}`;
    if (r.link !== '') line += ` -> ${r.link}`;
    out.push(`${line}\n`);
  }
  return out.join('');
}

function sortEntries(entries, opts) {
  const list = entries.slice();
  if (opts.sortBy === 'time') {
    list.sort((a, b) => b.st.mtime - a.st.mtime || collate(a.name, b.name));
  } else if (opts.sortBy === 'size') {
    list.sort((a, b) => b.st.size - a.st.size || collate(a.name, b.name));
  } else if (opts.sortBy === 'none') {
    /* keep readdir order */
  } else {
    list.sort((a, b) => collate(a.name, b.name));
  }
  if (opts.reverse) list.reverse();
  return list;
}

function lsCollect(ctx, dirPath, opts) {
  const stats = ctx.fs.readdir(dirPath, { withStats: true });
  const entries = [];
  if (opts.all) {
    entries.push({ name: '.', path: dirPath, st: ctx.fs.lstat(dirPath) });
    const parent = pathmod.dirname(dirPath);
    try {
      entries.push({ name: '..', path: parent, st: ctx.fs.lstat(parent) });
    } catch {
      /* root has no parent to stat */
    }
  }
  for (const st of stats) {
    if (!opts.all && !opts.almost && st.name.charCodeAt(0) === 46) continue;
    entries.push({
      name: st.name,
      path: dirPath === '/' ? `/${st.name}` : `${dirPath}/${st.name}`,
      st,
    });
  }
  return entries;
}

function lsRender(ctx, entries, opts) {
  const sorted = sortEntries(entries, opts);
  if (opts.long) return longFormat(ctx, sorted, opts);
  const cells = sorted.map((e) => {
    const r = renderName(ctx, e, opts);
    if (opts.inode) {
      const ino = String(inodeOf(e.path));
      return { text: `${ino} ${r.text}`, len: ino.length + 1 + r.len };
    }
    return r;
  });
  if (opts.oneLine) return cells.map((c) => `${c.text}\n`).join('');
  return columnize(cells, opts.width);
}

function lsDirRecursive(ctx, dirPath, opts, out, errors, state) {
  let entries;
  try {
    entries = lsCollect(ctx, dirPath, opts);
  } catch (err) {
    errors.push(`ls: cannot open directory '${dirPath}': ${phrase(err)}\n`);
    state.code = 2;
    return;
  }
  if (state.printed) out.push('\n');
  out.push(`${dirPath}:\n`);
  state.printed = true;
  out.push(lsRender(ctx, entries, opts));

  const subdirs = sortEntries(entries, opts).filter(
    (e) => e.st.isDir && e.name !== '.' && e.name !== '..',
  );
  for (const sub of subdirs) lsDirRecursive(ctx, sub.path, opts, out, errors, state);
}

const ls = {
  name: 'ls',
  aliases: [],
  synopsis: 'ls [OPTION]... [FILE]...',
  description: 'List directory contents',
  man: `NAME
       ls - list directory contents

SYNOPSIS
       ls [OPTION]... [FILE]...

DESCRIPTION
       List information about the FILEs (the current directory by default).
       Sort entries alphabetically unless -t or -S is given.

       -a, --all                  do not ignore entries starting with .
       -A, --almost-all           do not list implied . and ..
       -d, --directory            list directories themselves, not their contents
       -F, --classify             append indicator (one of */=>@|) to entries
       -h, --human-readable       with -l, print sizes like 1K 234M 2G
       -i, --inode                print the index number of each file
       -l                         use a long listing format
       -r, --reverse              reverse order while sorting
       -R, --recursive            list subdirectories recursively
       -S                         sort by file size, largest first
       -t                         sort by modification time, newest first
       -1                         list one file per line
           --color[=WHEN]         colorize the output; WHEN is 'always',
                                  'auto' (default) or 'never'`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'w');
    if (p.bad) {
      return {
        stdout: '',
        stderr: `ls: invalid option -- '${p.bad}'\nTry 'ls --help' for more information.\n`,
        code: 2,
      };
    }

    const f = p.flags;
    const L = p.longs;
    const colorWhen =
      L.color === undefined ? 'auto' : L.color === true ? 'always' : String(L.color);
    const opts = {
      all: f.has('a') || L.all === true,
      almost: f.has('A') || L['almost-all'] === true,
      long: f.has('l') || L.format === 'long' || f.has('o') || f.has('g'),
      human: f.has('h') || L['human-readable'] === true,
      recursive: f.has('R') || L.recursive === true,
      reverse: f.has('r') || L.reverse === true,
      classify: f.has('F') || L.classify === true,
      inode: f.has('i') || L.inode === true,
      dirOnly: f.has('d') || L.directory === true,
      // GNU ls only packs entries into columns when stdout is a terminal.
      // Piped or redirected, it prints one entry per line — which is what
      // makes `ls | wc -l` count files rather than report 1.
      oneLine:
        f.has('1') ||
        (!isTTY(ctx) && !(f.has('l') || f.has('o') || f.has('g') || L.format === 'long') && !f.has('C')),
      showTotal: true,
      sortBy: 'name',
      width: Number(p.values.w) > 0 ? Number(p.values.w) : termCols(ctx),
      color: colorWhen === 'always' || colorWhen === 'force' || (colorWhen === 'auto' && isTTY(ctx)),
    };
    if (f.has('t')) opts.sortBy = 'time';
    else if (f.has('S')) opts.sortBy = 'size';
    else if (f.has('U') || L.sort === 'none') opts.sortBy = 'none';
    if (L.sort === 'time') opts.sortBy = 'time';
    if (L.sort === 'size') opts.sortBy = 'size';

    const operands = p.operands.length ? p.operands : ['.'];
    const out = [];
    const errors = [];
    const state = { code: 0, printed: false };

    const fileArgs = [];
    const dirArgs = [];
    for (const arg of operands) {
      const target = abs(ctx, arg);
      let st;
      try {
        st = ctx.fs.lstat(target);
      } catch (err) {
        errors.push(`ls: cannot access '${arg}': ${phrase(err)}\n`);
        state.code = 2;
        continue;
      }
      const followed = st.isLink && !opts.dirOnly && !opts.long ? ctx.fs.isDir(target) : st.isDir;
      if (!opts.dirOnly && followed) dirArgs.push({ arg, path: st.isLink ? realpathOf(ctx.fs, target) : target });
      else fileArgs.push({ name: arg, path: target, st });
    }

    if (fileArgs.length) {
      const entries = fileArgs.map((e) => ({ name: e.name, path: e.path, st: e.st }));
      const saved = opts.showTotal;
      opts.showTotal = false;
      out.push(lsRender(ctx, entries, opts));
      opts.showTotal = saved;
      state.printed = true;
    }

    dirArgs.sort((a, b) => collate(a.arg, b.arg));
    const multi = dirArgs.length + (fileArgs.length ? 1 : 0) > 1 || opts.recursive;

    for (const d of dirArgs) {
      if (opts.recursive) {
        lsDirRecursive(ctx, d.path, opts, out, errors, state);
        continue;
      }
      let entries;
      try {
        entries = lsCollect(ctx, d.path, opts);
      } catch (err) {
        errors.push(`ls: cannot open directory '${d.arg}': ${phrase(err)}\n`);
        state.code = 2;
        continue;
      }
      if (multi) {
        if (state.printed) out.push('\n');
        out.push(`${d.arg}:\n`);
      }
      state.printed = true;
      out.push(lsRender(ctx, entries, opts));
    }

    return result(out, errors, state.code);
  },
};

/* ================================================================== *
 * mkdir / rmdir
 * ================================================================== */

const mkdir = {
  name: 'mkdir',
  aliases: [],
  synopsis: 'mkdir [OPTION]... DIRECTORY...',
  description: 'Create the DIRECTORY(ies), if they do not already exist',
  man: `NAME
       mkdir - make directories

SYNOPSIS
       mkdir [OPTION]... DIRECTORY...

DESCRIPTION
       Create the DIRECTORY(ies), if they do not already exist.

       -m, --mode=MODE   set file mode (as in chmod), not a=rwx - umask
       -p, --parents     no error if existing, make parent directories as needed
       -v, --verbose     print a message for each created directory`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'm');
    const parents = p.flags.has('p') || p.longs.parents === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;
    const modeArg = p.values.m !== undefined ? p.values.m : p.longs.mode;
    let mode = 0o755;
    if (typeof modeArg === 'string' && modeArg !== '') {
      if (/^[0-7]{1,4}$/.test(modeArg)) mode = parseInt(modeArg, 8);
      else {
        const applied = applySymbolicMode(modeArg, 0o755, true);
        if (applied === null) {
          return { stdout: '', stderr: `mkdir: invalid mode '${modeArg}'\n`, code: 1 };
        }
        mode = applied;
      }
    }

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "mkdir: missing operand\nTry 'mkdir --help' for more information.\n",
        code: 1,
      };
    }

    const out = [];
    const errors = [];
    let code = 0;
    for (const arg of p.operands) {
      const target = abs(ctx, arg);
      try {
        if (!parents && ctx.fs.lexists(target)) {
          errors.push(`mkdir: cannot create directory '${arg}': File exists\n`);
          code = 1;
          continue;
        }
        if (parents && ctx.fs.isDir(target)) continue;
        ctx.fs.mkdir(target, { parents, mode });
        if (verbose) out.push(`mkdir: created directory '${arg}'\n`);
      } catch (err) {
        errors.push(`mkdir: cannot create directory '${arg}': ${phrase(err)}\n`);
        code = 1;
      }
    }
    return result(out, errors, code);
  },
};

const rmdir = {
  name: 'rmdir',
  aliases: [],
  synopsis: 'rmdir [OPTION]... DIRECTORY...',
  description: 'Remove the DIRECTORY(ies), if they are empty',
  man: `NAME
       rmdir - remove empty directories

SYNOPSIS
       rmdir [OPTION]... DIRECTORY...

DESCRIPTION
       Remove the DIRECTORY(ies), if they are empty.

           --ignore-fail-on-non-empty
                  ignore each failure that is solely because a directory is non-empty
       -p, --parents   remove DIRECTORY and its ancestors
       -v, --verbose   output a diagnostic for every directory processed`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const parents = p.flags.has('p') || p.longs.parents === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;
    const ignoreNonEmpty = p.longs['ignore-fail-on-non-empty'] === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "rmdir: missing operand\nTry 'rmdir --help' for more information.\n",
        code: 1,
      };
    }

    const out = [];
    const errors = [];
    let code = 0;

    const removeOne = (display, target) => {
      try {
        ctx.fs.rmdir(target);
        if (verbose) out.push(`rmdir: removing directory, '${display}'\n`);
        return true;
      } catch (err) {
        if (err && err.code === 'ENOTEMPTY' && ignoreNonEmpty) return false;
        errors.push(`rmdir: failed to remove '${display}': ${phrase(err)}\n`);
        code = 1;
        return false;
      }
    };

    for (const arg of p.operands) {
      let display = arg.replace(/\/+$/, '') || '/';
      let target = abs(ctx, arg);
      if (!removeOne(display, target)) continue;
      if (!parents) continue;
      while (display.indexOf('/') > 0) {
        display = pathmod.dirname(display);
        target = pathmod.dirname(target);
        if (display === '.' || display === '/' || target === '/') break;
        if (!removeOne(display, target)) break;
      }
    }
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * rm
 * ================================================================== */

const rm = {
  name: 'rm',
  aliases: [],
  synopsis: 'rm [OPTION]... [FILE]...',
  description: 'Remove files or directories',
  man: `NAME
       rm - remove files or directories

SYNOPSIS
       rm [OPTION]... [FILE]...

DESCRIPTION
       rm removes each specified file. By default it does not remove directories.

       -f, --force       ignore nonexistent files and arguments, never prompt
       -i                prompt before every removal
       -r, -R, --recursive   remove directories and their contents recursively
       -d, --dir         remove empty directories
       -v, --verbose     explain what is being done
           --no-preserve-root  do not treat '/' specially`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const force = p.flags.has('f') || p.longs.force === true;
    const interactive = (p.flags.has('i') || p.longs.interactive !== undefined) && !force;
    const recursive = p.flags.has('r') || p.flags.has('R') || p.longs.recursive === true;
    const dirFlag = p.flags.has('d') || p.longs.dir === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;
    const noPreserveRoot = p.longs['no-preserve-root'] === true;

    if (p.operands.length === 0) {
      if (force) return ok('');
      return {
        stdout: '',
        stderr: "rm: missing operand\nTry 'rm --help' for more information.\n",
        code: 1,
      };
    }

    const out = [];
    const errors = [];
    let code = 0;

    for (const arg of p.operands) {
      const target = abs(ctx, arg);

      if (target === '/' && !noPreserveRoot) {
        errors.push("rm: it is dangerous to operate recursively on '/'\n");
        errors.push('rm: use --no-preserve-root to override this failsafe\n');
        code = 1;
        continue;
      }
      const base = pathmod.basename(target);
      if (base === '.' || base === '..' || arg === '.' || arg === '..') {
        errors.push(`rm: refusing to remove '.' or '..' directory: skipping '${arg}'\n`);
        code = 1;
        continue;
      }

      let st;
      try {
        st = ctx.fs.lstat(target);
      } catch (err) {
        if (!force) {
          errors.push(`rm: cannot remove '${arg}': ${phrase(err)}\n`);
          code = 1;
        }
        continue;
      }

      if (st.isDir && !recursive) {
        if (dirFlag) {
          try {
            ctx.fs.rmdir(target);
            if (verbose) out.push(`removed directory '${arg}'\n`);
          } catch (err) {
            errors.push(`rm: cannot remove '${arg}': ${phrase(err)}\n`);
            code = 1;
          }
          continue;
        }
        errors.push(`rm: cannot remove '${arg}': Is a directory\n`);
        code = 1;
        continue;
      }

      if (interactive) {
        const kind = st.isDir ? 'directory' : st.size === 0 ? 'regular empty file' : 'regular file';
        const answer = await confirm(ctx, `rm: remove ${kind} '${arg}'? `);
        if (!answer) continue;
      }

      try {
        ctx.fs.rm(target, { recursive, force });
        if (verbose) out.push(st.isDir ? `removed directory '${arg}'\n` : `removed '${arg}'\n`);
      } catch (err) {
        if (!force) {
          errors.push(`rm: cannot remove '${arg}': ${phrase(err)}\n`);
          code = 1;
        }
      }
    }
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * cp / mv
 * ================================================================== */

async function copyOrMove(ctx, cmd) {
  const p = optParse(ctx.argv, 't');
  const force = p.flags.has('f') || p.longs.force === true;
  const interactive = p.flags.has('i') || p.longs.interactive === true;
  const noClobber = p.flags.has('n') || p.longs['no-clobber'] === true;
  const verbose = p.flags.has('v') || p.longs.verbose === true;
  const recursive =
    cmd === 'cp' && (p.flags.has('r') || p.flags.has('R') || p.flags.has('a') || p.longs.recursive === true || p.longs.archive === true);

  const operands = p.operands.slice();
  const targetDirOpt = p.values.t !== undefined ? p.values.t : p.longs['target-directory'];
  const noTargetDir = p.flags.has('T') || p.longs['no-target-directory'] === true;

  if (operands.length === 0 || (operands.length === 1 && targetDirOpt === undefined)) {
    const missing = operands.length === 0 ? 'missing file operand' : `missing destination file operand after '${operands[0]}'`;
    return {
      stdout: '',
      stderr: `${cmd}: ${missing}\nTry '${cmd} --help' for more information.\n`,
      code: 1,
    };
  }

  let destArg;
  let sources;
  if (typeof targetDirOpt === 'string') {
    destArg = targetDirOpt;
    sources = operands;
  } else {
    destArg = operands[operands.length - 1];
    sources = operands.slice(0, -1);
  }

  const destPath = abs(ctx, destArg);
  const destIsDir = !noTargetDir && ctx.fs.isDir(destPath);

  if (sources.length > 1 && !destIsDir) {
    return { stdout: '', stderr: `${cmd}: target '${destArg}' is not a directory\n`, code: 1 };
  }

  const out = [];
  const errors = [];
  let code = 0;

  for (const srcArg of sources) {
    const srcPath = abs(ctx, srcArg);
    let st;
    try {
      st = ctx.fs.lstat(srcPath);
    } catch (err) {
      errors.push(`${cmd}: cannot stat '${srcArg}': ${phrase(err)}\n`);
      code = 1;
      continue;
    }

    const finalPath = destIsDir
      ? (destPath === '/' ? `/${pathmod.basename(srcPath)}` : `${destPath}/${pathmod.basename(srcPath)}`)
      : destPath;
    const finalDisplay = destIsDir
      ? `${destArg.replace(/\/+$/, '')}/${pathmod.basename(srcPath)}`
      : destArg;

    if (finalPath === srcPath) {
      errors.push(`${cmd}: '${srcArg}' and '${finalDisplay}' are the same file\n`);
      code = 1;
      continue;
    }

    if (cmd === 'cp' && st.isDir && !recursive) {
      errors.push(`cp: -r not specified; omitting directory '${srcArg}'\n`);
      code = 1;
      continue;
    }

    const exists = ctx.fs.lexists(finalPath);
    if (exists && noClobber) continue;
    if (exists && interactive && !force) {
      const answer = await confirm(ctx, `${cmd}: overwrite '${finalDisplay}'? `);
      if (!answer) continue;
    }

    try {
      if (exists && force) {
        try {
          ctx.fs.rm(finalPath, { recursive: true, force: true });
        } catch {
          /* fall through to the copy which will overwrite in place */
        }
      }
      if (cmd === 'cp') ctx.fs.cp(srcPath, finalPath, { recursive });
      else ctx.fs.mv(srcPath, finalPath);
      if (verbose) out.push(`'${srcArg}' -> '${finalDisplay}'\n`);
    } catch (err) {
      errors.push(`${cmd}: cannot ${cmd === 'cp' ? 'copy' : 'move'} '${srcArg}' to '${finalDisplay}': ${phrase(err)}\n`);
      code = 1;
    }
  }
  return result(out, errors, code);
}

const cp = {
  name: 'cp',
  aliases: [],
  synopsis: 'cp [OPTION]... SOURCE... DEST',
  description: 'Copy files and directories',
  man: `NAME
       cp - copy files and directories

SYNOPSIS
       cp [OPTION]... SOURCE DEST
       cp [OPTION]... SOURCE... DIRECTORY

DESCRIPTION
       Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.

       -f, --force        remove an existing destination file and try again
       -i, --interactive  prompt before overwrite
       -n, --no-clobber   do not overwrite an existing file
       -r, -R, --recursive  copy directories recursively
       -t, --target-directory=DIRECTORY  copy all SOURCE arguments into DIRECTORY
       -v, --verbose      explain what is being done`,
  run(ctx) {
    return copyOrMove(ctx, 'cp');
  },
};

const mv = {
  name: 'mv',
  aliases: [],
  synopsis: 'mv [OPTION]... SOURCE... DEST',
  description: 'Move (rename) files',
  man: `NAME
       mv - move (rename) files

SYNOPSIS
       mv [OPTION]... SOURCE DEST
       mv [OPTION]... SOURCE... DIRECTORY

DESCRIPTION
       Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.

       -f, --force        do not prompt before overwriting
       -i, --interactive  prompt before overwrite
       -n, --no-clobber   do not overwrite an existing file
       -t, --target-directory=DIRECTORY  move all SOURCE arguments into DIRECTORY
       -v, --verbose      explain what is being done`,
  run(ctx) {
    return copyOrMove(ctx, 'mv');
  },
};

/* ================================================================== *
 * touch / ln
 * ================================================================== */

const touch = {
  name: 'touch',
  aliases: [],
  synopsis: 'touch [OPTION]... FILE...',
  description: 'Change file timestamps',
  man: `NAME
       touch - change file timestamps

SYNOPSIS
       touch [OPTION]... FILE...

DESCRIPTION
       Update the access and modification times of each FILE to the current
       time. A FILE argument that does not exist is created empty.

       -a                 change only the access time
       -c, --no-create    do not create any files
       -m                 change only the modification time`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'rdt');
    const noCreate = p.flags.has('c') || p.longs['no-create'] === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "touch: missing file operand\nTry 'touch --help' for more information.\n",
        code: 1,
      };
    }

    const errors = [];
    let code = 0;
    for (const arg of p.operands) {
      const target = abs(ctx, arg);
      const exists = ctx.fs.lexists(target);
      if (!exists && noCreate) continue;
      try {
        ctx.fs.touch(target);
      } catch (err) {
        errors.push(`touch: cannot touch '${arg}': ${phrase(err)}\n`);
        code = 1;
      }
    }
    return result([], errors, code);
  },
};

const ln = {
  name: 'ln',
  aliases: [],
  synopsis: 'ln [OPTION]... TARGET... [LINK_NAME]',
  description: 'Make links between files',
  man: `NAME
       ln - make links between files

SYNOPSIS
       ln [OPTION]... TARGET LINK_NAME
       ln [OPTION]... TARGET... DIRECTORY

DESCRIPTION
       Create a link to TARGET with the name LINK_NAME.

       -f, --force        remove existing destination files
       -s, --symbolic     make symbolic links instead of hard links
       -v, --verbose      print name of each linked file`,

  async run(ctx) {
    const p = optParse(ctx.argv, 't');
    const symbolic = p.flags.has('s') || p.longs.symbolic === true;
    const force = p.flags.has('f') || p.longs.force === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "ln: missing file operand\nTry 'ln --help' for more information.\n",
        code: 1,
      };
    }

    let targets = p.operands.slice();
    let linkArg = null;
    if (targets.length > 1) {
      linkArg = targets[targets.length - 1];
      targets = targets.slice(0, -1);
    }

    const out = [];
    const errors = [];
    let code = 0;
    const linkPathBase = linkArg === null ? null : abs(ctx, linkArg);
    const intoDir = linkPathBase !== null && ctx.fs.isDir(linkPathBase);

    if (targets.length > 1 && !intoDir) {
      return { stdout: '', stderr: `ln: target '${linkArg}' is not a directory\n`, code: 1 };
    }

    for (const targetArg of targets) {
      const name = pathmod.basename(targetArg.replace(/\/+$/, '')) || targetArg;
      const linkPath =
        linkArg === null
          ? abs(ctx, name)
          : intoDir
            ? (linkPathBase === '/' ? `/${name}` : `${linkPathBase}/${name}`)
            : linkPathBase;
      const linkDisplay =
        linkArg === null ? `./${name}` : intoDir ? `${linkArg.replace(/\/+$/, '')}/${name}` : linkArg;

      if (!symbolic) {
        const srcPath = abs(ctx, targetArg);
        if (!ctx.fs.lexists(srcPath)) {
          errors.push(`ln: failed to access '${targetArg}': No such file or directory\n`);
          code = 1;
          continue;
        }
        if (ctx.fs.isDir(srcPath)) {
          errors.push(`ln: '${targetArg}': hard link not allowed for directory\n`);
          code = 1;
          continue;
        }
      }

      try {
        if (ctx.fs.lexists(linkPath)) {
          if (!force) {
            errors.push(`ln: failed to create ${symbolic ? 'symbolic ' : ''}link '${linkDisplay}': File exists\n`);
            code = 1;
            continue;
          }
          ctx.fs.rm(linkPath, { force: true });
        }
        if (symbolic) ctx.fs.symlink(targetArg, linkPath);
        else ctx.fs.cp(abs(ctx, targetArg), linkPath, { recursive: false });
        if (verbose) out.push(`'${linkDisplay}' -> '${targetArg}'\n`);
      } catch (err) {
        errors.push(`ln: failed to create ${symbolic ? 'symbolic ' : ''}link '${linkDisplay}': ${phrase(err)}\n`);
        code = 1;
      }
    }
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * cat / tac
 * ================================================================== */

function catTransform(text, opts) {
  if (!opts.number && !opts.numberNonBlank && !opts.showEnds && !opts.showTabs && !opts.showNonPrinting && !opts.squeeze) {
    return text;
  }
  const { lines, trailing } = splitLines(text);
  const out = [];
  let counter = 0;
  let blankRun = 0;

  for (const raw of lines) {
    if (opts.squeeze) {
      if (raw === '') {
        blankRun += 1;
        if (blankRun > 1) continue;
      } else {
        blankRun = 0;
      }
    }
    let line = raw;
    if (opts.showNonPrinting) {
      line = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (ch) => {
        const code = ch.charCodeAt(0);
        if (code === 127) return '^?';
        return `^${String.fromCharCode(code + 64)}`;
      });
    }
    if (opts.showTabs) line = line.split('\t').join('^I');
    if (opts.showEnds) line += '$';
    if (opts.numberNonBlank) {
      if (raw !== '') {
        counter += 1;
        line = `${padLeft(String(counter), 6)}\t${line}`;
      }
    } else if (opts.number) {
      counter += 1;
      line = `${padLeft(String(counter), 6)}\t${line}`;
    }
    out.push(line);
  }
  return out.join('\n') + (out.length && trailing ? '\n' : out.length ? '' : '');
}

const cat = {
  name: 'cat',
  aliases: [],
  synopsis: 'cat [OPTION]... [FILE]...',
  description: 'Concatenate files and print on the standard output',
  man: `NAME
       cat - concatenate files and print on the standard output

SYNOPSIS
       cat [OPTION]... [FILE]...

DESCRIPTION
       Concatenate FILE(s) to standard output. With no FILE, or when FILE is -,
       read standard input.

       -A, --show-all           equivalent to -vET
       -b, --number-nonblank    number nonempty output lines, overrides -n
       -E, --show-ends          display $ at end of each line
       -n, --number             number all output lines
       -s, --squeeze-blank      suppress repeated empty output lines
       -T, --show-tabs          display TAB characters as ^I
       -v, --show-nonprinting   use ^ and M- notation`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const showAll = p.flags.has('A') || p.longs['show-all'] === true;
    const opts = {
      number: p.flags.has('n') || p.longs.number === true,
      numberNonBlank: p.flags.has('b') || p.longs['number-nonblank'] === true,
      showEnds: showAll || p.flags.has('E') || p.longs['show-ends'] === true,
      showTabs: showAll || p.flags.has('T') || p.longs['show-tabs'] === true,
      showNonPrinting: showAll || p.flags.has('v') || p.longs['show-nonprinting'] === true,
      squeeze: p.flags.has('s') || p.longs['squeeze-blank'] === true,
    };
    if (opts.numberNonBlank) opts.number = false;

    const read = readInputs(ctx, p.operands, 'cat', 'plain');
    const out = [];
    for (const item of read.items) out.push(catTransform(item.text, opts));
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

const tac = {
  name: 'tac',
  aliases: [],
  synopsis: 'tac [OPTION]... [FILE]...',
  description: 'Concatenate and print files in reverse',
  man: `NAME
       tac - concatenate and print files in reverse

SYNOPSIS
       tac [OPTION]... [FILE]...

DESCRIPTION
       Write each FILE to standard output, last line first.

       -s, --separator=STRING   use STRING as the separator instead of newline`,

  async run(ctx) {
    const p = optParse(ctx.argv, 's');
    const sep = p.values.s !== undefined ? p.values.s : typeof p.longs.separator === 'string' ? p.longs.separator : '\n';
    const read = readInputs(ctx, p.operands, 'tac', 'plain');
    const out = [];
    for (const item of read.items) {
      if (item.text === '') continue;
      const trailing = item.text.endsWith(sep);
      const body = trailing ? item.text.slice(0, item.text.length - sep.length) : item.text;
      const parts = body.split(sep);
      parts.reverse();
      out.push(parts.map((line) => line + sep).join(''));
    }
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * head / tail
 * ================================================================== */

/** Rewrite `-5` into `-n 5` so GNU's obsolete syntax keeps working. */
function expandCountShorthand(argv) {
  const out = [];
  for (const a of argv) {
    const m = /^-([0-9]+)$/.exec(a);
    if (m) {
      out.push('-n', m[1]);
      continue;
    }
    out.push(a);
  }
  return out;
}

function headText(text, opts) {
  if (opts.bytes !== null) {
    if (opts.fromEnd) return text.slice(0, Math.max(0, text.length - opts.bytes));
    return text.slice(0, opts.bytes);
  }
  const { lines, trailing } = splitLines(text);
  const count = opts.fromEnd ? Math.max(0, lines.length - opts.lines) : Math.min(opts.lines, lines.length);
  const picked = lines.slice(0, count);
  if (picked.length === 0) return '';
  const complete = count < lines.length || trailing;
  return picked.join('\n') + (complete ? '\n' : '');
}

function tailText(text, opts) {
  if (opts.bytes !== null) {
    if (opts.fromStart) return text.slice(Math.max(0, opts.bytes - 1));
    return text.slice(Math.max(0, text.length - opts.bytes));
  }
  const { lines, trailing } = splitLines(text);
  const picked = opts.fromStart ? lines.slice(Math.max(0, opts.lines - 1)) : lines.slice(Math.max(0, lines.length - opts.lines));
  if (picked.length === 0) return '';
  return picked.join('\n') + (trailing ? '\n' : '');
}

function parseCount(raw) {
  const s = String(raw).trim();
  const m = /^([+-]?)(\d+)([bkKmMgG]?)$/.exec(s);
  if (!m) return null;
  const mult = { '': 1, b: 512, k: 1024, K: 1024, m: 1048576, M: 1048576, g: 1073741824, G: 1073741824 }[m[3]];
  return { sign: m[1], value: Number(m[2]) * mult };
}

const head = {
  name: 'head',
  aliases: [],
  synopsis: 'head [OPTION]... [FILE]...',
  description: 'Output the first part of files',
  man: `NAME
       head - output the first part of files

SYNOPSIS
       head [OPTION]... [FILE]...

DESCRIPTION
       Print the first 10 lines of each FILE to standard output.

       -c, --bytes=[-]NUM   print the first NUM bytes of each file
       -n, --lines=[-]NUM   print the first NUM lines instead of the first 10
       -q, --quiet          never print headers giving file names
       -v, --verbose        always print headers giving file names`,

  async run(ctx) {
    const p = optParse(expandCountShorthand(ctx.argv), 'nc');
    const nRaw = p.values.n !== undefined ? p.values.n : p.longs.lines;
    const cRaw = p.values.c !== undefined ? p.values.c : p.longs.bytes;
    const opts = { lines: 10, bytes: null, fromEnd: false };

    if (typeof cRaw === 'string') {
      const parsed = parseCount(cRaw);
      if (!parsed) return { stdout: '', stderr: `head: invalid number of bytes: '${cRaw}'\n`, code: 1 };
      opts.bytes = parsed.value;
      opts.fromEnd = parsed.sign === '-';
    } else if (typeof nRaw === 'string') {
      const parsed = parseCount(nRaw);
      if (!parsed) return { stdout: '', stderr: `head: invalid number of lines: '${nRaw}'\n`, code: 1 };
      opts.lines = parsed.value;
      opts.fromEnd = parsed.sign === '-';
    }

    const quiet = p.flags.has('q') || p.longs.quiet === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;
    const read = readInputs(ctx, p.operands, 'head', 'open');
    const showHeaders = verbose || (!quiet && read.items.length > 1);

    const out = [];
    read.items.forEach((item, index) => {
      if (showHeaders) {
        if (index > 0) out.push('\n');
        out.push(`==> ${item.name === '-' ? 'standard input' : item.name} <==\n`);
      }
      out.push(headText(item.text, opts));
    });
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

const tail = {
  name: 'tail',
  aliases: [],
  synopsis: 'tail [OPTION]... [FILE]...',
  description: 'Output the last part of files',
  man: `NAME
       tail - output the last part of files

SYNOPSIS
       tail [OPTION]... [FILE]...

DESCRIPTION
       Print the last 10 lines of each FILE to standard output.

       -c, --bytes=[+]NUM   output the last NUM bytes
       -f, --follow         output appended data as the file grows
       -n, --lines=[+]NUM   output the last NUM lines instead of the last 10
       -q, --quiet          never print headers giving file names
       -v, --verbose        always print headers giving file names

       With -f, tail keeps running until interrupted with Ctrl+C.`,

  async run(ctx) {
    const p = optParse(expandCountShorthand(ctx.argv), 'nc');
    const nRaw = p.values.n !== undefined ? p.values.n : p.longs.lines;
    const cRaw = p.values.c !== undefined ? p.values.c : p.longs.bytes;
    const opts = { lines: 10, bytes: null, fromStart: false };

    if (typeof cRaw === 'string') {
      const parsed = parseCount(cRaw);
      if (!parsed) return { stdout: '', stderr: `tail: invalid number of bytes: '${cRaw}'\n`, code: 1 };
      opts.bytes = parsed.value;
      opts.fromStart = parsed.sign === '+';
    } else if (typeof nRaw === 'string') {
      const parsed = parseCount(nRaw);
      if (!parsed) return { stdout: '', stderr: `tail: invalid number of lines: '${nRaw}'\n`, code: 1 };
      opts.lines = parsed.value;
      opts.fromStart = parsed.sign === '+';
    }

    const follow = p.flags.has('f') || p.flags.has('F') || p.longs.follow !== undefined;
    const quiet = p.flags.has('q') || p.longs.quiet === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;
    const read = readInputs(ctx, p.operands, 'tail', 'open');
    const showHeaders = verbose || (!quiet && read.items.length > 1);

    const out = [];
    read.items.forEach((item, index) => {
      if (showHeaders) {
        if (index > 0) out.push('\n');
        out.push(`==> ${item.name === '-' ? 'standard input' : item.name} <==\n`);
      }
      out.push(tailText(item.text, opts));
    });

    if (!follow || !ctx.term || typeof ctx.term.write !== 'function') {
      return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
    }

    /* --- tail -f: stream to the terminal until Ctrl+C --- */
    ctx.term.write(out.join(''));
    const watched = read.items
      .filter((i) => i.name !== '-')
      .map((i) => ({ name: i.name, path: abs(ctx, i.name), seen: i.text.length }));

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        offBus();
        if (ctx.signal && typeof ctx.signal.removeEventListener === 'function') {
          ctx.signal.removeEventListener('abort', finish);
        }
        resolve();
      };

      const offBus = bus.on('fs:change', (payload) => {
        if (!payload || typeof payload.path !== 'string') return;
        for (const w of watched) {
          if (payload.path !== w.path && payload.to !== w.path) continue;
          let text = '';
          try {
            text = ctx.fs.readFile(w.path);
          } catch {
            continue;
          }
          if (text.length > w.seen) {
            const chunk = text.slice(w.seen);
            if (watched.length > 1) ctx.term.write(`\n==> ${w.name} <==\n`);
            ctx.term.write(chunk);
          }
          w.seen = text.length;
        }
      });

      if (ctx.signal) {
        if (ctx.signal.aborted) finish();
        else ctx.signal.addEventListener('abort', finish, { once: true });
      }
    });

    return { stdout: '', stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * wc
 * ================================================================== */

function countText(text) {
  const bytes = new TextEncoder().encode(text).length;
  const chars = Array.from(text).length;
  const { lines } = splitLines(text);
  const lineCount = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const words = text.split(/\s+/).filter((w) => w !== '').length;
  let maxLine = 0;
  for (const l of lines) if (l.length > maxLine) maxLine = l.length;
  return { lines: lineCount, words, bytes, chars, maxLine };
}

const wc = {
  name: 'wc',
  aliases: [],
  synopsis: 'wc [OPTION]... [FILE]...',
  description: 'Print newline, word, and byte counts for each file',
  man: `NAME
       wc - print newline, word, and byte counts for each file

SYNOPSIS
       wc [OPTION]... [FILE]...

DESCRIPTION
       Print newline, word, and byte counts for each FILE, and a total line if
       more than one FILE is specified.

       -c, --bytes            print the byte counts
       -m, --chars            print the character counts
       -l, --lines            print the newline counts
       -L, --max-line-length  print the maximum display width
       -w, --words            print the word counts`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const want = {
      lines: p.flags.has('l') || p.longs.lines === true,
      words: p.flags.has('w') || p.longs.words === true,
      bytes: p.flags.has('c') || p.longs.bytes === true,
      chars: p.flags.has('m') || p.longs.chars === true,
      maxLine: p.flags.has('L') || p.longs['max-line-length'] === true,
    };
    if (!want.lines && !want.words && !want.bytes && !want.chars && !want.maxLine) {
      want.lines = true;
      want.words = true;
      want.bytes = true;
    }

    const read = readInputs(ctx, p.operands, 'wc', 'plain');
    const rows = [];
    const total = { lines: 0, words: 0, bytes: 0, chars: 0, maxLine: 0 };

    for (const item of read.items) {
      const counts = countText(item.text);
      total.lines += counts.lines;
      total.words += counts.words;
      total.bytes += counts.bytes;
      total.chars += counts.chars;
      if (counts.maxLine > total.maxLine) total.maxLine = counts.maxLine;
      rows.push({ counts, label: item.name === '-' ? '' : item.name });
    }
    if (rows.length > 1) rows.push({ counts: total, label: 'total' });

    const fields = (c) => {
      const list = [];
      if (want.lines) list.push(c.lines);
      if (want.words) list.push(c.words);
      if (want.chars) list.push(c.chars);
      if (want.bytes) list.push(c.bytes);
      if (want.maxLine) list.push(c.maxLine);
      return list;
    };

    let width = 1;
    if (read.usedStdin) {
      width = 7;
    } else {
      for (const r of rows) for (const v of fields(r.counts)) width = Math.max(width, String(v).length);
    }

    const out = [];
    for (const r of rows) {
      const cells = fields(r.counts).map((v) => padLeft(String(v), width));
      out.push(cells.join(' ') + (r.label ? ` ${r.label}` : '') + '\n');
    }
    return { stdout: out.join(''), stderr: read.errors.join(''), code: read.code };
  },
};

/* ================================================================== *
 * find
 * ================================================================== */

function globToRegExp(pattern, insensitive) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
      let j = i + 1;
      let negate = false;
      if (pattern[j] === '!' || pattern[j] === '^') {
        negate = true;
        j += 1;
      }
      let body = '';
      while (j < pattern.length && pattern[j] !== ']') {
        body += pattern[j] === '\\' ? '\\\\' : pattern[j];
        j += 1;
      }
      if (j >= pattern.length) {
        out += '\\[';
      } else {
        out += `[${negate ? '^' : ''}${body}]`;
        i = j;
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      i += 1;
      out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`, insensitive ? 'i' : '');
}

function parseSizeSpec(spec) {
  const m = /^([+-]?)(\d+)([bcwkMG]?)$/.exec(spec);
  if (!m) return null;
  const unit = m[3] || 'b';
  const mult = { b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 }[unit];
  return { cmp: m[1], value: Number(m[2]), unit, mult };
}

const find = {
  name: 'find',
  aliases: [],
  synopsis: 'find [PATH...] [EXPRESSION]',
  description: 'Search for files in a directory hierarchy',
  man: `NAME
       find - search for files in a directory hierarchy

SYNOPSIS
       find [PATH...] [EXPRESSION]

DESCRIPTION
       Walk the file hierarchy rooted at each PATH, evaluating EXPRESSION.

       -maxdepth LEVELS   descend at most LEVELS directories below the arguments
       -mindepth LEVELS   do not apply any tests at levels less than LEVELS
       -name PATTERN      base of file name matches shell pattern PATTERN
       -iname PATTERN     like -name, but the match is case insensitive
       -path PATTERN      full path matches shell pattern PATTERN
       -type [fdl]        file is of type f (regular), d (directory), l (link)
       -size N[bckMG]     file uses N units of space (rounded up)
       -newer FILE        file was modified more recently than FILE
       -delete            delete files; implies -depth
       -exec COMMAND ;    execute COMMAND; {} is replaced by the current file
       -print             print the full file name followed by a newline`,

  async run(ctx) {
    const argv = ctx.argv.slice();
    const paths = [];
    let i = 0;
    while (i < argv.length && argv[i] !== '' && argv[i][0] !== '-' && argv[i] !== '!' && argv[i] !== '(') {
      paths.push(argv[i]);
      i += 1;
    }
    if (paths.length === 0) paths.push('.');

    const tests = [];
    const actions = [];
    let maxDepth = Infinity;
    let minDepth = 0;
    const errors = [];
    let code = 0;

    const need = (opt) => {
      i += 1;
      if (i >= argv.length) {
        errors.push(`find: missing argument to '${opt}'\n`);
        code = 1;
        return null;
      }
      return argv[i];
    };

    while (i < argv.length) {
      const tok = argv[i];
      let negate = false;
      if (tok === '!' || tok === '-not') {
        negate = true;
        i += 1;
        if (i >= argv.length) break;
      }
      const opt = argv[i];
      switch (opt) {
        case '-maxdepth': {
          const v = need(opt);
          if (v === null) return result([], errors, code);
          maxDepth = Number(v);
          break;
        }
        case '-mindepth': {
          const v = need(opt);
          if (v === null) return result([], errors, code);
          minDepth = Number(v);
          break;
        }
        case '-name':
        case '-iname': {
          const v = need(opt);
          if (v === null) return result([], errors, code);
          const re = globToRegExp(v, opt === '-iname');
          tests.push({ negate, fn: (e) => re.test(pathmod.basename(e.display)) });
          break;
        }
        case '-path':
        case '-ipath':
        case '-wholename': {
          const v = need(opt);
          if (v === null) return result([], errors, code);
          const re = globToRegExp(v, opt === '-ipath');
          tests.push({ negate, fn: (e) => re.test(e.display) });
          break;
        }
        case '-type': {
          const v = need(opt);
          if (v === null) return result([], errors, code);
          const kinds = v.split(',');
          tests.push({
            negate,
            fn: (e) =>
              kinds.some((k) =>
                k === 'd' ? e.st.isDir : k === 'l' ? e.st.isLink : k === 'f' ? e.st.isFile : false,
              ),
          });
          break;
        }
        case '-size': {
          const v = need(opt);
          if (v === null) return result([], errors, code);
          const spec = parseSizeSpec(v);
          if (!spec) {
            return { stdout: '', stderr: `find: invalid -size type ‘${v}’\n`, code: 1 };
          }
          tests.push({
            negate,
            fn: (e) => {
              const units = Math.ceil((Number(e.st.size) || 0) / spec.mult);
              if (spec.cmp === '+') return units > spec.value;
              if (spec.cmp === '-') return units < spec.value;
              return units === spec.value;
            },
          });
          break;
        }
        case '-newer': {
          const v = need(opt);
          if (v === null) return result([], errors, code);
          let refTime = 0;
          try {
            refTime = ctx.fs.lstat(abs(ctx, v)).mtime;
          } catch (err) {
            return { stdout: '', stderr: `find: ‘${v}’: ${phrase(err)}\n`, code: 1 };
          }
          tests.push({ negate, fn: (e) => e.st.mtime > refTime });
          break;
        }
        case '-empty':
          tests.push({
            negate,
            fn: (e) => {
              if (e.st.isDir) {
                try {
                  return ctx.fs.readdir(e.path).length === 0;
                } catch {
                  return false;
                }
              }
              return (Number(e.st.size) || 0) === 0;
            },
          });
          break;
        case '-print':
          actions.push({ kind: 'print' });
          break;
        case '-print0':
          actions.push({ kind: 'print0' });
          break;
        case '-delete':
          actions.push({ kind: 'delete' });
          break;
        case '-exec': {
          const parts = [];
          i += 1;
          let terminator = ';';
          while (i < argv.length && argv[i] !== ';' && argv[i] !== '\\;' && argv[i] !== '+') {
            parts.push(argv[i]);
            i += 1;
          }
          if (i >= argv.length) {
            return { stdout: '', stderr: "find: missing argument to `-exec'\n", code: 1 };
          }
          terminator = argv[i] === '+' ? '+' : ';';
          actions.push({ kind: 'exec', parts, terminator });
          break;
        }
        case '-a':
        case '-and':
        case '-depth':
        case '-nowarn':
          break;
        default:
          if (opt !== undefined) {
            return {
              stdout: '',
              stderr: `find: unknown predicate ‘${opt}’\n`,
              code: 1,
            };
          }
      }
      i += 1;
    }

    const hasPrint = actions.some((a) => a.kind === 'print' || a.kind === 'print0');
    const hasOther = actions.some((a) => a.kind !== 'print' && a.kind !== 'print0');
    if (!hasPrint && !hasOther) actions.push({ kind: 'print' });

    const out = [];
    const collected = [];

    const matches = (entry) => tests.every((t) => (t.negate ? !t.fn(entry) : t.fn(entry)));

    const walk = (absPath, display, depth) => {
      if (depth > maxDepth) return;
      let st;
      try {
        st = ctx.fs.lstat(absPath);
      } catch (err) {
        errors.push(`find: ‘${display}’: ${phrase(err)}\n`);
        code = 1;
        return;
      }
      const entry = { path: absPath, display, depth, st };
      if (depth >= minDepth && matches(entry)) collected.push(entry);
      if (!st.isDir || depth >= maxDepth) return;
      let names;
      try {
        names = ctx.fs.readdir(absPath);
      } catch (err) {
        errors.push(`find: ‘${display}’: ${phrase(err)}\n`);
        code = 1;
        return;
      }
      for (const name of names) {
        const childAbs = absPath === '/' ? `/${name}` : `${absPath}/${name}`;
        const childDisplay = display === '/' ? `/${name}` : `${display}/${name}`;
        walk(childAbs, childDisplay, depth + 1);
      }
    };

    for (const startArg of paths) {
      const startAbs = abs(ctx, startArg);
      const display = startArg.length > 1 ? startArg.replace(/\/+$/, '') : startArg;
      if (!ctx.fs.lexists(startAbs)) {
        errors.push(`find: ‘${startArg}’: No such file or directory\n`);
        code = 1;
        continue;
      }
      walk(startAbs, display, 0);
    }

    const deleteAction = actions.some((a) => a.kind === 'delete');
    const ordered = deleteAction ? collected.slice().reverse() : collected;

    for (const entry of ordered) {
      if (ctx.signal && ctx.signal.aborted) break;
      for (const action of actions) {
        if (action.kind === 'print') {
          out.push(`${entry.display}\n`);
        } else if (action.kind === 'print0') {
          out.push(`${entry.display}\u0000`);
        } else if (action.kind === 'delete') {
          try {
            ctx.fs.rm(entry.path, { recursive: false, force: false });
          } catch (err) {
            if (err && err.code === 'ENOTEMPTY') {
              errors.push(`find: cannot delete ‘${entry.display}’: Directory not empty\n`);
            } else {
              errors.push(`find: cannot delete ‘${entry.display}’: ${phrase(err)}\n`);
            }
            code = 1;
          }
        } else if (action.kind === 'exec') {
          const line = action.parts
            .map((tok) => (tok === '{}' ? shellQuote(entry.display) : tok))
            .join(' ');
          try {
            const mod = await import('../shell.js');
            const res = await mod.execute(line, ctx);
            if (res && res.stdout) out.push(res.stdout);
            if (res && res.stderr) errors.push(res.stderr);
            if (res && res.code) code = res.code;
          } catch (err) {
            errors.push(`find: ${action.parts[0]}: ${err && err.message ? err.message : 'exec failed'}\n`);
            code = 1;
          }
        }
      }
    }

    return result(out, errors, code);
  },
};

/* ================================================================== *
 * tree
 * ================================================================== */

const tree = {
  name: 'tree',
  aliases: [],
  synopsis: 'tree [OPTION]... [DIRECTORY]...',
  description: 'List contents of directories in a tree-like format',
  man: `NAME
       tree - list contents of directories in a tree-like format

SYNOPSIS
       tree [OPTION]... [DIRECTORY]...

DESCRIPTION
       Tree is a recursive directory listing program that produces a depth
       indented listing of files.

       -a          All files are printed, including hidden ones
       -d          List directories only
       -f          Print the full path prefix for each file
       -F          Append '/', '=', '*', '@' or '|' as per ls -F
       -L level    Max display depth of the directory tree
       -n          Turn colorization off
       -C          Turn colorization on`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'L');
    const showAll = p.flags.has('a');
    const dirsOnly = p.flags.has('d');
    const fullPath = p.flags.has('f');
    const classify = p.flags.has('F');
    const maxLevel = p.values.L !== undefined ? Number(p.values.L) : Infinity;
    const color = p.flags.has('n') ? false : p.flags.has('C') ? true : isTTY(ctx);

    if (p.values.L !== undefined && (!Number.isFinite(maxLevel) || maxLevel < 1)) {
      return { stdout: '', stderr: 'tree: Invalid level, must be greater than 0.\n', code: 1 };
    }

    const roots = p.operands.length ? p.operands : ['.'];
    const out = [];
    const errors = [];
    let code = 0;
    let dirCount = 0;
    let fileCount = 0;

    const paint = (entryPath, st, label) => {
      if (!color) return label;
      const c = colorFor(ctx, entryPath, st);
      return c ? `${c}${label}${RESET}` : label;
    };

    const walk = (dirAbs, dirDisplay, prefix, level) => {
      if (level > maxLevel) return;
      let kids;
      try {
        kids = ctx.fs.readdir(dirAbs, { withStats: true });
      } catch (err) {
        out.push(`${prefix}[error opening dir]\n`);
        errors.push(`tree: ${dirDisplay}: ${phrase(err)}\n`);
        code = 1;
        return;
      }
      let entries = kids.filter((st) => showAll || st.name.charCodeAt(0) !== 46);
      if (dirsOnly) entries = entries.filter((st) => st.isDir);
      entries.sort((a, b) => collate(a.name, b.name));

      entries.forEach((st, index) => {
        const last = index === entries.length - 1;
        const childAbs = dirAbs === '/' ? `/${st.name}` : `${dirAbs}/${st.name}`;
        const childDisplay = dirDisplay === '/' ? `/${st.name}` : `${dirDisplay}/${st.name}`;
        let label = fullPath ? childDisplay : st.name;
        if (classify) label += classifySuffix(st);
        let line = `${prefix}${last ? '└── ' : '├── '}${paint(childAbs, st, label)}`;
        if (st.isLink) {
          let target = '';
          try {
            target = ctx.fs.readlink(childAbs);
          } catch {
            target = '';
          }
          line += ` -> ${target}`;
        }
        out.push(`${line}\n`);
        if (st.isDir) {
          dirCount += 1;
          walk(childAbs, childDisplay, `${prefix}${last ? '    ' : '│   '}`, level + 1);
        } else {
          fileCount += 1;
        }
      });
    };

    for (const rootArg of roots) {
      const rootAbs = abs(ctx, rootArg);
      let st;
      try {
        st = ctx.fs.lstat(rootAbs);
      } catch (err) {
        out.push(`${rootArg} [error opening dir]\n`);
        errors.push(`tree: ${rootArg}: ${phrase(err)}\n`);
        code = 1;
        continue;
      }
      out.push(`${paint(rootAbs, st, rootArg)}\n`);
      if (st.isDir) walk(rootAbs, rootArg, '', 1);
    }

    out.push('\n');
    out.push(
      `${dirCount} director${dirCount === 1 ? 'y' : 'ies'}` +
        (dirsOnly ? '\n' : `, ${fileCount} file${fileCount === 1 ? '' : 's'}\n`),
    );
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * du / df
 * ================================================================== */

function duWalk(ctx, absPath, display, opts, rows, depth) {
  let st;
  try {
    st = ctx.fs.lstat(absPath);
  } catch (err) {
    return { blocks: 0, error: phrase(err) };
  }
  if (!st.isDir) {
    const blocks = blocks1k(st);
    if (opts.all && depth <= opts.maxDepth) rows.push({ blocks, name: display });
    return { blocks, error: null };
  }

  let total = 4;
  let names = [];
  try {
    names = ctx.fs.readdir(absPath);
  } catch {
    names = [];
  }
  for (const name of names) {
    const childAbs = absPath === '/' ? `/${name}` : `${absPath}/${name}`;
    const childDisplay = display === '/' ? `/${name}` : `${display}/${name}`;
    const sub = duWalk(ctx, childAbs, childDisplay, opts, rows, depth + 1);
    total += sub.blocks;
  }
  if (depth <= opts.maxDepth) rows.push({ blocks: total, name: display });
  return { blocks: total, error: null };
}

const du = {
  name: 'du',
  aliases: [],
  synopsis: 'du [OPTION]... [FILE]...',
  description: 'Estimate file space usage',
  man: `NAME
       du - estimate file space usage

SYNOPSIS
       du [OPTION]... [FILE]...

DESCRIPTION
       Summarize device usage of the set of FILEs, recursively for directories.

       -a, --all             write counts for all files, not just directories
       -c, --total           produce a grand total
       -d, --max-depth=N     print the total for a directory only if it is N or
                             fewer levels below the command line argument
       -h, --human-readable  print sizes in human readable format
       -s, --summarize       display only a total for each argument`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'd');
    const human = p.flags.has('h') || p.longs['human-readable'] === true;
    const summarize = p.flags.has('s') || p.longs.summarize === true;
    const all = p.flags.has('a') || p.longs.all === true;
    const grandTotal = p.flags.has('c') || p.longs.total === true;
    let maxDepth = Infinity;
    if (p.values.d !== undefined) maxDepth = Number(p.values.d);
    else if (typeof p.longs['max-depth'] === 'string') maxDepth = Number(p.longs['max-depth']);
    if (summarize) maxDepth = 0;

    const targets = p.operands.length ? p.operands : ['.'];
    const out = [];
    const errors = [];
    let code = 0;
    let total = 0;

    for (const arg of targets) {
      const target = abs(ctx, arg);
      if (!ctx.fs.lexists(target)) {
        errors.push(`du: cannot access '${arg}': No such file or directory\n`);
        code = 1;
        continue;
      }
      const rows = [];
      const display = arg.length > 1 ? arg.replace(/\/+$/, '') : arg;
      const res = duWalk(ctx, target, display, { all, maxDepth }, rows, 0);
      total += res.blocks;
      for (const row of rows) {
        out.push(`${human ? humanSize(row.blocks * 1024) : String(row.blocks)}\t${row.name}\n`);
      }
    }

    if (grandTotal) out.push(`${human ? humanSize(total * 1024) : String(total)}\ttotal\n`);
    return result(out, errors, code);
  },
};

/**
 * The mount table, in `df`'s 1K blocks.
 *
 * Shared with the System Monitor's File Systems tab so the two can never
 * disagree — see `js/apps/monitor/filesystems.js` for where the numbers come
 * from. In short: `/` is this desktop's own filesystem on a virtual disk whose
 * capacity is the browser's storage quota (not the machine's disk, and not
 * labelled as one), its usage is the real byte count of the virtual tree, and
 * the tmpfs mounts are sized from real RAM the way systemd sizes them.
 *
 * @returns {{fs:string, type:string, total:number, used:number, avail:number, mount:string}[]}
 */
function dfMounts() {
  return monitorMountTable().map((m) => ({
    fs: m.device,
    type: m.type,
    total: Math.round(m.total / 1024),
    used: Math.round(m.used / 1024),
    avail: Math.round(m.available / 1024),
    mount: m.directory,
  }));
}

const df = {
  name: 'df',
  aliases: [],
  synopsis: 'df [OPTION]... [FILE]...',
  description: 'Report file system disk space usage',
  man: `NAME
       df - report file system disk space usage

SYNOPSIS
       df [OPTION]... [FILE]...

DESCRIPTION
       Show information about the file system on which each FILE resides, or
       all file systems by default.

       -h, --human-readable  print sizes in powers of 1024 (e.g. 1023M)
       -T, --print-type      print file system type
       -a, --all             include pseudo, duplicate, inaccessible file systems
       -i, --inodes          list inode information instead of block usage`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const human = p.flags.has('h') || p.longs['human-readable'] === true;
    const withType = p.flags.has('T') || p.longs['print-type'] === true;

    const table = dfMounts();
    const root = table.find((m) => m.mount === '/') || table[0];
    let mounts = table;
    if (p.operands.length) {
      const picked = [];
      for (const arg of p.operands) {
        const target = abs(ctx, arg);
        if (!ctx.fs.lexists(target)) continue;
        let best = root;
        for (const m of mounts) {
          if ((target === m.mount || target.startsWith(m.mount === '/' ? '/' : `${m.mount}/`)) && m.mount.length >= best.mount.length) {
            best = m;
          }
        }
        if (!picked.includes(best)) picked.push(best);
      }
      mounts = picked.length ? picked : mounts;
    }

    const fmt = (kb) => (human ? humanSize(kb * 1024) : String(kb));
    const rows = mounts.map((m) => {
      const usePct = m.total === 0 ? 0 : Math.ceil((m.used / (m.used + m.avail || 1)) * 100);
      return [
        m.fs,
        withType ? m.type : null,
        fmt(m.total),
        fmt(m.used),
        fmt(m.avail),
        `${Number.isFinite(usePct) ? usePct : 0}%`,
        m.mount,
      ].filter((c) => c !== null);
    });

    const header = [
      'Filesystem',
      withType ? 'Type' : null,
      human ? 'Size' : '1K-blocks',
      human ? 'Used' : 'Used',
      human ? 'Avail' : 'Available',
      'Use%',
      'Mounted on',
    ].filter((c) => c !== null);

    const all = [header].concat(rows);
    const widths = header.map((_, col) => Math.max(...all.map((r) => String(r[col]).length)));

    const out = all.map((row) => {
      const cells = row.map((cell, col) => {
        if (col === 0) return padRight(String(cell), widths[col]);
        if (col === row.length - 1) return String(cell);
        return padLeft(String(cell), widths[col]);
      });
      return `${cells.join(' ')}\n`;
    });

    // Without a storage quota the capacity of `/` is a placeholder, and the
    // only honest thing to do is say so. It goes to stderr with exit status 0
    // so `df | awk` still behaves.
    const note = rootCapacityIsReal()
      ? ''
      : "df: this browser reports no storage quota, so the size shown for '/' is a "
        + 'placeholder; the space in use is real\n';
    return { stdout: out.join(''), stderr: note, code: 0 };
  },
};

/* ================================================================== *
 * stat
 * ================================================================== */

function fileTypeLabel(st) {
  if (st.isDir) return 'directory';
  if (st.isLink) return 'symbolic link';
  if ((Number(st.size) || 0) === 0) return 'regular empty file';
  return 'regular file';
}

/** 512-byte blocks actually allocated, ext4-style. */
function statBlocks(st) {
  if (st.isDir) return 8;
  if (st.isLink) return 0;
  const size = Number(st.size) || 0;
  if (size === 0) return 0;
  return Math.ceil(size / 4096) * 8;
}

function statBlock(ctx, arg, target, st) {
  const isLink = st.isLink;
  let linkTarget = '';
  if (isLink) {
    try {
      linkTarget = ctx.fs.readlink(target);
    } catch {
      linkTarget = '';
    }
  }
  const size = Number(st.size) || 0;
  const blocks = statBlocks(st);
  const mode = Number(st.mode) || 0;
  const octal = pad0((mode & 0o7777).toString(8), 4);
  const uid = st.owner === 'root' ? 0 : 1000;
  const gid = st.group === 'root' ? 0 : 1000;
  const stamp = statTime(st.mtime);

  const lines = [];
  lines.push(`  File: ${arg}${isLink ? ` -> ${linkTarget}` : ''}\n`);
  lines.push(
    `  Size: ${padRight(String(size), 10)}\tBlocks: ${padRight(String(blocks), 10)} IO Block: 4096   ${fileTypeLabel(st)}\n`,
  );
  lines.push(`Device: 8,2\tInode: ${padRight(String(inodeOf(target)), 10)}  Links: ${linkCount(ctx, target, st)}\n`);
  lines.push(
    `Access: (${octal}/${permString(mode, st.type)})  Uid: (${padLeft(String(uid), 5)}/${padLeft(st.owner || 'ubuntu', 8)})   Gid: (${padLeft(String(gid), 5)}/${padLeft(st.group || 'ubuntu', 8)})\n`,
  );
  lines.push(`Access: ${stamp}\n`);
  lines.push(`Modify: ${stamp}\n`);
  lines.push(`Change: ${stamp}\n`);
  lines.push(` Birth: ${stamp}\n`);
  return lines.join('');
}

function statFormat(ctx, fmt, arg, target, st) {
  const mode = Number(st.mode) || 0;
  const size = Number(st.size) || 0;
  const map = {
    n: arg,
    N: st.isLink ? `'${arg}' -> '${(() => { try { return ctx.fs.readlink(target); } catch { return ''; } })()}'` : `'${arg}'`,
    s: String(size),
    b: String(statBlocks(st)),
    B: '512',
    f: (mode | (st.isDir ? 0o40000 : st.isLink ? 0o120000 : 0o100000)).toString(16),
    a: (mode & 0o7777).toString(8),
    A: permString(mode, st.type),
    u: st.owner === 'root' ? '0' : '1000',
    U: st.owner || 'ubuntu',
    g: st.group === 'root' ? '0' : '1000',
    G: st.group || 'ubuntu',
    i: String(inodeOf(target)),
    h: String(linkCount(ctx, target, st)),
    F: fileTypeLabel(st),
    d: '2051',
    D: '803',
    t: '8',
    T: '2',
    m: '/',
    o: '4096',
    x: statTime(st.mtime),
    y: statTime(st.mtime),
    z: statTime(st.mtime),
    w: statTime(st.mtime),
    X: String(Math.floor(st.mtime / 1000)),
    Y: String(Math.floor(st.mtime / 1000)),
    Z: String(Math.floor(st.mtime / 1000)),
    W: String(Math.floor(st.mtime / 1000)),
  };
  let out = '';
  for (let i = 0; i < fmt.length; i += 1) {
    const ch = fmt[i];
    if (ch === '\\' && i + 1 < fmt.length) {
      i += 1;
      const esc = fmt[i];
      out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '\\' ? '\\' : esc;
      continue;
    }
    if (ch === '%' && i + 1 < fmt.length) {
      i += 1;
      const spec = fmt[i];
      if (spec === '%') out += '%';
      else out += map[spec] !== undefined ? map[spec] : `%${spec}`;
      continue;
    }
    out += ch;
  }
  return out;
}

const stat = {
  name: 'stat',
  aliases: [],
  synopsis: 'stat [OPTION]... FILE...',
  description: 'Display file or file system status',
  man: `NAME
       stat - display file or file system status

SYNOPSIS
       stat [OPTION]... FILE...

DESCRIPTION
       Display file status.

       -c, --format=FORMAT   use the specified FORMAT instead of the default
       -L, --dereference     follow links
       -t, --terse           print the information in terse form`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'c');
    const deref = p.flags.has('L') || p.longs.dereference === true;
    const fmt = p.values.c !== undefined ? p.values.c : typeof p.longs.format === 'string' ? p.longs.format : null;
    const terse = p.flags.has('t') || p.longs.terse === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "stat: missing operand\nTry 'stat --help' for more information.\n",
        code: 1,
      };
    }

    const out = [];
    const errors = [];
    let code = 0;

    for (const arg of p.operands) {
      const target = abs(ctx, arg);
      let st;
      try {
        st = deref ? ctx.fs.stat(target) : ctx.fs.lstat(target);
      } catch (err) {
        errors.push(`stat: cannot statx '${arg}': ${phrase(err)}\n`);
        code = 1;
        continue;
      }
      if (fmt !== null) {
        out.push(`${statFormat(ctx, fmt, arg, target, st)}\n`);
      } else if (terse) {
        out.push(
          `${arg} ${st.size} ${statBlocks(st)} ${(Number(st.mode) & 0o7777).toString(8)} ` +
            `${st.owner === 'root' ? 0 : 1000} ${st.group === 'root' ? 0 : 1000} 803 ${inodeOf(target)} ${linkCount(ctx, target, st)} 0 0 ` +
            `${Math.floor(st.mtime / 1000)} ${Math.floor(st.mtime / 1000)} ${Math.floor(st.mtime / 1000)} 4096\n`,
        );
      } else {
        out.push(statBlock(ctx, arg, target, st));
      }
    }
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * file
 * ================================================================== */

/**
 * Language tests, keyed by extension. Deliberately conservative: file(1) 5.45
 * on Ubuntu 24.04 reports plain "ASCII text" for .md, .css, .sh, .yaml and
 * friends, so those are absent here on purpose.
 */
const EXT_TYPES = {
  '.json': 'JSON text data',
  '.html': 'HTML document',
  '.htm': 'HTML document',
  '.xml': 'XML 1.0 document',
  '.svg': 'SVG Scalable Vector Graphics image',
  '.c': 'C source',
  '.h': 'C source',
  '.cpp': 'C++ source',
  '.cc': 'C++ source',
  '.hpp': 'C++ source',
  '.java': 'Java source',
  '.csv': 'CSV text',
  '.desktop': 'Desktop Entry file',
  '.diff': 'unified diff output',
  '.patch': 'unified diff output',
};

/** Extension fallback for files whose bytes are not modelled (size-only nodes). */
const EXT_BINARY = {
  '.iso': "ISO 9660 CD-ROM filesystem data 'Ubuntu 24.04.1 LTS amd64'",
  '.png': 'PNG image data, 3840 x 2160, 8-bit/color RGBA, non-interlaced',
  '.jpg': 'JPEG image data, JFIF standard 1.01',
  '.jpeg': 'JPEG image data, JFIF standard 1.01',
  '.gif': 'GIF image data, version 89a',
  '.webp': 'RIFF (little-endian) data, Web/P image',
  '.pdf': 'PDF document, version 1.7',
  '.zip': 'Zip archive data, at least v2.0 to extract',
  '.gz': 'gzip compressed data',
  '.xz': 'XZ compressed data, checksum CRC64',
  '.deb': 'Debian binary package (format 2.0)',
  '.mp3': 'Audio file with ID3 version 2.4.0',
  '.mp4': 'ISO Media, MP4 Base Media v1',
  '.woff2': 'Web Open Font Format (Version 2)',
  '.so': 'ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked',
};

const SHEBANGS = [
  [/^#!.*\bpython[0-9.]*\b/, 'Python script'],
  [/^#!.*\bbash\b/, 'Bourne-Again shell script'],
  [/^#!.*\bzsh\b/, 'Zsh script'],
  [/^#!.*\/sh\b/, 'POSIX shell script'],
  [/^#!.*\bnode\b/, 'Node.js script'],
  [/^#!.*\bperl\b/, 'Perl script'],
  [/^#!.*\bruby\b/, 'Ruby script'],
  [/^#!.*\benv\s+\S+/, 'a /usr/bin/env script'],
];

const BINARY_MAGIC = [
  ['\u0089PNG', 'PNG image data'],
  ['GIF87a', 'GIF image data, version 87a'],
  ['GIF89a', 'GIF image data, version 89a'],
  ['%PDF-', 'PDF document'],
  ['PK\u0003\u0004', 'Zip archive data'],
  ['\u007fELF', 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked'],
  ['\u001f\u008b', 'gzip compressed data'],
  ['BZh', 'bzip2 compressed data'],
  ['\u00fd7zXZ', 'XZ compressed data'],
  ['OggS', 'Ogg data'],
  ['RIFF', 'RIFF (little-endian) data'],
  ['\u00ff\u00d8\u00ff', 'JPEG image data'],
];

function describeText(content, isExecutable, kind) {
  const encoding = /[^\u0000-\u007f]/.test(content) ? 'Unicode text, UTF-8 text' : 'ASCII text';
  const notes = [];
  if (content.indexOf('\r\n') >= 0) notes.push('with CRLF line terminators');
  else if (content !== '' && !content.endsWith('\n')) notes.push('with no line terminators');
  const longest = content.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
  if (longest > 300) notes.push('with very long lines');

  let base = encoding;
  if (isExecutable) base += ' executable';
  const parts = [];
  if (kind) parts.push(kind);
  parts.push(base);
  const joined = parts.join(', ');
  return notes.length ? `${joined}, ${notes.join(', ')}` : joined;
}

const fileCmd = {
  name: 'file',
  aliases: [],
  synopsis: 'file [OPTION]... FILE...',
  description: 'Determine file type',
  man: `NAME
       file - determine file type

SYNOPSIS
       file [OPTION]... FILE...

DESCRIPTION
       file tests each argument in an attempt to classify it. There are three
       sets of tests, performed in this order: filesystem tests, magic tests
       and language tests.

       -b, --brief          do not prepend filenames to output lines
       -i, --mime           output MIME type strings
       -L, --dereference    follow symlinks`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const brief = p.flags.has('b') || p.longs.brief === true;
    const mime = p.flags.has('i') || p.longs.mime === true;
    const deref = p.flags.has('L') || p.longs.dereference === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: 'Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--exclude-quiet] FILE...\n',
        code: 1,
      };
    }

    const width = brief ? 0 : Math.max(...p.operands.map((a) => a.length));
    const out = [];
    let code = 0;

    for (const arg of p.operands) {
      const target = abs(ctx, arg);
      let st;
      try {
        st = deref ? ctx.fs.stat(target) : ctx.fs.lstat(target);
      } catch {
        const line = 'cannot open (No such file or directory)';
        out.push(brief ? `${line}\n` : `${padRight(`${arg}:`, width + 1)} ${line}\n`);
        code = 1;
        continue;
      }

      let desc;
      if (st.isDir) {
        desc = mime ? 'inode/directory; charset=binary' : 'directory';
      } else if (st.isLink) {
        let t = '';
        try {
          t = ctx.fs.readlink(target);
        } catch {
          t = '';
        }
        desc = mime ? 'inode/symlink; charset=binary' : `symbolic link to ${t}`;
      } else {
        let content = '';
        try {
          content = ctx.fs.readFile(target);
        } catch {
          content = '';
        }
        if (content === '' && (Number(st.size) || 0) > 0) {
          const byExt = EXT_BINARY[pathmod.extname(arg).toLowerCase()];
          desc = mime ? 'application/octet-stream; charset=binary' : byExt || 'data';
        } else if (content === '') {
          desc = mime ? 'inode/x-empty; charset=binary' : 'empty';
        } else {
          let magic = null;
          for (const [sig, label] of BINARY_MAGIC) {
            if (content.slice(0, sig.length) === sig) {
              magic = label;
              break;
            }
          }
          if (magic) {
            desc = mime ? 'application/octet-stream; charset=binary' : magic;
          } else {
            let kind = null;
            const firstLine = content.slice(0, content.indexOf('\n') < 0 ? content.length : content.indexOf('\n'));
            for (const [re, label] of SHEBANGS) {
              if (re.test(firstLine)) {
                kind = label;
                break;
              }
            }
            if (!kind) {
              const ext = pathmod.extname(arg).toLowerCase();
              const byExt = EXT_TYPES[ext];
              if (byExt && byExt !== 'ASCII text') kind = byExt;
            }
            if (kind === 'JSON text data' || kind === 'CSV text' || kind === 'SVG Scalable Vector Graphics image') {
              desc = mime ? 'text/plain; charset=us-ascii' : kind;
            } else {
              /* file(1) only calls text "executable" when it carries a #! line. */
              const executable = firstLine.slice(0, 2) === '#!';
              desc = mime
                ? `text/plain; charset=${/[^\u0000-\u007f]/.test(content) ? 'utf-8' : 'us-ascii'}`
                : describeText(content, executable, kind);
            }
          }
        }
      }
      out.push(brief ? `${desc}\n` : `${padRight(`${arg}:`, width + 1)} ${desc}\n`);
    }
    return { stdout: out.join(''), stderr: '', code };
  },
};

/* ================================================================== *
 * chmod / chown
 * ================================================================== */

/**
 * Apply a symbolic mode expression (`u+x`, `go-w`, `a=rw`, `+x`).
 * @returns {number|null} the new mode, or null when the expression is invalid
 */
function applySymbolicMode(spec, current, isDir) {
  let mode = current;
  for (const clause of String(spec).split(',')) {
    const m = /^([ugoa]*)((?:[-+=][rwxXstugo]*)+)$/.exec(clause);
    if (!m) return null;
    const whoRaw = m[1] || 'a';
    const ops = m[2].match(/[-+=][rwxXstugo]*/g) || [];
    let who = 0;
    if (whoRaw.indexOf('a') >= 0) who = 0o7777;
    else {
      if (whoRaw.indexOf('u') >= 0) who |= 0o4700;
      if (whoRaw.indexOf('g') >= 0) who |= 0o2070;
      if (whoRaw.indexOf('o') >= 0) who |= 0o0007;
    }

    for (const op of ops) {
      const action = op[0];
      const perms = op.slice(1);
      let bits = 0;
      for (const ch of perms) {
        if (ch === 'r') bits |= 0o444;
        else if (ch === 'w') bits |= 0o222;
        else if (ch === 'x') bits |= 0o111;
        else if (ch === 'X') {
          if (isDir || (mode & 0o111) !== 0) bits |= 0o111;
        } else if (ch === 's') bits |= 0o6000;
        else if (ch === 't') bits |= 0o1000;
        else if (ch === 'u') bits |= ((mode >> 6) & 7) * 0o111;
        else if (ch === 'g') bits |= ((mode >> 3) & 7) * 0o111;
        else if (ch === 'o') bits |= (mode & 7) * 0o111;
        else return null;
      }
      const masked = bits & who;
      if (action === '+') mode |= masked;
      else if (action === '-') mode &= ~masked;
      else mode = (mode & ~who) | masked;
    }
  }
  return mode & 0o7777;
}

const chmod = {
  name: 'chmod',
  aliases: [],
  synopsis: 'chmod [OPTION]... MODE[,MODE]... FILE...',
  description: 'Change file mode bits',
  man: `NAME
       chmod - change file mode bits

SYNOPSIS
       chmod [OPTION]... MODE[,MODE]... FILE...
       chmod [OPTION]... OCTAL-MODE FILE...

DESCRIPTION
       Change the mode of each FILE to MODE. A symbolic MODE has the form
       [ugoa...][[-+=][perms...]...] where perms is zero or more letters from
       rwxXst. An octal MODE is one to four octal digits.

       -c, --changes    report only when a change is made
       -R, --recursive  change files and directories recursively
       -v, --verbose    output a diagnostic for every file processed`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const recursive = p.flags.has('R') || p.longs.recursive === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;
    const changesOnly = p.flags.has('c') || p.longs.changes === true;
    const silent = p.flags.has('f') || p.longs.silent === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "chmod: missing operand\nTry 'chmod --help' for more information.\n",
        code: 1,
      };
    }
    const spec = p.operands[0];
    const files = p.operands.slice(1);
    if (files.length === 0) {
      return {
        stdout: '',
        stderr: `chmod: missing operand after '${spec}'\nTry 'chmod --help' for more information.\n`,
        code: 1,
      };
    }

    const octal = /^[0-7]{1,4}$/.test(spec) ? parseInt(spec, 8) : null;
    if (octal === null && !/^([ugoa]*(?:[-+=][rwxXstugo]*)+)(,[ugoa]*(?:[-+=][rwxXstugo]*)+)*$/.test(spec)) {
      return {
        stdout: '',
        stderr: `chmod: invalid mode: '${spec}'\nTry 'chmod --help' for more information.\n`,
        code: 1,
      };
    }

    const out = [];
    const errors = [];
    let code = 0;

    const applyTo = (display, target) => {
      let st;
      try {
        st = ctx.fs.lstat(target);
      } catch (err) {
        if (!silent) {
          errors.push(`chmod: cannot access '${display}': ${phrase(err)}\n`);
          code = 1;
        }
        return;
      }
      const before = Number(st.mode) & 0o7777;
      const after = octal !== null ? octal : applySymbolicMode(spec, before, st.isDir);
      if (after === null) {
        errors.push(`chmod: invalid mode: '${spec}'\n`);
        code = 1;
        return;
      }
      try {
        if (after !== before) ctx.fs.chmod(target, after);
      } catch (err) {
        errors.push(`chmod: changing permissions of '${display}': ${phrase(err)}\n`);
        code = 1;
        return;
      }
      if (after === before) {
        if (verbose && !changesOnly) {
          out.push(`mode of '${display}' retained as ${pad0(after.toString(8), 4)} (${permString(after, st.type)})\n`);
        }
      } else if (verbose || changesOnly) {
        out.push(
          `mode of '${display}' changed from ${pad0(before.toString(8), 4)} (${permString(before, st.type)}) to ${pad0(after.toString(8), 4)} (${permString(after, st.type)})\n`,
        );
      }

      if (recursive && st.isDir) {
        let names = [];
        try {
          names = ctx.fs.readdir(target);
        } catch {
          names = [];
        }
        for (const name of names) {
          applyTo(display === '/' ? `/${name}` : `${display}/${name}`, target === '/' ? `/${name}` : `${target}/${name}`);
        }
      }
    };

    for (const arg of files) applyTo(arg, abs(ctx, arg));
    return result(out, errors, code);
  },
};

const chown = {
  name: 'chown',
  aliases: [],
  synopsis: 'chown [OPTION]... [OWNER][:[GROUP]] FILE...',
  description: 'Change file owner and group',
  man: `NAME
       chown - change file owner and group

SYNOPSIS
       chown [OPTION]... [OWNER][:[GROUP]] FILE...

DESCRIPTION
       Change the user and/or group ownership of each given FILE to OWNER
       and/or GROUP. Only a privileged user may change the owner of a file.

       -c, --changes    report only when a change is made
       -R, --recursive  operate on files and directories recursively
       -v, --verbose    output a diagnostic for every file processed`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const recursive = p.flags.has('R') || p.longs.recursive === true;
    const verbose = p.flags.has('v') || p.longs.verbose === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "chown: missing operand\nTry 'chown --help' for more information.\n",
        code: 1,
      };
    }
    const spec = p.operands[0];
    const files = p.operands.slice(1);
    if (files.length === 0) {
      return {
        stdout: '',
        stderr: `chown: missing operand after '${spec}'\nTry 'chown --help' for more information.\n`,
        code: 1,
      };
    }

    const colon = spec.indexOf(':');
    const owner = colon < 0 ? spec : spec.slice(0, colon);
    const group = colon < 0 ? '' : spec.slice(colon + 1);
    const me = ctx.users && ctx.users.current ? ctx.users.current.name : 'ubuntu';
    const privileged =
      (ctx.users && ctx.users.sudoUnlocked === true) || (ctx.env && ctx.env.get('USER') === 'root');

    const out = [];
    const errors = [];
    let code = 0;

    const applyTo = (display, target) => {
      let st;
      try {
        st = ctx.fs.lstat(target);
      } catch (err) {
        errors.push(`chown: cannot access '${display}': ${phrase(err)}\n`);
        code = 1;
        return;
      }
      const wantsForeign = (owner !== '' && owner !== me) || (group !== '' && group !== me);
      if (wantsForeign && !privileged) {
        errors.push(`chown: changing ownership of '${display}': Operation not permitted\n`);
        code = 1;
        return;
      }
      const before = `${st.owner}:${st.group}`;
      try {
        ctx.fs.chown(target, owner || undefined, group || undefined);
      } catch (err) {
        errors.push(`chown: changing ownership of '${display}': ${phrase(err)}\n`);
        code = 1;
        return;
      }
      if (verbose) {
        const after = `${owner || st.owner}:${group || st.group}`;
        if (before === after) out.push(`ownership of '${display}' retained as ${after}\n`);
        else out.push(`changed ownership of '${display}' from ${before} to ${after}\n`);
      }
      if (recursive && st.isDir) {
        let names = [];
        try {
          names = ctx.fs.readdir(target);
        } catch {
          names = [];
        }
        for (const name of names) {
          applyTo(display === '/' ? `/${name}` : `${display}/${name}`, target === '/' ? `/${name}` : `${target}/${name}`);
        }
      }
    };

    for (const arg of files) applyTo(arg, abs(ctx, arg));
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * realpath / basename / dirname / readlink
 * ================================================================== */

const realpath = {
  name: 'realpath',
  aliases: [],
  synopsis: 'realpath [OPTION]... FILE...',
  description: 'Print the resolved absolute file name',
  man: `NAME
       realpath - print the resolved path

SYNOPSIS
       realpath [OPTION]... FILE...

DESCRIPTION
       Print the resolved absolute file name; all but the last component must
       exist.

       -e, --canonicalize-existing  all components must exist
       -m, --canonicalize-missing   no path components need exist
       -q, --quiet                  suppress most error messages
       -s, --strip, --no-symlinks   do not expand symlinks
           --relative-to=DIR        print the resolved path relative to DIR`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const missingOk = p.flags.has('m') || p.longs['canonicalize-missing'] === true;
    const quiet = p.flags.has('q') || p.longs.quiet === true;
    const noSymlinks = p.flags.has('s') || p.longs.strip === true || p.longs['no-symlinks'] === true;
    const relativeTo = typeof p.longs['relative-to'] === 'string' ? p.longs['relative-to'] : null;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "realpath: missing operand\nTry 'realpath --help' for more information.\n",
        code: 1,
      };
    }

    const out = [];
    const errors = [];
    let code = 0;
    for (const arg of p.operands) {
      const target = abs(ctx, arg);
      const resolved = noSymlinks ? target : realpathOf(ctx.fs, target);
      if (!missingOk && !ctx.fs.lexists(resolved)) {
        if (!quiet) errors.push(`realpath: ${arg}: No such file or directory\n`);
        code = 1;
        continue;
      }
      out.push(`${relativeTo ? pathmod.relative(abs(ctx, relativeTo), resolved) : resolved}\n`);
    }
    return result(out, errors, code);
  },
};

const basenameCmd = {
  name: 'basename',
  aliases: [],
  synopsis: 'basename NAME [SUFFIX]',
  description: 'Strip directory and suffix from filenames',
  man: `NAME
       basename - strip directory and suffix from filenames

SYNOPSIS
       basename NAME [SUFFIX]
       basename OPTION... NAME...

DESCRIPTION
       Print NAME with any leading directory components removed. If specified,
       also remove a trailing SUFFIX.

       -a, --multiple       support multiple arguments and treat each as a NAME
       -s, --suffix=SUFFIX  remove a trailing SUFFIX; implies -a
       -z, --zero           end each output line with NUL, not newline`,

  async run(ctx) {
    const p = optParse(ctx.argv, 's');
    const suffixOpt = p.values.s !== undefined ? p.values.s : typeof p.longs.suffix === 'string' ? p.longs.suffix : null;
    const multiple = p.flags.has('a') || p.longs.multiple === true || suffixOpt !== null;
    const zero = p.flags.has('z') || p.longs.zero === true;
    const term = zero ? '\u0000' : '\n';

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "basename: missing operand\nTry 'basename --help' for more information.\n",
        code: 1,
      };
    }

    const strip = (name, suffix) => {
      const trimmed = name.replace(/\/+$/, '') || '/';
      let base = trimmed === '/' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1);
      if (suffix && base !== suffix && base.endsWith(suffix)) base = base.slice(0, base.length - suffix.length);
      return base;
    };

    if (multiple) {
      return ok(p.operands.map((n) => strip(n, suffixOpt) + term).join(''));
    }
    if (p.operands.length > 2) {
      return {
        stdout: '',
        stderr: `basename: extra operand '${p.operands[2]}'\nTry 'basename --help' for more information.\n`,
        code: 1,
      };
    }
    return ok(strip(p.operands[0], p.operands[1] || null) + term);
  },
};

const dirnameCmd = {
  name: 'dirname',
  aliases: [],
  synopsis: 'dirname [OPTION] NAME...',
  description: 'Strip last component from file name',
  man: `NAME
       dirname - strip last component from file name

SYNOPSIS
       dirname [OPTION] NAME...

DESCRIPTION
       Output each NAME with its last non-slash component and trailing slashes
       removed; if NAME contains no /'s, output '.' (meaning the current
       directory).

       -z, --zero   end each output line with NUL, not newline`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const zero = p.flags.has('z') || p.longs.zero === true;
    const term = zero ? '\u0000' : '\n';
    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "dirname: missing operand\nTry 'dirname --help' for more information.\n",
        code: 1,
      };
    }
    const out = p.operands.map((name) => {
      const trimmed = name.replace(/\/+$/, '');
      const idx = trimmed.lastIndexOf('/');
      if (idx < 0) return `.${term}`;
      if (idx === 0) return `/${term}`;
      return `${trimmed.slice(0, idx).replace(/\/+$/, '') || '/'}${term}`;
    });
    return ok(out.join(''));
  },
};

const readlinkCmd = {
  name: 'readlink',
  aliases: [],
  synopsis: 'readlink [OPTION]... FILE...',
  description: 'Print resolved symbolic links or canonical file names',
  man: `NAME
       readlink - print resolved symbolic links or canonical file names

SYNOPSIS
       readlink [OPTION]... FILE...

DESCRIPTION
       Print value of a symbolic link or canonical file name.

       -f, --canonicalize   canonicalize by following every symlink
       -e, --canonicalize-existing  all components must exist
       -m, --canonicalize-missing   no components need exist
       -n, --no-newline     do not output the trailing delimiter
       -q, --quiet          suppress most error messages`,

  async run(ctx) {
    const p = optParse(ctx.argv);
    const canon = p.flags.has('f') || p.flags.has('e') || p.flags.has('m') || p.longs.canonicalize === true;
    const mustExist = p.flags.has('e') || p.longs['canonicalize-existing'] === true;
    const noNewline = p.flags.has('n') || p.longs['no-newline'] === true;
    const quiet = p.flags.has('q') || p.flags.has('s') || p.longs.quiet === true;

    if (p.operands.length === 0) {
      return {
        stdout: '',
        stderr: "readlink: missing operand\nTry 'readlink --help' for more information.\n",
        code: 1,
      };
    }

    const out = [];
    const errors = [];
    let code = 0;
    for (const arg of p.operands) {
      const target = abs(ctx, arg);
      if (canon) {
        const resolved = realpathOf(ctx.fs, target);
        if (mustExist && !ctx.fs.lexists(resolved)) {
          code = 1;
          continue;
        }
        out.push(noNewline ? resolved : `${resolved}\n`);
        continue;
      }
      try {
        const value = ctx.fs.readlink(target);
        out.push(noNewline ? value : `${value}\n`);
      } catch (err) {
        if (!quiet && err && err.code !== 'EINVAL') {
          /* GNU readlink is silent for non-links; other errors stay silent too */
        }
        code = 1;
      }
    }
    return result(out, errors, code);
  },
};

/* ================================================================== *
 * mktemp
 * ================================================================== */

const TEMPLATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += TEMPLATE_CHARS[Math.floor(Math.random() * TEMPLATE_CHARS.length)];
  }
  return out;
}

const mktemp = {
  name: 'mktemp',
  aliases: [],
  synopsis: 'mktemp [OPTION]... [TEMPLATE]',
  description: 'Create a temporary file or directory',
  man: `NAME
       mktemp - create a temporary file or directory

SYNOPSIS
       mktemp [OPTION]... [TEMPLATE]

DESCRIPTION
       Create a temporary file or directory, safely, and print its name.
       TEMPLATE must contain at least 3 consecutive 'X's in the last component.
       If TEMPLATE is not specified, use tmp.XXXXXXXXXX.

       -d, --directory     create a directory, not a file
       -u, --dry-run       do not create anything; merely print a name
       -p DIR, --tmpdir[=DIR]  interpret TEMPLATE relative to DIR
       -t                  interpret TEMPLATE as a single file name component
           --suffix=SUFF   append SUFF to TEMPLATE`,

  async run(ctx) {
    const p = optParse(ctx.argv, 'p');
    const wantDir = p.flags.has('d') || p.longs.directory === true;
    const dryRun = p.flags.has('u') || p.longs['dry-run'] === true;
    const forceTmp = p.flags.has('t');
    const suffix = typeof p.longs.suffix === 'string' ? p.longs.suffix : '';
    let tmpdir = ctx.env && ctx.env.get('TMPDIR') ? ctx.env.get('TMPDIR') : '/tmp';
    if (p.values.p !== undefined) tmpdir = p.values.p;
    else if (typeof p.longs.tmpdir === 'string') tmpdir = p.longs.tmpdir;

    let template = p.operands.length ? p.operands[0] : 'tmp.XXXXXXXXXX';
    const explicit = p.operands.length > 0;

    if (explicit && !/XXX$/.test(template.replace(new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''))) {
      if (!/XXX/.test(template)) {
        return { stdout: '', stderr: `mktemp: too few X's in template '${template}'\n`, code: 1 };
      }
    }

    const usesTmpdir = !explicit || forceTmp || p.values.p !== undefined || typeof p.longs.tmpdir === 'string' || !template.includes('/');
    const baseDir = usesTmpdir ? abs(ctx, tmpdir) : abs(ctx, pathmod.dirname(template));
    const namePart = usesTmpdir ? pathmod.basename(template) : pathmod.basename(template);

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const filled = namePart.replace(/X{3,}/, (run) => randomSuffix(run.length)) + suffix;
      const candidate = baseDir === '/' ? `/${filled}` : `${baseDir}/${filled}`;
      if (ctx.fs.lexists(candidate)) continue;
      if (dryRun) return ok(`${candidate}\n`);
      try {
        if (wantDir) ctx.fs.mkdir(candidate, { parents: false, mode: 0o700 });
        else ctx.fs.writeFile(candidate, '', { mode: 0o600 });
      } catch (err) {
        return {
          stdout: '',
          stderr: `mktemp: failed to create ${wantDir ? 'directory' : 'file'} via template '${namePart}': ${phrase(err)}\n`,
          code: 1,
        };
      }
      return ok(`${candidate}\n`);
    }
    return { stdout: '', stderr: `mktemp: failed to create file via template '${namePart}': File exists\n`, code: 1 };
  },
};

/* ================================================================== *
 * export
 * ================================================================== */

export default [
  ls,
  mkdir,
  rmdir,
  rm,
  cp,
  mv,
  touch,
  ln,
  cat,
  tac,
  head,
  tail,
  wc,
  find,
  tree,
  du,
  df,
  stat,
  fileCmd,
  chmod,
  chown,
  realpath,
  basenameCmd,
  dirnameCmd,
  readlinkCmd,
  mktemp,
];
