/**
 * shell-utils.js — env, printenv, expr, xargs.
 *
 * Small tools that tutorials lean on constantly and whose absence stopped
 * pipelines cold (`find … | xargs grep`, `expr $a + 1`, `env FOO=1 cmd`).
 *
 * `env` and `xargs` run other commands. They do it through `ctx.run()`, which
 * re-parses a command LINE, so every argument is shell-quoted first — an item
 * containing a space or a quote must arrive as one argument, not be re-split.
 */

import { ok, fail } from './util.js';

/* ------------------------------------------------------------------ *
 * shared
 * ------------------------------------------------------------------ */

/**
 * Quote one word so the shell reads it back as exactly that word.
 * @param {string} word
 * @returns {string}
 */
export function shQuote(word) {
  const s = String(word);
  if (s !== '' && /^[A-Za-z0-9_\-+./:=@%^,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ *
 * env / printenv
 * ------------------------------------------------------------------ */

const env = {
  name: 'env',
  aliases: [],
  synopsis: 'env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]',
  description: 'Run a program in a modified environment',
  man: `NAME
       env - run a program in a modified environment

SYNOPSIS
       env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]

DESCRIPTION
       Set each NAME to VALUE in the environment and run COMMAND. With no
       COMMAND, print the resulting environment.

       -i, --ignore-environment
              start with an empty environment
       -u, --unset=NAME
              remove variable from the environment
       -0, --null
              end each output line with NUL, not newline
       --help display this help and exit
       --version
              output version information and exit

       A mere - implies -i.

EXAMPLES
       env                     list the environment
       env LANG=C sort file    run sort with LANG set to C
       env -u HOME printenv    run printenv without HOME`,

  async run(ctx) {
    const argv = ctx.argv.slice();
    let ignore = false;
    let nul = false;
    const unset = [];
    let i = 0;

    for (; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--help') return ok(`${this.synopsis.replace(/^/, 'Usage: ')}\n`);
      if (a === '--version') return ok('env (GNU coreutils) 9.4\n');
      if (a === '-' || a === '-i' || a === '--ignore-environment') { ignore = true; continue; }
      if (a === '-0' || a === '--null') { nul = true; continue; }
      if (a === '-u' || a === '--unset') {
        if (i + 1 >= argv.length) {
          return fail("env: option requires an argument -- 'u'\nTry 'env --help' for more information.\n", 125);
        }
        unset.push(argv[i + 1]);
        i += 1;
        continue;
      }
      if (a.startsWith('--unset=')) { unset.push(a.slice(8)); continue; }
      if (a === '--') { i += 1; break; }
      if (a.startsWith('-') && a.length > 1) {
        return fail(`env: invalid option -- '${a.slice(1, 2)}'\nTry 'env --help' for more information.\n`, 125);
      }
      break;
    }

    const assigns = [];
    for (; i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]); i += 1) {
      const eq = argv[i].indexOf('=');
      assigns.push([argv[i].slice(0, eq), argv[i].slice(eq + 1)]);
    }
    const command = argv.slice(i);

    // Build the environment the child would see.
    const base = ignore ? {} : { ...ctx.env.all() };
    for (const name of unset) delete base[name];
    for (const [k, v] of assigns) base[k] = v;

    if (command.length === 0) {
      const end = nul ? '\0' : '\n';
      return ok(Object.entries(base).map(([k, v]) => `${k}=${v}${end}`).join(''));
    }

    // The shell keeps one environment per tab, so -i/-u are applied for the
    // duration of the child and then restored — what a real exec'd child
    // would observe, without touching the parent afterwards. The session's
    // own variable map shadows the global env, so both are cleared.
    const vars = ctx.session && ctx.session.vars instanceof Map ? ctx.session.vars : null;
    const saved = ctx.env.all();
    const savedVars = vars ? new Map(vars) : null;
    const pool = new Set([...Object.keys(saved), ...(vars ? vars.keys() : [])]);
    const removed = ignore ? [...pool] : unset.filter((n) => pool.has(n));
    try {
      for (const name of removed) {
        ctx.env.unset(name);
        if (vars) vars.delete(name);
      }
      const line = assigns.map(([k, v]) => `${k}=${shQuote(v)}`)
        .concat(command.map(shQuote))
        .join(' ');
      const res = await ctx.run(line);
      return { stdout: res.stdout, stderr: '', code: res.code };
    } finally {
      for (const name of removed) {
        if (name in saved) ctx.env.set(name, saved[name]);
        if (vars && savedVars.has(name)) vars.set(name, savedVars.get(name));
      }
    }
  },
};

const printenv = {
  name: 'printenv',
  aliases: [],
  synopsis: 'printenv [OPTION]... [VARIABLE]...',
  description: 'Print all or part of environment',
  man: `NAME
       printenv - print all or part of environment

SYNOPSIS
       printenv [OPTION]... [VARIABLE]...

DESCRIPTION
       Print the values of the specified environment VARIABLE(s). If no
       VARIABLE is specified, print name and value pairs for them all.

       -0, --null
              end each output line with NUL, not newline

EXIT STATUS
       0 if all variables specified were found, 1 if at least one was not.`,

  async run(ctx) {
    const nul = ctx.argv.includes('-0') || ctx.argv.includes('--null');
    const names = ctx.argv.filter((a) => a !== '-0' && a !== '--null');
    const end = nul ? '\0' : '\n';
    const all = ctx.env.all();
    if (names.length === 0) {
      return ok(Object.entries(all).map(([k, v]) => `${k}=${v}${end}`).join(''));
    }
    let out = '';
    let code = 0;
    for (const n of names) {
      if (Object.prototype.hasOwnProperty.call(all, n)) out += `${all[n]}${end}`;
      else code = 1;
    }
    return { stdout: out, stderr: '', code };
  },
};

/* ------------------------------------------------------------------ *
 * expr
 * ------------------------------------------------------------------ */

class ExprError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

/** GNU expr treats a value as an integer if it is an optional '-' then digits. */
function isInt(v) {
  return typeof v === 'bigint' || (typeof v === 'string' && /^-?\d+$/.test(v));
}

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (!isInt(v)) throw new ExprError('expr: non-integer argument');
  return BigInt(v);
}

/** Null or zero — the values expr treats as false. */
function isFalsy(v) {
  if (typeof v === 'bigint') return v === 0n;
  if (v === '') return true;
  return /^-?0+$/.test(v);
}

function str(v) {
  return typeof v === 'bigint' ? v.toString() : v;
}

/**
 * Translate a POSIX basic regular expression into a JS RegExp source.
 * In a BRE, ( ) { } + ? | are literal and their backslashed forms are the
 * operators; GNU adds \+ \? \| as extensions.
 * @param {string} bre
 * @returns {string}
 */
export function breToJs(bre) {
  let out = '';
  let i = 0;
  let atStart = true;
  while (i < bre.length) {
    const c = bre[i];
    if (c === '\\' && i + 1 < bre.length) {
      const n = bre[i + 1];
      if ('(){}+?|'.includes(n)) out += n;
      else if (/[0-9]/.test(n)) out += `\\${n}`;
      else if (n === '<') out += '\\b(?=\\w)';
      else if (n === '>') out += '\\b(?<=\\w)';
      else if (n === 'w' || n === 'W' || n === 's' || n === 'S' || n === 'b' || n === 'B') out += `\\${n}`;
      else out += `\\${n}`;
      i += 2;
      atStart = false;
      continue;
    }
    if (c === '[') {
      // Copy a bracket expression through, translating POSIX classes.
      let j = i + 1;
      if (bre[j] === '^') j += 1;
      if (bre[j] === ']') j += 1;
      while (j < bre.length && bre[j] !== ']') {
        if (bre[j] === '[' && bre[j + 1] === ':') {
          const end = bre.indexOf(':]', j + 2);
          if (end > 0) { j = end + 2; continue; }
        }
        j += 1;
      }
      out += posixBrackets(bre.slice(i, j + 1));
      i = j + 1;
      atStart = false;
      continue;
    }
    if (c === '*' && atStart) { out += '\\*'; i += 1; atStart = false; continue; }
    if ('(){}+?|/'.includes(c)) { out += `\\${c}`; i += 1; atStart = false; continue; }
    out += c;
    atStart = c === '^';
    i += 1;
  }
  return out;
}

const POSIX_CLASSES = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', print: ' -~',
  graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f', word: 'A-Za-z0-9_',
};

/**
 * Rewrite [[:alpha:]]-style classes inside one bracket expression.
 * @param {string} br including the outer [ ]
 * @returns {string}
 */
export function posixBrackets(br) {
  return br.replace(/\[:([a-z]+):\]/g, (m, name) => POSIX_CLASSES[name] || m);
}

/**
 * Recursive-descent evaluator over the argument list, lowest precedence first.
 */
function evalExpr(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary() {
    const t = next();
    if (t === undefined) {
      throw new ExprError(pos > 1 ? `expr: syntax error: missing argument after '${tokens[pos - 2]}'` : 'expr: syntax error: missing argument');
    }
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new ExprError(`expr: syntax error: expecting ')' after '${tokens[pos - 2] ?? ''}'`);
      return v;
    }
    if (t === '+' && pos < tokens.length) return next();   // GNU: quote the next token
    if (t === 'length' && pos < tokens.length) return BigInt(Array.from(str(primary())).length);
    if (t === 'index' && pos + 1 < tokens.length) {
      const s = str(primary());
      const chars = str(primary());
      let best = 0;
      for (let k = 0; k < s.length; k += 1) if (chars.includes(s[k])) { best = k + 1; break; }
      return BigInt(best);
    }
    if (t === 'substr' && pos + 2 < tokens.length) {
      const s = str(primary());
      const p = toBig(primary());
      const l = toBig(primary());
      if (p < 1n || l < 1n) return '';
      return Array.from(s).slice(Number(p) - 1, Number(p) - 1 + Number(l)).join('');
    }
    if (t === 'match' && pos + 1 < tokens.length) {
      const s = str(primary());
      const re = str(primary());
      return matchOp(s, re);
    }
    return t;
  }

  function matchOp(s, re) {
    let rx;
    try {
      rx = new RegExp(`^(?:${breToJs(re)})`, 's');
    } catch {
      throw new ExprError('expr: Invalid regular expression', 3);
    }
    const m = rx.exec(s);
    const hasGroup = /\\\(/.test(re);
    if (!m) return hasGroup ? '' : 0n;
    if (hasGroup) return m[1] === undefined ? '' : m[1];
    return BigInt(Array.from(m[0]).length);
  }

  function colon() {
    let v = primary();
    while (peek() === ':') {
      next();
      v = matchOp(str(v), str(primary()));
    }
    return v;
  }

  function mul() {
    let v = colon();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const a = toBig(v);
      const b = toBig(colon());
      if (op !== '*' && b === 0n) throw new ExprError('expr: division by zero');
      v = op === '*' ? a * b : op === '/' ? a / b : a % b;
    }
    return v;
  }

  function add() {
    let v = mul();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const a = toBig(v);
      const b = toBig(mul());
      v = op === '+' ? a + b : a - b;
    }
    return v;
  }

  function cmp() {
    let v = add();
    while (['<', '<=', '=', '==', '!=', '>=', '>'].includes(peek())) {
      const op = next();
      const r = add();
      let c;
      if (isInt(v) && isInt(r)) {
        const a = toBig(v); const b = toBig(r);
        c = a < b ? -1 : a > b ? 1 : 0;
      } else {
        const a = str(v); const b = str(r);
        c = a < b ? -1 : a > b ? 1 : 0;
      }
      const res = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '=' || op === '==' ? c === 0
        : op === '!=' ? c !== 0 : op === '>=' ? c >= 0 : c > 0;
      v = res ? 1n : 0n;
    }
    return v;
  }

  function andExpr() {
    let v = cmp();
    while (peek() === '&') {
      next();
      const r = cmp();
      v = !isFalsy(v) && !isFalsy(r) ? v : 0n;
    }
    return v;
  }

  function orExpr() {
    let v = andExpr();
    while (peek() === '|') {
      next();
      const r = andExpr();
      v = !isFalsy(v) ? v : !isFalsy(r) ? r : 0n;
    }
    return v;
  }

  const result = orExpr();
  if (pos < tokens.length) throw new ExprError(`expr: syntax error: unexpected argument '${tokens[pos]}'`);
  return result;
}

const expr = {
  name: 'expr',
  aliases: [],
  synopsis: 'expr EXPRESSION',
  description: 'Evaluate expressions',
  man: `NAME
       expr - evaluate expressions

SYNOPSIS
       expr EXPRESSION

DESCRIPTION
       Print the value of EXPRESSION to standard output. Each operator and
       operand must be a separate argument, so quote the shell's special
       characters: expr 3 \\* 4.

       ARG1 | ARG2       ARG1 if it is neither null nor 0, otherwise ARG2
       ARG1 & ARG2       ARG1 if neither argument is null or 0, otherwise 0
       ARG1 < ARG2       ARG1 is less than ARG2 (also <=, =, !=, >=, >)
       ARG1 + ARG2       arithmetic sum (also -, *, /, %)
       STRING : REGEXP   anchored pattern match of REGEXP in STRING
       match STRING REGEXP        same as STRING : REGEXP
       substr STRING POS LENGTH   substring of STRING, POS counted from 1
       index STRING CHARS         index in STRING where any CHARS is found, or 0
       length STRING              length of STRING
       + TOKEN                    interpret TOKEN as a string

       Integers are arbitrary precision, as in GNU expr.
       REGEXP is a POSIX basic regular expression: \\( \\) capture.

EXIT STATUS
       0 if EXPRESSION is neither null nor 0, 1 if it is, 2 if it is
       syntactically invalid, 3 if an error occurred.`,

  async run(ctx) {
    const argv = ctx.argv.slice();
    if (argv[0] === '--help') return ok(`Usage: expr EXPRESSION\n`);
    if (argv[0] === '--version') return ok('expr (GNU coreutils) 9.4\n');
    if (argv[0] === '--') argv.shift();
    if (argv.length === 0) return fail("expr: missing operand\nTry 'expr --help' for more information.\n", 2);
    try {
      const v = evalExpr(argv);
      return { stdout: `${str(v)}\n`, stderr: '', code: isFalsy(v) ? 1 : 0 };
    } catch (err) {
      if (err instanceof ExprError) return fail(`${err.message}\n`, err.code);
      throw err;
    }
  },
};

/* ------------------------------------------------------------------ *
 * xargs
 * ------------------------------------------------------------------ */

/**
 * Split xargs input into items the way GNU xargs does by default: blanks and
 * newlines separate, single and double quotes group, backslash escapes.
 * @param {string} text
 * @returns {{items: string[], error: string}}
 */
export function splitXargs(text) {
  const items = [];
  let cur = '';
  let has = false;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      if (c === '\n') return { items, error: `xargs: unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option` };
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < text.length) { cur += text[i + 1]; has = true; i += 1; continue; }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (has) { items.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) return { items, error: `xargs: unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option` };
  if (has) items.push(cur);
  return { items, error: '' };
}

const xargs = {
  name: 'xargs',
  aliases: [],
  synopsis: 'xargs [OPTION]... COMMAND [INITIAL-ARGS]...',
  description: 'Build and execute command lines from standard input',
  man: `NAME
       xargs - build and execute command lines from standard input

SYNOPSIS
       xargs [OPTION]... COMMAND [INITIAL-ARGS]...

DESCRIPTION
       Read items from standard input, delimited by blanks or newlines (quotes
       and backslashes group them), and run COMMAND with INITIAL-ARGS followed
       by those items. The default COMMAND is echo.

       -0, --null            items are separated by NUL, not whitespace
       -d, --delimiter=DELIM items are separated by DELIM
       -a, --arg-file=FILE   read items from FILE instead of standard input
       -n, --max-args=N      use at most N items per command line
       -L, --max-lines=N     use at most N input lines per command line
       -I REPLACE            replace REPLACE in INITIAL-ARGS with each input
                             line; implies -L 1
       -t, --verbose         print each command line on stderr before running it
       -r, --no-run-if-empty do not run COMMAND at all if there is no input
       -P, --max-procs=N     accepted; commands run one at a time here

EXIT STATUS
       0 success, 123 if any invocation exited with status 1-125, 124 if one
       exited with 255, 127 if COMMAND was not found.`,

  async run(ctx) {
    const argv = ctx.argv.slice();
    let delim = null;          // null = blank/quote splitting
    let argFile = null;
    let maxArgs = 0;
    let maxLines = 0;
    let replace = null;
    let trace = false;
    let noRunIfEmpty = false;
    let i = 0;

    const needArg = (opt) => fail(`xargs: option requires an argument -- '${opt}'\nTry 'xargs --help' for more information.\n`, 1);
    const positive = (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 ? n : null;
    };

    for (; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--') { i += 1; break; }
      if (!a.startsWith('-') || a === '-') break;
      if (a === '--help') return ok('Usage: xargs [OPTION]... COMMAND [INITIAL-ARGS]...\n');
      if (a === '--version') return ok('xargs (GNU findutils) 4.9.0\n');
      if (a === '-0' || a === '--null') { delim = '\0'; continue; }
      if (a === '-t' || a === '--verbose') { trace = true; continue; }
      if (a === '-r' || a === '--no-run-if-empty') { noRunIfEmpty = true; continue; }
      if (a === '-i') { replace = '{}'; continue; }

      /* An option that takes a value: `-n 2`, `-n2`, `--max-args=2`. */
      const take = (short, long) => {
        if (a === short || a === long) {
          if (i + 1 >= argv.length) return undefined;
          i += 1;
          return argv[i];
        }
        if (a.startsWith(short) && a.length > short.length && !a.startsWith('--')) return a.slice(short.length);
        if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
        return null;
      };
      let v;
      if ((v = take('-d', '--delimiter')) !== null) {
        if (v === undefined) return needArg('d');
        delim = v === '\\n' ? '\n' : v === '\\t' ? '\t' : v === '\\0' ? '\0' : v.slice(0, 1);
        continue;
      }
      if ((v = take('-a', '--arg-file')) !== null) {
        if (v === undefined) return needArg('a');
        argFile = v;
        continue;
      }
      if ((v = take('-n', '--max-args')) !== null) {
        if (v === undefined) return needArg('n');
        if ((maxArgs = positive(v)) === null) return fail(`xargs: invalid number "${v}" for -n option\n`, 1);
        continue;
      }
      if ((v = take('-L', '--max-lines')) !== null) {
        if (v === undefined) return needArg('L');
        if ((maxLines = positive(v)) === null) return fail(`xargs: invalid number "${v}" for -L option\n`, 1);
        continue;
      }
      if ((v = take('-I', '--replace')) !== null) {
        if (v === undefined) return needArg('I');
        replace = v;
        continue;
      }
      // Accepted for compatibility; commands run one at a time here.
      if ((v = take('-P', '--max-procs')) !== null || (v = take('-s', '--max-chars')) !== null) {
        if (v === undefined) return needArg(a.slice(1, 2));
        continue;
      }
      return fail(`xargs: invalid option -- '${a.slice(1, 2)}'\nTry 'xargs --help' for more information.\n`, 1);
    }

    const command = argv.slice(i);
    if (command.length === 0) command.push('echo');

    let input = ctx.stdin || '';
    if (argFile) {
      try {
        input = ctx.fs.readFile(ctx.fs.resolve(argFile, ctx.cwd));
      } catch (err) {
        return fail(`xargs: ${argFile}: ${err.message}\n`, 1);
      }
    }

    /* ---- group the input into one argument list per invocation ---- */
    const batches = [];
    let splitError = '';

    if (replace !== null) {
      // -I: one invocation per non-blank line, leading blanks stripped.
      for (const line of input.split('\n')) {
        const item = line.replace(/^[ \t]+/, '');
        if (item === '') continue;
        batches.push(command.map((w) => w.split(replace).join(item)));
      }
    } else if (maxLines > 0 && delim === null) {
      // -L N: the items from N non-blank lines per invocation.
      let bucket = [];
      let taken = 0;
      for (const line of input.split('\n')) {
        const words = splitXargs(line);
        if (words.error) { splitError = words.error; break; }
        if (words.items.length === 0) continue;
        bucket.push(...words.items);
        taken += 1;
        if (taken === maxLines) {
          batches.push(command.concat(bucket));
          bucket = [];
          taken = 0;
        }
      }
      if (bucket.length) batches.push(command.concat(bucket));
    } else {
      let items;
      if (delim !== null) {
        items = input.split(delim);
        if (items.length && items[items.length - 1] === '') items.pop();
      } else {
        const split = splitXargs(input);
        items = split.items;
        splitError = split.error;
      }
      const size = maxArgs > 0 ? maxArgs : (maxLines > 0 ? maxLines : items.length);
      for (let k = 0; k < items.length; k += size) batches.push(command.concat(items.slice(k, k + size)));
    }

    // GNU runs the command once with no items unless -r was given.
    if (batches.length === 0 && !noRunIfEmpty && replace === null && !splitError) batches.push(command.slice());

    /* ---- run ---- */
    let stdout = '';
    let stderr = '';
    let status = 0;
    for (const args of batches) {
      if (ctx.signal && ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
      const line = args.map(shQuote).join(' ');
      if (trace) stderr += `${line}\n`;
      const res = await ctx.run(line);
      stdout += res.stdout || '';
      if (res.code === 127 || res.code === 126) {
        return { stdout, stderr, code: res.code };
      }
      if (res.code === 255) {
        stderr += `xargs: ${args[0]}: exited with status 255; aborting\n`;
        return { stdout, stderr, code: 124 };
      }
      if (res.code >= 128) return { stdout, stderr, code: 125 };
      if (res.code !== 0) status = 123;
    }

    if (splitError) return { stdout, stderr: `${stderr}${splitError}\n`, code: 1 };
    return { stdout, stderr, code: status };
  },
};

/* ------------------------------------------------------------------ *
 * clear
 * ------------------------------------------------------------------ */

const ESC = String.fromCharCode(27);

const clear = {
  name: 'clear',
  aliases: [],
  synopsis: 'clear [-x] [-T type] [-V]',
  description: 'clear the terminal screen',
  man: `NAME
       clear - clear the terminal screen

SYNOPSIS
       clear [-Ttype] [-V] [-x]

DESCRIPTION
       clear clears your terminal's screen and its scrollback buffer, if
       possible. When its output is not a terminal it writes the escape
       sequence that would do so (ESC [H ESC [2J ESC [3J), as ncurses does.

OPTIONS
       -x     do not attempt to clear the terminal's scrollback buffer
       -V     reports the version of ncurses which was used in this program,
              and exits

SEE ALSO
       Ctrl+L clears the screen from the prompt without running a command.`,

  async run(ctx) {
    if (ctx.argv.includes('-V')) return ok('ncurses 6.4.20240113\n');
    const bad = ctx.argv.find((a) => !/^-(x|T.*)$/.test(a) && a !== '-T');
    if (bad) return fail(`clear: invalid option -- '${bad.replace(/^-/, '').slice(0, 1)}'\nUsage: clear [options]\n`, 1);
    const seq = `${ESC}[H${ESC}[2J${ctx.argv.includes('-x') ? '' : `${ESC}[3J`}`;
    if (!ctx.stdoutIsTTY) return ok(seq);
    ctx.term.clear();
    return ok('');
  },
};

export default [env, printenv, expr, xargs, clear];
