/**
 * js/apps/files/headerbar.js — the Nautilus header bar.
 *
 * Back / forward / up, the clickable breadcrumb path bar with its Ctrl+L
 * type-a-path entry, the search entry, and the view / sort / primary-menu
 * buttons. It owns no filesystem knowledge: the controller feeds it crumb
 * segments and receives callbacks.
 */

import { h, clear } from '../../core/dom.js';
import { symbolic } from './icons.js';

/**
 * @param {{
 *   mode?: 'grid'|'list',
 *   onBack?: () => void,
 *   onForward?: () => void,
 *   onUp?: () => void,
 *   onCrumb?: (path: string) => void,
 *   onPathSubmit?: (text: string) => void,
 *   onPathCancel?: () => void,
 *   onSearchToggle?: () => void,
 *   onSearchInput?: (text: string) => void,
 *   onSearchCancel?: () => void,
 *   onSearchDown?: () => void,
 *   onToggleView?: () => void,
 *   onSortMenu?: (anchor: HTMLElement) => void,
 *   onMainMenu?: (anchor: HTMLElement) => void,
 * }} opts
 * @returns {object} the header bar handle
 */
export function createHeaderBar(opts = {}) {
  const call = (name, ...args) => {
    const fn = opts[name];
    if (typeof fn === 'function') fn(...args);
  };

  function iconButton(iconName, label, handler) {
    const button = h('button.files-btn', { type: 'button', title: label, 'aria-label': label });
    button.appendChild(symbolic(iconName, 16));
    button.addEventListener('click', () => handler(button));
    return button;
  }

  const backButton = iconButton('back', 'Back', () => call('onBack'));
  const forwardButton = iconButton('forward', 'Forward', () => call('onForward'));
  const upButton = iconButton('up', 'Parent Folder', () => call('onUp'));

  const crumbBar = h('div.files-crumbs', { role: 'navigation', 'aria-label': 'Location' });
  const pathEntry = h('input.files-pathentry', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Location',
    hidden: true,
  });
  const searchEntry = h('input.files-searchentry', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'Search',
    'aria-label': 'Search',
  });
  const searchBox = h('div.files-searchbox', { hidden: true }, symbolic('search', 16), searchEntry);

  const searchButton = iconButton('search', 'Search', () => call('onSearchToggle'));
  const viewButton = iconButton(opts.mode === 'list' ? 'grid' : 'list', 'Toggle View', () => call('onToggleView'));
  const sortButton = iconButton('sort', 'Sort and View Options', (button) => call('onSortMenu', button));
  const menuButton = iconButton('menu', 'Main Menu', (button) => call('onMainMenu', button));

  const element = h(
    'div.files-headerbar',
    {},
    h('div.files-headerbar__nav', {}, backButton, forwardButton, upButton),
    h('div.files-bar', {}, crumbBar, pathEntry, searchBox),
    h('div.files-headerbar__end', {}, searchButton, viewButton, sortButton, menuButton),
  );

  let barMode = 'crumbs';

  pathEntry.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      call('onPathCancel');
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const typed = pathEntry.value.trim();
      if (typed !== '') call('onPathSubmit', typed);
    }
  });
  pathEntry.addEventListener('blur', () => {
    if (barMode === 'path') call('onPathCancel');
  });

  searchEntry.addEventListener('input', () => call('onSearchInput', searchEntry.value));
  searchEntry.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      call('onSearchCancel');
    } else if (ev.key === 'ArrowDown' || ev.key === 'Enter') {
      ev.preventDefault();
      call('onSearchDown');
    }
  });

  return {
    /** @type {HTMLElement} */
    element,

    /**
     * Rebuild the breadcrumb row.
     * @param {{label:string, path:string, icon?:string}[]} segments
     */
    setCrumbs(segments) {
      clear(crumbBar);
      segments.forEach((segment, i) => {
        const button = h('button.files-crumb', { type: 'button' });
        if (segment.icon) button.appendChild(symbolic(segment.icon, 15));
        button.appendChild(h('span', { text: segment.label }));
        if (i === segments.length - 1) button.classList.add('is-current');
        button.addEventListener('click', () => call('onCrumb', segment.path));
        crumbBar.appendChild(button);
        if (i < segments.length - 1) crumbBar.appendChild(h('span.files-crumb__sep', { text: '›' }));
      });
      crumbBar.scrollLeft = crumbBar.scrollWidth;
    },

    /**
     * Switch between the breadcrumbs, the path entry (Ctrl+L) and search.
     * @param {'crumbs'|'path'|'search'} mode
     * @param {string} [pathValue] prefilled text for the path entry
     */
    setBarMode(mode, pathValue = '') {
      barMode = mode;
      crumbBar.hidden = mode !== 'crumbs';
      pathEntry.hidden = mode !== 'path';
      searchBox.hidden = mode !== 'search';
      searchButton.classList.toggle('is-active', mode === 'search');
      if (mode === 'path') {
        pathEntry.value = pathValue;
        pathEntry.focus();
        pathEntry.setSelectionRange(pathEntry.value.length, pathEntry.value.length);
      } else if (mode === 'search') {
        searchEntry.focus();
      } else {
        searchEntry.value = '';
      }
    },

    /** @returns {'crumbs'|'path'|'search'} */
    barMode() {
      return barMode;
    },

    /** @param {{back:boolean, forward:boolean, up:boolean}} enabled */
    setNavState({ back, forward, up }) {
      backButton.disabled = !back;
      forwardButton.disabled = !forward;
      upButton.disabled = !up;
    },

    /** @param {'grid'|'list'} mode the mode currently displayed */
    setViewIcon(mode) {
      clear(viewButton);
      viewButton.appendChild(symbolic(mode === 'grid' ? 'list' : 'grid', 16));
      viewButton.title = mode === 'grid' ? 'List View' : 'Grid View';
      viewButton.setAttribute('aria-label', viewButton.title);
    },

    /** @param {string} text */
    setSearchValue(text) {
      searchEntry.value = text;
    },

    /** @returns {string} */
    searchValue() {
      return searchEntry.value;
    },

    focusSearch() {
      searchEntry.focus();
    },
  };
}
