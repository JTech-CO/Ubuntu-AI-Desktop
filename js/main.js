/**
 * main.js — boot sequence (ARCHITECTURE §20).
 *
 * The single entry point loaded by index.html. Nothing else attaches to the
 * document at import time; every subsystem exposes an `install()` that this
 * file calls in a defined order.
 *
 * Each step is wrapped in `step()` so that one broken subsystem logs a clear
 * console group and the rest of the desktop still comes up. A desktop that
 * boots with a dead dock is far more debuggable than a blank page.
 */

import { bus } from './core/bus.js';
import { store } from './core/store.js';
import { fs } from './core/fs.js';
import { procs } from './core/procs.js';
import { metrics } from './core/metrics.js';
import { env } from './core/env.js';
import { notify } from './core/notify.js';
import { dialog } from './core/dialog.js';
import { h } from './core/dom.js';
import { gemini } from './services/gemini.js';

import { wm } from './shell/window-manager.js';
import { installTopBar } from './shell/top-bar.js';
import { installDock } from './shell/dock.js';
import { installSystemMenu, applyShellSettings } from './shell/system-menu.js';
import { installOverview } from './shell/overview.js';
import { installKeybindings } from './shell/keybindings.js';
import { openMenu as openContextMenu, isMenuOpen } from './shell/context-menu.js';
import { install as installSettingsBridge } from './shell/settings-bridge.js';
import { keyboardCapture } from './shell/keyboard-capture.js';
import { overview } from './shell/overview.js';
import { topBar } from './shell/top-bar.js';
import { systemMenu, isLocked } from './shell/system-menu.js';
import { runDialog } from './shell/run-dialog.js';

import { apps, getApp } from './apps/registry.js';
import { settings, applySettings } from './apps/settings/state.js';

/* ===================================================================== *
 * step runner
 * ===================================================================== */

const failures = [];

/**
 * Run one boot step, isolating its failure.
 * @param {string} label
 * @param {() => any} fn
 * @returns {any} the step's return value, or undefined when it threw
 */
function step(label, fn) {
  try {
    return fn();
  } catch (err) {
    failures.push(label);
    console.group(`%c[boot] ${label} failed`, 'color:#c01c28;font-weight:bold');
    console.error(err);
    console.groupEnd();
    return undefined;
  }
}

/* ===================================================================== *
 * 1. appearance — applied before the splash lifts, so there is no flash
 * ===================================================================== */

step('apply saved appearance', () => {
  applySettings();
  applyShellSettings();
});

step('install settings bridge', () => installSettingsBridge());

/* ===================================================================== *
 * 2. filesystem
 * ===================================================================== */

const firstRun = step('restore filesystem', () => {
  const snapshot = store.get('fs', null);
  if (snapshot) {
    fs.restore(snapshot);
    return false;
  }
  fs.reset();
  store.set('firstrun', { at: Date.now() });
  return true;
});

/* ===================================================================== *
 * 3. simulation clock
 * Exactly one interval drives the process table and the metric rings; apps
 * read from those rather than running timers of their own.
 * ===================================================================== */

step('start simulation clock', () => {
  const tick = () => {
    procs.tick();
    const t = procs.totals();
    metrics.push('cpu', t.cpu);
    metrics.push('mem', t.memUsedMb);
    // Idle network chatter, in KiB/s, so the Resources graph is not flat.
    metrics.push('net', Math.max(0, Math.round(t.cpu * 1.8 + Math.random() * 40)));
  };
  tick();
  const id = setInterval(tick, 1000);
  // Pause the simulation while the tab is hidden — a background tab throttles
  // timers anyway, and this keeps the graphs from showing a false flat line.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tick();
  });
  return id;
});

/* ===================================================================== *
 * 4. applications — registered before the shell, because the dock and the
 *    overview read the registry as soon as they install
 * ===================================================================== */

step('register applications', () => {
  for (const app of apps) wm.register(app);
});

/* ===================================================================== *
 * 5. shell
 * ===================================================================== */

step('install system menu', () => installSystemMenu());
step('install top bar', () => installTopBar());
step('install dock', () => installDock());
step('install overview', () => installOverview());
step('install keybindings', () => installKeybindings());

step('install keyboard capture', () => {
  keyboardCapture.install();

  // Escape only offers to leave once nothing inside the desktop still wants
  // it. Registering the predicates from here keeps keyboard-capture.js free of
  // any import on the shell UI, which would otherwise be a cycle: top-bar.js
  // already imports keyboard-capture.js for its indicator.
  keyboardCapture.addExitGuard(
    () =>
      isLocked() ||
      dialog.isOpen() ||
      runDialog.isOpen() ||
      overview.isOpen() ||
      isMenuOpen() ||
      systemMenu.isOpen() ||
      topBar.isCalendarOpen(),
  );
});

/* ===================================================================== *
 * 6. desktop surface — icons from ~/Desktop and the right-click menu
 * ===================================================================== */

/**
 * Pick the app that should open a given file.
 * @param {string} name
 * @returns {string} an app id
 */
function appForFile(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['py', 'js', 'ts', 'json', 'sh', 'c', 'cpp', 'h', 'java', 'css', 'html'].includes(ext)) {
    return 'codeoss';
  }
  return 'editor';
}

const desktopLayer = document.getElementById('desktop-icons');

/** Re-render the desktop icons from ~/Desktop. */
function renderDesktopIcons() {
  if (!desktopLayer) return;
  desktopLayer.replaceChildren();

  const dir = `${fs.HOME}/Desktop`;
  let entries = [];
  try {
    entries = fs.readdir(dir, { withStats: true });
  } catch {
    return; // ~/Desktop may not exist yet; nothing to draw
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const label = h('span.desktop-icon__label', { text: entry.name });
    const glyph = h('span.desktop-icon__glyph', {
      text: entry.isDir ? '\u{1F4C1}' : '\u{1F4C4}',
      'aria-hidden': 'true',
    });
    const button = h(
      'button.desktop-icon',
      { type: 'button', title: entry.name, dataset: { path: `${dir}/${entry.name}` } },
      glyph,
      label,
    );

    button.addEventListener('dblclick', () => {
      if (entry.isDir) wm.open('files', { path: `${dir}/${entry.name}` });
      else wm.open(appForFile(entry.name), { path: `${dir}/${entry.name}` });
    });

    desktopLayer.appendChild(button);
  }
}

step('render desktop icons', () => {
  renderDesktopIcons();
  // Keep the desktop in step with the filesystem, but only for changes that
  // could affect ~/Desktop.
  bus.on('fs:change', (payload) => {
    const p = payload && payload.path;
    if (!p || p === '/' || p.startsWith(`${fs.HOME}/Desktop`)) renderDesktopIcons();
  });
});

step('wire desktop context menu', () => {
  const desktop = document.getElementById('desktop');
  if (!desktop) return;

  desktop.addEventListener('contextmenu', (ev) => {
    // Let windows, the dock and the panels handle their own menus.
    if (ev.target.closest('.window, .dock, .top-bar, .overview')) return;
    ev.preventDefault();

    openContextMenu(ev.clientX, ev.clientY, [
      {
        label: 'New Folder',
        onClick: async () => {
          const name = await dialog.prompt({
            title: 'New Folder',
            body: 'Folder name',
            value: 'Untitled Folder',
          });
          if (!name) return;
          try {
            fs.mkdir(`${fs.HOME}/Desktop/${name}`);
          } catch (err) {
            notify.show({ app: 'Files', title: 'Could not create folder', body: String(err.message || err) });
          }
        },
      },
      { separator: true },
      { label: 'Change Background…', onClick: () => wm.open('settings', { section: 'background' }) },
      { label: 'Display Settings', onClick: () => wm.open('settings', { section: 'displays' }) },
      { separator: true },
      { label: 'Open Terminal', accel: 'Ctrl+Alt+T', onClick: () => wm.open('terminal') },
      { label: 'Settings', onClick: () => wm.open('settings') },
    ]);
  });
});

/* ===================================================================== *
 * 7. session — restore the previous windows, or open a Terminal
 * ===================================================================== */

/** Persist which apps are open so the next boot can restore them. */
function saveSession() {
  if (!settings.get('session.restore', true)) return;
  const open = wm
    .instances()
    .map((inst) => inst.appId)
    .filter((id, i, arr) => arr.indexOf(id) === i);
  store.set('session', open);
}

step('restore session', () => {
  const restore = settings.get('session.restore', true);
  const previous = restore ? store.get('session', null) : null;

  const toOpen =
    Array.isArray(previous) && previous.length
      ? previous.filter((id) => getApp(id))
      : ['terminal'];

  // A short delay lets the first paint (and the splash fade) land first.
  setTimeout(() => {
    for (const id of toOpen) wm.open(id);
  }, 260);
});

/**
 * Set while a deliberate wipe is in progress, so the unload handler does not
 * write the state back out again.
 */
let wiping = false;

/**
 * Offer to trap the keyboard.
 *
 * This has to be a click target rather than something boot does by itself:
 * `requestFullscreen()` — which keyboard lock depends on — is only granted
 * during a user gesture, so an automatic call at startup would always fail.
 * The prompt is shown when capture is possible and the user has not already
 * turned it down, and it remembers a dismissal.
 */
function offerKeyboardCapture() {
  if (!keyboardCapture.isSupported()) return;
  if (keyboardCapture.isActive()) return;
  if (store.get('keyboardCapturePromptDismissed', false) === true) return;

  const prompt = h(
    'div.kbd-prompt',
    { role: 'dialog', 'aria-label': '키보드 캡처' },
    h('span.kbd-prompt__icon', { 'aria-hidden': 'true' }, h('span', { text: '⌨' })),
    h('span.kbd-prompt__text', {}, h('b', { text: 'Ctrl+T · Ctrl+W 를 우분투 안에서 쓰시겠습니까? ' }), h('span', {
      text:
        '지금은 브라우저가 그 키들을 먼저 가져가서 진짜 크롬 탭이 열리고 닫힙니다. ' +
        '전체화면으로 전환하면 에뮬레이터가 키보드를 받습니다.',
    })),
    h('span.kbd-prompt__actions'),
  );

  const actions = prompt.querySelector('.kbd-prompt__actions');
  const close = () => {
    prompt.classList.remove('is-shown');
    setTimeout(() => prompt.remove(), 260);
  };

  const enableBtn = h('button.kbd-prompt__button.kbd-prompt__button--primary', {
    type: 'button',
    text: '키보드 잠그기',
  });
  enableBtn.addEventListener('click', async () => {
    // Inside the click handler, so the gesture is still live.
    const ok = await keyboardCapture.enable();
    if (ok) close();
  });

  const laterBtn = h('button.kbd-prompt__button', { type: 'button', text: '나중에' });
  laterBtn.addEventListener('click', () => {
    store.set('keyboardCapturePromptDismissed', true);
    close();
  });

  actions.appendChild(enableBtn);
  actions.appendChild(laterBtn);
  document.body.appendChild(prompt);
  requestAnimationFrame(() => prompt.classList.add('is-shown'));
}

step('offer keyboard capture', () => {
  // After the splash has gone, so it does not fight the boot animation.
  setTimeout(offerKeyboardCapture, 1400);
});

step('register session persistence', () => {
  bus.on('win:open', saveSession);
  bus.on('win:close', saveSession);
  window.addEventListener('beforeunload', () => {
    if (wiping) return;

    // If the `fs` key has vanished while the page was open, someone cleared
    // storage deliberately (the documented `localStorage.clear()` reset, or the
    // browser's "clear site data"). Persisting here would resurrect exactly the
    // state they just deleted, so the reset would silently do nothing.
    if (store.get('fs', null) === null) return;

    fs.persist();
    saveSession();
  });
});

/**
 * Wipe every trace of this desktop and start over: filesystem, settings, API
 * key, session and shell history.
 *
 * @param {{reload?: boolean}} [opts]
 * @returns {void}
 */
function resetDesktop({ reload = true } = {}) {
  wiping = true;
  store.clear();
  if (reload) window.location.reload();
}

/* ===================================================================== *
 * 8. debug handle + splash
 * ===================================================================== */

window.UAD = {
  fs, wm, procs, env, bus, store, gemini, metrics, notify, settings, apps,
  reset: resetDesktop,
};

step('dismiss boot splash', () => {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.classList.add('is-done');
  splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  // Belt and braces: remove it even if the transition never fires.
  setTimeout(() => splash.remove(), 1200);
});

if (failures.length) {
  console.warn(
    `[boot] Ubuntu AI Desktop started with ${failures.length} failed step(s): ` +
      `${failures.join(', ')}. The desktop is running in a degraded state.`,
  );
} else {
  console.info(
    `%cUbuntu AI Desktop%c ready — ${apps.length} apps, ` +
      `${procs.list().length} processes${firstRun ? ', fresh install' : ''}. ` +
      'Inspect window.UAD to poke at the internals.',
    'color:#e95420;font-weight:bold',
    'color:inherit',
  );
}
