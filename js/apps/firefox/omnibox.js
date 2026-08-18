/**
 * js/apps/firefox/omnibox.js — the unified address bar's drop-down.
 *
 * Firefox's "awesomebar": the typed text is offered as a page to visit and as a
 * search, then matching bookmarks and history are listed underneath. What the
 * search row says depends on the browsing mode, and in Live web mode a YouTube
 * shortcut (the word "youtube", or a bare video id) is offered first.
 *
 * Split out of `index.js`, which owns the actual navigation; this module only
 * builds rows and tracks which one is selected. Every value shown — typed text,
 * page titles, URLs — goes through `h({ text })`.
 */

import { h, clear } from '../../core/dom.js';
import { fxIcon, prettyUrl } from './pages.js';
import { classifyInput, getPrefs, getBookmarks, getHistory } from './data.js';
import { resolveLiveInput } from './live.js';

/** Hard caps so the list never grows past a sensible drop-down. */
const MAX_WITH_BOOKMARKS = 8;
const MAX_ROWS = 11;

/**
 * @param {object} deps
 * @param {HTMLInputElement} deps.urlInput the address field
 * @param {HTMLElement} deps.urlbar the field's container (gets `has-ac`)
 * @param {HTMLElement} deps.list the drop-down element
 * @param {() => boolean} deps.isLive current browsing mode
 * @param {(query: string) => string} deps.searchAddress results-page URL builder
 * @param {(url: string) => void} deps.navigate load an exact address
 * @param {(text: string) => void} deps.openAddress classify then load
 * @returns {{open: () => void, close: () => void, move: (delta: number) => void,
 *            commit: () => void, isOpen: () => boolean}}
 */
export function createOmnibox(deps) {
  const { urlInput, urlbar, list, isLive, searchAddress, navigate, openAddress } = deps;

  /** @type {HTMLElement[]} */
  let rows = [];
  let index = -1;

  function select(next) {
    index = next;
    rows.forEach((row, i) => {
      const selected = i === next;
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  function close() {
    list.hidden = true;
    urlbar.classList.remove('has-ac');
    rows = [];
    index = -1;
  }

  function buildRow({ icon, primary, secondary, action, kind }) {
    const row = h(
      'button.fx-ac-row',
      { type: 'button', role: 'option', 'aria-selected': 'false', dataset: { kind } },
      icon,
      h('span.fx-ac-primary', { text: primary }),
      secondary ? h('span.fx-ac-sep', { text: '—' }) : null,
      secondary ? h('span.fx-ac-secondary', { text: secondary }) : null
    );
    row.acAction = action;
    row.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      close();
      action();
    });
    row.addEventListener('mouseenter', () => select(rows.indexOf(row)));
    return row;
  }

  /** Bookmarks first, then history, skipping anything already listed. */
  function suggestionRows(text, taken) {
    const out = [];
    const needle = text.toLowerCase();
    const seen = new Set();
    const matches = (entry) =>
      !seen.has(entry.url) &&
      (String(entry.title).toLowerCase().includes(needle) || String(entry.url).toLowerCase().includes(needle));

    for (const mark of getBookmarks()) {
      if (taken + out.length >= MAX_WITH_BOOKMARKS) break;
      if (!matches(mark)) continue;
      seen.add(mark.url);
      out.push(
        buildRow({
          kind: 'bookmark',
          icon: fxIcon('star', 16, { class: 'fx-ac-icon', filled: true }),
          primary: mark.title,
          secondary: prettyUrl(mark.url),
          action: () => navigate(mark.url),
        })
      );
    }
    for (const entry of getHistory()) {
      if (taken + out.length >= MAX_ROWS) break;
      if (!matches(entry)) continue;
      seen.add(entry.url);
      out.push(
        buildRow({
          kind: 'history',
          icon: fxIcon('clock', 16, { class: 'fx-ac-icon' }),
          primary: entry.title,
          secondary: prettyUrl(entry.url),
          action: () => navigate(entry.url),
        })
      );
    }
    return out;
  }

  function open() {
    const text = urlInput.value.trim();
    clear(list);
    rows = [];
    index = -1;
    if (text === '') {
      close();
      return;
    }

    const live = isLive();
    const verdict = classifyInput(text);
    const shortcut = live ? resolveLiveInput(text) : '';
    const built = [];

    if (shortcut !== '') {
      built.push(
        buildRow({
          kind: 'visit',
          icon: fxIcon('play', 16, { class: 'fx-ac-icon' }),
          primary: shortcut,
          secondary: 'Play on YouTube',
          action: () => navigate(shortcut),
        })
      );
    }
    if (verdict.kind === 'url') {
      built.push(
        buildRow({
          kind: 'visit',
          icon: fxIcon('globe', 16, { class: 'fx-ac-icon' }),
          primary: verdict.url,
          secondary: live ? 'Visit — real page' : 'Visit',
          action: () => navigate(verdict.url),
        })
      );
    }
    built.push(
      buildRow({
        kind: 'search',
        icon: fxIcon('search', 16, { class: 'fx-ac-icon' }),
        primary: text,
        secondary: live ? 'Search DuckDuckGo and Wikipedia' : 'Search with Gemini',
        action: () => navigate(searchAddress(text)),
      })
    );

    if (getPrefs().acSuggest) built.push(...suggestionRows(text, built.length));

    for (const row of built) list.appendChild(row);
    rows = built;
    list.hidden = built.length === 0;
    urlbar.classList.toggle('has-ac', !list.hidden);
    select(-1);
  }

  return {
    open,
    close,
    isOpen: () => !list.hidden,

    /** @param {number} delta wraps around at both ends, like Firefox */
    move(delta) {
      if (rows.length === 0) return;
      const next = index + delta;
      select(next < 0 ? rows.length - 1 : next >= rows.length ? 0 : next);
    },

    /** Enter: run the highlighted row, or treat the raw text as an address. */
    commit() {
      const selected = index >= 0 ? rows[index] : null;
      if (selected && typeof selected.acAction === 'function') {
        const action = selected.acAction;
        close();
        urlInput.blur();
        action();
        return;
      }
      const text = urlInput.value.trim();
      close();
      if (text === '') return;
      urlInput.blur();
      openAddress(text);
    },
  };
}
