/**
 * python-worker.js — CPython 3.12 (Pyodide) in a dedicated Web Worker.
 *
 * Python runs here so a busy or endless program cannot freeze the page:
 * Ctrl+C terminates this worker. The page (commands/python.js) sends:
 *
 *   {type:'init', id, base}                         → {type:'ready', version, channel}
 *   {type:'run',  id, kind, source, filename, argv, cwd, env, stdin, tty, inspect, snapshot}
 *                                                   → {type:'done', code, changes}
 *   {type:'repl-start', id, cwd, env, argv, inspect, snapshot, tty} → {type:'done', banner}
 *   {type:'repl-line',  id, line}                   → {type:'done', more, exit, changes}
 *   {type:'repl-reset', id}                         → {type:'done'}
 *
 * and receives, while a request runs:
 *   {type:'out'|'err', id, text}                    program output
 *   {type:'input', id, key}                         Python is blocked reading the terminal
 *
 * Files: the page sends a snapshot of the parts of the virtual filesystem a
 * program may touch (home, /tmp, /etc read-only, the working directory); it
 * is written into Pyodide's in-memory filesystem before the run, and what
 * the program created, changed or deleted is sent back afterwards.
 *
 * Blocking: input() and time.sleep() make a synchronous XMLHttpRequest that
 * the service worker (/sw.js) holds open — see the comment there.
 */

const PYODIDE_VERSION = '0.27.7';
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let py = null;
let base = '';
let channel = false;
/** The request being served: output buffers, stdin, the filesystem baseline. */
let job = null;
/** Baseline of the synced filesystem, kept across REPL lines. */
let tree = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

/* ------------------------------------------------------------------ *
 * output
 * ------------------------------------------------------------------ */

function makeJob(id, stdin) {
  return {
    id,
    stdin,                      // string (piped) or null (the terminal)
    stdinUsed: false,
    inputSeq: 0,
    warned: false,
    dec: { out: new TextDecoder(), err: new TextDecoder() },
    buf: { out: '', err: '' },
    last: 0,                    // so the first write of a run is sent at once
  };
}

function flush() {
  if (!job) return;
  for (const stream of ['out', 'err']) {
    if (job.buf[stream]) {
      post({ type: stream, id: job.id, text: job.buf[stream] });
      job.buf[stream] = '';
    }
  }
  job.last = Date.now();
}

/**
 * Output leaves at once unless it is part of a rapid burst. Text still
 * buffered when the program then loops forever would be lost on Ctrl+C
 * (the worker is terminated), so only writes within 16 ms of the previous
 * flush wait, and the first write after any pause always goes out.
 */
function writeBytes(stream, bytes) {
  if (!job) return bytes.length;
  job.buf[stream] += job.dec[stream].decode(bytes, { stream: true });
  if (job.buf.out.length + job.buf.err.length > 8192 || Date.now() - job.last >= 16) flush();
  return bytes.length;
}

function note(text) {
  if (!job) return;
  job.buf.err += text;
  flush();
}

/* ------------------------------------------------------------------ *
 * blocking: stdin and sleep through the service worker
 * ------------------------------------------------------------------ */

function syncGet(url) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.send();
  return xhr;
}

function probeChannel() {
  try {
    const xhr = syncGet(`${base}__uad_py__/ping`);
    return xhr.status === 200 && xhr.responseText === 'pong';
  } catch {
    return false;
  }
}

/** Pyodide's stdin callback: a chunk of text, or null for end of file. */
function readStdin() {
  if (!job) return null;
  if (job.stdin !== null) {
    if (job.stdinUsed || job.stdin === '') return null;
    job.stdinUsed = true;
    return job.stdin;
  }
  flush();
  if (!channel) {
    if (!job.warned) {
      job.warned = true;
      note('python3: input() cannot read the terminal: the page\'s input channel (a service worker) is not running.\n'
        + 'python3: reload the page once, or pipe the input instead:  echo 42 | python3 script.py\n');
    }
    return null;
  }
  job.inputSeq += 1;
  const key = `${job.id}-${job.inputSeq}-${Math.random().toString(36).slice(2, 8)}`;
  post({ type: 'input', id: job.id, key });
  for (;;) {
    let reply;
    try {
      reply = JSON.parse(syncGet(`${base}__uad_py__/stdin/${key}`).responseText);
    } catch {
      return null;
    }
    if (reply.retry) continue;
    if (reply.eof) return null;
    return typeof reply.line === 'string' ? reply.line : null;
  }
}

function sleepMs(ms) {
  flush();
  let left = Math.max(0, Number(ms) || 0);
  if (channel) {
    while (left > 0) {
      const step = Math.min(left, 200000);
      try { syncGet(`${base}__uad_py__/sleep/${Math.round(step)}`); } catch { break; }
      left -= step;
    }
    return;
  }
  const end = Date.now() + left;
  while (Date.now() < end) { /* no service worker: spin */ }
}

/* ------------------------------------------------------------------ *
 * filesystem mirroring
 * ------------------------------------------------------------------ */

const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

function exists(p) {
  return py.FS.analyzePath(p).exists;
}

function removeTree(p, keepSelf) {
  const FS = py.FS;
  if (!exists(p)) return;
  const st = FS.lstat(p);
  if (FS.isDir(st.mode)) {
    for (const name of FS.readdir(p)) {
      if (name === '.' || name === '..') continue;
      removeTree(`${p === '/' ? '' : p}/${name}`, false);
    }
    if (!keepSelf) FS.rmdir(p);
  } else {
    FS.unlink(p);
  }
}

function walk(root, visit) {
  const FS = py.FS;
  if (!exists(root)) return;
  const st = FS.lstat(root);
  if (FS.isLink(st.mode)) return;
  if (!FS.isDir(st.mode)) { visit(root, false); return; }
  visit(root, true);
  for (const name of FS.readdir(root)) {
    if (name === '.' || name === '..') continue;
    walk(`${root === '/' ? '' : root}/${name}`, visit);
  }
}

/** Replace the mirrored roots with the page's snapshot. */
function syncIn(snapshot) {
  const FS = py.FS;
  tree = { writable: [], files: new Map(), dirs: new Set() };
  for (const root of snapshot.roots) {
    removeTree(root.path, true);
    FS.mkdirTree(root.path);
    if (root.writable) tree.writable.push(root.path);
  }
  const writable = (p) => tree.writable.some((r) => p === r || p.startsWith(`${r}/`));
  for (const d of snapshot.dirs) {
    FS.mkdirTree(d);
    if (writable(d)) tree.dirs.add(d);
  }
  for (const f of snapshot.files) {
    FS.mkdirTree(dirOf(f.path));
    FS.writeFile(f.path, f.bytes);
    if (writable(f.path)) tree.files.set(f.path, f.bytes);
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** What the program changed under the writable roots since the baseline. */
function syncOut() {
  if (!tree) return { changes: { changed: [], deleted: [], dirs: [] }, transfer: [] };
  const FS = py.FS;
  const changed = [];
  const dirs = [];
  const transfer = [];
  const nowFiles = new Map();
  const nowDirs = new Set();
  for (const root of tree.writable) {
    walk(root, (p, isDir) => {
      if (isDir) {
        nowDirs.add(p);
        if (!tree.dirs.has(p)) dirs.push(p);
        return;
      }
      const bytes = FS.readFile(p);
      nowFiles.set(p, bytes);
      const before = tree.files.get(p);
      if (!before || !sameBytes(before, bytes)) {
        const copy = bytes.slice();
        changed.push({ path: p, bytes: copy });
        transfer.push(copy.buffer);
      }
    });
  }
  const deleted = [];
  for (const p of tree.files.keys()) if (!nowFiles.has(p)) deleted.push(p);
  for (const d of tree.dirs) if (!nowDirs.has(d)) deleted.push(d);
  tree.files = nowFiles;
  tree.dirs = nowDirs;
  return { changes: { changed, deleted, dirs }, transfer };
}

/* ------------------------------------------------------------------ *
 * the Python side
 * ------------------------------------------------------------------ */

const HELPER = `
import sys, os, traceback, runpy, time, types, code as _code
import _uad

def _sleep(secs):
    if not isinstance(secs, (int, float)):
        raise TypeError("'%s' object cannot be interpreted as an integer" % type(secs).__name__)
    if secs < 0:
        raise ValueError("sleep length must be non-negative")
    _uad.sleep(secs * 1000)

time.sleep = _sleep
sys.executable = '/usr/bin/python3'
_USER = ('/home/', '/tmp/')
_inspect_ns = None
_console = None

def _fresh_streams():
    # Each run gets new standard streams: a program may close them (json.tool
    # closes sys.stdout on the way out) and the interpreter outlives it.
    tty = os.isatty(1)
    sys.stdin = open(0, 'r', encoding='utf-8', closefd=False)
    sys.stdout = open(1, 'w', encoding='utf-8', closefd=False, buffering=1 if tty else -1)
    sys.stderr = open(2, 'w', encoding='utf-8', errors='backslashreplace', closefd=False, buffering=1)

def _prepare(argv, cwd, env):
    _fresh_streams()
    for k in list(os.environ):
        if k not in env:
            del os.environ[k]
    os.environ.update(env)
    os.environ.setdefault('LANG', 'C.UTF-8')
    for d in (cwd, os.environ.get('HOME', '/'), '/'):
        try:
            os.chdir(d)
            break
        except OSError:
            pass
    sys.argv = list(argv)

def _forget(before):
    for name in list(sys.modules):
        if name in before:
            continue
        f = getattr(sys.modules.get(name), '__file__', None) or ''
        if f.startswith(_USER):
            del sys.modules[name]

def _exit_code(e):
    c = e.code
    if c is None:
        return 0
    if isinstance(c, int):
        return c & 0xff
    try:
        print(c, file=sys.stderr)
    except Exception:
        pass
    return 1

def _print_exc():
    etype, value, tb = sys.exc_info()
    while tb is not None and tb.tb_frame.f_code.co_filename == '<uad>':
        tb = tb.tb_next
    traceback.print_exception(etype, value, tb)

def _flush():
    for s in (sys.stdout, sys.stderr):
        try:
            s.flush()
        except Exception:
            pass

def _run(kind, source, filename, argv, cwd, env, inspect):
    global _inspect_ns
    _prepare(argv, cwd, env)
    before = set(sys.modules)
    saved_path = list(sys.path)
    saved_main = sys.modules.get('__main__')
    if kind == 'script':
        sys.path.insert(0, os.path.dirname(os.path.abspath(filename)))
    elif kind == 'module':
        sys.path.insert(0, os.getcwd())
    else:
        sys.path.insert(0, '')
    main = types.ModuleType('__main__')
    main.__dict__.update({'__builtins__': __builtins__, '__package__': None, '__spec__': None, '__loader__': None})
    if kind == 'script':
        main.__file__ = filename
    status = 0
    try:
        if kind == 'module':
            runpy.run_module(source, run_name='__main__', alter_sys=True)
        else:
            sys.modules['__main__'] = main
            exec(compile(source, filename, 'exec'), main.__dict__)
    except SystemExit as e:
        status = _exit_code(e)
    except BaseException:
        _print_exc()
        status = 1
    finally:
        _flush()
        sys.path[:] = saved_path
        if saved_main is not None:
            sys.modules['__main__'] = saved_main
        _forget(before)
    _inspect_ns = main.__dict__ if inspect else None
    return status

def _repl_start(argv, cwd, env, inspect):
    global _console
    _prepare(argv, cwd, env)
    if inspect and _inspect_ns is not None:
        ns = _inspect_ns
    else:
        ns = {'__name__': '__main__', '__doc__': None, '__builtins__': __builtins__}
    if '' not in sys.path:
        sys.path.insert(0, '')
    sys.ps1, sys.ps2 = '>>> ', '... '
    _console = _code.InteractiveConsole(ns, filename='<stdin>')
    return 'Python %s on %s\\nType "help", "copyright", "credits" or "license" for more information.' % (sys.version, sys.platform)

def _repl_push(line):
    # -1: more input needed; -2: done; >= 0: the program exited with that status
    try:
        more = _console.push(line)
    except SystemExit as e:
        _flush()
        return _exit_code(e)
    _flush()
    return -1 if more else -2

def _repl_reset():
    if _console is not None:
        _console.resetbuffer()
`;

let fns = null;

async function init(msg) {
  base = msg.base;
  const { loadPyodide } = await import(`${INDEX_URL}pyodide.mjs`);
  py = await loadPyodide({ indexURL: INDEX_URL });
  channel = probeChannel();
  py.registerJsModule('_uad', { sleep: sleepMs });
  py.runPython(HELPER, { filename: '<uad>' });
  const g = py.globals;
  fns = { run: g.get('_run'), start: g.get('_repl_start'), push: g.get('_repl_push'), reset: g.get('_repl_reset') };
  const version = py.runPython('import sys; sys.version');
  return { version, channel };
}

/**
 * stdin is presented as a plain stream: CPython's input() then writes its
 * prompt to stdout and flushes before reading (on a tty it would go through
 * PyOS_Readline, which prints the prompt to stderr without GNU readline).
 */
function configure(tty) {
  py.setStdout({ write: (b) => writeBytes('out', b), isatty: tty });
  py.setStderr({ write: (b) => writeBytes('err', b), isatty: tty });
  py.setStdin({ stdin: readStdin, autoEOF: true, isatty: false });
}

function toPy(value) {
  return py.toPy(value);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'init': {
        const info = await init(msg);
        post({ type: 'ready', id: msg.id, ...info });
        return;
      }
      case 'run': {
        job = makeJob(msg.id, typeof msg.stdin === 'string' ? msg.stdin : null);
        configure(msg.tty);
        syncIn(msg.snapshot);
        const argv = toPy(msg.argv);
        const env = toPy(msg.env);
        let code;
        try {
          code = fns.run(msg.kind, msg.source, msg.filename, argv, msg.cwd, env, !!msg.inspect);
        } finally {
          argv.destroy();
          env.destroy();
        }
        flush();
        const { changes, transfer } = syncOut();
        job = null;
        post({ type: 'done', id: msg.id, code, changes }, transfer);
        return;
      }
      case 'repl-start': {
        job = makeJob(msg.id, null);
        configure(msg.tty);
        if (msg.snapshot) syncIn(msg.snapshot);
        const argv = toPy(msg.argv);
        const env = toPy(msg.env);
        let banner;
        try {
          banner = fns.start(argv, msg.cwd, env, !!msg.inspect);
        } finally {
          argv.destroy();
          env.destroy();
        }
        flush();
        job = null;
        post({ type: 'done', id: msg.id, banner });
        return;
      }
      case 'repl-line': {
        job = makeJob(msg.id, null);
        const r = fns.push(msg.line);
        flush();
        const { changes, transfer } = syncOut();
        job = null;
        post({ type: 'done', id: msg.id, more: r === -1, exit: r >= 0 ? r : null, changes }, transfer);
        return;
      }
      case 'repl-reset':
        fns.reset();
        post({ type: 'done', id: msg.id });
        return;
      default:
        post({ type: 'fail', id: msg.id, message: `unknown request ${msg.type}` });
    }
  } catch (err) {
    flush();
    job = null;
    post({ type: 'fail', id: msg.id, message: err && err.message ? err.message : String(err) });
  }
};
