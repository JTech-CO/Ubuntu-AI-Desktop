/**
 * js/apps/firefox/data.js — persistence and address parsing for Firefox.
 * Split out of `index.js` to keep each file focused.
 *
 * History, bookmarks, preferences, the browsing mode (Live web / AI
 * simulation) and the restored session all live in `store` (ARCHITECTURE §3)
 * under `firefox:` keys. The reserved key `history` belongs to the shell, so
 * the browser namespaces its own.
 */

import { store } from '../../core/store.js';
import { DEFAULT_PREFS, MODE_LIVE, MODE_AI, prettyUrl, hostOf, isAboutUrl } from './pages.js';

const HISTORY_KEY = 'firefox:history';
const BOOKMARKS_KEY = 'firefox:bookmarks';
const PREFS_KEY = 'firefox:prefs';
const SESSION_KEY = 'firefox:session';
const MAX_HISTORY = 500;
const MAX_BOOKMARKS = 250;

/** @type {object[]|null} */ let historyCache = null;
/** @type {object[]|null} */ let bookmarkCache = null;
/** @type {object|null} */ let prefsCache = null;
/** @type {Set<(prefs: object) => void>} */ const prefsListeners = new Set();

/**
 * Drop anything malformed that a previous version (or a hand-edited
 * localStorage) may have left behind.
 * @param {any} raw
 * @returns {{url:string, title:string, ts:number}[]}
 */
function sanitiseEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item.url !== 'string' || item.url.trim() === '') continue;
    out.push({
      url: item.url,
      title: typeof item.title === 'string' && item.title !== '' ? item.title : prettyUrl(item.url),
      ts: Number.isFinite(item.ts) ? item.ts : Date.now(),
    });
  }
  return out;
}

/* ------------------------------------------------------------- history --- */

/** @returns {object[]} newest first */
export function getHistory() {
  if (!historyCache) historyCache = sanitiseEntries(store.get(HISTORY_KEY, []));
  return historyCache;
}

/** @param {object[]} list */
export function saveHistory(list) {
  historyCache = list.slice(0, MAX_HISTORY);
  store.set(HISTORY_KEY, historyCache);
}

/**
 * Move a page to the top of the history list.
 * @param {string} url
 * @param {string} title
 */
export function recordVisit(url, title) {
  if (!url || isAboutUrl(url)) return;
  const list = getHistory().filter((entry) => entry.url !== url);
  list.unshift({ url, title: title || prettyUrl(url), ts: Date.now() });
  saveHistory(list);
}

/**
 * Replace a placeholder title once the real page title is known.
 * @param {string} url
 * @param {string} title
 */
export function retitleVisit(url, title) {
  const list = getHistory();
  const entry = list.find((item) => item.url === url);
  if (!entry || !title || entry.title === title) return;
  entry.title = title;
  saveHistory(list);
}

/** @param {string} url */
export function forgetHistory(url) {
  saveHistory(getHistory().filter((entry) => entry.url !== url));
}

/* ----------------------------------------------------------- bookmarks --- */

/** @returns {object[]} */
export function getBookmarks() {
  if (!bookmarkCache) bookmarkCache = sanitiseEntries(store.get(BOOKMARKS_KEY, []));
  return bookmarkCache;
}

/** @param {object[]} list */
export function saveBookmarks(list) {
  bookmarkCache = list.slice(0, MAX_BOOKMARKS);
  store.set(BOOKMARKS_KEY, bookmarkCache);
}

/** @param {string} url @returns {boolean} */
export function isBookmarked(url) {
  return getBookmarks().some((entry) => entry.url === url);
}

/** @param {string} url @param {string} title */
export function addBookmark(url, title) {
  if (!url || isBookmarked(url)) return;
  saveBookmarks([{ url, title: title || prettyUrl(url), ts: Date.now() }, ...getBookmarks()]);
}

/** @param {string} url */
export function removeBookmark(url) {
  saveBookmarks(getBookmarks().filter((entry) => entry.url !== url));
}

/* --------------------------------------------------------- preferences --- */

/** @returns {object} stored preferences merged over the defaults */
export function getPrefs() {
  if (!prefsCache) {
    const saved = store.get(PREFS_KEY, {});
    prefsCache = { ...DEFAULT_PREFS, ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) };
  }
  return prefsCache;
}

/**
 * @param {string} key
 * @param {any} value
 */
export function setPref(key, value) {
  const prefs = { ...getPrefs(), [key]: value };
  prefsCache = prefs;
  store.set(PREFS_KEY, prefs);
  for (const listener of prefsListeners) {
    try {
      listener(prefs);
    } catch (err) {
      console.warn('[firefox] preference listener failed:', err);
    }
  }
}

/**
 * @param {(prefs: object) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onPrefsChange(listener) {
  prefsListeners.add(listener);
  return () => prefsListeners.delete(listener);
}

/* ---------------------------------------------------------------- mode --- */

/**
 * Which engine renders an http(s) address: `live` really loads it in a frame,
 * `ai` asks Gemini to write it. Stored with the rest of the preferences, so it
 * survives a reload like every other Firefox setting.
 * @returns {'live'|'ai'}
 */
export function getMode() {
  return getPrefs().mode === MODE_AI ? MODE_AI : MODE_LIVE;
}

/**
 * @param {string} mode
 * @returns {'live'|'ai'} the mode actually stored
 */
export function setMode(mode) {
  const value = mode === MODE_AI ? MODE_AI : MODE_LIVE;
  setPref('mode', value);
  return value;
}

/* ------------------------------------------------------------- session --- */

/** @returns {string[]} URLs of the tabs open when the last window was closed */
export function loadSession() {
  const saved = store.get(SESSION_KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter((url) => typeof url === 'string' && url.trim() !== '').map((url) => url.trim());
}

/** @param {string[]} urls */
export function saveSession(urls) {
  store.set(SESSION_KEY, urls.slice(0, 12));
}

/* -------------------------------------------------------------- caches --- */

const CACHE_LIMIT = 40;
const searchCache = new Map();
const pageCache = new Map();
const liveSearchCache = new Map();

function cachePut(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
}

/** @param {string} query @returns {object|undefined} */
export function getCachedSearch(query) {
  return searchCache.get(String(query).toLowerCase());
}

/** @param {string} query @param {object} value */
export function putCachedSearch(query, value) {
  cachePut(searchCache, String(query).toLowerCase(), value);
}

/** @param {string} query */
export function dropCachedSearch(query) {
  searchCache.delete(String(query).toLowerCase());
}

/** @param {string} url @returns {object|undefined} */
export function getCachedPage(url) {
  return pageCache.get(url);
}

/** @param {string} url @param {object} value */
export function putCachedPage(url, value) {
  cachePut(pageCache, url, value);
}

/** @param {string} url */
export function dropCachedPage(url) {
  pageCache.delete(url);
}

/**
 * Real search results are cached for the session too, so going back to a
 * results page does not hit DuckDuckGo and Wikipedia again.
 * @param {string} query
 * @returns {object|undefined}
 */
export function getCachedLiveSearch(query) {
  return liveSearchCache.get(String(query).toLowerCase());
}

/** @param {string} query @param {object} value */
export function putCachedLiveSearch(query, value) {
  cachePut(liveSearchCache, String(query).toLowerCase(), value);
}

/** @param {string} query */
export function dropCachedLiveSearch(query) {
  liveSearchCache.delete(String(query).toLowerCase());
}

/* ----------------------------------------------------------- addresses --- */

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const DEAD_TLDS = ['invalid', 'test', 'local', 'localdomain', 'internal', 'onion'];

/**
 * Decide what address-bar text means, the way Firefox's unified bar does: an
 * `about:` page, an explicit URL, a bare hostname, or a search query.
 *
 * @param {string} text
 * @returns {{kind:'none'|'url'|'search', url?:string, query?:string,
 *            scheme?:string, unsupported?:boolean}}
 */
export function classifyInput(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (raw === '') return { kind: 'none' };
  if (/^about:/i.test(raw)) return { kind: 'url', url: raw.toLowerCase() };
  if (/^gemini:search\?q=/i.test(raw)) return { kind: 'url', url: raw };
  if (/^web:search\?q=/i.test(raw)) return { kind: 'url', url: raw };

  const scheme = SCHEME_RE.exec(raw);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https') return { kind: 'url', url: raw };
    if (raw.includes('://') || name === 'mailto' || name === 'file' || name === 'ftp' || name === 'ftps') {
      return { kind: 'url', url: raw, scheme: name, unsupported: true };
    }
    // `localhost:8080/x` also matches SCHEME_RE — fall through to the host test.
  }

  if (/\s/.test(raw)) return { kind: 'search', query: raw };
  const host = raw.split(/[/?#]/)[0].split(':')[0];
  if (host === 'localhost' || HOSTNAME_RE.test(host)) return { kind: 'url', url: `https://${raw}` };
  return { kind: 'search', query: raw };
}

/**
 * Why an http(s) address cannot be opened, or `null` when a page can be made
 * for it.
 * @param {string} url
 * @returns {'dns'|'invalid'|null}
 */
export function webFailure(url) {
  const authority = hostOf(url);
  if (authority === '') return 'invalid';
  const host = authority.split(':')[0];
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'dns';
  if (!HOSTNAME_RE.test(host)) return 'invalid';
  const tld = host.split('.').pop();
  if (!/^[a-z]{2,}$/i.test(tld)) return 'invalid';
  if (DEAD_TLDS.includes(tld)) return 'dns';
  return null;
}

/**
 * `ubuntu.com › download › desktop` — the breadcrumb form of a URL used on the
 * results page.
 * @param {string} url
 * @returns {string}
 */
export function breadcrumb(url) {
  const host = hostOf(url) || String(url || '');
  const path = String(url || '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .split(/[?#]/)[0];
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return [host, ...parts.slice(0, 3)].join(' › ');
}
