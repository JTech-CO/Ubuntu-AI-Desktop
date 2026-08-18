/**
 * js/apps/firefox/index.js — Mozilla Firefox for the Ubuntu AI Desktop.
 * ARCHITECTURE §16 app module, §18 Firefox requirements.
 *
 * The browser has two modes, switchable from the toolbar and the menu and
 * persisted through `store`:
 *
 *   Live web (default)  addresses are really loaded, in a sandboxed frame, and
 *                       searches really run against DuckDuckGo and Wikipedia.
 *                       Sites that refuse to be framed get an interstitial that
 *                       says so and offers a real browser tab.
 *   AI simulation       the original behaviour: Gemini writes the page and the
 *                       results, under a permanent "AI-generated" banner.
 *
 * Everything else is the browser proper: independent tabs with their own
 * session history, the unified address bar with autocomplete, bookmarks,
 * history, settings, reader view and Firefox's own error pages. `innerHTML`
 * never receives model output, network data, a URL, a page title or anything
 * the user typed.
 *
 * Companion modules in this folder:
 *   pages.js         URL helpers, icons, start page, error page
 *   pages-library.js about:preferences / history / bookmarks / about
 *   data.js          history / bookmarks / prefs / mode / caches / parsing
 *   content.js       Gemini-backed search results and generated documents
 *   live.js          real navigation, frame-block detection, interstitial
 *   live-search.js   real DuckDuckGo + Wikipedia results
 *   live-youtube.js  the working YouTube player page
 */

import { h, clear, on } from '../../core/dom.js';
import { dialog } from '../../core/dialog.js';
import {
  HOME_URL,
  NEWTAB_URL,
  HISTORY_URL,
  BOOKMARKS_URL,
  SEARCH_PREFIX,
  LIVE_SEARCH_PREFIX,
  MODE_LIVE,
  MODE_AI,
  fxIcon,
  faviconChip,
  prettyUrl,
  decodeQuery,
  searchUrl,
  liveSearchUrl,
  securityFor,
  isAboutUrl,
  renderErrorPage,
} from './pages.js';
import { isLocalUrl, titleForLocal, renderLocalPage } from './pages-library.js';
import {
  getHistory,
  saveHistory,
  recordVisit,
  retitleVisit,
  forgetHistory,
  getBookmarks,
  saveBookmarks,
  isBookmarked,
  addBookmark,
  removeBookmark,
  getPrefs,
  setPref,
  onPrefsChange,
  getMode,
  setMode,
  loadSession,
  saveSession,
  dropCachedSearch,
  dropCachedPage,
  dropCachedLiveSearch,
  classifyInput,
  webFailure,
} from './data.js';
import { renderSearchPage, renderGeneratedPage, openAiSettings } from './content.js';
import { t, openExternal, resolveLiveInput, parseYouTube, renderLivePage } from './live.js';
import { renderLiveSearchPage } from './live-search.js';
import { renderYouTubePage } from './live-youtube.js';
import { createOmnibox } from './omnibox.js';
import { createMenu } from './menu.js';

/** @type {Map<string, object>} instanceId -> session */
const sessions = new Map();

/**
 * Build one browser window.
 * @param {HTMLElement} root the window content element
 * @param {object} ctx ARCHITECTURE §16 context
 * @returns {object} session handle
 */
function createSession(root, ctx) {
  /* ============================================================= chrome == */

  const shell = h('div.fx', { tabindex: '-1' });

  const tabsEl = h('div.fx-tabs', { role: 'tablist', 'aria-label': 'Browser tabs' });
  const newTabBtn = h(
    'button.fx-newtab',
    { type: 'button', title: 'Open a new tab (Ctrl+T)', 'aria-label': 'Open a new tab' },
    fxIcon('plus', 16)
  );
  const tabstrip = h('div.fx-tabstrip', {}, tabsEl, newTabBtn);

  const makeNavButton = (icon, label, accel, handler) => {
    const btn = h('button.fx-navbtn', {
      type: 'button',
      title: accel ? `${label} (${accel})` : label,
      'aria-label': label,
      on: { click: handler },
    });
    btn.appendChild(fxIcon(icon, 16));
    return btn;
  };

  const backBtn = makeNavButton('back', 'Go back one page', 'Alt+Left', () => goBack());
  const forwardBtn = makeNavButton('forward', 'Go forward one page', 'Alt+Right', () => goForward());
  const reloadBtn = makeNavButton('reload', 'Reload current page', 'Ctrl+R', () => reloadOrStop());
  const homeBtn = makeNavButton('home', 'Go to homepage', 'Alt+Home', () => goHome());

  const identityIcon = h('span.fx-identity-icon', {}, fxIcon('shield', 15));
  const identityBadge = h('span.fx-identity-badge', { hidden: true });
  const identityBtn = h(
    'button.fx-identity',
    {
      type: 'button',
      title: 'Site information',
      'aria-label': 'Site information',
      on: { click: () => showIdentity() },
    },
    identityIcon,
    identityBadge
  );
  const urlInput = h('input.fx-url-input', {
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search the web or enter address',
    placeholder: 'Search the web or enter address',
  });
  const readerBtn = h(
    'button.fx-urlbtn.fx-reader-btn',
    {
      type: 'button',
      title: 'Toggle Reader View (Ctrl+Alt+R)',
      'aria-label': 'Toggle Reader View',
      hidden: true,
      on: { click: () => toggleReader() },
    },
    fxIcon('reader', 16)
  );
  const starBtn = h('button.fx-urlbtn.fx-star-btn', {
    type: 'button',
    title: 'Bookmark this page (Ctrl+D)',
    'aria-label': 'Bookmark this page',
    on: { click: () => toggleBookmark() },
  });
  const urlbar = h('div.fx-urlbar', {}, identityBtn, urlInput, readerBtn, starBtn);

  const modeIcon = h('span.fx-mode-icon', {}, fxIcon('frame', 15));
  const modeLabel = h('span.fx-mode-label', { text: 'Live web' });
  const modeBtn = h(
    'button.fx-modebtn',
    {
      type: 'button',
      'aria-label': 'Switch browsing mode',
      on: { click: () => toggleMode() },
    },
    modeIcon,
    modeLabel
  );

  const extensionsBtn = h(
    'button.fx-navbtn',
    { type: 'button', title: 'Extensions', 'aria-label': 'Extensions', on: { click: () => menu.showExtensions() } },
    fxIcon('puzzle', 16)
  );
  const menuBtn = h(
    'button.fx-navbtn.fx-menubtn',
    {
      type: 'button',
      title: 'Open application menu',
      'aria-label': 'Open application menu',
      on: { click: (ev) => menu.toggle(ev) },
    },
    fxIcon('menu', 16)
  );

  const autocomplete = h('div.fx-ac', { role: 'listbox', hidden: true });
  const menuPopup = h('div.fx-menu-popup', { role: 'menu', hidden: true });
  const bookmarkBar = h('div.fx-bmbar', { 'aria-label': 'Bookmarks toolbar' });
  const content = h('div.fx-content');

  const navbar = h(
    'div.fx-navbar',
    {},
    backBtn,
    forwardBtn,
    reloadBtn,
    homeBtn,
    h('div.fx-urlbar-wrap', {}, urlbar, autocomplete),
    modeBtn,
    extensionsBtn,
    menuBtn,
    menuPopup
  );

  shell.appendChild(tabstrip);
  shell.appendChild(navbar);
  shell.appendChild(bookmarkBar);
  shell.appendChild(content);
  root.appendChild(shell);

  /* ============================================================== state == */

  const state = { tabs: [], active: null, seq: 0, forceClose: false, mode: getMode() };
  const cleanups = [];

  /** @returns {boolean} true while the browser really loads the web */
  function isLive() {
    return state.mode === MODE_LIVE;
  }

  /**
   * The results-page address for a query in the current mode.
   * @param {string} query
   * @returns {string}
   */
  function searchAddress(query) {
    return isLive() ? liveSearchUrl(query) : searchUrl(query);
  }

  /** Callbacks handed to `content.js`, `live.js` and friends. */
  const contentHost = {
    navigate: (url) => openAddress(url),
    search: (query) => navigate(searchAddress(query)),
    reload: () => reloadOrStop(true),
    setLoading: (tab, loading) => setLoading(tab, loading),
    setTitle: (tab, title) => setTabTitle(tab, title),
    applyReader: (doc, enabled) => applyReader(doc, enabled),
    isActive: (tab) => state.active === tab,
    updateChrome: () => updateChrome(),
    mode: () => state.mode,
    openExternal: (url) => openExternal(url),
  };

  /** The API handed to the local pages in `pages.js` / `pages-library.js`. */
  const browser = {
    navigate: (url) => openAddress(url),
    search: (query) => navigate(searchAddress(query)),
    reload: () => reloadOrStop(true),
    newTab: (url) => openNewTab(url),
    history: () => getHistory(),
    bookmarks: () => getBookmarks(),
    forgetHistory: (url) => forgetHistory(url),
    removeBookmark: (url) => {
      removeBookmark(url);
      renderBookmarkBar();
      updateChrome();
    },
    clearHistory: async () => {
      const ok = await dialog.confirm({
        title: 'Clear all history?',
        body: 'Every page in this browser profile will be forgotten. This cannot be undone.',
        okLabel: 'Clear',
        destructive: true,
      });
      if (ok) saveHistory([]);
      return ok;
    },
    clearBookmarks: async () => {
      const ok = await dialog.confirm({
        title: 'Remove all bookmarks?',
        body: 'Every bookmark in this browser profile will be deleted. This cannot be undone.',
        okLabel: 'Remove',
        destructive: true,
      });
      if (ok) {
        saveBookmarks([]);
        renderBookmarkBar();
        updateChrome();
      }
      return ok;
    },
    prefs: () => getPrefs(),
    setPref: (key, value) => setPref(key, value),
    mode: () => state.mode,
    setMode: (mode) => applyMode(mode),
    openExternal: (url) => openExternal(url),
    openAiSettings,
  };

  /* =============================================================== tabs == */

  function createTab() {
    state.seq += 1;
    const favSlot = h('span.fx-tab-fav');
    const titleEl = h('span.fx-tab-title', { text: 'New Tab' });
    const closeEl = h(
      'button.fx-tab-close',
      { type: 'button', title: 'Close tab (Ctrl+W)', 'aria-label': 'Close tab' },
      fxIcon('close', 12)
    );
    const tabEl = h('div.fx-tab', { role: 'tab', 'aria-selected': 'false' }, favSlot, titleEl, closeEl);
    const view = h('div.fx-view');

    const tab = {
      id: state.seq,
      url: '',
      title: 'New Tab',
      stack: [],
      index: -1,
      nav: 0,
      loading: false,
      reader: false,
      canReader: false,
      controller: null,
      tabEl,
      titleEl,
      favSlot,
      view,
    };

    tabEl.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        closeTab(tab);
      } else if (ev.button === 0) {
        selectTab(tab);
      }
    });
    closeEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTab(tab);
    });

    state.tabs.push(tab);
    tabsEl.appendChild(tabEl);
    content.appendChild(view);
    updateTabFavicon(tab);
    layoutTabs();
    return tab;
  }

  function openNewTab(url) {
    const tab = createTab();
    selectTab(tab);
    navigate(url || NEWTAB_URL, { tab });
    if (!url) focusAddressBar();
    return tab;
  }

  function selectTab(tab) {
    if (!tab) return;
    if (state.active === tab) {
      updateChrome();
      return;
    }
    for (const other of state.tabs) {
      const isActive = other === tab;
      other.tabEl.classList.toggle('is-active', isActive);
      other.tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
      other.view.classList.toggle('is-active', isActive);
    }
    state.active = tab;
    omnibox.close();
    updateChrome();
    tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function closeTab(tab) {
    if (!tab) return;
    const index = state.tabs.indexOf(tab);
    if (index < 0) return;
    if (tab.controller) tab.controller.abort();
    tab.nav += 1;
    state.tabs.splice(index, 1);
    tab.tabEl.remove();
    tab.view.remove();

    if (state.tabs.length === 0) {
      state.forceClose = true;
      ctx.close();
      return;
    }
    if (state.active === tab) {
      state.active = null;
      selectTab(state.tabs[Math.min(index, state.tabs.length - 1)]);
    }
    persistSession();
    layoutTabs();
  }

  function cycleTab(direction) {
    if (state.tabs.length < 2) return;
    const index = state.tabs.indexOf(state.active);
    const next = (index + direction + state.tabs.length) % state.tabs.length;
    selectTab(state.tabs[next]);
  }

  function updateTabFavicon(tab) {
    clear(tab.favSlot);
    if (tab.loading) {
      tab.favSlot.appendChild(h('span.fx-spinner'));
      return;
    }
    tab.favSlot.appendChild(faviconChip(tab.url || NEWTAB_URL, { size: 16 }));
  }

  function setTabTitle(tab, title) {
    const value = title && String(title).trim() !== '' ? String(title).trim() : prettyUrl(tab.url) || 'New Tab';
    tab.title = value;
    tab.titleEl.textContent = value;
    tab.tabEl.title = value;
    retitleVisit(tab.url, value);
    if (tab === state.active) ctx.setTitle(`${value} — Mozilla Firefox`);
  }

  function layoutTabs() {
    tabstrip.classList.toggle('fx-tabstrip--many', state.tabs.length > 6);
  }

  function persistSession() {
    if (!getPrefs().restoreSession) return;
    saveSession(state.tabs.map((tab) => tab.url).filter((url) => url && url !== NEWTAB_URL));
  }

  /* ========================================================= navigation == */

  /**
   * Load an address into a tab and push it onto that tab's session history.
   * @param {string} url
   * @param {{tab?:object, push?:boolean}} [opts]
   */
  function navigate(url, opts = {}) {
    const tab = opts.tab || state.active;
    if (!tab || !url) return;

    if (tab.controller) {
      tab.controller.abort();
      tab.controller = null;
    }
    tab.nav += 1;
    tab.url = url;
    tab.reader = false;
    tab.canReader = false;

    if (opts.push !== false) {
      tab.stack = tab.stack.slice(0, tab.index + 1);
      if (tab.stack[tab.stack.length - 1] !== url) tab.stack.push(url);
      tab.index = tab.stack.length - 1;
      if (tab.stack.length > 60) {
        tab.stack.shift();
        tab.index -= 1;
      }
    }

    setTabTitle(tab, isLocalUrl(url) ? titleForLocal(url) : prettyUrl(url));
    updateTabFavicon(tab);
    recordVisit(url, tab.title);
    persistSession();
    updateChrome();
    renderTab(tab);
  }

  /**
   * Address-bar / link entry point: classify the text, then navigate.
   * In Live web mode a couple of shortcuts resolve first — the word "youtube"
   * in either language, and a bare 11-character video id.
   */
  function openAddress(text, opts = {}) {
    if (isLive()) {
      const shortcut = resolveLiveInput(text);
      if (shortcut !== '') {
        navigate(shortcut, opts);
        return;
      }
    }
    const verdict = classifyInput(text);
    if (verdict.kind === 'none') return;
    navigate(verdict.kind === 'search' ? searchAddress(verdict.query) : verdict.url, opts);
  }

  /**
   * Switch between Live web and AI simulation, persist it, and re-render the
   * tab the user is looking at so the change is immediately visible.
   * @param {string} mode
   */
  function applyMode(mode) {
    const next = setMode(mode);
    if (next === state.mode) return;
    state.mode = next;
    syncModeChrome();
    const tab = state.active;
    if (tab && tab.url) renderTab(tab);
    updateChrome();
  }

  function toggleMode() {
    applyMode(isLive() ? MODE_AI : MODE_LIVE);
  }

  /** Toolbar labels and the address-bar placeholder follow the mode. */
  function syncModeChrome() {
    const live = isLive();
    clear(modeIcon);
    modeIcon.appendChild(fxIcon(live ? 'frame' : 'sparkle', 15));
    modeLabel.textContent = live ? 'Live web' : 'AI mode';
    modeBtn.classList.toggle('is-live', live);
    modeBtn.classList.toggle('is-ai', !live);
    modeBtn.title = live
      ? 'Live web: addresses are really loaded and searches really run. Click to switch to AI simulation.'
      : 'AI simulation: pages and results are written by Gemini. Click to switch to Live web.';
    const placeholder = live ? 'Search the web or enter address' : 'Search with Gemini or enter address';
    urlInput.placeholder = placeholder;
    urlInput.setAttribute('aria-label', placeholder);
  }

  function goBack() {
    const tab = state.active;
    if (!tab || tab.index <= 0) return;
    tab.index -= 1;
    navigate(tab.stack[tab.index], { push: false });
  }

  function goForward() {
    const tab = state.active;
    if (!tab || tab.index >= tab.stack.length - 1) return;
    tab.index += 1;
    navigate(tab.stack[tab.index], { push: false });
  }

  function goHome() {
    openAddress(getPrefs().homepage || HOME_URL);
  }

  /** The reload button doubles as Stop while a page is generating. */
  function reloadOrStop(force) {
    const tab = state.active;
    if (!tab) return;
    if (tab.loading && !force) {
      if (tab.controller) tab.controller.abort();
      tab.controller = null;
      tab.nav += 1;
      setLoading(tab, false);
      return;
    }
    if (tab.url.startsWith(SEARCH_PREFIX)) dropCachedSearch(decodeQuery(tab.url));
    else if (tab.url.startsWith(LIVE_SEARCH_PREFIX)) dropCachedLiveSearch(decodeQuery(tab.url));
    else dropCachedPage(tab.url);
    navigate(tab.url, { push: false });
  }

  function setLoading(tab, loading) {
    tab.loading = loading;
    tab.tabEl.classList.toggle('is-loading', loading);
    updateTabFavicon(tab);
    if (tab === state.active) updateChrome();
  }

  /* ============================================================= chrome == */

  function updateChrome() {
    const tab = state.active;
    if (!tab) return;

    if (document.activeElement !== urlInput) {
      urlInput.value = tab.url === NEWTAB_URL || tab.url === HOME_URL ? '' : tab.url;
    }
    backBtn.disabled = tab.index <= 0;
    forwardBtn.disabled = tab.index >= tab.stack.length - 1;

    clear(reloadBtn);
    reloadBtn.appendChild(fxIcon(tab.loading ? 'stop' : 'reload', 16));
    reloadBtn.title = tab.loading ? 'Stop loading this page (Esc)' : 'Reload current page (Ctrl+R)';

    const security = securityFor(tab.url);
    clear(identityIcon);
    identityIcon.appendChild(fxIcon(security.icon, 15));
    identityBtn.classList.remove('is-secure', 'is-insecure', 'is-local', 'is-unknown');
    identityBtn.classList.add(`is-${security.tone}`);
    identityBtn.title = security.label;
    identityBtn.setAttribute('aria-label', security.label);
    identityBadge.hidden = security.badge === '';
    identityBadge.textContent = security.badge;

    const marked = isBookmarked(tab.url);
    clear(starBtn);
    starBtn.appendChild(fxIcon('star', 16, { filled: marked }));
    starBtn.classList.toggle('is-on', marked);
    starBtn.title = marked ? 'Remove this bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';

    readerBtn.hidden = !tab.canReader;
    readerBtn.classList.toggle('is-on', tab.reader);
    ctx.setTitle(`${tab.title} — Mozilla Firefox`);
  }

  function focusAddressBar() {
    urlInput.focus();
    urlInput.select();
  }

  /** The site-information panel behind the padlock. */
  function showIdentity() {
    const tab = state.active;
    if (!tab) return;
    const security = securityFor(tab.url);
    const lines = [security.label];
    if (security.tone === 'insecure') {
      lines.push('Anything sent to this site travels unencrypted, and an https page cannot embed it at all.');
    } else if (security.tone === 'secure') {
      lines.push(
        isLive()
          ? 'The page is loaded in a sandboxed frame: no script from this desktop runs inside it, and nothing is injected into it.'
          : 'AI simulation mode is on, so nothing was loaded from this address — Gemini wrote the page.'
      );
    }
    dialog.alert({ title: prettyUrl(tab.url) || 'Site information', body: lines.join('\n\n'), okLabel: 'Close' });
  }

  function toggleBookmark() {
    const tab = state.active;
    if (!tab || !tab.url || tab.url === NEWTAB_URL) return;
    if (isBookmarked(tab.url)) removeBookmark(tab.url);
    else addBookmark(tab.url, tab.title);
    renderBookmarkBar();
    updateChrome();
  }

  function toggleReader() {
    const tab = state.active;
    if (!tab || !tab.canReader) return;
    tab.reader = !tab.reader;
    const doc = tab.view.querySelector('.fx-doc');
    if (doc) applyReader(doc, tab.reader);
    updateChrome();
  }

  /** Reader View: a narrow serif column, sized from the preferences. */
  function applyReader(doc, enabled) {
    const prefs = getPrefs();
    doc.classList.toggle('is-reader', enabled);
    doc.classList.toggle('is-sepia', enabled && prefs.readerTheme === 'sepia');
    doc.style.setProperty('--fx-reader-size', `${prefs.readerFontSize}px`);
  }

  function renderBookmarkBar() {
    clear(bookmarkBar);
    const marks = getBookmarks();
    if (marks.length === 0) {
      bookmarkBar.appendChild(
        h('span.fx-bmbar-hint', { text: 'Bookmarks you add with the star appear on this toolbar.' })
      );
      return;
    }
    for (const mark of marks.slice(0, 24)) {
      bookmarkBar.appendChild(
        h(
          'button.fx-bmark',
          { type: 'button', title: mark.url, on: { click: () => openAddress(mark.url) } },
          faviconChip(mark.url, { size: 14 }),
          h('span.fx-bmark-label', { text: mark.title })
        )
      );
    }
    bookmarkBar.appendChild(
      h(
        'button.fx-bmark.fx-bmark--all',
        { type: 'button', title: 'Show all bookmarks', on: { click: () => openAddress(BOOKMARKS_URL) } },
        h('span.fx-bmark-label', { text: 'All Bookmarks' })
      )
    );
  }

  /* =================================================== application menu == */

  const menu = createMenu({
    popup: menuPopup,
    button: menuBtn,
    activeTab: () => state.active,
    isLive,
    actions: {
      newTab: (url) => openNewTab(url),
      openAddress: (url) => openAddress(url),
      applyMode: (mode) => applyMode(mode),
      toggleReader: () => toggleReader(),
      close: () => ctx.close(),
      closeAutocomplete: () => omnibox.close(),
    },
  });

  /* ======================================================= autocomplete == */

  const omnibox = createOmnibox({
    urlInput,
    urlbar,
    list: autocomplete,
    isLive,
    searchAddress,
    navigate: (url) => navigate(url),
    openAddress: (text) => openAddress(text),
  });


  /* ======================================================== page render == */

  function renderTab(tab) {
    clear(tab.view);
    tab.view.scrollTop = 0;
    setLoading(tab, false);
    const url = tab.url;

    if (isLocalUrl(url)) {
      const page = renderLocalPage(url, browser);
      tab.view.appendChild(page);
      setTabTitle(tab, titleForLocal(url));
      updateChrome();
      if (url === HOME_URL || url === NEWTAB_URL) {
        const field = page.querySelector('.fx-start-input');
        if (field && tab === state.active) field.focus();
      }
      return;
    }

    if (isAboutUrl(url)) {
      tab.view.appendChild(renderErrorPage(url, browser, { reason: 'invalid', live: isLive() }));
      setTabTitle(tab, 'Problem loading page');
      return;
    }

    if (url.startsWith(SEARCH_PREFIX)) {
      const query = decodeQuery(url);
      setTabTitle(tab, `${query} — Gemini Search`);
      renderSearchPage(tab, query, contentHost);
      return;
    }

    if (url.startsWith(LIVE_SEARCH_PREFIX)) {
      const query = decodeQuery(url);
      setTabTitle(tab, t(`${query} — 웹 검색`, `${query} — Web Search`));
      renderLiveSearchPage(tab, query, contentHost);
      return;
    }

    const verdict = classifyInput(url);
    if (verdict.unsupported) {
      tab.view.appendChild(
        renderErrorPage(url, browser, { reason: 'unsupported', scheme: verdict.scheme, live: isLive() })
      );
      setTabTitle(tab, 'Problem loading page');
      return;
    }

    if (isLive()) {
      const youtube = parseYouTube(url);
      if (youtube) {
        renderYouTubePage(tab, youtube, contentHost);
        return;
      }
      renderLivePage(tab, url, contentHost);
      return;
    }

    const failure = webFailure(url);
    if (failure) {
      tab.view.appendChild(renderErrorPage(url, browser, { reason: failure }));
      setTabTitle(tab, failure === 'dns' ? 'Server Not Found' : 'Problem loading page');
      return;
    }

    renderGeneratedPage(tab, url, contentHost);
  }

  /* ============================================================= wiring == */

  newTabBtn.addEventListener('click', () => openNewTab());

  urlInput.addEventListener('focus', () => {
    urlbar.classList.add('is-focused');
    urlInput.select();
  });
  urlInput.addEventListener('blur', () => {
    urlbar.classList.remove('is-focused');
    window.setTimeout(() => {
      omnibox.close();
      updateChrome();
    }, 120);
  });
  urlInput.addEventListener('input', () => omnibox.open());
  urlInput.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case 'Enter':
        ev.preventDefault();
        omnibox.commit();
        break;
      case 'ArrowDown':
        ev.preventDefault();
        if (omnibox.isOpen()) omnibox.move(1);
        else omnibox.open();
        break;
      case 'ArrowUp':
        ev.preventDefault();
        omnibox.move(-1);
        break;
      case 'Escape':
        ev.preventDefault();
        ev.stopPropagation();
        omnibox.close();
        updateChrome();
        urlInput.blur();
        break;
      default:
        break;
    }
  });

  function handleKeydown(ev) {
    const ctrl = ev.ctrlKey || ev.metaKey;
    const key = String(ev.key).toLowerCase();

    if (ctrl && ev.altKey && key === 'r') {
      ev.preventDefault();
      toggleReader();
      return;
    }
    if (ctrl && !ev.altKey) {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        cycleTab(ev.shiftKey ? -1 : 1);
        return;
      }
      if (ev.shiftKey) return;
      switch (key) {
        case 't':
          ev.preventDefault();
          openNewTab();
          return;
        case 'w':
          ev.preventDefault();
          closeTab(state.active);
          return;
        case 'l':
          ev.preventDefault();
          focusAddressBar();
          return;
        case 'r':
          ev.preventDefault();
          reloadOrStop(true);
          return;
        case 'd':
          ev.preventDefault();
          toggleBookmark();
          return;
        case 'h':
          ev.preventDefault();
          openAddress(HISTORY_URL);
          return;
        case 'b':
          ev.preventDefault();
          openAddress(BOOKMARKS_URL);
          return;
        default:
          return;
      }
    }
    if (ev.altKey && ev.key === 'ArrowLeft') {
      ev.preventDefault();
      goBack();
      return;
    }
    if (ev.altKey && ev.key === 'ArrowRight') {
      ev.preventDefault();
      goForward();
      return;
    }
    if (ev.altKey && ev.key === 'Home') {
      ev.preventDefault();
      goHome();
      return;
    }
    if (ev.key === 'F5') {
      ev.preventDefault();
      reloadOrStop(true);
      return;
    }
    if (ev.key === 'Escape') {
      if (menu.isOpen()) {
        menu.close();
        return;
      }
      if (omnibox.isOpen()) {
        omnibox.close();
        return;
      }
      if (state.active && state.active.loading) reloadOrStop();
    }
  }

  cleanups.push(on(shell, 'keydown', handleKeydown));
  cleanups.push(
    on(document, 'mousedown', (ev) => {
      if (menu.isOpen() && !menuPopup.contains(ev.target) && !menuBtn.contains(ev.target)) menu.close();
      if (omnibox.isOpen() && !autocomplete.contains(ev.target) && !urlbar.contains(ev.target)) omnibox.close();
    })
  );

  cleanups.push(
    onPrefsChange((prefs) => {
      for (const tab of state.tabs) {
        const doc = tab.view.querySelector('.fx-doc');
        if (!doc) continue;
        doc.style.setProperty('--fx-reader-size', `${prefs.readerFontSize}px`);
        doc.classList.toggle('is-sepia', tab.reader && prefs.readerTheme === 'sepia');
      }
    })
  );

  const resize = () => {
    const width = shell.clientWidth || root.clientWidth;
    shell.classList.toggle('fx--narrow', width > 0 && width < 760);
    shell.classList.toggle('fx--tiny', width > 0 && width < 560);
  };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    cleanups.push(() => observer.disconnect());
  }

  /* ============================================================ startup == */

  renderBookmarkBar();
  syncModeChrome();

  const startUrls = [];
  const args = ctx.args || {};
  if (typeof args.url === 'string' && args.url.trim() !== '') {
    startUrls.push(args.url.trim());
  } else if (typeof args.search === 'string' && args.search.trim() !== '') {
    startUrls.push(searchUrl(args.search.trim()));
  } else if (getPrefs().restoreSession) {
    startUrls.push(...loadSession().slice(0, 8));
  }
  if (startUrls.length === 0) startUrls.push(getPrefs().homepage || HOME_URL);

  startUrls.forEach((url, index) => {
    const tab = createTab();
    if (index === 0) selectTab(tab);
    navigate(url, { tab });
  });
  resize();
  updateChrome();

  return {
    focus() {
      shell.focus({ preventScroll: true });
    },
    resize,
    destroy() {
      for (const tab of state.tabs) {
        if (tab.controller) tab.controller.abort();
      }
      for (const off of cleanups) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      cleanups.length = 0;
    },
    get tabCount() {
      return state.tabs.length;
    },
    get forceClose() {
      return state.forceClose;
    },
    set forceClose(value) {
      state.forceClose = value;
    },
  };
}

/** Flat Firefox mark — product colours, no gradients. @returns {SVGElement} */
function firefoxIcon() {
  return h(
    'svg.app-icon-firefox',
    { viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': 'true', focusable: 'false' },
    h('circle', { cx: 12, cy: 12, r: 11, fill: '#5b2a86' }),
    h('path', {
      d: 'M12 2.6c2.2 1.5 3.4 3.5 3.6 5.6 1-.6 1.7-1.6 1.9-2.8 1.7 1.9 2.6 4.3 2.6 6.6 0 4.6-3.6 8.3-8.1 8.3S3.9 16.6 3.9 12c0-2 .7-3.9 2-5.4.1 1.4.9 2.6 2 3.2.1-2.8 1.6-5.3 4.1-7.2z',
      fill: '#ff7139',
    }),
    h('path', {
      d: 'M12 18.6c-2.4 0-4.4-1.9-4.4-4.2 0-1.8 1.1-3.1 2.6-3.9-.3 1.5.4 2.7 1.6 3.2.9-1.5 1.1-3.1.3-4.7 2.6 1.3 4.4 3.4 4.4 5.4 0 2.3-2 4.2-4.5 4.2z',
      fill: '#ffb833',
    })
  );
}

export default {
  id: 'firefox',
  name: 'Firefox',
  genericName: 'Web Browser',
  icon: firefoxIcon,
  pinned: true,
  singleton: false,
  width: 1060,
  height: 700,
  minWidth: 520,
  minHeight: 360,
  resizable: true,
  themeClass: 'app-firefox',
  darkChrome: true,

  /**
   * @param {HTMLElement} root window content element
   * @param {object} ctx ARCHITECTURE §16 context
   */
  mount(root, ctx) {
    const session = createSession(root, ctx);
    sessions.set(ctx.instanceId, session);
    session.focus();
  },

  onFocus(ctx) {
    const session = sessions.get(ctx.instanceId);
    if (session) session.focus();
  },

  onBlur() {
    /* nothing to release */
  },

  onResize(ctx) {
    const session = sessions.get(ctx.instanceId);
    if (session) session.resize();
  },

  /**
   * Firefox's "Confirm before closing multiple tabs" preference.
   * @param {object} ctx
   * @returns {boolean} false vetoes the close
   */
  onClose(ctx) {
    const session = sessions.get(ctx.instanceId);
    if (!session) return true;
    if (session.forceClose || session.tabCount <= 1 || !getPrefs().warnOnQuit) {
      session.destroy();
      sessions.delete(ctx.instanceId);
      return true;
    }
    dialog
      .confirm({
        title: `Close ${session.tabCount} tabs?`,
        body: 'You are about to close several tabs. Are you sure you want to continue?',
        okLabel: 'Close Tabs',
        destructive: true,
      })
      .then((ok) => {
        if (!ok) return;
        session.forceClose = true;
        ctx.close();
      });
    return false;
  },
};
