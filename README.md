# Ubuntu AI Desktop

### ▶  **[Launch the desktop → jtech-co.github.io/Ubuntu-AI-Desktop](https://jtech-co.github.io/Ubuntu-AI-Desktop/)**

[![Live demo](https://img.shields.io/badge/demo-live-E95420?style=flat-square)](https://jtech-co.github.io/Ubuntu-AI-Desktop/)
![No build step](https://img.shields.io/badge/build-none-772953?style=flat-square)
![Vanilla ES modules](https://img.shields.io/badge/js-vanilla%20ES%20modules-2C001E?style=flat-square)
![Commands](https://img.shields.io/badge/shell-200%20commands-26A269?style=flat-square)

[![Ubuntu AI Desktop](assets/og-image.png)](https://jtech-co.github.io/Ubuntu-AI-Desktop/)

An Ubuntu 24.04 LTS (Noble Numbat) desktop emulator that runs entirely in the
browser as a static site. No build step, no bundler, no server-side code — just
native ES modules and plain CSS, so it deploys to GitHub Pages by pushing.

It is a *simulation*, not a virtual machine. There is no real kernel and no real
package archive. What it does have is a genuine in-memory POSIX-ish filesystem, a
real bash-style shell with pipes and redirection, and ten applications that all
read and write the same filesystem — so a file you create in the terminal really
does appear in Files, opens in the editor, and lands in the trash when deleted.

Open a terminal and try it:

```bash
ls -l ~/Pictures | wc -l          # a real pipeline, with real isatty(1) behaviour
cat ~/Desktop/help.txt            # the full tour, in Korean
neofetch                          # reads your machine's actual CPU, GPU and RAM
sudo apt install cowsay           # simulated archive, real file written to /usr/bin
```

---

## Running it locally

```bash
python serve.py
```

Then open <http://localhost:8321>.

**Opening `index.html` directly with `file://` will not work.** ES modules are
fetched with CORS rules that the `file:` scheme cannot satisfy, so the browser
refuses every `import` before the desktop can start. Any static HTTP server will
do; `serve.py` is included because it also sends `Cache-Control: no-store`, which
saves you from editing a module, reloading, and silently running the old code —
`python -m http.server` sends no cache headers at all and browsers will cache
your JavaScript aggressively.

Any modern Chromium, Firefox or Safari release works. The app uses top-level
`await`, `ResizeObserver`, `crypto.subtle` and CSS nesting-free custom
properties, all of which have been baseline for years.

---

## Deploying to GitHub Pages

1. Push this directory to a repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, pick your
   branch and the `/ (root)` folder.
3. Open `https://<user>.github.io/<repo>/`.

`.nojekyll` is committed so Jekyll does not eat paths beginning with an
underscore. Nothing else is required — every asset path in `index.html` is
relative, so the site works from a subdirectory.

---

## The Gemini API key

The AI features (the `ai` command, the Code-OSS agent panel, Firefox's generated
search results) call the Google Gemini API directly from the browser.

Get a key at <https://aistudio.google.com/apikey>, then open
**Settings → AI Configuration** inside the desktop and paste it in. It is stored
in that browser's `localStorage` under `uad:apikey`.

### Security — read this before you deploy

- **Never commit an API key, and never bake one into the page.** A GitHub Pages
  site is public and unminified; anyone can read the source or the network tab
  and take the key. `.gitignore` covers `key.txt`, `*.key` and `.env` for this
  reason.
- The key lives in the visitor's own `localStorage`. Each visitor supplies their
  own; you are not paying for anyone else's usage.
- `localStorage` is readable by any script on the same origin, so treat it as
  "safe from other websites, not safe from someone at this browser."
- **Restrict the key in Google AI Studio** — add an HTTP referrer restriction for
  your Pages domain so a leaked key cannot be used elsewhere.
- If you have ever committed a key, rotate it. Deleting the file in a later
  commit does not remove it from git history.

Everything except the AI features works with no key at all.

---

## Layout

```
index.html              shell skeleton, stylesheet links, one module script
serve.py                local dev server (no-cache, correct MIME types)
docs/ARCHITECTURE.md    the normative contract every module is built against
css/base/               design tokens, reset, typography
css/shell/              desktop, window chrome, top bar, dock, menus, dialogs
css/apps/               one stylesheet per application
js/core/                runtime: filesystem, event bus, storage, processes, DOM
js/services/            the Gemini client
js/shell/               window manager, top bar, dock, overview, keybindings
js/apps/<id>/           one folder per application
js/apps/registry.js     the application catalogue
js/main.js              boot sequence
legacy/                 the original single-file versions, kept for reference
```

The pieces worth knowing about:

| Module | Role |
| --- | --- |
| `js/core/fs.js` | The virtual filesystem. Every app reads and writes through it, and it persists to `localStorage`. Emits `fs:change` so views refresh themselves. |
| `js/core/bus.js` | The event bus that decouples the shell from the apps. |
| `js/core/procs.js` | The simulated process table behind `ps`, `top`, `kill` and System Monitor. |
| `js/shell/window-manager.js` | Builds every window from one template: drag, eight-way resize, edge snapping, tiling, minimise, focus. |
| `js/apps/terminal/shell.js` | The shell: tokeniser, expansion, parser, pipeline executor. |
| `js/shell/settings-bridge.js` | Keeps the quick-settings menu and the Settings app in sync — they own overlapping preferences under different key names. |

---

## Applications

**Terminal** — tabbed gnome-terminal with a real shell (see below).
**Files** — Nautilus-style browser: grid and list views, breadcrumbs, selection,
rename, cut/copy/paste, undo, drag and drop, properties, Open in Terminal, trash.
**Text Editor** — tabbed, dirty tracking, find and replace, line numbers.
**Image Viewer** — Eye of GNOME: zoom, pan, rotate, slideshow, fullscreen,
prev/next through the folder, Set as Wallpaper. Reads images stored in the
virtual filesystem as data URLs, and `.svg` files as markup.
**Code - OSS** — VS Code-style editor with a tokeniser-based highlighter, file
tree, integrated terminal, and a Gemini agent panel.
**Firefox** — a browser with two modes: **Live web** (default) really loads
sites in an iframe, really searches, and really plays YouTube; **AI simulation**
keeps the older Gemini-generated pages, labelled as such.
**System Monitor** — processes, live resource charts, file systems.
**Settings** — appearance, background, dock, AI configuration, about, and more.
**Calculator** — basic and advanced modes with a real expression parser.
**Trash** — freedesktop.org trash with restore and permanent delete.

Press `Alt`+`F2` for GNOME's run dialog, and read `~/Desktop/help.txt` (Korean)
for a full tour from inside the desktop itself.

## What is real, and what is simulated

The point of this project is fidelity, so it is worth being precise about where
the line falls.

**Real** — the virtual filesystem shared by every app; the shell's tokeniser,
expansion, pipes, redirection, globbing and subshells; GNU output formats and
error strings; `isatty(1)` behaviour, so `ls | wc -l` counts files; the window
manager's eight-way resize, edge snapping and tiling; the host's hardware as far
as the browser will report it; and in Firefox's live mode, genuine network
requests, genuine search results and genuine YouTube playback.

**Simulated** — there is no kernel and no real process table (`ps`/`top` read a
model); `apt` installs from a fake archive, and although it really writes a file
into `/usr/bin`, that file is not executable code; the network commands
(`ping`, `dig`, `traceroute`) invent plausible output; and Code-OSS's Run button
asks Gemini to act as an interpreter rather than executing anything.

### Hardware readings

`About`, `/proc/cpuinfo`, `/proc/meminfo`, `lscpu`, `free`, `neofetch`, `xrandr`,
`glxinfo` and the System Monitor all read `js/core/device.js`, which probes the
real machine. Browsers deliberately restrict this, so the module records how
trustworthy each field is and the UI says so rather than inventing a number:

- `navigator.deviceMemory` is bucketed to a power of two, so memory is labelled
  "approx." — and a reading of exactly 8 GiB is shown as "8.0 GiB or more",
  because the original spec capped the value there.
- **The CPU model string is not exposed to web content at all.** You get core
  count and architecture; `/proc/cpuinfo` says "model not reported to the
  browser" instead of naming a chip it cannot see.
- `navigator.storage.estimate()` is the *browser's storage quota*, not the disk,
  and is labelled that way.
- The GPU comes from `WEBGL_debug_renderer_info`, which Firefox's
  `resistFingerprinting` and some privacy extensions mask. When masked, the UI
  says it is masked.

### Live browsing

Firefox's live mode is bounded by what a page in a browser tab is allowed to do:

- Most large sites (Google, YouTube watch pages, most news and social sites) send
  `X-Frame-Options` or `frame-ancestors` and **cannot** be embedded. The app
  detects the refusal and shows an honest interstitial with a button that opens
  the site in a real browser tab, rather than pretending to have rendered it.
- **YouTube playback genuinely works** through the `youtube-nocookie.com/embed/`
  player. Paste a video URL or ID, or use one of the demo videos.
- Search is real and keyless, from CORS-enabled APIs: Wikipedia (in your own
  language), Ask Ubuntu / Stack Overflow via the Stack Exchange API, and Hacker
  News via Algolia. Engines fail independently, so one being down still leaves a
  usable result page. Google cannot be embedded, so there is a button that runs
  the query on the real Google in a new tab.
- Same-origin, `javascript:` and `data:` addresses are refused outright — framing
  the desktop inside itself would both boot a second copy racing the first on
  `localStorage` and defeat the iframe sandbox.
- The Stack Exchange anonymous quota is about 300 requests per day per IP.

---

## The terminal

The shell is not a switch statement over command names. It tokenises with proper
quote and escape handling, expands in bash's order (tilde → parameter → command
substitution → word splitting → globbing), parses into an AST, and executes
pipelines.

Supported: `|`, `>`, `>>`, `<`, `2>`, `2>&1`, `&&`, `||`, `;`, trailing `&`,
`$VAR`, `${VAR}`, `${VAR:-default}`, `$?`, `$(…)`, backticks, `*`, `?`, `[abc]`,
`~`, aliases, and exit codes that propagate to `$?`.

Line editing has history (persisted to `~/.bash_history`), tab completion for
both commands and paths, reverse-i-search with `Ctrl+R`, and the usual Emacs
keys — `Ctrl+A/E/U/K/W/L/C/D`, `Alt+B/F/D`.

Because commands respect `isatty(1)`, `ls` prints columns at the prompt and one
entry per line when piped — so `ls | wc -l` counts files, as it should.

### Commands

**Builtins** (they mutate shell state, so they live in `js/apps/terminal/builtins.js`)
`cd pwd export unset alias unalias source . exit logout history jobs fg bg wait
set shopt type command eval help true false :`

**Files** `ls cat tac head tail wc cp mv rm mkdir rmdir touch ln find tree du df
stat file chmod chown realpath readlink basename dirname mktemp`

**Text** `echo printf grep egrep fgrep sed sort uniq cut tr rev tee diff nl less
more paste column fold split join comm shuf`

**System** `uname whoami id hostname hostnamectl uptime date cal ncal free ps top
kill pkill killall pgrep pidof which whereis man lscpu lsblk lsusb lspci lsmod
mount dmesg systemctl journalctl timedatectl lsb_release locale nproc arch tty
stty groups su sudo neofetch fastfetch screenfetch`

**Network** (simulated — no real requests leave the page)
`ping ifconfig ip netstat ss curl wget dig nslookup host traceroute tracepath arp
route nmcli`

**Packages** (simulated archive) `apt apt-get apt-cache dpkg dpkg-query snap
add-apt-repository apt-add-repository do-release-upgrade`

**AI** (needs a key) `ai ask gemini explain gencode summarize summarise translate`

**Misc** `sleep seq yes bc md5sum sha256sum base64 xxd watch time xdg-open nano
vim vi gedit gnome-text-editor code nautilus gnome-files firefox cowsay cowthink
figlet banner fortune reboot poweroff halt shutdown`

**Emulator-only** `reset github` — these two do not exist on Ubuntu, or behave
differently there, and their man pages say so.

`reset` is a factory reset for the desktop: it discards the filesystem,
wallpaper, accent, theme, dock settings, session, browser history, shell history
and trash, then reloads. Your API key survives unless you pass `--all`; `-y`
skips the confirmation. (Real `reset(1)` reinitialises the *terminal* and leaves
your files alone — use `clear` or `Ctrl+L` for that.)

`github` is a scripted demo: the screen pulses, Firefox opens by itself, types
`github.com` a character at a time and loads a locally drawn repository page —
GitHub sends `X-Frame-Options`, so the real site cannot be embedded, and the page
says so. Enter then takes the browser tab to the live site; Escape cancels.

That is 176 external commands plus 24 builtins — 200 in all, or 212 names counting
aliases. Run `help` for the live list, or
`man <command>` for a full page.

`apt install` really does write a binary into `/usr/bin`, so `which` finds it
afterwards and `apt remove` deletes it; `/var/log/dpkg.log` gains matching
records. It needs `sudo`, and without it prints the genuine dpkg lock error.

### Known limitations

These are deliberate, and the commands tell you rather than pretending:

- **Nothing reaches the network** except the Gemini API. `curl`, `wget`, `ping`
  and `dig` return generated or canned responses; Firefox's pages are written by
  Gemini and labelled as such on every page.
- **`bc`** uses JavaScript doubles, so `scale` is honoured to about 15 decimal
  places rather than arbitrary precision, and `define`/`if`/`while`/`for` are not
  implemented (they return the real `(standard_in): syntax error`).
- **`yes`** is rate-limited and capped at a million lines so a piped `yes` cannot
  freeze the tab.
- **`xxd -r`** (reverse a hex dump) is not implemented.
- **Code-OSS "Run"** does not execute Python or C++. Shell scripts really run
  through the terminal engine; other languages are sent to Gemini, and the output
  panel labels the result as AI-simulated. With no API key it says so instead of
  inventing output.
- **`ai … | grep`** — the progress spinner is buffered into the pipe along with
  the answer, because the shell gives commands a single output channel.

---

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Super` | Activities overview |
| `Super`+`A` | Application grid |
| `Alt`+`Tab` | Cycle windows |
| `Super`+`←` / `→` | Tile left / right |
| `Super`+`↑` / `↓` | Maximise / restore |
| `Super`+`D` | Show desktop |
| `Super`+`L` | Lock screen (password: `ubuntu`) |
| `Ctrl`+`Alt`+`T` | New terminal |
| `Alt`+`F2` | Run a command (GNOME's run dialog) |
| `Alt`+`F4` | Close window |
| `Print` | Screenshot |
| `Esc` | Leave the emulator, when the keyboard is locked |

### Keeping the keyboard inside the emulator

`Ctrl+T`, `Ctrl+W` and `Ctrl+N` belong to the *browser*. A page cannot cancel
them — `preventDefault()` has no effect — so by default pressing `Ctrl+W` in
Code-OSS closes the real tab hosting the desktop instead of the app's own tab.

The only web API that changes this is **Keyboard Lock**, and it has conditions
that shape the whole feature:

- It works **only in fullscreen**, and entering fullscreen needs a user gesture.
  So capture can never switch itself on at boot — click **키보드 잠그기** in the
  top bar, or the button on the first-run prompt.
- It is **Chromium-only**. Firefox and Safari have not shipped it; there the
  indicator is greyed out with an explanation rather than a button that fails.
- Once Escape is locked, **holding Escape for ~2 seconds always escapes**. That
  is enforced by the browser and cannot be disabled from script — it is the
  user's guaranteed way out.

Three ways back out, then: a short `Esc` (asks for confirmation, and defers to
any menu or dialog that wants Escape first), a long `Esc` (browser-enforced),
or the **power button at the top left**, which shuts the machine down and hands
the keyboard back immediately without asking.

That power button is a deliberate departure from GNOME, which keeps shutdown in
the top-right system menu — that menu still exists and still works. Running a
desktop inside a browser tab just needs one always-visible way out.

`Print` takes a **real** screenshot through `getDisplayMedia`, so the browser
will ask which surface to share; the result is saved to
`~/Pictures/Screenshots/` and opens in the Image Viewer. Cancelling the
permission prompt writes nothing. Where the API is unavailable (an insecure
origin, or an unsupported browser) it writes a placeholder that says on its face
that it is one, rather than a file pretending to be a capture.

The simulated `sudo` password is also `ubuntu`.

---

## Extending

### Adding an application

Create `js/apps/<id>/index.js` with a default export matching the contract in
`docs/ARCHITECTURE.md` §16, then add it to `js/apps/registry.js`. The dock, the
overview and the window manager pick it up from there.

```js
import { h } from '../../core/dom.js';
import { fs } from '../../core/fs.js';

export default {
  id: 'notes',
  name: 'Notes',
  icon: () => h('span', { text: '📝' }),
  pinned: true,
  width: 620,
  height: 480,

  mount(root, ctx) {
    root.appendChild(h('pre', { text: fs.readFile('/home/ubuntu/README.md') }));
    ctx.setTitle('Notes — README.md');
  },

  onClose() {
    return true; // return false to veto the close
  },
};
```

### Adding a terminal command

Add the command object to one of the arrays in
`js/apps/terminal/commands/`, or create a new module and list it in
`commands/index.js`. Return `{ stdout, stderr, code }`, or a plain string for
the common case.

```js
export default [
  {
    name: 'hello',
    aliases: [],
    synopsis: 'hello [NAME]...',
    description: 'Greet someone',
    man: 'NAME\n    hello - greet someone\n\nSYNOPSIS\n    hello [NAME]...',

    async run(ctx) {
      const who = ctx.argv.length ? ctx.argv.join(' ') : ctx.env.get('USER');
      // ctx.stdoutIsTTY is false when piped or redirected — match GNU tools
      // and drop decoration in that case.
      return { stdout: `Hello, ${who}!\n`, stderr: '', code: 0 };
    },
  },
];
```

`ctx` carries `argv`, `raw`, `stdin`, `stdoutIsTTY`, `env`, `fs`, `procs`,
`users`, `gemini`, `term`, `signal` and a `run()` helper for invoking the shell
recursively. Long-running commands must watch `ctx.signal` so `Ctrl+C` works.

---

## Resetting

The desktop keeps its filesystem and settings in `localStorage`. To wipe it and
get a fresh install, run this in the browser console:

```js
UAD.reset();
```

`localStorage.clear(); location.reload()` also works, but only because the
unload handler checks whether the store was cleared out from under it before
saving. Prefer `UAD.reset()`.

`window.UAD` exposes `fs`, `wm`, `procs`, `env`, `bus`, `store`, `gemini`,
`metrics`, `notify`, `settings` and `apps` for poking around.
