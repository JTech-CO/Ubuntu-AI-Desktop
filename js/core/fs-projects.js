/**
 * js/core/fs-projects.js — user documents, the ~/Projects workspace and the
 * /var/log corpus for the default tree.
 *
 * Kept apart from fs-data.js so neither file grows unwieldy.
 * Sibling of js/core/fs.js — see ARCHITECTURE §6.
 */

export const WELCOME_TXT = `Welcome to Ubuntu 24.04.1 LTS (Noble Numbat)!

This desktop is a faithful, fully client-side simulation of GNOME 46 on Yaru.
Nothing here talks to a real machine — the filesystem lives in your browser.

Getting started
---------------
  * Press the Super key to open the Activities overview.
  * Ctrl+Alt+T opens a new Terminal.
  * Super+Left / Super+Right tile the focused window.
  * Everything the Terminal writes is visible in Files, and vice versa.

Add your Gemini API key in Settings -> AI Configuration to enable the
"ai", "ask", "explain" and "gencode" commands, the Code-OSS agent panel and
Firefox search.

Have a look around. Try:

    neofetch
    ls -la ~/Projects
    cat /etc/os-release
    ai how do I find large files with du?
`;

export const README_MD = `# ubuntu-ai

A personal scratch space on this machine.

## Layout

| Path | What lives there |
| ---- | ---------------- |
| \`~/Projects\` | Source checkouts, one directory per project |
| \`~/Documents\` | Notes, todo lists, anything long-form |
| \`~/Downloads\` | Installer images and one-off downloads |

## Conventions

1. Python projects use a venv in \`.venv/\` and pin dependencies in
   \`requirements.txt\`.
2. JavaScript projects are plain ES modules — no bundler unless there is a
   real reason for one.
3. Every project gets a README before it gets a second file.

## Handy commands

    du -sh ~/Projects/*        # what is eating the disk
    grep -rn "TODO" ~/Projects # outstanding work
    df -h /                    # free space on root

Last tidied up after the 24.04.1 point release upgrade.
`;

export const HELLO_PY = `#!/usr/bin/env python3
"""A first program. Run it with:  python3 hello.py"""

import platform
import sys


def greet(name: str = "world") -> str:
    """Return a greeting for *name*."""
    return f"Hello, {name}!"


def main(argv: list[str]) -> int:
    name = argv[1] if len(argv) > 1 else "world"
    print(greet(name))
    print(f"Running Python {platform.python_version()} on {platform.system()}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

export const NOTES_MD = `# Notes

## 2024-08-14 — Upgrading to 24.04.1

The point release landed. \`do-release-upgrade\` refused to run until
\`Prompt=lts\` was set in \`/etc/update-manager/release-upgrades\`, which is the
expected behaviour on an LTS -> LTS hop.

Things that needed attention afterwards:

- The \`resolv.conf\` symlink got recreated pointing at the stub resolver.
  That is correct; do not "fix" it.
- Wayland is the default session again. Xorg is still available from the
  cog on the login screen.
- \`netplan\` config moved to \`/etc/netplan/50-cloud-init.yaml\`.

## Shell things worth remembering

\`\`\`sh
# every file over 100 MiB under home, largest last
find ~ -type f -size +100M -printf '%s\\t%p\\n' | sort -n

# what is listening
ss -tulpn

# disk usage by directory, one level deep
du -h --max-depth=1 ~ | sort -h
\`\`\`

## Reading list

- [ ] systemd-resolved: split DNS and the search domain rules
- [x] cgroup v2 and how systemd slices map onto it
- [ ] Wayland clipboard managers that actually work
- [ ] Why \`apt\` and \`apt-get\` have different default answers

## Ideas

An offline-first terminal that can explain its own output would be genuinely
useful for people learning the shell. The hard part is not the model, it is
making the transcript legible enough to be worth explaining.
`;

export const TODO_TXT = `(A) 2024-08-16 Finish the weather-cli forecast subcommand +weather @dev
(A) 2024-08-16 Add unit tests for weather.format.humanise +weather @dev
(B) 2024-08-12 Write up the 24.04.1 upgrade notes @writing
(B) 2024-08-15 Pin todo-app dependencies before tagging 0.3.0 +todoapp @dev
(C) 2024-08-10 Back up ~/Projects to the external drive @chore
(C) 2024-08-17 Renew the domain before it lapses in October @chore
x 2024-08-15 2024-08-11 Replace the failing SSD @chore
x 2024-08-13 2024-08-09 Enable unattended-upgrades on the server @ops
`;

/**
 * ~/Projects — a small Python CLI and a small vanilla-JS app, so Code-OSS has
 * a real tree with real syntax to highlight.
 * @type {Record<string, string>} path relative to ~/Projects -> file contents
 */
export const PROJECT_FILES = {
  'weather-cli/README.md': `# weather-cli

A tiny command line weather client. No dependencies beyond the standard
library, because a weather report is not worth a dependency tree.

## Usage

    python3 main.py --city Edinburgh
    python3 main.py --city Edinburgh --days 3

## Development

    python3 -m venv .venv
    . .venv/bin/activate
    python3 -m pytest
`,

  'weather-cli/requirements.txt': `# Runtime dependencies: none.
# Development only:
pytest==8.3.2
ruff==0.6.2
`,

  'weather-cli/.gitignore': `__pycache__/
*.py[cod]
.venv/
.pytest_cache/
.ruff_cache/
dist/
`,

  'weather-cli/main.py': `#!/usr/bin/env python3
"""Entry point for weather-cli."""

import argparse
import sys

from weather.api import fetch_forecast
from weather.format import render_forecast


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="weather",
        description="Print a short weather forecast for a city.",
    )
    parser.add_argument("--city", required=True, help="City name, e.g. Edinburgh")
    parser.add_argument("--days", type=int, default=1, help="Forecast length in days")
    parser.add_argument("--units", choices=("metric", "imperial"), default="metric")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.days < 1 or args.days > 7:
        print("weather: --days must be between 1 and 7", file=sys.stderr)
        return 2

    try:
        forecast = fetch_forecast(args.city, days=args.days, units=args.units)
    except LookupError as exc:
        print(f"weather: {exc}", file=sys.stderr)
        return 1

    print(render_forecast(forecast, units=args.units))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`,

  'weather-cli/weather/__init__.py': `"""weather — a very small forecast client."""

__version__ = "0.4.1"
__all__ = ["api", "format"]
`,

  'weather-cli/weather/api.py': `"""Forecast retrieval.

The network layer is deliberately thin: one function, one request, no session
state. Offline runs fall back to the sample data so the tests never touch the
network.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = "https://api.open-meteo.com/v1/forecast"
TIMEOUT_SECONDS = 8

SAMPLE = {
    "city": "Edinburgh",
    "days": [
        {"date": "2024-08-18", "high": 18.4, "low": 11.2, "code": 3},
        {"date": "2024-08-19", "high": 19.1, "low": 12.0, "code": 61},
        {"date": "2024-08-20", "high": 17.8, "low": 10.6, "code": 80},
    ],
}


def geocode(city: str) -> tuple[float, float]:
    """Resolve a city name to (latitude, longitude)."""
    known = {
        "edinburgh": (55.9533, -3.1883),
        "london": (51.5074, -0.1278),
        "seoul": (37.5665, 126.9780),
        "san francisco": (37.7749, -122.4194),
    }
    key = city.strip().lower()
    if key not in known:
        raise LookupError(f"unknown city: {city}")
    return known[key]


def fetch_forecast(city: str, days: int = 1, units: str = "metric") -> dict:
    """Return a forecast dict for *city*, falling back to sample data."""
    lat, lon = geocode(city)
    query = urllib.parse.urlencode(
        {
            "latitude": lat,
            "longitude": lon,
            "daily": "temperature_2m_max,temperature_2m_min,weathercode",
            "forecast_days": days,
            "temperature_unit": "celsius" if units == "metric" else "fahrenheit",
            "timezone": "auto",
        }
    )
    try:
        with urllib.request.urlopen(f"{ENDPOINT}?{query}", timeout=TIMEOUT_SECONDS) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError):
        payload = None

    if payload is None:
        sample = dict(SAMPLE)
        sample["days"] = sample["days"][:days]
        sample["city"] = city
        return sample

    daily = payload["daily"]
    return {
        "city": city,
        "days": [
            {
                "date": daily["time"][i],
                "high": daily["temperature_2m_max"][i],
                "low": daily["temperature_2m_min"][i],
                "code": daily["weathercode"][i],
            }
            for i in range(len(daily["time"]))
        ],
    }
`,

  'weather-cli/weather/format.py': `"""Turning a forecast dict into something a human wants to read."""

from __future__ import annotations

CONDITIONS = {
    0: "clear",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    51: "light drizzle",
    61: "rain",
    71: "snow",
    80: "rain showers",
    95: "thunderstorm",
}


def humanise(code: int) -> str:
    """Map a WMO weather code onto plain English."""
    return CONDITIONS.get(code, f"code {code}")


def render_forecast(forecast: dict, units: str = "metric") -> str:
    """Render a forecast as an aligned plain-text table."""
    degree = "C" if units == "metric" else "F"
    lines = [f"Forecast for {forecast['city']}", "-" * 42]
    for day in forecast["days"]:
        lines.append(
            f"{day['date']}  {day['high']:5.1f}{degree} / {day['low']:5.1f}{degree}"
            f"  {humanise(day['code'])}"
        )
    return "\\n".join(lines)
`,

  'todo-app/README.md': `# todo-app

A dependency-free todo list. Plain ES modules, no build step, no framework —
open \`index.html\` and it runs.

## Why

Every todo app tutorial reaches for a framework before the second commit. This
one does not, so it still works in five years.

## Structure

    index.html    markup and nothing else
    src/store.js  state + localStorage persistence
    src/app.js    rendering and event wiring
    src/style.css layout
`,

  'todo-app/package.json': `{
  "name": "todo-app",
  "version": "0.3.0",
  "description": "A dependency-free todo list in plain ES modules",
  "type": "module",
  "main": "src/app.js",
  "scripts": {
    "start": "python3 -m http.server 8080",
    "lint": "eslint src"
  },
  "keywords": ["todo", "vanilla", "esm"],
  "author": "ubuntu",
  "license": "MIT"
}
`,

  'todo-app/.gitignore': `node_modules/
dist/
.env
*.log
`,

  'todo-app/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Todo</title>
    <link rel="stylesheet" href="src/style.css" />
  </head>
  <body>
    <main class="app">
      <h1>Todo</h1>
      <form id="new-item">
        <input id="title" name="title" placeholder="What needs doing?" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <ul id="list"></ul>
      <footer><span id="count">0 items</span></footer>
    </main>
    <script type="module" src="src/app.js"></script>
  </body>
</html>
`,

  'todo-app/src/store.js': `const KEY = 'todo-app:items';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(items) {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function createStore() {
  let items = load();
  const listeners = new Set();

  const emit = () => {
    save(items);
    for (const fn of listeners) fn(items.slice());
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      fn(items.slice());
      return () => listeners.delete(fn);
    },
    add(title) {
      const text = String(title).trim();
      if (!text) return;
      items = items.concat({ id: crypto.randomUUID(), title: text, done: false });
      emit();
    },
    toggle(id) {
      items = items.map((it) => (it.id === id ? { ...it, done: !it.done } : it));
      emit();
    },
    remove(id) {
      items = items.filter((it) => it.id !== id);
      emit();
    },
    clearDone() {
      items = items.filter((it) => !it.done);
      emit();
    },
  };
}
`,

  'todo-app/src/app.js': `import { createStore } from './store.js';

const store = createStore();
const list = document.querySelector('#list');
const form = document.querySelector('#new-item');
const input = document.querySelector('#title');
const count = document.querySelector('#count');

function itemNode(item) {
  const li = document.createElement('li');
  li.className = item.done ? 'item done' : 'item';
  li.dataset.id = item.id;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = item.done;
  box.addEventListener('change', () => store.toggle(item.id));

  const label = document.createElement('span');
  label.className = 'title';
  label.textContent = item.title;

  const del = document.createElement('button');
  del.className = 'remove';
  del.textContent = 'Remove';
  del.addEventListener('click', () => store.remove(item.id));

  li.append(box, label, del);
  return li;
}

function render(items) {
  list.replaceChildren(...items.map(itemNode));
  const left = items.filter((it) => !it.done).length;
  count.textContent = left === 1 ? '1 item left' : left + ' items left';
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  store.add(input.value);
  input.value = '';
  input.focus();
});

store.subscribe(render);
`,

  'todo-app/src/style.css': `:root {
  --bg: #ffffff;
  --fg: #1d1d1d;
  --muted: #77767b;
  --accent: #e95420;
  --line: #dcdcdc;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: Ubuntu, system-ui, sans-serif;
  background: var(--bg);
  color: var(--fg);
}

.app {
  max-width: 34rem;
  margin: 4rem auto;
  padding: 0 1rem;
}

form {
  display: flex;
  gap: 0.5rem;
}

input#title {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 6px;
}

button {
  border: 0;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

ul {
  list-style: none;
  padding: 0;
}

.item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--line);
}

.item.done .title {
  color: var(--muted);
  text-decoration: line-through;
}

.remove {
  margin-left: auto;
  background: transparent;
  color: var(--muted);
}

footer {
  margin-top: 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
`,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** `Aug 18 07:24:01` — rsyslog's traditional file format. */
function syslogStamp(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`;
}

/** `2024-08-18 07:24:01` — dpkg's format. */
function dpkgStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`;
}

/**
 * @param {number} bootTime epoch ms
 * @returns {string} /var/log/syslog
 */
export function syslog(bootTime) {
  const at = (offsetSec) => syslogStamp(bootTime + offsetSec * 1000);
  const rows = [
    [0, 'kernel: [    0.000000] Linux version 6.8.0-45-generic (buildd@lcy02-amd64-036) #45-Ubuntu SMP PREEMPT_DYNAMIC'],
    [0, 'kernel: [    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz-6.8.0-45-generic root=UUID=8c2f19f4-6c2e-4d51-9a1f-0d3b7c5e41a2 ro quiet splash'],
    [1, 'kernel: [    1.204118] EXT4-fs (sda2): mounted filesystem 8c2f19f4-6c2e-4d51-9a1f-0d3b7c5e41a2 r/w with ordered data mode'],
    [2, 'systemd[1]: Started systemd-journald.service - Journal Service.'],
    [3, 'systemd[1]: Finished systemd-udev-trigger.service - Coldplug All udev Devices.'],
    [4, 'systemd-resolved[612]: Positive Trust Anchors:'],
    [4, 'systemd-resolved[612]: Using system hostname \'ubuntu-ai\'.'],
    [5, 'NetworkManager[745]: <info>  [1723967045.8821] NetworkManager (version 1.46.0) is starting... (boot:9f2c1d4e)'],
    [6, 'NetworkManager[745]: <info>  [1723967046.4102] device (enp0s3): state change: config -> ip-config (reason \'none\')'],
    [8, 'dhclient[901]: bound to 10.0.2.15 -- renewal in 41287 seconds.'],
    [9, 'systemd[1]: Reached target graphical.target - Graphical Interface.'],
    [11, 'gdm-launch-environment][1041]: pam_unix(gdm-launch-environment:session): session opened for user gdm(uid=117) by (uid=0)'],
    [14, 'snapd[812]: daemon.go:247: started snapd/2.63 (series 16; classic) ubuntu/24.04 (amd64) linux/6.8.0-45-generic.'],
    [22, 'gnome-shell[1387]: Registering session with GDM'],
    [23, 'systemd[1240]: Reached target default.target - Main User Target.'],
    [40, 'wireplumber[1508]: Failed to set scheduler settings: Operation not permitted'],
    [61, 'systemd[1]: Starting fwupd.service - Firmware update daemon...'],
    [90, 'kernel: [   90.117402] rfkill: input handler disabled'],
    [1802, 'CRON[2145]: (root) CMD (   cd / && run-parts --report /etc/cron.hourly)'],
    [3601, 'systemd[1]: Starting logrotate.service - Rotate log files...'],
    [3602, 'systemd[1]: logrotate.service: Deactivated successfully.'],
    [5405, 'systemd[1]: Started apt-daily.service - Daily apt download activities.'],
    [5412, 'systemd[1]: apt-daily.service: Deactivated successfully.'],
    [7203, 'CRON[3388]: (root) CMD (   cd / && run-parts --report /etc/cron.hourly)'],
    [9012, 'gnome-shell[1387]: libmutter-Message: Received a resize request for a window that is not resizable'],
  ];
  return `${rows.map(([off, msg]) => `${at(off)} ubuntu-ai ${msg}`).join('\n')}\n`;
}

/**
 * @param {number} bootTime epoch ms
 * @returns {string} /var/log/auth.log
 */
export function authLog(bootTime) {
  const at = (offsetSec) => syslogStamp(bootTime + offsetSec * 1000);
  const rows = [
    [10, 'systemd-logind[798]: New seat seat0.'],
    [11, 'systemd-logind[798]: Watching system buttons on /dev/input/event0 (Power Button)'],
    [12, 'gdm-password][1041]: gkr-pam: unable to locate daemon control file'],
    [13, 'gdm-password][1041]: pam_unix(gdm-password:session): session opened for user ubuntu(uid=1000) by ubuntu(uid=0)'],
    [13, 'systemd-logind[798]: New session 2 of user ubuntu.'],
    [13, 'systemd: pam_unix(systemd-user:session): session opened for user ubuntu(uid=1000) by ubuntu(uid=0)'],
    [15, 'polkitd(authority=local): Registered Authentication Agent for unix-session:2 (system bus name :1.62 [gnome-shell], object path /org/freedesktop/PolicyKit1/AuthenticationAgent, locale en_US.UTF-8)'],
    [1204, 'sudo:   ubuntu : TTY=pts/0 ; PWD=/home/ubuntu ; USER=root ; COMMAND=/usr/bin/apt update'],
    [1204, 'sudo: pam_unix(sudo:session): session opened for user root(uid=0) by ubuntu(uid=1000)'],
    [1219, 'sudo: pam_unix(sudo:session): session closed for user root'],
    [1240, 'sudo:   ubuntu : TTY=pts/0 ; PWD=/home/ubuntu ; USER=root ; COMMAND=/usr/bin/apt upgrade -y'],
    [1240, 'sudo: pam_unix(sudo:session): session opened for user root(uid=0) by ubuntu(uid=1000)'],
    [1318, 'sudo: pam_unix(sudo:session): session closed for user root'],
    [3600, 'CRON[3387]: pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)'],
    [3601, 'CRON[3387]: pam_unix(cron:session): session closed for user root'],
    [6842, 'sudo:   ubuntu : TTY=pts/1 ; PWD=/home/ubuntu/Projects ; USER=root ; COMMAND=/usr/bin/systemctl restart NetworkManager'],
    [6842, 'sudo: pam_unix(sudo:session): session opened for user root(uid=0) by ubuntu(uid=1000)'],
    [6843, 'sudo: pam_unix(sudo:session): session closed for user root'],
  ];
  return `${rows.map(([off, msg]) => `${at(off)} ubuntu-ai ${msg}`).join('\n')}\n`;
}

/**
 * @param {number} bootTime epoch ms
 * @returns {string} /var/log/dpkg.log
 */
export function dpkgLog(bootTime) {
  // The last upgrade ran four days before this boot.
  const base = bootTime - 4 * 86400 * 1000;
  const at = (offsetSec) => dpkgStamp(base + offsetSec * 1000);
  const packages = [
    ['libc-bin:amd64', '2.39-0ubuntu8.2', '2.39-0ubuntu8.3'],
    ['libc6:amd64', '2.39-0ubuntu8.2', '2.39-0ubuntu8.3'],
    ['python3-update-manager:all', '1:24.04.6', '1:24.04.9'],
    ['update-manager-core:all', '1:24.04.6', '1:24.04.9'],
    ['ubuntu-advantage-tools:amd64', '32.3', '32.3.1'],
    ['linux-firmware:amd64', '20240318.git3b128b60-0ubuntu2.2', '20240318.git3b128b60-0ubuntu2.3'],
  ];

  const lines = [`${at(0)} startup archives unpack`];
  let t = 1;
  for (const [name, from, to] of packages) {
    lines.push(`${at(t)} upgrade ${name} ${from} ${to}`);
    lines.push(`${at(t)} status half-configured ${name} ${from}`);
    lines.push(`${at(t + 1)} status unpacked ${name} ${to}`);
    lines.push(`${at(t + 1)} status half-installed ${name} ${to}`);
    t += 3;
  }
  lines.push(`${at(t)} startup packages configure`);
  for (const [name, , to] of packages) {
    lines.push(`${at(t)} configure ${name} ${to} <none>`);
    lines.push(`${at(t)} status unpacked ${name} ${to}`);
    lines.push(`${at(t + 1)} status half-configured ${name} ${to}`);
    lines.push(`${at(t + 1)} status installed ${name} ${to}`);
    t += 2;
  }
  lines.push(`${at(t + 4)} startup archives install`);
  lines.push(`${at(t + 5)} install neofetch:all <none> 7.1.0-4`);
  lines.push(`${at(t + 5)} status half-installed neofetch:all 7.1.0-4`);
  lines.push(`${at(t + 6)} status unpacked neofetch:all 7.1.0-4`);
  lines.push(`${at(t + 6)} configure neofetch:all 7.1.0-4 <none>`);
  lines.push(`${at(t + 7)} status installed neofetch:all 7.1.0-4`);
  return `${lines.join('\n')}\n`;
}

/**
 * @param {number} bootTime epoch ms
 * @returns {string} /var/log/wtmp-ish summary used by `last`
 */
export function lastLog(bootTime) {
  const d = new Date(bootTime);
  const stamp = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}`;
  return `ubuntu   :0           :0               ${stamp}   still logged in
reboot   system boot  6.8.0-45-generic ${stamp}   still running
`;
}
