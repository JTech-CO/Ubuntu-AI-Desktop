/**
 * jq-engine.js — a jq 1.7.1 interpreter.
 *
 * Pure: no filesystem, terminal or DOM. `compile(program)` parses and checks
 * a filter; `run(filter, input, io)` returns a generator of results.
 *
 * Values are JSON values with objects held in a Map, because jq keeps keys
 * in insertion order and a plain JS object would move integer-like keys
 * ("2", "10") to the front.
 *
 * Evaluation is a tree of generators, which gives jq's backtracking for
 * free: `.[] | select(.a)` pulls one value at a time. Every result travels
 * with its path (or null when it is not a path expression), so `path(f)`,
 * `del(f)`, `|=` and friends work on any filter built from path-preserving
 * parts — including user-defined functions — exactly as in jq.
 *
 * Derived builtins (map, select, to_entries, walk, …) are written in jq
 * itself in PRELUDE below, as jq's own builtin.jq does.
 */

/* ================================================================== *
 * errors
 * ================================================================== */

/** A runtime error raised by the program; `value` is what `catch` sees. */
export class JqError extends Error {
  constructor(value) {
    super(typeof value === 'string' ? value : 'jq error');
    this.value = value;
  }
}

/** `break $label` unwinding to its `label`. */
class JqBreak {
  constructor(id) { this.id = id; }
}

/** `halt` / `halt_error`. */
export class JqHalt {
  constructor(code, value, hasValue) {
    this.code = code;
    this.value = value;
    this.hasValue = hasValue;
  }
}

/** A syntax or name-resolution error; `pos` is an offset into the source. */
export class JqCompileError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

/** Raised when a program exceeds the emulator's time budget. */
export class JqTimeout extends Error {}

/* ================================================================== *
 * values
 * ================================================================== */

const isObj = (v) => v instanceof Map;

export function typeName(v) {
  if (v === null) return 'null';
  if (v === true || v === false) return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  return 'object';
}

const truthy = (v) => v !== null && v !== false;

const KIND_ORDER = { null: 0, boolean: 1, number: 3, string: 4, array: 5, object: 6 };
function kindRank(v) {
  if (v === true) return 2;
  return KIND_ORDER[typeName(v)];
}

function cmpStr(a, b) {
  // jq compares UTF-8 bytes, which orders by code point.
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const d = x.value.codePointAt(0) - y.value.codePointAt(0);
    if (d) return d < 0 ? -1 : 1;
  }
}

const sortedKeys = (m) => Array.from(m.keys()).sort(cmpStr);

/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
export function compare(a, b) {
  const ka = kindRank(a);
  const kb = kindRank(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  switch (typeName(a)) {
    case 'number': return a < b ? -1 : a > b ? 1 : 0;
    case 'string': return cmpStr(a, b);
    case 'array': {
      for (let i = 0; i < a.length && i < b.length; i += 1) {
        const c = compare(a[i], b[i]);
        if (c) return c;
      }
      return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    }
    case 'object': {
      const ak = sortedKeys(a);
      const bk = sortedKeys(b);
      const c = compare(ak, bk);
      if (c) return c;
      for (const k of ak) {
        const d = compare(a.get(k), b.get(k));
        if (d) return d;
      }
      return 0;
    }
    default: return 0;
  }
}

const equal = (a, b) => compare(a, b) === 0;

/* ================================================================== *
 * JSON text
 * ================================================================== */

export function formatNumber(n) {
  if (Number.isNaN(n)) return 'null';
  if (!Number.isFinite(n)) return n > 0 ? '1.7976931348623157e+308' : '-1.7976931348623157e+308';
  if (Object.is(n, -0)) return '-0';
  return String(n).replace(/e([+-])(\d)$/, 'e$10$2');
}

function hex4(c) {
  return `\\u${c.toString(16).padStart(4, '0')}`;
}

export function quoteString(s, ascii = false) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c < 0x20 || c === 0x7f) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else out += hex4(c);
    } else if (ascii && c > 0x7e) {
      if (c > 0xffff) {
        const v = c - 0x10000;
        out += hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
      } else out += hex4(c);
    } else out += ch;
  }
  return `${out}"`;
}

const ESC = String.fromCharCode(27);

/** jq 1.7.1's default JQ_COLORS. */
export const DEFAULT_COLORS = ['1;30', '0;39', '0;39', '0;39', '0;32', '1;39', '1;39', '34;1'];

/**
 * Serialize a value.
 * @param {*} v
 * @param {{indent?: string, sortKeys?: boolean, colors?: string[]|null, ascii?: boolean}} [o]
 *        indent '' means compact output
 */
export function dump(v, o = {}, level = 0) {
  const indent = o.indent || '';
  const col = o.colors || null;
  const paint = (c, s) => (col ? `${ESC}[${c}m${s}${ESC}[0m` : s);
  const nl = indent ? '\n' : '';
  const pad = (n) => indent.repeat(n);

  switch (typeName(v)) {
    case 'null': return paint(col && col[0], 'null');
    case 'boolean': return paint(col && (v ? col[2] : col[1]), v ? 'true' : 'false');
    case 'number': return paint(col && col[3], formatNumber(v));
    case 'string': return paint(col && col[4], quoteString(v, o.ascii));
    case 'array': {
      const c = col && col[5];
      if (v.length === 0) return paint(c, '[]');
      const items = v.map((x) => `${pad(level + 1)}${dump(x, o, level + 1)}`);
      return `${paint(c, '[')}${nl}${items.join(`${paint(c, ',')}${nl}`)}${nl}${pad(level)}${paint(c, ']')}`;
    }
    default: {
      const c = col && col[6];
      if (v.size === 0) return paint(c, '{}');
      const keys = o.sortKeys ? sortedKeys(v) : Array.from(v.keys());
      const sep = indent ? ': ' : ':';
      const items = keys.map((k) => `${pad(level + 1)}${paint(col && col[7], quoteString(k, o.ascii))}${paint(c, sep.trimEnd())}${indent ? ' ' : ''}${dump(v.get(k), o, level + 1)}`);
      return `${paint(c, '{')}${nl}${items.join(`${paint(c, ',')}${nl}`)}${nl}${pad(level)}${paint(c, '}')}`;
    }
  }
}

const compact = (v) => dump(v, {});

/** Value shown inside an error message, truncated as jq does. */
function trunc(v) {
  const s = compact(v);
  return s.length > 14 ? `${s.slice(0, 11)}...` : s;
}

/** Stream parser for JSON input (several values, whitespace separated). */
export class JsonReader {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }

  where(pos, eof = false) {
    let line = 1;
    let last = -1;
    for (let k = 0; k < pos && k < this.s.length; k += 1) {
      if (this.s.charCodeAt(k) === 10) { line += 1; last = k; }
    }
    return `${eof ? 'at EOF ' : ''}at line ${line}, column ${pos - last - 1}`;
  }

  /** Report as jq does: the position just past the character that failed. */
  fail(msg) {
    const eof = this.i >= this.s.length;
    this.failAt(msg, eof ? this.s.length : this.i + 1, eof);
  }

  failAt(msg, pos, eof) {
    throw new SyntaxError(`${msg} ${this.where(pos, eof)}`);
  }

  ws() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) this.i += 1;
      else break;
    }
  }

  /** @returns {boolean} true when another value follows */
  more() {
    this.ws();
    return this.i < this.s.length;
  }

  /** Lines consumed so far, for `jq: error (at <stdin>:N)`. */
  lineNo() {
    let n = 0;
    for (let k = 0; k < this.i && k < this.s.length; k += 1) if (this.s.charCodeAt(k) === 10) n += 1;
    // jq has read the newline that ends the value too
    if (this.s.charCodeAt(this.i) === 10) n += 1;
    return n;
  }

  next() {
    this.ws();
    const v = this.value(0);
    return v;
  }

  value(depth) {
    if (depth > 10000) this.fail('Exceeds depth limit for parsing');
    this.ws();
    const s = this.s;
    if (this.i >= s.length) this.fail('Unfinished JSON term');
    const c = s[this.i];
    if (c === '{') {
      this.i += 1;
      const m = new Map();
      this.ws();
      if (s[this.i] === '}') { this.i += 1; return m; }
      for (;;) {
        this.ws();
        if (s[this.i] !== '"') {
          if (this.i >= s.length) this.fail('Unfinished JSON term');
          this.fail('Object keys must be strings');
        }
        const k = this.string();
        this.ws();
        if (s[this.i] !== ':') {
          if (this.i >= s.length) this.fail('Unfinished JSON term');
          this.fail('Objects must consist of key:value pairs');
        }
        this.i += 1;
        m.set(k, this.value(depth + 1));
        this.ws();
        if (s[this.i] === ',') { this.i += 1; continue; }
        if (s[this.i] === '}') { this.i += 1; return m; }
        if (this.i >= s.length) this.fail('Unfinished JSON term');
        this.fail('Expected separator between values');
      }
    }
    if (c === '[') {
      this.i += 1;
      const a = [];
      this.ws();
      if (s[this.i] === ']') { this.i += 1; return a; }
      for (;;) {
        a.push(this.value(depth + 1));
        this.ws();
        if (s[this.i] === ',') { this.i += 1; continue; }
        if (s[this.i] === ']') { this.i += 1; return a; }
        if (this.i >= s.length) this.fail('Unfinished JSON term');
        this.fail('Expected separator between values');
      }
    }
    if (c === '"') return this.string();
    if (c === ']' || c === '}') this.fail(`Unmatched '${c}'`);
    if (c === ',' || c === ':') this.fail(`'${c}' not as part of an object or array`);
    // a bare literal: number, true, false, null, nan
    const start = this.i;
    while (this.i < s.length && /[A-Za-z0-9.+\-]/.test(s[this.i])) this.i += 1;
    const tok = s.slice(start, this.i);
    if (tok === '') this.fail('Invalid literal');
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (tok === 'nan' || tok === 'NaN') return NaN;
    if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
    // jq notices at the character after the token (or at EOF)
    const eof = this.i >= s.length;
    this.failAt(/^[tfn]/.test(tok) ? 'Invalid literal' : 'Invalid numeric literal', eof ? s.length : this.i + 1, eof);
    return null;
  }

  string() {
    const s = this.s;
    this.i += 1;
    let out = '';
    let run = this.i;
    for (;;) {
      if (this.i >= s.length) this.fail('Unfinished string');
      const c = s.charCodeAt(this.i);
      if (c === 34) {
        out += s.slice(run, this.i);
        this.i += 1;
        return out;
      }
      if (c === 92) {
        out += s.slice(run, this.i);
        const e = s[this.i + 1];
        this.i += 2;
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === '/' || e === '\\' || e === '"') out += e;
        else if (e === 'u') {
          const h = s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail('Invalid escape');
          out += String.fromCharCode(parseInt(h, 16));
          this.i += 4;
        } else this.fail('Invalid escape');
        run = this.i;
        continue;
      }
      this.i += 1;
    }
  }
}

/** Parse exactly one JSON text (for fromjson, --argjson). */
export function parseJson(text) {
  const r = new JsonReader(text);
  if (!r.more()) throw new SyntaxError('Expected JSON value');
  const v = r.next();
  if (r.more()) throw new SyntaxError(`Unexpected extra JSON values ${r.where(r.i)}`);
  return v;
}

/** Convert a plain JS value (from JSON.parse or the environment) to engine values. */
export function fromJs(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(fromJs);
  if (typeof v === 'object') {
    const m = new Map();
    for (const [k, x] of Object.entries(v)) m.set(k, fromJs(x));
    return m;
  }
  return v;
}

/* ================================================================== *
 * lexer + parser
 * ================================================================== */

const KEYWORDS = new Set(['def', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach', 'try', 'catch', 'label', 'import', 'include', 'and', 'or', '__loc__']);
const OPS = ['?//', '|=', '+=', '-=', '*=', '/=', '%=', '//=', '==', '!=', '<=', '>=', '//', '..',
  '.', '[', ']', '{', '}', '(', ')', '|', ',', ':', ';', '=', '<', '>', '+', '-', '*', '/', '%', '?'];
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

class Parser {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.cache = null;
  }

  skip(p) {
    const s = this.src;
    for (;;) {
      while (p < s.length && /\s/.test(s[p])) p += 1;
      if (s[p] === '#') {
        while (p < s.length && s[p] !== '\n') p += 1;
        continue;
      }
      return p;
    }
  }

  /** Token at the current position (not consumed). */
  peek() {
    if (this.cache && this.cache.at === this.pos) return this.cache.tok;
    const tok = this.lex(this.pos);
    this.cache = { at: this.pos, tok };
    return tok;
  }

  lex(at) {
    const s = this.src;
    const p = this.skip(at);
    if (p >= s.length) return { t: 'eof', start: p, end: p };
    const c = s[p];
    // .foo
    if (c === '.' && IDENT_START.test(s[p + 1] || '')) {
      let e = p + 1;
      while (e < s.length && IDENT_CHAR.test(s[e])) e += 1;
      return { t: 'field', v: s.slice(p + 1, e), start: p, end: e };
    }
    // numbers, including .5
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[p + 1] || ''))) {
      const m = /^([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?/.exec(s.slice(p));
      return { t: 'num', v: Number(m[0]), start: p, end: p + m[0].length };
    }
    if (c === '"') return { t: 'str', start: p, end: p + 1 };
    if (c === '$') {
      let e = p + 1;
      if (s.startsWith('__loc__', e)) return { t: 'loc', start: p, end: e + 7 };
      if (!IDENT_START.test(s[e] || '')) return { t: 'bad', v: '$', start: p, end: p + 1 };
      while (e < s.length && (IDENT_CHAR.test(s[e]) || (s[e] === ':' && s[e + 1] === ':'))) e += s[e] === ':' ? 2 : 1;
      return { t: 'var', v: s.slice(p + 1, e), start: p, end: e };
    }
    if (c === '@') {
      let e = p + 1;
      while (e < s.length && IDENT_CHAR.test(s[e])) e += 1;
      return { t: 'format', v: s.slice(p + 1, e), start: p, end: e };
    }
    if (IDENT_START.test(c)) {
      let e = p;
      while (e < s.length && (IDENT_CHAR.test(s[e]) || (s[e] === ':' && s[e + 1] === ':' && IDENT_START.test(s[e + 2] || '')))) e += s[e] === ':' ? 2 : 1;
      const word = s.slice(p, e);
      return { t: KEYWORDS.has(word) ? word : 'ident', v: word, start: p, end: e };
    }
    for (const op of OPS) {
      if (s.startsWith(op, p)) return { t: op, start: p, end: p + op.length };
    }
    return { t: 'bad', v: c, start: p, end: p + 1 };
  }

  next() {
    const tok = this.peek();
    this.pos = tok.end;
    return tok;
  }

  is(t) { return this.peek().t === t; }

  accept(t) {
    if (this.is(t)) { this.next(); return true; }
    return false;
  }

  expect(t) {
    if (!this.is(t)) this.unexpected();
    return this.next();
  }

  unexpected() {
    const tok = this.peek();
    let what;
    if (tok.t === 'eof') what = 'end of file';
    else if (tok.t === 'bad') what = 'INVALID_CHARACTER';
    else if (tok.t === 'ident') what = 'IDENT';
    else if (tok.t === 'field') what = 'FIELD';
    else if (tok.t === 'num') what = 'LITERAL';
    else if (tok.t === 'str') what = 'QQSTRING_START';
    else if (tok.t === 'var') what = `'$'`;
    else if (tok.t === 'format') what = 'FORMAT';
    else what = KEYWORDS.has(tok.t) ? tok.t : `'${this.src.slice(tok.start, tok.end)}'`;
    throw new JqCompileError(`syntax error, unexpected ${what} (Unix shell quoting issues?)`, tok.start);
  }

  node(k, props, pos) {
    return { k, pos, ...props };
  }

  /* --- grammar ----------------------------------------------------- */

  program() {
    const e = this.pipe();
    if (!this.is('eof')) this.unexpected();
    return e;
  }

  pipe() {
    const at = this.peek().start;
    if (this.is('def')) {
      const def = this.funcDef();
      const rest = this.pipe();
      return this.node('def', { ...def, rest }, at);
    }
    const left = this.comma();
    if (this.accept('|')) return this.node('pipe', { l: left, r: this.pipe() }, at);
    return left;
  }

  funcDef() {
    this.expect('def');
    const nameTok = this.peek();
    if (nameTok.t !== 'ident' && !KEYWORDS.has(nameTok.t)) this.unexpected();
    this.next();
    const params = [];
    if (this.accept('(')) {
      do {
        const t = this.next();
        if (t.t === 'var') params.push({ name: t.v, isVar: true });
        else if (t.t === 'ident') params.push({ name: t.v, isVar: false });
        else { this.pos = t.start; this.cache = null; this.unexpected(); }
      } while (this.accept(';'));
      this.expect(')');
    }
    this.expect(':');
    const body = this.pipe();
    this.expect(';');
    return { name: nameTok.v, params, body };
  }

  comma() {
    let left = this.alt();
    while (this.is(',')) {
      const at = this.next().start;
      left = this.node('comma', { l: left, r: this.alt() }, at);
    }
    return left;
  }

  alt() {
    const left = this.assign();
    if (this.is('//')) {
      const at = this.next().start;
      return this.node('alt', { l: left, r: this.alt() }, at);
    }
    return left;
  }

  assign() {
    const left = this.or();
    const t = this.peek().t;
    if (['=', '|=', '+=', '-=', '*=', '/=', '%=', '//='].includes(t)) {
      const at = this.next().start;
      return this.node('assign', { op: t, l: left, r: this.alt() }, at);
    }
    return left;
  }

  or() {
    let left = this.and();
    while (this.is('or')) {
      const at = this.next().start;
      left = this.node('or', { l: left, r: this.and() }, at);
    }
    return left;
  }

  and() {
    let left = this.cmp();
    while (this.is('and')) {
      const at = this.next().start;
      left = this.node('and', { l: left, r: this.cmp() }, at);
    }
    return left;
  }

  cmp() {
    const left = this.add();
    const t = this.peek().t;
    if (['==', '!=', '<', '<=', '>', '>='].includes(t)) {
      const at = this.next().start;
      const right = this.add();
      if (['==', '!=', '<', '<=', '>', '>='].includes(this.peek().t)) this.unexpected();
      return this.node('bin', { op: t, l: left, r: right }, at);
    }
    return left;
  }

  add() {
    let left = this.mul();
    while (this.is('+') || this.is('-')) {
      const tok = this.next();
      left = this.node('bin', { op: tok.t, l: left, r: this.mul() }, tok.start);
    }
    return left;
  }

  mul() {
    let left = this.unary();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const tok = this.next();
      left = this.node('bin', { op: tok.t, l: left, r: this.unary() }, tok.start);
    }
    return left;
  }

  unary() {
    if (this.is('-')) {
      const at = this.next().start;
      return this.node('neg', { e: this.unary() }, at);
    }
    return this.postfix(false);
  }

  /** A term with its suffixes: .a, [e], [], [a:b], ?, and `as` bindings. */
  postfix(noAs) {
    let t = this.primary();
    for (;;) {
      const tok = this.peek();
      if (tok.t === 'field') {
        this.next();
        t = this.node('index', { t, key: this.node('lit', { v: tok.v }, tok.start) }, tok.start);
      } else if (tok.t === '.' && this.src[tok.end] === '"') {
        this.next();
        t = this.node('index', { t, key: this.string(null) }, tok.start);
      } else if (tok.t === '.' && this.lex(tok.end).t === '[') {
        this.next();
      } else if (tok.t === '[') {
        this.next();
        t = this.bracket(t, tok.start);
      } else if (tok.t === '?') {
        this.next();
        t = this.node('try', { body: t, handler: null }, tok.start);
      } else if (tok.t === 'as' && !noAs) {
        this.next();
        const patterns = [this.pattern()];
        while (this.accept('?//')) patterns.push(this.pattern());
        this.expect('|');
        return this.node('as', { src: t, patterns, body: this.pipe() }, tok.start);
      } else {
        return t;
      }
    }
  }

  bracket(t, at) {
    if (this.accept(']')) return this.node('iter', { t }, at);
    if (this.accept(':')) {
      const to = this.pipe();
      this.expect(']');
      return this.node('slice', { t, from: null, to }, at);
    }
    const e = this.pipe();
    if (this.accept(':')) {
      const to = this.is(']') ? null : this.pipe();
      this.expect(']');
      return this.node('slice', { t, from: e, to }, at);
    }
    this.expect(']');
    return this.node('index', { t, key: e }, at);
  }

  primary() {
    const tok = this.peek();
    const at = tok.start;
    switch (tok.t) {
      case '.': {
        this.next();
        if (this.src[tok.end] === '"') return this.node('index', { t: this.node('id', {}, at), key: this.string(null) }, at);
        return this.node('id', {}, at);
      }
      case '..':
        this.next();
        return this.node('call', { name: 'recurse', args: [] }, at);
      case 'field':
        this.next();
        return this.node('index', { t: this.node('id', {}, at), key: this.node('lit', { v: tok.v }, at) }, at);
      case 'num':
        this.next();
        return this.node('lit', { v: tok.v }, at);
      case 'str':
        return this.string(null);
      case 'format': {
        this.next();
        if (!FORMATS.has(tok.v)) throw new JqCompileError(`${tok.v} is not a valid format`, at);
        if (this.is('str')) return this.string(tok.v);
        return this.node('format', { fmt: tok.v }, at);
      }
      case '(': {
        this.next();
        const e = this.pipe();
        this.expect(')');
        return e;
      }
      case '[': {
        this.next();
        if (this.accept(']')) return this.node('array', { body: null }, at);
        const body = this.pipe();
        this.expect(']');
        return this.node('array', { body }, at);
      }
      case '{':
        this.next();
        return this.object(at);
      case 'var':
        this.next();
        return this.node('var', { name: tok.v }, at);
      case 'loc':
        this.next();
        return this.node('loc', { line: this.lineOf(at) }, at);
      case 'if': return this.ifExpr();
      case 'try': {
        this.next();
        const body = this.postfixNoTry();
        let handler = null;
        if (this.accept('catch')) handler = this.postfixNoTry();
        return this.node('try', { body, handler }, at);
      }
      case 'reduce': {
        this.next();
        const src = this.postfix(true);
        this.expect('as');
        const patterns = [this.pattern()];
        while (this.accept('?//')) patterns.push(this.pattern());
        this.expect('(');
        const init = this.pipe();
        this.expect(';');
        const update = this.pipe();
        this.expect(')');
        return this.node('reduce', { src, patterns, init, update }, at);
      }
      case 'foreach': {
        this.next();
        const src = this.postfix(true);
        this.expect('as');
        const patterns = [this.pattern()];
        while (this.accept('?//')) patterns.push(this.pattern());
        this.expect('(');
        const init = this.pipe();
        this.expect(';');
        const update = this.pipe();
        let extract = null;
        if (this.accept(';')) extract = this.pipe();
        this.expect(')');
        return this.node('foreach', { src, patterns, init, update, extract }, at);
      }
      case 'label': {
        this.next();
        const v = this.expect('var');
        this.expect('|');
        return this.node('label', { name: v.v, body: this.pipe() }, at);
      }
      case 'def': {
        const def = this.funcDef();
        return this.node('def', { ...def, rest: this.pipe() }, at);
      }
      case 'ident': {
        this.next();
        if (tok.v === 'break') {
          const v = this.expect('var');
          return this.node('break', { name: v.v }, at);
        }
        if (!this.is('(')) {
          if (tok.v === 'true') return this.node('lit', { v: true }, at);
          if (tok.v === 'false') return this.node('lit', { v: false }, at);
          if (tok.v === 'null') return this.node('lit', { v: null }, at);
        }
        const args = [];
        if (this.accept('(')) {
          do args.push(this.pipe()); while (this.accept(';'));
          this.expect(')');
        }
        return this.node('call', { name: tok.v, args }, at);
      }
      case '-':
        return this.unary();
      default:
        this.unexpected();
        return null;
    }
  }

  /** `try` binds tighter than postfix `?`… but still takes indexing. */
  postfixNoTry() {
    return this.postfix(true);
  }

  ifExpr() {
    return this.ifRest(this.expect('if').start);
  }

  /** After `if`/`elif`: an `elif` chain nests, and the innermost takes the `end`. */
  ifRest(at) {
    const cond = this.pipe();
    this.expect('then');
    const then = this.pipe();
    if (this.is('elif')) {
      const elifAt = this.next().start;
      return this.node('if', { cond, then, other: this.ifRest(elifAt) }, at);
    }
    const other = this.accept('else') ? this.pipe() : null;
    this.expect('end');
    return this.node('if', { cond, then, other }, at);
  }

  object(at) {
    const entries = [];
    if (this.accept('}')) return this.node('object', { entries }, at);
    for (;;) {
      const tok = this.peek();
      let key;
      let value = null;
      if (tok.t === 'var') {
        this.next();
        if (this.accept(':')) {
          key = this.node('var', { name: tok.v }, tok.start);
          value = this.objValue();
        } else {
          key = this.node('lit', { v: tok.v }, tok.start);
          value = this.node('var', { name: tok.v }, tok.start);
        }
      } else if (tok.t === 'loc') {
        this.next();
        key = this.node('lit', { v: '__loc__' }, tok.start);
        value = this.node('loc', { line: this.lineOf(tok.start) }, tok.start);
      } else if (tok.t === 'ident' || KEYWORDS.has(tok.t)) {
        this.next();
        key = this.node('lit', { v: tok.v }, tok.start);
        if (this.accept(':')) value = this.objValue();
        else value = this.node('index', { t: this.node('id', {}, tok.start), key }, tok.start);
      } else if (tok.t === 'str' || tok.t === 'format') {
        if (tok.t === 'format') {
          this.next();
          if (!this.is('str')) this.unexpected();
          key = this.string(tok.v);
        } else key = this.string(null);
        if (this.accept(':')) value = this.objValue();
        else value = this.node('index', { t: this.node('id', {}, tok.start), key }, tok.start);
      } else if (tok.t === 'num') {
        this.next();
        key = this.node('lit', { v: tok.v }, tok.start);
        this.expect(':');
        value = this.objValue();
      } else if (tok.t === '(') {
        this.next();
        key = this.pipe();
        this.expect(')');
        this.expect(':');
        value = this.objValue();
      } else {
        this.unexpected();
      }
      entries.push({ key, value });
      if (this.accept(',')) continue;
      this.expect('}');
      return this.node('object', { entries }, at);
    }
  }

  /** Object values: pipes without commas (`{a: .b | .c, d: 1}`). */
  objValue() {
    let left = this.alt();
    while (this.is('|')) {
      const at = this.next().start;
      left = this.node('pipe', { l: left, r: this.alt() }, at);
    }
    return left;
  }

  pattern() {
    const tok = this.peek();
    if (tok.t === 'var') {
      this.next();
      return { k: 'pvar', name: tok.v };
    }
    if (tok.t === '[') {
      this.next();
      const items = [];
      if (!this.is(']')) {
        do items.push(this.pattern()); while (this.accept(','));
      }
      this.expect(']');
      return { k: 'parr', items };
    }
    if (tok.t === '{') {
      this.next();
      const entries = [];
      do {
        const t = this.peek();
        if (t.t === 'var') {
          this.next();
          const sub = this.accept(':') ? this.pattern() : null;
          entries.push({ key: { k: 'lit', v: t.v }, bind: t.v, pat: sub });
        } else if (t.t === 'ident' || KEYWORDS.has(t.t)) {
          this.next();
          this.expect(':');
          entries.push({ key: { k: 'lit', v: t.v }, bind: null, pat: this.pattern() });
        } else if (t.t === 'str') {
          const key = this.string(null);
          this.expect(':');
          entries.push({ key, bind: null, pat: this.pattern() });
        } else if (t.t === '(') {
          this.next();
          const key = this.pipe();
          this.expect(')');
          this.expect(':');
          entries.push({ key, bind: null, pat: this.pattern() });
        } else this.unexpected();
      } while (this.accept(','));
      this.expect('}');
      return { k: 'pobj', entries };
    }
    this.unexpected();
    return null;
  }

  lineOf(pos) {
    let line = 1;
    for (let i = 0; i < pos; i += 1) if (this.src.charCodeAt(i) === 10) line += 1;
    return line;
  }

  /** A string literal starting at the current `"`, with \( … ) interpolation. */
  string(fmt) {
    const tok = this.peek();
    if (tok.t !== 'str') this.unexpected();
    const at = tok.start;
    const s = this.src;
    let p = tok.start + 1;
    const parts = [];
    let buf = '';
    for (;;) {
      if (p >= s.length) {
        this.pos = p;
        this.cache = null;
        throw new JqCompileError('syntax error, unexpected end of file, expecting QQSTRING_TEXT or QQSTRING_INTERP_START or QQSTRING_END (Unix shell quoting issues?)', p);
      }
      const c = s[p];
      if (c === '"') { p += 1; break; }
      if (c === '\\') {
        const e = s[p + 1];
        if (e === '(') {
          if (buf) { parts.push(buf); buf = ''; }
          this.pos = p + 2;
          this.cache = null;
          parts.push(this.pipe());
          const close = this.expect(')');
          p = close.end;
          continue;
        }
        p += 2;
        if (e === 'n') buf += '\n';
        else if (e === 't') buf += '\t';
        else if (e === 'r') buf += '\r';
        else if (e === 'b') buf += '\b';
        else if (e === 'f') buf += '\f';
        else if (e === '"' || e === '\\' || e === '/') buf += e;
        else if (e === 'u') {
          const h = s.slice(p, p + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new JqCompileError('invalid \\u escape', p);
          let code = parseInt(h, 16);
          p += 4;
          if (code >= 0xd800 && code < 0xdc00 && s[p] === '\\' && s[p + 1] === 'u') {
            const lo = parseInt(s.slice(p + 2, p + 6), 16);
            if (lo >= 0xdc00 && lo < 0xe000) {
              code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
              p += 6;
            }
          }
          buf += String.fromCodePoint(code);
        } else throw new JqCompileError(`invalid escape at line ${this.lineOf(p)}`, p);
        continue;
      }
      buf += c;
      p += 1;
    }
    this.pos = p;
    this.cache = null;
    if (buf || parts.length === 0) parts.push(buf);
    if (parts.length === 1 && typeof parts[0] === 'string' && !fmt) return this.node('lit', { v: parts[0] }, at);
    return this.node('str', { parts, fmt }, at);
  }
}

/* ================================================================== *
 * formats (@base64 etc.)
 * ================================================================== */

const FORMATS = new Set(['text', 'json', 'html', 'uri', 'csv', 'tsv', 'sh', 'base64', 'base64d', 'base32', 'base32d']);

const utf8enc = new TextEncoder();
const utf8dec = new TextDecoder();

function tostring(v) {
  return typeof v === 'string' ? v : compact(v);
}

function b64encode(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63];
    out += i + 1 < bytes.length ? A[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? A[n & 63] : '=';
  }
  return out;
}

function b64decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = s.replace(/[\s=]/g, '');
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = A.indexOf(ch);
    if (v < 0) throw new JqError(`${quoteString(s)} is not valid base64 data`);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  if (clean.length % 4 === 1) throw new JqError(`${trunc(s)} trailing base64 byte found`);
  return utf8dec.decode(new Uint8Array(out));
}

function b32encode(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += A[(buf >> bits) & 31];
    }
  }
  if (bits > 0) out += A[(buf << (5 - bits)) & 31];
  while (out.length % 8) out += '=';
  return out;
}

function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s.replace(/=+$/, '')) {
    const v = A.indexOf(ch.toUpperCase());
    if (v < 0) continue;
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return utf8dec.decode(new Uint8Array(out));
}

function applyFormat(fmt, v) {
  switch (fmt) {
    case 'text': return tostring(v);
    case 'json': return compact(v);
    case 'html':
      return tostring(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[c]));
    case 'uri': {
      let out = '';
      for (const b of utf8enc.encode(tostring(v))) {
        const ch = String.fromCharCode(b);
        out += /[A-Za-z0-9\-_.~]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
      }
      return out;
    }
    case 'csv':
    case 'tsv': {
      if (!Array.isArray(v)) throw new JqError(`${typeName(v)} (${trunc(v)}) cannot be ${fmt}-formatted, only an array can be`);
      return v.map((x) => {
        const t = typeName(x);
        if (t === 'number') return formatNumber(x);
        if (t === 'boolean') return x ? 'true' : 'false';
        if (t === 'null') return '';
        if (t === 'string') {
          if (fmt === 'csv') return `"${x.replace(/"/g, '""')}"`;
          return x.replace(/[\\\t\n\r]/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' }[c]));
        }
        throw new JqError(`${t} (${trunc(x)}) is not valid in a csv row`);
      }).join(fmt === 'csv' ? ',' : '\t');
    }
    case 'sh': {
      const one = (x) => {
        const t = typeName(x);
        if (t === 'string') return `'${x.replace(/'/g, "'\\''")}'`;
        if (t === 'array' || t === 'object') throw new JqError(`${t} (${trunc(x)}) can not be escaped for shell`);
        return compact(x);
      };
      return Array.isArray(v) ? v.map(one).join(' ') : one(v);
    }
    case 'base64': return b64encode(utf8enc.encode(tostring(v)));
    case 'base64d': return b64decode(tostring(v));
    case 'base32': return b32encode(utf8enc.encode(tostring(v)));
    case 'base32d': return b32decode(tostring(v));
    default: throw new JqError(`${fmt} is not a valid format`);
  }
}

/* ================================================================== *
 * paths: get / set / delete
 * ================================================================== */

function toIndex(n, len) {
  let i = Math.floor(n);
  if (i < 0) i += len;
  return i;
}

function sliceBounds(len, from, to) {
  const conv = (x, dflt) => {
    if (x === null) return dflt;
    if (typeof x !== 'number') throw new JqError('Start and end indices of an array slice must be numbers');
    let i = Math.floor(x);
    if (i < 0) i += len;
    return Math.max(0, Math.min(len, i));
  };
  const a = conv(from, 0);
  const b = Math.max(a, conv(to, len));
  return [a, b];
}

function cps(s) { return Array.from(s); }

function sliceValue(v, from, to) {
  if (v === null) return null;
  if (typeof v === 'string') {
    const chars = cps(v);
    const [a, b] = sliceBounds(chars.length, from, to);
    return chars.slice(a, b).join('');
  }
  if (Array.isArray(v)) {
    const [a, b] = sliceBounds(v.length, from, to);
    return v.slice(a, b);
  }
  throw new JqError(`Cannot index ${typeName(v)} with object`);
}

const isSliceKey = (k) => isObj(k) && k.has('start') && k.has('end');

/** `.[k]` */
function indexValue(v, k) {
  if (isSliceKey(k)) return sliceValue(v, k.get('start'), k.get('end'));
  if (v === null) {
    if (typeof k === 'string' || typeof k === 'number' || k === null) return null;
  } else if (isObj(v)) {
    if (typeof k === 'string') return v.has(k) ? v.get(k) : null;
  } else if (Array.isArray(v)) {
    if (typeof k === 'number') {
      if (Number.isNaN(k)) return null;
      const i = toIndex(k, v.length);
      return i >= 0 && i < v.length ? v[i] : null;
    }
    if (Array.isArray(k)) return indicesOf(v, k);
  }
  if (typeof k === 'string') throw new JqError(`Cannot index ${typeName(v)} with ${quoteString(k)}`);
  throw new JqError(`Cannot index ${typeName(v)} with ${typeName(k)}`);
}

function indicesOf(arr, sub) {
  const out = [];
  if (sub.length === 0) return null;
  for (let i = 0; i + sub.length <= arr.length; i += 1) {
    let hit = true;
    for (let j = 0; j < sub.length; j += 1) if (!equal(arr[i + j], sub[j])) { hit = false; break; }
    if (hit) out.push(i);
  }
  return out;
}

function getpath(v, path) {
  let cur = v;
  for (const k of path) {
    if (cur === null) return null;
    cur = indexValue(cur, k);
  }
  return cur;
}

function setpath(v, path, x, at = 0) {
  if (at === path.length) return x;
  const k = path[at];
  if (isSliceKey(k)) {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot update field at object index of ${typeName(v)}`);
    const arr = v || [];
    const [a, b] = sliceBounds(arr.length, k.get('start'), k.get('end'));
    const repl = setpath(arr.slice(a, b), path, x, at + 1);
    if (!Array.isArray(repl)) throw new JqError('A slice of an array can only be assigned another array');
    return arr.slice(0, a).concat(repl, arr.slice(b));
  }
  if (typeof k === 'string') {
    if (v !== null && !isObj(v)) throw new JqError(`Cannot index ${typeName(v)} with ${quoteString(k)}`);
    const m = new Map(v || []);
    m.set(k, setpath(m.has(k) ? m.get(k) : null, path, x, at + 1));
    return m;
  }
  if (typeof k === 'number') {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot index ${typeName(v)} with number`);
    const arr = (v || []).slice();
    let i = Math.floor(k);
    if (i < 0) {
      i += arr.length;
      if (i < 0) throw new JqError('Out of bounds negative array index');
    }
    while (arr.length < i) arr.push(null);
    arr[i] = setpath(i < arr.length ? arr[i] : null, path, x, at + 1);
    return arr;
  }
  throw new JqError(`Invalid path component ${trunc(k)}`);
}

function delpath(v, path, at = 0) {
  if (v === null) return null;
  const k = path[at];
  const last = at === path.length - 1;
  if (isSliceKey(k)) {
    if (!Array.isArray(v)) throw new JqError(`Cannot delete field at object index of ${typeName(v)}`);
    const [a, b] = sliceBounds(v.length, k.get('start'), k.get('end'));
    if (last) return v.slice(0, a).concat(v.slice(b));
    const repl = delpath(v.slice(a, b), path, at + 1);
    return v.slice(0, a).concat(repl, v.slice(b));
  }
  if (typeof k === 'string') {
    if (!isObj(v)) throw new JqError(`Cannot delete field at object index of ${typeName(v)}`);
    if (!v.has(k)) return v;
    const m = new Map(v);
    if (last) m.delete(k);
    else m.set(k, delpath(m.get(k), path, at + 1));
    return m;
  }
  if (typeof k === 'number') {
    if (!Array.isArray(v)) throw new JqError(`Cannot delete field at index of ${typeName(v)}`);
    const i = toIndex(k, v.length);
    if (i < 0 || i >= v.length) return v;
    const arr = v.slice();
    if (last) arr.splice(i, 1);
    else arr[i] = delpath(arr[i], path, at + 1);
    return arr;
  }
  throw new JqError(`Invalid path component ${trunc(k)}`);
}

function delpaths(v, paths) {
  const sorted = paths.slice().sort(compare).reverse();
  let out = v;
  for (const p of sorted) {
    if (!Array.isArray(p)) throw new JqError('Path must be specified as an array');
    if (p.length === 0) return null;
    out = delpath(out, p);
  }
  return out;
}

/* ================================================================== *
 * arithmetic
 * ================================================================== */

function deepMerge(a, b) {
  const m = new Map(a);
  for (const [k, v] of b) {
    m.set(k, isObj(v) && isObj(m.get(k)) ? deepMerge(m.get(k), v) : v);
  }
  return m;
}

function binop(op, a, b) {
  switch (op) {
    case '+':
      if (a === null) return b;
      if (b === null) return a;
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
      if (isObj(a) && isObj(b)) { const m = new Map(a); for (const [k, v] of b) m.set(k, v); return m; }
      throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot be added`);
    case '-':
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      if (Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.some((y) => equal(x, y)));
      throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot be subtracted`);
    case '*':
      if (typeof a === 'number' && typeof b === 'number') return a * b;
      if ((typeof a === 'string' && typeof b === 'number') || (typeof a === 'number' && typeof b === 'string')) {
        const s = typeof a === 'string' ? a : b;
        const n = typeof a === 'number' ? a : b;
        // jq 1.7 repeats the string int(n) times, so "x" * 0 is "".
        return n > 0 ? s.repeat(Math.min(Math.trunc(n), 2 ** 28 / Math.max(1, s.length))) : '';
      }
      if (isObj(a) && isObj(b)) return deepMerge(a, b);
      throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot be multiplied`);
    case '/':
      if (typeof a === 'number' && typeof b === 'number') {
        if (b === 0) throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot be divided because the divisor is zero`);
        return a / b;
      }
      if (typeof a === 'string' && typeof b === 'string') return splitString(a, b);
      throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot be divided`);
    case '%': {
      if (typeof a === 'number' && typeof b === 'number') {
        const bi = Math.trunc(b);
        if (bi === 0 || Number.isNaN(b)) throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot be divided because the divisor is zero`);
        const r = Math.trunc(a) % Math.abs(bi);
        return Object.is(r, -0) ? 0 : r;
      }
      throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot be divided`);
    }
    case '==': return equal(a, b);
    case '!=': return !equal(a, b);
    case '<': return compare(a, b) < 0;
    case '<=': return compare(a, b) <= 0;
    case '>': return compare(a, b) > 0;
    case '>=': return compare(a, b) >= 0;
    default: throw new JqError(`unknown operator ${op}`);
  }
}

function splitString(s, sep) {
  if (s === '') return [];
  if (sep === '') return cps(s);
  return s.split(sep);
}

/* ================================================================== *
 * the evaluator
 * ================================================================== */

/*
 * Environments are linked frames:
 *   {v: name, value, up}              a $variable
 *   {f: 'name/arity', def, up}        a def (def.env is the frame the body runs in)
 *   {c: 'name/0', node, env, up}      a closure parameter
 *   {l: name, id, up}                 a label
 * Builtins live in PRELUDE_DEFS / NATIVES and are found when the chain ends.
 */

const NATIVES = new Map();
const PRELUDE_DEFS = new Map();

class Runtime {
  constructor(io) {
    this.io = io;
    this.steps = 0;
    this.deadline = io.deadline || Infinity;
  }

  tick() {
    this.steps += 1;
    if ((this.steps & 0x3fff) === 0 && Date.now() > this.deadline) throw new JqTimeout('time limit');
  }

  /** Values only. */
  *vals(node, v, env) {
    for (const [x] of this.ev(node, v, null, env)) yield x;
  }

  /** Cartesian product of argument values, first argument outermost. */
  *cart(args, v, i = 0, acc = []) {
    if (i === args.length) { yield acc.slice(); return; }
    for (const x of this.vals(args[i].node, v, args[i].env)) {
      acc.push(x);
      yield* this.cart(args, v, i + 1, acc);
      acc.pop();
    }
  }

  *ev(node, v, p, env) {
    this.tick();
    switch (node.k) {
      case 'id':
        yield [v, p];
        return;

      case 'lit':
        yield [node.v, null];
        return;

      case 'var': {
        let e = env;
        for (; e; e = e.up) if (e.v === node.name) break;
        if (e) yield [e.value, null];
        else if (this.io.named && this.io.named.has(node.name)) yield [this.io.named.get(node.name), null];
        else if (node.name === 'ENV') yield [this.io.env, null];
        else if (node.name === '__prog_args') yield [[], null];
        else throw new JqError(`$${node.name} is not defined`);
        return;
      }

      case 'loc':
        yield [new Map([['file', '<stdin>'], ['line', node.line]]), null];
        return;

      case 'format':
        yield [applyFormat(node.fmt, v), null];
        return;

      case 'str':
        yield* this.strParts(node, v, env, node.parts.length - 1);
        return;

      case 'pipe':
        for (const [lv, lp] of this.ev(node.l, v, p, env)) yield* this.ev(node.r, lv, lp, env);
        return;

      case 'comma':
        yield* this.ev(node.l, v, p, env);
        yield* this.ev(node.r, v, p, env);
        return;

      case 'neg':
        for (const x of this.vals(node.e, v, env)) {
          if (typeof x !== 'number') throw new JqError(`${typeName(x)} (${trunc(x)}) cannot be negated`);
          yield [-x, null];
        }
        return;

      case 'bin':
        for (const r of this.vals(node.r, v, env)) {
          for (const l of this.vals(node.l, v, env)) yield [binop(node.op, l, r), null];
        }
        return;

      case 'and':
      case 'or':
        for (const l of this.vals(node.l, v, env)) {
          if (node.k === 'and' && !truthy(l)) { yield [false, null]; continue; }
          if (node.k === 'or' && truthy(l)) { yield [true, null]; continue; }
          for (const r of this.vals(node.r, v, env)) yield [truthy(r), null];
        }
        return;

      case 'alt': {
        let any = false;
        try {
          for (const out of this.ev(node.l, v, p, env)) {
            if (truthy(out[0])) {
              any = true;
              yield out;
            }
          }
        } catch (err) {
          if (!(err instanceof JqError)) throw err;
        }
        if (!any) yield* this.ev(node.r, v, p, env);
        return;
      }

      case 'if':
        for (const c of this.vals(node.cond, v, env)) {
          if (truthy(c)) yield* this.ev(node.then, v, p, env);
          else if (node.other) yield* this.ev(node.other, v, p, env);
          else yield [v, p];
        }
        return;

      case 'try': {
        try {
          for (const out of this.ev(node.body, v, p, env)) yield out;
        } catch (err) {
          if (!(err instanceof JqError)) throw err;
          if (node.handler) yield* this.ev(node.handler, err.value, null, env);
        }
        return;
      }

      case 'index':
        for (const k of this.vals(node.key, v, env)) {
          for (const [tv, tp] of this.ev(node.t, v, p, env)) {
            yield [indexValue(tv, k), tp && tp.concat([k])];
          }
        }
        return;

      case 'slice': {
        const froms = node.from ? Array.from(this.vals(node.from, v, env)) : [null];
        const tos = node.to ? Array.from(this.vals(node.to, v, env)) : [null];
        for (const to of tos) {
          for (const from of froms) {
            for (const [tv, tp] of this.ev(node.t, v, p, env)) {
              const key = new Map([['start', from], ['end', to]]);
              yield [sliceValue(tv, from, to), tp && tp.concat([key])];
            }
          }
        }
        return;
      }

      case 'iter':
        for (const [tv, tp] of this.ev(node.t, v, p, env)) {
          if (Array.isArray(tv)) {
            for (let i = 0; i < tv.length; i += 1) yield [tv[i], tp && tp.concat([i])];
          } else if (isObj(tv)) {
            for (const [k, x] of tv) yield [x, tp && tp.concat([k])];
          } else {
            throw new JqError(`Cannot iterate over ${typeName(tv)}${tv === null ? '' : ` (${trunc(tv)})`}`);
          }
        }
        return;

      case 'array':
        yield [node.body ? Array.from(this.vals(node.body, v, env)) : [], null];
        return;

      case 'object':
        yield* this.objectEntries(node.entries, 0, new Map(), v, env);
        return;

      case 'as':
        yield* this.bindAlternatives(node.patterns, node.src, v, env, (env2) => this.ev(node.body, v, p, env2));
        return;

      case 'reduce':
        for (const init of this.ev(node.init, v, p, env)) {
          let state = init;
          for (const x of this.vals(node.src, v, env)) {
            for (const env2 of this.bindPattern(node.patterns[0], x, env, v, allPatternVars(node.patterns))) {
              let last = null;
              for (const out of this.ev(node.update, state[0], state[1], env2)) last = out;
              state = last || [null, null];
            }
          }
          yield state;
        }
        return;

      case 'foreach':
        for (const init of this.ev(node.init, v, p, env)) {
          let state = init;
          for (const x of this.vals(node.src, v, env)) {
            for (const env2 of this.bindPattern(node.patterns[0], x, env, v, allPatternVars(node.patterns))) {
              for (const out of this.ev(node.update, state[0], state[1], env2)) {
                state = out;
                if (node.extract) yield* this.ev(node.extract, out[0], out[1], env2);
                else yield out;
              }
            }
          }
        }
        return;

      case 'def': {
        const frame = { f: `${node.name}/${node.params.length}`, def: null, up: env };
        frame.def = { params: node.params, body: node.body, env: frame, name: node.name };
        yield* this.ev(node.rest, v, p, frame);
        return;
      }

      case 'label': {
        const id = {};
        try {
          yield* this.ev(node.body, v, p, { l: node.name, id, up: env });
        } catch (err) {
          if (err instanceof JqBreak && err.id === id) return;
          throw err;
        }
        return;
      }

      case 'break': {
        for (let e = env; e; e = e.up) if (e.l === node.name) throw new JqBreak(e.id);
        throw new JqError(`$*label-${node.name} is not defined`);
      }

      case 'call':
        yield* this.call(node, v, p, env);
        return;

      case 'assign':
        yield* this.assign(node, v, env);
        return;

      default:
        throw new JqError(`internal: unknown node ${node.k}`);
    }
  }

  /** String interpolation: the last part is the outermost loop, as in jq. */
  *strParts(node, v, env, i) {
    if (i < 0) { yield ['', null]; return; }
    const part = node.parts[i];
    if (typeof part === 'string') {
      for (const [pre] of this.strParts(node, v, env, i - 1)) yield [pre + part, null];
      return;
    }
    for (const x of this.vals(part, v, env)) {
      const text = node.fmt ? applyFormat(node.fmt, x) : tostring(x);
      for (const [pre] of this.strParts(node, v, env, i - 1)) yield [pre + text, null];
    }
  }

  *objectEntries(entries, i, acc, v, env) {
    if (i === entries.length) { yield [new Map(acc), null]; return; }
    const { key, value } = entries[i];
    for (const k of this.vals(key, v, env)) {
      if (typeof k !== 'string') {
        throw new JqError(`Object keys must be strings`);
      }
      for (const x of this.vals(value, v, env)) {
        const had = acc.has(k);
        const old = acc.get(k);
        acc.set(k, x);
        yield* this.objectEntries(entries, i + 1, acc, v, env);
        if (had) acc.set(k, old); else acc.delete(k);
      }
    }
  }

  /* --- destructuring ------------------------------------------------ */

  *bindAlternatives(patterns, srcNode, v, env, body) {
    const names = allPatternVars(patterns);
    for (const x of this.vals(srcNode, v, env)) {
      for (let i = 0; i < patterns.length; i += 1) {
        try {
          for (const env2 of this.bindPattern(patterns[i], x, env, v, names)) yield* body(env2);
          break;
        } catch (err) {
          if (!(err instanceof JqError) || i === patterns.length - 1) throw err;
        }
      }
    }
  }

  /** Bind one pattern; with alternatives every variable starts as null. */
  *bindPattern(pat, x, env, dot, names) {
    let base = env;
    if (names && names.length > 1) for (const n of names) base = { v: n, value: null, up: base };
    yield* this.destructure(pat, x, base, dot);
  }

  *destructure(pat, x, env, dot) {
    if (pat.k === 'pvar') { yield { v: pat.name, value: x, up: env }; return; }
    if (pat.k === 'parr') {
      if (x !== null && !Array.isArray(x)) throw new JqError(`Cannot index ${typeName(x)} with number`);
      yield* this.destructureList(pat.items.map((sub, i) => [sub, indexValue(x, i)]), 0, env, dot);
      return;
    }
    // object pattern
    yield* this.destructureObj(pat.entries, 0, x, env, dot);
  }

  *destructureList(pairs, i, env, dot) {
    if (i === pairs.length) { yield env; return; }
    for (const env2 of this.destructure(pairs[i][0], pairs[i][1], env, dot)) yield* this.destructureList(pairs, i + 1, env2, dot);
  }

  *destructureObj(entries, i, x, env, dot) {
    if (i === entries.length) { yield env; return; }
    const e = entries[i];
    const keys = e.key.k === 'lit' ? [e.key.v] : Array.from(this.vals(e.key, dot, env));
    for (const k of keys) {
      if (typeof k !== 'string') throw new JqError(`Cannot index ${typeName(x)} with ${typeName(k)}`);
      if (x !== null && !isObj(x)) throw new JqError(`Cannot index ${typeName(x)} with ${quoteString(k)}`);
      const val = indexValue(x, k);
      let env2 = env;
      if (e.bind) env2 = { v: e.bind, value: val, up: env2 };
      if (e.pat) {
        for (const env3 of this.destructure(e.pat, val, env2, dot)) yield* this.destructureObj(entries, i + 1, x, env3, dot);
      } else {
        yield* this.destructureObj(entries, i + 1, x, env2, dot);
      }
    }
  }

  /* --- calls -------------------------------------------------------- */

  *call(node, v, p, env) {
    const key = `${node.name}/${node.args.length}`;
    for (let e = env; e; e = e.up) {
      if (e.f === key) { yield* this.callDef(e.def, node.args, v, p, env); return; }
      if (e.c === key) { yield* this.ev(e.node, v, p, e.env); return; }
    }
    const def = PRELUDE_DEFS.get(key);
    if (def) { yield* this.callDef(def, node.args, v, p, env); return; }
    const native = NATIVES.get(key);
    if (native) {
      const args = node.args.map((a) => ({ node: a, env }));
      yield* native.call(this, v, p, args, env);
      return;
    }
    throw new JqError(`${key} is not defined`);
  }

  *callDef(def, argNodes, v, p, callerEnv) {
    let env = def.env;
    const valueParams = [];
    def.params.forEach((prm, i) => {
      env = { c: `${prm.name}/0`, node: argNodes[i], env: callerEnv, up: env };
      if (prm.isVar) valueParams.push([prm.name, argNodes[i]]);
    });
    if (!valueParams.length) { yield* this.ev(def.body, v, p, env); return; }
    const self = this;
    function* bind(i, e) {
      if (i === valueParams.length) { yield* self.ev(def.body, v, p, e); return; }
      for (const x of self.vals(valueParams[i][1], v, callerEnv)) yield* bind(i + 1, { v: valueParams[i][0], value: x, up: e });
    }
    yield* bind(0, env);
  }

  /** Every path `node` produces from `v`, or an error for a non-path result. */
  paths(node, v, env) {
    const out = [];
    for (const [x, xp] of this.ev(node, v, [], env)) {
      if (xp === null) throw new JqError(`Invalid path expression with result ${trunc(x)}`);
      out.push(xp);
    }
    return out;
  }

  *assign(node, v, env) {
    if (node.op === '|=') {
      // jq 1.7's _modify: the first output replaces the value; paths whose
      // update produced nothing are deleted together at the end, so
      // `.[] |= empty` empties an array instead of skipping every other item.
      let out = v;
      const doomed = [];
      for (const path of this.paths(node.l, v, env)) {
        let first;
        let got = false;
        for (const x of this.vals(node.r, getpath(out, path), env)) { first = x; got = true; break; }
        if (got) out = setpath(out, path, first);
        else doomed.push(path);
      }
      if (doomed.length) out = delpaths(out, doomed);
      yield [out, null];
      return;
    }
    for (const rhs of this.vals(node.r, v, env)) {
      let out = v;
      for (const path of this.paths(node.l, v, env)) {
        if (node.op === '=') out = setpath(out, path, rhs);
        else if (node.op === '//=') {
          const cur = getpath(out, path);
          out = setpath(out, path, truthy(cur) ? cur : rhs);
        } else out = setpath(out, path, binop(node.op[0], getpath(out, path), rhs));
      }
      yield [out, null];
    }
  }
}

function allPatternVars(patterns) {
  if (patterns.length < 2) return null;
  const names = new Set();
  const walk = (pat) => {
    if (!pat) return;
    if (pat.k === 'pvar') names.add(pat.name);
    else if (pat.k === 'parr') pat.items.forEach(walk);
    else if (pat.k === 'pobj') pat.entries.forEach((e) => { if (e.bind) names.add(e.bind); walk(e.pat); });
  };
  patterns.forEach(walk);
  return Array.from(names);
}

/* ================================================================== *
 * native builtins
 * ================================================================== */

/** A value function: args are `$`-style (cartesian), result is one value. */
function defv(name, arity, fn) {
  NATIVES.set(`${name}/${arity}`, function* native(v, p, args) {
    if (arity === 0) { yield [fn.call(this, v), null]; return; }
    for (const vals of this.cart(args, v)) yield [fn.call(this, v, ...vals), null];
  });
}

/** A generator builtin with full control over paths and closures. */
function defg(name, arity, fn) {
  NATIVES.set(`${name}/${arity}`, fn);
}

const requireString = (v, what) => {
  if (typeof v !== 'string') throw new JqError(`${typeName(v)} (${trunc(v)}) ${what}`);
  return v;
};

/** A string-only builtin with jq's fixed wording, e.g. "trim input must be a string". */
const needStr = (v, message) => {
  if (typeof v !== 'string') throw new JqError(message);
  return v;
};

defg('empty', 0, function* empty() { /* nothing */ });
defg('not', 0, function* not(v) { yield [!truthy(v), null]; });
defg('error', 0, function* error(v) { throw new JqError(v); });
defg('error', 1, function* error(v, p, [a]) { for (const m of this.vals(a.node, v, a.env)) throw new JqError(m); });
defg('path', 1, function* path(v, p, [a]) {
  for (const xp of this.paths(a.node, v, a.env)) yield [xp, null];
});
defg('getpath', 1, function* gp(v, p, [a]) {
  for (const path of this.vals(a.node, v, a.env)) {
    if (!Array.isArray(path)) throw new JqError('Path must be specified as an array');
    yield [getpath(v, path), p && p.concat(path)];
  }
});
defv('setpath', 2, (v, path, x) => {
  if (!Array.isArray(path)) throw new JqError('Path must be specified as an array');
  return setpath(v, path, x);
});
defv('delpaths', 1, (v, paths) => {
  if (!Array.isArray(paths)) throw new JqError('Paths must be specified as an array');
  return delpaths(v, paths);
});
defg('limit', 2, function* limit(v, p, [n, f]) {
  for (const count of this.vals(n.node, v, n.env)) {
    if (!(count > 0)) continue;
    let i = 0;
    for (const out of this.ev(f.node, v, p, f.env)) {
      yield out;
      i += 1;
      if (i >= count) break;
    }
  }
});
defg('first', 1, function* first(v, p, [f]) {
  for (const out of this.ev(f.node, v, p, f.env)) { yield out; return; }
});
defg('last', 1, function* last(v, p, [f]) {
  let got = null;
  for (const out of this.ev(f.node, v, p, f.env)) got = out;
  if (got) yield got;
});
defg('nth', 2, function* nth(v, p, [n, f]) {
  for (const k of this.vals(n.node, v, n.env)) {
    if (k < 0) throw new JqError('Out of bounds negative array index');
    let i = 0;
    for (const out of this.ev(f.node, v, p, f.env)) {
      if (i === k) { yield out; break; }
      i += 1;
    }
  }
});
defg('isempty', 1, function* isempty(v, p, [g]) {
  for (const _ of this.ev(g.node, v, null, g.env)) { yield [false, null]; return; }
  yield [true, null];
});
defg('range', 1, function* range(v, p, [a]) {
  for (const n of this.vals(a.node, v, a.env)) for (let i = 0; i < n; i += 1) { this.tick(); yield [i, null]; }
});
defg('range', 2, function* range(v, p, args) {
  for (const [from, upto] of this.cart(args, v)) for (let i = from; i < upto; i += 1) { this.tick(); yield [i, null]; }
});
defg('range', 3, function* range(v, p, args) {
  for (const [from, upto, by] of this.cart(args, v)) {
    if (by > 0) for (let i = from; i < upto; i += by) { this.tick(); yield [i, null]; }
    else if (by < 0) for (let i = from; i > upto; i += by) { this.tick(); yield [i, null]; }
    else if (from < upto) for (;;) { this.tick(); yield [from, null]; }
  }
});
defg('until', 2, function* until(v, p, [cond, update]) {
  let state = [v, p];
  for (;;) {
    this.tick();
    const cs = Array.from(this.vals(cond.node, state[0], cond.env));
    if (cs.length !== 1) {
      // multiple condition outputs: fall back to the recursive definition
      for (const c of cs) {
        if (truthy(c)) yield state;
        else for (const u of this.ev(update.node, state[0], state[1], update.env)) yield* NATIVES.get('until/2').call(this, u[0], u[1], [cond, update]);
      }
      return;
    }
    if (truthy(cs[0])) { yield state; return; }
    const us = Array.from(this.ev(update.node, state[0], state[1], update.env));
    if (us.length !== 1) {
      for (const u of us) yield* NATIVES.get('until/2').call(this, u[0], u[1], [cond, update]);
      return;
    }
    state = us[0];
  }
});
defg('while', 2, function* whileFn(v, p, [cond, update]) {
  let state = [v, p];
  for (;;) {
    this.tick();
    const cs = Array.from(this.vals(cond.node, state[0], cond.env));
    if (cs.length !== 1) {
      for (const c of cs) {
        if (!truthy(c)) continue;
        yield state;
        for (const u of this.ev(update.node, state[0], state[1], update.env)) yield* NATIVES.get('while/2').call(this, u[0], u[1], [cond, update]);
      }
      return;
    }
    if (!truthy(cs[0])) return;
    yield state;
    const us = Array.from(this.ev(update.node, state[0], state[1], update.env));
    if (us.length !== 1) {
      for (const u of us) yield* NATIVES.get('while/2').call(this, u[0], u[1], [cond, update]);
      return;
    }
    state = us[0];
  }
});
defg('repeat', 1, function* repeat(v, p, [f]) {
  let state = [v, p];
  for (;;) {
    this.tick();
    yield state;
    const us = Array.from(this.ev(f.node, state[0], state[1], f.env));
    if (us.length !== 1) {
      for (const u of us) yield* NATIVES.get('repeat/1').call(this, u[0], u[1], [f]);
      return;
    }
    state = us[0];
  }
});

defv('length', 0, (v) => {
  switch (typeName(v)) {
    case 'null': return 0;
    case 'boolean': throw new JqError(`boolean (${v}) has no length`);
    case 'number': return Math.abs(v);
    case 'string': return cps(v).length;
    case 'array': return v.length;
    default: return v.size;
  }
});
defv('utf8bytelength', 0, (v) => utf8enc.encode(requireString(v, 'only strings have UTF-8 byte length')).length);
defv('type', 0, (v) => typeName(v));
defv('keys', 0, (v) => {
  if (isObj(v)) return sortedKeys(v);
  if (Array.isArray(v)) return v.map((_, i) => i);
  throw new JqError(`${typeName(v)} (${trunc(v)}) has no keys`);
});
defv('keys_unsorted', 0, (v) => {
  if (isObj(v)) return Array.from(v.keys());
  if (Array.isArray(v)) return v.map((_, i) => i);
  throw new JqError(`${typeName(v)} (${trunc(v)}) has no keys`);
});
defv('has', 1, (v, k) => {
  if (isObj(v)) {
    if (typeof k !== 'string') throw new JqError(`Cannot check whether object has a key of type ${typeName(k)}`);
    return v.has(k);
  }
  if (Array.isArray(v)) {
    if (typeof k !== 'number') throw new JqError(`Cannot check whether array has a key of type ${typeName(k)}`);
    return k >= 0 && k < v.length;
  }
  throw new JqError(`Cannot check whether ${typeName(v)} has a ${typeName(k)} key`);
});

/** jv_contains: nested values of different kinds simply do not contain each other. */
function containsInner(a, b) {
  if (typeName(a) !== typeName(b)) return false;
  if (isObj(a)) {
    for (const [k, bv] of b) if (!a.has(k) || !containsInner(a.get(k), bv)) return false;
    return true;
  }
  if (Array.isArray(a)) return b.every((bv) => a.some((av) => containsInner(av, bv)));
  if (typeof a === 'string') return a.includes(b);
  return equal(a, b);
}
function contains(a, b) {
  if (typeName(a) !== typeName(b)) {
    throw new JqError(`${typeName(a)} (${trunc(a)}) and ${typeName(b)} (${trunc(b)}) cannot have their containment checked`);
  }
  return containsInner(a, b);
}
defv('contains', 1, contains);
defv('add', 0, (v) => {
  let acc = null;
  const items = isObj(v) ? Array.from(v.values()) : Array.isArray(v) ? v : null;
  if (!items) throw new JqError(`Cannot iterate over ${typeName(v)}${v === null ? '' : ` (${trunc(v)})`}`);
  for (const x of items) acc = binop('+', acc, x);
  return acc;
});
defv('floor', 0, (v) => Math.floor(num(v, 'floor')));
defv('ceil', 0, (v) => Math.ceil(num(v, 'ceil')));
defv('round', 0, (v) => { const x = num(v, 'round'); return x < 0 ? -Math.round(-x) : Math.round(x); });
defv('sqrt', 0, (v) => Math.sqrt(num(v, 'sqrt')));
defv('fabs', 0, (v) => Math.abs(num(v, 'fabs')));
defv('abs', 0, (v) => {
  if (typeof v !== 'number') throw new JqError(`${typeName(v)} (${trunc(v)}) has no absolute value`);
  return v < 0 ? -v : v;
});
for (const [name, fn] of Object.entries({
  log: Math.log, log2: Math.log2, log10: Math.log10, exp: Math.exp, exp2: (x) => 2 ** x, exp10: (x) => 10 ** x,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, cbrt: Math.cbrt, trunc: Math.trunc, significand: (x) => {
    if (x === 0) return 0;
    const e = Math.floor(Math.log2(Math.abs(x)));
    return x / 2 ** e;
  },
  log1p: Math.log1p, expm1: Math.expm1, rint: (x) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2) ? r - 1 : r; },
  nearbyint: (x) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2) ? r - 1 : r; },
})) defv(name, 0, (v) => fn(num(v, name)));
defv('pow', 2, (v, a, b) => num(a, 'pow') ** num(b, 'pow'));
defv('atan2', 2, (v, a, b) => Math.atan2(num(a, 'atan2'), num(b, 'atan2')));
defv('fmin', 2, (v, a, b) => Math.min(a, b));
defv('fmax', 2, (v, a, b) => Math.max(a, b));
defv('fmod', 2, (v, a, b) => a % b);
defv('ldexp', 2, (v, a, b) => a * 2 ** b);
function num(v, name) {
  if (typeof v !== 'number') throw new JqError(`${typeName(v)} (${trunc(v)}) number required`);
  return v;
}
defv('infinite', 0, () => Infinity);
defv('nan', 0, () => NaN);
defv('isinfinite', 0, (v) => { num(v); return v === Infinity || v === -Infinity; });
defv('isnan', 0, (v) => { num(v); return Number.isNaN(v); });
defv('isnormal', 0, (v) => { num(v); return Number.isFinite(v) && v !== 0 && Math.abs(v) >= 2.2250738585072014e-308; });
defv('now', 0, () => Date.now() / 1000);
defv('tostring', 0, (v) => tostring(v));
defv('tonumber', 0, (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
    if (t === 'nan' || t === 'NaN') return NaN;
    throw new JqError(`Cannot parse '${v}' as JSON`);
  }
  throw new JqError(`${typeName(v)} (${trunc(v)}) cannot be parsed as a number`);
});
defv('tojson', 0, (v) => compact(v));
defv('fromjson', 0, (v) => {
  requireString(v, 'only strings can be parsed');
  try {
    return parseJson(v);
  } catch (err) {
    throw new JqError(`${err.message} (while parsing '${v}')`);
  }
});
defv('ascii_downcase', 0, (v) => needStr(v, 'ascii_downcase input must be a string').replace(/[A-Z]/g, (c) => c.toLowerCase()));
defv('ascii_upcase', 0, (v) => needStr(v, 'ascii_upcase input must be a string').replace(/[a-z]/g, (c) => c.toUpperCase()));
defv('explode', 0, (v) => cps(needStr(v, 'explode input must be a string')).map((c) => c.codePointAt(0)));
defv('implode', 0, (v) => {
  if (!Array.isArray(v)) throw new JqError('Cannot implode: input must be an array');
  return v.map((c) => {
    if (typeof c !== 'number') throw new JqError('Unicode codepoint must be numeric');
    const cp = Math.trunc(c);
    if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000)) return '�';
    return String.fromCodePoint(cp);
  }).join('');
});
defv('ltrimstr', 1, (v, x) => (typeof v === 'string' && typeof x === 'string' && v.startsWith(x) ? v.slice(x.length) : v));
defv('rtrimstr', 1, (v, x) => (typeof v === 'string' && typeof x === 'string' && v.endsWith(x) && x.length ? v.slice(0, v.length - x.length) : v));
defv('startswith', 1, (v, x) => {
  if (typeof v !== 'string' || typeof x !== 'string') throw new JqError('startswith() requires string inputs');
  return v.startsWith(x);
});
defv('endswith', 1, (v, x) => {
  if (typeof v !== 'string' || typeof x !== 'string') throw new JqError('endswith() requires string inputs');
  return v.endsWith(x);
});
defv('split', 1, (v, sep) => {
  if (typeof v !== 'string' || typeof sep !== 'string') throw new JqError('split input and separator must be strings');
  return splitString(v, sep);
});
defv('indices', 1, (v, x) => {
  if (v === null) return null;
  if (typeof v === 'string' && typeof x === 'string') {
    if (x === '') return null;
    const out = [];
    const chars = cps(v);
    const needle = cps(x);
    for (let i = 0; i + needle.length <= chars.length; i += 1) {
      let hit = true;
      for (let j = 0; j < needle.length; j += 1) if (chars[i + j] !== needle[j]) { hit = false; break; }
      if (hit) out.push(i);
    }
    return out;
  }
  if (Array.isArray(v)) return indicesOf(v, Array.isArray(x) ? x : [x]);
  throw new JqError(`Cannot determine indices of ${trunc(x)} in ${typeName(v)}`);
});
NATIVES.set('index/1', function* index(v, p, args) {
  for (const [r] of NATIVES.get('indices/1').call(this, v, p, args)) yield [r === null ? null : (r.length ? r[0] : null), null];
});
NATIVES.set('rindex/1', function* rindex(v, p, args) {
  for (const [r] of NATIVES.get('indices/1').call(this, v, p, args)) yield [r === null ? null : (r.length ? r[r.length - 1] : null), null];
});
defv('reverse', 0, (v) => {
  if (v === null) return [];
  if (typeof v === 'string') return cps(v).reverse().join('');
  if (Array.isArray(v)) return v.slice().reverse();
  throw new JqError(`Cannot reverse ${typeName(v)}`);
});
const needArray = (v, what) => {
  if (!Array.isArray(v)) throw new JqError(`${typeName(v)} (${trunc(v)}) cannot be ${what}, as it is not an array`);
  return v;
};
defv('sort', 0, (v) => needArray(v, 'sorted').slice().sort(compare));
defv('unique', 0, (v) => {
  const s = needArray(v, 'sorted').slice().sort(compare);
  return s.filter((x, i) => i === 0 || !equal(x, s[i - 1]));
});
defv('min', 0, (v) => { const a = needArray(v, 'sorted'); let m = null; a.forEach((x, i) => { if (i === 0 || compare(x, m) < 0) m = x; }); return m; });
defv('max', 0, (v) => { const a = needArray(v, 'sorted'); let m = null; a.forEach((x, i) => { if (i === 0 || compare(x, m) >= 0) m = x; }); return m; });

/** Keys for the *_by builtins: `[f]` per element, as jq does. */
function byKeys(rt, v, f, what) {
  const a = needArray(v, what);
  return a.map((x) => ({ x, k: Array.from(rt.vals(f.node, x, f.env)) }));
}
defg('sort_by', 1, function* sortBy(v, p, [f]) {
  const items = byKeys(this, v, f, 'sorted');
  items.sort((a, b) => compare(a.k, b.k));
  yield [items.map((it) => it.x), null];
});
defg('group_by', 1, function* groupBy(v, p, [f]) {
  const items = byKeys(this, v, f, 'grouped');
  items.sort((a, b) => compare(a.k, b.k));
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    if (i === 0 || !equal(items[i].k, items[i - 1].k)) out.push([]);
    out[out.length - 1].push(items[i].x);
  }
  yield [out, null];
});
defg('unique_by', 1, function* uniqueBy(v, p, [f]) {
  const items = byKeys(this, v, f, 'grouped');
  items.sort((a, b) => compare(a.k, b.k));
  yield [items.filter((it, i) => i === 0 || !equal(it.k, items[i - 1].k)).map((it) => it.x), null];
});
defg('min_by', 1, function* minBy(v, p, [f]) {
  const items = byKeys(this, v, f, 'iterated over');
  let best = null;
  for (const it of items) if (best === null || compare(it.k, best.k) < 0) best = it;
  yield [best ? best.x : null, null];
});
defg('max_by', 1, function* maxBy(v, p, [f]) {
  const items = byKeys(this, v, f, 'iterated over');
  let best = null;
  for (const it of items) if (best === null || compare(it.k, best.k) >= 0) best = it;
  yield [best ? best.x : null, null];
});
function flatten(a, depth) {
  const out = [];
  for (const x of a) {
    if (Array.isArray(x) && depth > 0) out.push(...flatten(x, depth - 1));
    else out.push(x);
  }
  return out;
}
defv('flatten', 0, (v) => flatten(needArray(v, 'flattened'), 1e9));
defv('flatten', 1, (v, d) => {
  if (d < 0) throw new JqError('flatten depth must not be negative');
  return flatten(needArray(v, 'flattened'), d);
});
defv('input_filename', 0, function inputFilename() { return this.io.filename || null; });
defv('builtins', 0, () => Array.from(new Set([...NATIVES.keys(), ...PRELUDE_DEFS.keys()])));
defv('input_line_number', 0, () => 0);
defv('have_literal_numbers', 0, () => true);
defv('have_decnum', 0, () => false);
defg('input', 0, function* input() {
  const next = this.io.input();
  if (next === undefined) throw new JqError('No more inputs');
  yield [next, null];
});
defg('inputs', 0, function* inputs() {
  for (;;) {
    const next = this.io.input();
    if (next === undefined) return;
    yield [next, null];
  }
});
defg('debug', 0, function* debug(v, p) {
  this.io.stderr(`["DEBUG:",${compact(v)}]\n`);
  yield [v, p];
});
defg('stderr', 0, function* stderr(v, p) {
  this.io.stderr(compact(v));
  yield [v, p];
});
defg('halt', 0, function* halt() { throw new JqHalt(0, null, false); });
defg('halt_error', 1, function* haltError(v, p, [a]) {
  for (const code of this.vals(a.node, v, a.env)) {
    if (typeof code !== 'number') throw new JqError('halt_error/1: number required');
    throw new JqHalt(code, v, true);
  }
});
defg('env', 0, function* envFn() { yield [this.io.env, null]; });

/* --- regex ---------------------------------------------------------- */

function groupNames(src) {
  const names = [];
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '[') {
      // skip a character class
      i += 1;
      if (src[i] === '^') i += 1;
      if (src[i] === ']') i += 1;
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (c !== '(') continue;
    if (src[i + 1] !== '?') { names.push(null); continue; }
    const m = /^\(\?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(src.slice(i)) || /^\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(src.slice(i));
    if (m) names.push(m[1]);
  }
  return names;
}

function compileRegex(re, flags) {
  if (typeof re !== 'string') throw new JqError(`${typeName(re)} (${trunc(re)}) cannot be matched, as it is not a string`);
  if (flags !== null && typeof flags !== 'string') throw new JqError(`${trunc(flags)} is not a string`);
  let global = false;
  let skipEmpty = false;
  let js = 'd';
  let src = re.replace(/\(\?P</g, '(?<');
  for (const f of flags || '') {
    if (f === 'g') global = true;
    else if (f === 'i') js += 'i';
    else if (f === 'x') src = src.replace(/\\#/g, '\u0000').replace(/#.*$/gm, '').replace(/\s+/g, '').replace(/\u0000/g, '\\#');
    else if (f === 's' || f === 'p') { if (!js.includes('s')) js += 's'; }
    else if (f === 'n') skipEmpty = true;
    else if (f === 'l') { /* longest match: not applicable */ }
    else throw new JqError(`${flags} is not a valid modifier string`);
  }
  let rx;
  try {
    rx = new RegExp(src, `${js}gu`);
  } catch {
    try {
      rx = new RegExp(src, `${js}g`);
    } catch (err) {
      throw new JqError(`${re} (at offset 0) is not a valid regex: ${err.message}`);
    }
  }
  return { rx, global, skipEmpty, names: groupNames(src) };
}

/** Code-point offset of a UTF-16 index. */
function cpOffset(s, idx) {
  let n = 0;
  for (let i = 0; i < idx; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) i += 1;
    n += 1;
  }
  return n;
}

function allMatches(s, cr) {
  const out = [];
  cr.rx.lastIndex = 0;
  for (;;) {
    const m = cr.rx.exec(s);
    if (!m) break;
    if (m[0] === '') {
      cr.rx.lastIndex = m.index + (s.codePointAt(m.index) > 0xffff ? 2 : 1);
      if (cr.skipEmpty) { if (m.index >= s.length) break; continue; }
    }
    out.push(m);
    if (!cr.global) break;
    if (m.index >= s.length) break;
  }
  return out;
}

function matchObject(s, m, names) {
  const caps = [];
  for (let i = 1; i < m.length; i += 1) {
    const name = names[i - 1] === undefined ? null : names[i - 1];
    if (m[i] === undefined) {
      caps.push(new Map([['offset', -1], ['length', 0], ['string', null], ['name', name]]));
    } else {
      const [a] = m.indices[i];
      caps.push(new Map([['offset', cpOffset(s, a)], ['length', cps(m[i]).length], ['string', m[i]], ['name', name]]));
    }
  }
  return new Map([['offset', cpOffset(s, m.index)], ['length', cps(m[0]).length], ['string', m[0]], ['captures', caps]]);
}

function regexArgs(re, flags) {
  if (Array.isArray(re)) return [re[0], re.length > 1 ? re[1] : null];
  return [re, flags];
}

defg('match', 2, function* match(v, p, args) {
  for (const [re0, fl0] of this.cart(args, v)) {
    const [re, flags] = regexArgs(re0, fl0);
    requireString(v, 'cannot be matched, as it is not a string');
    const cr = compileRegex(re, flags);
    for (const m of allMatches(v, cr)) yield [matchObject(v, m, cr.names), null];
  }
});
defg('test', 2, function* test(v, p, args) {
  for (const [re0, fl0] of this.cart(args, v)) {
    const [re, flags] = regexArgs(re0, fl0);
    requireString(v, 'cannot be matched, as it is not a string');
    const cr = compileRegex(re, flags);
    cr.rx.lastIndex = 0;
    yield [cr.rx.test(v), null];
  }
});
function captureObject(mo) {
  const out = new Map();
  for (const c of mo.get('captures')) if (c.get('name') !== null) out.set(c.get('name'), c.get('string'));
  return out;
}
defg('capture', 2, function* capture(v, p, args) {
  for (const [mo] of NATIVES.get('match/2').call(this, v, p, args)) yield [captureObject(mo), null];
});
defg('scan', 2, function* scan(v, p, args) {
  for (const [re0, fl0] of this.cart(args, v)) {
    const [re, flags] = regexArgs(re0, fl0);
    requireString(v, 'cannot be matched, as it is not a string');
    const cr = compileRegex(re, `g${flags || ''}`);
    for (const m of allMatches(v, cr)) {
      yield [m.length > 1 ? m.slice(1).map((x) => (x === undefined ? null : x)) : m[0], null];
    }
  }
});
defg('split', 2, function* split(v, p, args) {
  for (const [re, flags] of this.cart(args, v)) {
    requireString(v, 'cannot be matched, as it is not a string');
    const cr = compileRegex(re, `g${flags || ''}`);
    const out = [];
    let last = 0;
    for (const m of allMatches(v, cr)) {
      out.push(v.slice(last, m.index));
      last = m.index + m[0].length;
    }
    out.push(v.slice(last));
    yield [out, null];
  }
});
defg('sub', 3, function* sub(v, p, [reA, replA, flA]) {
  requireString(v, 'cannot be matched, as it is not a string');
  for (const re of this.vals(reA.node, v, reA.env)) {
    for (const flags of this.vals(flA.node, v, flA.env)) {
      const cr = compileRegex(re, flags);
      const matches = allMatches(v, cr);
      const self = this;
      // Every combination of replacement outputs, first match outermost.
      function* build(i, acc, pos) {
        if (i === matches.length) { yield [acc + v.slice(pos), null]; return; }
        const m = matches[i];
        const capObj = captureObject(matchObject(v, m, cr.names));
        for (const r of self.vals(replA.node, capObj, replA.env)) {
          if (typeof r !== 'string') throw new JqError(`${typeName(r)} (${trunc(r)}) cannot be added to a string`);
          yield* build(i + 1, acc + v.slice(pos, m.index) + r, m.index + m[0].length);
        }
      }
      yield* build(0, '', 0);
    }
  }
});

/* --- dates ---------------------------------------------------------- */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function brokenDown(sec, local) {
  const d = new Date(sec * 1000);
  const g = local
    ? [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds() + (sec % 1), d.getDay()]
    : [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds() + (sec % 1), d.getUTCDay()];
  const start = Date.UTC(g[0], 0, 1);
  const yday = Math.floor((Date.UTC(g[0], g[1], g[2]) - start) / 86400000);
  return [...g, yday];
}

function toBroken(v, fn) {
  if (typeof v === 'number') return brokenDown(v, false);
  if (Array.isArray(v) && v.length >= 6 && v.slice(0, 6).every((x) => typeof x === 'number')) return v;
  throw new JqError(`${fn} requires parsed datetime inputs`);
}

defv('gmtime', 0, (v) => brokenDown(num(v, 'gmtime'), false));
defv('localtime', 0, (v) => brokenDown(num(v, 'localtime'), true));
defv('mktime', 0, (v) => {
  if (!Array.isArray(v) || v.length < 6 || !v.slice(0, 6).every((x) => typeof x === 'number')) throw new JqError('mktime requires array of 6 numbers');
  return Math.floor(Date.UTC(v[0], v[1], v[2], v[3], v[4], Math.floor(v[5])) / 1000);
});

function strftime(bd, fmt, local) {
  const two = (n) => String(n).padStart(2, '0');
  const [Y, mo, d, H, M, S, wd, yd] = bd;
  const sec = Math.floor(S);
  const epoch = Math.floor(Date.UTC(Y, mo, d, H, M, sec) / 1000);
  const tz = local ? (new Date(epoch * 1000).toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop() || 'UTC') : 'UTC';
  const offMin = local ? -new Date(epoch * 1000).getTimezoneOffset() : 0;
  const z = `${offMin < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offMin) / 60))}${two(Math.abs(offMin) % 60)}`;
  return fmt.replace(/%([a-zA-Z%])/g, (all, c) => {
    switch (c) {
      case 'Y': return String(Y);
      case 'y': return two(Y % 100);
      case 'C': return two(Math.floor(Y / 100));
      case 'm': return two(mo + 1);
      case 'd': return two(d);
      case 'e': return String(d).padStart(2, ' ');
      case 'H': return two(H);
      case 'I': return two(H % 12 || 12);
      case 'M': return two(M);
      case 'S': return two(sec);
      case 'j': return String(yd + 1).padStart(3, '0');
      case 'a': return DAYS[wd].slice(0, 3);
      case 'A': return DAYS[wd];
      case 'b': case 'h': return MONTHS[mo].slice(0, 3);
      case 'B': return MONTHS[mo];
      case 'p': return H < 12 ? 'AM' : 'PM';
      case 'Z': return tz;
      case 'z': return z;
      case 's': return String(epoch);
      case 'u': return String(wd || 7);
      case 'w': return String(wd);
      case 'T': return `${two(H)}:${two(M)}:${two(sec)}`;
      case 'R': return `${two(H)}:${two(M)}`;
      case 'D': return `${two(mo + 1)}/${two(d)}/${two(Y % 100)}`;
      case 'F': return `${Y}-${two(mo + 1)}-${two(d)}`;
      case 'c': return `${DAYS[wd].slice(0, 3)} ${MONTHS[mo].slice(0, 3)} ${String(d).padStart(2, ' ')} ${two(H)}:${two(M)}:${two(sec)} ${Y}`;
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return all;
    }
  });
}

defv('strftime', 1, (v, fmt) => {
  if (typeof fmt !== 'string') throw new JqError('strftime/1 requires a string format');
  return strftime(toBroken(v, 'strftime/1'), fmt, false);
});
defv('strflocaltime', 1, (v, fmt) => {
  if (typeof fmt !== 'string') throw new JqError('strflocaltime/1 requires a string format');
  const bd = typeof v === 'number' ? brokenDown(v, true) : toBroken(v, 'strflocaltime/1');
  return strftime(bd, fmt, true);
});
defv('strptime', 1, (v, fmt) => {
  if (typeof v !== 'string') throw new JqError(`strptime/1 requires string inputs and arguments`);
  const fields = { Y: 1900, m: 1, d: 1, H: 0, M: 0, S: 0, off: 0 };
  let re = '^';
  const order = [];
  for (let i = 0; i < fmt.length; i += 1) {
    const c = fmt[i];
    if (c === '%' && i + 1 < fmt.length) {
      const f = fmt[i + 1];
      i += 1;
      const map = {
        Y: '(\\d{4})', m: '(\\d{1,2})', d: '(\\d{1,2})', e: '\\s*(\\d{1,2})', H: '(\\d{1,2})', M: '(\\d{1,2})', S: '(\\d{1,2})',
        y: '(\\d{2})', j: '(\\d{1,3})', Z: '([A-Za-z]+)', z: '([+-]\\d{2}:?\\d{2}|Z)', a: '([A-Za-z]+)', A: '([A-Za-z]+)',
        b: '([A-Za-z]+)', B: '([A-Za-z]+)', h: '([A-Za-z]+)', s: '(\\d+)', p: '(AM|PM|am|pm)',
      };
      if (f === 'T') { re += '(\\d{1,2}):(\\d{1,2}):(\\d{1,2})'; order.push('H', 'M', 'S'); continue; }
      if (f === 'F') { re += '(\\d{4})-(\\d{1,2})-(\\d{1,2})'; order.push('Y', 'm', 'd'); continue; }
      if (f === 'D') { re += '(\\d{1,2})/(\\d{1,2})/(\\d{2})'; order.push('m', 'd', 'y'); continue; }
      if (f === '%') { re += '%'; continue; }
      if (f === 'n' || f === 't') { re += '\\s+'; continue; }
      if (!map[f]) throw new JqError(`date "${v}" does not match format "${fmt}"`);
      re += map[f];
      order.push(f);
      continue;
    }
    if (/\s/.test(c)) { re += '\\s*'; continue; }
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const m = new RegExp(`${re}$`).exec(v);
  if (!m) throw new JqError(`date "${v}" does not match format "${fmt}"`);
  let pm = null;
  let epoch = null;
  order.forEach((f, i) => {
    const s = m[i + 1];
    if (f === 'Y') fields.Y = Number(s);
    else if (f === 'y') fields.Y = 1900 + Number(s) + (Number(s) < 69 ? 100 : 0);
    else if (f === 'm') fields.m = Number(s);
    else if (f === 'd' || f === 'e') fields.d = Number(s);
    else if (f === 'H') fields.H = Number(s);
    else if (f === 'M') fields.M = Number(s);
    else if (f === 'S') fields.S = Number(s);
    else if (f === 'b' || f === 'B' || f === 'h') {
      const idx = MONTHS.findIndex((x) => x.toLowerCase().startsWith(s.toLowerCase().slice(0, 3)));
      if (idx < 0) throw new JqError(`date "${v}" does not match format "${fmt}"`);
      fields.m = idx + 1;
    } else if (f === 'p') pm = s.toUpperCase() === 'PM';
    else if (f === 's') epoch = Number(s);
    else if (f === 'z' && s !== 'Z') {
      const mm = /([+-])(\d{2}):?(\d{2})/.exec(s);
      fields.off = (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3]));
    }
  });
  if (pm !== null) fields.H = (fields.H % 12) + (pm ? 12 : 0);
  if (epoch !== null) return brokenDown(epoch, false);
  const ms = Date.UTC(fields.Y, fields.m - 1, fields.d, fields.H, fields.M, fields.S) - fields.off * 60000;
  return brokenDown(ms / 1000, false);
});

/* ================================================================== *
 * the prelude (jq's builtin.jq, trimmed to what is not native)
 * ================================================================== */

const PRELUDE = `
def values: select(. != null);
def nulls: select(. == null);
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def strings: select(type == "string");
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type|. == "array" or . == "object");
def scalars: select(type|. != "array" and . != "object");
def select(f): if f then . else empty end;
def recurse(f): def r: ., (f | r); r;
def recurse(f; cond): def r: ., (f | select(cond) | r); r;
def recurse: recurse(.[]?);
def recurse_down: recurse;
def map(f): [.[] | f];
def map_values(f): .[] |= f;
def to_entries: [keys_unsorted[] as $k | {key: $k, value: .[$k]}];
def from_entries: reduce .[] as $x ({}; . + { ($x | if .key == null then .k // .name // .Name // .K // .Key else .key end | if type == "string" then . else tojson end): ($x | if has("value") then .value else .v end) });
def with_entries(f): to_entries | map(f) | from_entries;
def del(f): delpaths([path(f)]);
def paths: path(..) | select(length > 0);
def paths(node_filter): . as $dot | paths | select(. as $p | $dot | getpath($p) | node_filter);
def any: reduce .[] as $x (false; . or $x);
def all: reduce .[] as $x (true; . and $x);
def any(f): reduce (.[] | f) as $x (false; . or $x);
def all(f): reduce (.[] | f) as $x (true; . and $x);
def any(g; cond): isempty(first(g | cond or empty)) | not;
def all(g; cond): isempty(first(g | cond and empty));
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def combinations: if length == 0 then [] else .[0][] as $x | (.[1:] | combinations) as $w | [$x] + $w end;
def combinations(n): . as $dot | [range(n)] | map($dot) | combinations;
def walk(f): def w: if type == "object" then map_values(w) elif type == "array" then map(w) else . end | f; w;
def first: .[0];
def last: .[-1];
def nth($n): .[$n];
def todate: strftime("%Y-%m-%dT%H:%M:%SZ");
def fromdateiso8601: strptime("%Y-%m-%dT%H:%M:%SZ") | mktime;
def todateiso8601: strftime("%Y-%m-%dT%H:%M:%SZ");
def fromdate: fromdateiso8601;
def date: todate;
def dateadd(u; n): . + n;
def datesub(u; n): . - n;
def finites: select(isinfinite or isnan | not);
def normals: select(isnormal);
def transpose: [range(0; map(length) | max // 0) as $i | [.[][$i]]];
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);
def INDEX(stream; idx_expr): reduce stream as $row ({}; .[$row | idx_expr | tostring] |= $row);
def INDEX(idx_expr): INDEX(.[]; idx_expr);
def tostream: path(def r: (.[]? | r), .; r) as $p | getpath($p) | reduce path(.[]?) as $q ([$p, .]; [$p + $q]);
def fromstream(f): { x: null, e: false } as $init | foreach f as $i ($init; if .e then $init else . end | if $i | length == 2 then setpath(["e"]; $i[0] | length == 0) | setpath(["x"] + $i[0]; $i[1]) else setpath(["e"]; $i[0] | length == 1) end; if .e then .x else empty end);
def truncate_stream(stream): . as $n | null | stream | . as $input | if (.[0] | length) > $n then setpath([0]; .[0][$n:]) else empty end;
def pick(pathexps): . as $top | reduce path(pathexps) as $p (null; setpath($p; $top | getpath($p)));
def debug(msg): (msg | debug | empty), .;
def splits($re): splits($re; null);
def splits($re; flags): split($re; flags) | .[];
def capture(re): capture(re; null);
def scan(re): scan(re; null);
def test(re): test(re; null);
def match(re): match(re; null);
def sub(re; str): sub(re; str; "");
def gsub(re; str): sub(re; str; "g");
def gsub(re; str; flags): sub(re; str; flags + "g");
def join($x): reduce .[] as $i (null; (if . == null then "" else . + $x end) + ($i | if . == null then "" elif type == "string" then . else tojson end)) // "";
def halt_error: halt_error(5);
`;

(function loadPrelude() {
  const parser = new Parser(PRELUDE.trim());
  while (parser.is('def')) {
    const def = parser.funcDef();
    const key = `${def.name}/${def.params.length}`;
    PRELUDE_DEFS.set(key, { params: def.params, body: def.body, env: null, name: def.name });
  }
})();

/* ================================================================== *
 * compile-time checks (undefined functions and variables)
 * ================================================================== */

function check(node, scope, named) {
  if (!node) return;
  const fail = (msg) => { throw new JqCompileError(msg, node.pos); };
  switch (node.k) {
    case 'call': {
      const key = `${node.name}/${node.args.length}`;
      if (!scope.funcs.has(key) && !PRELUDE_DEFS.has(key) && !NATIVES.has(key)) fail(`${key} is not defined`);
      node.args.forEach((a) => check(a, scope, named));
      return;
    }
    case 'var':
      if (!scope.vars.has(node.name) && node.name !== 'ENV' && node.name !== '__prog_args' && !named.has(node.name)) fail(`$${node.name} is not defined`);
      return;
    case 'break':
      if (!scope.labels.has(node.name)) fail(`$*label-${node.name} is not defined`);
      return;
    case 'def': {
      const inner = { funcs: new Set(scope.funcs), vars: new Set(scope.vars), labels: scope.labels };
      inner.funcs.add(`${node.name}/${node.params.length}`);
      const body = { funcs: new Set(inner.funcs), vars: new Set(inner.vars), labels: scope.labels };
      for (const prm of node.params) {
        body.funcs.add(`${prm.name}/0`);
        if (prm.isVar) body.vars.add(prm.name);
      }
      check(node.body, body, named);
      check(node.rest, inner, named);
      return;
    }
    case 'as': {
      check(node.src, scope, named);
      const inner = { funcs: scope.funcs, vars: new Set(scope.vars), labels: scope.labels };
      node.patterns.forEach((pat) => patternVars(pat, inner.vars, scope, named));
      check(node.body, inner, named);
      return;
    }
    case 'reduce':
    case 'foreach': {
      check(node.src, scope, named);
      check(node.init, scope, named);
      const inner = { funcs: scope.funcs, vars: new Set(scope.vars), labels: scope.labels };
      node.patterns.forEach((pat) => patternVars(pat, inner.vars, scope, named));
      check(node.update, inner, named);
      if (node.extract) check(node.extract, inner, named);
      return;
    }
    case 'label': {
      const inner = { funcs: scope.funcs, vars: scope.vars, labels: new Set(scope.labels) };
      inner.labels.add(node.name);
      check(node.body, inner, named);
      return;
    }
    case 'str': node.parts.forEach((part) => { if (typeof part !== 'string') check(part, scope, named); }); return;
    case 'object': node.entries.forEach((e) => { check(e.key, scope, named); check(e.value, scope, named); }); return;
    default:
      for (const key of ['l', 'r', 'e', 't', 'key', 'from', 'to', 'body', 'handler', 'cond', 'then', 'other']) {
        if (node[key] && typeof node[key] === 'object' && node[key].k) check(node[key], scope, named);
      }
  }
}

function patternVars(pat, into, scope, named) {
  if (pat.k === 'pvar') into.add(pat.name);
  else if (pat.k === 'parr') pat.items.forEach((x) => patternVars(x, into, scope, named));
  else {
    for (const e of pat.entries) {
      if (e.key && e.key.k && e.key.k !== 'lit') check(e.key, scope, named);
      if (e.bind) into.add(e.bind);
      if (e.pat) patternVars(e.pat, into, scope, named);
    }
  }
}

/* ================================================================== *
 * public API
 * ================================================================== */

/**
 * @param {string} program
 * @param {Iterable<string>} [namedVars] names of --arg/--argjson variables
 * @returns {object} compiled filter
 */
export function compile(program, namedVars = []) {
  const parser = new Parser(program);
  const ast = parser.program();
  const named = new Set(namedVars);
  named.add('ARGS');
  named.add('__loc__');
  check(ast, { funcs: new Set(), vars: new Set(), labels: new Set() }, named);
  return { ast, source: parser.src };
}

/** Line of `pos` and its text, for compile error messages. */
export function locate(program, pos) {
  let line = 1;
  let start = 0;
  for (let i = 0; i < pos && i < program.length; i += 1) {
    if (program.charCodeAt(i) === 10) { line += 1; start = i + 1; }
  }
  const end = program.indexOf('\n', start);
  return { line, text: program.slice(start, end < 0 ? program.length : end) };
}

/**
 * Run a compiled filter on one input.
 * @param {object} filter from compile()
 * @param {*} input
 * @param {{env: Map, named: Map, input: () => *, stderr: (s: string) => void, filename?: string, deadline?: number}} io
 * @returns {Generator<*>}
 */
export function* run(filter, input, io) {
  const rt = new Runtime(io);
  for (const [v] of rt.ev(filter.ast, input, null, null)) yield v;
}

export const builtinNames = () => Array.from(new Set([...NATIVES.keys(), ...PRELUDE_DEFS.keys()]));
