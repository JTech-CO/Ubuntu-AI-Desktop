/**
 * awk.js — `awk` (mawk 1.3.4, Ubuntu's default awk; also `mawk`, `nawk`).
 *
 * Option handling and the bridge to the filesystem and shell; the language
 * is in ./awk-engine.js. The program runs as a generator: shell commands
 * (`cmd | getline`, `system()`, `print | "cmd"`) are awaited when it yields
 * them, and every few thousand statements it yields so output streams to
 * the terminal and Ctrl+C can stop it.
 */

import { ok, fail } from './util.js';
import {
  parseProgram, Awk, TICK, unescapeString,
  AwkSyntaxError, AwkRuntimeError, AwkFatal,
} from './awk-engine.js';

const VERSION = `mawk 1.3.4 20240123
Copyright 2008-2023,2024, Thomas E. Dickey
Copyright 1991-1996,2014, Michael D. Brennan

random-funcs:       srandom/random
regex-funcs:        internal

compiled limits:
sprintf buffer      8192
maximum-integer     2147483647
`;

const USAGE = `Usage: mawk [Options] [Program] [file ...]

Program:
    The -f option value is the name of a file containing program text.
    If no -f option is given, a "--" ends option processing; the following
    parameters are the program text.

Options:
    -f program-file  Program  text is read from file instead of from the
                     command-line.  Multiple -f options are accepted.
    -F value         sets the field separator, FS, to value.
    -v var=value     assigns value to program variable var.
    --               unambiguous end of options.

    Implementation-specific options are prefixed with "-W".  They can be
    abbreviated:

    -W version       show version information and exit.
    -W help          show this message and exit.
    -W usage         show this message and exit.
`;

const MAN = `NAME
       mawk - pattern scanning and text processing language

SYNOPSIS
       mawk [-W option] [-F value] [-v var=value] [--] 'program text' [file ...]
       mawk [-W option] [-F value] [-v var=value] [-f program-file] [--] [file ...]

DESCRIPTION
       mawk is an interpreter for the AWK Programming Language. A program is
       a sequence of pattern {action} pairs and function definitions. Each
       input record (a line, by default) is split into fields $1 … $NF, and
       every pattern that matches runs its action. BEGIN runs before input
       is read, END after the last record.

OPTIONS
       -F value      sets the field separator, FS, to value ("\\t" for a tab).
       -f file       program text is read from file (may be repeated).
       -v var=value  assigns value to program variable var before BEGIN.
       -W version    mawk writes its version and exits.

THE AWK LANGUAGE
       Patterns     BEGIN  END  expression  /regex/  pattern1, pattern2
       Statements   if/else  while  do-while  for(;;)  for (k in array)
                    break  continue  next  nextfile  exit  return  delete
                    print  printf  getline  { ... }
       Operators    = += -= *= /= %= ^=  ?:  ||  &&  in  ~ !~
                    < <= != == > >=  (concatenation)  + - * / % ^  ! ++ --  $
       Output       print > "file"   print >> "file"   print | "command"
       Input        getline  getline var  getline < file  "cmd" | getline

BUILT-IN VARIABLES
       NR NF FNR FS OFS ORS RS FILENAME SUBSEP RSTART RLENGTH CONVFMT OFMT
       ENVIRON ARGC ARGV

BUILT-IN FUNCTIONS
       length substr index split sub gsub match sprintf tolower toupper
       sin cos atan2 exp log sqrt int rand srand system close fflush
       systime mktime strftime

EXAMPLES
       awk '{ print $1 }' file              print the first field of each line
       awk -F: '{ print $1 }' /etc/passwd   user names
       awk '{ s += $2 } END { print s }'    sum a column
       awk '!seen[$0]++'                    drop duplicate lines
       awk 'NR % 2 == 0'                    even-numbered lines
       awk 'length > 72'                    long lines

NOTES
       Strings are measured in characters, as gawk does in a UTF-8 locale;
       the real mawk counts bytes, so length("é") is 2 there and 1 here.
       Output pipes run their command when closed or when the program ends.

EXIT STATUS
       The value given to exit, 0 otherwise; 2 for errors.`;

function parseArgs(argv) {
  const o = { fs: null, assigns: [], progFiles: [], program: null, operands: [], version: false, usage: false, error: '' };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { i += 1; break; }
    if (a === '--version' || a === '-V') { o.version = true; return o; }
    if (a === '--help' || a === '--usage') { o.usage = true; return o; }
    if (!a.startsWith('-') || a === '-') break;
    const flag = a[1];
    const inline = a.slice(2);
    const value = () => {
      if (inline !== '') return inline;
      i += 1;
      if (i >= argv.length) { o.error = `option requires an argument -- ${flag}`; return null; }
      return argv[i];
    };
    if (flag === 'F') {
      const v = value();
      if (v === null) return o;
      o.fs = v === 't' ? '\t' : unescapeString(v);
    } else if (flag === 'v') {
      const v = value();
      if (v === null) return o;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(v);
      if (!m) { o.error = `improper assignment: -v ${v}`; return o; }
      o.assigns.push([m[1], unescapeString(m[2])]);
    } else if (flag === 'f') {
      const v = value();
      if (v === null) return o;
      o.progFiles.push(v);
    } else if (flag === 'W') {
      const v = value();
      if (v === null) return o;
      const w = v.toLowerCase();
      if ('version'.startsWith(w) && w) { o.version = true; return o; }
      if ('usage'.startsWith(w) || 'help'.startsWith(w)) { o.usage = true; return o; }
      // other -W options (interactive, posix_space, …) are accepted and ignored
    } else {
      o.error = `not an option: ${a}`;
      return o;
    }
  }
  const rest = argv.slice(i);
  if (!o.progFiles.length) {
    if (!rest.length) { o.usage = true; return o; }
    o.program = rest.shift();
  }
  o.operands = rest;
  return o;
}

const awk = {
  name: 'awk',
  aliases: ['mawk', 'nawk'],
  synopsis: "awk [-F fs] [-v var=value] ['prog' | -f progfile] [file ...]",
  description: 'pattern scanning and text processing language',
  man: MAN,

  async run(ctx) {
    const prog = ctx.name === 'awk' || ctx.name === 'nawk' || ctx.name === 'mawk' ? ctx.name : 'awk';
    const o = parseArgs(ctx.argv);
    if (o.version) return ok(VERSION);
    if (o.usage) return fail(USAGE, 2);
    if (o.error) return fail(`${prog}: ${o.error}\n`, 2);

    let source = o.program;
    if (o.progFiles.length) {
      const parts = [];
      for (const f of o.progFiles) {
        try {
          parts.push(f === '-' || f === '/dev/stdin' ? (ctx.stdin || '') : ctx.fs.readFile(ctx.fs.resolve(f, ctx.cwd)));
        } catch (err) {
          return fail(`${prog}: couldn't open file ${f}: ${err.message}\n`, 2);
        }
      }
      source = parts.join('\n');
    }

    let parsed;
    try {
      parsed = parseProgram(source);
    } catch (err) {
      if (err instanceof AwkSyntaxError) return fail(`${prog}: ${err.message}\n`, 2);
      throw err;
    }

    const resolve = (name) => ctx.fs.resolve(name, ctx.cwd);
    const io = {
      stdin: ctx.stdin || '',
      env: ctx.env.all(),
      argv: [prog, ...o.operands],
      assigns: o.fs !== null ? [['FS', o.fs], ...o.assigns] : o.assigns,
      readFile: (name) => {
        const p = resolve(name);
        if (ctx.fs.isDir(p)) throw new Error('Is a directory');
        return ctx.fs.readFile(p);
      },
      writeFile: (name, text, append) => {
        if (name === '/dev/null') return;
        ctx.fs.writeFile(resolve(name), text, { append });
      },
      run: async (cmd, stdin) => {
        const res = await ctx.run(cmd, { stdin });
        return { code: res.code, stdout: res.stdout || '' };
      },
    };

    const machine = new Awk(parsed, io);
    const gen = machine.main();
    let code = 0;
    let feed;
    try {
      for (;;) {
        const step = gen.next(feed);
        feed = undefined;
        if (step.done) { code = step.value; break; }
        if (step.value === TICK) {
          if (machine.out) { ctx.term.write(machine.out); machine.out = ''; }
          await new Promise((r) => setTimeout(r, 0));
          if (ctx.signal && ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
          continue;
        }
        feed = await step.value;
      }
    } catch (err) {
      const where = `\tFILENAME="${machine.str(machine.g.get('FILENAME'))}" FNR=${machine.str(machine.g.get('FNR'))} NR=${machine.str(machine.g.get('NR'))}\n`;
      let msg;
      if (err instanceof AwkFatal) msg = `${prog}: ${err.message}\n`;
      else if (err instanceof AwkRuntimeError) msg = `${prog}: run time error: ${err.message}\n${where}`;
      else if (err instanceof RangeError) msg = `${prog}: run time error: function call nesting too deep\n${where}`;
      else throw err;
      return { stdout: machine.out, stderr: machine.err + msg, code: 2 };
    }
    return { stdout: machine.out, stderr: machine.err, code };
  },
};

export default [awk];
