/**
 * python.js — `python3`: real CPython 3.12 through Pyodide.
 *
 * The interpreter runs in a Web Worker (../python-worker.js) and is
 * downloaded from cdn.jsdelivr.net the first time it is needed (about 6 MB,
 * then served from the browser cache). It is the one piece of the terminal,
 * besides the AI commands, that fetches anything from the network.
 *
 * What a program sees:
 *   - the virtual filesystem: home, /tmp and the working directory are
 *     mirrored in before the run and what it writes comes back afterwards;
 *     /etc is readable but changes to it are not kept
 *   - argv, the environment, the working directory
 *   - stdin: piped text, or the terminal for input() (through the service
 *     worker in /sw.js)
 *   - the standard library only — like a fresh Ubuntu, numpy and friends are
 *     not installed
 *
 * Ctrl+C stops a program by terminating the worker, so a KeyboardInterrupt
 * cannot be caught and an interactive session's variables are lost.
 */

import { ok, fail } from './util.js';

const PYTHON_VERSION = '3.12.7';
const PYODIDE_VERSION = '0.27.7';
const MAX_FILE = 16 * 1024 * 1024;
const MAX_EXTRA_FILES = 3000;

const USAGE = `usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...
Options (and corresponding environment variables):
-b     : issue warnings about str(bytes_instance), str(bytearray_instance)
         and comparing bytes/bytearray with str. (-bb: issue errors)
-B     : don't write .pyc files on import; also PYTHONDONTWRITEBYTECODE=x
-c cmd : program passed in as string (terminates option list)
-d     : turn on parser debugging output (for experts only, only works on
         debug builds); also PYTHONDEBUG=x
-E     : ignore PYTHON* environment variables (such as PYTHONPATH)
-h     : print this help message and exit (also -? or --help)
-i     : inspect interactively after running script; forces a prompt even
         if stdin does not appear to be a terminal; also PYTHONINSPECT=x
-I     : isolate Python from the user's environment (implies -E and -s)
-m mod : run library module as a script (terminates option list)
-O     : remove assert and __debug__-dependent statements; add .opt-1 before
         .pyc extension; also PYTHONOPTIMIZE=x
-OO    : do -O changes and also discard docstrings; add .opt-2 before
         .pyc extension
-P     : don't prepend a potentially unsafe path to sys.path; also
         PYTHONSAFEPATH
-q     : don't print version and copyright messages on interactive startup
-s     : don't add user site directory to sys.path; also PYTHONNOUSERSITE
-S     : don't imply 'import site' on initialization
-u     : force the stdout and stderr streams to be unbuffered;
         this option has no effect on stdin; also PYTHONUNBUFFERED=x
-v     : verbose (trace import statements); also PYTHONVERBOSE=x
         can be supplied multiple times to increase verbosity
-V     : print the Python version number and exit (also --version)
         when given twice, print more information about the build
-W arg : warning control; arg is action:message:category:module:lineno
         also PYTHONWARNINGS=arg
-x     : skip first line of source, allowing use of non-Unix forms of #!cmd
-X opt : set implementation-specific option
--check-hash-based-pycs always|default|never:
         control how Python invalidates hash-based .pyc files
--help-env      : print help about Python environment variables and exit
--help-xoptions : print help about implementation-specific -X options and exit
--help-all      : print complete help information and exit
Arguments:
file   : program read from script file
-      : program read from stdin (default; interactive mode if a tty)
arg ...: arguments passed to program in sys.argv[1:]
`;

const MAN = `NAME
       python3 - an interpreted, interactive, object-oriented programming language

SYNOPSIS
       python3 [ -c command | -m module | script | - ] [ arguments ]

DESCRIPTION
       Runs Python 3.12 — real CPython, compiled to WebAssembly by the Pyodide
       project (${PYODIDE_VERSION}) and running inside this page. The first use
       downloads it from cdn.jsdelivr.net (about 6 MB); after that it comes
       from the browser cache.

       With no arguments and a terminal on stdin, starts the interactive
       interpreter. Otherwise runs a script file, a -c command, a -m module,
       or a program read from standard input.

WHAT A PROGRAM CAN SEE
       Files      your home directory, /tmp and the working directory, with
                  everything the program writes saved back to the desktop's
                  filesystem; /etc is readable, changes there are not kept.
       Input      input() reads the terminal; piped input works too:
                      echo 42 | python3 -c 'print(int(input()) * 2)'
       Modules    the standard library. As on a fresh Ubuntu, third-party
                  packages such as numpy are not installed.
       Network    sockets are not available in the browser.

LIMITS
       Ctrl+C stops the program by stopping the interpreter, so a
       KeyboardInterrupt cannot be caught, and in the interactive
       interpreter your variables are lost. subprocess, os.fork and
       threads that need real OS support are unavailable.

EXAMPLES
       python3                        interactive interpreter (Ctrl+D to leave)
       python3 hello.py               run a script
       python3 -c 'import sys; print(sys.version)'
       python3 -m json.tool data.json pretty-print JSON
       ./hello.py                     run a script with a #!/usr/bin/env python3 line`;

/* ------------------------------------------------------------------ *
 * the worker connection
 * ------------------------------------------------------------------ */

let shared = null;
let announced = false;

class PyWorker {
  constructor() {
    this.seq = 0;
    this.waiters = new Map();
    this.dead = false;
    this.busy = false;
    this.worker = new Worker(new URL('../python-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.receive(e.data || {});
    this.worker.onerror = (e) => {
      this.fail(new Error(e && e.message ? e.message : 'the Python worker could not start'));
      if (e && e.preventDefault) e.preventDefault();
    };
    const base = new URL('./', document.baseURI).href;
    this.ready = this.request({ type: 'init', base });
    this.ready.catch(() => { this.dead = true; });
  }

  request(msg, onEvent, transfer = []) {
    if (this.dead) return Promise.reject(new Error('the Python worker has stopped'));
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject, onEvent });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  receive(m) {
    const w = this.waiters.get(m.id);
    if (!w) return;
    if (m.type === 'ready' || m.type === 'done') {
      this.waiters.delete(m.id);
      w.resolve(m);
    } else if (m.type === 'fail') {
      this.waiters.delete(m.id);
      w.reject(new Error(m.message));
    } else if (w.onEvent) {
      w.onEvent(m);
    }
  }

  fail(err) {
    for (const w of this.waiters.values()) w.reject(err);
    this.waiters.clear();
  }

  terminate() {
    this.dead = true;
    this.worker.terminate();
    this.fail(new Error('terminated'));
    if (shared === this) shared = null;
  }
}

/** The shared interpreter if it is free, otherwise a private one for this run. */
function acquire() {
  if (!shared || shared.dead) shared = new PyWorker();
  if (!shared.busy) {
    shared.busy = true;
    return { w: shared, release: () => { if (shared) shared.busy = false; } };
  }
  const own = new PyWorker();
  return { w: own, release: () => own.terminate() };
}

/** Hand a line typed at the terminal to the worker blocked in input(). */
async function answerInput(key, value) {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  const target = sw.controller || (await sw.ready).active;
  if (target) target.postMessage({ type: 'uad-py-stdin', key, value });
}

/* ------------------------------------------------------------------ *
 * the filesystem snapshot
 * ------------------------------------------------------------------ */

function snapshotOf(fs, roots, extraFiles) {
  const files = [];
  const dirs = [];
  const transfer = [];
  const seen = new Set();
  const addFile = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    let st;
    try { st = fs.lstat(p); } catch { return; }
    if (st.isLink || st.isDir || st.size > MAX_FILE) return;
    let bytes;
    try { bytes = fs.readBytes(p); } catch { return; }
    files.push({ path: p, bytes });
    transfer.push(bytes.buffer);
  };
  const out = [];
  for (const root of roots) {
    if (!fs.exists(root.path) || !fs.isDir(root.path)) continue;
    out.push(root);
    let paths;
    try { paths = fs.walk(root.path); } catch { continue; }
    if (root.limit && paths.length > root.limit) paths = paths.slice(0, root.limit);
    for (const p of paths) {
      let st;
      try { st = fs.lstat(p); } catch { continue; }
      if (st.isLink) continue;
      if (st.isDir) dirs.push(p);
      else addFile(p);
    }
  }
  for (const p of extraFiles) addFile(p);
  return { snapshot: { roots: out, dirs, files }, transfer };
}

function rootsFor(ctx, extraDir) {
  const home = ctx.env.get('HOME') || ctx.home || '/home/ubuntu';
  const roots = [
    { path: home, writable: true },
    { path: '/tmp', writable: true },
    { path: '/etc', writable: false },
  ];
  const under = (p, r) => p === r || p.startsWith(`${r}/`);
  for (const d of [ctx.cwd, extraDir]) {
    if (!d || d === '/' || /^\/(proc|sys|dev)(\/|$)/.test(d)) continue;
    if (roots.some((r) => under(d, r.path))) continue;
    roots.push({ path: d, writable: !/^\/(usr|bin|sbin|lib|boot)(\/|$)/.test(d), limit: MAX_EXTRA_FILES });
  }
  return roots;
}

function applyChanges(fs, changes) {
  if (!changes) return;
  for (const d of changes.dirs || []) {
    try { if (!fs.exists(d)) fs.mkdir(d, { parents: true }); } catch { /* ignore */ }
  }
  for (const f of changes.changed || []) {
    try {
      const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
      if (!fs.exists(dir)) fs.mkdir(dir, { parents: true });
      fs.writeBytes(f.path, f.bytes);
    } catch { /* a path the desktop cannot hold */ }
  }
  for (const p of changes.deleted || []) {
    try { fs.rm(p, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

/* ------------------------------------------------------------------ *
 * output, with the prompt of input() held back
 * ------------------------------------------------------------------ */

/**
 * Program output goes to the terminal as it arrives. On a terminal, the
 * unfinished last line is held back: if the program then asks for input,
 * that text becomes the prompt the answer is typed after, as it would on a
 * real terminal.
 */
function makeSink(ctx) {
  const tty = ctx.stdoutIsTTY;
  let held = '';
  let stderr = '';
  return {
    out(text) {
      if (!tty) { ctx.term.write(text); return; }
      const all = held + text;
      const nl = all.lastIndexOf('\n');
      if (nl >= 0) {
        ctx.term.write(all.slice(0, nl + 1));
        held = all.slice(nl + 1);
      } else {
        held = all;
      }
    },
    err(text) {
      if (tty) this.out(text);
      else stderr += text;
    },
    takePrompt() {
      const p = held;
      held = '';
      return p;
    },
    finish() {
      if (held) ctx.term.write(held);
      held = '';
      return stderr;
    },
  };
}

/** ask() that also ends when Ctrl+C aborts the command. */
function askLine(ctx, prompt, allowEof) {
  return new Promise((resolve) => {
    let done = false;
    const onAbort = () => { if (!done) { done = true; resolve(null); } };
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(ctx.term.ask(prompt, { allowEof })).then((v) => {
      if (done) return;
      done = true;
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      resolve(v);
    });
  });
}

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { mode: null, source: null, args: [], inspect: false, quiet: false, version: 0, help: false, error: '' };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { i += 1; break; }
    if (a === '--version') { o.version += 1; continue; }
    if (a === '--help' || a === '--help-all' || a === '-?') { o.help = true; return o; }
    if (a === '--help-env' || a === '--help-xoptions') { o.help = true; return o; }
    if (a === '-' || !a.startsWith('-')) break;
    // a cluster such as -qi or -c'code'
    for (let k = 1; k < a.length; k += 1) {
      const ch = a[k];
      if (ch === 'c' || ch === 'm') {
        const rest = a.slice(k + 1);
        let value = rest;
        if (value === '') {
          i += 1;
          if (i >= argv.length) { o.error = `Argument expected for the -${ch} option`; return o; }
          value = argv[i];
        }
        o.mode = ch === 'c' ? 'code' : 'module';
        o.source = value;
        o.args = argv.slice(i + 1);
        return o;
      }
      if (ch === 'W' || ch === 'X') {
        if (a.slice(k + 1) === '') i += 1;
        break;
      }
      if (ch === 'V') { o.version += 1; continue; }
      if (ch === 'h') { o.help = true; return o; }
      if (ch === 'i') { o.inspect = true; continue; }
      if (ch === 'q') { o.quiet = true; continue; }
      if ('bBdEIOPsSuvx'.includes(ch)) continue;
      o.error = `unknown option -${ch}`;
      return o;
    }
  }
  const rest = argv.slice(i);
  if (rest.length) {
    o.mode = rest[0] === '-' ? 'stdin' : 'script';
    o.source = rest[0];
    o.args = rest.slice(1);
  }
  return o;
}

/* ------------------------------------------------------------------ *
 * the command
 * ------------------------------------------------------------------ */

const python3 = {
  name: 'python3',
  aliases: ['python3.12'],
  synopsis: 'python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...',
  description: 'an interpreted, interactive, object-oriented programming language',
  man: MAN,

  async run(ctx) {
    const o = parseArgs(ctx.argv);
    if (o.error) {
      return fail(`${o.error}\nusage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry \`python -h' for more information.\n`, 2);
    }
    if (o.help) return ok(USAGE);
    if (o.version === 1) return ok(`Python ${PYTHON_VERSION}\n`);
    if (o.version > 1) return ok(`Python ${PYTHON_VERSION} (main, Pyodide ${PYODIDE_VERSION}) [Clang, Emscripten, WebAssembly]\n`);

    if (!o.mode) o.mode = ctx.stdin ? 'stdin' : 'repl';

    // Resolve the program before paying for the interpreter.
    let source = o.source;
    let filename = '<string>';
    let argv0 = '-c';
    let extraDir = null;
    const extraFiles = [];
    if (o.mode === 'script') {
      const abs = ctx.fs.resolve(o.source, ctx.cwd);
      if (!ctx.fs.exists(abs)) {
        return fail(`python3: can't open file '${abs}': [Errno 2] No such file or directory\n`, 2);
      }
      if (ctx.fs.isDir(abs)) {
        return fail(`python3: can't find '__main__' module in '${abs}'\n`, 1);
      }
      source = ctx.fs.readFile(abs);
      filename = abs;
      argv0 = o.source;
      extraDir = abs.slice(0, abs.lastIndexOf('/')) || '/';
      extraFiles.push(abs);
    } else if (o.mode === 'stdin') {
      source = ctx.stdin || '';
      filename = '<stdin>';
      argv0 = o.source === '-' ? '-' : '';
    } else if (o.mode === 'module') {
      argv0 = '-m';
    }

    const { w, release } = acquire();
    const sink = makeSink(ctx);
    let interrupted = false;
    const onAbort = () => {
      interrupted = true;
      w.terminate();
    };
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

    const onEvent = async (m) => {
      if (m.type === 'out') sink.out(m.text);
      else if (m.type === 'err') sink.err(m.text);
      else if (m.type === 'input') {
        const prompt = ctx.stdoutIsTTY ? sink.takePrompt() : '';
        const line = await askLine(ctx, prompt, true);
        if (line === null) {
          await answerInput(m.key, { eof: true });
          onAbort();
          return;
        }
        await answerInput(m.key, line === undefined ? { eof: true } : { line: `${line}\n` });
      }
    };

    try {
      if (!announced && ctx.stdoutIsTTY) {
        const slow = setTimeout(() => {
          ctx.term.write(`\x1b[2m(loading Python ${PYTHON_VERSION} — Pyodide ${PYODIDE_VERSION}, about 6 MB from cdn.jsdelivr.net the first time)\x1b[0m\n`);
        }, 400);
        try { await w.ready; } finally { clearTimeout(slow); }
      } else {
        await w.ready;
      }
      announced = true;
    } catch (err) {
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      release();
      if (interrupted) return { stdout: '', stderr: 'KeyboardInterrupt\n', code: 130 };
      return fail(`python3: could not load Python (Pyodide ${PYODIDE_VERSION} from cdn.jsdelivr.net): ${err.message}\n`
        + 'python3: this needs a network connection the first time.\n', 1);
    }

    const env = ctx.env.all();
    const roots = rootsFor(ctx, extraDir);
    let code = 0;
    try {
      if (o.mode !== 'repl') {
        const { snapshot, transfer } = snapshotOf(ctx.fs, roots, extraFiles);
        const done = await w.request({
          type: 'run',
          kind: o.mode,
          source,
          filename,
          argv: [argv0, ...o.args],
          cwd: ctx.cwd,
          env,
          stdin: o.mode === 'stdin' ? '' : (ctx.stdin ? ctx.stdin : null),
          tty: ctx.stdoutIsTTY,
          inspect: o.inspect,
          snapshot,
        }, onEvent, transfer);
        applyChanges(ctx.fs, done.changes);
        code = done.code;
        if (!o.inspect) return { stdout: '', stderr: sink.finish(), code };
      }

      // The interactive interpreter (also after `-i script`).
      let snapshotMsg = {};
      if (o.mode === 'repl') {
        const { snapshot, transfer } = snapshotOf(ctx.fs, roots, extraFiles);
        snapshotMsg = { snapshot, transfer };
      }
      const start = await w.request({
        type: 'repl-start',
        argv: [''],
        cwd: ctx.cwd,
        env,
        inspect: o.inspect,
        tty: ctx.stdoutIsTTY,
        snapshot: snapshotMsg.snapshot || null,
      }, onEvent, snapshotMsg.transfer || []);
      if (!o.quiet && o.mode === 'repl') sink.out(`${start.banner}\n`);

      let more = false;
      for (;;) {
        const line = await askLine(ctx, sink.takePrompt() + (more ? '... ' : '>>> '), true);
        if (interrupted || (ctx.signal && ctx.signal.aborted)) break;
        if (line === null) {
          sink.out('KeyboardInterrupt\n');
          more = false;
          await w.request({ type: 'repl-reset' });
          continue;
        }
        if (line === undefined) {
          sink.out('\n');
          break;
        }
        const r = await w.request({ type: 'repl-line', line }, onEvent);
        applyChanges(ctx.fs, r.changes);
        if (r.exit !== null && r.exit !== undefined) { code = r.exit; break; }
        more = r.more;
      }
      return { stdout: '', stderr: sink.finish(), code };
    } catch (err) {
      if (interrupted) {
        const tail = sink.finish();
        return { stdout: '', stderr: `${tail}${tail && !tail.endsWith('\n') ? '\n' : ''}KeyboardInterrupt\n`, code: 130 };
      }
      return { stdout: '', stderr: `${sink.finish()}python3: ${err.message}\n`, code: 1 };
    } finally {
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      if (!interrupted) release();
    }
  },
};

export default [python3];
