/**
 * js/apps/firefox/live-search.js — a real search engine results page.
 *
 * There is no such thing as a keyless, CORS-enabled Google or Bing endpoint, so
 * this page uses the two public APIs that genuinely answer a cross-origin
 * `fetch` from any origin:
 *
 *   DuckDuckGo Instant Answer   https://api.duckduckgo.com/?q=…&format=json
 *   Wikipedia search + summary  https://<lang>.wikipedia.org/w/api.php?…&origin=*
 *
 * Both were verified to return `Access-Control-Allow-Origin: *`. The Wikipedia
 * subdomain follows `navigator.language`, so a Korean query searches
 * ko.wikipedia.org and falls back to English when that finds nothing.
 *
 * Google is offered honestly: a labelled button that opens the real thing in a
 * real browser tab, because Google can neither be fetched cross-origin nor
 * framed.
 *
 * SAFETY: every field that arrives from the network — titles, snippets,
 * abstracts, URLs — is written with `textContent` through `h({ text })`. No
 * network string is ever routed to `innerHTML`, and no URL from a response is
 * used to fetch anything else.
 */

import { h, clear } from '../../core/dom.js';
import { fxIcon, faviconChip, hostOf, prettyUrl, button, liveNotice } from './pages.js';
import { breadcrumb, getCachedLiveSearch, putCachedLiveSearch } from './data.js';
import { t, uiLang, openExternal, openExternalButton } from './live.js';

/** Endpoints time out rather than leaving the page spinning forever. */
const FETCH_TIMEOUT_MS = 9000;

/* =============================================================== fetching = */

/**
 * `fetch` with a deadline, honouring the tab's own abort signal as well.
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<any>} parsed JSON
 */
async function fetchJson(url, signal) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const relay = () => controller.abort();
  if (signal) signal.addEventListener('abort', relay);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

/**
 * Wikipedia language edition to search, taken from the desktop's language.
 * @returns {string}
 */
export function wikiLang() {
  return uiLang();
}

/** Strip the `<span class="searchmatch">` markup MediaWiki puts in snippets. */
function plainText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DuckDuckGo's instant answer for a query.
 * @param {string} query
 * @param {AbortSignal} signal
 * @returns {Promise<{heading:string, abstract:string, source:string, url:string,
 *                    answer:string, results:object[], related:object[]}|null>}
 */
export async function fetchDuckDuckGo(query, signal) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const data = await fetchJson(url, signal);
  if (!data || typeof data !== 'object') return null;

  const topics = [];
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.Topics)) {
        walk(item.Topics);
        continue;
      }
      const text = plainText(item.Text);
      const link = String(item.FirstURL || '');
      if (text !== '' && /^https?:\/\//i.test(link)) topics.push({ text, url: link });
    }
  };
  walk(data.RelatedTopics);

  const results = (Array.isArray(data.Results) ? data.Results : [])
    .filter((item) => item && typeof item === 'object' && /^https?:\/\//i.test(String(item.FirstURL || '')))
    .map((item) => ({ text: plainText(item.Text), url: String(item.FirstURL) }));

  return {
    heading: plainText(data.Heading),
    abstract: plainText(data.AbstractText || data.Abstract),
    source: plainText(data.AbstractSource),
    url: /^https?:\/\//i.test(String(data.AbstractURL || '')) ? String(data.AbstractURL) : '',
    answer: plainText(data.Answer),
    answerType: plainText(data.AnswerType),
    definition: plainText(data.Definition),
    definitionUrl: /^https?:\/\//i.test(String(data.DefinitionURL || '')) ? String(data.DefinitionURL) : '',
    results: results.slice(0, 3),
    related: topics.slice(0, 8),
  };
}

/**
 * Wikipedia full-text search in one language edition.
 * @param {string} query
 * @param {string} lang
 * @param {AbortSignal} signal
 * @returns {Promise<{lang:string, hits:object[]}>}
 */
export async function fetchWikipedia(query, lang, signal) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    '&format=json&origin=*&srlimit=8&srprop=snippet%7Cwordcount%7Ctimestamp';
  const data = await fetchJson(url, signal);
  const search = data && data.query && Array.isArray(data.query.search) ? data.query.search : [];
  const hits = search
    .filter((item) => item && typeof item.title === 'string')
    .map((item) => ({
      title: item.title,
      snippet: plainText(item.snippet),
      words: Number.isFinite(item.wordcount) ? item.wordcount : 0,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/ /g, '_'))}`,
    }));
  return { lang, hits };
}

/**
 * REST summary of one article, used as the instant answer when DuckDuckGo has
 * no abstract for the query.
 * @param {string} title
 * @param {string} lang
 * @param {AbortSignal} signal
 * @returns {Promise<{title:string, extract:string, url:string}|null>}
 */
export async function fetchWikiSummary(title, lang, signal) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;
  const data = await fetchJson(url, signal);
  if (!data || typeof data !== 'object' || typeof data.extract !== 'string') return null;
  const page =
    data.content_urls && data.content_urls.desktop && typeof data.content_urls.desktop.page === 'string'
      ? data.content_urls.desktop.page
      : `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;
  return { title: plainText(data.title) || String(title), extract: plainText(data.extract), url: page };
}

/**
 * DuckDuckGo's endpoint rate-limits bursts and then simply drops the request,
 * which surfaces as a `TypeError: Failed to fetch`. One retry after a short
 * pause recovers most of those.
 * @param {string} query
 * @param {AbortSignal} signal
 * @returns {Promise<object|null>}
 */
async function fetchDuckDuckGoTwice(query, signal) {
  try {
    return await fetchDuckDuckGo(query, signal);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    return fetchDuckDuckGo(query, signal);
  }
}

/**
 * Ask Ubuntu (and Stack Overflow) through the Stack Exchange API.
 *
 * This is the single most useful engine for this desktop: the questions people
 * actually ask about Ubuntu live here, and the API is keyless, CORS-enabled and
 * returns real ranked results. The anonymous quota is ~300 requests/day/IP;
 * `quota_remaining` comes back on every response, so a caller can see it drain.
 *
 * @param {string} query
 * @param {AbortSignal} signal
 * @returns {Promise<{site:string, hits:object[], quota:number}>}
 */
export async function fetchStackExchange(query, signal) {
  // Ubuntu-flavoured queries belong on askubuntu; everything else is more
  // likely to be answered on Stack Overflow.
  const site = /\b(ubuntu|apt|dpkg|snap|gnome|unity|grub|systemd|debian)\b/i.test(query)
    ? 'askubuntu'
    : 'stackoverflow';
  const url =
    'https://api.stackexchange.com/2.3/search/advanced' +
    `?order=desc&sort=relevance&q=${encodeURIComponent(query)}` +
    `&site=${site}&pagesize=5&filter=default`;

  const data = await fetchJson(url, signal);
  const hits = (Array.isArray(data.items) ? data.items : []).map((item) => ({
    // The API returns HTML entities in titles (&#39; and friends); plainText
    // decodes them safely, and every field is rendered with textContent later.
    title: plainText(item.title),
    url: String(item.link || ''),
    score: Number(item.score) || 0,
    answers: Number(item.answer_count) || 0,
    accepted: Boolean(item.is_answered),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
  }));
  return { site, hits, quota: Number(data.quota_remaining) || 0 };
}

/**
 * Hacker News via the Algolia index — keyless, CORS-enabled, and a good source
 * of discussion links that Wikipedia cannot provide.
 *
 * @param {string} query
 * @param {AbortSignal} signal
 * @returns {Promise<{hits: object[], total: number}>}
 */
export async function fetchHackerNews(query, signal) {
  const url =
    'https://hn.algolia.com/api/v1/search' +
    `?query=${encodeURIComponent(query)}&hitsPerPage=5&tags=story`;
  const data = await fetchJson(url, signal);
  const hits = (Array.isArray(data.hits) ? data.hits : [])
    .filter((hit) => hit && (hit.title || hit.story_title))
    .map((hit) => ({
      title: plainText(hit.title || hit.story_title),
      // Ask HN posts carry no external url; fall back to the discussion.
      url: String(hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`),
      points: Number(hit.points) || 0,
      comments: Number(hit.num_comments) || 0,
      author: String(hit.author || ''),
    }));
  return { hits, total: Number(data.nbHits) || 0 };
}

/**
 * Run every engine for one query. Engines fail independently: a dead
 * DuckDuckGo still leaves the Wikipedia column, and the reverse.
 * @param {string} query
 * @param {AbortSignal} signal
 * @returns {Promise<object>}
 */
export async function runSearch(query, signal) {
  const lang = wikiLang();
  const [ddgOutcome, wikiOutcome, seOutcome, hnOutcome] = await Promise.allSettled([
    fetchDuckDuckGoTwice(query, signal),
    fetchWikipedia(query, lang, signal),
    fetchStackExchange(query, signal),
    fetchHackerNews(query, signal),
  ]);

  const ddg = ddgOutcome.status === 'fulfilled' ? ddgOutcome.value : null;
  const se = seOutcome.status === 'fulfilled' ? seOutcome.value : null;
  const hn = hnOutcome.status === 'fulfilled' ? hnOutcome.value : null;
  let wiki = wikiOutcome.status === 'fulfilled' ? wikiOutcome.value : { lang, hits: [] };

  if (wiki.hits.length === 0 && lang !== 'en') {
    try {
      wiki = await fetchWikipedia(query, 'en', signal);
    } catch {
      /* keep the empty result */
    }
  }

  let summary = null;
  const noAbstract = !ddg || (ddg.abstract === '' && ddg.answer === '' && ddg.definition === '');
  if (noAbstract && wiki.hits.length > 0) {
    try {
      summary = await fetchWikiSummary(wiki.hits[0].title, wiki.lang, signal);
    } catch {
      summary = null;
    }
  }

  return {
    query,
    ddg,
    wiki,
    se,
    hn,
    summary,
    // "Failed" means the user got nothing at all. Any one engine surviving is
    // a usable result page, so only flag failure when every engine is down.
    failed:
      ddgOutcome.status === 'rejected' &&
      wikiOutcome.status === 'rejected' &&
      seOutcome.status === 'rejected' &&
      hnOutcome.status === 'rejected',
    ddgError: ddgOutcome.status === 'rejected' ? String(ddgOutcome.reason && ddgOutcome.reason.message) : '',
    wikiError: wikiOutcome.status === 'rejected' ? String(wikiOutcome.reason && wikiOutcome.reason.message) : '',
    seError: seOutcome.status === 'rejected' ? String(seOutcome.reason && seOutcome.reason.message) : '',
    hnError: hnOutcome.status === 'rejected' ? String(hnOutcome.reason && hnOutcome.reason.message) : '',
  };
}

/* =============================================================== painting = */

/**
 * One clickable result. The title navigates inside the app; the small button
 * next to it opens the genuine site in a real tab, which is the only thing
 * that works for a site that refuses framing.
 * @param {{title:string, url:string, description:string}} item
 * @param {object} host
 * @returns {HTMLElement}
 */
function resultRow(item, host) {
  const row = h('div.fx-result');
  row.appendChild(
    h(
      'div.fx-result-head',
      {},
      faviconChip(item.url, { size: 24 }),
      h(
        'div.fx-result-ident',
        {},
        h('span.fx-result-site', { text: hostOf(item.url).replace(/^www\./, '') }),
        h('span.fx-result-url', { text: breadcrumb(item.url) })
      ),
      h(
        'button.fx-result-ext',
        {
          type: 'button',
          title: t('실제 브라우저 탭에서 열기', 'Open in a real browser tab'),
          'aria-label': t('실제 브라우저 탭에서 열기', 'Open in a real browser tab'),
          on: { click: () => openExternal(item.url) },
        },
        fxIcon('external', 15)
      )
    )
  );
  row.appendChild(
    h('button.fx-result-title', {
      type: 'button',
      title: item.url,
      text: item.title,
      on: { click: () => host.navigate(item.url) },
    })
  );
  if (item.description) row.appendChild(h('p.fx-result-desc', { text: item.description }));
  return row;
}

/**
 * The instant-answer card: DuckDuckGo's abstract, its calculated Answer, or a
 * Wikipedia summary — whichever the engines actually returned.
 * @param {object} data
 * @param {object} host
 * @returns {HTMLElement|null}
 */
function answerCard(data, host) {
  const ddg = data.ddg;
  const summary = data.summary;

  let title = '';
  let body = '';
  let url = '';
  let source = '';

  if (ddg && ddg.answer !== '') {
    title = ddg.heading || data.query;
    body = ddg.answer;
    source = ddg.answerType ? `DuckDuckGo · ${ddg.answerType}` : 'DuckDuckGo';
    url = ddg.url;
  } else if (ddg && ddg.abstract !== '') {
    title = ddg.heading || data.query;
    body = ddg.abstract;
    source = ddg.source ? `DuckDuckGo · ${ddg.source}` : 'DuckDuckGo';
    url = ddg.url;
  } else if (ddg && ddg.definition !== '') {
    title = ddg.heading || data.query;
    body = ddg.definition;
    source = 'DuckDuckGo';
    url = ddg.definitionUrl;
  } else if (summary && summary.extract !== '') {
    title = summary.title;
    body = summary.extract;
    source = `Wikipedia (${data.wiki.lang})`;
    url = summary.url;
  }

  if (body === '') return null;

  const card = h('section.fx-answer');
  card.appendChild(
    h(
      'div.fx-answer-head',
      {},
      fxIcon('info', 16, { class: 'fx-answer-icon' }),
      h('span.fx-answer-source', { text: source })
    )
  );
  card.appendChild(h('h2.fx-answer-title', { text: title }));
  card.appendChild(h('p.fx-answer-body', { text: body }));
  if (url !== '') {
    card.appendChild(
      h(
        'div.fx-answer-actions',
        {},
        h('button.fx-link', {
          type: 'button',
          title: url,
          text: t('출처 열기', 'Open the source'),
          on: { click: () => host.navigate(url) },
        }),
        h('span.fx-answer-url', { text: prettyUrl(url) })
      )
    );
  }
  return card;
}

/**
 * Paint a completed search into the results list.
 * @param {HTMLElement} list
 * @param {HTMLElement} stat
 * @param {object} data
 * @param {number} ms
 * @param {object} host
 */
function paint(list, stat, data, ms, host) {
  clear(list);

  const wikiCount = data.wiki.hits.length;
  const ddgCount = data.ddg ? data.ddg.results.length + data.ddg.related.length : 0;
  const seCount = data.se ? data.se.hits.length : 0;
  const hnCount = data.hn ? data.hn.hits.length : 0;
  const total = ddgCount + wikiCount + seCount + hnCount;

  // Name only the engines that actually contributed, so the byline never
  // credits a source that returned nothing.
  const engines = [];
  if (wikiCount) engines.push(`Wikipedia(${data.wiki.lang})`);
  if (seCount) engines.push(data.se.site === 'askubuntu' ? 'Ask Ubuntu' : 'Stack Overflow');
  if (hnCount) engines.push('Hacker News');
  if (ddgCount) engines.push('DuckDuckGo');

  stat.textContent =
    t(`실제 결과 ${total}건`, `${total} real results`) +
    (engines.length ? ` · ${engines.join(' + ')}` : '') +
    (ms > 0 ? ` · ${(ms / 1000).toFixed(2)}s` : ` · ${t('캐시', 'cached')}`);

  const answer = answerCard(data, host);
  if (answer) list.appendChild(answer);

  if (data.ddg && data.ddg.results.length) {
    const section = h('section.fx-lsec', {}, h('h2.fx-lsec-title', { text: t('공식 사이트', 'Official site') }));
    for (const item of data.ddg.results) {
      section.appendChild(resultRow({ title: item.text || prettyUrl(item.url), url: item.url, description: '' }, host));
    }
    list.appendChild(section);
  }

  if (wikiCount) {
    const section = h(
      'section.fx-lsec',
      {},
      h('h2.fx-lsec-title', { text: `Wikipedia (${data.wiki.lang}.wikipedia.org)` }),
      h('p.fx-lsec-note', {
        text: t(
          'Wikipedia는 삽입을 허용하므로, 아래 결과는 이 브라우저 안에서 그대로 열립니다.',
          'Wikipedia allows framing, so these open inside this browser for real.'
        ),
      })
    );
    for (const hit of data.wiki.hits) {
      section.appendChild(resultRow({ title: hit.title, url: hit.url, description: hit.snippet }, host));
    }
    list.appendChild(section);
  }

  if (seCount) {
    const isAsk = data.se.site === 'askubuntu';
    const section = h(
      'section.fx-lsec',
      {},
      h('h2.fx-lsec-title', { text: isAsk ? 'Ask Ubuntu' : 'Stack Overflow' }),
      h('p.fx-lsec-note', {
        text: t(
          '실제 질문·답변입니다. 이 사이트는 삽입을 거부하므로 제목을 누르면 진짜 탭에서 열립니다.',
          'Real questions and answers. The site refuses framing, so the title opens in a real tab.'
        ),
      })
    );
    for (const hit of data.se.hits) {
      const meta = t(
        `추천 ${hit.score} · 답변 ${hit.answers}${hit.accepted ? ' · 채택됨' : ''}`,
        `${hit.score} votes · ${hit.answers} answers${hit.accepted ? ' · answered' : ''}`
      );
      const tags = hit.tags.length ? ` · ${hit.tags.join(', ')}` : '';
      section.appendChild(resultRow({ title: hit.title, url: hit.url, description: meta + tags }, host));
    }
    list.appendChild(section);
  }

  if (hnCount) {
    const section = h(
      'section.fx-lsec',
      {},
      h('h2.fx-lsec-title', { text: 'Hacker News' }),
      h('p.fx-lsec-note', {
        text: t(
          `Algolia 색인에서 ${data.hn.total.toLocaleString()}건 중 상위 결과입니다.`,
          `Top hits out of ${data.hn.total.toLocaleString()} in the Algolia index.`
        ),
      })
    );
    for (const hit of data.hn.hits) {
      const meta = t(
        `${hit.points}점 · 댓글 ${hit.comments}${hit.author ? ` · ${hit.author}` : ''}`,
        `${hit.points} points · ${hit.comments} comments${hit.author ? ` · ${hit.author}` : ''}`
      );
      section.appendChild(resultRow({ title: hit.title, url: hit.url, description: meta }, host));
    }
    list.appendChild(section);
  }

  if (data.ddg && data.ddg.related.length) {
    const section = h('section.fx-lsec', {}, h('h2.fx-lsec-title', { text: t('관련 주제', 'Related topics') }));
    const chips = h('div.fx-related-chips');
    for (const topic of data.ddg.related) {
      chips.appendChild(
        h(
          'button.fx-chip',
          { type: 'button', title: topic.url, on: { click: () => host.navigate(topic.url) } },
          fxIcon('globe', 14),
          h('span', { text: topic.text })
        )
      );
    }
    section.appendChild(chips);
    list.appendChild(section);
  }

  if (!answer && total === 0) {
    list.appendChild(
      h(
        'div.fx-lsearch-empty',
        {},
        fxIcon('search', 28, { class: 'fx-empty-icon' }),
        h('p.fx-empty-title', { text: t('결과가 없습니다', 'No results') }),
        h('p.fx-empty-body', {
          text: t(
            'Wikipedia, Ask Ubuntu, Hacker News 어디에도 이 검색어에 대한 항목이 없습니다. Google 버튼으로 진짜 구글에서 검색해 보세요.',
            'Wikipedia, Ask Ubuntu and Hacker News have nothing for this query. The Google button runs it on the real Google.'
          ),
        })
      )
    );
  }
}

/**
 * The failure card, shown when every engine failed (offline, blocked by a
 * corporate proxy, CORS turned off by an extension…).
 * @param {object} data
 * @param {string} query
 * @param {object} host
 * @returns {HTMLElement}
 */
function failureCard(data, query, host) {
  const detail = [data.ddgError, data.wikiError, data.seError, data.hnError]
    .filter((x) => x && x !== 'undefined')
    .join(' · ');
  return h(
    'div.fx-failcard',
    {},
    fxIcon('warning', 24, { class: 'fx-failcard-icon' }),
    h(
      'div.fx-failcard-body',
      {},
      h('h2.fx-failcard-title', { text: t('검색 요청이 실패했습니다', 'The search request failed') }),
      h('p.fx-failcard-text', {
        text:
          t(
            'DuckDuckGo와 Wikipedia 양쪽 모두 응답하지 않았습니다. 네트워크가 끊겼거나 요청이 차단되었을 수 있습니다.',
            'Neither DuckDuckGo nor Wikipedia answered. This machine may be offline, or the requests may be blocked.'
          ) + (detail ? ` (${detail})` : ''),
      }),
      h(
        'div.fx-block-actions',
        {},
        button(t('다시 시도', 'Try again'), () => host.reload(), { icon: 'reload', variant: 'primary' }),
        openExternalButton(`https://www.google.com/search?q=${encodeURIComponent(query)}`, {
          label: t('Google에서 검색', 'Search on Google'),
          variant: 'quiet',
        })
      )
    )
  );
}

/* ============================================================ entry point = */

/**
 * Render `web:search?q=…` into a tab with genuine network results.
 * @param {object} tab
 * @param {string} query
 * @param {object} host
 * @returns {Promise<void>}
 */
export async function renderLiveSearchPage(tab, query, host) {
  const nav = tab.nav;
  const page = h('div.fx-page.fx-serp.fx-lsearch');
  tab.canReader = false;

  const field = h('input.fx-serp-input', {
    type: 'text',
    value: query,
    'aria-label': t('웹 검색', 'Search the web'),
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const submit = () => {
    const next = field.value.trim();
    if (next !== '') host.search(next);
  };
  field.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    submit();
  });

  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  page.appendChild(
    h(
      'div.fx-serp-head',
      {},
      h('div.fx-serp-brand', {}, fxIcon('search', 18), h('span', { text: 'DuckDuckGo + Wikipedia' })),
      h(
        'div.fx-serp-field',
        {},
        field,
        h('button.fx-start-go', { type: 'button', text: t('검색', 'Search'), on: { click: submit } })
      ),
      h(
        'div.fx-serp-engines',
        {},
        openExternalButton(googleUrl, { label: t('Google에서 검색', 'Search on Google'), variant: 'quiet' }),
        openExternalButton(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
          label: t('DuckDuckGo에서 열기', 'Open on DuckDuckGo'),
          variant: 'quiet',
        })
      )
    )
  );
  page.appendChild(
    liveNotice(
      t(
        '이 결과는 DuckDuckGo 인스턴트 응답 API와 Wikipedia 검색 API에서 실시간으로 받아온 진짜 데이터입니다. Google과 Bing은 키 없이 교차 출처 요청을 허용하지 않으므로, 구글 결과는 위의 “Google에서 검색” 버튼으로 진짜 탭에서 열어야 합니다.',
        'These results come live from the DuckDuckGo Instant Answer API and the Wikipedia search API. Google and Bing allow neither keyless cross-origin requests nor framing, so their results open in a real browser tab through the button above.'
      )
    )
  );

  const stat = h('div.fx-serp-stat', { text: t('검색 중…', 'Searching…') });
  const list = h('div.fx-serp-list');
  page.appendChild(stat);
  page.appendChild(list);
  tab.view.appendChild(page);

  const cached = getCachedLiveSearch(query);
  if (cached) {
    paint(list, stat, cached, 0, host);
    return;
  }

  const skeleton = h('div.fx-skel', { 'aria-busy': 'true', 'aria-label': 'Loading' });
  for (const width of ['42%', '96%', '88%', null, '36%', '92%', '80%', null, '38%', '90%']) {
    skeleton.appendChild(width === null ? h('div.fx-skel-gap') : h('div.fx-skel-line', { style: { width } }));
  }
  list.appendChild(skeleton);

  const controller = new AbortController();
  tab.controller = controller;
  host.setLoading(tab, true);
  const started = performance.now();

  try {
    const data = await runSearch(query, controller.signal);
    if (tab.nav !== nav) return;
    if (data.failed) {
      clear(list);
      stat.textContent = t('검색 실패', 'Search failed');
      list.appendChild(failureCard(data, query, host));
      return;
    }
    putCachedLiveSearch(query, data);
    paint(list, stat, data, performance.now() - started, host);
  } catch (err) {
    if (tab.nav !== nav) return;
    clear(list);
    stat.textContent = t('검색 실패', 'Search failed');
    list.appendChild(
      failureCard({ ddgError: err && err.message ? err.message : String(err), wikiError: '' }, query, host)
    );
  } finally {
    if (tab.nav === nav) {
      tab.controller = null;
      host.setLoading(tab, false);
    }
  }
}
