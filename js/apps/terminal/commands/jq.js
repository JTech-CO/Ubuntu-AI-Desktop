/**
 * jq.js — the `jq` command (jq 1.7.1).
 *
 * Option handling, input streams, output formatting and exit codes; the
 * language itself lives in ./jq-engine.js.
 *
 * jq is not part of a fresh Ubuntu 24.04 install, so the command stays
 * "not found" until `sudo apt install jq` — see `available()`.
 */

import { ok, fail } from './util.js';
import { pkgdb } from './pkg-db.js';
import {
  compile, run, locate, dump, parseJson, JsonReader,
  JqError, JqHalt, JqCompileError, JqTimeout, DEFAULT_COLORS,
} from './jq-engine.js';

/** A runaway filter blocks the page, so evaluation stops after this long. */
const TIME_LIMIT_MS = 15000;

const USAGE = `Usage:\tjq [OPTIONS] FILTER [FILES...]
\tjq [OPTIONS] --args FILTER [ARGUMENTS...]
\tjq [OPTIONS] --jsonargs FILTER [JSON_VALUES...]

jq is a tool for processing JSON inputs, applying the given filter to
its JSON text inputs and producing the filter's results as JSON on
standard output.

The simplest filter is ., which copies jq's input to its output
unmodified except for formatting. For more advanced filters see
the jq(1) manpage ("man jq") and/or https://jqlang.github.io/jq/.

Example:

\t$ echo '{"foo": 0}' | jq .
\t{
\t  "foo": 0
\t}

Command options:
  -n, --null-input          use \`null\` as the single input value;
  -R, --raw-input           read each line as string instead of JSON;
  -s, --slurp               read all inputs into an array and use it as
                            the single input value;
  -c, --compact-output      compact instead of pretty-printed output;
  -r, --raw-output          output strings without escapes and quotes;
      --raw-output0         implies -r and output NUL after each output;
  -j, --join-output         implies -r and output without newline after
                            each output;
  -a, --ascii-output        output strings by only ASCII characters
                            using escape sequences;
  -S, --sort-keys           sort keys of each object on output;
  -C, --color-output        colorize JSON output;
  -M, --monochrome-output   disable colored output;
      --tab                 use tabs for indentation;
      --indent n            use n spaces for indentation (max 7 spaces);
      --stream              parse the input value in streaming fashion;
  -f, --from-file file      load filter from the file;
      --arg name value      set $name to the string value;
      --argjson name value  set $name to the JSON value;
      --slurpfile name file set $name to an array of JSON values read
                            from the file;
      --rawfile name file   set $name to string contents of file;
      --args                consume remaining arguments as positional
                            string values;
      --jsonargs            consume remaining arguments as positional
                            JSON values;
  -e, --exit-status         set exit status code based on the output;
  -V, --version             show the version;
  -h, --help                show the help;
  --                        terminates argument processing;

Named arguments are also available as $ARGS.named[], while
positional arguments are available as $ARGS.positional[].
`;

const SHORT_USAGE = `Usage:\tjq [OPTIONS] FILTER [FILES...]
\tjq [OPTIONS] --args FILTER [ARGUMENTS...]
\tjq [OPTIONS] --jsonargs FILTER [JSON_VALUES...]

jq is a tool for processing JSON inputs, applying the given filter to
its JSON text inputs and producing the filter's results as JSON on
standard output.

The simplest filter is ., which copies jq's input to its output
unmodified except for formatting. For more advanced filters see
the jq(1) manpage ("man jq") and/or https://jqlang.github.io/jq/.

Example:

\t$ echo '{"foo": 0}' | jq .
\t{
\t  "foo": 0
\t}

For listing the command options, use jq --help.
`;

function parseArgs(argv) {
  const o = {
    nullInput: false, rawInput: false, slurp: false, compact: false, raw: false, raw0: false, join: false,
    ascii: false, sortKeys: false, color: null, tab: false, indent: 2, stream: false, exitStatus: false,
    fromFile: null, named: new Map(), positional: [], filter: null, files: [], error: '', help: false, version: false,
    pending: [],
  };
  let restMode = null;        // 'args' | 'jsonargs'
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const positional = (x) => {
      if (o.filter === null && o.fromFile === null) { o.filter = x; return; }
      if (restMode === 'args') o.positional.push(x);
      else if (restMode === 'jsonargs') {
        try { o.positional.push(parseJson(x)); } catch { o.error = `jq: Invalid JSON text passed to --jsonargs\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n`; }
      } else o.files.push(x);
    };
    if (onlyPositional || !a.startsWith('-') || a === '-') { positional(a); continue; }
    if (a === '--') { onlyPositional = true; continue; }
    const need = (n) => {
      if (i + n >= argv.length) {
        o.error = `jq: error: ${a} takes ${n === 1 ? 'one parameter' : 'two parameters'} (e.g. ${a} ${n === 1 ? 'value' : 'name value'})\n`;
        return null;
      }
      const vals = argv.slice(i + 1, i + 1 + n);
      i += n;
      return vals;
    };
    if (a.startsWith('--')) {
      switch (a) {
        case '--null-input': o.nullInput = true; break;
        case '--raw-input': o.rawInput = true; break;
        case '--slurp': o.slurp = true; break;
        case '--compact-output': o.compact = true; break;
        case '--raw-output': o.raw = true; break;
        case '--raw-output0': o.raw = true; o.raw0 = true; break;
        case '--join-output': o.raw = true; o.join = true; break;
        case '--ascii-output': o.ascii = true; break;
        case '--sort-keys': o.sortKeys = true; break;
        case '--color-output': o.color = true; break;
        case '--monochrome-output': o.color = false; break;
        case '--tab': o.tab = true; break;
        case '--stream': o.stream = true; break;
        case '--exit-status': o.exitStatus = true; break;
        case '--unbuffered': case '--seq': case '--stream-errors': break;
        case '--args': restMode = 'args'; break;
        case '--jsonargs': restMode = 'jsonargs'; break;
        case '--help': o.help = true; break;
        case '--version': o.version = true; break;
        case '--indent': {
          const v = need(1);
          if (!v) return o;
          const n = Number(v[0]);
          if (!Number.isInteger(n) || n < 0) { o.error = 'jq: Cannot indent less than 0 characters\n'; return o; }
          if (n > 7) { o.error = 'jq: Cannot indent more than 7 characters\n'; return o; }
          o.indent = n;
          break;
        }
        case '--from-file': { const v = need(1); if (!v) return o; o.fromFile = v[0]; break; }
        case '--arg': { const v = need(2); if (!v) return o; o.named.set(v[0], v[1]); break; }
        case '--argjson': {
          const v = need(2);
          if (!v) return o;
          try {
            o.named.set(v[0], parseJson(v[1]));
          } catch {
            o.error = `jq: Invalid JSON text passed to --argjson\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n`;
            return o;
          }
          break;
        }
        case '--slurpfile': case '--rawfile': {
          const v = need(2);
          if (!v) return o;
          o.pending.push({ kind: a.slice(2), name: v[0], file: v[1] });
          break;
        }
        default:
          o.error = `jq: Unknown option: ${a}\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n`;
          return o;
      }
      continue;
    }
    for (const ch of a.slice(1)) {
      switch (ch) {
        case 'n': o.nullInput = true; break;
        case 'R': o.rawInput = true; break;
        case 's': o.slurp = true; break;
        case 'c': o.compact = true; break;
        case 'r': o.raw = true; break;
        case 'j': o.raw = true; o.join = true; break;
        case 'a': o.ascii = true; break;
        case 'S': o.sortKeys = true; break;
        case 'C': o.color = true; break;
        case 'M': o.color = false; break;
        case 'e': o.exitStatus = true; break;
        case 'h': o.help = true; break;
        case 'V': o.version = true; break;
        case 'f': { const v = need(1); if (!v) return o; o.fromFile = v[0]; break; }
        default:
          o.error = `jq: Unknown option: ${a}\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n`;
          return o;
      }
    }
  }
  return o;
}

/** JQ_COLORS, falling back to jq's defaults for any field left out. */
function colorsFrom(spec) {
  const out = DEFAULT_COLORS.slice();
  if (!spec) return out;
  spec.split(':').forEach((c, i) => {
    if (i < out.length && /^[0-9;]*$/.test(c)) out[i] = c;
  });
  return out;
}

/** `tostream` for --stream: [path, leaf] events plus closing [path] events. */
function* streamEvents(v, path = []) {
  const isContainer = Array.isArray(v) || v instanceof Map;
  if (!isContainer || (Array.isArray(v) ? v.length === 0 : v.size === 0)) {
    yield [path, v];
    return;
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Array.from(v.entries());
  for (const [k, x] of entries) yield* streamEvents(x, path.concat([k]));
  yield [path.concat([entries[entries.length - 1][0]])];
}

const jq = {
  name: 'jq',
  aliases: [],
  available: () => pkgdb.isInstalled('jq'),
  synopsis: 'jq [OPTIONS] FILTER [FILES...]',
  description: 'Command-line JSON processor',
  man: `NAME
       jq - Command-line JSON processor

SYNOPSIS
       jq [options...] filter [files...]

DESCRIPTION
       jq can transform JSON in various ways, by selecting, iterating,
       reducing and otherwise mangling JSON documents. For instance,
       running the command jq 'map(.price) | add' will take an array of
       JSON objects as input and return the sum of their "price" fields.

       By default, jq reads a stream of JSON entities from stdin. If files
       are given, it reads from those instead.

BASIC FILTERS
       .                 identity
       .foo, .foo.bar    object identifier-index
       .foo?             optional (no error if . is not an object)
       .[n], .[a:b]      array index and slice
       .[]               iterate values
       ,  |              produce both / pipe
       ..                recursive descent

TYPES AND VALUES
       [ ... ]  { ... }  construct arrays and objects
       "\\(expr)"         string interpolation
       @base64 @csv @tsv @sh @uri @html @json @text   formats

BUILTIN OPERATORS AND FUNCTIONS
       + - * / %  ==  !=  <  <=  >  >=  and or not  //  |=  =  +=
       length keys has in map map_values select empty error path paths
       del getpath setpath to_entries from_entries with_entries add any all
       flatten range floor sqrt pow log tostring tonumber type
       sort sort_by group_by unique unique_by min max min_by max_by
       reverse contains inside startswith endswith ltrimstr rtrimstr
       explode implode split join ascii_downcase ascii_upcase
       test match capture scan splits sub gsub  recurse env $ENV
       limit first last nth until while repeat input inputs debug
       tojson fromjson todate fromdate now strftime strptime mktime
       reduce foreach  if/then/elif/else/end  try/catch  label/break
       def  $__loc__  getpath  tostream fromstream  splits  walk

OPTIONS
       -n  null input          -r  raw output         -c  compact output
       -s  slurp               -R  raw input          -j  join output
       -S  sort keys           -e  exit status        -a  ASCII output
       -C / -M  color on/off   --tab / --indent n
       --arg name v   --argjson name json   --slurpfile / --rawfile
       --args / --jsonargs   -f file   --stream

EXIT STATUS
       0 normally; 1 or 4 with -e (last output false/null, or none);
       2 usage or input error; 3 compile error; 5 runtime error.`,

  async run(ctx) {
    const o = parseArgs(ctx.argv);
    if (o.error) return fail(o.error, 2);
    if (o.help) return ok(USAGE);
    if (o.version) return ok('jq-1.7.1\n');

    let program = o.filter;
    if (o.fromFile !== null) {
      try {
        program = ctx.fs.readFile(ctx.fs.resolve(o.fromFile, ctx.cwd));
      } catch (err) {
        return fail(`jq: error: Could not open ${o.fromFile}: ${err.message}\n`, 2);
      }
      if (o.filter !== null) { o.files.unshift(o.filter); o.filter = null; }
    }
    if (program === null) {
      // jq runs `.` when it has piped input and no filter; otherwise it explains itself
      if (ctx.stdin && !o.files.length) program = '.';
      else return fail(SHORT_USAGE, 2);
    }

    // Files for --slurpfile / --rawfile
    for (const pf of o.pending) {
      let text;
      try {
        text = ctx.fs.readFile(ctx.fs.resolve(pf.file, ctx.cwd));
      } catch (err) {
        return fail(`jq: Bad JSON in --${pf.kind} ${pf.name} ${pf.file}: Could not open ${pf.file}: ${err.message}\n`, 2);
      }
      if (pf.kind === 'rawfile') o.named.set(pf.name, text);
      else {
        const r = new JsonReader(text);
        const all = [];
        try {
          while (r.more()) all.push(r.next());
        } catch (err) {
          return fail(`jq: Bad JSON in --slurpfile ${pf.name} ${pf.file}: ${err.message}\n`, 2);
        }
        o.named.set(pf.name, all);
      }
    }
    const namedObj = new Map();
    for (const [k, v] of o.named) namedObj.set(k, v);
    o.named.set('ARGS', new Map([['positional', o.positional], ['named', namedObj]]));

    let filter;
    try {
      filter = compile(program, o.named.keys());
    } catch (err) {
      if (err instanceof JqCompileError) {
        const where = locate(program, err.pos);
        return fail(`jq: error: ${err.message} at <top-level>, line ${where.line}:\n${where.text}\njq: 1 compile error\n`, 3);
      }
      throw err;
    }

    /* ---- inputs ---- */
    const sources = [];
    if (o.files.length) {
      for (const f of o.files) {
        try {
          sources.push({ name: f, text: ctx.fs.readFile(ctx.fs.resolve(f, ctx.cwd)) });
        } catch (err) {
          return fail(`jq: error: Could not open ${f}: ${err.message}\n`, 2);
        }
      }
    } else {
      sources.push({ name: null, text: ctx.stdinBinary ? '' : (ctx.stdin || '') });
    }

    let inputError = '';
    let current = { name: null, reader: null, line: 0 };
    const queue = sources.slice();

    /** The next input value, or undefined at the end. */
    const rawValues = (function* values() {
      if (o.rawInput) {
        const text = sources.map((s) => s.text).join('');
        if (o.slurp) { yield text; return; }
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        for (const line of lines) yield line;
        return;
      }
      while (queue.length) {
        const src = queue.shift();
        current = { name: src.name, reader: new JsonReader(src.text) };
        for (;;) {
          let more;
          try {
            more = current.reader.more();
            if (!more) break;
            const v = current.reader.next();
            if (o.stream) {
              for (const ev of streamEvents(v)) yield ev;
            } else yield v;
          } catch (err) {
            if (err instanceof SyntaxError) {
              inputError = `jq: parse error: ${err.message}\n`;
              return;
            }
            throw err;
          }
        }
      }
    })();

    const nextInput = () => {
      const r = rawValues.next();
      return r.done ? undefined : r.value;
    };

    /* ---- output ---- */
    const useColor = o.color !== null ? o.color : (ctx.stdoutIsTTY && !ctx.env.get('NO_COLOR'));
    const fmt = {
      indent: o.compact ? '' : o.tab ? '\t' : ' '.repeat(o.indent),
      sortKeys: o.sortKeys,
      colors: useColor ? colorsFrom(ctx.env.get('JQ_COLORS')) : null,
      ascii: o.ascii,
    };
    const envMap = new Map(Object.entries(ctx.env.all()));

    let stdout = '';
    let stderr = '';
    let code = 0;
    let lastOutput;
    let produced = false;
    const deadline = Date.now() + TIME_LIMIT_MS;
    const io = {
      env: envMap,
      named: o.named,
      input: nextInput,
      stderr: (s) => { stderr += s; },
      get filename() { return current.name; },
      deadline,
    };

    const emit = (v) => {
      produced = true;
      lastOutput = v;
      if (o.raw && typeof v === 'string') stdout += v;
      else stdout += dump(v, fmt);
      if (o.raw0) stdout += '\0';
      else if (!o.join) stdout += '\n';
    };

    let count = 0;
    const runOne = async (input) => {
      try {
        for (const v of run(filter, input, io)) {
          emit(v);
          count += 1;
          if ((count & 255) === 0) {
            // let the terminal breathe and notice Ctrl+C
            await new Promise((r) => setTimeout(r, 0));
            if (ctx.signal && ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
          }
        }
      } catch (err) {
        if (err instanceof JqError) {
          const where = current.name === null && o.nullInput ? '<unknown>' : `${current.name || '<stdin>'}:${current.reader ? current.reader.lineNo() : 0}`;
          const v = err.value;
          if (typeof v === 'string') stderr += `jq: error (at ${where}): ${v}\n`;
          else if (v instanceof Map && v.has('message') && typeof v.get('message') === 'string') stderr += `jq: error (at ${where}): ${v.get('message')}\n`;
          else stderr += `jq: error (at ${where}) (not a string): ${dump(v, {})}\n`;
          code = 5;
          return true;
        }
        if (err instanceof JqHalt) throw err;
        if (err instanceof JqTimeout) {
          stderr += `jq: error: stopped after ${TIME_LIMIT_MS / 1000} seconds (this emulator's limit for one jq run)\n`;
          code = 5;
          return false;
        }
        if (err instanceof RangeError) {
          stderr += 'jq: error: stack overflow (the program recursed too deeply)\n';
          code = 5;
          return false;
        }
        throw err;
      }
      return true;
    };

    try {
      if (o.nullInput) {
        await runOne(null);
      } else if (o.slurp && !o.rawInput) {
        const all = [];
        for (let v = nextInput(); v !== undefined; v = nextInput()) all.push(v);
        if (!inputError) await runOne(all);
      } else {
        for (let v = nextInput(); v !== undefined; v = nextInput()) {
          if (!(await runOne(v))) break;
        }
      }
    } catch (err) {
      if (err instanceof JqHalt) {
        if (err.hasValue) {
          const v = err.value;
          stderr += typeof v === 'string' ? v : `${dump(v, {})}\n`;
        }
        return { stdout, stderr, code: err.code };
      }
      throw err;
    }

    if (inputError) {
      stderr += inputError;
      code = 2;
    }
    if (o.exitStatus && code === 0) {
      if (!produced) code = 4;
      else if (lastOutput === null || lastOutput === false) code = 1;
    }
    return { stdout, stderr, code };
  },
};

export default [jq];
