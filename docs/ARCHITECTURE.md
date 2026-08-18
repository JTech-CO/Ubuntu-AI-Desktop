# Ubuntu AI Desktop — Architecture Contract

This document is **normative**. Every module in this project MUST conform to the APIs
declared here. If you are implementing a module, read this file first and do not invent
alternative signatures.

Target: **static hosting on GitHub Pages**. No build step, no bundler, no npm.
Everything is native ES modules (`<script type="module">`) + plain CSS.

---

## 0. Ground rules

1. **ES modules only.** Every `.js` file uses `import`/`export`. Relative paths with
   explicit `.js` extension (`import { fs } from '../../core/fs.js'`). No bare specifiers.
2. **No global leakage.** Do not attach to `window` except the single debug handle
   `window.UAD` assigned in `js/main.js`.
3. **No inline event handlers in HTML.** `onclick="..."` is banned. All wiring is done in
   JS with `addEventListener`.
4. **Never inject untrusted text via `innerHTML`.** AI responses, file contents, filenames,
   and user input go through `textContent` or the safe helpers in `js/core/dom.js`.
   `innerHTML` is only allowed for literal, developer-authored template strings that
   interpolate nothing.
5. **Strict mode is implicit** in modules. Use `const`/`let`, never `var`.
6. **No `event` global.** Handlers receive their event as an argument.
7. **Ubuntu fidelity over invention.** When choosing colours, spacing, wording, command
   output format, or icon shape, match real Ubuntu 24.04 LTS / GNOME 46 / Yaru.

---

## 1. Directory layout

```
index.html                 # ~50 lines: shell skeleton + <link>/<script> tags only
docs/ARCHITECTURE.md       # this file
css/
  base/tokens.css          # CSS custom properties (Yaru palette, spacing, z-index scale)
  base/reset.css           # box-sizing, margins, scrollbars, selection
  base/typography.css      # Ubuntu / Ubuntu Mono font stacks
  shell/top-bar.css
  shell/dock.css
  shell/window.css
  shell/system-menu.css
  shell/overview.css
  shell/notifications.css
  shell/context-menu.css
  shell/dialog.css
  apps/terminal.css
  apps/files.css
  apps/settings.css
  apps/monitor.css
  apps/editor.css
  apps/firefox.css
  apps/codeoss.css
  apps/calculator.css
js/
  main.js                  # boot sequence
  core/bus.js
  core/store.js
  core/dom.js
  core/path.js
  core/fs.js
  core/env.js
  core/users.js
  core/procs.js
  core/metrics.js
  core/notify.js
  core/dialog.js
  services/gemini.js
  shell/window-manager.js
  shell/top-bar.js
  shell/dock.js
  shell/system-menu.js
  shell/overview.js
  shell/context-menu.js
  shell/keybindings.js
  apps/registry.js
  apps/<app>/index.js      # one folder per app
  apps/terminal/shell.js       # tokenizer + parser + executor
  apps/terminal/readline.js    # line editing, history, completion
  apps/terminal/ansi.js        # ANSI SGR -> safe DOM spans
  apps/terminal/commands/*.js  # command implementations
legacy/                    # original single-file versions, kept for reference
```

---

## 2. `js/core/bus.js` — event bus

```js
export const bus = {
  on(event, handler),        // -> unsubscribe fn
  once(event, handler),      // -> unsubscribe fn
  off(event, handler),
  emit(event, payload),      // handlers are called synchronously; throws are caught+logged
};
```

Canonical event names (emit these, listen for these):

| Event | Payload |
| --- | --- |
| `fs:change` | `{ op, path, to? }` — `op` ∈ `write,mkdir,unlink,rmdir,rename,chmod,restore` |
| `fs:trash` | `{ path, entry }` |
| `win:open` | `{ appId, instanceId }` |
| `win:close` | `{ appId, instanceId }` |
| `win:focus` | `{ appId, instanceId }` |
| `win:minimize` / `win:restore` | `{ appId, instanceId }` |
| `win:maximize` / `win:unmaximize` | `{ appId, instanceId }` |
| `proc:spawn` / `proc:exit` | `{ pid, name }` |
| `settings:change` | `{ key, value }` |
| `net:online` / `net:offline` | `{}` |
| `ai:request` | `{ id, prompt }` |
| `ai:response` | `{ id, ms, chars }` |
| `ai:error` | `{ id, message }` |
| `session:poweroff` / `session:restart` / `session:lock` | `{}` |

---

## 3. `js/core/store.js` — persistence

Namespaced `localStorage` wrapper. All keys are prefixed `uad:` internally.

```js
export const store = {
  get(key, fallback = null),   // JSON-parsed; returns fallback on miss/parse error
  set(key, value),             // JSON-stringified; silently no-ops on quota error
  remove(key),
  keys(),                      // -> string[] (un-prefixed)
  clear(),
};
```

Reserved keys: `fs`, `settings`, `apikey`, `history`, `wallpaper`, `trash`, `firstrun`.

---

## 4. `js/core/dom.js` — DOM helpers

```js
export function h(tag, props = {}, ...children);
// tag: 'div', 'div.class', 'div#id.class'  (CSS-ish shorthand)
// props: { class, id, text, html, style: {}, dataset: {}, on: { click: fn }, ...attrs }
//   - `text` sets textContent (SAFE, preferred)
//   - `html` sets innerHTML (only for literal developer strings)
// children: strings (appended as text nodes) or Nodes; null/undefined/false skipped
// -> HTMLElement

export function svg(pathData, opts = {});      // -> SVGElement, 24x24 viewBox, stroke-based
export function el(sel, root = document);      // -> Element | null
export function els(sel, root = document);     // -> Element[]
export function clear(node);                   // remove all children
export function escapeHtml(str);               // -> string
export function frag(...children);             // -> DocumentFragment
export function on(target, event, handler, opts);  // -> unsubscribe fn
export function delegate(root, sel, event, handler); // -> unsubscribe fn
```

---

## 5. `js/core/path.js` — POSIX path utilities

```js
export function isAbsolute(p);
export function normalize(p);              // collapses . .. //, keeps leading /
export function join(...parts);
export function resolve(cwd, p);           // -> absolute normalized path; expands nothing
export function dirname(p);
export function basename(p, ext);
export function extname(p);                // -> '.txt' or ''
export function split(p);                  // -> string[] of segments
export function relative(from, to);
export function contract(p, home);         // '/home/ubuntu/x' -> '~/x'
export function expandTilde(p, home);      // '~/x' -> '/home/ubuntu/x'
```

---

## 6. `js/core/fs.js` — virtual filesystem

The single source of truth for Terminal, Files, Text Editor, Code-OSS and Trash.

### Node shape (internal)

```js
{ type: 'dir' | 'file' | 'link',
  name, mode,            // mode is an octal number, e.g. 0o755
  owner: 'ubuntu', group: 'ubuntu',
  mtime,                 // epoch ms
  children: {},          // dir only, name -> node
  content: '',           // file only
  target: '' }           // link only
```

### Errors

```js
export class FsError extends Error {
  constructor(code, path, message);
  code;   // 'ENOENT' | 'EEXIST' | 'EISDIR' | 'ENOTDIR' | 'ENOTEMPTY' | 'EACCES' | 'EINVAL' | 'ELOOP'
  path;
}
```
Commands catch `FsError` and print the exact GNU coreutils phrasing, e.g.
`ls: cannot access 'foo': No such file or directory`.

### API

```js
export const fs = {
  // --- read ---
  exists(p),                       // -> boolean
  stat(p),                         // -> { path, name, type, mode, owner, group, size, mtime, isDir, isFile, isLink }  (follows links)
  lstat(p),                        // -> same, does not follow links
  readdir(p, { withStats = false } = {}),  // -> string[] | StatObject[]
  readFile(p),                     // -> string
  readlink(p),                     // -> string
  isDir(p), isFile(p),
  du(p),                           // -> total bytes
  glob(pattern, cwd),              // -> string[] absolute paths; supports * ? [abc] and **

  // --- write (each emits bus 'fs:change' and schedules a persist) ---
  writeFile(p, content, { append = false, create = true } = {}),
  mkdir(p, { parents = false } = {}),
  rmdir(p),
  unlink(p),
  rm(p, { recursive = false, force = false } = {}),
  cp(src, dst, { recursive = false } = {}),
  mv(src, dst),
  touch(p),
  symlink(target, p),
  chmod(p, mode),

  // --- trash (freedesktop.org semantics) ---
  trash(p),                        // -> moves into /home/ubuntu/.local/share/Trash/files + writes .trashinfo
  listTrash(),                     // -> [{ name, originalPath, deletedAt, type, size }]
  restoreFromTrash(name),
  emptyTrash(),

  // --- lifecycle ---
  snapshot(),                      // -> plain JSON tree
  restore(json),
  reset(),                         // rebuild the pristine Ubuntu tree
  persist(),                       // force immediate save (normally debounced 400ms)
};
```

### Default tree (must be present on `reset()`)

Directories: `/bin`→link→`/usr/bin`, `/boot`, `/dev`, `/etc`, `/home/ubuntu`, `/lib`→`/usr/lib`,
`/media`, `/mnt`, `/opt`, `/proc`, `/root`, `/run`, `/sbin`→`/usr/sbin`, `/srv`, `/sys`,
`/tmp`, `/usr/{bin,lib,local,sbin,share}`, `/var/{cache,lib,log,tmp}`.

Home: `Desktop Documents Downloads Music Pictures Public Templates Videos`
plus `.bashrc .profile .bash_history .bash_logout .config/ .local/share/Trash/{files,info}`,
`Documents/notes.md`, `Documents/todo.txt`, `Downloads/ubuntu-24.04.1-desktop-amd64.iso` (fake size),
`Desktop/welcome.txt`, `~/hello.py`, `~/README.md`.

`/etc`: `os-release lsb-release hostname hosts passwd group shells fstab resolv.conf issue`.
Contents must be realistic Ubuntu 24.04 LTS (Noble Numbat) text.

`/proc`: `cpuinfo meminfo version uptime loadavg` — generated dynamically where it makes
sense (`uptime`, `loadavg`, `meminfo` reflect `procs`/`metrics`).

`/var/log`: `syslog auth.log dpkg.log`.

---

## 7. `js/core/env.js` — shell environment

```js
export const env = {
  get(name), set(name, value), unset(name),
  all(),                     // -> plain object copy
  expand(str),               // $VAR, ${VAR}, $?, ~ at token start
  cwd, home, user, host,     // live getters
  setCwd(p),
  lastExit,                  // $?
};
```
Defaults: `HOME=/home/ubuntu`, `USER=ubuntu`, `LOGNAME=ubuntu`, `SHELL=/bin/bash`,
`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games`,
`TERM=xterm-256color`, `LANG=en_US.UTF-8`, `PWD=/home/ubuntu`, `HOSTNAME=ubuntu-ai`.

---

## 8. `js/core/users.js`

```js
export const users = {
  current: { name: 'ubuntu', uid: 1000, gid: 1000, gecos: 'Ubuntu User', home: '/home/ubuntu', shell: '/bin/bash' },
  hostname: 'ubuntu-ai',
  sudoUnlocked,              // boolean, expires after 15 min like real sudo
  unlockSudo(password),      // -> boolean; accepted password is 'ubuntu'
  passwdFile(),              // -> /etc/passwd contents
  groupFile(),
};
```

---

## 9. `js/core/procs.js` — process table

Backs `ps`, `top`, `kill`, `pidof`, and the System Monitor.

```js
export const procs = {
  spawn({ name, cmd, user = 'ubuntu', cpu = 0, mem = 0, ppid = 1 }),  // -> pid
  kill(pid, signal = 15),    // -> boolean
  get(pid),
  find(name),                // -> proc[]
  list(),                    // -> [{ pid, ppid, user, name, cmd, cpu, mem, state, startedAt, cpuTime }]
  totals(),                  // -> { cpu, memUsedMb, memTotalMb, swapUsedMb, swapTotalMb, procCount, load: [1,5,15] }
  tick(),                    // advance simulation; called by a single 1s interval in main.js
  bindWindow(appId, pid),    // associate an app window with a pid so closing it kills the proc
};
```
Baseline daemons that must exist at boot (realistic pids and names): `systemd(1)`,
`kthreadd(2)`, `systemd-journald`, `systemd-udevd`, `systemd-resolved`, `dbus-daemon`,
`NetworkManager`, `snapd`, `cron`, `rsyslogd`, `gdm3`, `Xorg`, `gnome-shell`,
`gnome-terminal-`, `pipewire`, `wireplumber`.

---

## 10. `js/core/metrics.js`

```js
export const metrics = {
  recordRequest(ms, chars),
  latency(),                 // -> number[] rolling 60 samples
  throughput(),              // -> number[] tokens/s rolling 60
  cpuHistory(), memHistory(), netHistory(),
  push(series, value),
  last(series),
  totals(),                  // -> { requests, errors, avgMs, totalChars }
};
```

---

## 11. `js/core/notify.js` — GNOME notifications

```js
export const notify = {
  show({ app = 'System', title, body = '', icon = '', timeout = 4000, actions = [] }),  // -> id
  dismiss(id),
  list(),        // for the calendar/notification tray
  clearAll(),
};
```
Body/title are inserted with `textContent`. `actions` = `[{ label, onClick }]`.

---

## 12. `js/core/dialog.js` — modal dialogs (GNOME/Adwaita style)

```js
export const dialog = {
  alert({ title, body, okLabel = 'OK' }),                    // -> Promise<void>
  confirm({ title, body, okLabel = 'OK', destructive = false }), // -> Promise<boolean>
  prompt({ title, body, value = '', placeholder = '', password = false }), // -> Promise<string|null>
};
```

---

## 13. `js/services/gemini.js`

```js
export const gemini = {
  hasKey(),                  // -> boolean
  getKey(), setKey(k), clearKey(),
  model,                     // default 'gemini-2.5-flash'
  setModel(m),

  generate(prompt, { system, temperature, json = false, signal } = {}),  // -> Promise<string>
  generateJSON(prompt, { system, signal } = {}),                         // -> Promise<any>
  stream(prompt, onChunk, opts),                                         // -> Promise<string>
};
```
Behaviour:
- Key is read from `store.get('apikey')`. **Never hard-code a key.**
- On missing key, throw `new Error('NO_API_KEY')`; callers surface a friendly prompt that
  opens Settings.
- Emits `ai:request` / `ai:response` / `ai:error` and calls `metrics.recordRequest`.
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=…`
- Handles HTTP errors by throwing `new Error(\`HTTP ${status}: ${apiMessage}\`)`.

---

## 14. `js/shell/window-manager.js`

Windows are **created dynamically** from a template. There is no per-app window markup in
`index.html`.

```js
export const wm = {
  register(appDef),                 // appDef = the default export of an app module (see §16)
  open(appId, args = {}),           // -> instanceId; focuses if already open and singleton
  close(appId | instanceId),
  focus(id), minimize(id), restore(id),
  maximize(id), unmaximize(id), toggleMaximize(id),
  isOpen(appId),
  instances(),                      // -> [{ id, appId, title, minimized, maximized }]
  active(),                         // -> instanceId | null
  setTitle(id, title),
  cycle(dir = 1),                   // Alt+Tab
  tile(id, 'left' | 'right'),       // Super+Left/Right half-tiling
};
```

Window chrome requirements (Yaru / GNOME 46):
- Header bar height 38px, rounded top corners 12px, title centred and bold-ish (600).
- Controls on the **right**, GNOME order: minimize `−`, maximize `□`, close `×`, drawn as
  36px circular buttons that show a subtle background on hover, close turns Ubuntu orange.
- Drag by header; **double-click header toggles maximize**.
- **8 resize handles** (4 edges + 4 corners), respecting `minWidth`/`minHeight`.
- **Edge snapping**: dragging to the top maximizes, to left/right half-tiles, with a live
  translucent preview overlay.
- Focused window gets a stronger shadow + lighter border; unfocused dims the header.
- Maximized windows sit below the top bar and to the right of the dock.
- Windows must never be dragged above the top bar or fully off-screen.
- Opening cascades position (not `Math.random()`).

---

## 15. Shell modules

- `js/shell/top-bar.js` — GNOME 46 top bar: `Activities` on the left, **clock + date in the
  centre** (this is where GNOME actually puts it) opening a **calendar + notification
  popover**, status icons on the right opening the system menu.
- `js/shell/dock.js` — left dock, app icons with running dot + active bar, right-click
  context menu (New Window / Quit / Pin), Trash pinned at the bottom, window-count dots.
- `js/shell/system-menu.js` — Yaru quick-settings: volume + brightness sliders, Wi-Fi,
  Bluetooth, Power Mode, Dark Style toggle, Screenshot, Settings / Lock / Power buttons,
  and a real power dialog (Suspend / Restart / Power Off) with a 60s countdown.
- `js/shell/overview.js` — Activities overview: blurred wallpaper, window thumbnails laid
  out in a grid with titles, an app-grid button, search field that filters apps and jumps
  to Files search.
- `js/shell/context-menu.js` — reusable right-click menu builder:
  `openMenu(x, y, [{ label, icon, accel, disabled, separator, onClick, submenu }])`.
- `js/shell/keybindings.js` — global shortcuts:
  `Super` overview, `Super+A` app grid, `Alt+Tab` cycle, `Super+D` show desktop,
  `Super+L` lock, `Super+Left/Right` tile, `Super+Up/Down` maximize/restore,
  `Ctrl+Alt+T` new Terminal, `Alt+F4` close.

---

## 16. App module contract

Every app is `js/apps/<name>/index.js` with a **default export**:

```js
export default {
  id: 'terminal',                  // unique, matches folder name and dock icon id
  name: 'Terminal',                // display name (dock tooltip, window title, overview)
  genericName: 'Terminal',         // GNOME-style secondary name
  icon: iconElementFactory,        // () => Element  (SVG or img)
  pinned: true,                    // show in dock by default
  singleton: false,                // if true, open() focuses the existing instance
  width: 900, height: 560,
  minWidth: 420, minHeight: 260,
  resizable: true,
  themeClass: 'app-terminal',      // added to the window element for CSS scoping
  darkChrome: true,                // header bar uses the dark variant

  mount(root, ctx),                // build DOM into `root` (the window content element)
  onFocus(ctx), onBlur(ctx),
  onResize(ctx),
  onClose(ctx),                    // return false to veto close (e.g. unsaved changes)
};
```

`ctx` passed to every hook:

```js
{
  instanceId, appId, args,          // args from wm.open(appId, args)
  win,                              // the window element
  root,                             // the content element
  setTitle(t),
  close(), minimize(), maximize(),
  pid,                              // process id registered in procs
}
```

`js/apps/registry.js` imports every app module and exports:
```js
export const apps = [ terminal, files, textEditor, codeoss, firefox, monitor, settings, calculator, trash ];
export function getApp(id);
```

---

## 17. Terminal subsystem

### `js/apps/terminal/shell.js`

```js
export function tokenize(line);                 // -> Token[]  (handles ' " \ and operators)
export function parse(tokens);                  // -> AST of pipelines joined by ; && ||
export async function execute(line, ctx);       // -> { code, stdout, stderr }
export function registerCommand(cmd);
export function getCommand(name);
export function commandNames();                 // for tab completion
```

Must support:
- Quoting: `'single'` (literal), `"double"` (expands `$VAR`), backslash escapes.
- Expansion: `$VAR`, `${VAR}`, `$?`, `~`, `~/`, globs `* ? [abc]`, `$(cmd)` substitution,
  brace-free is fine.
- Operators: `|`, `>`, `>>`, `<`, `2>`, `&&`, `||`, `;`.
- Exit codes propagated to `$?`; `command not found` → 127 with the real Ubuntu message
  including the `Command 'x' not found, did you mean:` / `apt install` hint.
- Aliases (`alias ll='ls -alF'` preloaded from `.bashrc`).

### Command object contract

`js/apps/terminal/commands/*.js` each export an array of command objects:

```js
{
  name: 'ls',
  aliases: [],
  synopsis: 'ls [OPTION]... [FILE]...',
  description: 'List directory contents',
  man: '…full man-page body…',
  async run(ctx),   // -> { stdout, stderr, code } | string (treated as stdout, code 0)
}
```

`ctx` for a command:
```js
{ argv,          // string[] excluding the command name
  raw,           // original argument string
  stdin,         // string ('' when not piped)
  env, fs, procs, users, metrics, gemini,
  cwd,           // convenience: env.cwd
  term,          // terminal instance: { write(text), writeLine(text), clear(), ask(prompt, {password}) -> Promise<string> }
  signal,        // AbortSignal, aborted on Ctrl+C
}
```

### Required command coverage

- **files**: `ls cd pwd mkdir rmdir rm cp mv touch ln cat tac head tail wc find tree du df stat file chmod chown realpath basename dirname`
- **text**: `echo printf grep sed sort uniq cut tr rev tee diff nl less more`
- **system**: `uname whoami id hostname hostnamectl uptime date cal free ps top kill pkill pidof env export unset alias unalias history which whereis type man help clear exit reboot poweroff shutdown lscpu lsblk lsusb neofetch fastfetch sudo su groups`
- **net**: `ping ifconfig ip hostname -I netstat ss curl wget dig nslookup traceroute`
- **pkg**: `apt apt-get apt-cache dpkg snap` — simulated with realistic progress output
  (`Reading package lists... Done`, `Get:1 http://archive.ubuntu.com/ubuntu noble …`)
- **ai**: `ai` (ask Gemini), `explain` (explain last command/output), `gencode`, `ask`
- **misc**: `sleep seq yes bc md5sum sha256sum base64 xdg-open nano vim code gedit
  cowsay figlet fortune banner watch true false test`

`nano`/`vim`/`gedit` open the Text Editor on the given path; `code` opens Code-OSS;
`xdg-open` dispatches by file type.

### `js/apps/terminal/readline.js`

Line editing on a `contenteditable`-free model (hidden textarea + rendered line):
- History with ↑/↓, persisted to `~/.bash_history` and `store`.
- **Tab completion**: commands (first word), then paths (subsequent words), common-prefix
  completion, and a column listing on ambiguous double-Tab.
- Emacs keys: `Ctrl+A/E/U/K/W/L/C/D`, `Alt+B/F`, `Ctrl+R` reverse-i-search.
- Bracketed paste (multi-line paste runs lines sequentially).

### `js/apps/terminal/ansi.js`

```js
export function ansiToNodes(text);   // -> DocumentFragment of styled spans, text via textContent
export const C = { red, green, yellow, blue, magenta, cyan, white, gray, bold, dim, reset, … };
```
Supports SGR 0/1/2/4/7/22/24/27, 30–37, 90–97, 40–47, and 38;5;N / 38;2;R;G;B.

### Prompt

Exactly Ubuntu's default PS1 rendering:
`ubuntu@ubuntu-ai`(green bold)`:`(white)`~/Documents`(blue bold)`$ `
Root shells use red and `#`.

---

## 18. App-specific requirements

**Files (Nautilus)** — path breadcrumb bar, sidebar (Home / Desktop / Documents /
Downloads / Music / Pictures / Videos / Trash / Other Locations), grid **and** list view
toggle, sort menu, selection (click, ctrl-click, shift-click, marquee), double-click to
open (folders navigate, files open in Editor/Code-OSS), right-click context menu
(Open / Open With / Cut / Copy / Paste / Rename / Move to Trash / Properties / New Folder /
New Document), F2 rename inline, Delete → Trash, Ctrl+H toggle hidden files, search,
status bar with item count and free space, back/forward/up navigation with history.
All operations go through `fs` and react to `fs:change`.

**Text Editor (gedit/GNOME Text Editor)** — open/save/save-as against `fs`, tabbed
documents, dirty indicator `•` in the tab and title, line/column display, Ctrl+S/Ctrl+O/
Ctrl+N/Ctrl+W, find & replace bar (Ctrl+F), word wrap toggle, line numbers.

**Code-OSS** — file tree from `fs` rooted at `~/Projects`, tabs, line numbers gutter,
real tokenizer-based highlighting for py/js/ts/c/cpp/java/sh/html/css/json/md (not the
naive regex chain — tokenize strings and comments **first** so keywords inside strings are
not recoloured), auto-indent, bracket matching, Ctrl+S save to `fs`,
integrated terminal panel that reuses the terminal engine, and a Gemini agent panel
(explain / refactor / fix / generate) that streams into the panel.

**Firefox** — tabs with add/close, back/forward/reload/home, address bar that accepts a
URL or a search query, bookmark bar, an in-page "Ubuntu Start" home, Gemini-backed search
results page (rendered with `textContent`), a simple rendered "page" view for result
clicks generated by Gemini, history (Ctrl+H), and a clearly labelled *simulated browser*
notice — no real network fetches to arbitrary sites.

**System Monitor** — three tabs matching GNOME System Monitor: **Processes** (sortable
table: pid, name, user, %cpu, memory, state; End Process button with confirm),
**Resources** (CPU-per-core, Memory & Swap, Network line charts on canvas, redrawn from
`procs`/`metrics`, HiDPI-aware via `devicePixelRatio`), **File Systems** (table from a
simulated mount list). Charts must have grid lines, axis labels and legends.

**Settings** — sidebar sections: Wi-Fi, Network, Bluetooth, Background, Appearance
(light/dark, accent colour picker with the ten Yaru accents, dock position/size/autohide),
Notifications, Search, Multitasking, Sound, Power, Displays, Keyboard Shortcuts (list),
Users, Date & Time, About (real-looking device page: OS Name Ubuntu 24.04.1 LTS, GNOME
version, Windowing System, Kernel, Disk, Memory, Processor), and **AI Configuration**
(API key with show/hide, model select, test-connection button, security warning).
Every setting persists through `store` and emits `settings:change`.

**Calculator** — GNOME Calculator: basic + advanced modes, keyboard input, history strip.

**Trash** — Nautilus trash view backed by `fs.listTrash()`, Restore and Delete
Permanently per item, Empty Trash with confirm dialog.

---

## 19. Theming

`css/base/tokens.css` defines both light and dark palettes. Dark mode is applied by
`data-theme="dark"` on `<html>`; accent colour by `--accent` (default Ubuntu orange
`#E95420`). All app CSS must consume tokens, never hard-coded hex, except where a
specific product colour is being reproduced (VS Code chrome, Firefox chrome).

Required Yaru tokens:
```
--ubuntu-orange #E95420   --ubuntu-purple #772953   --ubuntu-aubergine #2C001E
--yaru-accents: bark #787859, sage #657b69, olive #4b8501, viridian #03875b,
                prussiangreen #308280, blue #0073e5, purple #7764d8,
                magenta #b34cb3, red #da3450, orange #e95420
```

Fonts: `Ubuntu` (UI), `Ubuntu Mono`/`Fira Code`/`JetBrains Mono` (terminal & code),
loaded from Google Fonts with a `system-ui` fallback so the page still works offline.

---

## 20. Boot sequence (`js/main.js`)

1. Apply saved theme/accent/wallpaper before first paint.
2. `fs.restore(store.get('fs'))` or `fs.reset()` on first run.
3. Seed `procs` baseline daemons; start the 1s `procs.tick()` + `metrics` interval.
4. Build shell: top bar → dock → overview → context menu → keybindings.
5. `apps.forEach(a => wm.register(a))`.
6. Restore the previous session's open windows (if the user enabled it) else open Terminal.
7. Expose `window.UAD = { fs, wm, procs, env, bus, store, gemini }` for debugging.
8. Register a `beforeunload` handler that calls `fs.persist()`.

---

## 21. Non-negotiables checklist

- [ ] No `onclick=` attributes anywhere in `index.html`.
- [ ] No `innerHTML` receiving AI output, file content, or user input.
- [ ] No API key committed to the repo. `key.txt` is git-ignored.
- [ ] Every module imports only from paths declared in §1.
- [ ] Every app conforms to §16.
- [ ] Runs from a plain static file server with zero build steps.
