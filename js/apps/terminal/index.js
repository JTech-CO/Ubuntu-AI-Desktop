/**
 * js/apps/terminal/index.js — the Terminal app module (ARCHITECTURE §16).
 *
 * Reproduces gnome-terminal on Ubuntu 24.04: a tab bar where every tab is an
 * independent shell session (own cwd, own environment, own history and jobs),
 * a scrollback capped at 5000 lines, selectable text, click-to-focus,
 * Ctrl+Shift+C/V through the Clipboard API, Ctrl+±/0 font zoom and the
 * right-click menu (Copy / Paste / Select All / Clear / New Tab).
 *
 * Command modules are loaded from `./commands/index.js`, which is expected to
 * export a named array `commands`. A missing or broken module is reported
 * loudly in the console but never stops the terminal from starting — the
 * builtins keep working.
 */

import { h, clear as clearNode, svg, on } from '../../core/dom.js';
import { fs } from '../../core/fs.js';
import { env } from '../../core/env.js';
import { store } from '../../core/store.js';
import { procs } from '../../core/procs.js';
import { users } from '../../core/users.js';
import { notify } from '../../core/notify.js';
import { contract } from '../../core/path.js';
import {
  execute,
  createSession,
  activateSession,
  syncSession,
  registerCommand,
  commandNames,
} from './shell.js';
import { createReadline } from './readline.js';
import { ansiToNodes, stripAnsi } from './ansi.js';
import { titleFor } from './prompt.js';

/* ------------------------------------------------------------------ *
 * command module loading
 * ------------------------------------------------------------------ */

/**
 * Kicked off at module-evaluation time so the import is already in flight by
 * the time the first window mounts. Never rejects.
 * @type {Promise<number>} how many commands were registered
 */
const commandsReady = (async () => {
  let mod;
  try {
    mod = await import('./commands/index.js');
  } catch (err) {
    console.error(
      '[terminal] could not load ./commands/index.js — starting with builtins only.',
      err,
    );
    return 0;
  }

  const list = Array.isArray(mod.commands)
    ? mod.commands
    : Array.isArray(mod.default)
      ? mod.default
      : null;

  if (!list) {
    console.error(
      '[terminal] ./commands/index.js must export a named array `commands`; got:',
      Object.keys(mod),
    );
    return 0;
  }

  let count = 0;
  for (const cmd of list) {
    try {
      registerCommand(cmd);
      count += 1;
    } catch (err) {
      console.error('[terminal] rejected a malformed command object:', cmd, err);
    }
  }
  return count;
})();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

const MAX_SCROLLBACK = 5000;
const MIN_FONT = 8;
const MAX_FONT = 32;
const DEFAULT_FONT = 14;
const SETTINGS_KEY = 'terminal';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** @type {Map<string, object>} instanceId → terminal window state */
const windows = new Map();

let openMenu = null;

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function pad2(n) { return n < 10 ? `0${n}` : String(n); }

function stamp(d) {
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${d.getFullYear()}`;
}

function motdStamp(d) {
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad2(d.getDate())} ` +
    `${pad2(h12)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${ampm} UTC ${d.getFullYear()}`;
}

function readSettings() {
  const saved = store.get(SETTINGS_KEY, null);
  const fontSize = saved && Number.isFinite(saved.fontSize) ? saved.fontSize : DEFAULT_FONT;
  return {
    fontSize: Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize)),
    lastLogin: saved && typeof saved.lastLogin === 'string' ? saved.lastLogin : '',
  };
}

function writeSettings(patch) {
  const current = store.get(SETTINGS_KEY, {}) || {};
  store.set(SETTINGS_KEY, { ...current, ...patch });
}

/**
 * The genuine Ubuntu 24.04 login MOTD, with the numbers filled in from the
 * simulated process table.
 * @param {string} lastLogin previous session stamp, '' on first run
 * @returns {string}
 */
function buildMotd(lastLogin) {
  const now = new Date();
  let totals;
  try { totals = procs.totals(); } catch { totals = null; }

  const load = totals && Array.isArray(totals.load) ? totals.load[0] : 0.08;
  const procCount = totals && Number.isFinite(totals.procCount) ? totals.procCount : 231;
  const memTotal = totals && totals.memTotalMb ? totals.memTotalMb : 16384;
  const memUsed = totals && totals.memUsedMb ? totals.memUsedMb : 5324;
  const memPct = Math.max(1, Math.round((memUsed / memTotal) * 100));
  const swapPct = totals && totals.swapTotalMb
    ? Math.round((totals.swapUsedMb / totals.swapTotalMb) * 100)
    : 0;

  const lines = [
    'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)',
    '',
    ' * Documentation:  https://help.ubuntu.com',
    ' * Management:     https://landscape.canonical.com',
    ' * Support:        https://ubuntu.com/pro',
    '',
    ` System information as of ${motdStamp(now)}`,
    '',
    `  System load:  ${load.toFixed(2).padEnd(18)}Processes:             ${procCount}`,
    `  Usage of /:   ${'38.2% of 48.28GB'.padEnd(18)}Users logged in:       1`,
    `  Memory usage: ${`${memPct}%`.padEnd(18)}IPv4 address for enp0s3: 10.0.2.15`,
    `  Swap usage:   ${swapPct}%`,
    '',
    'Expanded Security Maintenance for Applications is not enabled.',
    '',
    '7 updates can be applied immediately.',
    '3 of these updates are standard security updates.',
    'To see these additional updates run: apt list --upgradable',
    '',
    'Enable ESM Apps to receive additional future security updates.',
    'See https://ubuntu.com/esm or run: sudo pro status',
    '',
    '',
    `Last login: ${lastLogin || stamp(new Date(now.getTime() - 86_400_000))} from 127.0.0.1`,
    '',
  ];
  return `${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ *
 * context menu (self-contained — the terminal must not depend on a
 * shell module that may not be present yet)
 * ------------------------------------------------------------------ */

function closeContextMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', onGlobalPointerDown, true);
  document.removeEventListener('keydown', onGlobalMenuKey, true);
}

function onGlobalPointerDown(ev) {
  if (openMenu && !openMenu.contains(ev.target)) closeContextMenu();
}

function onGlobalMenuKey(ev) {
  if (ev.key === 'Escape') { ev.preventDefault(); closeContextMenu(); }
}

/**
 * @param {number} x @param {number} y
 * @param {{label:string, accel?:string, disabled?:boolean, separator?:boolean, onClick?:Function}[]} items
 */
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('div.term-menu', { role: 'menu' });

  for (const item of items) {
    if (item.separator) {
      menu.appendChild(h('div.term-menu-sep'));
      continue;
    }
    const button = h(
      'button.term-menu-item',
      { type: 'button', role: 'menuitem', disabled: item.disabled === true },
      h('span.term-menu-label', { text: item.label }),
      item.accel ? h('span.term-menu-accel', { text: item.accel }) : null,
    );
    button.addEventListener('click', () => {
      closeContextMenu();
      if (typeof item.onClick === 'function') item.onClick();
    });
    menu.appendChild(button);
  }

  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  openMenu = menu;
  document.addEventListener('pointerdown', onGlobalPointerDown, true);
  document.addEventListener('keydown', onGlobalMenuKey, true);
}

/* ------------------------------------------------------------------ *
 * a tab = one shell session + one scrollback + one readline
 * ------------------------------------------------------------------ */

function createTab(win, opts = {}) {
  const session = createSession({ cwd: opts.cwd || env.home });
  const pid = procs.spawn({ name: 'bash', cmd: '/bin/bash', cpu: 0.2, mem: 4 });
  session.vars.set('SHLVL', '1');

  const scrollback = h('div.term-scrollback', { role: 'log', 'aria-live': 'off' });
  const view = h('div.term-view', { tabindex: '-1' }, scrollback);
  win.body.appendChild(view);

  const tab = {
    id: `t${(win.tabSeq += 1)}`,
    session,
    pid,
    view,
    scrollback,
    current: null,
    lineCount: 0,
    controller: null,
    rl: null,
    chip: null,
    label: null,
  };

  /* --- output plumbing ------------------------------------------- */

  const openLine = () => {
    if (!tab.current) {
      tab.current = h('div.term-line');
      scrollback.appendChild(tab.current);
      tab.lineCount += 1;
    }
    return tab.current;
  };

  const closeLine = () => { openLine(); tab.current = null; };

  const trim = () => {
    while (scrollback.childElementCount > MAX_SCROLLBACK && scrollback.firstChild) {
      if (scrollback.firstChild === tab.current) break;
      scrollback.removeChild(scrollback.firstChild);
    }
  };

  const atBottom = () => view.scrollHeight - view.scrollTop - view.clientHeight < 48;

  const write = (text) => {
    if (text === undefined || text === null) return;
    const stick = atBottom();
    const chunks = String(text).split('\n');
    for (let i = 0; i < chunks.length; i += 1) {
      if (i > 0) closeLine();
      let segment = chunks[i];
      if (segment === '') continue;
      const cr = segment.lastIndexOf('\r');
      if (cr >= 0) {
        clearNode(openLine());
        segment = segment.slice(cr + 1);
        if (segment === '') continue;
      }
      openLine().appendChild(ansiToNodes(segment));
    }
    trim();
    if (stick) view.scrollTop = view.scrollHeight;
  };

  const clearScreen = () => {
    clearNode(scrollback);
    tab.current = null;
    tab.lineCount = 0;
    view.scrollTop = 0;
  };

  tab.write = write;
  tab.clearScreen = clearScreen;

  /** The `term` handle every command receives (ARCHITECTURE §17). */
  tab.term = {
    get cols() { return win.cols(); },
    get rows() { return win.rows(); },
    write,
    writeLine(text) { write(`${text === undefined || text === null ? '' : text}\n`); },
    clear: clearScreen,
    ask(prompt, options) { return tab.rl ? tab.rl.ask(prompt, options) : Promise.resolve(''); },
  };

  /* --- readline --------------------------------------------------- */

  tab.rl = createReadline({
    session,
    container: view,
    cols: () => win.cols(),
    write,
    clearScreen,
    onEOF: () => win.closeTab(tab),
    onInterrupt: () => {
      if (tab.controller) tab.controller.abort();
      write('^C\n');
    },
    onSubmit: (line) => runLine(win, tab, line),
  });

  view.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (win.activeTab === tab) tab.rl.focus();
  });

  view.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openTerminalMenu(win, ev.clientX, ev.clientY);
  });

  return tab;
}

async function runLine(win, tab, line) {
  tab.controller = new AbortController();
  activateSession(tab.session);
  try {
    await execute(line, {
      session: tab.session,
      term: tab.term,
      signal: tab.controller.signal,
      onExit: () => { win.pendingClose = tab; },
    });
  } catch (err) {
    console.error('[terminal] uncaught execution error:', err);
    tab.write(`bash: ${err && err.message ? err.message : 'internal error'}\n`);
  } finally {
    syncSession(tab.session);
    tab.controller = null;
    win.refreshTabs();
    if (win.pendingClose === tab) {
      win.pendingClose = null;
      win.closeTab(tab);
    }
  }
}

/* ------------------------------------------------------------------ *
 * clipboard + menu actions
 * ------------------------------------------------------------------ */

function selectionText() {
  const selection = window.getSelection();
  return selection ? String(selection) : '';
}

async function copySelection(win) {
  const text = selectionText();
  if (text === '') return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    notify.show({
      app: 'Terminal',
      title: 'Copy failed',
      body: 'The browser refused clipboard access for this page.',
    });
  }
  if (win && win.activeTab) win.activeTab.rl.focus();
}

async function pasteClipboard(win) {
  const tab = win.activeTab;
  if (!tab) return;
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    notify.show({
      app: 'Terminal',
      title: 'Paste failed',
      body: 'Grant clipboard permission, or use Ctrl+Shift+V with the browser prompt.',
    });
    return;
  }
  if (text) tab.rl.paste(text);
  tab.rl.focus();
}

function selectAll(win) {
  const tab = win.activeTab;
  if (!tab) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(tab.view);
  selection.removeAllRanges();
  selection.addRange(range);
}

function openTerminalMenu(win, x, y) {
  const hasSelection = selectionText() !== '';
  showContextMenu(x, y, [
    { label: 'Copy', accel: 'Ctrl+Shift+C', disabled: !hasSelection, onClick: () => copySelection(win) },
    { label: 'Paste', accel: 'Ctrl+Shift+V', onClick: () => pasteClipboard(win) },
    { separator: true },
    { label: 'Select All', accel: 'Ctrl+Shift+A', onClick: () => selectAll(win) },
    { label: 'Clear', accel: 'Ctrl+L', onClick: () => {
      if (!win.activeTab) return;
      win.activeTab.clearScreen();
      win.activeTab.rl.render();
      win.activeTab.rl.focus();
    } },
    { separator: true },
    { label: 'New Tab', accel: 'Ctrl+Shift+T', onClick: () => win.newTab() },
  ]);
}

/* ------------------------------------------------------------------ *
 * mount
 * ------------------------------------------------------------------ */

function mountTerminal(root, ctx) {
  const settings = readSettings();

  const tabStrip = h('div.term-tabstrip', { role: 'tablist' });
  const addButton = h('button.term-tab-add', {
    type: 'button',
    title: 'New Tab (Ctrl+Shift+T)',
    'aria-label': 'New Tab',
    text: '+',
  });
  const tabBar = h('div.term-tabbar', {}, tabStrip, addButton);
  const body = h('div.term-body');
  const app = h('div.terminal-app', {}, tabBar, body);
  app.style.setProperty('--term-font-size', `${settings.fontSize}px`);
  root.appendChild(app);

  const probe = h('span.term-measure', { text: 'M'.repeat(80) });

  const win = {
    ctx,
    app,
    body,
    tabBar,
    tabStrip,
    tabs: [],
    tabSeq: 0,
    activeTab: null,
    pendingClose: null,
    fontSize: settings.fontSize,
    charW: 8.4,
    lineH: 19,
    disposed: false,
  };

  win.measure = () => {
    body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    if (rect.width > 0) win.charW = rect.width / 80;
    if (rect.height > 0) win.lineH = rect.height;
    probe.remove();
  };

  win.cols = () => {
    const w = win.activeTab ? win.activeTab.view.clientWidth : body.clientWidth;
    return Math.max(20, Math.floor((w - 20) / win.charW));
  };
  win.rows = () => {
    const hgt = win.activeTab ? win.activeTab.view.clientHeight : body.clientHeight;
    return Math.max(4, Math.floor(hgt / win.lineH));
  };

  /* --- tab management --------------------------------------------- */

  win.refreshTabs = () => {
    if (win.disposed) return;
    tabBar.classList.toggle('is-single', win.tabs.length < 2);
    for (const tab of win.tabs) {
      const title = titleFor(tab.session);
      if (tab.label) tab.label.textContent = title;
      if (tab.chip) {
        tab.chip.classList.toggle('is-active', tab === win.activeTab);
        tab.chip.setAttribute('aria-selected', tab === win.activeTab ? 'true' : 'false');
        tab.chip.title = title;
      }
    }
    if (win.activeTab && typeof ctx.setTitle === 'function') {
      ctx.setTitle(titleFor(win.activeTab.session));
    }
  };

  win.selectTab = (tab) => {
    if (!tab || win.disposed) return;
    win.activeTab = tab;
    for (const other of win.tabs) other.view.classList.toggle('is-active', other === tab);
    activateSession(tab.session);
    win.refreshTabs();
    tab.rl.focus();
    tab.view.scrollTop = tab.view.scrollHeight;
  };

  win.newTab = (opts = {}) => {
    const tab = createTab(win, opts);

    const label = h('span.term-tab-label', { text: 'Terminal' });
    const close = h('button.term-tab-close', {
      type: 'button',
      title: 'Close Tab',
      'aria-label': 'Close Tab',
      text: '×',
    });
    const chip = h('div.term-tab', { role: 'tab', tabindex: '0' }, label, close);

    chip.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) { ev.preventDefault(); win.closeTab(tab); return; }
      if (ev.button === 0 && ev.target !== close) win.selectTab(tab);
    });
    chip.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); win.selectTab(tab); }
    });
    close.addEventListener('click', (ev) => { ev.stopPropagation(); win.closeTab(tab); });

    tab.chip = chip;
    tab.label = label;
    tabStrip.appendChild(chip);
    win.tabs.push(tab);
    win.selectTab(tab);

    commandsReady.then(() => {
      if (!win.disposed) tab.rl.render();
    });
    return tab;
  };

  win.closeTab = (tab) => {
    const index = win.tabs.indexOf(tab);
    if (index < 0) return;
    if (tab.controller) tab.controller.abort();
    tab.rl.dispose();
    tab.view.remove();
    if (tab.chip) tab.chip.remove();
    procs.kill(tab.pid, 9);
    win.tabs.splice(index, 1);

    if (win.tabs.length === 0) {
      if (typeof ctx.close === 'function') ctx.close();
      return;
    }
    win.selectTab(win.tabs[Math.min(index, win.tabs.length - 1)]);
  };

  win.setFontSize = (size) => {
    win.fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(size)));
    app.style.setProperty('--term-font-size', `${win.fontSize}px`);
    writeSettings({ fontSize: win.fontSize });
    win.measure();
  };

  /* --- window-level shortcuts -------------------------------------- */

  const offKeys = on(app, 'keydown', (ev) => {
    if (win.disposed) return;

    if (ev.ctrlKey && ev.shiftKey) {
      const key = ev.key.toLowerCase();
      if (key === 'c') { ev.preventDefault(); copySelection(win); return; }
      if (key === 'v') { ev.preventDefault(); pasteClipboard(win); return; }
      if (key === 't') { ev.preventDefault(); win.newTab({ cwd: win.activeTab ? win.activeTab.session.cwd : env.home }); return; }
      if (key === 'w') { ev.preventDefault(); if (win.activeTab) win.closeTab(win.activeTab); return; }
      if (key === 'a') { ev.preventDefault(); selectAll(win); return; }
      return;
    }

    if (ev.ctrlKey && !ev.altKey) {
      if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); win.setFontSize(win.fontSize + 1); return; }
      if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); win.setFontSize(win.fontSize - 1); return; }
      if (ev.key === '0') { ev.preventDefault(); win.setFontSize(DEFAULT_FONT); return; }
      if (ev.key === 'PageDown') { ev.preventDefault(); cycleTab(win, 1); return; }
      if (ev.key === 'PageUp') { ev.preventDefault(); cycleTab(win, -1); return; }
    }

    if (ev.altKey && !ev.ctrlKey && /^[1-9]$/.test(ev.key)) {
      const target = win.tabs[Number(ev.key) - 1];
      if (target) { ev.preventDefault(); win.selectTab(target); }
    }
  });

  const offWheel = on(app, 'wheel', (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    win.setFontSize(win.fontSize + (ev.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  const offMenu = on(tabBar, 'contextmenu', (ev) => {
    ev.preventDefault();
    openTerminalMenu(win, ev.clientX, ev.clientY);
  });

  addButton.addEventListener('click', () => {
    win.newTab({ cwd: win.activeTab ? win.activeTab.session.cwd : env.home });
  });

  win.dispose = () => {
    if (win.disposed) return;
    win.disposed = true;
    offKeys();
    offWheel();
    offMenu();
    closeContextMenu();
    for (const tab of win.tabs.slice()) {
      if (tab.controller) tab.controller.abort();
      tab.rl.dispose();
      procs.kill(tab.pid, 9);
    }
    win.tabs.length = 0;
  };

  /* --- first tab + MOTD -------------------------------------------- */

  const first = win.newTab({ cwd: (ctx.args && ctx.args.cwd) || env.home });
  win.measure();

  first.write(buildMotd(settings.lastLogin));
  writeSettings({ lastLogin: stamp(new Date()) });
  first.rl.render();

  commandsReady.then((count) => {
    if (win.disposed) return;
    if (count === 0) {
      first.write(
        'bash: warning: no external commands were registered — ' +
        'check the browser console for the ./commands/index.js error.\n\n',
      );
      first.rl.render();
    }
    const initial = ctx.args && typeof ctx.args.command === 'string' ? ctx.args.command : '';
    if (initial) first.rl.submitLine(initial);
  });

  return win;
}

function cycleTab(win, direction) {
  if (win.tabs.length < 2) return;
  const index = win.tabs.indexOf(win.activeTab);
  const next = (index + direction + win.tabs.length) % win.tabs.length;
  win.selectTab(win.tabs[next]);
}

/* ------------------------------------------------------------------ *
 * the app module
 * ------------------------------------------------------------------ */

const terminalApp = {
  id: 'terminal',
  name: 'Terminal',
  genericName: 'Terminal',
  pinned: true,
  singleton: false,
  width: 900,
  height: 560,
  minWidth: 420,
  minHeight: 260,
  resizable: true,
  themeClass: 'app-terminal',
  darkChrome: true,

  /** @returns {Element} */
  icon() {
    return svg(
      [
        'M3.2 4.5h17.6a1.2 1.2 0 0 1 1.2 1.2v12.6a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 18.3V5.7a1.2 1.2 0 0 1 1.2-1.2z',
        'M6.4 9.3l3 2.7-3 2.7',
        'M12.4 15h5',
      ],
      { class: 'app-icon app-icon-terminal', strokeWidth: 1.6 },
    );
  },

  /**
   * @param {Element} root the window content element
   * @param {object} ctx
   */
  mount(root, ctx) {
    const win = mountTerminal(root, ctx);
    windows.set(ctx.instanceId, win);
  },

  onFocus(ctx) {
    const win = windows.get(ctx.instanceId);
    if (!win || !win.activeTab) return;
    activateSession(win.activeTab.session);
    win.activeTab.rl.focus();
  },

  onBlur(ctx) {
    const win = windows.get(ctx.instanceId);
    if (!win || !win.activeTab) return;
    win.activeTab.rl.blur();
  },

  onResize(ctx) {
    const win = windows.get(ctx.instanceId);
    if (!win) return;
    win.measure();
    if (win.activeTab) win.activeTab.view.scrollTop = win.activeTab.view.scrollHeight;
  },

  onClose(ctx) {
    const win = windows.get(ctx.instanceId);
    if (!win) return true;
    win.dispose();
    windows.delete(ctx.instanceId);
    fs.persist();
    return true;
  },
};

export default terminalApp;

/* Re-exported so other apps (Code-OSS's integrated panel) can reuse the engine
 * without reaching into the shell module directly. */
export { execute, createSession, commandNames, stripAnsi, ansiToNodes, contract, users };
