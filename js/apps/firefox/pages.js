/**
 * js/apps/firefox/pages.js — built-in local pages for Firefox
 * (ARCHITECTURE §18).
 *
 * This module holds the browser's vocabulary — URL helpers, the security
 * indicator report, icons, favicon chips — plus the pages that are neither a
 * library page nor loaded from anywhere:
 *
 *   about:home / about:newtab   Ubuntu Start page (Live web or AI variant)
 *   about:blank                 empty document
 *   the network error page      Firefox `about:neterror` layout
 *
 * The library pages (about:preferences, about:history, about:bookmarks,
 * about:about) and the local-page dispatcher live in `pages-library.js`.
 * Real page loading lives in `live.js`; AI-generated pages in `content.js`.
 *
 * Every value that originates outside this file — URLs, page titles, typed
 * queries — is inserted through `h({ text })`, i.e. `textContent`. `innerHTML`
 * is never used anywhere in this module.
 *
 * Page builders receive a `browser` object supplied by `index.js`:
 *
 * ```js
 * {
 *   navigate(url), search(query), reload(), newTab(url),
 *   history(), bookmarks(), forgetHistory(url), removeBookmark(url),
 *   clearHistory(), clearBookmarks(),          // -> Promise<boolean>
 *   prefs(), setPref(key, value),
 *   mode(), setMode(mode),
 *   openAiSettings(), openExternal(url),
 * }
 * ```
 */

import { h, svg } from '../../core/dom.js';

/* --------------------------------------------------------------- URLs --- */

export const HOME_URL = 'about:home';
export const NEWTAB_URL = 'about:newtab';
export const BLANK_URL = 'about:blank';
export const PREFS_URL = 'about:preferences';
export const HISTORY_URL = 'about:history';
export const BOOKMARKS_URL = 'about:bookmarks';
export const ABOUT_URL = 'about:about';

/** Internal scheme used for the Gemini results page: `gemini:search?q=…`. */
export const SEARCH_PREFIX = 'gemini:search?q=';

/** Internal scheme used for the real (DuckDuckGo + Wikipedia) results page. */
export const LIVE_SEARCH_PREFIX = 'web:search?q=';

/** The two browsing modes. `live` really loads the web; `ai` writes pages. */
export const MODE_LIVE = 'live';
export const MODE_AI = 'ai';

/** Tiles on the Ubuntu Start page in AI simulation mode. */
export const SHORTCUTS = Object.freeze([
  { label: 'Ubuntu', url: 'https://ubuntu.com/', letter: 'U' },
  { label: 'Ask Ubuntu', url: 'https://askubuntu.com/', letter: 'A' },
  { label: 'Launchpad', url: 'https://launchpad.net/', letter: 'L' },
  { label: 'GitHub', url: 'https://github.com/', letter: 'G' },
  { label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page', letter: 'W' },
]);

/**
 * Tiles on the Ubuntu Start page in Live web mode. Every entry except YouTube
 * was checked against its real response headers while this file was written
 * and sends neither `X-Frame-Options` nor a `frame-ancestors` directive, so
 * clicking one loads the genuine page inside the browser. YouTube is handled
 * by the app's own player page, which embeds the site's privacy-enhanced
 * player — that one really does play.
 *
 * Sites people expect to see here but which refuse framing (MDN, ubuntu.com,
 * OpenStreetMap, GitHub, Stack Exchange…) are deliberately absent: they would
 * only ever produce the interstitial.
 */
export const LIVE_SHORTCUTS = Object.freeze([
  { label: 'YouTube', url: 'https://www.youtube.com/', letter: 'Y' },
  { label: 'Wikipedia', url: 'https://www.wikipedia.org/', letter: 'W' },
  { label: 'Internet Archive', url: 'https://archive.org/', letter: 'A' },
  { label: 'Linux man pages', url: 'https://man7.org/linux/man-pages/', letter: 'M' },
  { label: 'Project Gutenberg', url: 'https://www.gutenberg.org/', letter: 'G' },
  { label: 'xkcd', url: 'https://xkcd.com/', letter: 'X' },
  { label: 'example.com', url: 'https://example.com/', letter: 'E' },
]);

/** Firefox preferences backed by `store` (see `index.js`). */
export const DEFAULT_PREFS = Object.freeze({
  mode: MODE_LIVE,
  homepage: HOME_URL,
  customHome: '',
  restoreSession: true,
  warnOnQuit: true,
  acSuggest: true,
  readerFontSize: 18,
  readerTheme: 'light',
});

/** Version string shown on the start page — Ubuntu 24.04 LTS ships the snap. */
export const UA_LABEL = 'Firefox 128.0 (64-bit) · Ubuntu 24.04.1 LTS';

/* -------------------------------------------------------------- icons --- */

const ICONS = {
  back: ['M19.5 12H5.2', 'M11.5 5.2 4.7 12l6.8 6.8'],
  forward: ['M4.5 12h14.3', 'M12.5 5.2 19.3 12l-6.8 6.8'],
  reload: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v5.4h-5.4'],
  stop: ['M6.5 6.5h11v11h-11z'],
  home: ['M3.4 11.9 12 4.3l8.6 7.6', 'M6 10.6v9h12v-9', 'M10.4 19.6v-4.4h3.2v4.4'],
  shield: ['M12 3.2 5 6.1v5.6c0 4.3 2.9 8.2 7 9.5 4.1-1.3 7-5.2 7-9.5V6.1z'],
  lock: ['M5.8 10.4h12.4v9.4H5.8z', 'M8.6 10.4V7.7a3.4 3.4 0 0 1 6.8 0v2.7'],
  star: ['m12 3.7 2.6 5.3 5.8.9-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.9z'],
  plus: ['M12 5.2v13.6', 'M5.2 12h13.6'],
  close: ['m6.4 6.4 11.2 11.2', 'M17.6 6.4 6.4 17.6'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  puzzle: [
    'M9.6 4.6a1.9 1.9 0 0 1 3.8 0V6h3.5a1 1 0 0 1 1 1v3.5h1.4a1.9 1.9 0 0 1 0 3.8h-1.4V17a1 1 0 0 1-1 1h-3.5v-1.4a1.9 1.9 0 1 0-3.8 0V18H6.1a1 1 0 0 1-1-1v-3.5h1.4a1.9 1.9 0 1 0 0-3.8H5.1V7a1 1 0 0 1 1-1h3.5z',
  ],
  reader: ['M6.2 3.8h11.6v16.4H6.2z', 'M9 8.2h6', 'M9 12h6', 'M9 15.8h3.6'],
  search: ['M11 4.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6z', 'M15.9 15.9 20.4 20.4'],
  clock: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 7.6V12l3 1.9'],
  trash: ['M5 7h14', 'M9.4 7V4.8h5.2V7', 'm6.9 7 .9 12.2h8.4L17.1 7'],
  info: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 11.2v5', 'M12 7.9h.01'],
  gear: [
    'M19.3 13.1a7.6 7.6 0 0 0 0-2.2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.9-1.1L14.8 3.3h-4l-.3 2.6a7.6 7.6 0 0 0-1.9 1.1l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2.2l-2 1.5 2 3.4 2.3-1c.6.5 1.2.9 1.9 1.1l.3 2.6h4l.3-2.6c.7-.2 1.3-.6 1.9-1.1l2.3 1 2-3.4z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  ],
  globe: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M4.3 12h15.4', 'M12 4c2.1 2.2 3.2 5 3.2 8s-1.1 5.8-3.2 8c-2.1-2.2-3.2-5-3.2-8S9.9 6.2 12 4z'],
  warning: ['M12 4.4 2.8 20h18.4z', 'M12 10.2v4.4', 'M12 17.4h.01'],
  key: ['M14.6 4.6a4.9 4.9 0 1 0-3.2 8.5L4.4 20v0h3.2v-2.4H10v-2.4h2.2l1.2-1.2a4.9 4.9 0 0 0 1.2-9.4z', 'M16.4 8.1h.01'],
  play: ['M8.4 5.6 18.2 12l-9.8 6.4z'],
  external: ['M14.2 4.4h5.4v5.4', 'M19.6 4.4 11 13', 'M17.6 13.6v5a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1V7.4a1 1 0 0 1 1-1h5'],
  copy: ['M9.2 9.2h9.2v9.2H9.2z', 'M14.8 9.2V5.6H5.6v9.2h3.6'],
  frame: ['M3.8 5.2h16.4v13.6H3.8z', 'M3.8 9.4h16.4', 'M6.6 7.3h.01', 'M9 7.3h.01'],
  sparkle: ['M12 4.2 13.6 9l4.8 1.6-4.8 1.6L12 17l-1.6-4.8L5.6 10.6 10.4 9z', 'M18.4 15.4l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z'],
  broken: ['M12 3.2 5 6.1v5.6c0 4.3 2.9 8.2 7 9.5 4.1-1.3 7-5.2 7-9.5V6.1z', 'm9.4 9.4 5.2 5.2', 'm14.6 9.4-5.2 5.2'],
};

/**
 * Build one of the browser's symbolic icons.
 * @param {string} name key of ICONS
 * @param {number} [size] pixel size
 * @param {object} [opts] forwarded to `svg()`; `class` is merged
 * @returns {SVGElement}
 */
export function fxIcon(name, size = 16, opts = {}) {
  const paths = ICONS[name] || ICONS.globe;
  const merged = {
    strokeWidth: 1.7,
    ...opts,
    size,
    class: `fx-icon fx-icon-${name}${opts.class ? ` ${opts.class}` : ''}`,
  };
  return svg(paths, merged);
}

/* ------------------------------------------------------- url helpers ---- */

/**
 * Host portion of a URL, lower-cased and without credentials.
 * @param {string} url
 * @returns {string} '' for `about:` and `gemini:` URLs
 */
export function hostOf(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  if (raw === '' || /^(about|gemini|web|data|javascript):/i.test(raw)) return '';
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw);
  const authority = match ? match[1] : raw.split(/[/?#]/)[0];
  return authority.replace(/^[^@]*@/, '').toLowerCase();
}

/**
 * Display form of a URL: scheme and a lone trailing slash removed.
 * @param {string} url
 * @returns {string}
 */
export function prettyUrl(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  if (raw.startsWith('about:')) return raw;
  if (raw.startsWith(SEARCH_PREFIX)) return `Gemini search — ${decodeQuery(raw)}`;
  if (raw.startsWith(LIVE_SEARCH_PREFIX)) return `Web search — ${decodeQuery(raw)}`;
  return raw.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * Query string carried by a `gemini:search?q=…` or `web:search?q=…` URL.
 * @param {string} url
 * @returns {string}
 */
export function decodeQuery(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  let prefix = '';
  if (raw.startsWith(SEARCH_PREFIX)) prefix = SEARCH_PREFIX;
  else if (raw.startsWith(LIVE_SEARCH_PREFIX)) prefix = LIVE_SEARCH_PREFIX;
  else return '';
  try {
    return decodeURIComponent(raw.slice(prefix.length).replace(/\+/g, ' '));
  } catch {
    return raw.slice(prefix.length);
  }
}

/** Build an AI search URL for a query. @param {string} q @returns {string} */
export function searchUrl(q) {
  return SEARCH_PREFIX + encodeURIComponent(String(q).trim());
}

/** Build a real-web search URL for a query. @param {string} q @returns {string} */
export function liveSearchUrl(q) {
  return LIVE_SEARCH_PREFIX + encodeURIComponent(String(q).trim());
}

/**
 * @param {string} url
 * @returns {boolean} true for any `about:` address
 */
export function isAboutUrl(url) {
  return /^about:/i.test(String(url || '').trim());
}

/**
 * @param {string} url
 * @returns {boolean} true for either results-page scheme
 */
export function isSearchUrl(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  return raw.startsWith(SEARCH_PREFIX) || raw.startsWith(LIVE_SEARCH_PREFIX);
}

/**
 * What the address-bar security indicator should say about an address. The
 * report is about the *real* scheme — nothing here is decorative.
 *
 * @param {string} url
 * @returns {{icon:string, tone:'secure'|'insecure'|'local'|'unknown',
 *            label:string, badge:string}}
 */
export function securityFor(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  if (raw === '' || /^(about|gemini|web):/i.test(raw)) {
    return {
      icon: 'shield',
      tone: 'local',
      label: 'This page is part of the browser itself. Nothing was loaded from the network.',
      badge: '',
    };
  }
  if (/^https:\/\//i.test(raw)) {
    return {
      icon: 'lock',
      tone: 'secure',
      label: `Connection secure — ${hostOf(raw)} is served over HTTPS.`,
      badge: '',
    };
  }
  if (/^http:\/\//i.test(raw)) {
    return {
      icon: 'broken',
      tone: 'insecure',
      label: `Connection is not secure — ${hostOf(raw)} is served over plain HTTP.`,
      badge: 'Not secure',
    };
  }
  return { icon: 'info', tone: 'unknown', label: `Address scheme: ${raw.split(':')[0]}`, badge: '' };
}

/** Muted chip colours — deterministic per host so a site keeps its colour. */
const CHIP_COLOURS = ['#7a4ec0', '#0b6cbd', '#0f7a5a', '#b3541e', '#a03e6b', '#3f6ea3', '#6a7b1f', '#8a3b3b'];

/**
 * Stable colour for a favicon chip.
 * @param {string} seed
 * @returns {string} hex colour
 */
export function chipColour(seed) {
  const str = String(seed || '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return CHIP_COLOURS[hash % CHIP_COLOURS.length];
}

/**
 * Letter shown inside a favicon chip.
 * @param {string} url
 * @returns {string} a single upper-case character
 */
export function letterFor(url) {
  const host = hostOf(url).replace(/^www\./, '');
  const source = host || String(url || '').replace(/^[a-z]+:/i, '');
  const match = /[a-z0-9]/i.exec(source);
  return match ? match[0].toUpperCase() : '?';
}

/**
 * Favicon stand-in: an icon for local pages, a coloured letter otherwise.
 * @param {string} url
 * @param {{size?:number, letter?:string, class?:string}} [opts]
 * @returns {HTMLElement}
 */
export function faviconChip(url, opts = {}) {
  const size = opts.size || 16;
  const raw = String(url || '');
  const wrap = h('span.fx-favicon', {
    class: opts.class,
    style: { width: `${size}px`, height: `${size}px` },
    'aria-hidden': 'true',
  });
  if (raw.startsWith('about:') || raw === '') {
    wrap.classList.add('fx-favicon--local');
    wrap.appendChild(fxIcon(raw === PREFS_URL ? 'gear' : raw === HISTORY_URL ? 'clock' : raw === BOOKMARKS_URL ? 'star' : 'globe', Math.round(size * 0.92)));
    return wrap;
  }
  if (raw.startsWith('gemini:') || raw.startsWith('web:')) {
    wrap.classList.add('fx-favicon--local');
    wrap.appendChild(fxIcon('search', Math.round(size * 0.92)));
    return wrap;
  }
  const letter = opts.letter && String(opts.letter).trim() !== '' ? String(opts.letter).trim().slice(0, 1).toUpperCase() : letterFor(raw);
  wrap.classList.add('fx-favicon--letter');
  wrap.style.background = chipColour(hostOf(raw) || raw);
  wrap.style.fontSize = `${Math.max(8, Math.round(size * 0.62))}px`;
  wrap.textContent = letter;
  return wrap;
}

/* ---------------------------------------------------------- time text --- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * `14:32` — 24h clock, matching the GNOME default.
 * @param {number} ts epoch ms
 * @returns {string}
 */
export function clockText(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * `Today`, `Yesterday`, `Monday, 12 August 2026`.
 * @param {number} ts epoch ms
 * @returns {string}
 */
export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ------------------------------------------------------ shared pieces --- */

/**
 * The honest "this browser is simulated" info bar. Shown on the start page and
 * on every AI-generated document; it is deliberately not dismissible.
 * @param {string} [extra] replacement body text
 * @returns {HTMLElement}
 */
export function simulationNotice(extra) {
  return h(
    'div.fx-notice',
    { role: 'note' },
    fxIcon('info', 16, { class: 'fx-notice-icon' }),
    h(
      'div.fx-notice-text',
      {},
      h('strong', { text: 'Simulated browser.' }),
      ' ',
      h('span', {
        text:
          extra ||
          'Page content is generated by AI on this machine. No request is sent to the real website and nothing is downloaded.',
      })
    )
  );
}

/**
 * The Live-web counterpart of `simulationNotice()`: equally honest about what
 * the browser can and cannot do with a real network.
 * @param {string} [extra] replacement body text
 * @returns {HTMLElement}
 */
export function liveNotice(extra) {
  return h(
    'div.fx-notice.fx-notice--live',
    { role: 'note' },
    fxIcon('frame', 16, { class: 'fx-notice-icon' }),
    h(
      'div.fx-notice-text',
      {},
      h('strong', { text: 'Live web.' }),
      ' ',
      h('span', {
        text:
          extra ||
          'Pages load for real inside a sandboxed frame. Many large sites refuse to be framed at all — when that happens this browser says so instead of faking the page.',
      })
    )
  );
}

/**
 * The browser's standard button. Exported so the live-web pages build the same
 * control instead of inventing another one.
 * @param {string} label
 * @param {() => void} onClick
 * @param {{variant?:string, icon?:string, title?:string}} [opts]
 * @returns {HTMLButtonElement}
 */
export function button(label, onClick, opts = {}) {
  const el = h('button.fx-button', {
    type: 'button',
    class: opts.variant ? `fx-button--${opts.variant}` : null,
    title: opts.title || null,
    on: { click: onClick },
  });
  if (opts.icon) el.appendChild(fxIcon(opts.icon, 15));
  el.appendChild(h('span', { text: label }));
  return el;
}


/* ------------------------------------------------------- Ubuntu Start --- */

/** The Circle of Friends, drawn flat (no gradients). @returns {SVGElement} */
function ubuntuMark(size = 46) {
  const r = 9.5;
  const dots = [-60, 60, 180].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: 16 + r * Math.cos(rad), y: 16 + r * Math.sin(rad) };
  });
  return h(
    'svg.fx-ubuntu-mark',
    { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    h('circle', { cx: 16, cy: 16, r: 15, fill: '#E95420' }),
    h('circle', { cx: 16, cy: 16, r: 4.4, fill: 'none', stroke: '#ffffff', 'stroke-width': 2.6 }),
    ...dots.map((d) => h('circle', { cx: d.x.toFixed(2), cy: d.y.toFixed(2), r: 3.1, fill: '#ffffff' }))
  );
}

/**
 * about:home / about:newtab — the local Ubuntu Start page.
 * @param {object} browser
 * @returns {HTMLElement}
 */
export function renderStartPage(browser) {
  const live = browser.mode() === MODE_LIVE;
  const page = h('div.fx-page.fx-start');
  page.appendChild(live ? liveNotice() : simulationNotice());

  const label = live ? 'Search the web with DuckDuckGo and Wikipedia' : 'Search the web with Gemini';
  const input = h('input.fx-start-input', {
    type: 'text',
    placeholder: label,
    'aria-label': label,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const submit = () => {
    const q = input.value.trim();
    if (q !== '') browser.search(q);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });

  const tiles = h('div.fx-tiles');
  for (const tile of live ? LIVE_SHORTCUTS : SHORTCUTS) {
    tiles.appendChild(
      h(
        'button.fx-tile',
        { type: 'button', title: tile.url, on: { click: () => browser.navigate(tile.url) } },
        faviconChip(tile.url, { size: 34, letter: tile.letter, class: 'fx-tile-chip' }),
        h('span.fx-tile-label', { text: tile.label }),
        h('span.fx-tile-host', { text: hostOf(tile.url) })
      )
    );
  }

  page.appendChild(
    h(
      'div.fx-start-main',
      {},
      h('div.fx-start-brand', {}, ubuntuMark(), h('div.fx-start-word', { text: 'ubuntu' })),
      h('p.fx-start-tagline', { text: 'Start page' }),
      h(
        'div.fx-start-search',
        {},
        fxIcon('search', 18, { class: 'fx-start-search-icon' }),
        input,
        h('button.fx-start-go', { type: 'button', text: 'Search', on: { click: submit } })
      ),
      h(
        'div.fx-start-mode',
        {},
        h('span.fx-start-mode-label', { text: live ? 'Live web — real network' : 'AI simulation — pages written by Gemini' }),
        button(live ? 'Switch to AI simulation' : 'Switch to Live web', () => browser.setMode(live ? MODE_AI : MODE_LIVE), {
          icon: live ? 'sparkle' : 'frame',
          variant: 'quiet',
        })
      ),
      h('div.fx-tiles-label', { text: live ? 'Sites that really load here' : 'Shortcuts' }),
      tiles,
      h(
        'div.fx-start-links',
        {},
        button('History', () => browser.navigate(HISTORY_URL), { icon: 'clock', variant: 'quiet' }),
        button('Bookmarks', () => browser.navigate(BOOKMARKS_URL), { icon: 'star', variant: 'quiet' }),
        button('Settings', () => browser.navigate(PREFS_URL), { icon: 'gear', variant: 'quiet' })
      ),
      h('p.fx-start-foot', { text: UA_LABEL })
    )
  );
  return page;
}

/* --------------------------------------------------------- about:blank -- */

/** @returns {HTMLElement} */
export function renderBlankPage() {
  return h('div.fx-page.fx-blank', { 'aria-label': 'Blank page' });
}

/* --------------------------------------------------------- error pages --- */

/**
 * Firefox's `about:neterror` layout.
 * @param {string} url the address that failed
 * @param {object} browser
 * @param {{reason?:'dns'|'invalid'|'unsupported', scheme?:string, live?:boolean}} [opts]
 * @returns {HTMLElement}
 */
export function renderErrorPage(url, browser, opts = {}) {
  const reason = opts.reason || 'dns';
  const host = hostOf(url) || String(url || '');

  let title = "Hmm. We're having trouble finding that site.";
  let lede = `We can't connect to the server at ${host}.`;
  if (reason === 'invalid') {
    title = "Hmm. That address doesn't look right.";
    lede = 'Firefox can’t load this page because the web address isn’t valid.';
  } else if (reason === 'unsupported') {
    title = 'The address wasn’t understood';
    lede = `Firefox doesn’t know how to open this address, because the protocol (${opts.scheme || '?'}) isn’t associated with any program.`;
  }

  const tips = h('ul.fx-error-tips');
  const tipText =
    reason === 'dns'
      ? [
          'Try again later.',
          'Check your network connection.',
          'If you are connected but behind a firewall, check that Firefox has permission to access the Web.',
        ]
      : ['Check the address for typing errors.', 'Make sure the address starts with https://', 'Open the address from a bookmark or from your history instead.'];
  for (const tip of tipText) tips.appendChild(h('li', { text: tip }));

  const page = h('div.fx-page.fx-error-page');
  page.appendChild(
    h(
      'div.fx-error',
      {},
      fxIcon('warning', 44, { class: 'fx-error-icon' }),
      h('h1.fx-error-title', { text: title }),
      h('p.fx-error-lede', { text: lede }),
      h('p.fx-error-sub', { text: reason === 'dns' ? 'If that address is correct, here are three other things you can try:' : 'Here are a few things you can try:' }),
      tips,
      h(
        'div.fx-error-actions',
        {},
        button('Try Again', () => browser.reload(), { variant: 'primary' }),
        button('Go to Ubuntu Start', () => browser.navigate(HOME_URL), { variant: 'quiet' })
      ),
      h('p.fx-error-note', {
        text: opts.live
          ? 'Live web mode: the address itself could not be used, so no request was made.'
          : `AI simulation mode: no connection was attempted. ${host ? `“${host}” is not one of the addresses this browser can generate a page for.` : ''}`.trim(),
      })
    )
  );
  return page;
}

