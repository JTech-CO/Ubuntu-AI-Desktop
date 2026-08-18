/**
 * js/shell/session.js — session actions split out of `system-menu.js`
 * (ARCHITECTURE §15) to keep that module focused.
 *
 * Owns the end-session dialog, the power-off / restart / suspend overlay,
 * the GNOME lock screen and the screenshot action.
 *
 * The screenshot is a *real* capture: `getDisplayMedia` grabs one frame of the
 * surface the user picks, and the PNG that lands in ~/Pictures/Screenshots is
 * genuinely that frame. See `takeScreenshot` for what happens when the browser
 * cannot give us one.
 *
 * Imports nothing from the other shell panels — it announces itself with
 * `shell:popover` so open popovers dismiss themselves — which keeps the
 * shell import graph acyclic.
 */

import { h, svg } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { fs } from '../core/fs.js';
import { users } from '../core/users.js';
import { notify } from '../core/notify.js';
import { dialog } from '../core/dialog.js';
import { wm } from './window-manager.js';

const PERSON = [
  'M12 12.4a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2',
  'M4.4 20.4a7.6 7.6 0 0 1 15.2 0',
];
const CAMERA = [
  'M3.4 8.6h3.3l1.7-2.6h7.2l1.7 2.6h3.3v10.4H3.4z',
  'M12 16.6a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dismissPopovers() {
  bus.emit('shell:popover', { id: 'session' });
}

/**
 * The Ubuntu "Circle of Friends" mark, drawn from primitives so it needs no
 * external asset. Inherits `currentColor`.
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function ubuntuLogo(size = 96) {
  const root = h('svg.ubuntu-logo', {
    viewBox: '0 0 100 100',
    width: String(size),
    height: String(size),
    'aria-hidden': 'true',
  });
  const circumference = 2 * Math.PI * 30;
  const segment = circumference / 3;
  const gap = segment * 0.3;
  root.appendChild(h('circle', {
    cx: '50', cy: '50', r: '30',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '8.5',
    'stroke-dasharray': `${(segment - gap).toFixed(2)} ${gap.toFixed(2)}`,
    transform: 'rotate(-99 50 50)',
  }));
  for (let i = 0; i < 3; i += 1) {
    const deg = -99 + (((segment - gap / 2) + segment * i) / circumference) * 360;
    const rad = (deg * Math.PI) / 180;
    root.appendChild(h('circle', {
      cx: (50 + 30 * Math.cos(rad)).toFixed(2),
      cy: (50 + 30 * Math.sin(rad)).toFixed(2),
      r: '9.4',
      fill: 'currentColor',
    }));
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * screenshot
 * ------------------------------------------------------------------ */

/** White full-screen flash, like gnome-screenshot's capture feedback. */
export function flashScreen() {
  const flash = h('div.screen-flash', { 'aria-hidden': 'true' });
  document.body.appendChild(flash);
  void flash.offsetHeight;
  flash.classList.add('screen-flash--on');
  setTimeout(() => {
    flash.classList.remove('screen-flash--on');
    setTimeout(() => flash.remove(), 320);
  }, 90);
}

/** Where GNOME puts its shots, and the name format it uses. */
const SHOT_DIR = '/home/ubuntu/Pictures/Screenshots';

/**
 * `Screenshot from 2026-08-18 09-41-02.png` — byte for byte the name
 * gnome-screenshot writes.
 * @param {Date} [when]
 * @returns {string}
 */
export function screenshotName(when = new Date()) {
  const stamp =
    `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())} ` +
    `${pad2(when.getHours())}-${pad2(when.getMinutes())}-${pad2(when.getSeconds())}`;
  return `Screenshot from ${stamp}.png`;
}

/**
 * Abort-aware sleep used for `gnome-screenshot -d`.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Stop every track of a stream. Called the instant a frame is in hand so the
 * browser's "sharing" indicator never outlives the capture.
 * @param {MediaStream|null} stream
 */
function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already ended */
    }
  }
}

/**
 * Draw a bitmap-ish source onto a fresh canvas and export a PNG data URL.
 * @param {CanvasImageSource} source
 * @param {number} width
 * @param {number} height
 * @returns {string} a `data:image/png;base64,…` URL
 */
function toPng(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/**
 * Pull a single frame out of a live video track.
 *
 * `ImageCapture.grabFrame()` is the direct route where it exists (Chromium).
 * Everywhere else the track is played into a detached `<video>` and the first
 * painted frame is drawn to a canvas.
 *
 * @param {MediaStream} stream
 * @returns {Promise<string>} a PNG data URL
 */
async function grabFrame(stream) {
  const [track] = stream.getVideoTracks();
  if (!track) throw new Error('the capture stream carries no video track');

  if (typeof window.ImageCapture === 'function') {
    try {
      const capture = new window.ImageCapture(track);
      const bitmap = await capture.grabFrame();
      const png = toPng(bitmap, bitmap.width, bitmap.height);
      if (typeof bitmap.close === 'function') bitmap.close();
      return png;
    } catch {
      // Some platforms expose ImageCapture but refuse grabFrame on a display
      // track; fall through to the <video> route.
    }
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  await new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const failed = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error('the capture stream never produced a frame'));
    };
    const timer = setTimeout(() => failed(new Error('timed out waiting for the first frame')), 4000);

    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('error', failed, { once: true });
    Promise.resolve(video.play()).catch(failed);
  });

  // One more frame boundary, so we never export a blank first buffer.
  if (typeof video.requestVideoFrameCallback === 'function') {
    await new Promise((resolve) => {
      video.requestVideoFrameCallback(() => resolve());
      setTimeout(resolve, 400);
    });
  } else {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  const settings = stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
  const width = video.videoWidth || settings.width || window.innerWidth;
  const height = video.videoHeight || settings.height || window.innerHeight;
  const png = toPng(video, width, height);
  video.pause();
  video.srcObject = null;
  return png;
}

/**
 * The honest fallback: a labelled placeholder that says, in the image itself,
 * that no real capture was possible. Never dressed up as a genuine shot.
 *
 * @param {string} reason a short human explanation
 * @returns {string} a PNG data URL
 */
function placeholderPng(reason) {
  const width = 1280;
  const height = 720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d');

  const sky = c.createLinearGradient(0, 0, width, height);
  sky.addColorStop(0, '#2c001e');
  sky.addColorStop(0.55, '#772953');
  sky.addColorStop(1, '#e95420');
  c.fillStyle = sky;
  c.fillRect(0, 0, width, height);

  c.fillStyle = 'rgba(0, 0, 0, 0.42)';
  c.fillRect(0, height / 2 - 118, width, 236);

  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#ffffff';
  c.font = '700 46px Ubuntu, system-ui, sans-serif';
  c.fillText('SIMULATED CAPTURE', width / 2, height / 2 - 56);

  c.font = '400 24px Ubuntu, system-ui, sans-serif';
  c.fillStyle = 'rgba(255, 255, 255, 0.9)';
  c.fillText('This is not a real screenshot of the screen.', width / 2, height / 2 - 4);
  c.fillText(reason, width / 2, height / 2 + 36);

  c.font = '400 18px "Ubuntu Mono", ui-monospace, monospace';
  c.fillStyle = 'rgba(255, 255, 255, 0.72)';
  c.fillText(new Date().toString(), width / 2, height / 2 + 84);

  c.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  c.lineWidth = 4;
  c.strokeRect(2, 2, width - 4, height - 4);

  return canvas.toDataURL('image/png');
}

/**
 * Capture the screen and save it to `~/Pictures/Screenshots`.
 *
 * The frame comes from `navigator.mediaDevices.getDisplayMedia`, so the browser
 * shows its own picker and the user chooses what is shared. That API needs a
 * transient user activation, which both callers provide — the `Print`
 * keybinding runs inside the keydown handler, and the quick-settings button
 * fires 220 ms after its click, well inside the activation window.
 *
 * Outcomes:
 *   - the user picks a surface  → a real PNG of that surface is written;
 *   - the user cancels          → nothing is written, a notification says so;
 *   - the API is unavailable    → a placeholder PNG that states on its own face
 *                                 that it is simulated (an insecure context or
 *                                 a browser without the API).
 *
 * @param {{delay?: number, notify?: boolean}} [opts]
 *        `delay` is milliseconds to wait after the stream is granted and before
 *        the frame is taken — `gnome-screenshot -d N` uses it.
 * @returns {Promise<{path: string, name: string, simulated: boolean}|null>}
 *          null when the user cancelled, so callers can stay silent.
 */
export async function takeScreenshot({ delay: delayMs = 0, notify: announce = true } = {}) {
  const media = navigator.mediaDevices;
  const available =
    Boolean(media && typeof media.getDisplayMedia === 'function') && window.isSecureContext !== false;

  let dataUrl = '';
  let simulated = false;

  if (available) {
    let stream = null;
    try {
      stream = await media.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
      });
    } catch (err) {
      const name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        notify.show({
          app: 'Screenshot',
          title: 'Screenshot cancelled',
          body: 'Nothing was saved.',
          icon: svg(CAMERA, { size: 18, strokeWidth: 1.6 }),
          timeout: 4000,
        });
        return null;
      }
      console.warn('[session] getDisplayMedia failed:', err);
      simulated = true;
      dataUrl = placeholderPng('The browser refused to share the screen.');
    }

    if (stream) {
      try {
        if (delayMs > 0) await delay(delayMs);
        // Grab first, flash second: the flash overlay is part of the page, so
        // firing it before the grab would bleach the captured frame.
        dataUrl = await grabFrame(stream);
        flashScreen();
      } catch (err) {
        console.warn('[session] could not grab a frame:', err);
        simulated = true;
        dataUrl = placeholderPng('The shared surface produced no frame.');
      } finally {
        stopStream(stream);
      }
    }
  } else {
    if (delayMs > 0) await delay(delayMs);
    flashScreen();
    simulated = true;
    dataUrl = placeholderPng(
      window.isSecureContext === false
        ? 'Screen capture needs a secure context (https or localhost).'
        : 'This browser does not offer getDisplayMedia.',
    );
  }

  const name = screenshotName();
  const target = `${SHOT_DIR}/${name}`;

  try {
    if (!fs.exists(SHOT_DIR)) fs.mkdir(SHOT_DIR, { parents: true });
    fs.writeFile(target, dataUrl);
  } catch (err) {
    console.warn('[session] could not save the screenshot:', err);
    notify.show({
      app: 'Screenshot',
      title: 'Screenshot could not be saved',
      body: String((err && err.message) || err),
      icon: svg(CAMERA, { size: 18, strokeWidth: 1.6 }),
      timeout: 6000,
    });
    return null;
  }

  if (announce) {
    notify.show({
      app: 'Screenshot',
      title: simulated ? 'Simulated screenshot saved' : 'Screenshot captured',
      body: simulated ? `${name} — the image is labelled as simulated.` : name,
      icon: svg(CAMERA, { size: 18, strokeWidth: 1.6 }),
      timeout: 7000,
      actions: [
        { label: 'Open', onClick: () => wm.open('imageviewer', { path: target }) },
        { label: 'Show in Files', onClick: () => wm.open('files', { path: SHOT_DIR }) },
      ],
    });
  }

  return { path: target, name, simulated };
}

/* ------------------------------------------------------------------ *
 * power-off / restart / suspend overlay
 * ------------------------------------------------------------------ */

let overlay = null;

function removeOverlay() {
  if (overlay && overlay.isConnected) overlay.remove();
  overlay = null;
}

/**
 * Full-screen session overlay.
 * @param {'poweroff'|'restart'|'suspend'} mode
 * @returns {HTMLElement} the overlay element
 */
export function showSessionOverlay(mode) {
  removeOverlay();
  dismissPopovers();

  const root = h('div.session-overlay', { dataset: { mode }, tabindex: '-1' });

  if (mode === 'suspend') {
    root.appendChild(h('div.session-overlay__hint', { text: 'Press any key to wake up' }));
    document.body.appendChild(root);
    overlay = root;
    void root.offsetHeight;
    root.classList.add('session-overlay--in');
    root.focus();

    const wake = (ev) => {
      ev.preventDefault();
      document.removeEventListener('keydown', wake, true);
      document.removeEventListener('mousedown', wake, true);
      root.classList.remove('session-overlay--in');
      setTimeout(removeOverlay, 420);
    };
    setTimeout(() => {
      document.addEventListener('keydown', wake, true);
      document.addEventListener('mousedown', wake, true);
    }, 800);
    return root;
  }

  const spinner = h('div.session-overlay__spinner', { 'aria-hidden': 'true' });
  const status = h('div.session-overlay__status', {
    text: mode === 'restart' ? 'Restarting…' : 'Powering off…',
  });
  const stage = h('div.session-overlay__stage', {}, ubuntuLogo(104), spinner, status);
  root.appendChild(stage);
  document.body.appendChild(root);
  overlay = root;
  void root.offsetHeight;
  root.classList.add('session-overlay--in');

  bus.emit(mode === 'restart' ? 'session:restart' : 'session:poweroff', {});
  try {
    fs.persist();
  } catch {
    /* persistence is best-effort while shutting down */
  }

  if (mode === 'restart') {
    setTimeout(() => window.location.reload(), 2600);
    return root;
  }

  setTimeout(() => {
    spinner.remove();
    status.remove();
    stage.appendChild(h('div.session-overlay__prompt', { text: 'Press any key to restart' }));
    const reboot = (ev) => {
      ev.preventDefault();
      document.removeEventListener('keydown', reboot, true);
      document.removeEventListener('mousedown', reboot, true);
      window.location.reload();
    };
    document.addEventListener('keydown', reboot, true);
    document.addEventListener('mousedown', reboot, true);
  }, 3400);

  return root;
}

/* ------------------------------------------------------------------ *
 * end-session dialog
 * ------------------------------------------------------------------ */

/**
 * GNOME's end-session dialog: Cancel / Suspend / Restart / Power Off with a
 * 60-second auto-confirm. Built on `dialog.confirm` from core/dialog.js so it
 * inherits the exact Adwaita chrome, focus trap and Escape handling, then
 * augmented with the two extra choices GNOME offers.
 *
 * @returns {Promise<'cancel'|'suspend'|'restart'|'poweroff'>}
 */
export function openPowerDialog() {
  dismissPopovers();

  let choice = null;
  let seconds = 60;

  const promise = dialog.confirm({
    title: 'Power Off',
    body: 'The system will power off automatically in 60 seconds.',
    okLabel: 'Power Off',
    destructive: true,
  });

  // core/dialog.js appends its backdrop synchronously inside the executor.
  const backdrops = document.querySelectorAll('.dialog-backdrop');
  const backdrop = backdrops[backdrops.length - 1];
  if (!backdrop) return promise.then((ok) => (ok ? 'poweroff' : 'cancel'));

  const card = backdrop.querySelector('.dialog');
  const body = backdrop.querySelector('.dialog__body');
  const actions = backdrop.querySelector('.dialog__actions');
  const buttons = actions ? Array.from(actions.children) : [];
  const cancelButton = buttons[0] || null;
  const okButton = buttons[buttons.length - 1] || null;

  if (card) card.classList.add('dialog--power');

  const pick = (value) => {
    choice = value;
    if (cancelButton) cancelButton.click();
  };

  if (actions && okButton) {
    for (const spec of [
      { label: 'Suspend', value: 'suspend' },
      { label: 'Restart', value: 'restart' },
    ]) {
      const button = h('button.dialog__button', { type: 'button', text: spec.label });
      button.addEventListener('click', () => pick(spec.value));
      actions.insertBefore(button, okButton);
    }
  }

  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      if (okButton) okButton.click();
      return;
    }
    if (body) {
      body.textContent =
        `The system will power off automatically in ${seconds} second${seconds === 1 ? '' : 's'}.`;
    }
  }, 1000);

  return promise.then((accepted) => {
    clearInterval(timer);
    const result = accepted ? 'poweroff' : choice || 'cancel';
    if (result !== 'cancel') showSessionOverlay(result);
    return result;
  });
}

/* ------------------------------------------------------------------ *
 * lock screen
 * ------------------------------------------------------------------ */

let lockNode = null;

/** @returns {boolean} true while the lock screen is up */
export function isLocked() {
  return lockNode !== null && lockNode.isConnected;
}

/**
 * Show the GNOME lock screen: blurred wallpaper, big clock, and a shield that
 * lifts to reveal the password entry. The accepted password is `ubuntu`.
 * @returns {HTMLElement|null}
 */
export function lockScreen() {
  if (isLocked()) return lockNode;
  dismissPopovers();

  const clock = h('div.lock-screen__clock');
  const date = h('div.lock-screen__date');
  const shield = h(
    'div.lock-screen__shield',
    {},
    clock,
    date,
    h('div.lock-screen__hint', { text: 'Press Enter or click to unlock' }),
  );

  const entry = h('input.lock-screen__entry', {
    type: 'password',
    placeholder: 'Password',
    autocomplete: 'current-password',
    spellcheck: 'false',
    'aria-label': 'Password',
  });
  const error = h('div.lock-screen__error', { role: 'alert' });
  const auth = h(
    'div.lock-screen__auth',
    {},
    h('div.lock-screen__avatar', { 'aria-hidden': 'true' }, svg(PERSON, { size: 44, strokeWidth: 1.4 })),
    h('div.lock-screen__user', { text: users.current.gecos || users.current.name }),
    h('div.lock-screen__field', {}, entry),
    error,
  );

  const root = h(
    'div.lock-screen',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lock Screen', tabindex: '-1' },
    h('div.lock-screen__wallpaper', { 'aria-hidden': 'true' }),
    shield,
    auth,
  );

  const paint = () => {
    const now = new Date();
    clock.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    date.textContent = now.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  };
  paint();
  const ticker = setInterval(paint, 1000);

  const lift = () => {
    if (root.classList.contains('lock-screen--lifted')) return;
    root.classList.add('lock-screen--lifted');
    setTimeout(() => entry.focus(), 240);
  };
  const drop = () => {
    root.classList.remove('lock-screen--lifted');
    entry.value = '';
    error.textContent = '';
    root.focus();
  };

  shield.addEventListener('mousedown', lift);
  root.addEventListener('wheel', lift, { passive: true });
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (root.classList.contains('lock-screen--lifted')) drop();
      return;
    }
    if (!root.classList.contains('lock-screen--lifted')) {
      ev.preventDefault();
      lift();
    }
  });

  entry.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    if (entry.value === 'ubuntu') {
      clearInterval(ticker);
      root.classList.add('lock-screen--out');
      setTimeout(() => {
        root.remove();
        lockNode = null;
      }, 420);
      return;
    }
    error.textContent = 'Sorry, that didn’t work. Please try again.';
    entry.value = '';
    auth.classList.remove('lock-screen__auth--shake');
    void auth.offsetWidth;
    auth.classList.add('lock-screen__auth--shake');
  });

  document.body.appendChild(root);
  lockNode = root;
  void root.offsetHeight;
  root.classList.add('lock-screen--in');
  root.focus();
  bus.emit('session:lock', {});
  return root;
}
