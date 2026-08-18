/**
 * js/shell/top-bar.js — the GNOME 46 top bar (ARCHITECTURE §15).
 *
 * Layout, exactly as GNOME ships it:
 *   left    Activities
 *   centre  clock + date, opening the calendar / notification popover
 *   right   status icons (network, volume, battery), opening quick settings
 *
 * Only one popover may be open at a time; the modules coordinate through the
 * `shell:popover` bus event. Escape and an outside click close whatever is up.
 */

import { h, svg, clear } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { notify } from '../core/notify.js';
import { overview } from './overview.js';
import { systemMenu, shellIcons, shellSettings, openPowerDialog } from './system-menu.js';
import { keyboardCapture } from './keyboard-capture.js';
import { dialog } from '../core/dialog.js';

const WEEKDAYS = [
  { short: 'S', long: 'Sunday' },
  { short: 'M', long: 'Monday' },
  { short: 'T', long: 'Tuesday' },
  { short: 'W', long: 'Wednesday' },
  { short: 'T', long: 'Thursday' },
  { short: 'F', long: 'Friday' },
  { short: 'S', long: 'Saturday' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const NAV = {
  prev: 'M14.5 5.5 8 12l6.5 6.5',
  next: 'M9.5 5.5 16 12l-6.5 6.5',
  close: ['M7.5 7.5 16.5 16.5', 'M16.5 7.5 7.5 16.5'],
  bell: [
    'M18 9.5a6 6 0 1 0-12 0c0 5.2-2 6.5-2 6.5h16s-2-1.3-2-6.5z',
    'M13.7 19.5a2 2 0 0 1-3.4 0',
  ],
};

let bar = null;
let clockButton = null;
let dateLabel = null;
let timeLabel = null;
let unreadDot = null;
let statusButton = null;
let powerButton = null;
let captureButton = null;
let captureLabel = null;
let statusIcons = null;
let calendar = null;
let monthLabel = null;
let daysGrid = null;
let noticeList = null;
let noticeHeaderCount = null;
let dndSwitch = null;
let clearButton = null;

let calendarOpen = false;
let installed = false;
let tickTimer = 0;
let lastStamp = '';
let viewYear = 0;
let viewMonth = 0;
let selectedKey = '';
let unbindCalendar = null;

/* ------------------------------------------------------------------ *
 * clock
 * ------------------------------------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * `Mon 18 Aug` + `14:32`, GNOME's centred clock.
 * @param {Date} now
 * @returns {{date: string, time: string}}
 */
function formatClock(now) {
  return {
    date: `${SHORT_DAYS[now.getDay()]} ${now.getDate()} ${SHORT_MONTHS[now.getMonth()]}`,
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
  };
}

function tick() {
  const now = new Date();
  const { date, time } = formatClock(now);
  const stamp = `${date} ${time}`;
  if (stamp === lastStamp) return;
  lastStamp = stamp;
  dateLabel.textContent = date;
  timeLabel.textContent = time;
  clockButton.title = now.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  // The tray dot is otherwise kept current by the notify:* bus events.
  refreshUnread();
}

function refreshUnread() {
  if (!unreadDot) return;
  const count = notify.list().length;
  unreadDot.hidden = count === 0;
  clockButton.classList.toggle('top-bar__clock--notifying', count > 0);
  if (noticeHeaderCount) noticeHeaderCount.textContent = count > 0 ? String(count) : '';
  if (clearButton) clearButton.disabled = count === 0;
}

/* ------------------------------------------------------------------ *
 * status area
 * ------------------------------------------------------------------ */

function renderStatus() {
  if (!statusIcons) return;
  clear(statusIcons);
  const s = shellSettings.all();

  const wifiSlot = h('span.top-bar__status-icon', {
    title: s.wifi ? `Wired / Wi-Fi — ${s.wifiNetwork}` : 'Wi-Fi Off',
  }, shellIcons.wifi(s.wifi ? 4 : 0));

  const volumeSlot = h('span.top-bar__status-icon', {
    title: s.muted ? 'Muted' : `Volume ${Math.round(s.volume)}%`,
  }, shellIcons.volume(s.volume, s.muted === true));

  const batterySlot = h('span.top-bar__status-icon', {
    title: `${Math.round(s.battery)}%${s.charging ? ' — Charging' : ''}`,
  }, shellIcons.battery(s.battery, s.charging === true));

  statusIcons.appendChild(wifiSlot);
  statusIcons.appendChild(volumeSlot);
  statusIcons.appendChild(batterySlot);
  if (s.dnd) {
    statusIcons.appendChild(h('span.top-bar__status-icon.top-bar__status-icon--dnd', {
      title: 'Do Not Disturb',
    }, svg(NAV.bell.concat(['M4 4l16 16']), { size: 16, strokeWidth: 1.6 })));
  }
  statusIcons.appendChild(h('span.top-bar__chevron', { 'aria-hidden': 'true' }, shellIcons.chevron()));
}

/* ------------------------------------------------------------------ *
 * calendar popover
 * ------------------------------------------------------------------ */

function dayKey(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function renderMonth() {
  monthLabel.textContent = `${MONTHS[viewMonth]} ${viewYear}`;
  clear(daysGrid);

  for (const weekday of WEEKDAYS) {
    daysGrid.appendChild(h('div.calendar__weekday', {
      title: weekday.long, 'aria-label': weekday.long, text: weekday.short,
    }));
  }

  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysThisMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const today = new Date();
  const todayKey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());

  const cells = [];
  for (let i = firstWeekday - 1; i >= 0; i -= 1) {
    const day = daysPrevMonth - i;
    const date = new Date(viewYear, viewMonth - 1, day);
    cells.push({ day, date, outside: true });
  }
  for (let day = 1; day <= daysThisMonth; day += 1) {
    cells.push({ day, date: new Date(viewYear, viewMonth, day), outside: false });
  }
  let trailing = 1;
  while (cells.length % 7 !== 0 || cells.length < 42) {
    cells.push({ day: trailing, date: new Date(viewYear, viewMonth + 1, trailing), outside: true });
    trailing += 1;
    if (cells.length >= 42) break;
  }

  for (const cell of cells) {
    const key = dayKey(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate());
    const isToday = key === todayKey;
    const button = h('button.calendar__day', {
      type: 'button',
      text: String(cell.day),
      'aria-label': cell.date.toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      }),
      'aria-current': isToday ? 'date' : null,
      dataset: { key },
      class: [
        cell.outside ? 'calendar__day--outside' : null,
        isToday ? 'calendar__day--today' : null,
        key === selectedKey ? 'calendar__day--selected' : null,
      ],
    });
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectedKey = key;
      if (cell.outside) {
        viewYear = cell.date.getFullYear();
        viewMonth = cell.date.getMonth();
      }
      renderMonth();
    });
    daysGrid.appendChild(button);
  }
}

function shiftMonth(delta) {
  const next = new Date(viewYear, viewMonth + delta, 1);
  viewYear = next.getFullYear();
  viewMonth = next.getMonth();
  renderMonth();
}

function noticeTime(timestamp) {
  const then = new Date(timestamp);
  const now = new Date();
  const sameDay = then.toDateString() === now.toDateString();
  if (sameDay) return `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  return `${SHORT_DAYS[then.getDay()]} ${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
}

function renderNotifications() {
  clear(noticeList);
  const list = notify.list();

  if (list.length === 0) {
    noticeList.appendChild(h('div.notice-empty', {},
      h('span.notice-empty__icon', { 'aria-hidden': 'true' }, svg(NAV.bell, { size: 30, strokeWidth: 1.3 })),
      h('span.notice-empty__text', { text: 'No Notifications' })));
    refreshUnread();
    return;
  }

  for (const entry of list) {
    const dismiss = h('button.notice__close', {
      type: 'button',
      'aria-label': `Dismiss ${entry.title}`,
      title: 'Clear',
    }, svg(NAV.close, { size: 13, strokeWidth: 2 }));
    dismiss.addEventListener('click', (ev) => {
      ev.stopPropagation();
      notify.dismiss(entry.id);
      renderNotifications();
    });

    const card = h('div.notice', { dataset: { id: String(entry.id) } },
      h('div.notice__head', {},
        h('span.notice__app', { text: entry.app }),
        h('span.notice__time', { text: noticeTime(entry.timestamp) })),
      h('div.notice__title', { text: entry.title }),
      entry.body ? h('div.notice__body', { text: entry.body }) : null,
      dismiss);

    if (Array.isArray(entry.actions) && entry.actions.length > 0) {
      const row = h('div.notice__actions');
      for (const action of entry.actions) {
        if (!action || !action.label) continue;
        const button = h('button.notice__action', { type: 'button', text: String(action.label) });
        button.addEventListener('click', (ev) => {
          ev.stopPropagation();
          notify.dismiss(entry.id);
          renderNotifications();
          if (typeof action.onClick === 'function') {
            try {
              action.onClick();
            } catch (err) {
              console.error('[top-bar] notification action threw:', err);
            }
          }
        });
        row.appendChild(button);
      }
      if (row.childNodes.length > 0) card.appendChild(row);
    }

    noticeList.appendChild(card);
  }
  refreshUnread();
}

function syncDnd() {
  const on = shellSettings.get('dnd') === true;
  dndSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
  dndSwitch.classList.toggle('gnome-switch--on', on);
}

/* ------------------------------------------------------------------ *
 * popover open/close
 * ------------------------------------------------------------------ */

function onDocumentDown(ev) {
  if (!calendarOpen) return;
  if (calendar.contains(ev.target) || clockButton.contains(ev.target)) return;
  closeCalendar();
}

function onDocumentKey(ev) {
  if (!calendarOpen || ev.key !== 'Escape') return;
  ev.preventDefault();
  ev.stopPropagation();
  closeCalendar();
}

/** Open the calendar / notification popover. */
export function openCalendar() {
  if (calendarOpen) return;
  if (!bar) install();
  calendarOpen = true;

  const today = new Date();
  viewYear = today.getFullYear();
  viewMonth = today.getMonth();
  selectedKey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());

  renderMonth();
  renderNotifications();
  syncDnd();

  calendar.hidden = false;
  void calendar.offsetHeight;
  calendar.classList.add('popover--open');
  calendar.setAttribute('aria-hidden', 'false');
  clockButton.setAttribute('aria-expanded', 'true');
  clockButton.classList.add('top-bar__button--active');

  document.addEventListener('mousedown', onDocumentDown, true);
  document.addEventListener('keydown', onDocumentKey, true);
  unbindCalendar = () => {
    document.removeEventListener('mousedown', onDocumentDown, true);
    document.removeEventListener('keydown', onDocumentKey, true);
  };

  notify.markAllRead();
  bus.emit('shell:popover', { id: 'calendar' });
}

/** Close the calendar / notification popover. */
export function closeCalendar() {
  if (!calendarOpen) return;
  calendarOpen = false;
  calendar.classList.remove('popover--open');
  calendar.setAttribute('aria-hidden', 'true');
  clockButton.setAttribute('aria-expanded', 'false');
  clockButton.classList.remove('top-bar__button--active');
  setTimeout(() => {
    if (!calendarOpen) calendar.hidden = true;
  }, 180);
  if (unbindCalendar) {
    unbindCalendar();
    unbindCalendar = null;
  }
  refreshUnread();
}

/** Toggle the calendar / notification popover. */
export function toggleCalendar() {
  if (calendarOpen) closeCalendar();
  else openCalendar();
}

/** @returns {boolean} */
export function isCalendarOpen() {
  return calendarOpen;
}

/** Close every shell popover (calendar and quick settings). */
export function closePopovers() {
  closeCalendar();
  systemMenu.close();
}

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

function buildCalendar() {
  monthLabel = h('div.calendar__month', { 'aria-live': 'polite' });
  const prev = h('button.calendar__nav', { type: 'button', 'aria-label': 'Previous month', title: 'Previous month' },
    svg(NAV.prev, { size: 16, strokeWidth: 1.9 }));
  const next = h('button.calendar__nav', { type: 'button', 'aria-label': 'Next month', title: 'Next month' },
    svg(NAV.next, { size: 16, strokeWidth: 1.9 }));
  prev.addEventListener('click', (ev) => {
    ev.stopPropagation();
    shiftMonth(-1);
  });
  next.addEventListener('click', (ev) => {
    ev.stopPropagation();
    shiftMonth(1);
  });

  daysGrid = h('div.calendar__grid', { role: 'grid' });

  const calendarColumn = h('div.calendar-popover__calendar', {},
    h('div.calendar__head', {}, prev, monthLabel, next),
    daysGrid);

  noticeHeaderCount = h('span.notices__count');
  clearButton = h('button.notices__clear', { type: 'button', text: 'Clear' });
  clearButton.addEventListener('click', (ev) => {
    ev.stopPropagation();
    notify.clearAll();
    renderNotifications();
  });

  noticeList = h('div.notices__list', { role: 'log', 'aria-label': 'Notifications' });

  dndSwitch = h('button.gnome-switch', {
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    'aria-label': 'Do Not Disturb',
  }, h('span.gnome-switch__knob', { 'aria-hidden': 'true' }));
  dndSwitch.addEventListener('click', (ev) => {
    ev.stopPropagation();
    shellSettings.set('dnd', shellSettings.get('dnd') !== true);
    syncDnd();
    renderStatus();
  });

  const dndRow = h('div.notices__dnd', {},
    h('span.notices__dnd-label', { text: 'Do Not Disturb' }),
    dndSwitch);

  const noticesColumn = h('div.calendar-popover__notifications', {},
    h('div.notices__head', {},
      h('span.notices__title', { text: 'Notifications' }),
      noticeHeaderCount,
      clearButton),
    noticeList,
    dndRow);

  calendar = h('div.popover.calendar-popover', {
    id: 'calendar-popover',
    role: 'dialog',
    'aria-label': 'Calendar and Notifications',
    'aria-hidden': 'true',
    hidden: true,
  }, noticesColumn, calendarColumn);

  calendar.addEventListener('mousedown', (ev) => ev.stopPropagation());
  document.body.appendChild(calendar);
}

/**
 * Explain why keyboard capture is not on offer in this browser.
 * @returns {Promise<void>}
 */
function dialogAboutCapture() {
  return dialog.alert({
    title: '이 브라우저에서는 키보드를 가둘 수 없습니다',
    body: keyboardCapture.unsupportedReason(),
  });
}

/** Repaint the capture indicator from the live state. */
function renderCapture() {
  if (!captureButton || !captureLabel) return;

  if (!keyboardCapture.isSupported()) {
    captureButton.classList.add('is-unsupported');
    captureButton.classList.remove('is-active');
    captureLabel.textContent = '키보드 잠금 불가';
    captureButton.title = keyboardCapture.unsupportedReason();
    return;
  }

  const active = keyboardCapture.isActive();
  captureButton.classList.remove('is-unsupported');
  captureButton.classList.toggle('is-active', active);
  captureLabel.textContent = active ? '키보드 잠김' : '키보드 잠그기';
  captureButton.title = active
    ? 'Ctrl+T, Ctrl+W 등이 에뮬레이터 안에서 동작합니다. 눌러서 나가거나 Esc 를 누르세요.'
    : '눌러서 전체화면으로 전환하고 Ctrl+T, Ctrl+W 같은 브라우저 단축키를 에뮬레이터 안으로 가져옵니다.';
  captureButton.setAttribute('aria-pressed', active ? 'true' : 'false');
}

/**
 * Build the top bar and mount it. Safe to call more than once.
 * @returns {HTMLElement} the top bar element
 */
export function install() {
  if (bar && bar.isConnected) return bar;

  const activities = h('button.top-bar__button.top-bar__activities', {
    type: 'button',
    text: 'Activities',
    'aria-label': 'Activities Overview',
  });
  activities.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeCalendar();
    systemMenu.close();
    overview.toggle();
  });

  dateLabel = h('span.top-bar__date');
  timeLabel = h('span.top-bar__time');
  unreadDot = h('span.top-bar__unread', { 'aria-hidden': 'true', hidden: true });
  clockButton = h('button.top-bar__button.top-bar__clock', {
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    'aria-controls': 'calendar-popover',
  }, dateLabel, timeLabel, unreadDot);
  clockButton.addEventListener('click', (ev) => {
    ev.stopPropagation();
    systemMenu.close();
    toggleCalendar();
  });

  statusIcons = h('span.top-bar__status-icons');
  statusButton = h('button.top-bar__button.top-bar__status', {
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    'aria-controls': 'quick-settings',
    'aria-label': 'System Menu',
  }, statusIcons);
  statusButton.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeCalendar();
    systemMenu.toggle();
  });

  /* --- power button, at the very left ------------------------------------
     GNOME keeps shutdown in the top-right system menu, which this desktop
     also has. This extra control exists for a reason specific to running a
     desktop inside a browser tab: when the keyboard is locked into the
     emulator, the user needs one obvious, always-visible way to end the
     session and get their browser shortcuts back. */
  powerButton = h('button.top-bar__power', {
    type: 'button',
    title: '컴퓨터 끄기 / 다시 시작',
    'aria-label': 'Power Off',
  }, shellIcons.power());
  powerButton.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeCalendar();
    systemMenu.close();
    void openPowerDialog();
  });

  /* --- keyboard capture indicator ---------------------------------------- */
  captureLabel = h('span.top-bar__capture-label');
  captureButton = h('button.top-bar__capture', {
    type: 'button',
    'aria-live': 'polite',
  }, h('span.top-bar__capture-icon', { 'aria-hidden': 'true' }, shellIcons.lock()), captureLabel);
  captureButton.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeCalendar();
    systemMenu.close();
    if (!keyboardCapture.isSupported()) {
      void dialogAboutCapture();
      return;
    }
    if (keyboardCapture.isActive()) void keyboardCapture.requestExit();
    else void keyboardCapture.enable();
  });

  bar = h('header.top-bar', { id: 'top-bar', role: 'banner' },
    h('div.top-bar__left', {}, powerButton, activities, captureButton),
    h('div.top-bar__center', {}, clockButton),
    h('div.top-bar__right', {}, statusButton));

  document.body.appendChild(bar);
  buildCalendar();

  systemMenu.install({ anchor: statusButton });
  renderStatus();
  renderCapture();
  tick();

  if (!installed) {
    installed = true;
    tickTimer = setInterval(tick, 1000);

    bus.on('shell:popover', (payload) => {
      if (!payload || payload.id !== 'calendar') closeCalendar();
    });
    bus.on('settings:change', (payload) => {
      if (!payload) return;
      if (['volume', 'muted', 'wifi', 'wifiNetwork', 'battery', 'charging', 'dnd'].includes(payload.key)) {
        renderStatus();
      }
      if (payload.key === 'dnd' && calendarOpen) syncDnd();
    });
    bus.on('net:online', renderStatus);
    bus.on('net:offline', renderStatus);
    bus.on('capture:on', renderCapture);
    bus.on('capture:off', renderCapture);
    for (const event of ['notify:add', 'notify:remove', 'notify:clear']) {
      bus.on(event, () => {
        if (calendarOpen) renderNotifications();
        else refreshUnread();
      });
    }
    bus.on('overview:open', () => {
      bar.classList.add('top-bar--overview');
    });
    bus.on('overview:close', () => {
      bar.classList.remove('top-bar--overview');
    });
  }

  return bar;
}

/** Stop the clock and detach the top bar (used by hard resets and tests). */
export function uninstall() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = 0;
  }
  closeCalendar();
  if (calendar) calendar.remove();
  if (bar) bar.remove();
  bar = null;
  calendar = null;
}

/** Alias so `main.js` can import every shell installer side by side. */
export const installTopBar = install;

/** Grouped handle for main.js and the keybindings module. */
export const topBar = {
  install,
  uninstall,
  openCalendar,
  closeCalendar,
  toggleCalendar,
  isCalendarOpen,
  closePopovers,
  /** Re-read the settings and repaint the status icons. */
  refreshStatus: renderStatus,
  /** @returns {HTMLElement|null} */
  get element() {
    return bar;
  },
  /** @returns {number} the bar height in CSS pixels */
  height: () => (bar ? bar.offsetHeight : 32),
};
