/**
 * js/apps/firefox/menu.js — the hamburger (application) menu.
 *
 * Firefox's own menu, plus the two entries this browser needs: the browsing
 * mode radio pair, and the escape hatches that matter once pages are real —
 * opening the current address in a genuine browser tab and copying its link.
 *
 * The menu re-reads the browser's state every time it opens, so Reader View is
 * disabled on pages this app did not render itself (a cross-origin frame cannot
 * be restyled, and pretending otherwise would be a lie), and the mode radio
 * shows which mode is actually active.
 */

import { h } from '../../core/dom.js';
import { dialog } from '../../core/dialog.js';
import { wm } from '../../shell/window-manager.js';
import { PREFS_URL, HISTORY_URL, BOOKMARKS_URL, NEWTAB_URL, MODE_LIVE, MODE_AI } from './pages.js';
import { openAiSettings } from './content.js';
import { openExternal, copyText } from './live.js';

/**
 * Build the menu into `popup` and wire the button that opens it.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.popup the (hidden) popup element
 * @param {HTMLElement} deps.button the toolbar button that toggles it
 * @param {() => object|null} deps.activeTab
 * @param {() => boolean} deps.isLive
 * @param {object} deps.actions `{ newTab, openAddress, applyMode, toggleReader, close, closeAutocomplete }`
 * @returns {{toggle: (ev?: Event) => void, close: () => void, isOpen: () => boolean,
 *            showExtensions: () => void}}
 */
export function createMenu(deps) {
  const { popup, button, activeTab, isLive, actions } = deps;

  /** @type {Map<string, HTMLButtonElement>} */
  const items = new Map();

  function close() {
    popup.hidden = true;
    button.classList.remove('is-open');
  }

  function showExtensions() {
    close();
    dialog.alert({
      title: 'Add-ons and Themes',
      body:
        'No extensions are installed in this Firefox. Add-ons are downloaded and installed by the real browser, ' +
        'which this emulator cannot do from inside a web page.',
      okLabel: 'Close',
    });
  }

  /** The current address, but only when it is a real web page. */
  function webUrl() {
    const tab = activeTab();
    return tab && /^https?:\/\//i.test(tab.url) ? tab.url : '';
  }

  const definition = [
    { id: 'newtab', label: 'New Tab', accel: 'Ctrl+T', run: () => actions.newTab() },
    { id: 'newwin', label: 'New Window', accel: 'Ctrl+N', run: () => wm.open('firefox') },
    { separator: true },
    { id: 'mode-live', label: 'Live web (real network)', role: 'menuitemradio', run: () => actions.applyMode(MODE_LIVE) },
    { id: 'mode-ai', label: 'AI simulation (Gemini)', role: 'menuitemradio', run: () => actions.applyMode(MODE_AI) },
    { separator: true },
    {
      id: 'external',
      label: 'Open in a real browser tab',
      run: () => {
        const url = webUrl();
        if (url !== '') openExternal(url);
      },
    },
    {
      id: 'copylink',
      label: 'Copy Link',
      run: () => {
        const tab = activeTab();
        if (tab && tab.url && tab.url !== NEWTAB_URL) copyText(tab.url);
      },
    },
    { separator: true },
    { id: 'bookmarks', label: 'Bookmarks', accel: 'Ctrl+B', run: () => actions.openAddress(BOOKMARKS_URL) },
    { id: 'history', label: 'History', accel: 'Ctrl+H', run: () => actions.openAddress(HISTORY_URL) },
    { id: 'downloads', label: 'Downloads', accel: 'Ctrl+J', disabled: true },
    { separator: true },
    { id: 'reader', label: 'Toggle Reader View', accel: 'Ctrl+Alt+R', run: () => actions.toggleReader() },
    { id: 'zoom', label: 'Zoom', accel: '100%', disabled: true },
    { id: 'print', label: 'Print…', accel: 'Ctrl+P', disabled: true },
    { separator: true },
    { id: 'addons', label: 'Add-ons and Themes', accel: 'Ctrl+Shift+A', run: () => showExtensions() },
    { id: 'prefs', label: 'Settings', run: () => actions.openAddress(PREFS_URL) },
    { id: 'aikey', label: 'AI Configuration…', run: () => openAiSettings() },
    { separator: true },
    { id: 'quit', label: 'Quit', accel: 'Ctrl+Q', run: () => actions.close() },
  ];

  for (const item of definition) {
    if (item.separator) {
      popup.appendChild(h('div.fx-menu-sep', { role: 'separator' }));
      continue;
    }
    const node = h(
      'button.fx-menu-item',
      {
        type: 'button',
        role: item.role || 'menuitem',
        disabled: item.disabled === true,
        on: {
          click: () => {
            close();
            if (item.run) item.run();
          },
        },
      },
      h('span.fx-menu-label', { text: item.label }),
      item.accel ? h('span.fx-menu-accel', { text: item.accel }) : null
    );
    items.set(item.id, node);
    popup.appendChild(node);
  }

  /** Re-read the browser's state; called every time the menu opens. */
  function sync() {
    const tab = activeTab();
    const live = isLive();

    for (const [id, checked] of [
      ['mode-live', live],
      ['mode-ai', !live],
    ]) {
      const node = items.get(id);
      if (!node) continue;
      node.classList.toggle('is-checked', checked);
      node.setAttribute('aria-checked', checked ? 'true' : 'false');
    }

    const reader = items.get('reader');
    if (reader) {
      reader.disabled = !tab || !tab.canReader;
      reader.title = tab && tab.canReader ? '' : 'Reader View can only restyle a page this browser rendered itself.';
    }
    const external = items.get('external');
    if (external) external.disabled = webUrl() === '';
    const copy = items.get('copylink');
    if (copy) copy.disabled = !tab || tab.url === '' || tab.url === NEWTAB_URL;
  }

  return {
    close,
    showExtensions,
    isOpen: () => !popup.hidden,

    /** @param {Event} [ev] */
    toggle(ev) {
      if (ev) ev.stopPropagation();
      if (!popup.hidden) {
        close();
        return;
      }
      actions.closeAutocomplete();
      sync();
      popup.hidden = false;
      button.classList.add('is-open');
    },
  };
}
