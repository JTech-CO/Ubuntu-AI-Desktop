/**
 * js/apps/settings/sections-personal.js — Appearance, Background, Displays,
 * Notifications, Search and Multitasking panels.
 *
 * Each export is a section definition consumed by `./sections.js`.
 */

import { h, svg } from '../../core/dom.js';
import { notify } from '../../core/notify.js';
import { settings, ACCENTS, WALLPAPERS, getWallpaper } from './state.js';
import {
  prefPage,
  prefGroup,
  prefCard,
  switchRow,
  comboRow,
  sliderRow,
  buttonRow,
  radioRows,
  tileGrid,
} from './widgets.js';

const icon = (paths) => () => svg(paths, { size: 16, strokeWidth: 1.7 });

/* ------------------------------------------------------------------ *
 * Appearance
 * ------------------------------------------------------------------ */

function stylePreview(variant) {
  return h(
    `span.style-preview.style-preview--${variant}`,
    {},
    h('span.style-preview__bar'),
    h('span.style-preview__window', {}, h('span.style-preview__header'), h('span.style-preview__body')),
    h('span.style-preview__dock'),
  );
}

export const appearanceSection = {
  id: 'appearance',
  title: 'Appearance',
  icon: icon(['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 3v18', 'M12 8h9', 'M12 16h9']),
  keywords: 'theme dark light style accent colour color dock icons autohide trash',
  build() {
    const style = tileGrid({
      ariaLabel: 'Style',
      class: 'adw-tiles--style',
      columns: 3,
      value: settings.get('appearance.style'),
      onChange: (id) => settings.set('appearance.style', id),
      items: [
        { id: 'light', label: 'Light', render: () => stylePreview('light') },
        { id: 'dark', label: 'Dark', render: () => stylePreview('dark') },
        { id: 'auto', label: 'Automatic', render: () => stylePreview('auto') },
      ],
    });

    const accents = tileGrid({
      ariaLabel: 'Accent colour',
      class: 'adw-tiles--accent',
      columns: 10,
      value: settings.get('appearance.accent'),
      onChange: (id) => settings.set('appearance.accent', id),
      items: ACCENTS.map((accent) => ({
        id: accent.id,
        title: accent.name,
        render: () => h('span.accent-swatch', { style: { background: accent.hex } }),
      })),
    });

    return prefPage(
      { title: 'Appearance' },
      prefCard({ title: 'Style' }, style),
      prefCard(
        { title: 'Colour', description: 'The accent colour is used across the interface for selection and focus.' },
        accents,
      ),
      prefGroup(
        { title: 'Dock' },
        comboRow({
          title: 'Position on Screen',
          value: settings.get('dock.position'),
          options: [
            { value: 'left', label: 'Left' },
            { value: 'bottom', label: 'Bottom' },
            { value: 'right', label: 'Right' },
          ],
          onChange: (v) => settings.set('dock.position', v),
          keywords: 'dock position left bottom right',
        }),
        sliderRow({
          title: 'Icon Size',
          value: Number(settings.get('dock.iconSize')),
          min: 16,
          max: 64,
          step: 2,
          format: (v) => `${v} px`,
          onChange: (v) => settings.set('dock.iconSize', v),
          keywords: 'dock icon size',
        }),
        switchRow({
          title: 'Auto-hide the Dock',
          subtitle: 'The dock hides when any window overlaps it',
          value: settings.get('dock.autohide') === true,
          onChange: (v) => settings.set('dock.autohide', v),
          keywords: 'dock autohide intellihide',
        }),
        switchRow({
          title: 'Show Trash',
          value: settings.get('dock.showTrash') === true,
          onChange: (v) => settings.set('dock.showTrash', v),
          keywords: 'dock trash',
        }),
        switchRow({
          title: 'Show Mounted Drives',
          value: settings.get('dock.showMounts') === true,
          onChange: (v) => settings.set('dock.showMounts', v),
          keywords: 'dock mounted drives volumes',
        }),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Background
 * ------------------------------------------------------------------ */

export const backgroundSection = {
  id: 'background',
  title: 'Background',
  icon: icon(['M3 5h18v14H3z', 'M3 16l5-5 4 4 3-3 6 6']),
  keywords: 'wallpaper background desktop picture colour solid',
  build() {
    const preview = h('div.wallpaper-preview');
    const previewImage = h('div.wallpaper-preview__image');
    const previewName = h('span.wallpaper-preview__name');
    preview.appendChild(previewImage);
    preview.appendChild(h('div.wallpaper-preview__caption', {}, previewName));

    function refresh() {
      const wallpaper = getWallpaper(settings.get('background.id'));
      previewImage.style.background = wallpaper.css;
      previewName.textContent = `${wallpaper.name} · ${
        wallpaper.kind === 'photo' ? 'Photo' : wallpaper.kind === 'solid' ? 'Solid colour' : 'Generated'
      }`;
    }

    const choose = (id) => {
      settings.set('background.id', id);
      refresh();
    };

    const photos = WALLPAPERS.filter((w) => w.kind === 'photo');
    const generated = WALLPAPERS.filter((w) => w.kind === 'gradient');
    const solids = WALLPAPERS.filter((w) => w.kind === 'solid');

    const makeGrid = (items, label, columns) =>
      tileGrid({
        ariaLabel: label,
        class: 'adw-tiles--wallpaper',
        columns,
        value: settings.get('background.id'),
        onChange: choose,
        items: items.map((w) => ({
          id: w.id,
          title: w.name,
          render: () => h('span.wallpaper-thumb', { style: { background: w.css } }),
        })),
      });

    refresh();

    return prefPage(
      { title: 'Background' },
      prefCard({}, preview),
      prefCard(
        {
          title: 'Wallpapers',
          description: 'Photographs are loaded from the network; they fall back to a plain tile when offline.',
        },
        makeGrid(photos, 'Photo wallpapers', 4),
      ),
      prefCard(
        { title: 'Generated', description: 'Drawn locally in CSS, so they always work without a connection.' },
        makeGrid(generated, 'Generated wallpapers', 4),
      ),
      prefCard({ title: 'Colours' }, makeGrid(solids, 'Solid colours', 6)),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Displays
 * ------------------------------------------------------------------ */

export const displaysSection = {
  id: 'displays',
  title: 'Displays',
  icon: icon(['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4']),
  keywords: 'display monitor resolution refresh scale night light rotation',
  build() {
    const scale = tileGrid({
      ariaLabel: 'Scale',
      class: 'adw-tiles--scale',
      columns: 5,
      value: String(settings.get('displays.scale')),
      onChange: (v) => settings.set('displays.scale', Number(v)),
      items: [100, 125, 150, 175, 200].map((value) => ({
        id: String(value),
        render: () => h('span.scale-tile', { text: `${value}%` }),
      })),
    });

    return prefPage(
      { title: 'Displays' },
      prefGroup(
        {},
        comboRow({
          title: 'Display',
          subtitle: 'Built-in display · 13.3″',
          value: 'built-in',
          options: [{ value: 'built-in', label: 'Built-in display' }],
          onChange: () => {},
          keywords: 'display monitor',
        }),
        comboRow({
          title: 'Orientation',
          value: settings.get('displays.orientation'),
          options: [
            { value: 'landscape', label: 'Landscape' },
            { value: 'portrait-right', label: 'Portrait Right' },
            { value: 'portrait-left', label: 'Portrait Left' },
            { value: 'landscape-flipped', label: 'Landscape (flipped)' },
          ],
          onChange: (v) => settings.set('displays.orientation', v),
          keywords: 'rotate orientation portrait landscape',
        }),
        comboRow({
          title: 'Resolution',
          value: settings.get('displays.resolution'),
          options: [
            '1920 × 1080 (16:9)',
            '1680 × 1050 (16:10)',
            '1600 × 900 (16:9)',
            '1440 × 900 (16:10)',
            '1280 × 720 (16:9)',
          ],
          onChange: (v) => settings.set('displays.resolution', v),
          keywords: 'resolution size pixels',
        }),
        comboRow({
          title: 'Refresh Rate',
          value: settings.get('displays.refresh'),
          options: ['60.00 Hz', '59.94 Hz', '50.00 Hz', '48.00 Hz'],
          onChange: (v) => settings.set('displays.refresh', v),
          keywords: 'refresh rate hz',
        }),
      ),
      prefCard({ title: 'Scale' }, scale),
      prefGroup(
        {},
        switchRow({
          title: 'Fractional Scaling',
          subtitle: 'May increase power usage, lower speed, or reduce display sharpness',
          value: settings.get('displays.fractional') === true,
          onChange: (v) => settings.set('displays.fractional', v),
          keywords: 'fractional scaling hidpi',
        }),
      ),
      prefGroup(
        {
          title: 'Night Light',
          description: 'Night Light makes the screen colour warmer, which can help to prevent eye strain and sleeplessness.',
        },
        switchRow({
          title: 'Enable Night Light',
          value: settings.get('displays.nightLight') === true,
          onChange: (v) => settings.set('displays.nightLight', v),
          keywords: 'night light blue warm',
        }),
        comboRow({
          title: 'Schedule',
          value: settings.get('displays.nightLightSchedule'),
          options: [
            { value: 'sunset', label: 'Sunset to Sunrise' },
            { value: 'manual', label: 'Manual Schedule' },
          ],
          onChange: (v) => settings.set('displays.nightLightSchedule', v),
          keywords: 'night light schedule',
        }),
        sliderRow({
          title: 'Colour Temperature',
          value: Number(settings.get('displays.nightLightTemperature')),
          min: 1700,
          max: 4700,
          step: 100,
          format: (v) => `${v} K`,
          onChange: (v) => settings.set('displays.nightLightTemperature', v),
          keywords: 'temperature kelvin warm cool',
        }),
      ),
      prefGroup(
        {},
        buttonRow({
          title: 'Apply Changes',
          subtitle: 'Reverts automatically after 20 seconds if the display does not respond',
          label: 'Apply',
          style: 'suggested',
          onClick: () =>
            notify.show({
              app: 'Settings',
              title: 'Display configuration applied',
              body: `${settings.get('displays.resolution')} at ${settings.get('displays.refresh')}, ${settings.get('displays.scale')}% scale`,
            }),
          keywords: 'apply display',
        }),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

const NOTIFICATION_APPS = [
  { key: 'notifications.apps.files', title: 'Files' },
  { key: 'notifications.apps.firefox', title: 'Firefox Web Browser' },
  { key: 'notifications.apps.terminal', title: 'Terminal' },
  { key: 'notifications.apps.updates', title: 'Software Updater' },
  { key: 'notifications.apps.monitor', title: 'System Monitor' },
];

export const notificationsSection = {
  id: 'notifications',
  title: 'Notifications',
  icon: icon(['M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z', 'M10 19a2 2 0 0 0 4 0']),
  keywords: 'notifications banners do not disturb lock screen',
  build() {
    return prefPage(
      { title: 'Notifications' },
      prefGroup(
        {},
        switchRow({
          title: 'Do Not Disturb',
          subtitle: 'Notifications are collected in the message tray while this is on',
          value: settings.get('notifications.doNotDisturb') === true,
          onChange: (v) => settings.set('notifications.doNotDisturb', v),
          keywords: 'do not disturb silence',
        }),
        switchRow({
          title: 'Lock Screen Notifications',
          value: settings.get('notifications.lockScreen') === true,
          onChange: (v) => settings.set('notifications.lockScreen', v),
          keywords: 'lock screen notifications',
        }),
      ),
      prefGroup(
        { title: 'Applications' },
        ...NOTIFICATION_APPS.map((app) =>
          switchRow({
            title: app.title,
            value: settings.get(app.key) === true,
            onChange: (v) => settings.set(app.key, v),
            keywords: `notifications ${app.title}`,
          }),
        ),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const SEARCH_APPS = [
  { key: 'search.apps.files', title: 'Files', subtitle: 'Search documents, folders and recent files' },
  { key: 'search.apps.settings', title: 'Settings', subtitle: 'Search settings panels' },
  { key: 'search.apps.terminal', title: 'Terminal', subtitle: 'Run a command from the overview' },
  { key: 'search.apps.calculator', title: 'Calculator', subtitle: 'Evaluate expressions inline' },
  { key: 'search.apps.characters', title: 'Characters', subtitle: 'Find unicode characters by name' },
];

export const searchSection = {
  id: 'search',
  title: 'Search',
  icon: icon(['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16 16l4 4']),
  keywords: 'search overview results locations providers',
  build() {
    return prefPage(
      { title: 'Search' },
      prefGroup(
        { description: 'Control which search results are shown in the Activities Overview.' },
        switchRow({
          title: 'Search',
          subtitle: 'Show search results in the Activities Overview',
          value: settings.get('search.enabled') === true,
          onChange: (v) => settings.set('search.enabled', v),
          keywords: 'search enable',
        }),
      ),
      prefGroup(
        { title: 'Search Locations' },
        switchRow({
          title: 'Home',
          subtitle: '/home/ubuntu',
          value: settings.get('search.locations.home') === true,
          onChange: (v) => settings.set('search.locations.home', v),
          keywords: 'search location home',
        }),
        switchRow({
          title: 'Bookmarks',
          subtitle: 'Documents, Downloads, Pictures, Music, Videos',
          value: settings.get('search.locations.bookmarks') === true,
          onChange: (v) => settings.set('search.locations.bookmarks', v),
          keywords: 'search location bookmarks',
        }),
        switchRow({
          title: 'Other Locations',
          subtitle: 'Removable media and network shares',
          value: settings.get('search.locations.external') === true,
          onChange: (v) => settings.set('search.locations.external', v),
          keywords: 'search location other removable',
        }),
      ),
      prefGroup(
        { title: 'Search Results', description: 'Applications are shown in the order listed here.' },
        ...SEARCH_APPS.map((app) =>
          switchRow({
            title: app.title,
            subtitle: app.subtitle,
            value: settings.get(app.key) === true,
            onChange: (v) => settings.set(app.key, v),
            keywords: `search ${app.title}`,
          }),
        ),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Multitasking
 * ------------------------------------------------------------------ */

export const multitaskingSection = {
  id: 'multitasking',
  title: 'Multitasking',
  icon: icon(['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z']),
  keywords: 'workspaces hot corner screen edges window switching multitasking',
  build() {
    const fixedCombo = comboRow({
      title: 'Number of Workspaces',
      value: String(settings.get('multitasking.fixedCount')),
      options: ['1', '2', '3', '4', '5', '6', '8'],
      onChange: (v) => settings.set('multitasking.fixedCount', Number(v)),
      keywords: 'workspaces fixed number',
      disabled: settings.get('multitasking.workspaces') !== 'fixed',
    });

    const workspaceRows = radioRows({
      value: settings.get('multitasking.workspaces'),
      onChange: (v) => {
        settings.set('multitasking.workspaces', v);
        const select = fixedCombo.querySelector('.adw-combo');
        if (select) select.disabled = v !== 'fixed';
      },
      keywords: 'workspaces dynamic fixed',
      options: [
        { value: 'dynamic', title: 'Dynamic Workspaces', subtitle: 'Automatically removes empty workspaces' },
        { value: 'fixed', title: 'Fixed Number of Workspaces', subtitle: 'Specify a number of permanent workspaces' },
      ],
    });

    return prefPage(
      { title: 'Multitasking' },
      prefGroup(
        { title: 'General' },
        switchRow({
          title: 'Hot Corner',
          subtitle: 'Touch the top-left corner to open the Activities Overview',
          value: settings.get('multitasking.hotCorner') === true,
          onChange: (v) => settings.set('multitasking.hotCorner', v),
          keywords: 'hot corner activities',
        }),
        switchRow({
          title: 'Active Screen Edges',
          subtitle: 'Drag windows against the top, left and right screen edges to resize them',
          value: settings.get('multitasking.activeEdges') === true,
          onChange: (v) => settings.set('multitasking.activeEdges', v),
          keywords: 'screen edges tiling snap',
        }),
      ),
      prefGroup({ title: 'Workspaces' }, ...workspaceRows, fixedCombo),
      prefGroup(
        { title: 'Multi-Monitor' },
        ...radioRows({
          value: settings.get('multitasking.allDisplays') ? 'all' : 'primary',
          onChange: (v) => settings.set('multitasking.allDisplays', v === 'all'),
          keywords: 'multi monitor workspaces displays',
          options: [
            { value: 'all', title: 'Workspaces on all Displays' },
            { value: 'primary', title: 'Workspaces on Primary Display Only' },
          ],
        }),
      ),
      prefGroup(
        { title: 'Application Switching' },
        ...radioRows({
          value: settings.get('multitasking.switcherScope'),
          onChange: (v) => settings.set('multitasking.switcherScope', v),
          keywords: 'alt tab switcher workspaces',
          options: [
            { value: 'all', title: 'Include Applications from all Workspaces' },
            { value: 'current', title: 'Include Applications from Current Workspace Only' },
          ],
        }),
      ),
    );
  },
};
