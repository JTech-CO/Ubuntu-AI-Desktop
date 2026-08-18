/**
 * js/core/notify.js — GNOME 46 notification banners (ARCHITECTURE §11).
 *
 * Banners slide down from under the top bar, centred, and stack. Titles and
 * bodies are always inserted with `textContent`; an `icon` may be a string
 * (emoji or short glyph), an Element, or a factory returning an Element.
 *
 * Timed-out banners disappear from the screen but stay in `list()` so the
 * calendar popover can show them, exactly like the real message tray.
 * Dismissing a banner explicitly removes it from the list too.
 */

import { h, clear } from './dom.js';
import { bus } from './bus.js';

const MAX_VISIBLE = 4;

/** @type {{id:number, app:string, title:string, body:string, icon:any, timestamp:number, actions:object[], read:boolean}[]} */
const entries = [];

/** @type {Map<number, {node: HTMLElement, timer: number, timeout: number, startedAt: number, remaining: number}>} */
const banners = new Map();

let nextId = 1;
let layer = null;

function ensureLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.querySelector('.notify-layer');
  if (!layer) {
    layer = h('div.notify-layer', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Notifications' });
    document.body.appendChild(layer);
  }
  return layer;
}

/** `09:41` — GNOME shows a short local time on each banner. */
function shortTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildIcon(icon) {
  const box = h('div.notification__icon', { 'aria-hidden': 'true' });
  if (!icon) {
    box.textContent = '●'; // filled circle placeholder, like a missing app icon
    box.classList.add('notification__icon--empty');
    return box;
  }
  if (icon instanceof Node) {
    box.appendChild(icon);
    return box;
  }
  if (typeof icon === 'function') {
    try {
      const produced = icon();
      if (produced instanceof Node) {
        box.appendChild(produced);
        return box;
      }
    } catch (err) {
      console.warn('[notify] icon factory threw:', err);
    }
    box.textContent = '●';
    return box;
  }
  box.textContent = String(icon);
  return box;
}

function removeBanner(id, immediate = false) {
  const banner = banners.get(id);
  if (!banner) return;
  banners.delete(id);
  if (banner.timer) clearTimeout(banner.timer);
  const { node } = banner;
  if (immediate) {
    node.remove();
    return;
  }
  node.classList.remove('notification--in');
  node.classList.add('notification--out');
  setTimeout(() => node.remove(), 220);
}

function startTimer(id, ms) {
  const banner = banners.get(id);
  if (!banner || !ms) return;
  banner.startedAt = Date.now();
  banner.remaining = ms;
  banner.timer = setTimeout(() => {
    banner.timer = 0;
    removeBanner(id);
  }, ms);
}

function pauseTimer(id) {
  const banner = banners.get(id);
  if (!banner || !banner.timer) return;
  clearTimeout(banner.timer);
  banner.timer = 0;
  banner.remaining = Math.max(600, banner.remaining - (Date.now() - banner.startedAt));
}

function resumeTimer(id) {
  const banner = banners.get(id);
  if (!banner || banner.timer || !banner.timeout) return;
  startTimer(id, banner.remaining);
}

function trimStack() {
  while (banners.size > MAX_VISIBLE) {
    const oldest = banners.keys().next();
    if (oldest.done) break;
    removeBanner(oldest.value, true);
  }
}

export const notify = {
  /**
   * Post a notification banner.
   * @param {{app?:string, title:string, body?:string, icon?:any, timeout?:number,
   *          actions?:{label:string, onClick?:Function}[], onClick?:Function}} spec
   * @returns {number} notification id
   */
  show({ app = 'System', title, body = '', icon = '', timeout = 4000, actions = [], onClick } = {}) {
    const id = nextId;
    nextId += 1;

    const entry = {
      id,
      app: String(app),
      title: title === undefined || title === null ? '' : String(title),
      body: body === undefined || body === null ? '' : String(body),
      icon,
      timestamp: Date.now(),
      actions: Array.isArray(actions) ? actions : [],
      read: false,
    };
    entries.unshift(entry);

    const main = h(
      'div.notification__main',
      {},
      buildIcon(icon),
      h(
        'div.notification__text',
        {},
        h(
          'div.notification__meta',
          {},
          h('span.notification__app', { text: entry.app }),
          h('span.notification__time', { text: shortTime(entry.timestamp) }),
        ),
        h('div.notification__title', { text: entry.title }),
        entry.body ? h('div.notification__body', { text: entry.body }) : null,
      ),
    );

    const closeBtn = h('button.notification__close', {
      type: 'button',
      'aria-label': 'Close notification',
      title: 'Close',
      text: '×',
    });

    const node = h('div.notification', { role: 'status', dataset: { id: String(id) } }, main, closeBtn);

    if (entry.actions.length > 0) {
      const row = h('div.notification__actions');
      for (const action of entry.actions) {
        if (!action || !action.label) continue;
        const button = h('button.notification__action', { type: 'button', text: String(action.label) });
        button.addEventListener('click', (ev) => {
          ev.stopPropagation();
          notify.dismiss(id);
          if (typeof action.onClick === 'function') {
            try {
              action.onClick();
            } catch (err) {
              console.error('[notify] action handler threw:', err);
            }
          }
        });
        row.appendChild(button);
      }
      if (row.childNodes.length > 0) node.appendChild(row);
    }

    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      notify.dismiss(id);
    });

    if (typeof onClick === 'function') {
      node.classList.add('notification--clickable');
      main.addEventListener('click', () => {
        notify.dismiss(id);
        try {
          onClick();
        } catch (err) {
          console.error('[notify] click handler threw:', err);
        }
      });
    }

    node.addEventListener('mouseenter', () => pauseTimer(id));
    node.addEventListener('mouseleave', () => resumeTimer(id));

    const host = ensureLayer();
    host.appendChild(node);
    banners.set(id, { node, timer: 0, timeout: Number(timeout) || 0, startedAt: Date.now(), remaining: Number(timeout) || 0 });
    trimStack();

    // Force a reflow so the entry transition always runs.
    void node.offsetHeight;
    node.classList.add('notification--in');

    if (timeout && timeout > 0) startTimer(id, timeout);

    bus.emit('notify:add', { id, app: entry.app, title: entry.title });
    return id;
  },

  /**
   * Remove a banner and drop it from the tray list.
   * @param {number} id
   * @returns {boolean} true when something was removed
   */
  dismiss(id) {
    const key = Number(id);
    removeBanner(key);
    const idx = entries.findIndex((e) => e.id === key);
    if (idx < 0) return false;
    entries.splice(idx, 1);
    bus.emit('notify:remove', { id: key });
    return true;
  },

  /**
   * Hide the on-screen banner but keep the entry in the tray.
   * @param {number} id
   */
  hide(id) {
    removeBanner(Number(id));
  },

  /**
   * @returns {object[]} tray entries, newest first (copies)
   */
  list() {
    return entries.map((e) => ({
      id: e.id,
      app: e.app,
      title: e.title,
      body: e.body,
      timestamp: e.timestamp,
      read: e.read,
      actions: e.actions,
    }));
  },

  /** @returns {number} number of unread entries */
  unreadCount() {
    return entries.reduce((n, e) => (e.read ? n : n + 1), 0);
  },

  /** Mark every tray entry as read (the popover was opened). */
  markAllRead() {
    for (const e of entries) e.read = true;
  },

  /** Remove every banner and empty the tray. */
  clearAll() {
    for (const id of Array.from(banners.keys())) removeBanner(id, true);
    entries.length = 0;
    if (layer) clear(layer);
    bus.emit('notify:clear', {});
  },
};
