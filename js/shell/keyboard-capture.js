/**
 * keyboard-capture.js — keep the keyboard inside the emulator.
 *
 * THE PROBLEM
 * -----------
 * Ctrl+T, Ctrl+W, Ctrl+N, Ctrl+Shift+T and friends are *browser* shortcuts.
 * A page cannot cancel them: calling `preventDefault()` in a keydown handler
 * has no effect, because the browser consumes them before the page ever sees
 * them. So pressing Ctrl+W in Code-OSS closed the real Chrome tab that was
 * hosting the desktop, and Ctrl+T opened a real new tab, instead of the app's
 * own tab actually opening or closing.
 *
 * THE ONLY FIX THE WEB OFFERS
 * ---------------------------
 * The Keyboard Lock API — `navigator.keyboard.lock()` — and it comes with hard
 * conditions that shape everything below:
 *
 *   1. It only takes effect while the document is in FULLSCREEN. Leaving
 *      fullscreen releases the lock automatically.
 *   2. Entering fullscreen requires a user gesture, so capture can never be
 *      switched on automatically at boot — a person has to click something.
 *   3. It is Chromium-only (Chrome, Edge, Opera). Firefox and Safari have not
 *      shipped it, and there is no polyfill, because the whole point is an
 *      escape from the page's sandbox.
 *   4. Once Escape is locked, the browser enforces its own escape hatch:
 *      HOLDING Escape for about two seconds always exits fullscreen and
 *      releases the keyboard. This cannot be disabled from script and must not
 *      be fought — it is the user's guaranteed way out, and Chrome shows its
 *      own "Press and hold Esc to exit full screen" bubble to advertise it.
 *
 * WHAT THIS MODULE ADDS ON TOP
 * ----------------------------
 *   - A short Escape press, when no menu or dialog is open, asks "leave the
 *     emulator?" instead of quitting instantly. Guards are registered by
 *     main.js via `addExitGuard`, which keeps this module free of any import
 *     on the shell UI (and therefore free of import cycles).
 *   - Powering the machine off releases the keyboard immediately, with no
 *     confirmation, because the user already confirmed by shutting down.
 *   - State is mirrored from the real `fullscreenchange` event, so a
 *     long-Escape or an F11 keeps the indicator honest.
 */

import { bus } from '../core/bus.js';
import { dialog } from '../core/dialog.js';
import { store } from '../core/store.js';
import { h, on } from '../core/dom.js';

/** @type {Set<() => boolean>} predicates that suppress the Escape prompt */
const exitGuards = new Set();

/**
 * Neither `requestFullscreen()` nor `keyboard.lock()` is guaranteed to settle.
 * A surface that cannot go fullscreen leaves `lock()` pending forever, and
 * because a pending lock makes every later call reject with InvalidStateError,
 * an unbounded await would wedge capture for the rest of the session.
 */
const FULLSCREEN_TIMEOUT_MS = 4000;
const LOCK_TIMEOUT_MS = 3000;

/**
 * Reject if `promise` has not settled in time. The underlying request is not
 * cancellable — this only stops us waiting on it.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label used in the error message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: ${ms}ms 안에 응답하지 않았습니다.`)),
      ms,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let active = false;
let locking = false;
let osd = null;
let osdTimer = 0;

/* ------------------------------------------------------------------ *
 * capability
 * ------------------------------------------------------------------ */

/**
 * @returns {boolean} true when this browser can actually trap Ctrl+T and
 *   friends. Chromium-only; everything else gets the honest explanation.
 */
export function isSupported() {
  return Boolean(
    typeof navigator !== 'undefined' &&
      navigator.keyboard &&
      typeof navigator.keyboard.lock === 'function' &&
      document.fullscreenEnabled &&
      window.isSecureContext,
  );
}

/**
 * Why capture is unavailable, for the UI to show verbatim.
 * @returns {string} '' when it IS available
 */
export function unsupportedReason() {
  if (isSupported()) return '';
  if (!window.isSecureContext) {
    return '보안 컨텍스트가 아닙니다. https:// 또는 localhost 에서 열어야 키보드 잠금을 쓸 수 있습니다.';
  }
  if (!document.fullscreenEnabled) {
    return '이 문서에서 전체화면이 허용되지 않았습니다. iframe 안에서 열었다면 allowfullscreen 속성이 필요합니다.';
  }
  return (
    'Keyboard Lock API를 지원하지 않는 브라우저입니다. ' +
    'Chrome, Edge, Opera 같은 Chromium 계열에서만 동작하며 Firefox와 Safari에는 아직 없습니다. ' +
    '이 브라우저에서는 Ctrl+T, Ctrl+W 같은 단축키를 브라우저가 먼저 가져가므로 에뮬레이터가 막을 수 없습니다.'
  );
}

/** @returns {boolean} */
export function isActive() {
  return active;
}

/* ------------------------------------------------------------------ *
 * on-screen hint
 * ------------------------------------------------------------------ */

/**
 * Briefly show the "you are captured, here is the way out" banner.
 * @param {string} title
 * @param {string} body
 * @param {number} ms
 */
function showOsd(title, body, ms = 4200) {
  hideOsd();
  osd = h(
    'div.kbd-osd',
    { role: 'status', 'aria-live': 'polite' },
    h('div.kbd-osd__title', { text: title }),
    h('div.kbd-osd__body', { text: body }),
  );
  document.body.appendChild(osd);
  // Next frame, so the entry transition actually runs.
  requestAnimationFrame(() => osd && osd.classList.add('is-shown'));
  osdTimer = window.setTimeout(hideOsd, ms);
}

function hideOsd() {
  if (osdTimer) {
    clearTimeout(osdTimer);
    osdTimer = 0;
  }
  if (!osd) return;
  const node = osd;
  osd = null;
  node.classList.remove('is-shown');
  window.setTimeout(() => node.remove(), 250);
}

/* ------------------------------------------------------------------ *
 * enable / disable
 * ------------------------------------------------------------------ */

/**
 * Enter fullscreen and trap the keyboard.
 *
 * MUST be called from a user gesture (a click or a keydown handler), because
 * `requestFullscreen` requires one. Calling it from a timer silently fails.
 *
 * @param {{silent?: boolean}} [opts]
 * @returns {Promise<boolean>} true when capture is now active
 */
export async function enable({ silent = false } = {}) {
  if (active || locking) return active;
  if (!isSupported()) {
    if (!silent) {
      await dialog.alert({
        title: '키보드 캡처를 쓸 수 없습니다',
        body: unsupportedReason(),
      });
    }
    return false;
  }

  locking = true;
  try {
    if (!document.fullscreenElement) {
      await withTimeout(
        document.documentElement.requestFullscreen({ navigationUI: 'hide' }),
        FULLSCREEN_TIMEOUT_MS,
        'requestFullscreen',
      );
    }

    // `requestFullscreen()` resolving is NOT proof that we are fullscreen.
    // Embedded surfaces (an iframe without `allowfullscreen`, some automation
    // and preview panes) resolve it and stay windowed. Keyboard lock only
    // captures reserved keys while genuinely fullscreen, so claiming success
    // here would promise the user that Ctrl+W is trapped when it is not.
    if (!document.fullscreenElement) {
      throw new Error(
        '전체화면으로 전환되지 않았습니다. 이 창은 전체화면을 지원하지 않는 것 같습니다 ' +
          '(iframe에 allowfullscreen이 없거나, 내장된 미리보기 창일 수 있습니다). ' +
          '키보드 잠금은 전체화면에서만 동작하므로 사용할 수 없습니다.',
      );
    }

    // No argument locks every key the platform allows, Escape included.
    // A pending lock() rejects any further call with InvalidStateError, so a
    // hung promise here must never be awaited without a bound.
    await withTimeout(navigator.keyboard.lock(), LOCK_TIMEOUT_MS, 'keyboard.lock');

    active = true;
    store.set('keyboardCapture', true);
    bus.emit('capture:on', {});
    if (!silent) {
      showOsd(
        '키보드가 에뮬레이터 안에 갇혔습니다',
        'Ctrl+T · Ctrl+W · Ctrl+N 이 이제 우분투 안에서 동작합니다. ' +
          '나가려면 Esc 를 한 번 누르거나, Esc 를 2초간 길게 누르세요.',
        5200,
      );
    }
    return true;
  } catch (err) {
    // Most often: the fullscreen request was not tied to a real user gesture,
    // the surface cannot go fullscreen at all, or the user backed out.
    console.warn('[keyboard-capture] could not lock the keyboard:', err);
    active = false;

    // A lock() that half-registered would reject every later attempt with
    // InvalidStateError, so clear it before giving up.
    try {
      if (navigator.keyboard && typeof navigator.keyboard.unlock === 'function') {
        navigator.keyboard.unlock();
      }
    } catch {
      /* nothing to release */
    }

    // Fullscreen-but-unlocked is the worst outcome: the desktop fills the
    // screen while Ctrl+W still closes the host tab.
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* already gone */
      }
    }

    if (!silent) {
      await dialog.alert({
        title: '키보드를 가두지 못했습니다',
        body:
          `${String((err && err.message) || err)}\n\n` +
          'Ctrl+T, Ctrl+W 같은 키는 브라우저가 먼저 가져가므로, 전체화면 + 키보드 잠금 없이는 ' +
          '에뮬레이터가 막을 수 없습니다. 이 창에서는 계속 브라우저가 처리합니다.',
      });
    }
    return false;
  } finally {
    locking = false;
  }
}

/**
 * Release the keyboard and leave fullscreen.
 *
 * @param {{keepFullscreen?: boolean, silent?: boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function disable({ keepFullscreen = false, silent = false } = {}) {
  const wasActive = active;
  active = false;
  store.set('keyboardCapture', false);

  try {
    if (navigator.keyboard && typeof navigator.keyboard.unlock === 'function') {
      navigator.keyboard.unlock();
    }
  } catch (err) {
    console.warn('[keyboard-capture] unlock failed:', err);
  }

  if (!keepFullscreen && document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch (err) {
      console.warn('[keyboard-capture] exitFullscreen failed:', err);
    }
  }

  if (wasActive) {
    bus.emit('capture:off', {});
    if (!silent) {
      showOsd(
        '키보드가 브라우저로 돌아갔습니다',
        'Ctrl+T, Ctrl+W 같은 단축키는 이제 다시 브라우저가 처리합니다.',
        3200,
      );
    }
  }
}

/**
 * @returns {Promise<boolean>} the state after toggling
 */
export async function toggle() {
  if (active) {
    await disable();
    return false;
  }
  return enable();
}

/* ------------------------------------------------------------------ *
 * exit guards + Escape
 * ------------------------------------------------------------------ */

/**
 * Register a predicate that returns true while some overlay owns Escape
 * (a menu, the overview, a modal, the run dialog…). While any guard returns
 * true, Escape does its normal in-desktop job instead of offering to leave.
 *
 * @param {() => boolean} fn
 * @returns {() => void} unregister
 */
export function addExitGuard(fn) {
  if (typeof fn === 'function') exitGuards.add(fn);
  return () => exitGuards.delete(fn);
}

/** @returns {boolean} true when something inside the desktop wants Escape */
function guarded() {
  for (const guard of exitGuards) {
    try {
      if (guard()) return true;
    } catch (err) {
      console.warn('[keyboard-capture] exit guard threw:', err);
    }
  }
  return false;
}

let asking = false;

/**
 * Ask whether to hand the keyboard back. Used by the short-Escape path and by
 * the top bar's indicator.
 *
 * @returns {Promise<boolean>} true when capture was released
 */
export async function requestExit() {
  if (!active || asking) return false;
  asking = true;
  try {
    const leave = await dialog.confirm({
      title: '에뮬레이터에서 나갈까요?',
      body:
        '지금은 키보드가 우분투 안에 갇혀 있어 Ctrl+T, Ctrl+W 같은 키가 에뮬레이터 안에서 동작합니다.\n\n' +
        '나가면 전체화면이 해제되고 그 키들은 다시 브라우저가 가져갑니다. ' +
        '데스크톱과 파일은 그대로 유지됩니다.\n\n' +
        '참고: Esc 를 2초간 길게 누르면 브라우저가 강제로 빠져나갑니다.',
      okLabel: '나가기',
    });
    if (leave) await disable();
    return leave;
  } finally {
    asking = false;
  }
}

/**
 * Escape, in the bubble phase so every in-desktop handler has already had its
 * turn. `defaultPrevented` covers handlers that consumed it without exposing a
 * predicate; `guarded()` covers the ones that do.
 *
 * @param {KeyboardEvent} ev
 */
function onEscape(ev) {
  if (!active) return;
  if (ev.key !== 'Escape' || ev.repeat) return;
  if (ev.ctrlKey || ev.altKey || ev.shiftKey || ev.metaKey) return;
  if (ev.defaultPrevented) return;
  if (guarded()) return;
  ev.preventDefault();
  void requestExit();
}

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

let installed = false;

/**
 * Wire the listeners. Idempotent.
 * @returns {void}
 */
export function install() {
  if (installed) return;
  installed = true;

  // Bubble phase: last in line, after the apps and the shell.
  on(window, 'keydown', onEscape, false);

  // The browser can drop us out of fullscreen without asking — the long-Escape
  // hatch, F11, or the window manager. The lock dies with it, so mirror that.
  on(document, 'fullscreenchange', () => {
    if (!document.fullscreenElement && active) {
      active = false;
      store.set('keyboardCapture', false);
      bus.emit('capture:off', {});
      showOsd(
        '키보드가 브라우저로 돌아갔습니다',
        '전체화면이 해제되어 키보드 잠금도 함께 풀렸습니다.',
        3200,
      );
    }
  });

  // Powering the machine off is itself the confirmation — release at once.
  bus.on('session:poweroff', () => void disable({ silent: true }));
  bus.on('session:restart', () => void disable({ silent: true }));
}

/** Grouped handle, matching the other shell modules. */
export const keyboardCapture = {
  install,
  isSupported,
  unsupportedReason,
  isActive,
  enable,
  disable,
  toggle,
  requestExit,
  addExitGuard,
  /** @returns {boolean} whether the user had it on last session */
  wasEnabled: () => store.get('keyboardCapture', false) === true,
};

export default keyboardCapture;
