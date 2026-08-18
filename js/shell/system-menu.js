/**
 * js/shell/system-menu.js — Yaru quick-settings panel (ARCHITECTURE §15).
 *
 * Also the home of two things the rest of the shell shares:
 *   `shellSettings` — the namespaced accessor over `store.get('settings')`
 *                     that emits `settings:change` on every write.
 *   `shellIcons`    — the symbolic icon factories used by the top bar and dock.
 *
 * The session actions this panel triggers (end-session dialog, power-off
 * overlay, lock screen, screenshot) live in the sibling `./session.js`.
 *
 * Every label is written with `textContent`; `innerHTML` is never used.
 */

import { h, svg, clear } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { notify } from '../core/notify.js';
import { users } from '../core/users.js';
import { wm } from './window-manager.js';
import { openPowerDialog, lockScreen, isLocked, takeScreenshot, ubuntuLogo } from './session.js';

export { openPowerDialog, lockScreen, isLocked, takeScreenshot, ubuntuLogo };

/* ================================================================== *
 * settings
 * ================================================================== */

/** Shell defaults. The Settings app may add keys of its own. */
export const SETTINGS_DEFAULTS = Object.freeze({
  theme: 'light',
  accent: '#E95420',
  volume: 72,
  muted: false,
  brightness: 100,
  wifi: true,
  wifiNetwork: 'Ubuntu-Guest',
  bluetooth: false,
  powerMode: 'balanced',
  nightLight: false,
  dnd: false,
  battery: 78,
  charging: false,
  dockPosition: 'left',
  dockIconSize: 48,
  dockAutohide: false,
  dockPinned: null,
});

function readAll() {
  const raw = store.get('settings', null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export const shellSettings = {
  /**
   * @param {string} key
   * @param {any} [fallback] used when the key is absent and has no default
   * @returns {any}
   */
  get(key, fallback) {
    const all = readAll();
    if (Object.prototype.hasOwnProperty.call(all, key)) return all[key];
    if (Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)) return SETTINGS_DEFAULTS[key];
    return fallback === undefined ? null : fallback;
  },

  /**
   * Persist one setting and announce it on the bus.
   * @param {string} key
   * @param {any} value
   * @returns {any} the stored value
   */
  set(key, value) {
    const all = readAll();
    all[key] = value;
    store.set('settings', all);
    bus.emit('settings:change', { key, value });
    return value;
  },

  /** @returns {object} defaults merged with the persisted overrides */
  all() {
    return Object.assign({}, SETTINGS_DEFAULTS, readAll());
  },
};

/** @param {string} key @param {any} [fallback] @returns {any} */
export function getSetting(key, fallback) {
  return shellSettings.get(key, fallback);
}

/** @param {string} key @param {any} value @returns {any} */
export function setSetting(key, value) {
  return shellSettings.set(key, value);
}

/* ================================================================== *
 * symbolic icons
 * ================================================================== */

const ICON = {
  speaker: 'M4 9.2h3.4L12 5.2v13.6l-4.6-4H4z',
  waveSmall: 'M15.2 9.6a3.6 3.6 0 0 1 0 4.8',
  waveMid: 'M17.4 7.4a7 7 0 0 1 0 9.2',
  waveBig: 'M19.6 5.2a10.4 10.4 0 0 1 0 13.6',
  mute: ['M15.6 9.6 20.4 14.4', 'M20.4 9.6 15.6 14.4'],
  wifiArcs: [
    'M2.2 8.6a15.2 15.2 0 0 1 19.6 0',
    'M5.6 12.1a10.1 10.1 0 0 1 12.8 0',
    'M9 15.6a5.2 5.2 0 0 1 6 0',
  ],
  wifiOff: 'M3 3l18 18',
  bluetooth: 'M8 6.6 16 17 12 21V3l4 4L8 17.4',
  gear: [
    'M12 15.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2',
    'M19.1 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 1 1-2.9 2.9l-.06-.07a1.7 1.7 0 0 0-2.87 1.2v.18a2.05 2.05 0 1 1-4.1 0v-.1a1.7 1.7 0 0 0-2.93-1.16l-.06.06a2.05 2.05 0 1 1-2.9-2.9l.07-.06A1.7 1.7 0 0 0 3.5 13.6h-.18a2.05 2.05 0 1 1 0-4.1h.1a1.7 1.7 0 0 0 1.16-2.93l-.06-.06a2.05 2.05 0 1 1 2.9-2.9l.06.07A1.7 1.7 0 0 0 10.4 3.5v-.18a2.05 2.05 0 1 1 4.1 0v.1a1.7 1.7 0 0 0 2.93 1.16l.06-.06a2.05 2.05 0 1 1 2.9 2.9l-.07.06a1.7 1.7 0 0 0 1.2 2.87h.18a2.05 2.05 0 1 1 0 4.1h-.1a1.7 1.7 0 0 0-1.5 1.02',
  ],
  moon: 'M20.6 14.4A8.7 8.7 0 0 1 9.6 3.4a8.7 8.7 0 1 0 11 11z',
  star: 'M17.4 3.6l.78 1.72 1.72.78-1.72.78-.78 1.72-.78-1.72-1.72-.78 1.72-.78z',
  sun: 'M12 16.2a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4',
  rays: [
    'M12 2.4v2.1', 'M12 19.5v2.1', 'M2.4 12h2.1', 'M19.5 12h2.1',
    'M5.2 5.2l1.5 1.5', 'M17.3 17.3l1.5 1.5', 'M18.8 5.2l-1.5 1.5', 'M6.7 17.3l-1.5 1.5',
  ],
  camera: ['M3.4 8.6h3.3l1.7-2.6h7.2l1.7 2.6h3.3v10.4H3.4z', 'M12 16.6a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8'],
  lock: ['M5.8 10.6h12.4v9.2H5.8z', 'M8.6 10.6V7.6a3.4 3.4 0 0 1 6.8 0v3'],
  power: ['M12 3.2v8.6', 'M17.5 6.6a7.7 7.7 0 1 1-11 0'],
  person: ['M12 12.4a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2', 'M4.4 20.4a7.6 7.6 0 0 1 15.2 0'],
  chevron: 'M6.5 9.5 12 15l5.5-5.5',
  chevronRight: 'M9.5 6 15 11.5 9.5 17',
  performance: ['M4.6 18.4a9.2 9.2 0 1 1 14.8 0', 'M12 13.6 15.8 9.4'],
  ecoLeaf: ['M20 4.5c0 8.6-4.4 13.4-11 13.4-2.2 0-4-.6-4-.6s.4-6.7 5-10.2C13.4 4.4 20 4.5 20 4.5z', 'M5 19.5c1.6-4 4.2-7.2 7.6-9.4'],
};

/**
 * @param {number} level 0-100
 * @param {boolean} muted
 * @returns {SVGElement}
 */
function volumeIcon(level, muted) {
  const paths = [ICON.speaker];
  if (muted || level <= 0) paths.push(...ICON.mute);
  else {
    paths.push(ICON.waveSmall);
    if (level >= 34) paths.push(ICON.waveMid);
    if (level >= 67) paths.push(ICON.waveBig);
  }
  return svg(paths, { size: 18, strokeWidth: 1.6 });
}

/**
 * @param {number} level 0-100
 * @returns {SVGElement}
 */
function brightnessIcon(level) {
  const paths = [ICON.sun];
  const rays = level >= 66 ? 8 : level >= 33 ? 4 : 0;
  for (let i = 0; i < rays; i += 1) paths.push(ICON.rays[i]);
  return svg(paths, { size: 18, strokeWidth: 1.6 });
}

/**
 * @param {number} strength 0-4 (0 = disabled)
 * @returns {SVGElement}
 */
function wifiIcon(strength) {
  if (strength <= 0) return svg([ICON.wifiArcs[2], ICON.wifiOff], { size: 18, strokeWidth: 1.6 });
  const paths = ICON.wifiArcs.slice(3 - Math.min(3, strength));
  return svg(paths, { size: 18, strokeWidth: 1.6 });
}

/**
 * Battery pill whose fill tracks the charge level.
 * @param {number} percent 0-100
 * @param {boolean} charging
 * @returns {SVGElement}
 */
function batteryIcon(percent, charging) {
  const level = Math.max(0, Math.min(100, Number(percent) || 0));
  const root = h('svg', {
    viewBox: '0 0 24 24', width: '18', height: '18',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  });
  root.appendChild(h('rect', { x: '2', y: '8', width: '16.5', height: '8', rx: '2.4' }));
  root.appendChild(h('path', { d: 'M20.8 10.6v2.8', stroke: 'currentColor' }));
  const inner = 13.7 * (level / 100);
  if (inner > 0.4) {
    root.appendChild(h('rect', {
      x: '3.4', y: '9.4', width: String(inner.toFixed(2)), height: '5.2', rx: '1.2',
      fill: 'currentColor', stroke: 'none',
    }));
  }
  if (charging) {
    root.appendChild(h('path', {
      d: 'M11.4 9.2 8.9 12.6h2.7l-.6 2.4 2.7-3.5h-2.7z',
      fill: 'currentColor', stroke: 'none',
    }));
  }
  return root;
}

/** Icon factories shared with the top bar and dock. */
export const shellIcons = {
  volume: volumeIcon,
  brightness: brightnessIcon,
  wifi: wifiIcon,
  battery: batteryIcon,
  bluetooth: () => svg(ICON.bluetooth, { size: 18, strokeWidth: 1.6 }),
  settings: () => svg(ICON.gear, { size: 18, strokeWidth: 1.5 }),
  lock: () => svg(ICON.lock, { size: 18, strokeWidth: 1.6 }),
  power: () => svg(ICON.power, { size: 18, strokeWidth: 1.7 }),
  person: () => svg(ICON.person, { size: 20, strokeWidth: 1.6 }),
  chevron: () => svg(ICON.chevron, { size: 14, strokeWidth: 1.8 }),
  chevronRight: () => svg(ICON.chevronRight, { size: 14, strokeWidth: 1.8 }),
  camera: () => svg(ICON.camera, { size: 18, strokeWidth: 1.6 }),
  moon: () => svg(ICON.moon, { size: 18, strokeWidth: 1.6 }),
  nightLight: () => svg([ICON.moon, ICON.star], { size: 18, strokeWidth: 1.6 }),
  performance: () => svg(ICON.performance, { size: 18, strokeWidth: 1.6 }),
  eco: () => svg(ICON.ecoLeaf, { size: 18, strokeWidth: 1.6 }),
  trash: () => svg(['M4.5 6.6h15', 'M9.4 6.6V4.4h5.2v2.2', 'M6.6 6.6l.9 13h9l.9-13', 'M10.2 10v6.4', 'M13.8 10v6.4'], { size: 22, strokeWidth: 1.6 }),
};

/* ================================================================== *
 * applied state (overlays, css variables)
 * ================================================================== */

/** Simulated access points, strongest first. */
const NETWORKS = [
  { ssid: 'Ubuntu-Guest', strength: 4, secure: true },
  { ssid: 'eduroam', strength: 4, secure: true },
  { ssid: 'TP-Link_5GHz', strength: 3, secure: true },
  { ssid: 'Xfinity WiFi', strength: 2, secure: false },
  { ssid: 'HOME-A4C2', strength: 2, secure: true },
  { ssid: 'NETGEAR47', strength: 1, secure: true },
];

const POWER_MODES = [
  { id: 'performance', label: 'Performance' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'power-saver', label: 'Power Saver' },
];

let brightnessOverlay = null;
let nightLightOverlay = null;

function ensureOverlay(className, ref) {
  if (ref && ref.isConnected) return ref;
  const node = h('div', { class: className, 'aria-hidden': 'true' });
  document.body.appendChild(node);
  return node;
}

function applyBrightness(value) {
  brightnessOverlay = ensureOverlay('brightness-overlay', brightnessOverlay);
  const level = Math.max(10, Math.min(100, Number(value) || 0));
  brightnessOverlay.style.opacity = String(((100 - level) / 100) * 0.72);
}

function applyNightLight(enabled) {
  nightLightOverlay = ensureOverlay('night-light-overlay', nightLightOverlay);
  nightLightOverlay.style.opacity = enabled ? '1' : '0';
}

function applyVolume(level, muted) {
  const value = muted ? 0 : Math.max(0, Math.min(100, Number(level) || 0));
  document.documentElement.style.setProperty('--volume', String(value / 100));
  document.documentElement.style.setProperty('--volume-percent', `${Math.round(value)}%`);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

/** Re-apply every visual setting. Idempotent; safe to call at any time. */
export function applyShellSettings() {
  const s = shellSettings.all();
  applyTheme(s.theme);
  if (s.accent) document.documentElement.style.setProperty('--accent', String(s.accent));
  applyBrightness(s.brightness);
  applyNightLight(s.nightLight === true);
  applyVolume(s.volume, s.muted === true);
}

/* ================================================================== *
 * the quick-settings panel
 * ================================================================== */

let panel = null;
let statusAnchor = null;
let open = false;
let networkExpanded = false;
let batteryTimer = 0;
let unbindOutside = null;

function toggleButton({ label, icon, active, onClick, chevron, disabled }) {
  const button = h('button.qs-toggle', {
    type: 'button',
    title: label,
    'aria-label': label,
    'aria-pressed': active ? 'true' : 'false',
    disabled: disabled === true,
    class: active ? 'qs-toggle--on' : null,
  });
  button.appendChild(h('span.qs-toggle__disc', { 'aria-hidden': 'true' }, icon));
  button.appendChild(h('span.qs-toggle__label', { text: label }));
  if (chevron) button.appendChild(h('span.qs-toggle__chevron', { 'aria-hidden': 'true' }, shellIcons.chevron()));
  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick(ev);
  });
  return button;
}

function sliderRow({ className, icon, value, label, onInput }) {
  const iconBox = h('span.qs-slider__icon', { 'aria-hidden': 'true' }, icon);
  const input = h('input.qs-slider__range', {
    type: 'range', min: '0', max: '100', step: '1',
    value: String(Math.round(value)),
    'aria-label': label,
  });
  // `--fill` drives the filled portion of the track (see system-menu.css).
  const paintTrack = (level) => input.style.setProperty('--fill', `${Math.round(level)}%`);
  paintTrack(value);

  const row = h('div', { class: `qs-slider ${className}` }, iconBox, input);
  input.addEventListener('input', () => {
    const next = Number(input.value);
    paintTrack(next);
    const replacement = onInput(next);
    if (replacement) {
      clear(iconBox);
      iconBox.appendChild(replacement);
    }
  });
  input.addEventListener('click', (ev) => ev.stopPropagation());
  return row;
}

function networkRow(net, current, onPick) {
  const button = h('button.qs-network', {
    type: 'button',
    class: net.ssid === current ? 'qs-network--active' : null,
  });
  button.appendChild(h('span.qs-network__icon', { 'aria-hidden': 'true' }, shellIcons.wifi(net.strength)));
  button.appendChild(h('span.qs-network__name', { text: net.ssid }));
  if (net.secure) button.appendChild(h('span.qs-network__lock', { 'aria-hidden': 'true' }, shellIcons.lock()));
  if (net.ssid === current) button.appendChild(h('span.qs-network__state', { text: 'Connected' }));
  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onPick(net);
  });
  return button;
}

function nextPowerMode(current) {
  const index = POWER_MODES.findIndex((m) => m.id === current);
  return POWER_MODES[(index + 1 + POWER_MODES.length) % POWER_MODES.length];
}

function render() {
  if (!panel) return;
  clear(panel);
  const s = shellSettings.all();

  /* --- round toggles --- */
  const toggles = h('div.qs__toggles', { role: 'group', 'aria-label': 'Quick settings' });
  toggles.appendChild(toggleButton({
    label: s.wifi ? s.wifiNetwork : 'Wi-Fi Off',
    icon: shellIcons.wifi(s.wifi ? 4 : 0),
    active: s.wifi,
    chevron: true,
    onClick: (ev) => {
      if (ev.altKey || ev.target.closest('.qs-toggle__chevron')) {
        networkExpanded = !networkExpanded;
        render();
        return;
      }
      const value = !shellSettings.get('wifi');
      shellSettings.set('wifi', value);
      bus.emit(value ? 'net:online' : 'net:offline', {});
      networkExpanded = value ? networkExpanded : false;
      render();
    },
  }));
  toggles.appendChild(toggleButton({
    label: 'Bluetooth',
    icon: shellIcons.bluetooth(),
    active: s.bluetooth,
    onClick: () => {
      shellSettings.set('bluetooth', !shellSettings.get('bluetooth'));
      render();
    },
  }));
  const mode = POWER_MODES.find((m) => m.id === s.powerMode) || POWER_MODES[1];
  toggles.appendChild(toggleButton({
    label: mode.label,
    icon: mode.id === 'power-saver' ? shellIcons.eco() : shellIcons.performance(),
    active: mode.id !== 'balanced',
    onClick: () => {
      shellSettings.set('powerMode', nextPowerMode(shellSettings.get('powerMode')).id);
      render();
    },
  }));
  toggles.appendChild(toggleButton({
    label: 'Dark Style',
    icon: shellIcons.moon(),
    active: s.theme === 'dark',
    onClick: () => {
      const value = shellSettings.get('theme') === 'dark' ? 'light' : 'dark';
      shellSettings.set('theme', value);
      applyTheme(value);
      render();
    },
  }));
  toggles.appendChild(toggleButton({
    label: 'Night Light',
    icon: shellIcons.nightLight(),
    active: s.nightLight,
    onClick: () => {
      const value = !shellSettings.get('nightLight');
      shellSettings.set('nightLight', value);
      applyNightLight(value);
      render();
    },
  }));
  toggles.appendChild(toggleButton({
    label: 'Screenshot',
    icon: shellIcons.camera(),
    active: false,
    onClick: () => {
      closeMenu();
      setTimeout(takeScreenshot, 220);
    },
  }));
  panel.appendChild(toggles);

  /* --- expandable Wi-Fi list --- */
  if (networkExpanded && s.wifi) {
    const list = h('div.qs__networks', { role: 'listbox', 'aria-label': 'Wi-Fi Networks' });
    list.appendChild(h('div.qs__networks-title', { text: 'Visible Networks' }));
    for (const net of NETWORKS) {
      list.appendChild(networkRow(net, s.wifiNetwork, (picked) => {
        shellSettings.set('wifiNetwork', picked.ssid);
        networkExpanded = false;
        render();
        notify.show({
          app: 'Network',
          title: 'Connected',
          body: `You’re now connected to the Wi-Fi network “${picked.ssid}”.`,
          icon: shellIcons.wifi(picked.strength),
        });
      }));
    }
    panel.appendChild(list);
  }

  /* --- sliders --- */
  panel.appendChild(sliderRow({
    className: 'qs-slider--brightness',
    icon: shellIcons.brightness(s.brightness),
    value: s.brightness,
    label: 'Screen Brightness',
    onInput: (value) => {
      shellSettings.set('brightness', value);
      applyBrightness(value);
      return shellIcons.brightness(value);
    },
  }));
  panel.appendChild(sliderRow({
    className: 'qs-slider--volume',
    icon: shellIcons.volume(s.volume, s.muted),
    value: s.muted ? 0 : s.volume,
    label: 'Volume',
    onInput: (value) => {
      shellSettings.set('muted', value === 0);
      shellSettings.set('volume', value);
      applyVolume(value, value === 0);
      return shellIcons.volume(value, value === 0);
    },
  }));

  /* --- user row --- */
  const userRow = h('button.qs-user', { type: 'button' },
    h('span.qs-user__avatar', { 'aria-hidden': 'true' }, shellIcons.person()),
    h('span.qs-user__names', {},
      h('span.qs-user__name', { text: users.current.gecos || users.current.name }),
      h('span.qs-user__login', { text: `${users.current.name}@${users.hostname}` })),
    h('span.qs-user__battery', { 'aria-hidden': 'true' }, shellIcons.battery(s.battery, s.charging)),
    h('span.qs-user__percent', { text: `${Math.round(s.battery)}%` }));
  userRow.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenu();
    wm.open('settings', { section: 'users' });
  });
  panel.appendChild(userRow);

  /* --- footer --- */
  const footer = h('div.qs__footer');
  const footerButton = (label, icon, onClick) => {
    const button = h('button.qs-footer-btn', { type: 'button', title: label, 'aria-label': label },
      h('span.qs-footer-btn__disc', { 'aria-hidden': 'true' }, icon));
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return button;
  };
  footer.appendChild(footerButton('Settings', shellIcons.settings(), () => {
    closeMenu();
    wm.open('settings');
  }));
  footer.appendChild(footerButton('Lock Screen', shellIcons.lock(), () => {
    closeMenu();
    lockScreen();
  }));
  footer.appendChild(footerButton('Power Off / Log Out', shellIcons.power(), () => {
    closeMenu();
    openPowerDialog();
  }));
  panel.appendChild(footer);
}

function onDocumentDown(ev) {
  if (!open || !panel) return;
  if (panel.contains(ev.target)) return;
  if (statusAnchor && statusAnchor.contains(ev.target)) return;
  closeMenu();
}

function onDocumentKey(ev) {
  if (!open) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeMenu();
  }
}

/** Open the quick-settings panel. */
export function openMenu() {
  if (open) return;
  if (!panel) install();
  open = true;
  networkExpanded = false;
  render();
  panel.classList.add('qs--open');
  panel.setAttribute('aria-hidden', 'false');
  if (statusAnchor) statusAnchor.setAttribute('aria-expanded', 'true');

  document.addEventListener('mousedown', onDocumentDown, true);
  document.addEventListener('keydown', onDocumentKey, true);
  unbindOutside = () => {
    document.removeEventListener('mousedown', onDocumentDown, true);
    document.removeEventListener('keydown', onDocumentKey, true);
  };
  bus.emit('shell:popover', { id: 'system-menu' });
}

/** Close the quick-settings panel. */
export function closeMenu() {
  if (!open) return;
  open = false;
  networkExpanded = false;
  if (panel) {
    panel.classList.remove('qs--open');
    panel.setAttribute('aria-hidden', 'true');
  }
  if (statusAnchor) statusAnchor.setAttribute('aria-expanded', 'false');
  if (unbindOutside) {
    unbindOutside();
    unbindOutside = null;
  }
}

/** @returns {boolean} */
export function isOpen() {
  return open;
}

/** Toggle the quick-settings panel. */
export function toggleMenu() {
  if (open) closeMenu();
  else openMenu();
}

function startBatterySimulation() {
  if (batteryTimer) return;
  batteryTimer = setInterval(() => {
    const charging = shellSettings.get('charging') === true;
    const level = Number(shellSettings.get('battery')) || 0;
    let next = charging ? level + 1 : level - 1;
    if (next >= 100) {
      next = 100;
    } else if (next <= 8) {
      next = 8;
      shellSettings.set('charging', true);
      notify.show({
        app: 'Power',
        title: 'Battery Low',
        body: 'Connect the power cable to keep working.',
        icon: shellIcons.battery(8, false),
        timeout: 8000,
      });
    }
    shellSettings.set('battery', next);
  }, 180000);
}

/**
 * Mount the quick-settings panel and wire it to the top bar's status area.
 * Safe to call more than once.
 * @param {{anchor?: HTMLElement}} [options]
 * @returns {HTMLElement} the panel element
 */
export function install(options = {}) {
  applyShellSettings();

  if (options.anchor) statusAnchor = options.anchor;

  if (panel && panel.isConnected) {
    render();
    return panel;
  }

  panel = h('div.qs.popover', {
    id: 'quick-settings',
    role: 'dialog',
    'aria-label': 'System',
    'aria-hidden': 'true',
  });
  document.body.appendChild(panel);
  render();

  bus.on('shell:popover', (payload) => {
    if (!payload || payload.id !== 'system-menu') closeMenu();
  });
  bus.on('settings:change', (payload) => {
    if (!payload) return;
    if (payload.key === 'theme') applyTheme(payload.value);
    if (payload.key === 'accent') {
      document.documentElement.style.setProperty('--accent', String(payload.value));
    }
    if (payload.key === 'brightness') applyBrightness(payload.value);
    if (payload.key === 'nightLight') applyNightLight(payload.value === true);
    if (payload.key === 'volume' || payload.key === 'muted') {
      applyVolume(shellSettings.get('volume'), shellSettings.get('muted') === true);
    }
    if (open && (payload.key === 'battery' || payload.key === 'charging')) render();
  });

  startBatterySimulation();
  return panel;
}

/** Alias so `main.js` can import every shell installer side by side. */
export const installSystemMenu = install;

/** Grouped handle used by the top bar and the keybinding table. */
export const systemMenu = {
  install,
  open: openMenu,
  close: closeMenu,
  toggle: toggleMenu,
  isOpen,
  lock: lockScreen,
  isLocked,
  powerDialog: openPowerDialog,
  screenshot: takeScreenshot,
  settings: shellSettings,
  icons: shellIcons,
  /** @returns {{ssid:string, strength:number, secure:boolean}[]} */
  networks: () => NETWORKS.map((n) => Object.assign({}, n)),
  /** @returns {{id:string,label:string}[]} */
  powerModes: () => POWER_MODES.map((m) => Object.assign({}, m)),
};
