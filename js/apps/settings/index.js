/**
 * js/apps/settings/index.js — GNOME Settings (ARCHITECTURE §16, §18).
 *
 * A sidebar of panels with a search entry on the left and the active
 * preference page on the right. `wm.open('settings', { section: 'ai' })`
 * deep-links straight to a panel; `resolveSection` also accepts aliases such
 * as `apikey`, `wallpaper` or `shortcuts`.
 */

import { h, clear, svg } from '../../core/dom.js';
import { bus } from '../../core/bus.js';
import { applySettings } from './state.js';
import { SECTIONS, getSection, resolveSection, searchSections } from './sections.js';

/** @type {Map<string, {teardown: Array<() => void>}>} */
const instances = new Map();

function settingsIcon() {
  return svg(
    [
      'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
      'M19.3 13.1a7.4 7.4 0 0 0 0-2.2l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-1.9-1.1L14.8 3H9.2l-.4 2.9c-.7.3-1.3.6-1.9 1.1l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.2l-2 1.5 2 3.4 2.3-1c.6.5 1.2.8 1.9 1.1l.4 2.9h5.6l.4-2.9c.7-.3 1.3-.6 1.9-1.1l2.3 1 2-3.4z',
    ],
    { size: 24, strokeWidth: 1.6, class: 'app-icon app-icon--settings' },
  );
}

export default {
  id: 'settings',
  name: 'Settings',
  genericName: 'Preferences',
  icon: settingsIcon,
  pinned: true,
  singleton: true,
  width: 960,
  height: 680,
  minWidth: 560,
  minHeight: 420,
  resizable: true,
  themeClass: 'app-settings',
  darkChrome: false,

  /**
   * @param {HTMLElement} root
   * @param {{instanceId:string, args:object, setTitle:(t:string)=>void}} ctx
   */
  mount(root, ctx) {
    clear(root);
    // The panels write straight to :root, so make sure what is on screen and
    // what is stored agree the moment the app opens.
    applySettings();

    let activeId = '';

    /* --- sidebar ------------------------------------------------- */

    const searchInput = h('input.set-search__input', {
      type: 'search',
      placeholder: 'Search settings',
      'aria-label': 'Search settings',
    });
    const searchBox = h(
      'div.set-search',
      {},
      h('span.set-search__icon', { 'aria-hidden': 'true', text: '⌕' }),
      searchInput,
    );

    const navList = h('nav.set-nav', { 'aria-label': 'Settings sections' });
    const navButtons = new Map();
    const navGroups = new Map();
    const emptyState = h('p.set-nav__empty', { text: 'No results found', hidden: true });

    for (const section of SECTIONS) {
      if (section.group) {
        const heading = h('h2.set-nav__group', { text: section.group });
        navGroups.set(section.id, heading);
        navList.appendChild(heading);
      }
      const button = h('button.set-nav__item', {
        type: 'button',
        'aria-current': 'false',
        dataset: { section: section.id },
      });
      button.appendChild(h('span.set-nav__icon', {}, section.icon()));
      button.appendChild(h('span.set-nav__label', { text: section.title }));
      button.addEventListener('click', () => navigate(section.id));
      navButtons.set(section.id, button);
      navList.appendChild(button);
    }
    navList.appendChild(emptyState);

    const sidebar = h('div.set-sidebar', {}, searchBox, h('div.set-nav__scroll', {}, navList));

    /* --- content ------------------------------------------------- */

    const content = h('div.set-content', { role: 'region', 'aria-live': 'polite' });
    const shell = h('div.settings', {}, sidebar, content);
    root.appendChild(shell);

    /* --- routing -------------------------------------------------- */

    function navigate(id) {
      const section = getSection(id);
      if (!section) return;
      activeId = section.id;

      for (const [key, button] of navButtons) {
        const active = key === activeId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-current', active ? 'page' : 'false');
      }

      clear(content);
      content.appendChild(section.build());
      content.scrollTop = 0;

      if (typeof ctx.setTitle === 'function') ctx.setTitle(section.title);
    }

    function applyFilter() {
      const matches = new Set(searchSections(searchInput.value));
      let visible = 0;

      for (const section of SECTIONS) {
        const button = navButtons.get(section.id);
        const shown = matches.has(section.id);
        button.hidden = !shown;
        if (shown) visible += 1;
      }

      // A group heading is only useful while at least one of its rows shows.
      let currentHeading = null;
      let headingHasVisible = false;
      for (const section of SECTIONS) {
        if (navGroups.has(section.id)) {
          if (currentHeading) currentHeading.hidden = !headingHasVisible;
          currentHeading = navGroups.get(section.id);
          headingHasVisible = false;
        }
        if (matches.has(section.id)) headingHasVisible = true;
      }
      if (currentHeading) currentHeading.hidden = !headingHasVisible;

      emptyState.hidden = visible > 0;
    }

    searchInput.addEventListener('input', applyFilter);
    searchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        searchInput.value = '';
        applyFilter();
        return;
      }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const first = SECTIONS.find((section) => !navButtons.get(section.id).hidden);
      if (first) navigate(first.id);
    });

    /* --- external changes ------------------------------------------ */

    // Rebuild the visible panel when a setting is changed from elsewhere (the
    // system menu's dark-style toggle, the dock's context menu, a script).
    let rebuildTimer = 0;
    const offSettings = bus.on('settings:change', (payload) => {
      if (!payload || !shell.isConnected) return;
      if (rebuildTimer) return;
      rebuildTimer = window.setTimeout(() => {
        rebuildTimer = 0;
        const key = String(payload.key || '');
        // Only re-render for changes this panel does not already reflect.
        if (key === 'appearance.style' || key === 'appearance.accent' || key === '*') {
          const scroll = content.scrollTop;
          navigate(activeId);
          content.scrollTop = scroll;
        }
      }, 60);
    });

    instances.set(ctx.instanceId, {
      teardown: [
        offSettings,
        () => {
          if (rebuildTimer) window.clearTimeout(rebuildTimer);
        },
      ],
    });

    const requested = ctx.args && typeof ctx.args.section === 'string' ? ctx.args.section : '';
    navigate(resolveSection(requested));
    applyFilter();
  },

  /**
   * Re-entering an already-open Settings window with new args re-routes it.
   * @param {{instanceId:string, args:object, win:HTMLElement}} ctx
   */
  onFocus(ctx) {
    const requested = ctx.args && typeof ctx.args.section === 'string' ? ctx.args.section : '';
    if (requested === '' || !ctx.win) return;
    const target = resolveSection(requested);
    const button = ctx.win.querySelector(`.set-nav__item[data-section="${target}"]`);
    if (button instanceof HTMLElement && !button.classList.contains('is-active')) button.click();
  },

  onClose(ctx) {
    const record = instances.get(ctx.instanceId);
    if (record) {
      for (const off of record.teardown) off();
      instances.delete(ctx.instanceId);
    }
    return true;
  },
};

export { settings, applySettings } from './state.js';
export { SECTIONS, getSection, resolveSection } from './sections.js';
