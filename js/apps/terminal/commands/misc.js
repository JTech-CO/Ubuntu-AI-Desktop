/**
 * js/apps/terminal/commands/misc.js — the odds and ends.
 *
 * Timing (sleep, watch, time), generators (seq, yes), the calculator (bc),
 * digests and encodings (md5sum, sha256sum, base64, xxd), the desktop
 * launchers (nano/vim/gedit/code/nautilus/firefox/xdg-open), the toys
 * (cowsay, figlet, banner, fortune) and the session actions (reboot,
 * poweroff, shutdown).
 *
 * `bc` is a real tokenizer plus a precedence-climbing parser — there is no
 * `eval` or `new Function` anywhere in this project. `md5sum` is a full MD5
 * implementation; `sha256sum` uses `crypto.subtle`.
 */

import { fs } from '../../../core/fs.js';
import { env } from '../../../core/env.js';
import { users } from '../../../core/users.js';
import { bus } from '../../../core/bus.js';
import { wm } from '../../../shell/window-manager.js';
import { showSessionOverlay, takeScreenshot } from '../../../shell/session.js';
import { execute } from '../shell.js';
import {
  ok, fail, wait, aborted, wrap, termCols, isRoot,
  MONTHS_SHORT, DAYS_SHORT, pad0,
} from './util.js';

/* ================================================================== *
 * sleep
 * ================================================================== */

/** Suffix multipliers accepted by GNU sleep. */
const SLEEP_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Parse one sleep operand.
 * @param {string} spec
 * @returns {number|null} seconds, or null when the operand is invalid
 */
function parseDuration(spec) {
  const m = /^([0-9]*\.?[0-9]+)([smhd]?)$/.exec(String(spec));
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return value * (SLEEP_UNITS[m[2] || 's'] || 1);
}

const sleepCommand = {
  name: 'sleep',
  aliases: [],
  synopsis: 'sleep NUMBER[SUFFIX]...',
  description: 'Delay for a specified amount of time',
  man: `NAME
       sleep - delay for a specified amount of time

SYNOPSIS
       sleep NUMBER[SUFFIX]...

DESCRIPTION
       Pause for NUMBER seconds. SUFFIX may be 's' for seconds (the default),
       'm' for minutes, 'h' for hours or 'd' for days. NUMBER need not be an
       integer. Given two or more arguments, pause for the amount of time
       specified by the sum of their values.

       Ctrl+C interrupts the sleep and returns 130.

EXAMPLES
       sleep 5
       sleep 1.5
       sleep 2m 30s`,
  async run(ctx) {
    const argv = ctx.argv.filter((a) => a !== '--');
    if (argv.includes('--help')) return ok('Usage: sleep NUMBER[SUFFIX]...\n');
    if (argv.includes('--version')) return ok('sleep (GNU coreutils) 9.4\n');

    const operands = argv.filter((a) => !a.startsWith('-'));
    if (operands.length === 0) {
      return fail("sleep: missing operand\nTry 'sleep --help' for more information.\n", 1);
    }

    let seconds = 0;
    for (const spec of operands) {
      const value = parseDuration(spec);
      if (value === null) {
        return fail(`sleep: invalid time interval ‘${spec}’\nTry 'sleep --help' for more information.\n`, 1);
      }
      seconds += value;
    }

    await wait(seconds * 1000, ctx.signal);
    if (aborted(ctx.signal)) return { stdout: '', stderr: '', code: 130 };
    return ok('');
  },
};

/* ================================================================== *
 * seq
 * ================================================================== */

/** Decimal places in a numeric literal. */
function decimals(text) {
  const dot = String(text).indexOf('.');
  return dot < 0 ? 0 : String(text).length - dot - 1;
}

const seqCommand = {
  name: 'seq',
  aliases: [],
  synopsis: 'seq [-w] [-s STRING] [FIRST [INCREMENT]] LAST',
  description: 'Print a sequence of numbers',
  man: `NAME
       seq - print a sequence of numbers

SYNOPSIS
       seq [OPTION]... LAST
       seq [OPTION]... FIRST LAST
       seq [OPTION]... FIRST INCREMENT LAST

DESCRIPTION
       Print numbers from FIRST to LAST, in steps of INCREMENT. FIRST and
       INCREMENT default to 1.

OPTIONS
       -f, --format=FORMAT
              Use a printf-style floating-point FORMAT.

       -s, --separator=STRING
              Use STRING to separate numbers (default: a newline).

       -w, --equal-width
              Equalize width by padding with leading zeroes.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let separator = '\n';
    let equalWidth = false;
    let format = null;
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--help') return ok('Usage: seq [OPTION]... LAST\n  or:  seq [OPTION]... FIRST LAST\n  or:  seq [OPTION]... FIRST INCREMENT LAST\n');
      if (a === '--version') return ok('seq (GNU coreutils) 9.4\n');
      if (a === '-s' || a === '--separator') { separator = argv[++i] ?? '\n'; continue; }
      if (a.startsWith('--separator=')) { separator = a.slice(12); continue; }
      if (a.startsWith('-s') && a.length > 2) { separator = a.slice(2); continue; }
      if (a === '-f' || a === '--format') { format = argv[++i] ?? null; continue; }
      if (a.startsWith('--format=')) { format = a.slice(9); continue; }
      if (a === '-w' || a === '--equal-width') { equalWidth = true; continue; }
      operands.push(a);
    }

    if (operands.length === 0 || operands.length > 3) {
      return fail(operands.length === 0
        ? "seq: missing operand\nTry 'seq --help' for more information.\n"
        : `seq: extra operand ‘${operands[3]}’\nTry 'seq --help' for more information.\n`, 1);
    }

    for (const value of operands) {
      if (!/^[-+]?([0-9]*\.?[0-9]+)([eE][-+]?[0-9]+)?$/.test(value)) {
        return fail(`seq: invalid floating point argument: ‘${value}’\nTry 'seq --help' for more information.\n`, 1);
      }
    }

    const first = operands.length === 1 ? '1' : operands[0];
    const increment = operands.length === 3 ? operands[1] : '1';
    const last = operands[operands.length - 1];

    const start = Number(first);
    const step = Number(increment);
    const end = Number(last);

    if (step === 0) {
      return fail(`seq: invalid Zero increment value: ‘${increment}’\nTry 'seq --help' for more information.\n`, 1);
    }

    const places = Math.max(decimals(first), decimals(increment), decimals(last));
    const values = [];
    const LIMIT = 1_000_000;

    if (step > 0) {
      for (let v = start, n = 0; v <= end + Number.EPSILON * Math.abs(end) && n < LIMIT; n += 1, v = start + step * (n)) {
        values.push(v);
      }
    } else {
      for (let v = start, n = 0; v >= end - Number.EPSILON * Math.abs(end) && n < LIMIT; n += 1, v = start + step * (n)) {
        values.push(v);
      }
    }

    if (values.length === 0) return ok('');

    let texts = values.map((v) => v.toFixed(places));
    if (equalWidth) {
      const width = Math.max(...texts.map((t) => t.length));
      texts = texts.map((t) => (t.startsWith('-') ? `-${t.slice(1).padStart(width - 1, '0')}` : t.padStart(width, '0')));
    }
    if (format !== null) {
      const m = /%([-+ 0]*)(\d*)(?:\.(\d+))?([fgeGE])/.exec(format);
      if (m) {
        const prec = m[3] === undefined ? places : Number(m[3]);
        const width = m[2] === '' ? 0 : Number(m[2]);
        texts = values.map((v) => {
          let t = v.toFixed(prec);
          if (m[1].includes('-')) t = t.padEnd(width);
          else if (m[1].includes('0')) t = t.padStart(width, '0');
          else t = t.padStart(width);
          return format.replace(m[0], t);
        });
      }
    }

    return ok(`${texts.join(separator)}\n`);
  },
};

/* ================================================================== *
 * yes
 * ================================================================== */

const yesCommand = {
  name: 'yes',
  aliases: [],
  synopsis: 'yes [STRING]...',
  description: 'Output a string repeatedly until killed',
  man: `NAME
       yes - output a string repeatedly until killed

SYNOPSIS
       yes [STRING]...

DESCRIPTION
       Repeatedly output a line with all specified STRING(s), or 'y'.

       In a browser an unthrottled writer would freeze the tab, so this
       implementation emits a burst of lines every 60ms and stops after one
       million lines even if nothing interrupts it. Ctrl+C stops it at once.`,
  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--help')) return ok('Usage: yes [STRING]...\n  or:  yes OPTION\nRepeatedly output a line with all specified STRING(s), or \'y\'.\n');
    if (argv.includes('--version')) return ok('yes (GNU coreutils) 9.4\n');

    const text = argv.length > 0 ? argv.join(' ') : 'y';
    const BURST = 40;
    const MAX_LINES = 1_000_000;
    const chunk = `${`${text}\n`.repeat(BURST)}`;

    let written = 0;
    while (!aborted(ctx.signal) && written < MAX_LINES) {
      ctx.term.write(chunk);
      written += BURST;
      await wait(60, ctx.signal);
    }

    return { stdout: '', stderr: '', code: aborted(ctx.signal) ? 130 : 0 };
  },
};

/* ================================================================== *
 * bc — tokenizer + precedence-climbing parser (no eval)
 * ================================================================== */

/** A bc value: a magnitude plus the number of decimal places it carries. */
function num(value, scale) {
  return { n: value, s: Math.max(0, Math.min(60, Math.trunc(scale))) };
}

/** Truncate towards zero to `scale` decimals, guarding float noise. */
function truncate(value, scale) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** Math.max(0, Math.min(15, scale));
  const scaled = value * factor;
  const guarded = scaled >= 0 ? scaled + 1e-9 : scaled - 1e-9;
  return Math.trunc(guarded) / factor;
}

/** Render a bc value the way bc prints it (no leading zero, fixed scale). */
function formatBc(value) {
  const scale = Math.max(0, Math.min(20, value.s));
  const truncated = truncate(value.n, scale);
  /* bc normalises a zero result to a plain "0" whatever the scale is. */
  if (truncated === 0) return '0';
  const negative = truncated < 0;
  let text = Math.abs(truncated).toFixed(scale);
  if (text.startsWith('0.')) text = text.slice(1);
  return `${negative && Number(text.replace(/^\./, '0.')) !== 0 ? '-' : ''}${text}`;
}

class BcError extends Error {}

/**
 * Split a bc program into tokens.
 * @param {string} source
 * @returns {Array<{t:string, v:string, line:number}>}
 */
function bcTokenize(source) {
  const tokens = [];
  const text = String(source);
  let i = 0;
  let line = 1;

  const OPERATORS = [
    '&&', '||', '<=', '>=', '==', '!=', '++', '--',
    '+=', '-=', '*=', '/=', '%=', '^=',
    '+', '-', '*', '/', '%', '^', '(', ')', '<', '>', '=', '!', ',', ';',
  ];

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\n') { tokens.push({ t: 'eol', v: '\n', line }); line += 1; i += 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
    if (ch === '\\' && text[i + 1] === '\n') { i += 2; line += 1; continue; }
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j += 1;
      if (text[j] === '.') {
        j += 1;
        while (j < text.length && /[0-9]/.test(text[j])) j += 1;
      }
      const raw = text.slice(i, j);
      if (raw === '.') throw new BcError(String(line));
      tokens.push({ t: 'num', v: raw, line });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      tokens.push({ t: 'ident', v: text.slice(i, j), line });
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += 1;
      tokens.push({ t: 'str', v: text.slice(i + 1, j), line });
      i = j + 1;
      continue;
    }

    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) { tokens.push({ t: 'op', v: op, line }); i += op.length; continue; }

    throw new BcError(String(line));
  }

  tokens.push({ t: 'eof', v: '', line });
  return tokens;
}

/**
 * Evaluate a bc program.
 * @param {string} source
 * @param {{mathlib?:boolean}} [opts]
 * @returns {{out:string[], err:string[], code:number}}
 */
function bcRun(source, opts = {}) {
  const out = [];
  const err = [];
  const vars = new Map([
    ['scale', num(opts.mathlib ? 20 : 0, 0)],
    ['ibase', num(10, 0)],
    ['obase', num(10, 0)],
    ['last', num(0, 0)],
  ]);

  let tokens;
  try {
    tokens = bcTokenize(source);
  } catch (e) {
    err.push(`(standard_in) ${e.message}: syntax error`);
    return { out, err, code: 1 };
  }

  let pos = 0;
  const peek = () => tokens[pos];
  const at = (t, v) => tokens[pos].t === t && (v === undefined || tokens[pos].v === v);
  const next = () => tokens[pos++];
  const expect = (t, v) => {
    if (!at(t, v)) throw new BcError(String(tokens[pos].line));
    return next();
  };

  const scaleOf = () => Math.trunc(vars.get('scale').n);

  /* --- arithmetic ------------------------------------------------- */

  const addSub = (a, b, sign) => num(a.n + sign * b.n, Math.max(a.s, b.s));
  const mul = (a, b) => num(a.n * b.n, Math.min(a.s + b.s, Math.max(scaleOf(), a.s, b.s)));
  const div = (a, b) => {
    if (b.n === 0) throw new BcError('DIVZERO');
    const scale = scaleOf();
    return num(truncate(a.n / b.n, scale), scale);
  };
  const mod = (a, b) => {
    if (b.n === 0) throw new BcError('DIVZERO');
    const scale = scaleOf();
    const quotient = truncate(a.n / b.n, scale);
    return num(a.n - quotient * b.n, Math.max(a.s, b.s + scale));
  };
  const pow = (a, b) => {
    const exponent = Math.trunc(b.n);
    if (exponent >= 0) {
      return num(a.n ** exponent, Math.min(a.s * exponent, Math.max(scaleOf(), a.s)));
    }
    if (a.n === 0) throw new BcError('DIVZERO');
    const scale = scaleOf();
    return num(truncate(a.n ** exponent, scale), scale);
  };

  /* --- functions --------------------------------------------------- */

  const call = (name, args) => {
    const scale = scaleOf();
    const first = args[0] || num(0, 0);
    switch (name) {
      case 'sqrt':
        if (first.n < 0) throw new BcError('SQRTNEG');
        return num(truncate(Math.sqrt(first.n), Math.max(scale, first.s)), Math.max(scale, first.s));
      case 'length': {
        const digits = formatBc(first).replace(/[-.]/g, '');
        return num(Math.max(1, digits.replace(/^0+(?=\d)/, '').length), 0);
      }
      case 'scale':
        return num(first.s, 0);
      case 's': return num(truncate(Math.sin(first.n), scale), scale);
      case 'c': return num(truncate(Math.cos(first.n), scale), scale);
      case 'a': return num(truncate(Math.atan(first.n), scale), scale);
      case 'l':
        if (first.n <= 0) throw new BcError('LOGDOMAIN');
        return num(truncate(Math.log(first.n), scale), scale);
      case 'e': return num(truncate(Math.exp(first.n), scale), scale);
      default:
        throw new BcError(String(tokens[pos].line));
    }
  };

  /* --- grammar ----------------------------------------------------- */

  const parseExpr = () => parseOr();

  const parseOr = () => {
    let left = parseAnd();
    while (at('op', '||')) { next(); const right = parseAnd(); left = num(left.n !== 0 || right.n !== 0 ? 1 : 0, 0); }
    return left;
  };

  const parseAnd = () => {
    let left = parseNot();
    while (at('op', '&&')) { next(); const right = parseNot(); left = num(left.n !== 0 && right.n !== 0 ? 1 : 0, 0); }
    return left;
  };

  const parseNot = () => {
    if (at('op', '!')) { next(); const value = parseNot(); return num(value.n === 0 ? 1 : 0, 0); }
    return parseRelational();
  };

  const parseRelational = () => {
    const left = parseAdditive();
    for (const op of ['<=', '>=', '==', '!=', '<', '>']) {
      if (at('op', op)) {
        next();
        const right = parseAdditive();
        const a = truncate(left.n, 20);
        const b = truncate(right.n, 20);
        const result = op === '<' ? a < b : op === '>' ? a > b
          : op === '<=' ? a <= b : op === '>=' ? a >= b
            : op === '==' ? a === b : a !== b;
        return num(result ? 1 : 0, 0);
      }
    }
    return left;
  };

  const parseAdditive = () => {
    let left = parseMultiplicative();
    for (;;) {
      if (at('op', '+')) { next(); left = addSub(left, parseMultiplicative(), 1); continue; }
      if (at('op', '-')) { next(); left = addSub(left, parseMultiplicative(), -1); continue; }
      return left;
    }
  };

  const parseMultiplicative = () => {
    let left = parseUnary();
    for (;;) {
      if (at('op', '*')) { next(); left = mul(left, parseUnary()); continue; }
      if (at('op', '/')) { next(); left = div(left, parseUnary()); continue; }
      if (at('op', '%')) { next(); left = mod(left, parseUnary()); continue; }
      return left;
    }
  };

  const parseUnary = () => {
    if (at('op', '-')) { next(); const value = parseUnary(); return num(-value.n, value.s); }
    if (at('op', '+')) { next(); return parseUnary(); }
    return parsePower();
  };

  const parsePower = () => {
    const base = parsePrimary();
    if (at('op', '^')) { next(); return pow(base, parseUnary()); }
    return base;
  };

  const parsePrimary = () => {
    if (at('op', '(')) {
      next();
      const value = parseExpr();
      expect('op', ')');
      return value;
    }
    if (at('op', '++') || at('op', '--')) {
      const op = next().v;
      const name = expect('ident').v;
      const current = vars.get(name) || num(0, 0);
      const updated = num(current.n + (op === '++' ? 1 : -1), current.s);
      vars.set(name, updated);
      return updated;
    }
    if (at('num')) {
      const token = next();
      return num(Number(token.v), decimals(token.v));
    }
    if (at('ident')) {
      const name = next().v;
      if (at('op', '(')) {
        next();
        const args = [];
        if (!at('op', ')')) {
          args.push(parseExpr());
          while (at('op', ',')) { next(); args.push(parseExpr()); }
        }
        expect('op', ')');
        return call(name, args);
      }
      if (at('op', '++') || at('op', '--')) {
        const op = next().v;
        const current = vars.get(name) || num(0, 0);
        vars.set(name, num(current.n + (op === '++' ? 1 : -1), current.s));
        return current;
      }
      return vars.get(name) || num(0, 0);
    }
    throw new BcError(String(tokens[pos].line));
  };

  /* --- statements --------------------------------------------------- */

  const skipTerminators = () => {
    while (at('eol') || at('op', ';')) next();
  };

  try {
    for (;;) {
      skipTerminators();
      if (at('eof')) break;

      if (at('ident')) {
        const name = peek().v;
        if (name === 'quit' || name === 'halt') break;
        if (name === 'print') {
          next();
          const parts = [];
          for (;;) {
            if (at('str')) parts.push(next().v);
            else parts.push(formatBc(parseExpr()));
            if (at('op', ',')) { next(); continue; }
            break;
          }
          out.push(parts.join(''));
          continue;
        }
        /* assignment? */
        const save = pos;
        next();
        const assignOps = ['=', '+=', '-=', '*=', '/=', '%=', '^='];
        const found = assignOps.find((o) => at('op', o));
        if (found && !(found === '=' && at('op', '=='))) {
          next();
          const value = parseExpr();
          const current = vars.get(name) || num(0, 0);
          const updated = found === '=' ? value
            : found === '+=' ? addSub(current, value, 1)
              : found === '-=' ? addSub(current, value, -1)
                : found === '*=' ? mul(current, value)
                  : found === '/=' ? div(current, value)
                    : found === '%=' ? mod(current, value)
                      : pow(current, value);
          vars.set(name, name === 'scale' ? num(Math.trunc(updated.n), 0) : updated);
          continue;
        }
        pos = save;
      }

      if (at('str')) { out.push(next().v); continue; }

      const value = parseExpr();
      vars.set('last', value);
      out.push(formatBc(value));
    }
  } catch (e) {
    if (e instanceof BcError) {
      if (e.message === 'DIVZERO') {
        err.push('Runtime error (func=(main), adr=1): Divide by zero');
      } else if (e.message === 'SQRTNEG') {
        err.push('Runtime error (func=(main), adr=1): Square root of a negative number');
      } else if (e.message === 'LOGDOMAIN') {
        err.push('Runtime error (func=(main), adr=1): Argument to natural log is not positive');
      } else {
        err.push(`(standard_in) ${e.message}: syntax error`);
      }
      return { out, err, code: 1 };
    }
    throw e;
  }

  return { out, err, code: 0 };
}

const bcCommand = {
  name: 'bc',
  aliases: [],
  synopsis: 'bc [-l] [-q] [-e EXPRESSION] [FILE]...',
  description: 'An arbitrary precision calculator language',
  man: `NAME
       bc - An arbitrary precision calculator language

SYNOPSIS
       bc [-hlqsvw] [-e expression] [file ...]

DESCRIPTION
       bc is a language that supports arbitrary precision numbers with
       interactive execution of statements.

       The expression is parsed by a real tokenizer and a precedence-climbing
       parser: no JavaScript eval is involved anywhere.

SUPPORTED SYNTAX
       Operators   + - * / % ^ ( ) with unary minus. ^ is right-associative and
                   binds tighter than unary minus, so -2^2 is -4.
       Comparison  < <= > >= == != and the logical ! && ||, all yielding 1 or 0.
       Assignment  name = expr, and the compound forms += -= *= /= %= ^=.
       Variables   Any identifier. The special variable 'scale' sets the number
                   of digits kept after the decimal point in a division.
       Functions   sqrt(x), length(x), scale(x); with -l also s(x) c(x) a(x)
                   l(x) e(x).
       Comments    /* … */ and # to end of line.
       Statements  Separated by newlines or semicolons. quit and halt stop.

OPTIONS
       -e, --expression EXPR
              Evaluate EXPR. May be repeated.

       -l, --mathlib
              Load the math library; sets the default scale to 20.

       -q, --quiet
              Do not print the welcome banner.

EXAMPLES
       echo '2 + 2' | bc
       bc -e 'scale=4; 22/7'
       echo 'scale=10; sqrt(2)' | bc`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let mathlib = false;
    const pieces = [];
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-l' || a === '--mathlib') { mathlib = true; continue; }
      if (a === '-q' || a === '--quiet' || a === '-s' || a === '--standard' || a === '-w' || a === '--warn') continue;
      if (a === '-e' || a === '--expression') { pieces.push(argv[++i] ?? ''); continue; }
      if (a.startsWith('--expression=')) { pieces.push(a.slice(13)); continue; }
      if (a === '-v' || a === '--version') return ok('bc 1.07.1\nCopyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.\n');
      if (a === '-h' || a === '--help') return ok('usage: bc [options] [file ...]\n  -e  --expression=<expression>\n  -l  --mathlib\n  -q  --quiet\n');
      operands.push(a);
    }

    for (const name of operands) {
      const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(name, env.home));
      try {
        pieces.push(fs.readFile(target));
      } catch {
        /* Not a file: bc would refuse, but an inline expression is far more
           useful in a terminal that has no here-strings. */
        pieces.push(name);
      }
    }

    if (ctx.stdin && ctx.stdin.trim() !== '') pieces.push(ctx.stdin);

    const program = pieces.join('\n').trim();
    if (program === '') return ok('');

    const { out, err, code } = bcRun(program, { mathlib });
    return {
      stdout: out.length ? `${out.join('\n')}\n` : '',
      stderr: err.length ? `${err.join('\n')}\n` : '',
      code,
    };
  },
};

/* ================================================================== *
 * md5sum / sha256sum
 * ================================================================== */

/** Per-round left-rotation amounts for MD5. */
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32) */
const MD5_K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) {
    table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return table;
})();

/** Little-endian hex of one 32-bit word. */
function wordHex(word) {
  let text = '';
  for (let i = 0; i < 4; i += 1) text += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  return text;
}

/**
 * RFC 1321 MD5, in plain JavaScript, correct for arbitrary byte input.
 * @param {Uint8Array} bytes
 * @returns {string} 32 lowercase hex characters
 */
export function md5(bytes) {
  const length = bytes.length;
  const blocks = Math.floor((length + 8) / 64) + 1;
  const total = blocks * 64;
  const message = new Uint8Array(total);
  message.set(bytes);
  message[length] = 0x80;

  const view = new DataView(message.buffer);
  view.setUint32(total - 8, (length * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor(length / 536870912) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) M[i] = view.getUint32(offset + i * 4, true);

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i += 1) {
      let F;
      let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }

      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      const shift = MD5_SHIFTS[i];
      B = (B + (((F << shift) | (F >>> (32 - shift))) >>> 0)) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return `${wordHex(a0)}${wordHex(b0)}${wordHex(c0)}${wordHex(d0)}`;
}

/**
 * SHA-256 through the Web Crypto API.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('crypto.subtle is unavailable (a secure context is required)');
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ENCODER = new TextEncoder();

/**
 * Build the md5sum / sha256sum command object.
 * @param {string} name
 * @param {(bytes: Uint8Array) => Promise<string>|string} digest
 * @param {number} hexLength
 * @returns {object}
 */
function checksumCommand(name, digest, hexLength) {
  const algorithm = name === 'md5sum' ? 'MD5' : 'SHA256';
  return {
    name,
    aliases: [],
    synopsis: `${name} [-c] [--tag] [FILE]...`,
    description: `Compute and check ${algorithm} message digests`,
    man: `NAME
       ${name} - compute and check ${algorithm} message digest

SYNOPSIS
       ${name} [OPTION]... [FILE]...

DESCRIPTION
       Print or check ${algorithm} checksums. With no FILE, or when FILE is -,
       read standard input.

       ${name === 'md5sum'
    ? 'The digest is produced by a complete RFC 1321 MD5 implementation in\n       plain JavaScript.'
    : 'The digest is produced by crypto.subtle.digest(\'SHA-256\', …), which\n       requires a secure context (https or localhost).'}

OPTIONS
       -c, --check
              Read checksums from the FILEs and check them.

       --quiet
              Do not print OK for each successfully verified file.

       --status
              Do not output anything; the exit status shows success.

       --tag  Create a BSD-style checksum.

EXIT STATUS
       0 when every checksum matched, 1 otherwise.`,
    async run(ctx) {
      const argv = ctx.argv.slice();
      let check = false;
      let quiet = false;
      let status = false;
      let tag = false;
      const operands = [];

      for (const a of argv) {
        if (a === '-c' || a === '--check') { check = true; continue; }
        if (a === '--quiet') { quiet = true; continue; }
        if (a === '--status') { status = true; continue; }
        if (a === '--tag') { tag = true; continue; }
        if (a === '-b' || a === '--binary' || a === '-t' || a === '--text' || a === '-z' || a === '--zero') continue;
        if (a === '--help') return ok(`Usage: ${name} [OPTION]... [FILE]...\nPrint or check ${algorithm} (${hexLength / 2}-bit) checksums.\n`);
        if (a === '--version') return ok(`${name} (GNU coreutils) 9.4\n`);
        if (a.startsWith('-') && a !== '-') continue;
        operands.push(a);
      }

      const readBytes = (file) => {
        if (file === '-') return ENCODER.encode(ctx.stdin || '');
        const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(file, env.home));
        if (fs.isDir(target)) throw new Error('Is a directory');
        return ENCODER.encode(fs.readFile(target));
      };

      /* --- verification mode ------------------------------------- */
      if (check) {
        const sources = operands.length > 0 ? operands : ['-'];
        const lines = [];
        for (const source of sources) {
          try {
            const text = source === '-' ? (ctx.stdin || '') : fs.readFile(ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(source, env.home)));
            lines.push(...text.split('\n'));
          } catch {
            return fail(`${name}: ${source}: No such file or directory\n`, 1);
          }
        }

        const out = [];
        const errors = [];
        let failures = 0;
        let unreadable = 0;
        let checked = 0;

        for (const raw of lines) {
          const line = raw.trim();
          if (line === '') continue;
          const m = new RegExp(`^([0-9a-fA-F]{${hexLength}})\\s+[*]?(.+)$`).exec(line);
          if (!m) {
            errors.push(`${name}: ${source_label(sources)}: improperly formatted ${algorithm} checksum line`);
            continue;
          }
          checked += 1;
          const [, expected, file] = m;
          let actual;
          try {
            actual = await digest(readBytes(file));
          } catch {
            errors.push(`${name}: ${file}: No such file or directory`);
            out.push(`${file}: FAILED open or read`);
            unreadable += 1;
            continue;
          }
          if (actual.toLowerCase() === expected.toLowerCase()) {
            if (!quiet) out.push(`${file}: OK`);
          } else {
            out.push(`${file}: FAILED`);
            failures += 1;
          }
        }

        if (failures > 0) {
          errors.push(`${name}: WARNING: ${failures} computed checksum${failures === 1 ? '' : 's'} did NOT match`);
        }
        if (unreadable > 0) {
          errors.push(`${name}: WARNING: ${unreadable} listed file${unreadable === 1 ? '' : 's'} could not be read`);
        }
        if (checked === 0 && errors.length === 0) {
          errors.push(`${name}: no properly formatted checksum lines found`);
        }

        return {
          stdout: status ? '' : (out.length ? `${out.join('\n')}\n` : ''),
          stderr: status ? '' : (errors.length ? `${errors.join('\n')}\n` : ''),
          code: failures + unreadable > 0 || checked === 0 ? 1 : 0,
        };
      }

      /* --- digest mode -------------------------------------------- */
      const files = operands.length > 0 ? operands : ['-'];
      const out = [];
      const errors = [];
      let code = 0;

      for (const file of files) {
        let hex;
        try {
          hex = await digest(readBytes(file));
        } catch (e) {
          const message = e && e.message === 'Is a directory' ? 'Is a directory' : 'No such file or directory';
          errors.push(`${name}: ${file}: ${message}`);
          code = 1;
          continue;
        }
        out.push(tag ? `${algorithm} (${file}) = ${hex}` : `${hex}  ${file}`);
      }

      return {
        stdout: out.length ? `${out.join('\n')}\n` : '',
        stderr: errors.length ? `${errors.join('\n')}\n` : '',
        code,
      };
    },
  };
}

/** The name a malformed -c line is attributed to. */
function source_label(sources) {
  return sources[0] === '-' ? 'standard input' : sources[0];
}

const md5sumCommand = checksumCommand('md5sum', (bytes) => md5(bytes), 32);
const sha256sumCommand = checksumCommand('sha256sum', (bytes) => sha256(bytes), 64);

/* ================================================================== *
 * base64
 * ================================================================== */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode bytes to base64 without relying on btoa's Latin-1 restriction.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 63];
  }
  return out;
}

/**
 * Decode base64 to bytes.
 * @param {string} text
 * @returns {Uint8Array|null} null when the input is not valid base64
 */
export function base64Decode(text) {
  const clean = String(text).replace(/[\r\n\t ]/g, '');
  const body = clean.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(body)) return null;
  if (clean.length % 4 !== 0 && body.length % 4 === 1) return null;

  const bytes = new Uint8Array(Math.floor((body.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const ch of body) {
    accumulator = (accumulator << 6) | B64_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (accumulator >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes.subarray(0, index);
}

const base64Command = {
  name: 'base64',
  aliases: [],
  synopsis: 'base64 [-d] [-w COLS] [FILE]',
  description: 'Base64 encode/decode data and print to standard output',
  man: `NAME
       base64 - base64 encode/decode data and print to standard output

SYNOPSIS
       base64 [OPTION]... [FILE]

DESCRIPTION
       Base64 encode or decode FILE, or standard input, to standard output.

       Input is encoded to UTF-8 bytes before it is base64 encoded, so
       non-Latin-1 text round-trips correctly.

OPTIONS
       -d, --decode
              Decode data.

       -i, --ignore-garbage
              When decoding, ignore non-alphabet characters.

       -w, --wrap=COLS
              Wrap encoded lines after COLS characters (default 76). Use 0 to
              disable line wrapping.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let decode = false;
    let wrapAt = 76;
    let ignoreGarbage = false;
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-d' || a === '--decode') { decode = true; continue; }
      if (a === '-i' || a === '--ignore-garbage') { ignoreGarbage = true; continue; }
      if (a === '-w' || a === '--wrap') { wrapAt = Number(argv[++i]); continue; }
      if (a.startsWith('--wrap=')) { wrapAt = Number(a.slice(7)); continue; }
      if (a === '--help') return ok('Usage: base64 [OPTION]... [FILE]\nBase64 encode or decode FILE, or standard input, to standard output.\n');
      if (a === '--version') return ok('base64 (GNU coreutils) 9.4\n');
      if (a.startsWith('-') && a !== '-') continue;
      operands.push(a);
    }

    if (!Number.isFinite(wrapAt) || wrapAt < 0) {
      return fail(`base64: invalid wrap size: ‘${wrapAt}’\n`, 1);
    }

    let text;
    if (operands.length === 0 || operands[0] === '-') {
      text = ctx.stdin || '';
    } else {
      const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(operands[0], env.home));
      try {
        if (fs.isDir(target)) return fail(`base64: read error: Is a directory\n`, 1);
        text = fs.readFile(target);
      } catch {
        return fail(`base64: ${operands[0]}: No such file or directory\n`, 1);
      }
    }

    if (decode) {
      const source = ignoreGarbage ? text.replace(/[^A-Za-z0-9+/=]/g, '') : text;
      const bytes = base64Decode(source);
      if (bytes === null) return fail('base64: invalid input\n', 1);
      return ok(new TextDecoder().decode(bytes));
    }

    const encoded = base64Encode(ENCODER.encode(text));
    if (wrapAt === 0) return ok(`${encoded}\n`);
    const lines = [];
    for (let i = 0; i < encoded.length; i += wrapAt) lines.push(encoded.slice(i, i + wrapAt));
    return ok(lines.length ? `${lines.join('\n')}\n` : '');
  },
};

/* ================================================================== *
 * xxd
 * ================================================================== */

const xxdCommand = {
  name: 'xxd',
  aliases: [],
  synopsis: 'xxd [-p] [-c COLS] [-g SIZE] [-l LEN] [-s OFF] [FILE]',
  description: 'Make a hexdump',
  man: `NAME
       xxd - make a hexdump or do the reverse

SYNOPSIS
       xxd [options] [infile]

DESCRIPTION
       xxd creates a hex dump of a given file or standard input.

       The default layout is an 8 digit offset, 16 bytes shown as eight
       space-separated two-byte groups, and the printable ASCII rendering of
       those bytes between two dots.

OPTIONS
       -c cols
              Format cols octets per line. Default 16.

       -g bytes
              Separate the output every bytes octets. Default 2.

       -l len
              Stop after writing len octets.

       -p     Output in plain hexdump style.

       -s off
              Start at off bytes into the file.

       -u     Use upper-case hex letters.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let columns = 16;
    let groupSize = 2;
    let plain = false;
    let upper = false;
    let limit = Infinity;
    let seek = 0;
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-c' || a === '--cols') { columns = Math.max(1, Number(argv[++i]) || 16); continue; }
      if (a === '-g' || a === '--groupsize') { groupSize = Math.max(0, Number(argv[++i]) || 0); continue; }
      if (a === '-l' || a === '--len') { limit = Math.max(0, Number(argv[++i]) || 0); continue; }
      if (a === '-s' || a === '--seek') { seek = Math.max(0, Number(argv[++i]) || 0); continue; }
      if (a === '-p' || a === '--ps' || a === '--postscript') { plain = true; continue; }
      if (a === '-u') { upper = true; continue; }
      if (a === '-h' || a === '--help') return ok('Usage:\n       xxd [options] [infile [outfile]]\n');
      if (a === '-v' || a === '--version') return ok('xxd 2021-10-22 by Juergen Weigert et al.\n');
      if (a.startsWith('-') && a !== '-') continue;
      operands.push(a);
    }

    let text;
    if (operands.length === 0 || operands[0] === '-') {
      text = ctx.stdin || '';
    } else {
      const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(operands[0], env.home));
      try {
        if (fs.isDir(target)) return fail(`xxd: ${operands[0]}: Is a directory\n`, 1);
        text = fs.readFile(target);
      } catch {
        return fail(`xxd: ${operands[0]}: No such file or directory\n`, 1);
      }
    }

    let bytes = ENCODER.encode(text);
    if (seek > 0) bytes = bytes.subarray(Math.min(seek, bytes.length));
    if (Number.isFinite(limit)) bytes = bytes.subarray(0, limit);

    const hex = (b) => {
      const t = b.toString(16).padStart(2, '0');
      return upper ? t.toUpperCase() : t;
    };

    if (plain) {
      const perLine = columns === 16 ? 30 : columns;
      const chars = Array.from(bytes).map(hex).join('');
      const lines = [];
      for (let i = 0; i < chars.length; i += perLine * 2) lines.push(chars.slice(i, i + perLine * 2));
      return ok(lines.length ? `${lines.join('\n')}\n` : '');
    }

    const groups = groupSize > 0 ? groupSize : columns;
    /* Width of the hex column when a line is full. */
    const hexWidth = columns * 2 + (groups > 0 ? Math.ceil(columns / groups) - 1 : 0);

    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += columns) {
      const slice = bytes.subarray(offset, offset + columns);
      let hexPart = '';
      for (let i = 0; i < slice.length; i += 1) {
        if (i > 0 && groups > 0 && i % groups === 0) hexPart += ' ';
        hexPart += hex(slice[i]);
      }
      let ascii = '';
      for (const b of slice) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      lines.push(`${(seek + offset).toString(16).padStart(8, '0')}: ${hexPart.padEnd(hexWidth)}  ${ascii}`);
    }

    return ok(lines.length ? `${lines.join('\n')}\n` : '');
  },
};

/* ================================================================== *
 * watch / time
 * ================================================================== */

/** `Mon Aug 18 09:14:22 2026` — the ctime(3) rendering watch puts on the right. */
function ctimeStamp(d) {
  return `${DAYS_SHORT[d.getDay()]} ${MONTHS_SHORT[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} `
    + `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())} ${d.getFullYear()}`;
}

const watchCommand = {
  name: 'watch',
  aliases: [],
  synopsis: 'watch [-n SECONDS] [-t] COMMAND',
  description: 'Execute a program periodically, showing output fullscreen',
  man: `NAME
       watch - execute a program periodically, showing output fullscreen

SYNOPSIS
       watch [options] command

DESCRIPTION
       watch runs command repeatedly, displaying its output and errors. This
       allows you to watch the program output change over time. By default the
       program is run every 2 seconds.

       The command is executed through this terminal's own shell, so pipelines,
       redirection and aliases all work.

       Press Ctrl+C to stop.

OPTIONS
       -n, --interval SECONDS
              Specify update interval. Fractions are allowed; the minimum is
              0.1 seconds.

       -t, --no-title
              Turn off the header showing the interval, command and current
              time at the top of the display.

       -x, --exec
              Accepted for compatibility; the command is always run through the
              shell here.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let interval = 2;
    let title = true;
    const words = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (words.length > 0) { words.push(a); continue; }
      if (a === '-n' || a === '--interval') { interval = Number(argv[++i]); continue; }
      if (a.startsWith('--interval=')) { interval = Number(a.slice(11)); continue; }
      if (a.startsWith('-n') && a.length > 2) { interval = Number(a.slice(2)); continue; }
      if (a === '-t' || a === '--no-title') { title = false; continue; }
      if (a === '-x' || a === '--exec' || a === '-d' || a === '--differences' || a === '-b' || a === '--beep' || a === '-g' || a === '--chgexit' || a === '-e' || a === '--errexit') continue;
      if (a === '-h' || a === '--help') return ok('Usage:\n watch [options] command\n\nOptions:\n  -n, --interval <secs>  seconds to wait between updates\n  -t, --no-title         turn off header\n');
      if (a === '-v' || a === '--version') return ok('watch from procps-ng 4.0.4\n');
      if (a.startsWith('-')) continue;
      words.push(a);
    }

    if (!Number.isFinite(interval) || interval <= 0) {
      return fail('watch: failed to parse argument: invalid interval\n', 1);
    }
    interval = Math.max(0.1, interval);

    const command = words.join(' ').trim();
    if (command === '') {
      return fail('watch: no command specified\nUsage:\n watch [options] command\n', 1);
    }

    const cols = termCols(ctx);
    const host = env.host || users.hostname;

    while (!aborted(ctx.signal)) {
      let result;
      try {
        result = await execute(command, {
          session: ctx.session,
          term: ctx.term,
          signal: ctx.signal,
          capture: true,
          depth: 1,
        });
      } catch (e) {
        result = { stdout: '', stderr: `${e && e.message ? e.message : 'error'}\n`, code: 1 };
      }
      if (aborted(ctx.signal)) break;

      ctx.term.clear();
      if (title) {
        const left = `Every ${interval.toFixed(1)}s: ${command}`;
        const right = `${host}: ${ctimeStamp(new Date())}`;
        const gap = Math.max(1, cols - left.length - right.length);
        const header = left.length + right.length + 1 > cols
          ? `${left.slice(0, Math.max(0, cols - right.length - 1))} ${right}`
          : `${left}${' '.repeat(gap)}${right}`;
        ctx.term.write(`${header}\n\n`);
      }
      ctx.term.write(result.stdout || '');
      if (result.stderr) ctx.term.write(result.stderr);

      await wait(interval * 1000, ctx.signal);
    }

    ctx.term.clear();
    return { stdout: '', stderr: '', code: aborted(ctx.signal) ? 130 : 0 };
  },
};

/** `0m1.234s` — the shell's time format. */
function timeSpan(ms) {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  return `${minutes}m${(total - minutes * 60).toFixed(3)}s`;
}

const timeCommand = {
  name: 'time',
  aliases: [],
  synopsis: 'time COMMAND [ARG]...',
  description: 'Time a simple command',
  man: `NAME
       time - time a simple command

SYNOPSIS
       time COMMAND [ARGUMENTS]...

DESCRIPTION
       Run COMMAND and, when it finishes, write the elapsed real time, the
       user CPU time and the system CPU time to standard error in the format
       bash's time keyword uses.

       The command runs through this terminal's own shell, so pipelines and
       redirection work.

EXIT STATUS
       time exits with the status of COMMAND.`,
  async run(ctx) {
    const command = ctx.argv.join(' ').trim();
    if (command === '') {
      return fail('time: usage: time COMMAND [ARG]...\n', 2);
    }

    const started = performance.now();
    let result;
    try {
      result = await execute(command, {
        session: ctx.session,
        term: ctx.term,
        signal: ctx.signal,
        capture: false,
        depth: 1,
      });
    } catch (e) {
      result = { stdout: '', stderr: '', code: 1 };
    }
    const elapsed = performance.now() - started;

    /* A simulated split: the emulator has no kernel to charge time to. */
    const user = elapsed * 0.62;
    const sys = elapsed * 0.18;

    return {
      stdout: '',
      stderr: `\nreal\t${timeSpan(elapsed)}\nuser\t${timeSpan(user)}\nsys\t${timeSpan(sys)}\n`,
      code: result && typeof result.code === 'number' ? result.code : 0,
    };
  },
};

/* ================================================================== *
 * Desktop launchers
 * ================================================================== */

/** Extension -> desktop app id, for xdg-open. */
const OPEN_WITH = {
  js: 'codeoss', mjs: 'codeoss', cjs: 'codeoss', ts: 'codeoss', tsx: 'codeoss', jsx: 'codeoss',
  py: 'codeoss', rb: 'codeoss', go: 'codeoss', rs: 'codeoss', java: 'codeoss', kt: 'codeoss',
  c: 'codeoss', h: 'codeoss', cpp: 'codeoss', hpp: 'codeoss', cc: 'codeoss', cs: 'codeoss',
  sh: 'codeoss', bash: 'codeoss', zsh: 'codeoss', php: 'codeoss', pl: 'codeoss', lua: 'codeoss',
  json: 'codeoss', yaml: 'codeoss', yml: 'codeoss', toml: 'codeoss', css: 'codeoss', scss: 'codeoss',
  sql: 'codeoss', vue: 'codeoss', svelte: 'codeoss',
  html: 'firefox', htm: 'firefox', xhtml: 'firefox', pdf: 'firefox',
  txt: 'editor', md: 'editor', markdown: 'editor', log: 'editor', conf: 'editor',
  cfg: 'editor', ini: 'editor', csv: 'editor', xml: 'editor', desktop: 'editor',
  png: 'imageviewer', jpg: 'imageviewer', jpeg: 'imageviewer', jpe: 'imageviewer',
  gif: 'imageviewer', webp: 'imageviewer', svg: 'imageviewer', svgz: 'imageviewer',
  bmp: 'imageviewer', ico: 'imageviewer', avif: 'imageviewer', tif: 'imageviewer',
  tiff: 'imageviewer',
  mp3: 'files', mp4: 'files', ogg: 'files', wav: 'files', zip: 'files', tar: 'files',
  gz: 'files', iso: 'files', deb: 'files',
};

/**
 * Resolve a launcher argument, creating an empty file when it does not exist.
 * @param {object} ctx
 * @param {string} name command name, for error phrasing
 * @param {string} spec the path the user typed
 * @param {boolean} create
 * @returns {{path:string}|{error:object}}
 */
function preparePath(ctx, name, spec, create) {
  const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec, env.home));
  if (fs.exists(target)) return { path: target };
  if (!create) {
    return { error: fail(`${name}: ${spec}: No such file or directory\n`, 1) };
  }
  const parent = ctx.path.dirname(target);
  if (!fs.exists(parent)) {
    return { error: fail(`${name}: ${spec}: No such file or directory\n`, 1) };
  }
  try {
    fs.writeFile(target, '');
  } catch (e) {
    return { error: fail(`${name}: ${spec}: ${e && e.message ? e.message : 'cannot create file'}\n`, 1) };
  }
  return { path: target };
}

/**
 * Open a desktop app, reporting the failure the way a launcher would.
 * @param {string} name
 * @param {string} appId
 * @param {object} args
 * @returns {object} a command result
 */
function launch(name, appId, args) {
  const instance = wm.open(appId, args);
  if (!instance) {
    return fail(`${name}: no application registered to handle this request\n`, 3);
  }
  return ok('');
}

/**
 * Build an editor-style launcher.
 * @param {string} name
 * @param {string} appId
 * @param {string} description
 * @returns {object}
 */
function editorCommand(name, appId, description) {
  return {
    name,
    aliases: [],
    synopsis: `${name} [FILE]...`,
    description,
    man: `NAME
       ${name} - ${description}

SYNOPSIS
       ${name} [FILE]...

DESCRIPTION
       Opens FILE in the desktop's ${appId === 'codeoss' ? 'Code - OSS' : appId === 'files' ? 'Files' : 'Text Editor'}
       window. A file that does not exist yet is created empty first, so the
       editor always has something to open — which also means the new file is
       immediately visible to ls, find and the Files app.

       Like the real launchers this prints nothing when it succeeds. There is
       no in-terminal editing mode: this desktop puts the editor in a window.

EXIT STATUS
       0 the window was opened
       1 the path could not be created
       3 no application is registered for that window`,
    async run(ctx) {
      const operands = ctx.argv.filter((a) => !a.startsWith('-') || a === '-');
      if (ctx.argv.includes('--version')) {
        return ok(name === 'vim' || name === 'vi'
          ? 'VIM - Vi IMproved 9.1 (2024 Jan 02, compiled Aug 05 2024 12:00:00)\n'
          : `${name} (Ubuntu AI Desktop launcher)\n`);
      }
      if (ctx.argv.includes('--help')) {
        return ok(`Usage: ${name} [FILE]...\nOpens FILE in the desktop editor window.\n`);
      }

      if (operands.length === 0) {
        return launch(name, appId, {});
      }

      let last = null;
      for (const spec of operands) {
        const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec, env.home));
        if (fs.exists(target) && fs.isDir(target)) {
          return fail(`${name}: ${spec}: Is a directory\n`, 1);
        }
        const prepared = preparePath(ctx, name, spec, true);
        if (prepared.error) return prepared.error;
        last = prepared.path;
        const result = launch(name, appId, { path: prepared.path });
        if (result.code !== 0) return result;
      }
      return last === null ? launch(name, appId, {}) : ok('');
    },
  };
}

const nanoCommand = editorCommand('nano', 'editor', 'Open a file in the desktop Text Editor');
const vimCommand = editorCommand('vim', 'editor', 'Open a file in the desktop Text Editor');
const viCommand = editorCommand('vi', 'editor', 'Open a file in the desktop Text Editor');
const geditCommand = editorCommand('gedit', 'editor', 'Open a file in the desktop Text Editor');
const gnomeTextEditorCommand = editorCommand('gnome-text-editor', 'editor', 'Open a file in the desktop Text Editor');
const codeCommand = editorCommand('code', 'codeoss', 'Open a file or folder in Code - OSS');

const nautilusCommand = {
  name: 'nautilus',
  aliases: ['gnome-files'],
  synopsis: 'nautilus [DIRECTORY]',
  description: 'Open the Files browser',
  man: `NAME
       nautilus - the GNOME file manager

SYNOPSIS
       nautilus [OPTION...] [URI...]

DESCRIPTION
       Opens the Files window at DIRECTORY, or at the current working
       directory when none is given. Prints nothing on success.

OPTIONS
       -w, --new-window
              Open a new window. Accepted; every invocation opens a window
              here.`,
  async run(ctx) {
    const operands = ctx.argv.filter((a) => !a.startsWith('-'));
    const spec = operands[0] || '.';
    const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec, env.home));

    if (!fs.exists(target)) {
      return fail(`nautilus: ${spec}: No such file or directory\n`, 1);
    }
    const directory = fs.isDir(target) ? target : ctx.path.dirname(target);
    return launch('nautilus', 'files', { path: directory });
  },
};

const firefoxCommand = {
  name: 'firefox',
  aliases: [],
  synopsis: 'firefox [URL]',
  description: 'Open the Firefox browser',
  man: `NAME
       firefox - the Mozilla Firefox web browser

SYNOPSIS
       firefox [OPTION...] [URL]

DESCRIPTION
       Opens the desktop's simulated Firefox window, optionally at URL. Nothing
       is fetched from a real server: the browser in this desktop renders local
       and generated content only.

OPTIONS
       --new-tab URL, --new-window URL
              Accepted; both open the browser at URL.

       --search TERM
              Open the browser on a search for TERM.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let url = null;
    let search = null;

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--new-tab' || a === '--new-window' || a === '-new-tab' || a === '-new-window' || a === '--url') { url = argv[++i] || null; continue; }
      if (a === '--search') { search = argv[++i] || null; continue; }
      if (a === '--version' || a === '-v') return ok('Mozilla Firefox 129.0.2\n');
      if (a === '--help' || a === '-h') return ok('Usage: firefox [OPTIONS] [URL]\n');
      if (a.startsWith('-')) continue;
      if (url === null) url = a;
    }

    const args = {};
    if (search !== null) args.search = search;
    else if (url !== null) args.url = url;
    return launch('firefox', 'firefox', args);
  },
};

const xdgOpenCommand = {
  name: 'xdg-open',
  aliases: [],
  synopsis: 'xdg-open FILE|URL',
  description: 'Open a file or URL in the preferred application',
  man: `NAME
       xdg-open - opens a file or URL in the user's preferred application

SYNOPSIS
       xdg-open { file | URL }

DESCRIPTION
       xdg-open opens a file or URL in the user's preferred application.

       Dispatch in this desktop:
         http:// https:// ftp:// and .html .htm .pdf   Firefox
         directories                                    Files
         .png .jpg .gif .webp .svg .bmp .ico .avif      Image Viewer
         source and configuration files                 Code - OSS
         plain text, markdown, logs                     Text Editor
         everything else                                Files, at its folder

EXIT STATUS
       0  success
       1  error in command line syntax
       2  the file does not exist
       3  a required tool could not be found
       4  the action failed`,
  async run(ctx) {
    const operands = ctx.argv.filter((a) => !a.startsWith('-'));
    if (operands.length === 0) {
      return fail('xdg-open: no method available for opening nothing\nUsage: xdg-open { file | URL }\n', 1);
    }

    const spec = operands[0];

    if (/^(https?|ftp):\/\//i.test(spec) || /^www\./i.test(spec)) {
      return launch('xdg-open', 'firefox', { url: spec });
    }
    if (/^mailto:/i.test(spec)) {
      return fail(`xdg-open: no method available for opening '${spec}'\n`, 3);
    }

    const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec.replace(/^file:\/\//, ''), env.home));
    if (!fs.exists(target)) {
      return fail(`xdg-open: file '${spec}' does not exist\n`, 2);
    }
    if (fs.isDir(target)) {
      return launch('xdg-open', 'files', { path: target });
    }

    const extension = ctx.path.extname(target).replace(/^\./, '').toLowerCase();
    const appId = OPEN_WITH[extension] || 'editor';
    if (appId === 'files') {
      return launch('xdg-open', 'files', { path: ctx.path.dirname(target) });
    }
    if (appId === 'firefox') {
      return launch('xdg-open', 'firefox', { url: `file://${target}` });
    }
    return launch('xdg-open', appId, { path: target });
  },
};

/* ================================================================== *
 * cowsay
 * ================================================================== */

/** Preset faces, matching cowsay's single-letter mode flags. */
const COW_FACES = {
  b: { eyes: '==', tongue: '  ' },
  d: { eyes: 'xx', tongue: 'U ' },
  g: { eyes: '$$', tongue: '  ' },
  p: { eyes: '@@', tongue: '  ' },
  s: { eyes: '**', tongue: 'U ' },
  t: { eyes: '--', tongue: '  ' },
  w: { eyes: 'OO', tongue: '  ' },
  y: { eyes: '..', tongue: '  ' },
};

/**
 * Draw the speech balloon exactly the way cowsay does.
 * @param {string[]} lines already wrapped
 * @param {boolean} think
 * @returns {string[]}
 */
function balloon(lines, think) {
  const width = Math.max(...lines.map((l) => l.length), 0);
  const out = [` ${'_'.repeat(width + 2)}`];

  if (lines.length === 1) {
    out.push(think ? `( ${lines[0]} )` : `< ${lines[0]} >`);
  } else {
    lines.forEach((line, i) => {
      const padded = line.padEnd(width);
      if (think) { out.push(`( ${padded} )`); return; }
      if (i === 0) out.push(`/ ${padded} \\`);
      else if (i === lines.length - 1) out.push(`\\ ${padded} /`);
      else out.push(`| ${padded} |`);
    });
  }

  out.push(` ${'-'.repeat(width + 2)}`);
  return out;
}

/**
 * The default.cow template with the eyes, tongue and thought marker filled in.
 * @param {{eyes:string, tongue:string, thoughts:string}} face
 * @returns {string[]}
 */
function cowBody(face) {
  return [
    `        ${face.thoughts}   ^__^`,
    `         ${face.thoughts}  (${face.eyes})\\_______`,
    '            (__)\\       )\\/\\',
    `             ${face.tongue} ||----w |`,
    '                ||     ||',
  ];
}

/**
 * Build the cowsay / cowthink command.
 * @param {string} name
 * @param {boolean} think
 * @returns {object}
 */
function cowCommand(name, think) {
  return {
    name,
    aliases: [],
    synopsis: `${name} [-bdgpstwy] [-e EYES] [-T TONGUE] [-W COLUMN] [MESSAGE...]`,
    description: `Configurable speaking${think ? '/thinking' : ''} cow`,
    man: `NAME
       ${name} - configurable speaking${think ? '/thinking' : ''} cow

SYNOPSIS
       ${name} [-e eye_string] [-f cowfile] [-T tongue_string] [-W column]
              [-bdgpstwy] [message]

DESCRIPTION
       ${name} generates an ASCII picture of a cow ${think ? 'thinking' : 'saying'} something
       provided by the user. If run with no arguments, it accepts standard
       input, word-wraps the message at 40 columns and prints the cow ${think ? 'thinking' : 'saying'} it.

OPTIONS
       -e eye_string   The eyes. Only the first two characters are used.
       -T tongue_string
                       The tongue. Only the first two characters are used.
       -W column       Wrap the message at column instead of 40.
       -n              Do not word-wrap the message at all.

MODES
       -b borg   -d dead   -g greedy   -p paranoid
       -s stoned -t tired  -w wired    -y youthful`,
    async run(ctx) {
      const argv = ctx.argv.slice();
      let eyes = 'oo';
      let tongue = '  ';
      let width = 40;
      let noWrap = false;
      const words = [];

      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (words.length > 0) { words.push(a); continue; }
        if (a === '-e') { eyes = String(argv[++i] || 'oo').slice(0, 2).padEnd(2); continue; }
        if (a === '-T') { tongue = String(argv[++i] || '  ').slice(0, 2).padEnd(2); continue; }
        if (a === '-W') { width = Math.max(1, Number(argv[++i]) || 40); continue; }
        if (a === '-f') { i += 1; continue; }
        if (a === '-n') { noWrap = true; continue; }
        if (a === '-l' || a === '--list') return ok('Cow files in /usr/share/cowsay/cows:\ndefault\n');
        if (a === '-h' || a === '--help') return ok(`cow{say,think} version 3.7.0, (c) 1999 Tony Monroe\nUsage: ${name} [-bdgpstwy] [-h] [-e eyes] [-f cowfile]\n          [-l] [-n] [-T tongue] [-W wrapcolumn] [message]\n`);
        if (/^-[bdgpstwy]$/.test(a)) {
          const preset = COW_FACES[a[1]];
          eyes = preset.eyes;
          tongue = preset.tongue;
          continue;
        }
        if (a.startsWith('-') && a.length > 1) continue;
        words.push(a);
      }

      const message = words.length > 0 ? words.join(' ') : (ctx.stdin || '').replace(/\n+$/, '');
      if (message.trim() === '') {
        return ok(`${[...balloon([''], think), ...cowBody({ eyes, tongue, thoughts: think ? 'o' : '\\' })].join('\n')}\n`);
      }

      const lines = noWrap
        ? message.split('\n')
        : message.split('\n').flatMap((paragraph) => (paragraph === '' ? [''] : wrap(paragraph, width)));

      const art = [
        ...balloon(lines, think),
        ...cowBody({ eyes, tongue, thoughts: think ? 'o' : '\\' }),
      ];
      return ok(`${art.join('\n')}\n`);
    },
  };
}

const cowsayCommand = cowCommand('cowsay', false);
const cowthinkCommand = cowCommand('cowthink', true);

/* ================================================================== *
 * figlet / banner
 * ================================================================== */

/**
 * A five-row block font. Every glyph is an array of five equal-length rows.
 * Covers A-Z, 0-9, space and the punctuation a banner is likely to need.
 */
const BLOCK_FONT = {
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  B: ['#### ', '#   #', '#### ', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '###  ', '#    ', '#####'],
  F: ['#####', '#    ', '###  ', '#    ', '#    '],
  G: [' ####', '#    ', '#  ##', '#   #', ' ####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  I: ['###', ' # ', ' # ', ' # ', '###'],
  J: ['    #', '    #', '    #', '#   #', ' ### '],
  K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#### ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  X: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  Y: ['#   #', ' # # ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
  0: [' ### ', '#  ##', '# # #', '##  #', ' ### '],
  1: ['  #  ', ' ##  ', '  #  ', '  #  ', ' ### '],
  2: [' ### ', '#   #', '   # ', '  #  ', '#####'],
  3: ['#####', '   # ', '  ## ', '#   #', ' ### '],
  4: ['#   #', '#   #', '#####', '    #', '    #'],
  5: ['#####', '#    ', '#### ', '    #', '#### '],
  6: [' ### ', '#    ', '#### ', '#   #', ' ### '],
  7: ['#####', '    #', '   # ', '  #  ', '  #  '],
  8: [' ### ', '#   #', ' ### ', '#   #', ' ### '],
  9: [' ### ', '#   #', ' ####', '    #', ' ### '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
  '!': ['#', '#', '#', ' ', '#'],
  '"': ['# #', '# #', '   ', '   ', '   '],
  '#': [' # # ', '#####', ' # # ', '#####', ' # # '],
  $: ['  #  ', ' ####', '# #  ', '  ###', '  #  '],
  '%': ['#   #', '   # ', '  #  ', ' #   ', '#   #'],
  '&': [' ##  ', '#  # ', ' ##  ', '#  # ', ' ## #'],
  "'": ['#', '#', ' ', ' ', ' '],
  '(': [' #', '# ', '# ', '# ', ' #'],
  ')': ['# ', ' #', ' #', ' #', '# '],
  '*': ['     ', ' # # ', '  #  ', ' # # ', '     '],
  '+': ['     ', '  #  ', ' ### ', '  #  ', '     '],
  ',': [' ', ' ', ' ', '#', '#'],
  '-': ['     ', '     ', '#####', '     ', '     '],
  '.': [' ', ' ', ' ', ' ', '#'],
  '/': ['    #', '   # ', '  #  ', ' #   ', '#    '],
  ':': [' ', '#', ' ', '#', ' '],
  ';': [' ', '#', ' ', '#', '#'],
  '<': ['  #', ' # ', '#  ', ' # ', '  #'],
  '=': ['     ', '#####', '     ', '#####', '     '],
  '>': ['#  ', ' # ', '  #', ' # ', '#  '],
  '?': [' ### ', '#   #', '   # ', '     ', '  #  '],
  '@': [' ### ', '#   #', '# ###', '#    ', ' ### '],
  '[': ['##', '# ', '# ', '# ', '##'],
  '\\': ['#    ', ' #   ', '  #  ', '   # ', '    #'],
  ']': ['##', ' #', ' #', ' #', '##'],
  '^': ['  #  ', ' # # ', '     ', '     ', '     '],
  _: ['     ', '     ', '     ', '     ', '#####'],
  '`': ['# ', ' #', '  ', '  ', '  '],
  '{': [' ##', ' # ', '#  ', ' # ', ' ##'],
  '|': ['#', '#', '#', '#', '#'],
  '}': ['## ', ' # ', '  #', ' # ', '## '],
  '~': ['     ', ' ##  ', '#  ##', '     ', '     '],
};

/**
 * Render text in the block font.
 * @param {string} text
 * @param {{width?:number, align?:string, fill?:string}} [opts]
 * @returns {string}
 */
export function renderBlockFont(text, opts = {}) {
  const width = opts.width || 80;
  const fill = opts.fill || '#';
  const source = String(text).toUpperCase();

  const words = [];
  for (const ch of source) {
    words.push(BLOCK_FONT[ch] || BLOCK_FONT['?']);
  }

  /* Break into display lines that fit the requested width. */
  const displayLines = [];
  let current = [];
  let currentWidth = 0;
  for (const glyph of words) {
    const glyphWidth = glyph[0].length + 1;
    if (current.length > 0 && currentWidth + glyphWidth > width) {
      displayLines.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(glyph);
    currentWidth += glyphWidth;
  }
  if (current.length > 0) displayLines.push(current);

  const out = [];
  for (const glyphs of displayLines) {
    for (let row = 0; row < 5; row += 1) {
      let line = glyphs.map((g) => g[row]).join(' ').replace(/\s+$/, '');
      if (opts.align === 'center') {
        const pad = Math.max(0, Math.floor((width - glyphs.reduce((n, g) => n + g[0].length + 1, -1)) / 2));
        line = ' '.repeat(pad) + line;
      } else if (opts.align === 'right') {
        const pad = Math.max(0, width - glyphs.reduce((n, g) => n + g[0].length + 1, -1));
        line = ' '.repeat(pad) + line;
      }
      out.push(fill === '#' ? line : line.split('#').join(fill));
    }
  }
  return out.join('\n');
}

/**
 * Build figlet / banner.
 * @param {string} name
 * @returns {object}
 */
function figletCommand(name) {
  return {
    name,
    aliases: [],
    synopsis: `${name} [-c|-l|-r] [-w WIDTH] [TEXT...]`,
    description: 'Print text in large block letters',
    man: `NAME
       ${name} - display large characters made up of ordinary screen characters

SYNOPSIS
       ${name} [ -clnprtvxDELNRSWX ] [ -w outputwidth ] [ -f fontfile ] [ message ]

DESCRIPTION
       ${name} prints its input in large letters. This build ships one built-in
       five-row block font covering A-Z, 0-9, space and common punctuation;
       lower case is rendered as upper case. With no message it reads standard
       input.

OPTIONS
       -c     Centre the output.
       -l     Left-align the output (the default).
       -r     Right-align the output.
       -w outputwidth
              Set the output width. The default is the terminal width.
       -f fontfile
              Accepted and ignored: only the built-in block font is available.`,
    async run(ctx) {
      const argv = ctx.argv.slice();
      let align = 'left';
      let width = termCols(ctx);
      const words = [];

      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (words.length > 0) { words.push(a); continue; }
        if (a === '-c') { align = 'center'; continue; }
        if (a === '-l') { align = 'left'; continue; }
        if (a === '-r') { align = 'right'; continue; }
        if (a === '-w') { width = Math.max(10, Number(argv[++i]) || width); continue; }
        if (a === '-f') { i += 1; continue; }
        if (a === '-I' || a === '-v' || a === '--version') return ok(`${name} version 2.2.5\n`);
        if (a === '-h' || a === '--help') return ok(`Usage: ${name} [ -clr ] [ -w outputwidth ] [ message ]\n`);
        if (a.startsWith('-') && a.length > 1) continue;
        words.push(a);
      }

      const message = words.length > 0 ? words.join(' ') : (ctx.stdin || '').trim();
      if (message === '') return ok('');

      const blocks = message.split('\n').filter((l) => l !== '').map(
        (line) => renderBlockFont(line, { width, align }),
      );
      return ok(`${blocks.join('\n')}\n`);
    },
  };
}

const figletCmd = figletCommand('figlet');
const bannerCmd = figletCommand('banner');

/* ================================================================== *
 * fortune
 * ================================================================== */

/** The built-in fortune cookie file. */
const FORTUNES = [
  'A computer once beat me at chess, but it was no match for me at kickboxing.',
  'The best way to accelerate a computer is at 9.8 m/s².',
  'Never test for an error condition you do not know how to handle.',
  'Deleted code is debugged code.',
  'There are two hard problems in computing: cache invalidation, naming things,\nand off-by-one errors.',
  'Weeks of coding can save you hours of planning.',
  'If it works, do not touch it. If it does not, git blame will tell you whose\nfault it is.',
  'A good plan today is better than a perfect plan tomorrow.',
  'Simplicity is prerequisite for reliability.',
  'Any sufficiently advanced bug is indistinguishable from a feature.',
  'sudo: it is not a magic word, but it is close.',
  'You will find the answer in the log file you did not read.',
  'The tar command flags are: eXtract Ze Vucking File.',
  'rm -rf / is the fastest way to free up disk space, and the last.',
  'It compiles. Ship it.',
  'The night is dark and full of segfaults.',
  'One does not simply exit vim.',
  'Programs must be written for people to read, and only incidentally for\nmachines to execute.',
  'Premature optimisation is the root of a great deal of overtime.',
  'Documentation is a love letter you write to your future self.',
  'The cheapest, fastest and most reliable components are those that are not\nthere.',
  'Debugging is like being the detective in a crime film where you are also the\nmurderer.',
  'A user interface is like a joke. If you have to explain it, it is not that\ngood.',
  'Backups are useless. Restores are priceless.',
  'The problem is between the keyboard and the chair, and it has a coffee.',
  'Ubuntu: an ancient African word meaning "I cannot configure Debian".',
  'Your terminal is a time machine: history repeats itself with the up arrow.',
  'To iterate is human, to recurse divine.',
  'There is no cloud, it is just someone else\'s computer.',
  'Given enough eyeballs, all bugs are shallow. Finding the eyeballs is the hard\npart.',
  'Nothing is foolproof to a sufficiently talented fool.',
  'Today is a good day to read the man page.',
];

const fortuneCommand = {
  name: 'fortune',
  aliases: [],
  synopsis: 'fortune [-s] [-l] [-n LENGTH] [-a]',
  description: 'Print a random, hopefully interesting, adage',
  man: `NAME
       fortune - print a random, hopefully interesting, adage

SYNOPSIS
       fortune [-acefilosw] [-n length] [file...]

DESCRIPTION
       When fortune is run with no arguments it prints out a random epigram
       from its built-in cookie file.

OPTIONS
       -a     Choose from all lists of maxims.
       -l     Long dictums only.
       -s     Short apothegms only.
       -n length
              Set the longest fortune length considered to be "short".
       -e     Consider all fortune files to be of equal size.`,
  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('-v') || argv.includes('--version')) return ok('fortune-mod 3.20.0\n');

    let limit = 160;
    const lengthIdx = argv.indexOf('-n');
    if (lengthIdx >= 0 && argv[lengthIdx + 1]) limit = Math.max(1, Number(argv[lengthIdx + 1]) || 160);

    let pool = FORTUNES;
    if (argv.includes('-s')) pool = FORTUNES.filter((f) => f.length <= limit);
    else if (argv.includes('-l')) pool = FORTUNES.filter((f) => f.length > limit);
    if (pool.length === 0) pool = FORTUNES;

    const pick = pool[Math.floor(Math.random() * pool.length)];
    return ok(`${pick}\n`);
  },
};

/* ================================================================== *
 * reboot / poweroff / shutdown
 * ================================================================== */

/**
 * Perform the session action, announcing it on the bus. `showSessionOverlay`
 * emits the canonical `session:restart` / `session:poweroff` event itself; the
 * direct `bus.emit` below is only the fallback for a headless context (tests,
 * or a shell running before the desktop shell has mounted).
 * @param {'restart'|'poweroff'} mode
 */
function endSession(mode) {
  if (typeof showSessionOverlay === 'function') {
    showSessionOverlay(mode);
    return;
  }
  bus.emit(mode === 'restart' ? 'session:restart' : 'session:poweroff', {});
}

/** systemd's timestamp for a scheduled shutdown. */
function shutdownStamp(d) {
  return `${DAYS_SHORT[d.getDay()]} ${d.getFullYear()}-${pad0(d.getMonth() + 1)}-${pad0(d.getDate())} `
    + `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}`;
}

/**
 * Parse a shutdown TIME operand.
 * @param {string} spec
 * @returns {Date|null|'cancel'} null when the spec is invalid
 */
function parseShutdownTime(spec) {
  const text = String(spec).trim();
  if (text === 'now') return new Date();
  const relative = /^\+(\d+)$/.exec(text);
  if (relative) return new Date(Date.now() + Number(relative[1]) * 60000);
  const absolute = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (absolute) {
    const when = new Date();
    when.setHours(Number(absolute[1]), Number(absolute[2]), 0, 0);
    if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    return when;
  }
  return null;
}

const rebootCommand = {
  name: 'reboot',
  aliases: [],
  synopsis: 'reboot [--force]',
  description: 'Reboot the machine',
  man: `NAME
       reboot - reboot the machine

SYNOPSIS
       reboot [OPTIONS...]

DESCRIPTION
       reboot instructs systemd-logind to restart the machine. In this desktop
       that plays the Ubuntu shutdown animation, persists the virtual
       filesystem and reloads the page.

       Without root privileges logind refuses the request, exactly as it does
       on a real system when polkit cannot authenticate the caller
       non-interactively.

OPTIONS
       --force
              Do not contact the init system, reboot immediately.

EXIT STATUS
       0 the request was accepted, 1 authentication is required.`,
  async run(ctx) {
    if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
      return ok('reboot [OPTIONS...]\n\nReboot the system.\n\n     --help      Show this help\n     --force     Do not contact the init system\n');
    }
    if (!isRoot(ctx)) {
      return fail('Call to Reboot failed: Interactive authentication required.\n', 1);
    }
    endSession('restart');
    return ok('');
  },
};

const poweroffCommand = {
  name: 'poweroff',
  aliases: ['halt'],
  synopsis: 'poweroff [--force]',
  description: 'Power off the machine',
  man: `NAME
       poweroff - power off the machine

SYNOPSIS
       poweroff [OPTIONS...]

DESCRIPTION
       poweroff instructs systemd-logind to shut the machine down. In this
       desktop that plays the Ubuntu shutdown animation, persists the virtual
       filesystem and leaves a "press any key" screen behind.

       Without root privileges logind refuses the request.

OPTIONS
       --force
              Do not contact the init system, power off immediately.

EXIT STATUS
       0 the request was accepted, 1 authentication is required.`,
  async run(ctx) {
    if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
      return ok('poweroff [OPTIONS...]\n\nPower off the system.\n\n     --help      Show this help\n     --force     Do not contact the init system\n');
    }
    if (!isRoot(ctx)) {
      return fail(`Call to ${ctx.name === 'halt' ? 'Halt' : 'PowerOff'} failed: Interactive authentication required.\n`, 1);
    }
    endSession('poweroff');
    return ok('');
  },
};

/** Scheduled shutdown, so `shutdown -c` has something to cancel. */
let scheduled = null;

const shutdownCommand = {
  name: 'shutdown',
  aliases: [],
  synopsis: 'shutdown [-r|-h|-P|-c] [TIME] [MESSAGE]',
  description: 'Halt, power off or reboot the machine',
  man: `NAME
       shutdown - halt, power off or reboot the machine

SYNOPSIS
       shutdown [OPTIONS...] [TIME] [WALL...]

DESCRIPTION
       shutdown may be used to halt, power off or reboot the machine.

       TIME may be "now", "+m" for m minutes from now, or "hh:mm" for an
       absolute time today or tomorrow. With no TIME, "+1" is assumed.

       Without root privileges logind refuses the request.

OPTIONS
       -H, --halt      Halt the machine.
       -P, --poweroff  Power off the machine (the default).
       -r, --reboot    Reboot the machine.
       -h              Equivalent to --poweroff.
       -k              Do not halt, power off or reboot, just write the wall
                       message.
       -c              Cancel a pending shutdown.

EXIT STATUS
       0 the request was accepted, 1 authentication is required.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let mode = 'poweroff';
    let cancel = false;
    let dryRun = false;
    const operands = [];

    for (const a of argv) {
      if (a === '-r' || a === '--reboot') { mode = 'restart'; continue; }
      if (a === '-H' || a === '--halt' || a === '-P' || a === '--poweroff' || a === '-h') { mode = 'poweroff'; continue; }
      if (a === '-c') { cancel = true; continue; }
      if (a === '-k') { dryRun = true; continue; }
      if (a === '--help') return ok('shutdown [OPTIONS...] [TIME] [WALL...]\n\nShut down the system.\n\n     --help      Show this help\n  -H --halt      Halt the machine\n  -P --poweroff  Power off the machine\n  -r --reboot    Reboot the machine\n  -c             Cancel a pending shutdown\n');
      if (a.startsWith('-')) continue;
      operands.push(a);
    }

    if (!isRoot(ctx)) {
      return fail(
        'Failed to set wall message, ignoring: Interactive authentication required.\n'
        + 'Failed to call ScheduleShutdown in logind, no action taken: Interactive authentication required.\n',
        1,
      );
    }

    if (cancel) {
      if (scheduled === null) {
        return fail('Failed to cancel shutdown: No scheduled shutdown.\n', 1);
      }
      scheduled = null;
      return ok('');
    }

    const timeSpec = operands.length > 0 ? operands[0] : '+1';
    const when = parseShutdownTime(timeSpec);
    if (when === null) {
      return fail(`Failed to parse time specification: ${timeSpec}\n`, 1);
    }

    if (dryRun) {
      return { stdout: '', stderr: `Shutdown scheduled for ${shutdownStamp(when)}, use 'shutdown -c' to cancel.\n`, code: 0 };
    }

    if (when.getTime() - Date.now() > 1500) {
      scheduled = { when, mode };
      return { stdout: '', stderr: `Shutdown scheduled for ${shutdownStamp(when)}, use 'shutdown -c' to cancel.\n`, code: 0 };
    }

    endSession(mode);
    return ok('');
  },
};

/* ================================================================== *
 * eog / gnome-screenshot
 * ================================================================== */

const eogCommand = {
  name: 'eog',
  aliases: ['gnome-image-viewer', 'eom'],
  synopsis: 'eog [OPTION...] [FILE...]',
  description: 'Open images in the Image Viewer',
  man: `NAME
       eog - the Eye of GNOME image viewer

SYNOPSIS
       eog [OPTION...] [FILE...]

DESCRIPTION
       Opens FILE in the desktop's Image Viewer window. Prev and Next then walk
       every image in the same directory, in the order the Files window sorts
       them; zoom, rotation, the slideshow and the properties dialog all behave
       the way they do in eog.

       Because js/core/fs.js stores file content as a string, images in this
       filesystem are data URLs — a file whose content begins with
       "data:image/" is an image whatever its name is. A .svg file holding raw
       SVG markup is displayed too. Anything else gets the viewer's "could not
       be displayed" page rather than a blank window.

       With no FILE the viewer opens on ~/Pictures and shows the first image it
       finds there.

       Prints nothing on success, exactly like the real launcher.

OPTIONS
       -f, --fullscreen
              Open in fullscreen mode.

       -s, --slide-show
              Open in slideshow mode. Implies --fullscreen.

       -n, --new-instance
              Open a new window. Accepted; every invocation opens a window here.

       -c, --disable-image-collection
              Accepted and ignored.

EXAMPLES
       eog ~/Pictures/Screenshots/*.png
       eog -s ~/Pictures

EXIT STATUS
       0 the window was opened
       1 the file does not exist
       3 no application is registered for that window

SEE ALSO
       gnome-screenshot(1), xdg-open(1), nautilus(1)`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    const name = ctx.name || 'eog';
    const operands = [];
    let fullscreen = false;
    let slideshow = false;

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--') {
        for (const rest of argv.slice(i + 1)) operands.push(rest);
        break;
      }
      if (a === '--help' || a === '-h' || a === '-?') {
        return ok(
          'Usage:\n  eog [OPTION...] [FILE...]\n\n'
          + 'Help Options:\n  -h, --help                     Show help options\n\n'
          + 'Application Options:\n'
          + '  -f, --fullscreen               Open in fullscreen mode\n'
          + '  -c, --disable-image-collection Disable image collection\n'
          + '  -s, --slide-show               Open in slideshow mode\n'
          + '  -n, --new-instance             Start a new instance instead of reusing an existing one\n',
        );
      }
      if (a === '--version') return ok('eog 45.3\n');
      if (a === '-f' || a === '--fullscreen') { fullscreen = true; continue; }
      if (a === '-s' || a === '--slide-show' || a === '--slideshow') { slideshow = true; continue; }
      if (a === '-n' || a === '--new-instance') continue;
      if (a === '-c' || a === '--disable-image-collection') continue;
      if (a.startsWith('-') && a !== '-') continue;
      operands.push(a);
    }

    if (operands.length === 0) {
      return launch(name, 'imageviewer', { path: `${env.home}/Pictures`, fullscreen, slideshow });
    }

    for (const spec of operands) {
      const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec, env.home));
      if (!fs.exists(target)) {
        return fail(`${name}: Could not open '${spec}': No such file or directory\n`, 1);
      }
      const result = launch(name, 'imageviewer', { path: target, fullscreen, slideshow });
      if (result.code !== 0) return result;
    }
    return ok('');
  },
};

/**
 * Parse a `--delay` operand.
 * @param {string} spec
 * @returns {number|null} seconds, or null when it is not a number
 */
function parseDelay(spec) {
  const value = Number(String(spec));
  if (!Number.isFinite(value) || value < 0 || value > 600) return null;
  return value;
}

const gnomeScreenshotCommand = {
  name: 'gnome-screenshot',
  aliases: ['import'],
  synopsis: 'gnome-screenshot [OPTION...]',
  description: 'Save a picture of the screen into a file',
  man: `NAME
       gnome-screenshot - save a picture of the screen into a file

SYNOPSIS
       gnome-screenshot [OPTION...]
       import [-window ID] FILE

DESCRIPTION
       Captures the screen and writes the PNG to
       ~/Pictures/Screenshots/Screenshot from YYYY-MM-DD HH-MM-SS.png, the same
       folder and the same name format GNOME uses.

       The capture is real. The browser is asked for a frame through
       getDisplayMedia(), so it shows its own picker and you choose which
       surface to share; the PNG that lands in the filesystem is genuinely that
       frame, exported with canvas.toDataURL('image/png').

       Two consequences of running inside a browser, neither of which is
       papered over:

         * The picker needs a recent user interaction. Running this command
           from a keypress satisfies that; a screenshot fired from a script
           long after the last click may be refused.

         * The browser grants a whole surface — a tab, a window or a monitor —
           and never a rectangle inside it. There is no compositor here to ask
           "which window is focused", so -w and -a capture the whole surface you
           picked instead of cropping to a window or a selection. The flags are
           accepted, and a note on stderr says what actually happened.

       Cancelling the picker writes nothing and exits 1. If the browser has no
       getDisplayMedia at all (an insecure origin, or an old browser) a
       placeholder PNG is written that says "SIMULATED CAPTURE" across its own
       face — never a fake file pretending to be a real screenshot.

OPTIONS
       -w, --window
              Grab a window instead of the entire screen. Captures the whole
              shared surface here; see DESCRIPTION.

       -a, --area
              Grab an area of the screen instead of the entire screen.
              Captures the whole shared surface here; see DESCRIPTION.

       -d, --delay=SECONDS
              Take the picture after SECONDS. This is a genuine delay: the
              surface is granted immediately, the command then waits, and the
              frame is taken when the wait is over.

       -f, --file=FILENAME
              Save the picture to FILENAME instead of the Screenshots folder.

       -p, --include-pointer, -b, --include-border, -B, --remove-border,
       -i, --interactive
              Accepted for compatibility and ignored.

       -c, --clipboard
              Not supported: writing an image to the system clipboard is not
              available to a page. Exits 1 and says so.

EXAMPLES
       gnome-screenshot
       gnome-screenshot -d 5
       gnome-screenshot -w -f ~/Pictures/window.png

EXIT STATUS
       0 a picture was written
       1 the capture was cancelled, refused, or could not be saved

SEE ALSO
       eog(1)`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    const name = ctx.name || 'gnome-screenshot';
    const asImport = name === 'import';

    let delaySeconds = 0;
    let file = '';
    let windowMode = false;
    let areaMode = false;
    let clipboard = false;
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--') {
        for (const rest of argv.slice(i + 1)) operands.push(rest);
        break;
      }
      if (a === '--help' || a === '-h' || a === '-?') {
        return ok(
          'Usage:\n  gnome-screenshot [OPTION...]\n\n'
          + 'Help Options:\n  -h, --help                 Show help options\n\n'
          + 'Application Options:\n'
          + '  -c, --clipboard            Send the grab directly to the clipboard\n'
          + '  -w, --window               Grab a window instead of the entire screen\n'
          + '  -a, --area                 Grab an area of the screen instead of the entire screen\n'
          + '  -b, --include-border       Include the window border with the screenshot\n'
          + '  -B, --remove-border        Remove the window border from the screenshot\n'
          + '  -p, --include-pointer      Include the pointer with the screenshot\n'
          + '  -d, --delay=seconds        Take screenshot after specified delay [in seconds]\n'
          + '  -f, --file=filename        Save screenshot directly to this file\n'
          + '  -i, --interactive          Interactively set options\n'
          + '      --version              Print version information and exit\n',
        );
      }
      if (a === '--version') return ok('gnome-screenshot 41.0\n');
      if (a === '-w' || a === '--window') { windowMode = true; continue; }
      if (a === '-a' || a === '--area') { areaMode = true; continue; }
      if (a === '-c' || a === '--clipboard') { clipboard = true; continue; }
      if (a === '-p' || a === '--include-pointer' || a === '-b' || a === '--include-border'
        || a === '-B' || a === '--remove-border' || a === '-i' || a === '--interactive') continue;
      if (a === '-d' || a === '--delay') {
        const parsed = parseDelay(argv[i + 1]);
        if (parsed === null) return fail(`${name}: option '--delay' needs a number of seconds\n`, 1);
        delaySeconds = parsed;
        i += 1;
        continue;
      }
      if (a.startsWith('--delay=')) {
        const parsed = parseDelay(a.slice(8));
        if (parsed === null) return fail(`${name}: option '--delay' needs a number of seconds\n`, 1);
        delaySeconds = parsed;
        continue;
      }
      if (a === '-f' || a === '--file') { file = argv[i + 1] || ''; i += 1; continue; }
      if (a.startsWith('--file=')) { file = a.slice(7); continue; }
      // ImageMagick's `import -window root out.png`.
      if (asImport && a === '-window') { i += 1; continue; }
      if (a.startsWith('-') && a !== '-') continue;
      operands.push(a);
    }

    if (asImport && file === '' && operands.length > 0) file = operands[0];

    if (clipboard) {
      return fail(
        `${name}: --clipboard is not available here — a page cannot write an image to the system clipboard.\n`,
        1,
      );
    }

    let notes = '';
    if (windowMode || areaMode) {
      notes = `${name}: the browser only grants a whole surface, so `
        + `${windowMode && areaMode ? '-w and -a' : windowMode ? '-w' : '-a'} captured everything that was shared.\n`;
    }

    let result;
    try {
      result = await takeScreenshot({ delay: delaySeconds * 1000 });
    } catch (err) {
      return fail(`${name}: ${(err && err.message) || 'the capture failed'}\n`, 1);
    }
    if (!result) {
      return { stdout: '', stderr: `${notes}${name}: the screenshot was cancelled\n`, code: 1 };
    }

    if (file !== '') {
      const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(file, env.home));
      const parent = ctx.path.dirname(target);
      if (!fs.exists(parent)) {
        return {
          stdout: '',
          stderr: `${notes}${name}: ${file}: No such file or directory (the picture is at ${result.path})\n`,
          code: 1,
        };
      }
      try {
        fs.mv(result.path, target);
      } catch (err) {
        return {
          stdout: '',
          stderr: `${notes}${name}: ${file}: ${(err && err.message) || 'could not save'} `
            + `(the picture is at ${result.path})\n`,
          code: 1,
        };
      }
    }

    return { stdout: '', stderr: notes, code: 0 };
  },
};

/* ================================================================== *
 * export
 * ================================================================== */

/** @type {object[]} */
const miscCommands = [
  sleepCommand,
  seqCommand,
  yesCommand,
  bcCommand,
  md5sumCommand,
  sha256sumCommand,
  base64Command,
  xxdCommand,
  watchCommand,
  timeCommand,
  xdgOpenCommand,
  nanoCommand,
  vimCommand,
  viCommand,
  geditCommand,
  gnomeTextEditorCommand,
  codeCommand,
  nautilusCommand,
  firefoxCommand,
  eogCommand,
  gnomeScreenshotCommand,
  cowsayCommand,
  cowthinkCommand,
  figletCmd,
  bannerCmd,
  fortuneCommand,
  rebootCommand,
  poweroffCommand,
  shutdownCommand,
];

export default miscCommands;
