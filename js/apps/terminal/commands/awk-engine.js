/**
 * awk-engine.js — a POSIX awk interpreter that behaves like mawk 1.3.4,
 * Ubuntu's /usr/bin/awk.
 *
 * Pure: the command layer (awk.js) passes an `io` object for files, stdin,
 * the environment and running shell commands.
 *
 * Values follow POSIX: numbers, strings, and "strnums" — strings from input
 * (fields, getline, split, ARGV, -v) that compare numerically when they look
 * like numbers. Uninitialized values are both "" and 0.
 *
 * The interpreter is a tree of generators. Almost everything runs
 * synchronously; the few operations that must wait for the shell
 * (`cmd | getline`, `system()`, `close()` of an output pipe) yield a Promise
 * that the driver awaits, and a periodic TICK lets the page breathe and
 * Ctrl+C stop a runaway loop.
 *
 * Strings are handled as characters, as gawk does in a UTF-8 locale; the
 * real mawk counts bytes, so length("é") is 2 there and 1 here.
 */

/* ================================================================== *
 * errors and signals
 * ================================================================== */

export class AwkSyntaxError extends Error {}
export class AwkRuntimeError extends Error {}
/** Printed without the "run time error" frame, e.g. "mawk: division by zero". */
export class AwkFatal extends Error {}

export const TICK = { tick: true };

/* ================================================================== *
 * values
 * ================================================================== */

/** A string from input that may compare as a number. */
export class StrNum {
  constructor(s) {
    this.s = s;
    this._n = undefined;
  }

  /** The numeric value when the whole string looks numeric, else NaN. */
  get n() {
    if (this._n === undefined) this._n = NUMERIC_RE.test(this.s) ? Number(this.s.trim()) : NaN;
    return this._n;
  }
}

const NUMERIC_RE = /^[ \t\n\r\f\v]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[ \t\n\r\f\v]*$/;

export class AwkArray extends Map {}

/** A caller's uninitialized variable passed to a function: becomes an array on first array use. */
class RefCell {
  constructor(create) { this.create = create; }
}

/** The longest decimal prefix: "3abc" → 3, " 12 " → 12, "0x1A" → 0 (no hex, as POSIX asks). */
export function strtod(s) {
  const m = /^[ \t\n\r\f\v]*([-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (v === undefined) return 0;
  if (v instanceof StrNum) { const n = v.n; return Number.isNaN(n) ? strtod(v.s) : n; }
  if (typeof v === 'string') return strtod(v);
  throw new AwkRuntimeError("can't use array in scalar context");
}

function truthy(v) {
  if (typeof v === 'number') return v !== 0;
  if (v === undefined) return false;
  if (v instanceof StrNum) { const n = v.n; return Number.isNaN(n) ? v.s !== '' : n !== 0; }
  return v !== '';
}

const isNumeric = (v) => typeof v === 'number' || v === undefined || (v instanceof StrNum && !Number.isNaN(v.n));

/* ================================================================== *
 * printf — exact decimal formatting, matching glibc's rounding
 * ================================================================== */

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

/** Exact decimal digits of |v| (finite, non-zero): value = 0.D × 10^P. */
function exactDigits(v) {
  F64[0] = Math.abs(v);
  const lo = U32[0];
  const hi = U32[1];
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) e = -1074;
  else { mant |= 1n << 52n; e = exp - 1075; }
  let digits;
  let point;
  if (e >= 0) {
    digits = (mant << BigInt(e)).toString();
    point = digits.length;
  } else {
    digits = (mant * 5n ** BigInt(-e)).toString();
    point = digits.length + e;
  }
  const trimmed = digits.replace(/0+$/, '');
  return { D: trimmed || '0', P: point };
}

/** Round digit string D to `keep` digits, half to even on exact ties. */
function roundDigits(D, P, keep) {
  if (keep < 0) return { D: '', P };
  if (keep >= D.length) return { D: D.padEnd(keep, '0'), P };
  const next = D.charCodeAt(keep) - 48;
  let up = false;
  if (next > 5) up = true;
  else if (next === 5) {
    const rest = D.slice(keep + 1);
    if (/[1-9]/.test(rest)) up = true;
    else up = keep > 0 ? (D.charCodeAt(keep - 1) - 48) % 2 === 1 : false;
  }
  let kept = D.slice(0, keep);
  if (!up) return { D: kept, P };
  // increment the kept digits
  const arr = kept.split('');
  let i = arr.length - 1;
  while (i >= 0) {
    if (arr[i] === '9') { arr[i] = '0'; i -= 1; } else { arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1); break; }
  }
  kept = arr.join('');
  if (i < 0) return { D: `1${kept}`, P: P + 1 };
  return { D: kept, P };
}

function fmtFixed(v, prec) {
  if (v === 0) return prec > 0 ? `0.${'0'.repeat(prec)}` : '0';
  const { D, P } = exactDigits(v);
  const keep = P + prec;
  if (keep < 0) return prec > 0 ? `0.${'0'.repeat(prec)}` : '0';
  const r = roundDigits(D, P, keep);
  let digits = r.D;
  let point = r.P;
  if (digits === '') { digits = '0'; point = 1; }
  // digits holds (point + prec) digits
  const total = point + prec;
  digits = digits.padEnd(total, '0');
  let intPart;
  let frac;
  if (point <= 0) {
    intPart = '0';
    frac = '0'.repeat(-point) + digits;
    frac = frac.slice(0, prec).padEnd(prec, '0');
  } else {
    intPart = digits.slice(0, point);
    frac = digits.slice(point, point + prec);
  }
  return prec > 0 ? `${intPart}.${frac}` : intPart;
}

function fmtExp(v, prec, upper) {
  let mant;
  let x;
  if (v === 0) {
    mant = prec > 0 ? `0.${'0'.repeat(prec)}` : '0';
    x = 0;
  } else {
    const { D, P } = exactDigits(v);
    const r = roundDigits(D, P, prec + 1);
    const d = r.D.padEnd(prec + 1, '0');
    mant = prec > 0 ? `${d[0]}.${d.slice(1)}` : d[0];
    x = r.P - 1;
  }
  const sign = x < 0 ? '-' : '+';
  const ex = String(Math.abs(x)).padStart(2, '0');
  return `${mant}${upper ? 'E' : 'e'}${sign}${ex}`;
}

/** %g: the shorter of %e and %f, trailing zeros removed unless `alt`. */
function fmtGeneral(v, prec, upper, alt) {
  const P = prec === 0 ? 1 : prec;
  let X;
  if (v === 0) X = 0;
  else {
    const { D, P: pp } = exactDigits(v);
    X = roundDigits(D, pp, P).P - 1;
  }
  let s;
  if (P > X && X >= -4) s = fmtFixed(v, P - 1 - X);
  else s = fmtExp(v, P - 1, upper);
  if (!alt) {
    if (s.includes('e') || s.includes('E')) {
      const [m, e] = s.split(/(?=[eE])/);
      s = (m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m) + e;
    } else if (s.includes('.')) {
      s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
  }
  return s;
}

function nonFinite(v, upper) {
  const s = Number.isNaN(v) ? 'nan' : (v < 0 ? '-inf' : 'inf');
  return upper ? s.toUpperCase() : s;
}

/**
 * C's printf for awk. `args` are awk values; `str` converts with CONVFMT.
 * @returns {string}
 */
export function formatPrintf(fmt, args, str, fnName = 'printf') {
  let out = '';
  let ai = 0;
  const next = () => {
    if (ai >= args.length) throw new AwkRuntimeError(`not enough arguments passed to ${fnName}("${fmt}")`);
    return args[ai++];
  };
  for (let i = 0; i < fmt.length; i += 1) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    if (fmt[i + 1] === '%') { out += '%'; i += 1; continue; }
    const specStart = i;
    let j = i + 1;
    let flags = '';
    while ('-+ #0'.includes(fmt[j]) && j < fmt.length) { flags += fmt[j]; j += 1; }
    let width = '';
    if (fmt[j] === '*') { width = String(Math.trunc(toNum(next()))); j += 1; }
    else while (/[0-9]/.test(fmt[j] || '')) { width += fmt[j]; j += 1; }
    let prec = null;
    if (fmt[j] === '.') {
      j += 1;
      let p = '';
      if (fmt[j] === '*') { p = String(Math.trunc(toNum(next()))); j += 1; }
      else while (/[0-9]/.test(fmt[j] || '')) { p += fmt[j]; j += 1; }
      prec = p === '' ? 0 : Number(p);
      if (prec < 0) prec = null;
    }
    while ('hlLqjzt'.includes(fmt[j]) && j < fmt.length) j += 1;   // length modifiers
    const conv = fmt[j];
    if (conv === undefined) { out += fmt.slice(i); break; }
    i = j;
    let w = Number(width || 0);
    let left = flags.includes('-');
    if (w < 0) { left = true; w = -w; }
    const zero = flags.includes('0') && !left;
    const plus = flags.includes('+');
    const space = flags.includes(' ');
    const alt = flags.includes('#');
    let body;
    let sign = '';
    let numeric = true;
    switch (conv) {
      case 'c': {
        const a = next();
        numeric = false;
        // a number (or a field that looks like one) is a character code
        if (typeof a === 'number' || (a instanceof StrNum && !Number.isNaN(a.n))) {
          const code = Math.trunc(toNum(a));
          body = code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        } else {
          const s = str(a);
          body = s === '' ? '' : Array.from(s)[0];
        }
        break;
      }
      case 's': {
        numeric = false;
        let s = str(next());
        if (prec !== null) s = Array.from(s).slice(0, prec).join('');
        body = s;
        break;
      }
      case 'd': case 'i': {
        const v = toNum(next());
        if (!Number.isFinite(v)) { body = nonFinite(v); if (body.startsWith('-')) { sign = '-'; body = body.slice(1); } numeric = false; break; }
        let n = BigInt(Math.trunc(v));
        if (n < 0n) { sign = '-'; n = -n; } else if (plus) sign = '+'; else if (space) sign = ' ';
        body = n.toString();
        if (prec !== null) body = prec === 0 && n === 0n ? '' : body.padStart(prec, '0');
        break;
      }
      case 'o': case 'x': case 'X': case 'u': {
        const v = toNum(next());
        let n = BigInt.asUintN(64, BigInt(Math.trunc(Number.isFinite(v) ? v : 0)));
        body = conv === 'o' ? n.toString(8) : conv === 'u' ? n.toString() : n.toString(16);
        if (conv === 'X') body = body.toUpperCase();
        if (prec !== null) body = prec === 0 && n === 0n ? '' : body.padStart(prec, '0');
        if (alt && conv === 'o' && !body.startsWith('0')) body = `0${body}`;
        if (alt && (conv === 'x' || conv === 'X') && n !== 0n) sign = conv === 'x' ? '0x' : '0X';
        n = 0n;
        break;
      }
      case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': {
        const v = toNum(next());
        const p = prec === null ? 6 : prec;
        if (v < 0 || Object.is(v, -0)) sign = '-'; else if (plus) sign = '+'; else if (space) sign = ' ';
        const a = Math.abs(v);
        if (!Number.isFinite(v)) { body = nonFinite(a, conv === 'E' || conv === 'F' || conv === 'G'); if (Number.isNaN(v)) sign = sign === '-' ? '-' : sign; numeric = false; break; }
        if (conv === 'f' || conv === 'F') body = fmtFixed(a, p);
        else if (conv === 'e' || conv === 'E') body = fmtExp(a, p, conv === 'E');
        else body = fmtGeneral(a, p, conv === 'G', alt);
        if (alt && p === 0 && (conv === 'f' || conv === 'F')) body += '.';
        break;
      }
      default:
        // unknown conversion: printed literally, as glibc does
        out += fmt.slice(specStart, j + 1);
        continue;
    }
    let field = sign + body;
    const len = Array.from(field).length;
    if (len < w) {
      if (left) field += ' '.repeat(w - len);
      else if (zero && numeric && !(prec !== null && 'diouxX'.includes(conv))) field = sign + '0'.repeat(w - len) + body;
      else field = ' '.repeat(w - len) + field;
    }
    out += field;
  }
  return out;
}

/* ================================================================== *
 * regular expressions: POSIX ERE → JavaScript
 * ================================================================== */

const POSIX_CLASS = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', print: ' -~',
  graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
};

/** Translate an awk ERE into a JavaScript RegExp source. */
export function ereToJs(re) {
  let out = '';
  for (let i = 0; i < re.length; i += 1) {
    const c = re[i];
    if (c === '\\') {
      const n = re[i + 1];
      if (n === undefined) { out += '\\\\'; continue; }
      i += 1;
      if (n === '/') out += '\\/';
      else if (n === '"') out += '"';
      else if (n === 'y') out += '\\b';
      else if (/[0-9]/.test(n)) {
        // octal escape
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(re[i + 1] || '')) { oct += re[i + 1]; i += 1; }
        out += `\\x${parseInt(oct, 8).toString(16).padStart(2, '0')}`;
      } else if ('.[]()*+?{}|^$\\'.includes(n)) out += `\\${n}`;
      else if ('nrtfv'.includes(n)) out += `\\${n}`;
      else if (n === 'a') out += '\\x07';
      else if (n === 'b') out += '\\x08';
      else if (/[A-Za-z]/.test(n)) out += n;     // \q → q, as mawk does
      else out += `\\${n}`;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (re[j] === '^') { cls += '^'; j += 1; }
      if (re[j] === ']') { cls += '\\]'; j += 1; }
      for (; j < re.length && re[j] !== ']'; j += 1) {
        const d = re[j];
        if (d === '[' && re[j + 1] === ':') {
          const end = re.indexOf(':]', j + 2);
          if (end > 0) {
            const name = re.slice(j + 2, end);
            if (!POSIX_CLASS[name]) throw new SyntaxError(`bad class -- [], [^] or [`);
            cls += POSIX_CLASS[name];
            j = end + 1;
            continue;
          }
        }
        if (d === '\\') {
          const n = re[j + 1];
          j += 1;
          if (n === undefined) break;
          cls += n === 'n' || n === 't' || n === 'r' || n === 'f' || n === 'v' ? `\\${n}` : `\\${n}`;
          continue;
        }
        if (d === '[') { cls += '\\['; continue; }
        cls += d;
      }
      if (j >= re.length) throw new SyntaxError('bad class -- [], [^] or [');
      out += `${cls}]`;
      i = j;
      continue;
    }
    if (c === '/') { out += '\\/'; continue; }
    if (c === '{') {
      // an interval only when it is one; otherwise a literal brace
      const m = /^\{(\d+)(,(\d*))?\}/.exec(re.slice(i));
      if (m && out !== '' && !/[(|]$/.test(out)) { out += m[0]; i += m[0].length - 1; }
      else out += '\\{';
      continue;
    }
    if (c === '}') { out += '\\}'; continue; }
    out += c;
  }
  return out;
}

/* ================================================================== *
 * lexer
 * ================================================================== */

const KEYWORDS = new Set(['BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue',
  'next', 'nextfile', 'exit', 'return', 'delete', 'getline', 'print', 'printf', 'in']);
const BUILTINS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos',
  'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush',
  'systime', 'mktime', 'strftime']);
const OPERATORS = ['**=', '^=', '+=', '-=', '*=', '/=', '%=', '==', '<=', '>=', '!=', '!~', '++', '--', '&&', '||',
  '>>', '**', '{', '}', '(', ')', '[', ']', ';', ',', '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':',
  '~', '$', '='];
/** After these a `/` divides; elsewhere it starts a regular expression. */
const OPERAND_END = new Set(['num', 'str', 'ere', 'name', 'funcname', 'builtin', ')', ']', '++', '--']);

function unescapeString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[i + 1];
    i += 1;
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case '/': out += '/'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case undefined: out += '\\'; break;
      default:
        if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(raw[i + 1] || '')) { oct += raw[i + 1]; i += 1; }
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          out += `\\${n}`;     // mawk keeps the backslash of an unknown escape
        }
    }
  }
  return out;
}

export { unescapeString };

function lex(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  const push = (t, v) => { toks.push({ t, v, line }); };
  const prevT = () => (toks.length ? toks[toks.length - 1].t : 'nl');
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line += 1; continue; }
    if (c === '\\' && src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; line += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '\n') { push('nl'); i += 1; line += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let raw = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          if (src[j + 1] === '\n') { j += 2; line += 1; continue; }
          raw += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '\n') throw new AwkSyntaxError(`line ${line}: runaway string constant "${raw.slice(0, 10)} ...`);
        raw += src[j];
        j += 1;
      }
      if (j >= src.length) throw new AwkSyntaxError(`line ${line}: runaway string constant "${raw.slice(0, 10)} ...`);
      push('str', unescapeString(raw));
      i = j + 1;
      continue;
    }
    if (c === '/' && !OPERAND_END.has(prevT())) {
      let j = i + 1;
      let raw = '';
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\n') throw new AwkSyntaxError(`line ${line}: runaway regular expression /${raw.slice(0, 10)} ...`);
        if (d === '\\' && j + 1 < src.length) { raw += d + src[j + 1]; j += 2; continue; }
        if (d === '[' && !inClass) { inClass = true; if (src[j + 1] === '^') { raw += '[^'; j += 2; } else { raw += d; j += 1; } if (src[j] === ']') { raw += ']'; j += 1; } continue; }
        if (d === ']' && inClass) inClass = false;
        if (d === '/' && !inClass) break;
        raw += d;
        j += 1;
      }
      if (j >= src.length) throw new AwkSyntaxError(`line ${line}: runaway regular expression /${raw.slice(0, 10)} ...`);
      push('ere', raw);
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)/.exec(src.slice(i));
      push('num', m[0].startsWith('0x') || m[0].startsWith('0X') ? parseInt(m[0], 16) : Number(m[0]));
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      if (KEYWORDS.has(word)) push('kw', word === 'func' ? 'function' : word);
      else if (BUILTINS.has(word)) push('builtin', word);
      else if (src[j] === '(') push('funcname', word);
      else push('name', word);
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      push(op === '**' ? '^' : op === '**=' ? '^=' : op);
      i += op.length;
      continue;
    }
    throw new AwkSyntaxError(`${line}: unexpected character '${c}'`);
  }
  push('eof');
  return toks;
}

/* ================================================================== *
 * parser
 * ================================================================== */

const CONCAT_START = new Set(['num', 'str', 'ere', 'name', 'funcname', 'builtin', '$', '(', '++', '--', '!', '-', '+']);

class Parser {
  constructor(src) {
    this.toks = lex(src);
    this.i = 0;
    this.funcs = new Map();
    this.params = null;        // Map name → index while inside a function body
    this.called = new Map();   // user functions called → first line
  }

  peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  is(t, v) { const k = this.peek(); return k.t === t && (v === undefined || k.v === v); }
  isKw(v) { return this.is('kw', v); }
  next() { return this.toks[this.i++]; }
  accept(t, v) { if (this.is(t, v)) { this.i += 1; return true; } return false; }

  fail(tok = this.peek()) {
    let near;
    if (tok.t === 'eof') {
      throw new AwkSyntaxError(`line ${tok.line}: syntax error at or near end of file`);
    }
    if (tok.t === 'nl') near = 'end of line';
    else if (tok.t === 'str') near = `"${tok.v}"`;
    else if (tok.t === 'ere') near = `/${tok.v}/`;
    else if (tok.v !== undefined) near = String(tok.v);
    else near = tok.t;
    throw new AwkSyntaxError(`line ${tok.line}: syntax error at or near ${near}`);
  }

  expect(t, v) {
    if (!this.is(t, v)) this.fail();
    return this.next();
  }

  optNl() { while (this.is('nl')) this.i += 1; }

  /* --- program ------------------------------------------------------ */

  program() {
    const prog = { begin: [], end: [], rules: [], funcs: this.funcs };
    for (;;) {
      while (this.is('nl') || this.is(';')) this.i += 1;
      if (this.is('eof')) break;
      if (this.isKw('BEGIN')) {
        this.next();
        this.optNl();
        prog.begin.push(this.block());
      } else if (this.isKw('END')) {
        this.next();
        this.optNl();
        prog.end.push(this.block());
      } else if (this.isKw('function')) {
        this.funcDef();
      } else {
        let pattern = null;
        let pattern2 = null;
        if (!this.is('{')) {
          pattern = this.expr({});
          if (this.accept(',')) {
            this.optNl();
            pattern2 = this.expr({});
          }
        }
        let action = null;
        if (this.is('{')) action = this.block();
        else if (!(this.is('nl') || this.is(';') || this.is('eof'))) this.fail();
        prog.rules.push({ pattern, pattern2, action, inRange: false });
      }
    }
    for (const [name, line] of this.called) {
      if (!this.funcs.has(name)) throw new AwkSyntaxError(`line ${line}: function ${name} never defined`);
    }
    return prog;
  }

  funcDef() {
    this.next();
    const nameTok = this.next();
    if (nameTok.t !== 'name' && nameTok.t !== 'funcname') this.fail(nameTok);
    if (this.funcs.has(nameTok.v)) throw new AwkSyntaxError(`line ${nameTok.line}: function ${nameTok.v} redefined`);
    this.expect('(');
    const params = [];
    this.optNl();
    if (!this.is(')')) {
      for (;;) {
        const p = this.expect('name');
        params.push(p.v);
        this.optNl();
        if (!this.accept(',')) break;
        this.optNl();
      }
    }
    this.expect(')');
    this.optNl();
    const fn = { name: nameTok.v, params, body: null };
    this.funcs.set(nameTok.v, fn);
    this.params = new Map(params.map((p, idx) => [p, idx]));
    fn.body = this.block();
    this.params = null;
  }

  block() {
    this.expect('{');
    const body = this.stmtList();
    this.expect('}');
    return { k: 'block', body };
  }

  stmtList() {
    const body = [];
    for (;;) {
      while (this.is('nl') || this.is(';')) this.i += 1;
      if (this.is('}') || this.is('eof')) return body;
      body.push(this.stmt());
    }
  }

  /** A simple statement must end with a newline, `;`, or before `}`. */
  endSimple() {
    if (this.is('nl') || this.is(';')) { this.i += 1; return; }
    if (this.is('}') || this.is('eof')) return;
    this.fail();
  }

  stmt() {
    const tok = this.peek();
    if (tok.t === '{') return this.block();
    if (tok.t === ';') { this.next(); return { k: 'nop' }; }
    if (tok.t === 'kw') {
      switch (tok.v) {
        case 'if': {
          this.next();
          this.expect('(');
          const c = this.expr({});
          this.expect(')');
          this.optNl();
          const t = this.simpleOrBlock();
          const save = this.i;
          while (this.is('nl') || this.is(';')) this.i += 1;
          if (this.isKw('else')) {
            this.next();
            this.optNl();
            return { k: 'if', c, t, f: this.simpleOrBlock() };
          }
          this.i = save;
          return { k: 'if', c, t, f: null };
        }
        case 'while': {
          this.next();
          this.expect('(');
          const c = this.expr({});
          this.expect(')');
          if (this.is(';')) { this.next(); return { k: 'while', c, body: { k: 'nop' } }; }
          this.optNl();
          return { k: 'while', c, body: this.simpleOrBlock() };
        }
        case 'do': {
          this.next();
          this.optNl();
          const body = this.simpleOrBlock();
          while (this.is('nl') || this.is(';')) this.i += 1;
          if (!this.isKw('while')) this.fail();
          this.next();
          this.expect('(');
          const c = this.expr({});
          this.expect(')');
          this.endSimple();
          return { k: 'do', body, c };
        }
        case 'for': return this.forStmt();
        case 'next': this.next(); this.endSimple(); return { k: 'next' };
        case 'nextfile': this.next(); this.endSimple(); return { k: 'nextfile' };
        case 'break': this.next(); this.endSimple(); return { k: 'break' };
        case 'continue': this.next(); this.endSimple(); return { k: 'continue' };
        case 'exit': {
          this.next();
          const e = this.atEnd() ? null : this.expr({});
          this.endSimple();
          return { k: 'exit', e };
        }
        case 'return': {
          this.next();
          if (this.params === null) throw new AwkSyntaxError(`line ${tok.line}: return outside function body`);
          const e = this.atEnd() ? null : this.expr({});
          this.endSimple();
          return { k: 'return', e };
        }
        case 'delete': {
          this.next();
          const nameTok = this.expect('name');
          const arr = this.arrayRef(nameTok.v);
          let subs = null;
          if (this.accept('[')) {
            subs = this.exprList({});
            this.expect(']');
          }
          this.endSimple();
          return { k: 'delete', arr, subs };
        }
        case 'print':
        case 'printf': {
          const s = this.printStmt();
          this.endSimple();
          return s;
        }
        default:
          break;
      }
    }
    const e = this.expr({});
    this.endSimple();
    return { k: 'expr', e };
  }

  /** The body of if/while/for: a block, or one simple statement. */
  simpleOrBlock() {
    if (this.is(';')) { this.next(); return { k: 'nop' }; }
    return this.stmt();
  }

  atEnd() {
    return this.is('nl') || this.is(';') || this.is('}') || this.is('eof');
  }

  forStmt() {
    this.next();
    this.expect('(');
    // for (k in arr)
    if ((this.is('name') && this.peek(1).t === 'kw' && this.peek(1).v === 'in' && this.peek(2).t === 'name' && this.peek(3).t === ')')
      || (this.is('(') && this.peek(1).t === 'name' && this.peek(2).t === ')' && this.peek(3).t === 'kw' && this.peek(3).v === 'in')) {
      const paren = this.accept('(');
      const v = this.next();
      if (paren) this.expect(')');
      this.next(); // in
      const arrTok = this.next();
      this.expect(')');
      this.optNl();
      return { k: 'forin', v: this.varRef(v.v), arr: this.arrayRef(arrTok.v), body: this.simpleOrBlock() };
    }
    const init = this.is(';') ? null : this.expr({});
    this.expect(';');
    this.optNl();
    const c = this.is(';') ? null : this.expr({});
    this.expect(';');
    this.optNl();
    const step = this.is(')') ? null : this.expr({});
    this.expect(')');
    if (this.is(';')) { this.next(); return { k: 'for', init, c, step, body: { k: 'nop' } }; }
    this.optNl();
    return { k: 'for', init, c, step, body: this.simpleOrBlock() };
  }

  printStmt() {
    const kind = this.next().v;
    let args = [];
    if (!(this.atEnd() || this.is('>') || this.is('>>') || this.is('|'))) {
      args = this.exprList({ noGt: true, inPrint: true });
      if (args.length === 1 && args[0].k === 'grouplist') args = args[0].list;
    }
    for (const a of args) if (a.k === 'grouplist') this.fail();
    let redir = null;
    if (this.is('>') || this.is('>>') || this.is('|')) {
      const type = this.next().t;
      redir = { type, e: this.concat({ noGt: true, inPrint: true }) };
    }
    if (kind === 'printf' && args.length === 0) this.fail();
    return { k: kind, args, redir };
  }

  exprList(f) {
    const list = [this.expr(f)];
    while (this.accept(',')) {
      this.optNl();
      list.push(this.expr(f));
    }
    return list;
  }

  /* --- names -------------------------------------------------------- */

  varRef(name) {
    if (this.params && this.params.has(name)) return { k: 'local', idx: this.params.get(name), name };
    return { k: 'var', name };
  }

  arrayRef(name) {
    if (this.params && this.params.has(name)) return { local: this.params.get(name), name };
    return { global: name, name };
  }

  /* --- expressions ------------------------------------------------ */

  expr(f) {
    const left = this.ternary(f);
    const t = this.peek().t;
    if (['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(t) && isLvalue(left)) {
      this.next();
      this.optNl();
      return { k: 'assign', op: t, lv: left, e: this.expr(f) };
    }
    return left;
  }

  ternary(f) {
    const c = this.or(f);
    if (this.accept('?')) {
      this.optNl();
      const a = this.expr(f);
      this.optNl();
      this.expect(':');
      this.optNl();
      const b = this.expr(f);
      return { k: 'cond', c, a, b };
    }
    return c;
  }

  or(f) {
    let l = this.and(f);
    while (this.accept('||')) { this.optNl(); l = { k: 'or', l, r: this.and(f) }; }
    return l;
  }

  and(f) {
    let l = this.inExpr(f);
    while (this.accept('&&')) { this.optNl(); l = { k: 'and', l, r: this.inExpr(f) }; }
    return l;
  }

  inExpr(f) {
    let l = this.matchExpr(f);
    while (this.isKw('in')) {
      this.next();
      const arrTok = this.expect('name');
      const subs = l.k === 'grouplist' ? l.list : [l];
      l = { k: 'in', subs, arr: this.arrayRef(arrTok.v) };
    }
    return l;
  }

  matchExpr(f) {
    let l = this.cmp(f);
    while (this.is('~') || this.is('!~')) {
      const neg = this.next().t === '!~';
      l = { k: 'match', neg, l, r: this.cmp(f) };
    }
    return l;
  }

  cmp(f) {
    const l = this.concat(f);
    const t = this.peek().t;
    if (['<', '<=', '!=', '==', '>=', '>'].includes(t) && !(t === '>' && f.noGt)) {
      this.next();
      return { k: 'cmp', op: t, l, r: this.concat(f) };
    }
    return l;
  }

  concat(f) {
    let l = this.additive(f);
    for (;;) {
      // cmd | getline [var]
      if (this.is('|') && this.peek(1).t === 'kw' && this.peek(1).v === 'getline') {
        this.next();
        this.next();
        const lv = this.optLvalue();
        l = { k: 'getline', kind: 'cmd', src: l, lv };
        continue;
      }
      const t = this.peek();
      if (CONCAT_START.has(t.t) && t.t !== '-' && t.t !== '+' && t.t !== '!') {
        l = { k: 'concat', l, r: this.additive(f) };
        continue;
      }
      return l;
    }
  }

  additive(f) {
    let l = this.mul(f);
    while (this.is('+') || this.is('-')) {
      const op = this.next().t;
      l = { k: 'bin', op, l, r: this.mul(f) };
    }
    return l;
  }

  mul(f) {
    let l = this.unary(f);
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.next().t;
      l = { k: 'bin', op, l, r: this.unary(f) };
    }
    return l;
  }

  unary(f) {
    if (this.accept('!')) return { k: 'not', e: this.unary(f) };
    if (this.accept('-')) return { k: 'neg', e: this.unary(f) };
    if (this.accept('+')) return { k: 'plus', e: this.unary(f) };
    return this.pow(f);
  }

  pow(f) {
    const base = this.postfix(f);
    if (this.accept('^')) {
      // right associative, and the exponent may carry a sign: 2^-1
      let exp;
      if (this.accept('-')) exp = { k: 'neg', e: this.powRhs(f) };
      else if (this.accept('+')) exp = { k: 'plus', e: this.powRhs(f) };
      else if (this.accept('!')) exp = { k: 'not', e: this.powRhs(f) };
      else exp = this.powRhs(f);
      return { k: 'bin', op: '^', l: base, r: exp };
    }
    return base;
  }

  powRhs(f) { return this.pow(f); }

  postfix(f) {
    const p = this.primary(f);
    if ((this.is('++') || this.is('--')) && isLvalue(p)) {
      const op = this.next().t;
      return { k: 'incdec', op, pre: false, lv: p };
    }
    return p;
  }

  optLvalue() {
    if (this.is('$')) {
      this.next();
      return { k: 'field', e: this.fieldOperand() };
    }
    if (this.is('name')) {
      const nameTok = this.next();
      if (this.accept('[')) {
        const subs = this.exprList({});
        this.expect(']');
        return { k: 'index', arr: this.arrayRef(nameTok.v), subs };
      }
      return this.varRef(nameTok.v);
    }
    return null;
  }

  /** What follows `$`: a primary, or ++/-- applied to one. */
  fieldOperand() {
    if (this.is('++') || this.is('--')) {
      const op = this.next().t;
      const lv = this.primary({});
      if (!isLvalue(lv)) this.fail();
      return { k: 'incdec', op, pre: true, lv };
    }
    if (this.accept('-')) return { k: 'neg', e: this.primary({}) };
    return this.primary({});
  }

  primary(f) {
    const tok = this.next();
    switch (tok.t) {
      case 'num': return { k: 'num', v: tok.v };
      case 'str': return { k: 'str', v: tok.v };
      case 'ere': return { k: 'ere', src: tok.v, rx: compileEre(tok.v, tok.line) };
      case '(': {
        const e = this.expr({});
        if (this.is(',')) {
          const list = [e];
          while (this.accept(',')) { this.optNl(); list.push(this.expr({})); }
          this.expect(')');
          return { k: 'grouplist', list };
        }
        this.expect(')');
        return { k: 'group', e };
      }
      case '$': return { k: 'field', e: this.fieldOperand() };
      case '++':
      case '--': {
        const lv = this.primary(f);
        if (!isLvalue(lv)) this.fail(tok);
        return { k: 'incdec', op: tok.t, pre: true, lv };
      }
      case '-': return { k: 'neg', e: this.unary(f) };
      case '+': return { k: 'plus', e: this.unary(f) };
      case '!': return { k: 'not', e: this.unary(f) };
      case 'name': {
        if (this.accept('[')) {
          const subs = this.exprList({});
          this.expect(']');
          return { k: 'index', arr: this.arrayRef(tok.v), subs };
        }
        return this.varRef(tok.v);
      }
      case 'funcname': {
        this.expect('(');
        const args = [];
        this.optNl();
        if (!this.is(')')) {
          args.push(this.expr({}));
          while (this.accept(',')) { this.optNl(); args.push(this.expr({})); }
        }
        this.expect(')');
        if (!this.called.has(tok.v)) this.called.set(tok.v, tok.line);
        return { k: 'call', name: tok.v, args };
      }
      case 'builtin': {
        const args = [];
        if (this.accept('(')) {
          this.optNl();
          if (!this.is(')')) {
            args.push(this.expr({}));
            while (this.accept(',')) { this.optNl(); args.push(this.expr({})); }
          }
          this.expect(')');
        } else if (tok.v !== 'length') {
          this.fail(this.peek());
        }
        return this.builtinNode(tok, args);
      }
      case 'kw':
        if (tok.v === 'getline') {
          const lv = this.optLvalue();
          if (this.accept('<')) {
            const src = this.postfixPrimary();
            return { k: 'getline', kind: 'file', src, lv };
          }
          return { k: 'getline', kind: 'simple', src: null, lv };
        }
        this.fail(tok);
        return null;
      default:
        this.fail(tok);
        return null;
    }
  }

  /** `getline < file`: the file is a primary (use parentheses for concatenation). */
  postfixPrimary() {
    return this.postfix({});
  }

  builtinNode(tok, args) {
    const name = tok.v;
    const arity = {
      length: [0, 1], substr: [2, 3], index: [2, 2], split: [2, 3], sub: [2, 3], gsub: [2, 3], match: [2, 2],
      sprintf: [1, 255], sin: [1, 1], cos: [1, 1], atan2: [2, 2], exp: [1, 1], log: [1, 1], sqrt: [1, 1],
      int: [1, 1], rand: [0, 0], srand: [0, 1], tolower: [1, 1], toupper: [1, 1], system: [1, 1],
      close: [1, 1], fflush: [0, 1], systime: [0, 0], mktime: [1, 1], strftime: [0, 3],
    }[name];
    if (args.length < arity[0] || args.length > arity[1]) {
      throw new AwkSyntaxError(`line ${tok.line}: wrong number of arguments in call to ${name}`);
    }
    const node = { k: 'builtin', name, args };
    if (name === 'split') {
      if (args[1].k !== 'var' && args[1].k !== 'local') throw new AwkSyntaxError(`line ${tok.line}: type error in arg(2) in call to split`);
      node.arr = args[1].k === 'local' ? { local: args[1].idx, name: args[1].name } : { global: args[1].name, name: args[1].name };
    }
    if ((name === 'sub' || name === 'gsub') && args[2] && !isLvalue(args[2])) {
      throw new AwkSyntaxError(`line ${tok.line}: type error in arg(3) in call to ${name}`);
    }
    if (name === 'length' && args[0] && (args[0].k === 'var' || args[0].k === 'local')) node.maybeArray = true;
    return node;
  }
}

function isLvalue(n) {
  return n && (n.k === 'var' || n.k === 'local' || n.k === 'field' || n.k === 'index');
}

const ereCache = new Map();

function compileEre(src, line) {
  try {
    return makeRegex(src);
  } catch (err) {
    throw new AwkSyntaxError(`line ${line}: regular expression compile failed (${err.message.replace(/^Invalid regular expression: /, '')})\n${src}`);
  }
}

function makeRegex(src) {
  let rx = ereCache.get(src);
  if (!rx) {
    const js = ereToJs(src);
    try {
      rx = new RegExp(js, 'su');
    } catch {
      rx = new RegExp(js, 's');
    }
    if (ereCache.size > 500) ereCache.clear();
    ereCache.set(src, rx);
  }
  return rx;
}

/** A global copy of a regex for scanning (sub, gsub, split, RS). */
function globalOf(rx) {
  if (!rx._g) rx._g = new RegExp(rx.source, `${rx.flags}g`);
  return rx._g;
}

/**
 * @param {string} src program text
 * @returns {object} the parsed program
 */
export function parseProgram(src) {
  return new Parser(src).program();
}

/* ================================================================== *
 * input records
 * ================================================================== */

class Reader {
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  next(rs, awk) {
    const t = this.text;
    if (this.pos >= t.length) return null;
    if (rs === '') {
      while (this.pos < t.length && t[this.pos] === '\n') this.pos += 1;
      if (this.pos >= t.length) return null;
      const m = /\n\n+/g;
      m.lastIndex = this.pos;
      const hit = m.exec(t);
      let rec;
      if (hit) { rec = t.slice(this.pos, hit.index); this.pos = hit.index + hit[0].length; }
      else { rec = t.slice(this.pos).replace(/\n+$/, ''); this.pos = t.length; }
      return rec;
    }
    if (rs.length === 1) {
      const idx = t.indexOf(rs, this.pos);
      let rec;
      if (idx < 0) { rec = t.slice(this.pos); this.pos = t.length; }
      else { rec = t.slice(this.pos, idx); this.pos = idx + 1; }
      return rec;
    }
    const rx = globalOf(awk.dynRe(rs));
    rx.lastIndex = this.pos;
    let hit = rx.exec(t);
    while (hit && hit[0] === '') { rx.lastIndex = hit.index + 1; hit = rx.lastIndex <= t.length ? rx.exec(t) : null; }
    let rec;
    if (hit) { rec = t.slice(this.pos, hit.index); this.pos = hit.index + hit[0].length; }
    else { rec = t.slice(this.pos); this.pos = t.length; }
    return rec;
  }
}

/* ================================================================== *
 * the interpreter
 * ================================================================== */

const SPECIAL_INIT = {
  FS: ' ', OFS: ' ', ORS: '\n', RS: '\n', SUBSEP: '\x1c', CONVFMT: '%.6g', OFMT: '%.6g',
  NR: 0, FNR: 0, RSTART: 0, RLENGTH: -1, FILENAME: '',
};

export class Awk {
  /**
   * @param {object} prog from parseProgram
   * @param {object} io
   *   stdin: string                       standard input
   *   readFile(name): string              throws Error(message) when it cannot
   *   writeFile(name, text, append)       throws when it cannot
   *   run(cmd, stdin?): Promise<{code, stdout}>
   *   env: object                         ENVIRON
   *   argv: string[]                      ARGV[0..]
   *   assigns: [name, value][]            -v assignments (already unescaped)
   */
  constructor(prog, io) {
    this.prog = prog;
    this.io = io;
    this.g = new Map();
    for (const [k, v] of Object.entries(SPECIAL_INIT)) this.g.set(k, v);
    const envArr = new AwkArray();
    for (const [k, v] of Object.entries(io.env || {})) envArr.set(k, new StrNum(String(v)));
    this.g.set('ENVIRON', envArr);
    const argvArr = new AwkArray();
    (io.argv || ['awk']).forEach((a, i) => argvArr.set(String(i), new StrNum(a)));
    this.g.set('ARGV', argvArr);
    this.g.set('ARGC', (io.argv || ['awk']).length);
    this.record = '';
    this.recFS = ' ';
    this.fields = null;
    this.nf = 0;
    this.frames = [];
    this.out = '';
    this.err = '';
    this.outs = new Map();
    this.inFiles = new Map();
    this.inCmds = new Map();
    this.stdinReader = null;
    this.mainReader = null;
    this.argIndex = 1;
    this.sawFile = false;
    this.steps = 0;
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.prevSeed = this.seed;
    this.rng = mulberry32(this.seed);
    this.exitCode = 0;
    this.exiting = false;
    this.depth = 0;
  }

  /* --- variables ------------------------------------------------- */

  getVar(name) {
    if (name === 'NF') { this.split(); return this.nf; }
    const v = this.g.get(name);
    if (v instanceof AwkArray) throw new AwkRuntimeError(`can't use array ${name} in scalar context`);
    return v;
  }

  setVar(name, v) {
    if (name === 'NF') { this.setNF(toNum(v)); return; }
    if (this.g.get(name) instanceof AwkArray) throw new AwkRuntimeError(`can't assign to array ${name}`);
    this.g.set(name, v);
    if (name === 'FS' || name === 'RS') this.fsCache = null;
  }

  frame() { return this.frames[this.frames.length - 1]; }

  getLocal(idx) {
    const v = this.frame()[idx];
    if (v instanceof RefCell) return undefined;
    if (v instanceof AwkArray) throw new AwkRuntimeError('can\'t use array in scalar context');
    return v;
  }

  setLocal(idx, v) {
    const f = this.frame();
    if (f[idx] instanceof AwkArray) throw new AwkRuntimeError('can\'t assign to array');
    f[idx] = v;
  }

  /** The array an AST array reference names, creating it on first use. */
  arrayOf(ref) {
    if (ref.global !== undefined) {
      let v = this.g.get(ref.global);
      if (v instanceof AwkArray) return v;
      if (v !== undefined || ['NF', 'NR', 'FNR', 'FS', 'OFS', 'ORS', 'RS'].includes(ref.global)) {
        throw new AwkRuntimeError(`can't use scalar ${ref.global} as array`);
      }
      v = new AwkArray();
      this.g.set(ref.global, v);
      return v;
    }
    const f = this.frame();
    const v = f[ref.local];
    if (v instanceof AwkArray) return v;
    if (v instanceof RefCell) { const arr = v.create(); f[ref.local] = arr; return arr; }
    if (v !== undefined) throw new AwkRuntimeError(`can't use scalar ${ref.name} as array`);
    const arr = new AwkArray();
    f[ref.local] = arr;
    return arr;
  }

  str(v) {
    if (typeof v === 'string') return v;
    if (v instanceof StrNum) return v.s;
    if (v === undefined) return '';
    if (typeof v === 'number') return this.numStr(v, this.g.get('CONVFMT'));
    throw new AwkRuntimeError("can't use array in scalar context");
  }

  outStr(v) {
    if (typeof v === 'number') return this.numStr(v, this.g.get('OFMT'));
    return this.str(v);
  }

  numStr(v, fmt) {
    if (Number.isInteger(v)) {
      if (Object.is(v, -0)) return '-0';
      if (Math.abs(v) < 1e16) return String(v);
      if (Math.abs(v) < 1e30) return BigInt(v).toString();
    }
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    return formatPrintf(this.str(fmt), [v], (x) => this.str(x));
  }

  /* --- fields ------------------------------------------------------ */

  /** A new $0. It is split with the FS in force now, even if FS changes before a field is used. */
  setRecord(s) {
    this.record = s;
    this.fields = null;
    this.recFS = this.str(this.g.get('FS'));
  }

  split() {
    if (this.fields) return;
    const parts = this.splitWith(this.record, this.recFS, this.str(this.g.get('RS')) === '');
    this.fields = [null];
    for (const p of parts) this.fields.push(new StrNum(p));
    this.nf = parts.length;
  }

  /** Split by awk's FS rules. */
  splitWith(s, fs, paragraph) {
    if (s === '') return [];
    if (fs === ' ') {
      const t = s.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
      return t === '' ? [] : t.split(/[ \t\n]+/);
    }
    if (fs === '') return Array.from(s);
    if (fs.length === 1 && fs !== '\\') {
      if (paragraph && fs !== '\n') return s.split(new RegExp(`[${fs.replace(/[\]\\^-]/g, '\\$&')}\\n]`));
      return s.split(fs);
    }
    const rx = globalOf(this.dynRe(paragraph ? `(${fs})|\n` : fs));
    const out = [];
    let last = 0;
    rx.lastIndex = 0;
    for (let m = rx.exec(s); m; m = rx.exec(s)) {
      if (m[0] === '') { rx.lastIndex += 1; if (rx.lastIndex > s.length) break; continue; }
      out.push(s.slice(last, m.index));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return out;
  }

  getField(i) {
    if (i === 0) return new StrNum(this.record);
    this.split();
    return i <= this.nf ? this.fields[i] : undefined;
  }

  setField(i, v) {
    if (i === 0) { this.setRecord(this.str(v)); return; }
    this.split();
    while (this.nf < i) { this.nf += 1; this.fields[this.nf] = ''; }
    this.fields[i] = v;
    this.rebuild();
  }

  setNF(n) {
    this.split();
    const want = Math.max(0, Math.trunc(n));
    while (this.nf < want) { this.nf += 1; this.fields[this.nf] = ''; }
    this.nf = want;
    this.fields.length = want + 1;
    this.rebuild();
  }

  rebuild() {
    const ofs = this.str(this.g.get('OFS'));
    const parts = [];
    for (let i = 1; i <= this.nf; i += 1) parts.push(this.str(this.fields[i]));
    this.record = parts.join(ofs);
  }

  fieldIndex(v) {
    const n = toNum(v);
    if (n < 0) throw new AwkRuntimeError(`negative field index $${Math.trunc(n)}`);
    return Math.trunc(n);
  }

  /* --- regex --------------------------------------------------------- */

  dynRe(v) {
    const src = typeof v === 'object' && v && v.rx ? null : this.str(v);
    if (src === null) return v.rx;
    try {
      return makeRegex(src);
    } catch (err) {
      throw new AwkRuntimeError(`regular expression compile failed (${err.message.replace(/^Invalid regular expression: /, '')})\n${src}`);
    }
  }

  *regexArg(node) {
    if (node.k === 'ere') return node.rx;
    return this.dynRe(yield* this.ev(node));
  }

  /* --- input --------------------------------------------------------- */

  stdin() {
    if (!this.stdinReader) this.stdinReader = new Reader(this.io.stdin || '');
    return this.stdinReader;
  }

  /** Next record of the main input, across ARGV operands. */
  nextMain() {
    const rs = this.str(this.g.get('RS'));
    for (;;) {
      if (this.mainReader) {
        const rec = this.mainReader.next(rs, this);
        if (rec !== null) return rec;
        this.mainReader = null;
        if (this.mainDone) return null;
      }
      if (this.mainDone) return null;
      const argc = Math.trunc(toNum(this.g.get('ARGC')));
      const argv = this.g.get('ARGV');
      let opened = false;
      while (this.argIndex < argc) {
        const a = argv instanceof AwkArray ? argv.get(String(this.argIndex)) : undefined;
        this.argIndex += 1;
        const s = this.str(a);
        if (s === '') continue;
        const asg = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(s);
        if (asg) {
          this.setVar(asg[1], new StrNum(unescapeString(asg[2])));
          continue;
        }
        this.sawFile = true;
        if (s === '-' || s === '/dev/stdin') {
          this.mainReader = this.stdin();
        } else {
          let text;
          try {
            text = this.io.readFile(s);
          } catch (err) {
            throw new AwkFatal(`cannot open ${s} (${err.message})`);
          }
          this.mainReader = new Reader(text);
        }
        this.g.set('FILENAME', s);
        this.g.set('FNR', 0);
        opened = true;
        break;
      }
      if (!opened) {
        if (this.sawFile) { this.mainDone = true; return null; }
        this.sawFile = true;
        this.mainReader = this.stdin();
        this.g.set('FNR', 0);
        this.mainDone = true;   // stdin is the only input; end after it
        const rec = this.mainReader.next(rs, this);
        return rec;
      }
    }
  }

  /** A main-input record for the pattern loop or plain `getline`. */
  readMain() {
    const rec = this.nextMain();
    if (rec === null) return null;
    this.g.set('NR', toNum(this.g.get('NR')) + 1);
    this.g.set('FNR', toNum(this.g.get('FNR')) + 1);
    return rec;
  }

  /* --- output -------------------------------------------------------- */

  write(text, redir, target) {
    if (!redir) { this.out += text; return; }
    const name = target;
    if (redir === '|') {
      let e = this.outs.get(`|${name}`);
      if (!e) { e = { kind: 'pipe', name, chunks: [] }; this.outs.set(`|${name}`, e); }
      e.chunks.push(text);
      return;
    }
    if (name === '/dev/stdout' || name === '-') { this.out += text; return; }
    if (name === '/dev/stderr') { this.err += text; return; }
    let e = this.outs.get(`>${name}`);
    if (!e) {
      e = { kind: 'file', name, chunks: [], truncate: redir === '>', size: 0 };
      this.outs.set(`>${name}`, e);
    }
    e.chunks.push(text);
    e.size += text.length;
    if (e.size > 65536) this.flushFile(e);
  }

  flushFile(e) {
    const text = e.chunks.join('');
    e.chunks = [];
    e.size = 0;
    try {
      this.io.writeFile(e.name, text, !e.truncate);
    } catch (err) {
      throw new AwkFatal(`cannot open "${e.name}" for output (${err.message})`);
    }
    e.truncate = false;
  }

  *closeStream(name) {
    let code = -1;
    const file = this.outs.get(`>${name}`);
    if (file) { this.flushFile(file); this.outs.delete(`>${name}`); code = 0; }
    const pipe = this.outs.get(`|${name}`);
    if (pipe) {
      this.outs.delete(`|${name}`);
      const res = yield this.io.run(name, pipe.chunks.join(''));
      this.out += res.stdout || '';
      code = res.code;
    }
    if (this.inFiles.has(name)) { this.inFiles.delete(name); code = 0; }
    if (this.inCmds.has(name)) { this.inCmds.delete(name); code = 0; }
    return code;
  }

  *closeAll() {
    for (const [key, e] of Array.from(this.outs)) {
      if (e.kind === 'file') this.flushFile(e);
      else {
        const res = yield this.io.run(e.name, e.chunks.join(''));
        this.out += res.stdout || '';
      }
      this.outs.delete(key);
    }
  }

  /* --- running ------------------------------------------------------- */

  /** Drive the whole program; yields Promises and TICKs to the caller. */
  *main() {
    for (const [name, value] of this.io.assigns || []) this.setVar(name, new StrNum(value));
    const { begin, end, rules } = this.prog;
    let sig;
    for (const b of begin) {
      sig = yield* this.guard(this.exec(b));
      if (sig && sig.type === 'exit') break;
      if (sig && (sig.type === 'next' || sig.type === 'nextfile')) throw new AwkRuntimeError('improper use of next');
    }
    if (!this.exiting && (rules.length || end.length)) {
      recordLoop: for (;;) {
        const rec = this.readMain();
        if (rec === null) break;
        this.setRecord(rec);
        for (const rule of rules) {
          sig = yield* this.guard(this.ruleStep(rule));
          if (!sig) continue;
          if (sig.type === 'next') break;
          if (sig.type === 'nextfile') { this.mainReader = null; break; }
          if (sig.type === 'exit') break recordLoop;
        }
      }
    }
    // END runs after `exit` in BEGIN or a rule; an `exit` inside END stops it.
    for (const b of end) {
      sig = yield* this.guard(this.exec(b));
      if (sig && sig.type === 'exit') break;
    }
    yield* this.closeAll();
    return this.exitCode;
  }

  *ruleStep(rule) {
    if (!(yield* this.matches(rule))) return null;
    return rule.action ? yield* this.exec(rule.action) : yield* this.printRecord();
  }

  /** Run a block, turning an exit/next raised inside a function back into a signal. */
  *guard(gen) {
    try {
      return yield* gen;
    } catch (err) {
      if (err === EXIT_UNWIND) {
        const sig = this.pendingExit;
        this.pendingExit = null;
        return sig;
      }
      throw err;
    }
  }

  *printRecord() {
    this.out += this.record + this.str(this.g.get('ORS'));
    return null;
  }

  *matches(rule) {
    if (!rule.pattern) return true;
    if (!rule.pattern2) return truthy(yield* this.ev(rule.pattern));
    if (!rule.inRange) {
      if (!truthy(yield* this.ev(rule.pattern))) return false;
      rule.inRange = true;
    }
    if (truthy(yield* this.ev(rule.pattern2))) rule.inRange = false;
    return true;
  }

  /* --- statements ---------------------------------------------------- */

  *exec(s) {
    this.steps += 1;
    if ((this.steps & 4095) === 0) yield TICK;
    switch (s.k) {
      case 'block':
        for (const st of s.body) {
          const sig = yield* this.exec(st);
          if (sig) return sig;
        }
        return null;
      case 'nop': return null;
      case 'expr': yield* this.ev(s.e); return null;
      case 'print': {
        let text;
        if (s.args.length === 0) text = this.record;
        else {
          const parts = [];
          for (const a of s.args) parts.push(this.outStr(yield* this.ev(a)));
          text = parts.join(this.str(this.g.get('OFS')));
        }
        text += this.str(this.g.get('ORS'));
        const target = s.redir ? this.str(yield* this.ev(s.redir.e)) : null;
        this.write(text, s.redir && s.redir.type, target);
        return null;
      }
      case 'printf': {
        const vals = [];
        for (const a of s.args) vals.push(yield* this.ev(a));
        const text = formatPrintf(this.str(vals[0]), vals.slice(1), (x) => this.str(x));
        const target = s.redir ? this.str(yield* this.ev(s.redir.e)) : null;
        this.write(text, s.redir && s.redir.type, target);
        return null;
      }
      case 'if':
        if (truthy(yield* this.ev(s.c))) return yield* this.exec(s.t);
        if (s.f) return yield* this.exec(s.f);
        return null;
      case 'while':
        while (truthy(yield* this.ev(s.c))) {
          const sig = yield* this.exec(s.body);
          if (sig) {
            if (sig.type === 'break') break;
            if (sig.type === 'continue') continue;
            return sig;
          }
        }
        return null;
      case 'do':
        do {
          const sig = yield* this.exec(s.body);
          if (sig) {
            if (sig.type === 'break') break;
            if (sig.type !== 'continue') return sig;
          }
        } while (truthy(yield* this.ev(s.c)));
        return null;
      case 'for':
        if (s.init) yield* this.ev(s.init);
        while (!s.c || truthy(yield* this.ev(s.c))) {
          const sig = yield* this.exec(s.body);
          if (sig) {
            if (sig.type === 'break') break;
            if (sig.type !== 'continue') return sig;
          }
          if (s.step) yield* this.ev(s.step);
        }
        return null;
      case 'forin': {
        const arr = this.arrayOf(s.arr);
        for (const key of Array.from(arr.keys())) {
          if (!arr.has(key)) continue;
          const ref = yield* this.lref(s.v);
          ref.set(new StrNum(key));
          const sig = yield* this.exec(s.body);
          if (sig) {
            if (sig.type === 'break') break;
            if (sig.type !== 'continue') return sig;
          }
        }
        return null;
      }
      case 'next': return { type: 'next' };
      case 'nextfile': return { type: 'nextfile' };
      case 'break': return { type: 'break' };
      case 'continue': return { type: 'continue' };
      case 'exit':
        if (s.e) this.exitCode = Math.trunc(toNum(yield* this.ev(s.e))) & 255;
        this.exiting = true;
        return { type: 'exit' };
      case 'return':
        return { type: 'return', value: s.e ? yield* this.ev(s.e) : undefined };
      case 'delete': {
        const arr = this.arrayOf(s.arr);
        if (!s.subs) arr.clear();
        else arr.delete(yield* this.subscript(s.subs));
        return null;
      }
      default:
        throw new AwkRuntimeError(`internal: statement ${s.k}`);
    }
  }

  *subscript(subs) {
    if (subs.length === 1) return this.str(yield* this.ev(subs[0]));
    const parts = [];
    for (const e of subs) parts.push(this.str(yield* this.ev(e)));
    return parts.join(this.str(this.g.get('SUBSEP')));
  }

  /** A get/set handle on an lvalue, evaluating its subscript or field index once. */
  *lref(n) {
    switch (n.k) {
      case 'var': return { get: () => this.getVar(n.name), set: (v) => this.setVar(n.name, v) };
      case 'local': return { get: () => this.getLocal(n.idx), set: (v) => this.setLocal(n.idx, v) };
      case 'field': {
        const i = this.fieldIndex(yield* this.ev(n.e));
        return { get: () => this.getField(i), set: (v) => this.setField(i, v) };
      }
      case 'index': {
        const arr = this.arrayOf(n.arr);
        const key = yield* this.subscript(n.subs);
        return { get: () => arr.get(key), set: (v) => arr.set(key, v) };
      }
      default: throw new AwkRuntimeError('assignment to non-lvalue');
    }
  }

  /* --- expressions --------------------------------------------------- */

  *ev(n) {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'var': return this.getVar(n.name);
      case 'local': return this.getLocal(n.idx);
      case 'ere': return n.rx.test(this.record) ? 1 : 0;
      case 'group': return yield* this.ev(n.e);
      case 'grouplist': throw new AwkRuntimeError('syntax error: grouping list');
      case 'field': return this.getField(this.fieldIndex(yield* this.ev(n.e)));
      case 'index': {
        const arr = this.arrayOf(n.arr);
        const key = yield* this.subscript(n.subs);
        if (!arr.has(key)) { arr.set(key, undefined); return undefined; }
        return arr.get(key);
      }
      case 'in': {
        const key = yield* this.subscript(n.subs);
        return this.arrayOf(n.arr).has(key) ? 1 : 0;
      }
      case 'assign': {
        const ref = yield* this.lref(n.lv);
        let v = yield* this.ev(n.e);
        if (v instanceof AwkArray) throw new AwkRuntimeError("can't assign array");
        if (n.op !== '=') v = arith(n.op === '^=' ? '^' : n.op[0], toNum(ref.get()), toNum(v));
        ref.set(v);
        return v;
      }
      case 'cond':
        return truthy(yield* this.ev(n.c)) ? yield* this.ev(n.a) : yield* this.ev(n.b);
      case 'or':
        return truthy(yield* this.ev(n.l)) || truthy(yield* this.ev(n.r)) ? 1 : 0;
      case 'and':
        return truthy(yield* this.ev(n.l)) && truthy(yield* this.ev(n.r)) ? 1 : 0;
      case 'match': {
        const s = this.str(yield* this.ev(n.l));
        const rx = yield* this.regexArg(n.r);
        return rx.test(s) !== n.neg ? 1 : 0;
      }
      case 'cmp': {
        const l = yield* this.ev(n.l);
        const r = yield* this.ev(n.r);
        let c;
        if (isNumeric(l) && isNumeric(r)) {
          const a = toNum(l);
          const b = toNum(r);
          c = a < b ? -1 : a > b ? 1 : a === b ? 0 : NaN;
        } else {
          const a = this.str(l);
          const b = this.str(r);
          c = a < b ? -1 : a > b ? 1 : 0;
        }
        switch (n.op) {
          case '<': return c < 0 ? 1 : 0;
          case '<=': return c <= 0 ? 1 : 0;
          case '>': return c > 0 ? 1 : 0;
          case '>=': return c >= 0 ? 1 : 0;
          case '==': return c === 0 ? 1 : 0;
          default: return c !== 0 ? 1 : 0;
        }
      }
      case 'concat': {
        const l = this.str(yield* this.ev(n.l));
        return l + this.str(yield* this.ev(n.r));
      }
      case 'bin': {
        const l = toNum(yield* this.ev(n.l));
        return arith(n.op, l, toNum(yield* this.ev(n.r)));
      }
      case 'neg': return -toNum(yield* this.ev(n.e));
      case 'plus': return toNum(yield* this.ev(n.e));
      case 'not': return truthy(yield* this.ev(n.e)) ? 0 : 1;
      case 'incdec': {
        const ref = yield* this.lref(n.lv);
        const old = toNum(ref.get());
        const val = n.op === '++' ? old + 1 : old - 1;
        ref.set(val);
        return n.pre ? val : old;
      }
      case 'call': return yield* this.callUser(n);
      case 'builtin': return yield* this.builtin(n);
      case 'getline': return yield* this.getline(n);
      default:
        throw new AwkRuntimeError(`internal: expression ${n.k}`);
    }
  }

  *callUser(n) {
    const fn = this.prog.funcs.get(n.name);
    if (n.args.length > fn.params.length) throw new AwkRuntimeError(`too many arguments in call to ${n.name}`);
    const locals = new Array(fn.params.length);
    for (let i = 0; i < n.args.length; i += 1) {
      const a = n.args[i];
      if (a.k === 'var') {
        const v = this.g.get(a.name);
        if (v instanceof AwkArray) locals[i] = v;
        else if (v === undefined && a.name !== 'NF') {
          const name = a.name;
          locals[i] = new RefCell(() => {
            const arr = new AwkArray();
            this.g.set(name, arr);
            return arr;
          });
        } else locals[i] = this.getVar(a.name);
      } else if (a.k === 'local') {
        const f = this.frame();
        const v = f[a.idx];
        if (v instanceof AwkArray) locals[i] = v;
        else if (v === undefined || v instanceof RefCell) {
          const idx = a.idx;
          const outer = v;
          locals[i] = new RefCell(() => {
            const arr = outer instanceof RefCell ? outer.create() : new AwkArray();
            f[idx] = arr;
            return arr;
          });
        } else locals[i] = v;
      } else {
        locals[i] = yield* this.ev(a);
      }
    }
    this.depth += 1;
    if (this.depth > 1500) throw new AwkRuntimeError('function call nesting too deep');
    this.frames.push(locals);
    try {
      const sig = yield* this.exec(fn.body);
      if (sig && sig.type === 'return') return sig.value;
      if (sig && sig.type === 'exit') { this.pendingExit = sig; throw EXIT_UNWIND; }
      if (sig && (sig.type === 'next' || sig.type === 'nextfile')) { this.pendingExit = sig; throw EXIT_UNWIND; }
      return undefined;
    } finally {
      this.frames.pop();
      this.depth -= 1;
    }
  }

  /* --- getline ---------------------------------------------------- */

  *getline(n) {
    let rec;
    if (n.kind === 'simple') {
      rec = this.readMain();
      if (rec === null) return 0;
      if (n.lv) { (yield* this.lref(n.lv)).set(new StrNum(rec)); }
      else this.setRecord(rec);
      return 1;
    }
    const name = this.str(yield* this.ev(n.src));
    const rs = this.str(this.g.get('RS'));
    if (n.kind === 'file') {
      let r = this.inFiles.get(name);
      if (!r) {
        if (name === '-' || name === '/dev/stdin') r = this.stdin();
        else {
          const openOut = this.outs.get(`>${name}`);
          if (openOut) this.flushFile(openOut);
          try {
            r = new Reader(this.io.readFile(name));
          } catch {
            return -1;
          }
        }
        this.inFiles.set(name, r);
      }
      rec = r.next(rs, this);
      if (rec === null) return 0;
      if (n.lv) (yield* this.lref(n.lv)).set(new StrNum(rec));
      else { this.setRecord(rec); }
      return 1;
    }
    // cmd | getline
    let r = this.inCmds.get(name);
    if (!r) {
      for (const e of this.outs.values()) if (e.kind === 'file') this.flushFile(e);
      const res = yield this.io.run(name, '');
      r = new Reader(res.stdout || '');
      this.inCmds.set(name, r);
    }
    rec = r.next(rs, this);
    if (rec === null) return 0;
    this.g.set('NR', toNum(this.g.get('NR')) + 1);
    if (n.lv) (yield* this.lref(n.lv)).set(new StrNum(rec));
    else this.setRecord(rec);
    return 1;
  }

  /* --- builtins --------------------------------------------------- */

  *builtin(n) {
    const a = n.args;
    const S = (v) => this.str(v);
    switch (n.name) {
      case 'length': {
        if (a.length === 0) return Array.from(this.record).length;
        if (n.maybeArray) {
          const node = a[0];
          const v = node.k === 'var' ? this.g.get(node.name) : this.frame()[node.idx];
          if (v instanceof AwkArray) return v.size;
        }
        return Array.from(S(yield* this.ev(a[0]))).length;
      }
      case 'substr': {
        // As gawk and BWK awk: both truncated, and a start before 1 counts as 1.
        const s = Array.from(S(yield* this.ev(a[0])));
        let start = Math.trunc(toNum(yield* this.ev(a[1])));
        const len = a[2] ? Math.trunc(toNum(yield* this.ev(a[2]))) : Infinity;
        if (!(start >= 1)) start = 1;
        if (!(len > 0)) return '';
        return s.slice(start - 1, len === Infinity ? undefined : start - 1 + len).join('');
      }
      case 'index': {
        const s = S(yield* this.ev(a[0]));
        const t = S(yield* this.ev(a[1]));
        const idx = s.indexOf(t);
        return idx < 0 ? 0 : Array.from(s.slice(0, idx)).length + 1;
      }
      case 'split': {
        const s = S(yield* this.ev(a[0]));
        const arr = this.arrayOf(n.arr);
        let parts;
        if (a[2]) {
          if (a[2].k === 'ere') parts = this.splitRegex(s, a[2].rx);
          else parts = this.splitWith(s, S(yield* this.ev(a[2])), false);
        } else {
          parts = this.splitWith(s, S(this.g.get('FS')), false);
        }
        arr.clear();
        parts.forEach((p, i) => arr.set(String(i + 1), new StrNum(p)));
        return parts.length;
      }
      case 'sub':
      case 'gsub': {
        const rx = yield* this.regexArg(a[0]);
        const repl = S(yield* this.ev(a[1]));
        const target = a[2] || { k: 'field', e: { k: 'num', v: 0 } };
        const ref = yield* this.lref(target);
        const src = S(ref.get());
        const { text, count } = substitute(src, rx, repl, n.name === 'gsub');
        if (count > 0) ref.set(text);
        return count;
      }
      case 'match': {
        const s = S(yield* this.ev(a[0]));
        const rx = yield* this.regexArg(a[1]);
        const m = rx.exec(s);
        if (!m) { this.g.set('RSTART', 0); this.g.set('RLENGTH', -1); return 0; }
        const start = Array.from(s.slice(0, m.index)).length + 1;
        this.g.set('RSTART', start);
        this.g.set('RLENGTH', Array.from(m[0]).length);
        return start;
      }
      case 'sprintf': {
        const vals = [];
        for (const e of a) vals.push(yield* this.ev(e));
        return formatPrintf(S(vals[0]), vals.slice(1), S, 'sprintf');
      }
      case 'sin': return Math.sin(toNum(yield* this.ev(a[0])));
      case 'cos': return Math.cos(toNum(yield* this.ev(a[0])));
      case 'atan2': { const y = toNum(yield* this.ev(a[0])); return Math.atan2(y, toNum(yield* this.ev(a[1]))); }
      case 'exp': return Math.exp(toNum(yield* this.ev(a[0])));
      case 'log': return Math.log(toNum(yield* this.ev(a[0])));
      case 'sqrt': return Math.sqrt(toNum(yield* this.ev(a[0])));
      case 'int': return Math.trunc(toNum(yield* this.ev(a[0])));
      case 'rand': return this.rng();
      case 'srand': {
        const prev = this.seed;
        this.seed = a[0] ? toNum(yield* this.ev(a[0])) : Math.floor(Date.now() / 1000);
        this.rng = mulberry32(Math.trunc(this.seed));
        return prev;
      }
      case 'tolower': return S(yield* this.ev(a[0])).replace(/[A-Z]+/g, (x) => x.toLowerCase());
      case 'toupper': return S(yield* this.ev(a[0])).replace(/[a-z]+/g, (x) => x.toUpperCase());
      case 'system': {
        const cmd = S(yield* this.ev(a[0]));
        for (const e of this.outs.values()) if (e.kind === 'file') this.flushFile(e);
        const res = yield this.io.run(cmd, '');
        this.out += res.stdout || '';
        return res.code;
      }
      case 'close': return yield* this.closeStream(S(yield* this.ev(a[0])));
      case 'fflush': {
        if (a[0]) {
          const name = S(yield* this.ev(a[0]));
          const e = this.outs.get(`>${name}`);
          if (e) this.flushFile(e);
        } else {
          for (const e of this.outs.values()) if (e.kind === 'file') this.flushFile(e);
        }
        return 0;
      }
      case 'systime': return Math.floor(Date.now() / 1000);
      case 'mktime': {
        const spec = S(yield* this.ev(a[0])).trim().split(/\s+/).map(Number);
        if (spec.length < 6 || spec.slice(0, 6).some((x) => !Number.isFinite(x))) return -1;
        const d = new Date(spec[0], spec[1] - 1, spec[2], spec[3], spec[4], spec[5]);
        return Math.floor(d.getTime() / 1000);
      }
      case 'strftime': {
        const fmt = a[0] ? S(yield* this.ev(a[0])) : '%a %b %e %H:%M:%S %Z %Y';
        const ts = a[1] ? toNum(yield* this.ev(a[1])) : Date.now() / 1000;
        const utc = a[2] ? truthy(yield* this.ev(a[2])) : false;
        return strftime(fmt, ts, utc);
      }
      default:
        throw new AwkRuntimeError(`function ${n.name} never defined`);
    }
  }

  splitRegex(s, rx) {
    if (s === '') return [];
    const g = globalOf(rx);
    const out = [];
    let last = 0;
    g.lastIndex = 0;
    for (let m = g.exec(s); m; m = g.exec(s)) {
      if (m[0] === '') { g.lastIndex += 1; if (g.lastIndex > s.length) break; continue; }
      out.push(s.slice(last, m.index));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return out;
  }
}

/** Thrown through generator frames when `exit`/`next` happens inside a function. */
const EXIT_UNWIND = { unwind: true };
export { EXIT_UNWIND };

function arith(op, a, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/':
      if (b === 0) throw new AwkFatal('division by zero');
      return a / b;
    case '%':
      if (b === 0) throw new AwkFatal('division by zero in %');
      return a % b;
    case '^': return a ** b;
    default: throw new AwkRuntimeError(`bad operator ${op}`);
  }
}

/** sub/gsub: `&` is the match, `\&` a literal ampersand, `\\` a backslash. */
function substitute(src, rx, repl, global) {
  const expand = (m) => {
    let out = '';
    for (let i = 0; i < repl.length; i += 1) {
      const c = repl[i];
      if (c === '\\' && (repl[i + 1] === '&' || repl[i + 1] === '\\')) { out += repl[i + 1]; i += 1; }
      else if (c === '&') out += m;
      else out += c;
    }
    return out;
  };
  const g = globalOf(rx);
  let out = '';
  let i = 0;
  let count = 0;
  let prevEnd = -1;
  while (i <= src.length) {
    g.lastIndex = i;
    const m = g.exec(src);
    if (!m) break;
    const start = m.index;
    const end = start + m[0].length;
    if (start === end && start === prevEnd) {
      if (start >= src.length) break;
      out += src.slice(i, start + 1);
      i = start + 1;
      continue;
    }
    out += src.slice(i, start) + expand(m[0]);
    count += 1;
    prevEnd = end;
    if (end === start) {
      if (start >= src.length) { i = src.length + 1; break; }
      out += src[start];
      i = start + 1;
    } else i = end;
    if (!global) break;
  }
  if (i <= src.length) out += src.slice(i);
  return { text: out, count };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function strftime(fmt, ts, utc) {
  const d = new Date(ts * 1000);
  const get = utc
    ? { Y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(), w: d.getUTCDay() }
    : { Y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), H: d.getHours(), M: d.getMinutes(), S: d.getSeconds(), w: d.getDay() };
  const two = (n) => String(n).padStart(2, '0');
  const yday = Math.floor((Date.UTC(get.Y, get.m, get.d) - Date.UTC(get.Y, 0, 1)) / 86400000) + 1;
  const off = utc ? 0 : -d.getTimezoneOffset();
  const tz = utc ? 'UTC' : (Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName') || {}).value || 'UTC';
  return fmt.replace(/%([a-zA-Z%])/g, (all, c) => {
    switch (c) {
      case 'Y': return String(get.Y);
      case 'y': return two(get.Y % 100);
      case 'm': return two(get.m + 1);
      case 'd': return two(get.d);
      case 'e': return String(get.d).padStart(2, ' ');
      case 'H': return two(get.H);
      case 'I': return two(get.H % 12 || 12);
      case 'M': return two(get.M);
      case 'S': return two(get.S);
      case 'p': return get.H < 12 ? 'AM' : 'PM';
      case 'a': return DAY[get.w].slice(0, 3);
      case 'A': return DAY[get.w];
      case 'b': case 'h': return MON[get.m].slice(0, 3);
      case 'B': return MON[get.m];
      case 'j': return String(yday).padStart(3, '0');
      case 'u': return String(get.w || 7);
      case 'w': return String(get.w);
      case 'Z': return tz;
      case 'z': return `${off < 0 ? '-' : '+'}${two(Math.floor(Math.abs(off) / 60))}${two(Math.abs(off) % 60)}`;
      case 's': return String(Math.floor(ts));
      case 'T': return `${two(get.H)}:${two(get.M)}:${two(get.S)}`;
      case 'R': return `${two(get.H)}:${two(get.M)}`;
      case 'D': return `${two(get.m + 1)}/${two(get.d)}/${two(get.Y % 100)}`;
      case 'F': return `${get.Y}-${two(get.m + 1)}-${two(get.d)}`;
      case 'c': return `${DAY[get.w].slice(0, 3)} ${MON[get.m].slice(0, 3)} ${String(get.d).padStart(2, ' ')} ${two(get.H)}:${two(get.M)}:${two(get.S)} ${get.Y}`;
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return all;
    }
  });
}

export { toNum, truthy };
