/**
 * js/apps/terminal/shell.js — tokenizer, parser and executor (ARCHITECTURE §17).
 *
 * This is a real (small) Bourne-again shell, not a switch statement:
 *
 *   tokenize()  character scanner — quoting, escapes, operators, `$( )`, backticks
 *   parse()     tokens → AST of and-or lists → pipelines → simple commands
 *   execute()   walks the AST — pipes, redirections, short-circuits, jobs
 *
 * Expansion happens in bash's documented order: tilde → parameter/command
 * substitution → word splitting on IFS → pathname expansion (nullglob off).
 *
 * Builtins live in `./builtins.js` because they mutate shell state; everything
 * else is a registered command object from `./commands/*.js`.
 */

import { env } from '../../core/env.js';
import { fs, FsError } from '../../core/fs.js';
import { procs } from '../../core/procs.js';
import { users } from '../../core/users.js';
import { metrics } from '../../core/metrics.js';
import { notify } from '../../core/notify.js';
import { dialog } from '../../core/dialog.js';
import { bus } from '../../core/bus.js';
import { store } from '../../core/store.js';
import { gemini } from '../../services/gemini.js';
import * as path from '../../core/path.js';
import { BUILTINS, isBuiltin, builtinNames, commandNotFound } from './builtins.js';
import { C, stripAnsi } from './ansi.js';

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

/** A shell-level failure that carries a ready-to-print bash message. */
export class ShellError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message);
    this.name = 'ShellError';
    this.code = code;
  }
}

/** `bash: syntax error near unexpected token `|'` */
export class ShellSyntaxError extends ShellError {
  /** @param {string} token */
  constructor(token) {
    super(`bash: syntax error near unexpected token \`${token}'`, 2);
    this.name = 'ShellSyntaxError';
    this.token = token;
  }
}

/* ------------------------------------------------------------------ *
 * command registry
 * ------------------------------------------------------------------ */

/** @type {Map<string, object>} name (and alias) → command object */
const registry = new Map();

/**
 * Register one command object (see ARCHITECTURE §17 "Command object contract").
 * @param {{name:string, aliases?:string[], run:Function}} cmd
 * @returns {object} the command
 */
export function registerCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') throw new TypeError('registerCommand: object required');
  if (typeof cmd.name !== 'string' || cmd.name === '') {
    throw new TypeError('registerCommand: `name` must be a non-empty string');
  }
  if (typeof cmd.run !== 'function') {
    throw new TypeError(`registerCommand: "${cmd.name}" has no run()`);
  }
  registry.set(cmd.name, cmd);
  if (Array.isArray(cmd.aliases)) {
    for (const alias of cmd.aliases) {
      if (typeof alias === 'string' && alias !== '' && !registry.has(alias)) registry.set(alias, cmd);
    }
  }
  return cmd;
}

/**
 * @param {string} name
 * @returns {object|null}
 */
export function getCommand(name) {
  if (typeof name !== 'string') return null;
  return registry.get(name) || null;
}

/** @param {string} name @returns {boolean} */
export function hasCommand(name) {
  return registry.has(String(name));
}

/** @returns {string[]} every invocable external name, sorted — for completion */
export function commandNames() {
  return Array.from(registry.keys()).sort();
}

/** @returns {object[]} unique command objects, sorted by primary name */
export function allCommands() {
  const seen = new Set();
  const out = [];
  for (const cmd of registry.values()) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** @param {string} name @returns {boolean} true when something was removed */
export function unregisterCommand(name) {
  return registry.delete(String(name));
}

/* ------------------------------------------------------------------ *
 * tokenizer
 * ------------------------------------------------------------------ */

const IS_BLANK = /[ \t\r]/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAGIC_RE = /[*?[]/;

/**
 * @param {{v:string,q:string}[]} parts
 * @param {string} raw
 * @param {number} pos
 * @param {number} end
 */
function makeWord(parts, raw, pos, end) {
  const usable = parts.length ? parts : [{ v: '', q: 'none' }];
  let quoted = false;
  let text = '';
  for (const p of usable) {
    if (p.q !== 'none') quoted = true;
    text += p.v;
  }
  return { type: 'word', parts: usable, quoted, text, raw, pos, end };
}

/** Scan from `start` (which sits on `open`) to the matching `close`. */
function scanBalanced(src, start, open, close) {
  let depth = 0;
  let j = start;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") {
      j += 1;
      while (j < src.length && src[j] !== "'") j += 1;
      j += 1;
      continue;
    }
    if (c === '"') {
      j += 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      j += 1;
      continue;
    }
    if (c === open) { depth += 1; j += 1; continue; }
    if (c === close) {
      depth -= 1;
      j += 1;
      if (depth === 0) return j;
      continue;
    }
    j += 1;
  }
  return -1;
}

/** Scan a backtick run starting at `start`; returns the index past the closer. */
function scanBacktick(src, start) {
  let j = start + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '`') return j + 1;
    j += 1;
  }
  return src.length;
}

/**
 * Split a command line into word and operator tokens.
 *
 * Word tokens keep their `parts`, each tagged with the quoting that produced
 * it (`none` | `single` | `double` | `escape`), so the expander can skip
 * splitting and globbing for quoted material.
 *
 * @param {string} line
 * @returns {object[]} tokens
 */
export function tokenize(line) {
  const src = typeof line === 'string' ? line : '';
  /** @type {object[]} */
  const tokens = [];
  let parts = [];
  let hasWord = false;
  let wordStart = 0;
  let i = 0;

  const add = (v, q) => {
    hasWord = true;
    const last = parts[parts.length - 1];
    if (last && last.q === q) last.v += v;
    else parts.push({ v, q });
  };

  const flushWord = (endPos) => {
    if (!hasWord) return;
    tokens.push(makeWord(parts, src.slice(wordStart, endPos), wordStart, endPos));
    parts = [];
    hasWord = false;
  };

  const pushOp = (op, extra, pos, end) => {
    tokens.push({ type: 'op', op, raw: src.slice(pos, end), pos, end, ...extra });
  };

  /** Take a pending all-digit word as an explicit file descriptor. */
  const takeFd = () => {
    if (hasWord && parts.length === 1 && parts[0].q === 'none' && /^[0-9]+$/.test(parts[0].v)) {
      const fd = Number(parts[0].v);
      parts = [];
      hasWord = false;
      return fd;
    }
    return null;
  };

  while (i < src.length) {
    const c = src[i];

    if (!hasWord && c === '#') break;                    /* comment to EOL */

    if (IS_BLANK.test(c)) { flushWord(i); i += 1; continue; }

    if (c === '\n') {
      flushWord(i);
      pushOp(';', { newline: true }, i, i + 1);
      i += 1;
      continue;
    }

    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) { if (!hasWord) wordStart = i; add('\\', 'none'); i += 1; continue; }
      if (n === '\n') { i += 2; continue; }               /* line continuation */
      if (!hasWord) wordStart = i;
      add(n, 'escape');
      i += 2;
      continue;
    }

    if (c === "'") {
      if (!hasWord) wordStart = i;
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== "'") { s += src[j]; j += 1; }
      add('', 'single');
      add(s, 'single');
      i = j < src.length ? j + 1 : j;
      continue;
    }

    if (c === '"') {
      if (!hasWord) wordStart = i;
      i += 1;
      add('', 'double');
      let buf = '';
      const flushBuf = () => { if (buf !== '') { add(buf, 'double'); buf = ''; } };
      while (i < src.length && src[i] !== '"') {
        const ch = src[i];
        if (ch === '\\') {
          const n = src[i + 1];
          if (n === '"' || n === '\\' || n === '$' || n === '`') {
            flushBuf();
            add(n, 'escape');
            i += 2;
            continue;
          }
          if (n === '\n') { i += 2; continue; }
          buf += ch;
          i += 1;
          continue;
        }
        if (ch === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
          const openCh = src[i + 1];
          const closeCh = openCh === '(' ? ')' : '}';
          const end = scanBalanced(src, i + 1, openCh, closeCh);
          if (end < 0) { buf += src.slice(i); i = src.length; break; }
          buf += src.slice(i, end);
          i = end;
          continue;
        }
        if (ch === '`') {
          const end = scanBacktick(src, i);
          buf += src.slice(i, end);
          i = end;
          continue;
        }
        buf += ch;
        i += 1;
      }
      flushBuf();
      if (src[i] === '"') i += 1;
      continue;
    }

    if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
      if (!hasWord) wordStart = i;
      const openCh = src[i + 1];
      const closeCh = openCh === '(' ? ')' : '}';
      const end = scanBalanced(src, i + 1, openCh, closeCh);
      if (end < 0) { add(src.slice(i), 'none'); i = src.length; continue; }
      add(src.slice(i, end), 'none');
      i = end;
      continue;
    }

    if (c === '`') {
      if (!hasWord) wordStart = i;
      const end = scanBacktick(src, i);
      add(src.slice(i, end), 'none');
      i = end;
      continue;
    }

    if (c === '|') {
      flushWord(i);
      if (src[i + 1] === '|') { pushOp('||', {}, i, i + 2); i += 2; }
      else { pushOp('|', {}, i, i + 1); i += 1; }
      continue;
    }

    if (c === '&') {
      if (src[i + 1] === '&') { flushWord(i); pushOp('&&', {}, i, i + 2); i += 2; continue; }
      if (src[i + 1] === '>') {
        flushWord(i);
        if (src[i + 2] === '>') { pushOp('&>>', { fd: -1 }, i, i + 3); i += 3; }
        else { pushOp('&>', { fd: -1 }, i, i + 2); i += 2; }
        continue;
      }
      flushWord(i);
      pushOp('&', {}, i, i + 1);
      i += 1;
      continue;
    }

    if (c === ';') { flushWord(i); pushOp(';', {}, i, i + 1); i += 1; continue; }

    if (c === '<') {
      const fd = takeFd();
      const start = fd === null ? i : i - String(fd).length;
      flushWord(i);
      if (src[i + 1] === '&' && /[0-9]/.test(src[i + 2] || '')) {
        let j = i + 2;
        let digits = '';
        while (j < src.length && /[0-9]/.test(src[j])) { digits += src[j]; j += 1; }
        pushOp('<&', { fd: fd === null ? 0 : fd, targetFd: Number(digits) }, start, j);
        i = j;
        continue;
      }
      pushOp('<', { fd: fd === null ? 0 : fd }, start, i + 1);
      i += 1;
      continue;
    }

    if (c === '>') {
      const fd = takeFd();
      const start = fd === null ? i : i - String(fd).length;
      flushWord(i);
      if (src[i + 1] === '&') {
        if (/[0-9]/.test(src[i + 2] || '')) {
          let j = i + 2;
          let digits = '';
          while (j < src.length && /[0-9]/.test(src[j])) { digits += src[j]; j += 1; }
          pushOp('>&', { fd: fd === null ? 1 : fd, targetFd: Number(digits) }, start, j);
          i = j;
          continue;
        }
        pushOp('&>', { fd: -1 }, start, i + 2);
        i += 2;
        continue;
      }
      if (src[i + 1] === '>') {
        pushOp('>>', { fd: fd === null ? 1 : fd }, start, i + 2);
        i += 2;
        continue;
      }
      pushOp('>', { fd: fd === null ? 1 : fd }, start, i + 1);
      i += 1;
      continue;
    }

    if (!hasWord) wordStart = i;
    add(c, 'none');
    i += 1;
  }

  flushWord(src.length);
  return tokens;
}

/**
 * Does this line need a PS2 continuation? Mirrors what bash does when a quote,
 * an escape or a binary operator is left dangling.
 * @param {string} line
 * @returns {''|'dquote'|'squote'|'backslash'|'operator'|'subst'}
 */
export function needsContinuation(line) {
  const src = typeof line === 'string' ? line : '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { if (i === src.length - 1) return 'backslash'; i += 2; continue; }
    if (c === '#') { break; }
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'") j += 1;
      if (j >= src.length) return 'squote';
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      if (j >= src.length) return 'dquote';
      i = j + 1;
      continue;
    }
    if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
      const openCh = src[i + 1];
      const end = scanBalanced(src, i + 1, openCh, openCh === '(' ? ')' : '}');
      if (end < 0) return 'subst';
      i = end;
      continue;
    }
    if (c === '`') {
      const end = scanBacktick(src, i);
      if (end >= src.length && src[src.length - 1] !== '`') return 'subst';
      i = end;
      continue;
    }
    i += 1;
  }
  if (/(\|\||&&|\||;)\s*$/.test(src) && !/(\|\|\||&&&)\s*$/.test(src)) return 'operator';
  return '';
}

/* ------------------------------------------------------------------ *
 * parser
 * ------------------------------------------------------------------ */

const REDIR_OPS = new Set(['>', '>>', '<', '>&', '<&', '&>', '&>>']);
const REDIR_MODE = {
  '>': 'write',
  '>>': 'append',
  '<': 'read',
  '&>': 'both',
  '&>>': 'bothAppend',
};

function isAssignmentWord(token) {
  const first = token.parts[0];
  if (!first || first.q !== 'none') return false;
  return ASSIGN_RE.test(first.v);
}

function splitAssignment(token) {
  const first = token.parts[0];
  const eq = first.v.indexOf('=');
  const name = first.v.slice(0, eq);
  const rest = first.v.slice(eq + 1);
  const parts = [];
  if (rest !== '') parts.push({ v: rest, q: 'none' });
  for (let k = 1; k < token.parts.length; k += 1) parts.push(token.parts[k]);
  return { name, word: makeWord(parts, rest, token.pos, token.end) };
}

/**
 * @param {object[]} tokens
 * @returns {{type:'script', lists:object[]}}
 */
export function parse(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const script = { type: 'script', lists: [] };
  let i = 0;

  const fail = (tok) => {
    throw new ShellSyntaxError(tok ? (tok.raw || tok.op || 'newline') : 'newline');
  };
  const opAt = (op) => {
    const t = list[i];
    return Boolean(t) && t.type === 'op' && t.op === op;
  };

  const parseCommand = () => {
    const cmd = { type: 'command', words: [], redirs: [], assigns: [], tokens: [] };
    for (;;) {
      const t = list[i];
      if (!t) break;
      if (t.type === 'word') {
        cmd.tokens.push(t);
        if (cmd.words.length === 0 && isAssignmentWord(t)) cmd.assigns.push(splitAssignment(t));
        else cmd.words.push(t);
        i += 1;
        continue;
      }
      if (REDIR_OPS.has(t.op)) {
        cmd.tokens.push(t);
        i += 1;
        if (t.op === '>&' || t.op === '<&') {
          cmd.redirs.push({ fd: t.fd, mode: 'dup', targetFd: t.targetFd, word: null });
          continue;
        }
        const target = list[i];
        if (!target || target.type !== 'word') fail(target);
        cmd.tokens.push(target);
        i += 1;
        cmd.redirs.push({ fd: t.fd, mode: REDIR_MODE[t.op], targetFd: null, word: target });
        continue;
      }
      break;
    }
    if (cmd.words.length === 0 && cmd.assigns.length === 0 && cmd.redirs.length === 0) fail(list[i]);
    cmd.text = cmd.tokens.map((t) => t.raw).join(' ');
    return cmd;
  };

  const parsePipeline = () => {
    const commands = [parseCommand()];
    while (opAt('|')) {
      i += 1;
      commands.push(parseCommand());
    }
    return { type: 'pipeline', commands };
  };

  const parseAndOr = () => {
    const items = [{ op: null, pipeline: parsePipeline() }];
    while (opAt('&&') || opAt('||')) {
      const op = list[i].op;
      i += 1;
      items.push({ op, pipeline: parsePipeline() });
    }
    return { type: 'and-or', items, background: false, text: '' };
  };

  while (i < list.length) {
    if (opAt(';')) { i += 1; continue; }
    if (opAt('&')) { i += 1; continue; }
    const node = parseAndOr();
    node.text = node.items
      .map((it, idx) => (idx === 0 ? '' : `${it.op} `) + it.pipeline.commands.map((c) => c.text).join(' | '))
      .join(' ')
      .trim();
    if (opAt('&')) { node.background = true; i += 1; }
    else if (opAt(';')) { i += 1; }
    else if (i < list.length) fail(list[i]);
    script.lists.push(node);
  }

  return script;
}

/* ------------------------------------------------------------------ *
 * sessions
 * ------------------------------------------------------------------ */

let sessionSeq = 0;

/**
 * A shell session: one gnome-terminal tab. Each has its own cwd, variables,
 * aliases, history and job table.
 * @param {{id?:string, cwd?:string, user?:string}} [init]
 * @returns {object}
 */
export function createSession(init = {}) {
  sessionSeq += 1;
  const user = init.user || env.user || 'ubuntu';
  const home = user === 'root' ? '/root' : env.home;
  const session = {
    id: init.id || `sh${sessionSeq}`,
    cwd: init.cwd || home,
    home,
    user,
    host: env.host,
    vars: new Map(Object.entries(env.all())),
    aliases: new Map(),
    history: [],
    jobs: [],
    jobSeq: 0,
    cmdNumber: 1,
    lastExit: 0,
    lastBgPid: 0,
    lastArg: '',
    lastCommand: '',
    lastOutput: '',
    opts: new Set(),
    ps1: '',
    ps2: '',
    exited: false,
  };
  session.vars.set('PWD', session.cwd);
  session.vars.set('HOME', home);
  session.vars.set('USER', user);
  loadAliases(session);
  return session;
}

/**
 * Parse the `alias` lines out of the real `~/.bashrc` (and `~/.bash_aliases`
 * when present) and install them, exactly like an interactive login does.
 * @param {object} session
 * @returns {number} how many aliases were installed
 */
export function loadAliases(session) {
  const files = [`${session.home}/.bashrc`, `${session.home}/.bash_aliases`];
  let count = 0;
  for (const file of files) {
    let text;
    try { text = fs.readFile(file); } catch { continue; }
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('alias ')) continue;      /* commented-out lines are skipped */
      const body = line.slice(6).trim();
      const eq = body.indexOf('=');
      if (eq <= 0) continue;
      const name = body.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) continue;
      let value = body.slice(eq + 1).trim();
      const q = value[0];
      if (q === "'" || q === '"') {
        const close = value.lastIndexOf(q);
        if (close > 0) value = value.slice(1, close);
      }
      session.aliases.set(name, value);
      count += 1;
    }
  }
  return count;
}

/**
 * Make `session` the live one: push its variables and cwd into the global
 * `env` so command modules that read `env.cwd` see the right tab.
 * @param {object} session
 */
export function activateSession(session) {
  if (!session) return;
  for (const name of env.names()) {
    if (!session.vars.has(name)) env.unset(name);
  }
  for (const [k, v] of session.vars) env.set(k, v);
  env.set('PWD', session.cwd);
  env.lastExit = session.lastExit;
}

/**
 * Pull anything a command changed in the global `env` back into the session.
 * @param {object} session
 */
export function syncSession(session) {
  if (!session) return;
  session.vars = new Map(Object.entries(env.all()));
  session.cwd = env.cwd;
  session.lastExit = env.lastExit;
}

/* ------------------------------------------------------------------ *
 * expansion
 * ------------------------------------------------------------------ */

const OUT_CAP = 1 << 20;
const MAX_SUBST_DEPTH = 16;

const NULL_TERM = Object.freeze({
  cols: 80,
  rows: 24,
  write() {},
  writeLine() {},
  clear() {},
  ask() { return Promise.resolve(''); },
});

function varValue(name, sh) {
  const s = sh.session;
  if (s.vars.has(name)) return s.vars.get(name);
  const v = env.get(name);
  return v === undefined ? '' : v;
}

function varDefined(name, sh) {
  return sh.session.vars.has(name) || env.get(name) !== undefined;
}

function setVar(sh, name, value) {
  sh.session.vars.set(name, String(value));
  env.set(name, String(value));
}

function specialValue(ch, sh) {
  switch (ch) {
    case '?': return String(sh.session.lastExit | 0);
    case '$': return String(env.pid);
    case '#': return '0';
    case '!': return sh.session.lastBgPid ? String(sh.session.lastBgPid) : '';
    case '0': return 'bash';
    case '-': return 'himBHs';
    case '_': return sh.session.lastArg || '';
    case '*':
    case '@': return '';
    default: return /^[0-9]$/.test(ch) ? '' : '';
  }
}

/** Translate a shell pattern into an anchored RegExp. */
function patternToRegExp(pattern, anchor) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') { out += pattern[i + 1] ? pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\\\'; i += 1; continue; }
    if (c === '*') { out += '[\\s\\S]*'; continue; }
    if (c === '?') { out += '[\\s\\S]'; continue; }
    if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > 0) {
        let body = pattern.slice(i + 1, close);
        if (body[0] === '!') body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = close;
        continue;
      }
      out += '\\[';
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (anchor === 'prefix') return new RegExp(`^${out}`);
  if (anchor === 'suffix') return new RegExp(`${out}$`);
  return new RegExp(out);
}

function stripPattern(value, pattern, side, greedy) {
  if (pattern === '') return value;
  const whole = new RegExp(`^(?:${patternToRegExp(pattern, 'none').source})$`);
  if (side === 'prefix') {
    const cuts = [];
    for (let n = 0; n <= value.length; n += 1) cuts.push(n);
    if (greedy) cuts.reverse();
    for (const n of cuts) {
      if (whole.test(value.slice(0, n))) return value.slice(n);
    }
    return value;
  }
  const cuts = [];
  for (let n = value.length; n >= 0; n -= 1) cuts.push(n);
  if (greedy) cuts.reverse();
  for (const n of cuts) {
    if (whole.test(value.slice(n))) return value.slice(0, n);
  }
  return value;
}

/** Constant-folding integer evaluator for `$(( … ))` — never uses eval(). */
function arith(expr, sh) {
  const src = String(expr);
  let pos = 0;
  const skip = () => { while (pos < src.length && /\s/.test(src[pos])) pos += 1; };
  const peek = (s) => { skip(); return src.startsWith(s, pos); };
  const eat = (s) => { if (peek(s)) { pos += s.length; return true; } return false; };

  const primary = () => {
    skip();
    if (eat('(')) { const v = ternary(); eat(')'); return v; }
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    if (eat('!')) return primary() ? 0 : 1;
    if (eat('~')) return ~primary();
    const num = /^(0[xX][0-9a-fA-F]+|[0-9]+)/.exec(src.slice(pos));
    if (num) { pos += num[0].length; return Number(num[0]); }
    const name = /^\$?([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(pos));
    if (name) {
      pos += name[0].length;
      const raw = varValue(name[1], sh);
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    }
    pos = src.length;
    return 0;
  };
  const power = () => {
    let left = primary();
    while (peek('**')) { pos += 2; left = left ** primary(); }
    return left;
  };
  const mul = () => {
    let left = power();
    for (;;) {
      skip();
      if (peek('*') && !peek('**')) { pos += 1; left *= power(); continue; }
      if (eat('/')) { const r = power(); left = r === 0 ? 0 : Math.trunc(left / r); continue; }
      if (eat('%')) { const r = power(); left = r === 0 ? 0 : left % r; continue; }
      return left;
    }
  };
  const addsub = () => {
    let left = mul();
    for (;;) {
      skip();
      if (peek('+') && src[pos + 1] !== '+') { pos += 1; left += mul(); continue; }
      if (peek('-') && src[pos + 1] !== '-') { pos += 1; left -= mul(); continue; }
      return left;
    }
  };
  const shift = () => {
    let left = addsub();
    for (;;) {
      if (eat('<<')) { left <<= addsub(); continue; }
      if (eat('>>')) { left >>= addsub(); continue; }
      return left;
    }
  };
  const compare = () => {
    let left = shift();
    for (;;) {
      if (eat('<=')) { left = left <= shift() ? 1 : 0; continue; }
      if (eat('>=')) { left = left >= shift() ? 1 : 0; continue; }
      if (peek('<') && !peek('<<')) { pos += 1; left = left < shift() ? 1 : 0; continue; }
      if (peek('>') && !peek('>>')) { pos += 1; left = left > shift() ? 1 : 0; continue; }
      return left;
    }
  };
  const equality = () => {
    let left = compare();
    for (;;) {
      if (eat('==')) { left = left === compare() ? 1 : 0; continue; }
      if (eat('!=')) { left = left !== compare() ? 1 : 0; continue; }
      return left;
    }
  };
  const logic = () => {
    let left = equality();
    for (;;) {
      if (eat('&&')) { const r = equality(); left = left && r ? 1 : 0; continue; }
      if (eat('||')) { const r = equality(); left = left || r ? 1 : 0; continue; }
      return left;
    }
  };
  function ternary() {
    const cond = logic();
    if (eat('?')) {
      const a = ternary();
      eat(':');
      const b = ternary();
      return cond ? a : b;
    }
    return cond;
  }

  const value = ternary();
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

async function commandSubst(inner, sh) {
  if ((sh.depth || 0) >= MAX_SUBST_DEPTH) return '';
  const res = await execute(inner, {
    session: sh.session,
    term: sh.term,
    signal: sh.signal,
    capture: true,
    depth: (sh.depth || 0) + 1,
  });
  return String(res.stdout || '').replace(/\n+$/, '');
}

async function expandToText(text, sh) {
  const segs = await expandSegments(text, sh, true);
  return segs.map((s) => s.s).join('');
}

async function expandBrace(inner, sh) {
  if (inner.startsWith('#') && inner.length > 1) {
    return String(varValue(inner.slice(1), sh).length);
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[?$#!*@_-]|[0-9])([\s\S]*)$/.exec(inner);
  if (!m) return '';
  const name = m[1];
  const rest = m[2];
  const special = !NAME_START.test(name[0]);
  const defined = special ? true : varDefined(name, sh);
  const value = special ? specialValue(name, sh) : varValue(name, sh);

  if (rest === '') return value;

  if (rest.startsWith(':-')) return defined && value !== '' ? value : expandToText(rest.slice(2), sh);
  if (rest.startsWith(':=')) {
    if (defined && value !== '') return value;
    const d = await expandToText(rest.slice(2), sh);
    setVar(sh, name, d);
    return d;
  }
  if (rest.startsWith(':+')) return defined && value !== '' ? expandToText(rest.slice(2), sh) : '';
  if (rest.startsWith(':?')) {
    if (defined && value !== '') return value;
    const msg = await expandToText(rest.slice(2), sh);
    throw new ShellError(`bash: ${name}: ${msg || 'parameter null or not set'}`, 1);
  }
  if (rest.startsWith('##')) return stripPattern(value, await expandToText(rest.slice(2), sh), 'prefix', true);
  if (rest.startsWith('#')) return stripPattern(value, await expandToText(rest.slice(1), sh), 'prefix', false);
  if (rest.startsWith('%%')) return stripPattern(value, await expandToText(rest.slice(2), sh), 'suffix', true);
  if (rest.startsWith('%')) return stripPattern(value, await expandToText(rest.slice(1), sh), 'suffix', false);
  if (rest.startsWith('//') || rest.startsWith('/')) {
    const all = rest.startsWith('//');
    const body = rest.slice(all ? 2 : 1);
    const slash = body.indexOf('/');
    const pat = slash < 0 ? body : body.slice(0, slash);
    const rep = slash < 0 ? '' : await expandToText(body.slice(slash + 1), sh);
    const re = patternToRegExp(pat, 'none');
    return all ? value.replace(new RegExp(re.source, 'g'), rep) : value.replace(re, rep);
  }
  if (rest.startsWith('-')) return defined ? value : expandToText(rest.slice(1), sh);
  if (rest.startsWith('+')) return defined ? expandToText(rest.slice(1), sh) : '';
  if (rest.startsWith('=')) {
    if (defined) return value;
    const d = await expandToText(rest.slice(1), sh);
    setVar(sh, name, d);
    return d;
  }
  if (rest.startsWith(':')) {
    const nums = rest.slice(1).split(':');
    const off = Number.parseInt(nums[0], 10) || 0;
    const start = off < 0 ? Math.max(0, value.length + off) : off;
    if (nums.length < 2) return value.slice(start);
    const len = Number.parseInt(nums[1], 10) || 0;
    return len < 0 ? value.slice(start, value.length + len) : value.slice(start, start + len);
  }
  return value;
}

/**
 * Parameter and command substitution over one part of a word.
 * @returns {Promise<{s:string, quoted:boolean, split:boolean}[]>}
 */
async function expandSegments(text, sh, quoted) {
  const out = [];
  let lit = '';
  let i = 0;

  const pushLit = () => { if (lit !== '') { out.push({ s: lit, quoted, split: false }); lit = ''; } };
  const pushVal = (v) => { pushLit(); out.push({ s: String(v), quoted, split: !quoted }); };

  while (i < text.length) {
    const c = text[i];

    if (c === '`') {
      const end = scanBacktick(text, i);
      const inner = text.slice(i + 1, Math.max(i + 1, end - 1)).replace(/\\([$`\\])/g, '$1');
      pushVal(await commandSubst(inner, sh));
      i = end;
      continue;
    }

    if (c !== '$') { lit += c; i += 1; continue; }

    const n = text[i + 1];

    if (n === '(') {
      const end = scanBalanced(text, i + 1, '(', ')');
      if (end < 0) { lit += c; i += 1; continue; }
      const inner = text.slice(i + 2, end - 1);
      if (inner.startsWith('(') && inner.endsWith(')')) pushVal(String(arith(inner.slice(1, -1), sh)));
      else pushVal(await commandSubst(inner, sh));
      i = end;
      continue;
    }

    if (n === '{') {
      const end = scanBalanced(text, i + 1, '{', '}');
      if (end < 0) { lit += c; i += 1; continue; }
      pushVal(await expandBrace(text.slice(i + 2, end - 1), sh));
      i = end;
      continue;
    }

    if (n !== undefined && NAME_START.test(n)) {
      let j = i + 1;
      while (j < text.length && NAME_CHAR.test(text[j])) j += 1;
      pushVal(varValue(text.slice(i + 1, j), sh));
      i = j;
      continue;
    }

    if (n !== undefined && '?$#!*@-_0123456789'.includes(n)) {
      pushVal(specialValue(n, sh));
      i += 2;
      continue;
    }

    lit += c;
    i += 1;
  }

  pushLit();
  return out;
}

/** Tilde expansion — only at the very start of an unquoted word. */
function tildeExpand(parts, sh) {
  const first = parts[0];
  if (!first || first.q !== 'none' || first.v[0] !== '~') return parts;

  const m = /^~([A-Za-z0-9._-]*|\+|-)/.exec(first.v);
  if (!m) return parts;
  const who = m[1];
  const rest = first.v.slice(m[0].length);
  if (rest !== '' && rest[0] !== '/') return parts;

  let home;
  if (who === '' ) home = sh.session.home;
  else if (who === '+') home = sh.session.cwd;
  else if (who === '-') home = env.get('OLDPWD') || sh.session.cwd;
  else if (who === 'root') home = '/root';
  else if (fs.isDir(`/home/${who}`)) home = `/home/${who}`;
  else return parts;

  const out = [{ v: home, q: 'literal' }];
  if (rest !== '') out.push({ v: rest, q: 'none' });
  for (let k = 1; k < parts.length; k += 1) out.push(parts[k]);
  return out;
}

const IFS_SPLIT = /[ \t\n]+/;

function splitFields(segments) {
  const fields = [];
  let cur = { chunks: [], any: false };
  const endField = () => {
    if (cur.any) fields.push(cur);
    cur = { chunks: [], any: false };
  };
  for (const seg of segments) {
    if (!seg.split) {
      cur.chunks.push({ s: seg.s, quoted: seg.quoted });
      cur.any = true;
      continue;
    }
    const pieces = seg.s.split(IFS_SPLIT);
    for (let k = 0; k < pieces.length; k += 1) {
      if (k > 0) endField();
      if (pieces[k] !== '') {
        cur.chunks.push({ s: pieces[k], quoted: false });
        cur.any = true;
      }
    }
  }
  endField();
  return fields;
}

function globField(pattern, cwd) {
  let matches;
  try { matches = fs.glob(pattern, cwd); } catch { return []; }
  if (!matches || matches.length === 0) return [];
  if (path.isAbsolute(pattern) || pattern[0] === '~') return matches;
  const dot = pattern.startsWith('./');
  return matches.map((abs) => {
    const rel = path.relative(cwd, abs);
    return dot && !rel.startsWith('.') ? `./${rel}` : rel;
  });
}

/**
 * Full expansion of one word token into zero or more fields.
 * @param {object} word
 * @param {object} sh
 * @returns {Promise<string[]>}
 */
export async function expandWord(word, sh) {
  const parts = tildeExpand(word.parts, sh);
  /** @type {{s:string,quoted:boolean,split:boolean}[]} */
  const segments = [];

  for (const part of parts) {
    if (part.q === 'single' || part.q === 'escape' || part.q === 'literal') {
      segments.push({ s: part.v, quoted: true, split: false });
      continue;
    }
    const segs = await expandSegments(part.v, sh, part.q === 'double');
    for (const s of segs) segments.push(s);
  }

  const fields = splitFields(segments);
  const out = [];
  for (const field of fields) {
    const text = field.chunks.map((c) => c.s).join('');
    const globbable = field.chunks.some((c) => !c.quoted && MAGIC_RE.test(c.s));
    if (globbable) {
      const matches = globField(text, sh.session.cwd);
      if (matches.length) {
        for (const m of matches) out.push(m);
        continue;
      }
    }
    out.push(text);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * alias expansion
 * ------------------------------------------------------------------ */

const COMMAND_START_OPS = new Set(['|', '&&', '||', ';', '&']);

function isLiteralWord(token) {
  return token.type === 'word' && !token.quoted && !/[$`*?[\]~\\]/.test(token.text) && token.text !== '';
}

/**
 * Expand aliases at every command position, the way bash does at parse time.
 * @param {object[]} tokens
 * @param {object} session
 * @returns {object[]} a new token list
 */
export function expandAliases(tokens, session) {
  if (!session || !session.aliases || session.aliases.size === 0) return tokens;
  const list = tokens.slice();
  const out = [];
  const guard = new Set();
  let commandPos = true;
  let checkNext = false;
  let k = 0;
  let budget = 200;

  while (k < list.length) {
    const t = list[k];
    if (t.type === 'op') {
      out.push(t);
      commandPos = COMMAND_START_OPS.has(t.op);
      if (commandPos) guard.clear();
      checkNext = false;
      k += 1;
      continue;
    }
    if ((commandPos || checkNext) && isLiteralWord(t) && budget > 0) {
      const name = t.text;
      if (!guard.has(name) && session.aliases.has(name)) {
        guard.add(name);
        budget -= 1;
        const body = session.aliases.get(name);
        const sub = tokenize(body);
        list.splice(k, 1, ...sub);
        checkNext = /\s$/.test(body);
        continue;
      }
    }
    out.push(t);
    commandPos = false;
    checkNext = false;
    k += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * execution
 * ------------------------------------------------------------------ */

function fsPhrase(err) {
  if (err instanceof FsError) return err.message;
  return err && err.message ? err.message : 'Input/output error';
}

function makeShellCtx(ctx) {
  const session = ctx.session || createSession();
  return {
    session,
    term: ctx.term || NULL_TERM,
    signal: ctx.signal || null,
    capture: ctx.capture === true,
    depth: ctx.depth || 0,
    onExit: typeof ctx.onExit === 'function' ? ctx.onExit : null,
    stdout: '',
    stderr: '',
    exited: false,
  };
}

function emitOut(sh, text) {
  if (!text) return;
  if (sh.stdout.length < OUT_CAP) sh.stdout += text;
  if (!sh.capture) sh.term.write(text);
}

function emitErr(sh, text) {
  if (!text) return;
  if (sh.stderr.length < OUT_CAP) sh.stderr += text;
  sh.term.write(text);
}

function setExit(sh, code) {
  const n = Number.isFinite(code) ? code | 0 : 0;
  sh.session.lastExit = n;
  env.lastExit = n;
  return n;
}

function normalizeResult(res) {
  if (res === undefined || res === null) return { stdout: '', stderr: '', code: 0 };
  if (typeof res === 'string') return { stdout: res, stderr: '', code: 0 };
  if (typeof res === 'number') return { stdout: '', stderr: '', code: res | 0 };
  return {
    stdout: res.stdout === undefined || res.stdout === null ? '' : String(res.stdout),
    stderr: res.stderr === undefined || res.stderr === null ? '' : String(res.stderr),
    code: Number.isFinite(res.code) ? res.code | 0 : 0,
  };
}

function writeRedir(sh, redir, text) {
  const target = path.resolve(sh.session.cwd, path.expandTilde(redir.target, sh.session.home));
  const append = redir.mode === 'append' || redir.mode === 'bothAppend';
  try {
    fs.writeFile(target, text, { append });
    return true;
  } catch (err) {
    emitErr(sh, `bash: ${redir.target}: ${fsPhrase(err)}\n`);
    return false;
  }
}

/**
 * Build the ctx object a command receives (ARCHITECTURE §17).
 */
function makeCommandCtx(sh, name, argv, argText, stdin, cmdTerm, stdoutIsTTY) {
  const session = sh.session;
  return {
    name,
    argv,
    raw: argText,
    stdin,
    /**
     * True when this command's stdout goes straight to the terminal, false
     * when it is piped, redirected to a file, or captured by `$(...)`.
     *
     * Several GNU tools change their output format based on `isatty(1)`:
     * `ls` drops to one entry per line, and colour is suppressed. Without
     * this flag `ls *.txt | wc -l` counts 1 instead of one per file.
     */
    stdoutIsTTY: stdoutIsTTY !== false,
    env,
    fs,
    procs,
    users,
    metrics,
    gemini,
    notify,
    dialog,
    bus,
    store,
    path,
    C,
    get cwd() { return env.cwd; },
    home: session.home,
    session,
    term: cmdTerm,
    signal: sh.signal,
    getCommand,
    commandNames,
    /** Run another command line inside this session and capture its stdout. */
    run: (line) => execute(line, {
      session,
      term: sh.term,
      signal: sh.signal,
      capture: true,
      depth: (sh.depth || 0) + 1,
    }),
  };
}

async function runSimple(cmd, sh, io) {
  const session = sh.session;

  /* --- expansion ------------------------------------------------- */
  const assigns = [];
  for (const a of cmd.assigns) {
    const fields = await expandWord(a.word, sh);
    assigns.push({ name: a.name, value: fields.join(' ') });
  }

  const argv = [];
  for (const w of cmd.words) {
    const fields = await expandWord(w, sh);
    for (const f of fields) argv.push(f);
  }

  const redirs = [];
  for (const r of cmd.redirs) {
    if (r.mode === 'dup') { redirs.push({ ...r, target: null }); continue; }
    const fields = await expandWord(r.word, sh);
    if (fields.length !== 1) {
      emitErr(sh, `bash: ${r.word.text}: ambiguous redirect\n`);
      return { code: 1, stdout: '' };
    }
    redirs.push({ ...r, target: fields[0] });
  }

  /* --- assignment-only command ----------------------------------- */
  if (argv.length === 0) {
    for (const a of assigns) setVar(sh, a.name, a.value);
    for (const r of redirs) {
      if (r.mode === 'write' || r.mode === 'both') writeRedir(sh, r, '');
    }
    return { code: 0, stdout: '' };
  }

  /* --- redirection plan ------------------------------------------ */
  const inRedir = redirs.find((r) => r.mode === 'read');
  let outRedir = null;
  let errRedir = null;
  let mergeErrIntoOut = false;
  let mergeOutIntoErr = false;

  for (const r of redirs) {
    if (r.mode === 'dup') {
      if (r.fd === 2 && r.targetFd === 1) { mergeErrIntoOut = true; mergeOutIntoErr = false; }
      else if (r.fd === 1 && r.targetFd === 2) { mergeOutIntoErr = true; mergeErrIntoOut = false; }
      continue;
    }
    if (r.mode === 'both' || r.mode === 'bothAppend') { outRedir = r; errRedir = r; mergeErrIntoOut = false; continue; }
    if (r.mode === 'read') continue;
    if (r.fd === 2) errRedir = r;
    else outRedir = r;
  }

  /* `>` truncates before the command runs, exactly like the real shell. */
  for (const r of redirs) {
    if (r.mode !== 'write' && r.mode !== 'both') continue;
    const p = path.resolve(session.cwd, path.expandTilde(r.target, session.home));
    try {
      fs.writeFile(p, '');
    } catch (err) {
      emitErr(sh, `bash: ${r.target}: ${fsPhrase(err)}\n`);
      return { code: 1, stdout: '' };
    }
  }

  /* --- stdin ------------------------------------------------------ */
  let stdin = io.stdin || '';
  if (inRedir) {
    const p = path.resolve(session.cwd, path.expandTilde(inRedir.target, session.home));
    try {
      stdin = fs.readFile(p);
    } catch (err) {
      emitErr(sh, `bash: ${inRedir.target}: ${fsPhrase(err)}\n`);
      return { code: 1, stdout: '' };
    }
  }

  /* --- output plumbing -------------------------------------------- */
  const direct = io.isLast && !outRedir && !mergeOutIntoErr && !sh.capture;
  let buffered = '';
  const cmdTerm = {
    get cols() { return sh.term.cols || 80; },
    get rows() { return sh.term.rows || 24; },
    write(text) {
      const s = text === undefined || text === null ? '' : String(text);
      if (s === '') return;
      if (direct) emitOut(sh, s);
      else buffered += s;
    },
    writeLine(text) {
      cmdTerm.write(`${text === undefined || text === null ? '' : String(text)}\n`);
    },
    clear() { if (direct) sh.term.clear(); },
    ask(prompt, options) { return sh.term.ask(prompt, options); },
  };

  /* --- resolve and run -------------------------------------------- */
  const name = argv[0];
  const args = argv.slice(1);
  const argText = args.join(' ');
  session.lastArg = args.length ? args[args.length - 1] : name;

  const savedAssigns = [];
  for (const a of assigns) {
    savedAssigns.push({ name: a.name, had: session.vars.has(a.name), old: session.vars.get(a.name) });
    setVar(sh, a.name, a.value);
  }

  let res;
  try {
    if (sh.signal && sh.signal.aborted) {
      res = { code: 130 };
    } else {
      const builtin = BUILTINS[name];
      if (builtin) {
        res = await builtin.run({
          argv: args,
          raw: argText,
          stdin,
          sh,
          session,
          term: cmdTerm,
          signal: sh.signal,
          write: (t) => cmdTerm.write(t),
        });
      } else {
        const command = getCommand(name);
        if (command) {
          res = await command.run(
            makeCommandCtx(sh, name, args, argText, stdin, cmdTerm, direct),
          );
        } else {
          res = { stderr: commandNotFound(name), code: 127 };
        }
      }
    }
  } catch (err) {
    if (err && (err.name === 'AbortError' || (sh.signal && sh.signal.aborted))) {
      res = { code: 130 };
    } else if (err instanceof FsError) {
      res = { stderr: `${name}: ${err.path ? `${err.path}: ` : ''}${err.message}\n`, code: 1 };
    } else if (err instanceof ShellError) {
      res = { stderr: `${err.message}\n`, code: err.code };
    } else {
      console.error(`[terminal] ${name} failed:`, err);
      res = { stderr: `${name}: ${err && err.message ? err.message : 'unexpected error'}\n`, code: 1 };
    }
  } finally {
    for (const s of savedAssigns) {
      if (s.had) { session.vars.set(s.name, s.old); env.set(s.name, s.old); }
      else { session.vars.delete(s.name); env.unset(s.name); }
    }
  }

  const result = normalizeResult(res);
  let out = buffered + result.stdout;
  let errText = result.stderr;

  if (mergeErrIntoOut && errText) { out += errText; errText = ''; }
  if (mergeOutIntoErr && out) { errText += out; out = ''; }

  if (errText) {
    if (errRedir) writeRedir(sh, errRedir, errText);
    else emitErr(sh, errText);
  }

  if (outRedir) {
    writeRedir(sh, outRedir, out);
    out = '';
  } else if (io.isLast) {
    emitOut(sh, direct ? result.stdout : out);
  }

  return { code: result.code, stdout: out };
}

async function runPipeline(pipeline, sh) {
  let stdin = '';
  let code = 0;
  const cmds = pipeline.commands;
  for (let i = 0; i < cmds.length; i += 1) {
    if (sh.signal && sh.signal.aborted) return 130;
    const res = await runSimple(cmds[i], sh, {
      stdin,
      isLast: i === cmds.length - 1,
    });
    stdin = res.stdout || '';
    code = res.code;
    if (sh.exited) break;
  }
  return code;
}

function startBackground(node, sh) {
  const session = sh.session;
  session.jobSeq += 1;
  const jobId = session.jobSeq;
  const text = node.text || '';
  const first = text.split(/\s+/)[0] || 'bash';
  const pid = procs.spawn({ name: first, cmd: text, cpu: 0.4, mem: 6 });
  const controller = new AbortController();
  const job = { id: jobId, pid, cmd: text, state: 'Running', controller };
  session.jobs.push(job);
  session.lastBgPid = pid;
  sh.term.write(`[${jobId}] ${pid}\n`);

  const detached = {
    session,
    term: sh.term,
    signal: controller.signal,
    capture: false,
    depth: (sh.depth || 0) + 1,
  };

  job.promise = (async () => {
    let code = 0;
    try {
      const clone = { type: 'and-or', items: node.items, background: false, text };
      const child = makeShellCtx(detached);
      code = await runAndOr(clone, child);
    } catch (err) {
      console.error('[terminal] background job failed:', err);
      code = 1;
    }
    procs.kill(pid, 9);
    job.state = code === 0 ? 'Done' : 'Exit';
    job.code = code;
    const mark = code === 0 ? 'Done' : `Exit ${code}`;
    sh.term.write(`[${jobId}]+  ${mark.padEnd(24)}${text}\n`);
    return code;
  })();

  return 0;
}

async function runAndOr(node, sh) {
  if (node.background) return startBackground(node, sh);

  let code = sh.session.lastExit | 0;
  let first = true;
  for (const item of node.items) {
    if (!first) {
      if (item.op === '&&' && code !== 0) continue;
      if (item.op === '||' && code === 0) continue;
    }
    first = false;
    code = await runPipeline(item.pipeline, sh);
    setExit(sh, code);
    if (sh.exited) break;
    if (sh.signal && sh.signal.aborted) break;
  }
  return code;
}

/**
 * Run a command line.
 *
 * @param {string} line
 * @param {{session?:object, term?:object, signal?:AbortSignal, capture?:boolean,
 *          depth?:number, onExit?:Function, noAlias?:boolean}} [ctx]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export async function execute(line, ctx = {}) {
  const sh = makeShellCtx(ctx);
  const src = typeof line === 'string' ? line : '';

  if (src.trim() === '') {
    return { code: sh.session.lastExit | 0, stdout: '', stderr: '' };
  }

  let ast;
  try {
    const raw = tokenize(src);
    ast = parse(ctx.noAlias === true ? raw : expandAliases(raw, sh.session));
  } catch (err) {
    const message = err instanceof ShellError ? err.message : `bash: ${err.message}`;
    emitErr(sh, `${message}\n`);
    setExit(sh, err instanceof ShellError ? err.code : 2);
    return { code: sh.session.lastExit, stdout: sh.stdout, stderr: sh.stderr };
  }

  let code = sh.session.lastExit | 0;
  for (const node of ast.lists) {
    if (sh.signal && sh.signal.aborted) { code = setExit(sh, 130); break; }
    try {
      code = await runAndOr(node, sh);
    } catch (err) {
      if (err instanceof ShellError) {
        emitErr(sh, `${err.message}\n`);
        code = setExit(sh, err.code);
      } else if (err && err.name === 'AbortError') {
        code = setExit(sh, 130);
      } else {
        console.error('[terminal] execution error:', err);
        emitErr(sh, `bash: ${err && err.message ? err.message : 'internal error'}\n`);
        code = setExit(sh, 1);
      }
      break;
    }
    if (sh.exited) break;
    if (sh.session.opts.has('e') && code !== 0) break;
  }

  setExit(sh, code);
  if (sh.exited && sh.onExit) sh.onExit(code);
  sh.session.lastCommand = src;
  sh.session.lastOutput = stripAnsi(sh.stdout).slice(0, 8000);
  return { code, stdout: sh.stdout, stderr: sh.stderr };
}

/* ------------------------------------------------------------------ *
 * introspection helpers used by readline and the `type`/`help` builtins
 * ------------------------------------------------------------------ */

export { isBuiltin, builtinNames, commandNotFound };

/**
 * Everything that can start a command line, for first-word tab completion.
 * @param {object} [session]
 * @returns {string[]} sorted, de-duplicated
 */
export function completionNames(session) {
  const set = new Set(commandNames());
  for (const b of builtinNames()) set.add(b);
  if (session && session.aliases) {
    for (const a of session.aliases.keys()) set.add(a);
  }
  return Array.from(set).sort();
}
