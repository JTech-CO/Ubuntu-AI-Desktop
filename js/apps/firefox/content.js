/**
 * js/apps/firefox/content.js — the Gemini-backed pages of the simulated
 * Firefox: the search results page and the generated document view.
 *
 * SAFETY: every string that comes back from the model is written with
 * `textContent` (through `h({ text })`). Nothing the model produces ever
 * reaches `innerHTML`, and no URL from the model is used to fetch anything.
 *
 * Both entry points take a `host` object supplied by `index.js`:
 *
 * ```js
 * {
 *   navigate(url), reload(),
 *   setLoading(tab, boolean), setTitle(tab, title),
 *   applyReader(docElement, enabled),
 *   isActive(tab), updateChrome(),
 * }
 * ```
 */

import { h, clear } from '../../core/dom.js';
import { dialog } from '../../core/dialog.js';
import { gemini } from '../../services/gemini.js';
import { wm } from '../../shell/window-manager.js';
import { fxIcon, faviconChip, hostOf, prettyUrl, searchUrl, simulationNotice, button } from './pages.js';
import { breadcrumb, getCachedSearch, putCachedSearch, getCachedPage, putCachedPage } from './data.js';
import { t, openExternal } from './live.js';

/* =============================================================== prompts == */

const SEARCH_SYSTEM =
  'You simulate a web search engine inside an offline Ubuntu desktop demo. ' +
  'You reply with JSON only. Results must point at real, well known websites and be factually plausible. ' +
  'Never use HTML, markdown or emoji.';

const PAGE_SYSTEM =
  'You write the readable content of a web page for an offline browser simulation. ' +
  'You reply with JSON only. Every string is plain text: no HTML tags, no markdown syntax, no asterisks, no emoji.';

function searchPrompt(query) {
  return (
    `Return web search results for this query: ${JSON.stringify(query)}\n\n` +
    'JSON shape:\n' +
    '{"results":[{"title":string,"url":string,"description":string,"letter":string}],"related":[string]}\n\n' +
    'Rules:\n' +
    '- Exactly 7 results, most relevant first.\n' +
    '- "url" is an absolute https URL on a real, well known site, including a realistic path.\n' +
    '- "title" is at most 70 characters.\n' +
    '- "description" is 20 to 30 words of plain text, like a search snippet.\n' +
    '- "letter" is one uppercase letter used as the favicon.\n' +
    '- "related" holds 4 short follow-up queries.\n' +
    'Answer with JSON only.'
  );
}

function pagePrompt(url) {
  return (
    `Write the content a visitor would read at this address: ${url}\n\n` +
    'JSON shape:\n' +
    '{"title":string,"site":string,"summary":string,"blocks":[Block],"links":[{"text":string,"url":string}]}\n\n' +
    'Block shapes:\n' +
    '{"type":"heading","level":2,"text":string}\n' +
    '{"type":"paragraph","text":string}\n' +
    '{"type":"list","ordered":false,"items":[string]}\n' +
    '{"type":"code","language":string,"code":string}\n' +
    '{"type":"quote","text":string,"cite":string}\n' +
    '{"type":"table","headers":[string],"rows":[[string]]}\n\n' +
    'Rules:\n' +
    '- "title" is the page title, "site" is the site name, "summary" is one sentence.\n' +
    '- 8 to 14 blocks, starting with a paragraph, including at least two headings.\n' +
    '- Include at least one list or table. Use a code block only for a technical page.\n' +
    '- Stay factual for real sites: describe what that page really covers.\n' +
    '- "links" holds 3 to 5 absolute https URLs to related pages.\n' +
    'Answer with JSON only.'
  );
}

/* ========================================================== normalisers == */

function asText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * Coerce whatever the model returned into the result list the UI expects.
 * @param {any} payload
 * @returns {{results:object[], related:string[]}}
 */
export function normaliseResults(payload) {
  const raw = Array.isArray(payload) ? payload : payload && Array.isArray(payload.results) ? payload.results : [];
  const results = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = asText(item.url).trim();
    const title = asText(item.title).trim();
    if (url === '' && title === '') continue;
    const absolute = url === '' ? '' : /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`;
    results.push({
      url: absolute,
      title: title || prettyUrl(absolute),
      description: asText(item.description || item.snippet).trim(),
      letter: asText(item.letter).trim().slice(0, 1),
    });
  }
  const relatedRaw = payload && Array.isArray(payload.related) ? payload.related : [];
  const related = relatedRaw
    .map((item) => asText(item).trim())
    .filter((item) => item !== '')
    .slice(0, 6);
  return { results: results.slice(0, 10), related };
}

/**
 * Coerce a generated document into the block list the renderer understands.
 * Unknown block types degrade to paragraphs instead of being dropped.
 * @param {any} payload
 * @param {string} url
 * @returns {{title:string, site:string, summary:string, blocks:object[], links:object[]}}
 */
export function normaliseDocument(payload, url) {
  const doc = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawBlocks = Array.isArray(doc.blocks) ? doc.blocks : Array.isArray(payload) ? payload : [];
  const blocks = [];

  for (const item of rawBlocks) {
    if (!item) continue;
    if (typeof item === 'string') {
      blocks.push({ type: 'paragraph', text: item });
      continue;
    }
    if (typeof item !== 'object') continue;

    switch (asText(item.type).toLowerCase()) {
      case 'heading': {
        const level = Number(item.level);
        blocks.push({
          type: 'heading',
          level: level >= 2 && level <= 4 ? Math.round(level) : 2,
          text: asText(item.text),
        });
        break;
      }
      case 'list': {
        const items = (Array.isArray(item.items) ? item.items : []).map((x) => asText(x)).filter((x) => x !== '');
        if (items.length) blocks.push({ type: 'list', ordered: item.ordered === true, items });
        break;
      }
      case 'code': {
        const code = asText(item.code || item.text);
        if (code !== '') blocks.push({ type: 'code', language: asText(item.language), code });
        break;
      }
      case 'quote':
        blocks.push({ type: 'quote', text: asText(item.text), cite: asText(item.cite || item.source) });
        break;
      case 'table': {
        const headers = (Array.isArray(item.headers) ? item.headers : []).map((x) => asText(x));
        const rows = (Array.isArray(item.rows) ? item.rows : [])
          .filter((row) => Array.isArray(row))
          .map((row) => row.map((cell) => asText(cell)));
        if (headers.length || rows.length) blocks.push({ type: 'table', headers, rows });
        break;
      }
      default: {
        const text = asText(item.text || item.content);
        if (text !== '') blocks.push({ type: 'paragraph', text });
        break;
      }
    }
  }

  const links = (Array.isArray(doc.links) ? doc.links : [])
    .filter((link) => link && typeof link === 'object')
    .map((link) => ({ text: asText(link.text) || prettyUrl(asText(link.url)), url: asText(link.url) }))
    .filter((link) => link.url !== '')
    .slice(0, 6);

  return {
    title: asText(doc.title).trim() || prettyUrl(url),
    site: asText(doc.site).trim() || hostOf(url),
    summary: asText(doc.summary).trim(),
    blocks: blocks.length ? blocks : [{ type: 'paragraph', text: 'This page could not be generated.' }],
    links,
  };
}

/* ============================================================ rendering == */

/**
 * Render generated blocks. Every string goes through `textContent`.
 * @param {object[]} blocks
 * @returns {DocumentFragment}
 */
export function renderBlocks(blocks) {
  const out = document.createDocumentFragment();
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.appendChild(h(`h${block.level}.fx-doc-h`, { text: block.text }));
        break;

      case 'list': {
        const list = h(block.ordered ? 'ol.fx-doc-list' : 'ul.fx-doc-list');
        for (const item of block.items) list.appendChild(h('li', { text: item }));
        out.appendChild(list);
        break;
      }

      case 'code': {
        const pre = h('pre.fx-doc-code', {}, h('code', { text: block.code }));
        if (block.language) pre.appendChild(h('span.fx-doc-code-lang', { text: block.language }));
        out.appendChild(pre);
        break;
      }

      case 'quote':
        out.appendChild(
          h('blockquote.fx-doc-quote', {}, h('p', { text: block.text }), block.cite ? h('cite', { text: block.cite }) : null)
        );
        break;

      case 'table': {
        const table = h('table.fx-doc-table');
        if (block.headers.length) {
          const tr = h('tr');
          for (const head of block.headers) tr.appendChild(h('th', { text: head }));
          table.appendChild(h('thead', {}, tr));
        }
        const tbody = h('tbody');
        for (const row of block.rows) {
          const tr = h('tr');
          for (const cell of row) tr.appendChild(h('td', { text: cell }));
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        out.appendChild(h('div.fx-doc-tablewrap', {}, table));
        break;
      }

      default:
        out.appendChild(h('p.fx-doc-p', { text: block.text }));
        break;
    }
  }
  return out;
}

/**
 * Placeholder rows shown while Gemini is answering.
 * @param {'serp'|'doc'} kind
 * @returns {HTMLElement}
 */
export function skeleton(kind) {
  const box = h('div.fx-skel', { 'aria-busy': 'true', 'aria-label': 'Loading' });
  const widths =
    kind === 'serp'
      ? ['38%', '62%', '96%', '80%', null, '34%', '58%', '94%', '76%', null, '41%', '66%', '92%', '70%']
      : ['52%', '100%', '96%', '88%', null, '34%', '98%', '92%', '76%', null, '46%', '95%', '84%'];
  for (const width of widths) {
    if (width === null) box.appendChild(h('div.fx-skel-gap'));
    else box.appendChild(h('div.fx-skel-line', { style: { width } }));
  }
  return box;
}

/* ================================================================ cards == */

/** Open GNOME Settings on the AI Configuration section. */
export function openAiSettings() {
  try {
    wm.open('settings', { section: 'ai' });
  } catch (err) {
    console.warn('[firefox] could not open Settings:', err);
    dialog.alert({
      title: 'Gemini API key required',
      body: 'Open Settings → AI Configuration and paste your Google Gemini API key, then try again.',
    });
  }
}

/**
 * The NO_API_KEY card: explains the situation and offers the two useful
 * actions instead of failing silently.
 * @param {object} host
 * @param {string} [message]
 * @returns {HTMLElement}
 */
export function keyCard(host, message) {
  return h(
    'div.fx-keycard',
    {},
    fxIcon('key', 26, { class: 'fx-keycard-icon' }),
    h('h2.fx-keycard-title', { text: 'A Gemini API key is needed to load pages' }),
    h('p.fx-keycard-body', {
      text:
        message ||
        'This browser writes every page with Google Gemini. Add your own API key in Settings → AI Configuration, then reload this page.',
    }),
    h(
      'div.fx-keycard-actions',
      {},
      h('button.fx-button.fx-button--primary', { type: 'button', on: { click: openAiSettings } }, h('span', { text: 'Open Settings' })),
      h('button.fx-button.fx-button--quiet', { type: 'button', on: { click: () => host.reload() } }, h('span', { text: 'Try Again' }))
    )
  );
}

/**
 * @param {object} host
 * @param {any} err
 * @returns {HTMLElement}
 */
export function failureCard(host, err) {
  const message = err && err.message ? err.message : String(err);
  return h(
    'div.fx-failcard',
    {},
    fxIcon('warning', 24, { class: 'fx-failcard-icon' }),
    h(
      'div.fx-failcard-body',
      {},
      h('h2.fx-failcard-title', { text: 'The page could not be generated' }),
      h('p.fx-failcard-text', { text: message })
    ),
    h('button.fx-button', { type: 'button', on: { click: () => host.reload() } }, h('span', { text: 'Try Again' }))
  );
}

/* ========================================================= results page == */

function paintResults(list, stat, data, query, ms, host) {
  stat.textContent =
    `${data.results.length} generated results for “${query}”` + (ms ? ` (${(ms / 1000).toFixed(2)} seconds)` : ' (from cache)');

  if (data.results.length === 0) {
    list.appendChild(failureCard(host, new Error('Gemini returned no results for this query.')));
    return;
  }

  for (const result of data.results) {
    const item = h('div.fx-result');
    item.appendChild(
      h(
        'div.fx-result-head',
        {},
        faviconChip(result.url, { size: 24, letter: result.letter }),
        h(
          'div.fx-result-ident',
          {},
          h('span.fx-result-site', { text: hostOf(result.url).replace(/^www\./, '') }),
          h('span.fx-result-url', { text: breadcrumb(result.url) })
        )
      )
    );
    item.appendChild(
      h('button.fx-result-title', {
        type: 'button',
        title: result.url,
        text: result.title,
        on: { click: () => host.navigate(result.url) },
      })
    );
    if (result.description) item.appendChild(h('p.fx-result-desc', { text: result.description }));
    list.appendChild(item);
  }

  if (data.related.length) {
    const related = h('div.fx-related', {}, h('h2.fx-related-title', { text: 'Related searches' }));
    const chips = h('div.fx-related-chips');
    for (const term of data.related) {
      chips.appendChild(
        h(
          'button.fx-chip',
          { type: 'button', on: { click: () => host.navigate(searchUrl(term)) } },
          fxIcon('search', 14),
          h('span', { text: term })
        )
      );
    }
    related.appendChild(chips);
    list.appendChild(related);
  }
}

/**
 * Render `gemini:search?q=…` into a tab: a Google-like result list built from
 * structured JSON.
 * @param {object} tab
 * @param {string} query
 * @param {object} host
 * @returns {Promise<void>}
 */
export async function renderSearchPage(tab, query, host) {
  const nav = tab.nav;
  const page = h('div.fx-page.fx-serp');

  const field = h('input.fx-serp-input', {
    type: 'text',
    value: query,
    'aria-label': 'Search with Gemini',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  field.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const next = field.value.trim();
    if (next !== '') host.navigate(searchUrl(next));
  });

  page.appendChild(
    h(
      'div.fx-serp-head',
      {},
      h('div.fx-serp-brand', {}, fxIcon('search', 18), h('span', { text: 'Gemini Search' })),
      h('div.fx-serp-field', {}, field),
      h(
        'div.fx-serp-engines',
        {},
        button(
          t('Google에서 검색', 'Search on Google'),
          () => openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`),
          { icon: 'external', variant: 'quiet' }
        )
      )
    )
  );
  page.appendChild(
    simulationNotice(
      'Results are written by Google Gemini from your query. No search engine is contacted and the linked sites are never visited.'
    )
  );

  const stat = h('div.fx-serp-stat');
  const list = h('div.fx-serp-list');
  page.appendChild(stat);
  page.appendChild(list);
  tab.view.appendChild(page);

  const cached = getCachedSearch(query);
  if (cached) {
    paintResults(list, stat, cached, query, 0, host);
    return;
  }

  list.appendChild(skeleton('serp'));
  host.setLoading(tab, true);
  const controller = new AbortController();
  tab.controller = controller;
  const started = performance.now();

  try {
    const payload = await gemini.generateJSON(searchPrompt(query), { system: SEARCH_SYSTEM, signal: controller.signal });
    if (tab.nav !== nav) return;
    const data = normaliseResults(payload);
    putCachedSearch(query, data);
    clear(list);
    paintResults(list, stat, data, query, performance.now() - started, host);
  } catch (err) {
    if (tab.nav !== nav) return;
    clear(list);
    list.appendChild(err && err.message === 'NO_API_KEY' ? keyCard(host) : failureCard(host, err));
  } finally {
    if (tab.nav === nav) {
      tab.controller = null;
      host.setLoading(tab, false);
    }
  }
}

/* ======================================================= generated page == */

function paintDocument(tab, doc, body, document_, url, host) {
  body.appendChild(
    h(
      'header.fx-doc-head',
      {},
      h('div.fx-doc-site', {}, faviconChip(url, { size: 18 }), h('span', { text: document_.site || hostOf(url) })),
      h('h1.fx-doc-title', { text: document_.title }),
      document_.summary ? h('p.fx-doc-summary', { text: document_.summary }) : null
    )
  );
  body.appendChild(renderBlocks(document_.blocks));

  if (document_.links.length) {
    const nav = h('nav.fx-doc-links', {}, h('h2.fx-doc-h', { text: 'Related pages' }));
    const list = h('ul.fx-doc-linklist');
    for (const link of document_.links) {
      list.appendChild(
        h(
          'li',
          {},
          h('button.fx-link', { type: 'button', title: link.url, text: link.text, on: { click: () => host.navigate(link.url) } }),
          h('span.fx-doc-linkurl', { text: prettyUrl(link.url) })
        )
      );
    }
    nav.appendChild(list);
    body.appendChild(nav);
  }

  host.setTitle(tab, document_.title);
  tab.canReader = true;
  host.applyReader(doc, tab.reader);
  if (host.isActive(tab)) host.updateChrome();
}

/**
 * Render an http(s) address into a tab by asking Gemini for structured blocks.
 * A permanent banner states that the content is generated, not fetched.
 * @param {object} tab
 * @param {string} url
 * @param {object} host
 * @returns {Promise<void>}
 */
export async function renderGeneratedPage(tab, url, host) {
  const nav = tab.nav;
  const page = h('div.fx-page.fx-doc-page');
  const doc = h('div.fx-doc');

  doc.appendChild(
    h(
      'div.fx-aibanner',
      { role: 'note' },
      fxIcon('warning', 16, { class: 'fx-aibanner-icon' }),
      h('span.fx-aibanner-text', {
        text: `AI-generated page. This content was written by Gemini from the address you opened — it was not fetched from ${hostOf(url)}.`,
      }),
      /^https?:\/\//i.test(url)
        ? button(t('진짜 사이트 열기', 'Open the real site'), () => openExternal(url), {
            icon: 'external',
            variant: 'quiet',
            title: url,
          })
        : null
    )
  );

  const body = h('div.fx-doc-body');
  doc.appendChild(body);
  page.appendChild(doc);
  tab.view.appendChild(page);
  host.applyReader(doc, false);

  const cached = getCachedPage(url);
  if (cached) {
    paintDocument(tab, doc, body, cached, url, host);
    return;
  }

  body.appendChild(skeleton('doc'));
  host.setLoading(tab, true);
  const controller = new AbortController();
  tab.controller = controller;

  try {
    const payload = await gemini.generateJSON(pagePrompt(url), { system: PAGE_SYSTEM, signal: controller.signal });
    if (tab.nav !== nav) return;
    const document_ = normaliseDocument(payload, url);
    putCachedPage(url, document_);
    clear(body);
    paintDocument(tab, doc, body, document_, url, host);
  } catch (err) {
    if (tab.nav !== nav) return;
    clear(body);
    body.appendChild(err && err.message === 'NO_API_KEY' ? keyCard(host) : failureCard(host, err));
    host.setTitle(tab, prettyUrl(url));
  } finally {
    if (tab.nav === nav) {
      tab.controller = null;
      host.setLoading(tab, false);
    }
  }
}
