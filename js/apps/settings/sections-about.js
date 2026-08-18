/**
 * js/apps/settings/sections-about.js — Users, Keyboard Shortcuts and About.
 *
 * The software half of the About page reads its facts out of the virtual
 * filesystem (/etc/os-release, /etc/hostname, /proc/version) so it can never
 * drift away from what `cat` prints in the Terminal. Renaming the device writes
 * /etc/hostname back through `fs`.
 *
 * The hardware half describes the *real* machine, via `js/core/device.js`.
 * Browsers fuzz or withhold most of it, so each row states what it actually
 * knows: RAM is a spec-capped lower bound, storage is the browser's quota
 * rather than the disk, and the CPU model and GPU string may be masked
 * outright. Nothing here invents a vendor, a model number or a capacity.
 *
 * Several of those probes are asynchronous, so the rows are built from a live
 * reader function and re-read when `device.ready()` (and the refresh-rate
 * measurement) resolve — the page is never left showing a placeholder.
 */

import { h, svg } from '../../core/dom.js';
import { fs } from '../../core/fs.js';
import { env } from '../../core/env.js';
import { users } from '../../core/users.js';
import { procs } from '../../core/procs.js';
import { device, measureRefreshRate } from '../../core/device.js';
import { dialog } from '../../core/dialog.js';
import { notify } from '../../core/notify.js';
import { settings } from './state.js';
import * as keybindingsModule from '../../shell/keybindings.js';
import {
  prefPage,
  prefGroup,
  prefCard,
  actionRow,
  switchRow,
  comboRow,
  buttonRow,
  entryRow,
  infoRow,
  button,
} from './widgets.js';

const icon = (paths) => () => svg(paths, { size: 16, strokeWidth: 1.7 });

/* ------------------------------------------------------------------ *
 * facts pulled out of the virtual filesystem
 * ------------------------------------------------------------------ */

function readFile(path) {
  try {
    return fs.readFile(path);
  } catch {
    return '';
  }
}

function osPrettyName() {
  const match = /^PRETTY_NAME="([^"]+)"/m.exec(readFile('/etc/os-release'));
  return match ? match[1] : 'Ubuntu 24.04.1 LTS';
}

function kernelVersion() {
  const match = /^Linux version (\S+)/.exec(readFile('/proc/version'));
  return match ? `Linux ${match[1]}` : 'Linux 6.8.0-45-generic';
}

function deviceName() {
  const raw = readFile('/etc/hostname').trim();
  return raw || users.hostname || 'ubuntu-ai';
}

/* ------------------------------------------------------------------ *
 * facts about the real machine (js/core/device.js)
 * ------------------------------------------------------------------ */

/**
 * Hardware model. Only Chromium exposes one, and only for devices that
 * actually carry a model string (phones, tablets, Chromebooks). Desktops
 * report nothing, and nothing is what we then say.
 * @returns {string}
 */
function hardwareModel() {
  return device.info().cpu.model || 'Unknown';
}

/** @returns {string} `${bitness}-bit`, from userAgentData or the UA string */
function osType() {
  const bits = device.info().cpu.bitness || '64';
  return `${bits}-bit`;
}

/**
 * Browser storage quota, which is emphatically *not* the size of the disk —
 * it is the budget this origin may persist into, usually a fraction of the
 * free space, and it is what the emulator's own filesystem lives inside.
 * @returns {string}
 */
function storageQuota() {
  const s = device.storageLabel();
  if (!s.reported) return 'Not reported by this browser';
  if (s.usageBytes > 0) return `${s.quota} (${s.usage} in use)`;
  return s.quota;
}

/** @returns {string} the host's language tag and IANA time zone */
function localeLabel() {
  const l = device.info().locale;
  return `${l.language} · ${l.timeZone}`;
}

/** @returns {string} what the emulator's RAM figure is worth, in words */
function memoryLabel() {
  return device.memoryLabel();
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const usersSection = {
  id: 'users',
  title: 'Users',
  icon: icon(['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 20a8 8 0 0 1 16 0']),
  keywords: 'users account password login administrator fingerprint',
  build() {
    const locked = () => !users.sudoUnlocked;

    const unlockButton = button({
      label: users.sudoUnlocked ? 'Unlocked' : 'Unlock…',
      style: 'suggested',
      disabled: users.sudoUnlocked,
      onClick: async () => {
        const password = await dialog.prompt({
          title: 'Authentication Required',
          body: 'Authentication is required to change user data.\nEnter the password for the ubuntu account.',
          placeholder: 'Password',
          password: true,
          okLabel: 'Authenticate',
        });
        if (password === null) return;
        if (users.unlockSudo(password)) {
          unlockButton.textContent = 'Unlocked';
          unlockButton.disabled = true;
          for (const control of controls) control.disabled = false;
          notify.show({ app: 'Settings', title: 'Authenticated', body: 'User settings are unlocked for 15 minutes.' });
        } else {
          dialog.alert({ title: 'Authentication Failed', body: 'Sorry, that did not work. Please try again.' });
        }
      },
    });

    const nameEntry = entryRow({
      title: 'Full Name',
      value: settings.get('users.realName'),
      onCommit: (value) => settings.set('users.realName', value.trim() || 'Ubuntu User'),
      keywords: 'user real name gecos',
      disabled: locked(),
    });

    const typeRow = comboRow({
      title: 'Account Type',
      value: settings.get('users.accountType'),
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'administrator', label: 'Administrator' },
      ],
      onChange: (v) => settings.set('users.accountType', v),
      keywords: 'account type administrator standard',
      disabled: locked(),
    });

    const autoLoginRow = switchRow({
      title: 'Automatic Login',
      subtitle: 'Sign in without entering a password when the computer starts',
      value: settings.get('users.automaticLogin') === true,
      onChange: (v) => settings.set('users.automaticLogin', v),
      keywords: 'automatic login autologin',
      disabled: locked(),
    });

    const controls = [
      nameEntry.input,
      typeRow.querySelector('.adw-combo'),
      autoLoginRow.querySelector('.adw-switch'),
    ].filter((node) => node instanceof HTMLElement);

    const avatar = h('div.user-avatar', { text: (settings.get('users.realName') || 'U').trim().charAt(0).toUpperCase() });
    const card = h(
      'div.user-card',
      {},
      avatar,
      h(
        'div.user-card__text',
        {},
        h('span.user-card__name', { text: settings.get('users.realName') }),
        h('span.user-card__meta', { text: `${users.current.name} · ${settings.get('users.accountType') === 'administrator' ? 'Administrator' : 'Standard'}` }),
        h('span.user-card__meta', { text: `uid ${users.current.uid} · ${users.current.home} · ${users.current.shell}` }),
      ),
      unlockButton,
    );

    return prefPage(
      { title: 'Users' },
      prefCard({}, card),
      prefGroup(
        {},
        nameEntry.row,
        typeRow,
        actionRow({
          title: 'Password',
          subtitle: 'Last changed 3 weeks ago',
          suffix: button({
            label: 'Change…',
            onClick: () =>
              dialog.alert({
                title: 'Password Changes Are Not Available',
                body:
                  'This is a simulated Ubuntu session running entirely in your browser. ' +
                  'There is no real account database to write to, so the password cannot be changed.',
              }),
          }),
          keywords: 'password change',
        }),
        autoLoginRow,
        actionRow({
          title: 'Fingerprint Login',
          subtitle: 'No fingerprint reader detected',
          disabled: true,
          suffix: h('span.adw-row__value', { text: 'Unavailable' }),
          keywords: 'fingerprint biometric login',
        }),
      ),
      prefGroup(
        { title: 'Other Users' },
        actionRow({
          title: 'No other users',
          subtitle: 'This system has a single local account',
          keywords: 'other users list',
        }),
        buttonRow({
          title: 'Add User',
          subtitle: 'Create a new local account',
          label: 'Add User…',
          onClick: () => {
            if (!users.sudoUnlocked) {
              dialog.alert({
                title: 'Authentication Required',
                body: 'Unlock this panel before adding a user.',
              });
              return;
            }
            dialog.alert({
              title: 'Account Creation Is Not Available',
              body:
                'This simulated session has one local account, `ubuntu`. ' +
                'Creating additional accounts would have nothing to write to.',
            });
          },
          keywords: 'add user account create',
        }),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Keyboard Shortcuts
 * ------------------------------------------------------------------ */

/** ARCHITECTURE §15, used when the shell module exposes nothing readable. */
const FALLBACK_SHORTCUTS = [
  { group: 'Navigation', accel: 'Super', description: 'Open the Activities Overview' },
  { group: 'Navigation', accel: 'Super+A', description: 'Show all applications' },
  { group: 'Navigation', accel: 'Alt+Tab', description: 'Switch windows' },
  { group: 'Navigation', accel: 'Super+D', description: 'Hide all windows and show the desktop' },
  { group: 'System', accel: 'Super+L', description: 'Lock the screen' },
  { group: 'Windows', accel: 'Super+Left', description: 'Tile the window to the left half' },
  { group: 'Windows', accel: 'Super+Right', description: 'Tile the window to the right half' },
  { group: 'Windows', accel: 'Super+Up', description: 'Maximise the window' },
  { group: 'Windows', accel: 'Super+Down', description: 'Restore the window' },
  { group: 'Windows', accel: 'Alt+F4', description: 'Close the window' },
  { group: 'Launchers', accel: 'Ctrl+Alt+T', description: 'Launch Terminal' },
];

function normaliseShortcut(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const accel = entry.accel || entry.accelerator || entry.keys || entry.shortcut || entry.combo || entry.binding;
  const description = entry.description || entry.label || entry.title || entry.name || entry.action;
  if (typeof accel !== 'string' || typeof description !== 'string') return null;
  return { group: entry.group || entry.category || 'Shortcuts', accel, description };
}

/**
 * Read the shortcut table out of `js/shell/keybindings.js` whatever shape it
 * chose to publish, falling back to the contract's own list.
 * @returns {{group:string, accel:string, description:string}[]}
 */
export function readShortcuts() {
  const candidates = [
    keybindingsModule.SHORTCUTS,
    keybindingsModule.shortcuts,
    keybindingsModule.KEYBINDINGS,
    keybindingsModule.BINDINGS,
    keybindingsModule.default && keybindingsModule.default.shortcuts,
  ];

  const holder = keybindingsModule.keybindings;
  if (holder && typeof holder === 'object') {
    if (Array.isArray(holder.shortcuts)) candidates.push(holder.shortcuts);
    if (typeof holder.list === 'function') {
      try {
        candidates.push(holder.list());
      } catch {
        /* ignore a shell module that is not ready yet */
      }
    }
  }

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const normalised = candidate.map(normaliseShortcut).filter(Boolean);
    if (normalised.length > 0) return normalised;
  }
  return FALLBACK_SHORTCUTS;
}

function accelChips(accel) {
  const box = h('span.accel');
  const parts = String(accel).split(/\s*\+\s*/).filter(Boolean);
  parts.forEach((part, index) => {
    if (index > 0) box.appendChild(h('span.accel__plus', { 'aria-hidden': 'true', text: '+' }));
    box.appendChild(h('kbd.accel__key', { text: part }));
  });
  return box;
}

export const keyboardSection = {
  id: 'keyboard',
  title: 'Keyboard',
  icon: icon(['M3 6h18v12H3z', 'M7 10h.01 M11 10h.01 M15 10h.01 M8 14h8']),
  keywords: 'keyboard shortcuts accelerators keys super alt ctrl',
  build() {
    const shortcuts = readShortcuts();
    const groups = new Map();
    for (const shortcut of shortcuts) {
      const list = groups.get(shortcut.group) || [];
      list.push(shortcut);
      groups.set(shortcut.group, list);
    }

    const sections = [];
    for (const [groupName, list] of groups) {
      sections.push(
        prefGroup(
          { title: groupName },
          ...list.map((shortcut) =>
            actionRow({
              title: shortcut.description,
              class: 'adw-row--shortcut',
              suffix: accelChips(shortcut.accel),
              keywords: `shortcut ${shortcut.accel}`,
            }),
          ),
        ),
      );
    }

    return prefPage(
      { title: 'Keyboard' },
      prefGroup(
        { description: 'These shortcuts are handled by the shell and cannot be reassigned in this session.' },
        actionRow({
          title: 'Keyboard Layout',
          subtitle: 'English (UK)',
          suffix: h('span.adw-row__value', { text: 'gb' }),
          keywords: 'keyboard layout input source',
        }),
      ),
      ...sections,
    );
  },
};

/* ------------------------------------------------------------------ *
 * About
 * ------------------------------------------------------------------ */

/** The Ubuntu Circle of Friends. */
function ubuntuLogo() {
  const dots = [-60, 60, 180].map((degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return h('circle', {
      cx: String(32 + 20 * Math.cos(radians)),
      cy: String(32 + 20 * Math.sin(radians)),
      r: '6.6',
      fill: '#E95420',
      stroke: 'var(--adw-card-bg, #ffffff)',
      'stroke-width': '3.2',
    });
  });

  return h(
    'svg.ubuntu-logo',
    { viewBox: '0 0 64 64', width: '80', height: '80', role: 'img', 'aria-label': 'Ubuntu' },
    h('circle', { cx: '32', cy: '32', r: '20', fill: 'none', stroke: '#E95420', 'stroke-width': '6' }),
    ...dots,
  );
}

/**
 * An info row whose value comes from `device.js` and therefore changes when the
 * asynchronous probes land. Returns the row plus a refresh closure that the
 * page registers; refreshing a row that has been navigated away from is a
 * no-op, so a stale timer can never write into a detached tree.
 *
 * @param {string} title
 * @param {() => string} read
 * @param {{keywords?:string}} [opts]
 * @returns {{row: HTMLElement, refresh: () => void}}
 */
function deviceInfoRow(title, read, opts = {}) {
  const row = infoRow(title, read(), opts);
  const value = row.querySelector('.adw-row__value');
  return {
    row,
    refresh() {
      if (!value || !row.isConnected) return;
      const next = read();
      if (value.textContent !== next) value.textContent = next;
    },
  };
}

export const aboutSection = {
  id: 'about',
  title: 'About',
  icon: icon(['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v6', 'M12 7.5h.01']),
  keywords:
    'about device os version kernel gnome hardware disk memory processor hostname '
    + 'graphics gpu display resolution storage quota browser locale time zone host',
  build() {
    /** @type {Array<() => void>} */
    const liveRows = [];

    /**
     * Register a device-backed row and return the element for layout.
     * @param {string} title
     * @param {() => string} read
     * @param {{keywords?:string}} [opts]
     * @returns {HTMLElement}
     */
    const fact = (title, read, opts) => {
      const entry = deviceInfoRow(title, read, opts);
      liveRows.push(entry.refresh);
      return entry.row;
    };

    const refreshAll = () => {
      for (const refresh of liveRows) refresh();
    };

    const deviceRow = entryRow({
      title: 'Device Name',
      value: deviceName(),
      placeholder: 'ubuntu-ai',
      keywords: 'device name hostname',
      onCommit: (raw) => {
        const name = raw.trim().replace(/\s+/g, '-').toLowerCase();
        if (name === '') {
          deviceRow.input.value = deviceName();
          return;
        }
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
          dialog.alert({
            title: 'Invalid Device Name',
            body: 'A hostname may contain only lowercase letters, digits and hyphens, and must not start with a hyphen.',
          });
          deviceRow.input.value = deviceName();
          return;
        }
        fs.writeFile('/etc/hostname', `${name}\n`);
        users.hostname = name;
        env.set('HOSTNAME', name);
        deviceRow.input.value = name;
        notify.show({ app: 'Settings', title: 'Device name changed', body: `The hostname is now ${name}.` });
      },
    });

    const header = h(
      'div.about-header',
      {},
      ubuntuLogo(),
      h('span.about-header__name', { text: osPrettyName() }),
      h('span.about-header__tagline', { text: 'Ubuntu Desktop · GNOME 46' }),
    );

    const page = prefPage(
      { title: 'About' },
      prefCard({}, header),
      prefGroup({}, deviceRow.row),
      prefGroup(
        {
          title: 'Hardware',
          description:
            'Read from the machine this browser is running on. Browsers round, cap or '
            + 'withhold most hardware facts, so each row says how far it can be trusted.',
        },
        fact('Hardware Model', hardwareModel, { keywords: 'hardware model vendor' }),
        fact('Memory', memoryLabel, { keywords: 'memory ram' }),
        fact('Processor', () => device.cpuModel(), { keywords: 'processor cpu cores' }),
        fact('Graphics', () => device.gpuModel(), { keywords: 'graphics gpu renderer webgl' }),
        fact('Display', () => device.displayLabel(), { keywords: 'display resolution refresh scale' }),
        fact('Browser Storage Quota', storageQuota, { keywords: 'disk capacity storage quota' }),
      ),
      prefGroup(
        { title: 'Host' },
        fact('Running On', () => device.hostLabel(), { keywords: 'browser host operating system' }),
        fact('Locale and Time Zone', localeLabel, { keywords: 'locale language time zone region' }),
      ),
      prefGroup(
        { title: 'Software' },
        infoRow('OS Name', osPrettyName(), { keywords: 'os name distribution' }),
        fact('OS Type', osType, { keywords: 'os type architecture bitness' }),
        infoRow('GNOME Version', '46.0', { keywords: 'gnome version desktop' }),
        infoRow('Windowing System', 'Wayland', { keywords: 'windowing system wayland x11' }),
        infoRow('Kernel Version', kernelVersion(), { keywords: 'kernel linux version' }),
      ),
      prefGroup(
        {},
        buttonRow({
          title: 'Software Updates',
          subtitle: 'Check for operating system and application updates',
          label: 'Check for Updates',
          onClick: () =>
            notify.show({
              app: 'Software Updater',
              title: 'The software on this computer is up to date',
              body: 'However, updates to Ubuntu 24.04.1 LTS may be available in future.',
            }),
          keywords: 'software updates upgrade',
        }),
        buttonRow({
          title: 'System Details',
          subtitle: 'Full hardware and software report',
          label: 'System Details',
          onClick: () =>
            dialog.alert({
              title: 'System Details',
              body: [
                `Device Name\t${deviceName()}`,
                `Hardware Model\t${hardwareModel()}`,
                `Memory\t\t${memoryLabel()}`,
                `Processor\t${device.cpuModel()}`,
                `Graphics\t${device.gpuModel()}`,
                `Display\t\t${device.displayLabel()}`,
                `Browser Storage\t${storageQuota()}`,
                '',
                `Running On\t${device.hostLabel()}`,
                `Locale\t\t${localeLabel()}`,
                '',
                `OS Name\t\t${osPrettyName()}`,
                `OS Type\t\t${osType()}`,
                `GNOME Version\t46.0`,
                `Windowing System\tWayland`,
                `Kernel Version\t${kernelVersion()}`,
                `Processors\t${procs.cores}`,
                `Uptime\t\t${Math.floor(procs.uptime() / 3600)}h ${Math.floor((procs.uptime() % 3600) / 60)}m`,
                '',
                'Memory and storage figures come from the browser, which rounds RAM to a',
                'spec-capped bucket and reports a storage quota rather than a disk size.',
              ].join('\n'),
              okLabel: 'Close',
            }),
          keywords: 'system details report',
        }),
      ),
    );

    // The storage quota, the device model and the architecture arrive from
    // asynchronous probes, and the refresh rate needs twenty animation frames
    // after that. Re-read the rows as each lands rather than leaving the page
    // showing whatever was known at build time.
    device.ready().then(refreshAll, () => {});
    measureRefreshRate().then(refreshAll, () => {});

    return page;
  },
};
