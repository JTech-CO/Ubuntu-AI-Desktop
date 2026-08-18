/**
 * js/apps/firefox/live-youtube.js — a working YouTube page inside the browser.
 *
 * youtube.com itself refuses to be framed, so a watch page cannot simply be
 * embedded. What genuinely does work — and is what this page is built on — is
 * YouTube's own privacy-enhanced player:
 *
 *     https://www.youtube-nocookie.com/embed/<VIDEO_ID>
 *
 * That URL sends no frame-blocking header, so the video really plays here,
 * fullscreen included.
 *
 * Searching is the honest gap. The YouTube Data API needs a key, and this
 * project never ships one, so the search button opens the real YouTube search
 * in a real browser tab. The same field also accepts a pasted link or a bare
 * video id and plays it inline immediately, and a best-effort attempt is made
 * at YouTube's legacy `videoseries?listType=search` embed, which frequently
 * refuses — when it does, the page says so rather than showing a dead frame.
 *
 * SAFETY: video ids are validated against `[A-Za-z0-9_-]{11}` before they are
 * ever put in a URL, titles are inserted with `textContent`, and nothing is
 * written into any frame.
 */

import { h, clear } from '../../core/dom.js';
import { fxIcon, liveNotice } from './pages.js';
import { t, openExternalButton, copyLinkButton, extractVideoId } from './live.js';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Well-known videos, so the player is obviously working on first use. Each id
 * was checked against YouTube's oEmbed endpoint while this module was written.
 */
export const CURATED = Object.freeze([
  { id: 'jNQXAC9IVRw', title: 'Me at the zoo', channel: 'jawed', note: 'The first video ever uploaded to YouTube' },
  { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny 60fps 4K', channel: 'Blender', note: 'Blender Foundation open movie' },
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channel: 'Rick Astley', note: '4K remaster' },
  { id: '9bZkp7q19f0', title: 'GANGNAM STYLE (강남스타일)', channel: 'officialpsy', note: 'PSY' },
  { id: 'kJQP7kiw5Fk', title: 'Despacito', channel: 'LuisFonsiVEVO', note: 'Luis Fonsi ft. Daddy Yankee' },
  { id: 'LXb3EKWsInQ', title: 'Costa Rica in 4K 60fps HDR', channel: 'Jacob + Katie Schwarz', note: 'Ultra HD scenery' },
]);

const CURATED_BY_ID = new Map(CURATED.map((item) => [item.id, item]));

/**
 * Embed URL for one video. The id is validated first, so nothing that is not
 * an id can be spliced into the address.
 * @param {string} videoId
 * @returns {string} '' when the id is not valid
 */
export function embedUrl(videoId) {
  const id = String(videoId || '').trim();
  if (!VIDEO_ID_RE.test(id)) return '';
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1`;
}

/**
 * The best-effort inline search-playback embed. YouTube deprecated
 * `listType=search` years ago and it often refuses to load; the caller must
 * have a fallback, and this page does.
 * @param {string} query
 * @returns {string}
 */
export function searchEmbedUrl(query) {
  return `https://www.youtube-nocookie.com/embed/videoseries?listType=search&list=${encodeURIComponent(String(query).trim())}`;
}

/** @param {string} videoId @returns {string} canonical watch URL */
export function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The player frame. `allow` carries exactly the permissions YouTube's embed
 * documents, which is what makes playback and fullscreen work.
 * @param {string} src
 * @param {string} title
 * @returns {HTMLIFrameElement}
 */
function playerFrame(src, title) {
  return h('iframe.fx-yt-frame', {
    src,
    title,
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation',
    referrerpolicy: 'no-referrer-when-downgrade',
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
    allowfullscreen: true,
  });
}

/**
 * Thumbnail tile for a curated video.
 * @param {object} item
 * @param {object} host
 * @returns {HTMLElement}
 */
function videoCard(item, host) {
  const thumb = h('img.fx-yt-thumb', {
    src: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
  });
  thumb.addEventListener('error', () => {
    thumb.remove();
  });

  return h(
    'button.fx-yt-card',
    {
      type: 'button',
      title: watchUrl(item.id),
      on: { click: () => host.navigate(watchUrl(item.id)) },
    },
    h('span.fx-yt-thumbwrap', {}, thumb, h('span.fx-yt-play', {}, fxIcon('play', 20, { filled: true }))),
    h('span.fx-yt-card-title', { text: item.title }),
    h('span.fx-yt-card-meta', { text: `${item.channel} · ${item.note}` })
  );
}

/**
 * The YouTube-red wordmark, drawn rather than fetched.
 * @returns {HTMLElement}
 */
function ytBrand() {
  return h(
    'div.fx-yt-brand',
    {},
    h(
      'svg',
      { viewBox: '0 0 28 20', width: 28, height: 20, 'aria-hidden': 'true', focusable: 'false' },
      h('rect', { x: 0, y: 0, width: 28, height: 20, rx: 5, fill: '#ff0000' }),
      h('path', { d: 'M11 5.6 19 10l-8 4.4z', fill: '#ffffff' })
    ),
    h('span.fx-yt-word', { text: 'YouTube' })
  );
}

/**
 * Header: the wordmark, a search field that doubles as a "paste a link" field,
 * and the button that opens the real site.
 * @param {object} view
 * @param {object} host
 * @returns {HTMLElement}
 */
function ytHeader(view, host) {
  const field = h('input.fx-yt-input', {
    type: 'text',
    value: view.kind === 'results' ? view.query : '',
    placeholder: t('검색어, 링크 또는 영상 ID', 'Search, or paste a link or video id'),
    'aria-label': t('YouTube 검색 또는 링크 붙여넣기', 'Search YouTube, or paste a link or video id'),
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const submit = () => {
    const value = field.value.trim();
    if (value === '') return;
    const id = extractVideoId(value);
    if (id) {
      host.navigate(watchUrl(id));
      return;
    }
    host.navigate(`https://www.youtube.com/results?search_query=${encodeURIComponent(value)}`);
  };

  field.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    submit();
  });

  const searchBtn = h(
    'button.fx-yt-searchbtn',
    { type: 'button', title: t('검색하거나 붙여넣은 링크를 재생합니다', 'Search, or play a pasted link'), on: { click: submit } },
    fxIcon('search', 16),
    h('span', { text: t('검색', 'Search') })
  );

  const externalTarget =
    view.kind === 'watch'
      ? watchUrl(view.videoId)
      : view.kind === 'results'
        ? `https://www.youtube.com/results?search_query=${encodeURIComponent(view.query)}`
        : 'https://www.youtube.com/';

  return h(
    'header.fx-yt-head',
    {},
    ytBrand(),
    h('div.fx-yt-searchwrap', {}, field, searchBtn),
    openExternalButton(externalTarget, { label: t('YouTube에서 열기', 'Open on YouTube'), variant: 'quiet' })
  );
}

/**
 * The watch view: a real, playing embed plus the metadata this app can state
 * truthfully without an API key.
 * @param {object} view
 * @returns {HTMLElement}
 */
function watchSection(view) {
  const known = CURATED_BY_ID.get(view.videoId);
  const src = embedUrl(view.videoId);
  const url = watchUrl(view.videoId);

  const section = h('section.fx-yt-watch');
  section.appendChild(h('div.fx-yt-player', {}, playerFrame(src, known ? known.title : `YouTube video ${view.videoId}`)));
  section.appendChild(
    h(
      'div.fx-yt-meta',
      {},
      h('h1.fx-yt-title', { text: known ? known.title : t(`YouTube 영상 ${view.videoId}`, `YouTube video ${view.videoId}`) }),
      h('p.fx-yt-sub', {
        text: known
          ? `${known.channel} · ${known.note}`
          : t(
              '영상 제목과 채널은 YouTube Data API 키가 있어야 읽을 수 있습니다. 재생 자체는 실제 플레이어에서 이루어집니다.',
              'Reading a title and channel needs a YouTube Data API key. The playback itself is the genuine player.'
            ),
      }),
      h(
        'div.fx-yt-actions',
        {},
        openExternalButton(url, { label: t('YouTube에서 열기', 'Watch on YouTube'), variant: 'quiet' }),
        copyLinkButton(url),
        h('span.fx-yt-id', { text: `ID: ${view.videoId}` })
      )
    )
  );
  return section;
}

/**
 * The results view: the deprecated inline-search embed, attempted honestly,
 * with a fallback panel that appears when it does not load.
 * @param {object} view
 * @returns {HTMLElement}
 */
function resultsSection(view) {
  const query = view.query;
  const externalSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const section = h('section.fx-yt-watch');

  const player = h('div.fx-yt-player');
  const frame = playerFrame(searchEmbedUrl(query), `YouTube search: ${query}`);
  player.appendChild(frame);

  const fallback = h(
    'div.fx-yt-fallback',
    { hidden: true },
    fxIcon('warning', 22, { class: 'fx-yt-fallback-icon' }),
    h('div', {}, h('p.fx-yt-fallback-title', { text: t('인라인 검색 재생이 로드되지 않았습니다', 'Inline search playback did not load') }),
      h('p.fx-yt-fallback-body', {
        text: t(
          'YouTube의 legacy 검색 재생목록 임베드(listType=search)는 오래전에 지원이 중단되어 자주 거부됩니다. 아래 버튼으로 진짜 YouTube 검색을 여세요.',
          "YouTube's legacy search-playlist embed (listType=search) was deprecated long ago and often refuses. Use the button below to open the real YouTube search."
        ),
      })),
    openExternalButton(externalSearch, { label: t('YouTube에서 검색', 'Search on YouTube'), variant: 'primary' })
  );

  let settled = false;
  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    fallback.hidden = false;
  }, 4000);
  frame.addEventListener('load', () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
  });

  section.appendChild(player);
  section.appendChild(fallback);
  section.appendChild(
    h(
      'div.fx-yt-meta',
      {},
      h('h1.fx-yt-title', { text: t(`“${query}” 검색`, `Search: ${query}`) }),
      h('p.fx-yt-sub', {
        text: t(
          'YouTube 검색 결과 목록은 API 키가 필요하므로 이 앱에서는 만들 수 없습니다. 위 플레이어는 YouTube의 legacy 검색 임베드를 시도한 것이고, 링크나 영상 ID를 붙여넣으면 바로 여기서 재생됩니다.',
          'A real result list needs an API key, so this app cannot build one. The player above attempts YouTube\'s legacy search embed; pasting a link or a video id plays it here immediately.'
        ),
      }),
      h(
        'div.fx-yt-actions',
        {},
        openExternalButton(externalSearch, { label: t('YouTube에서 검색', 'Search on YouTube'), variant: 'quiet' }),
        openExternalButton(`https://www.google.com/search?q=${encodeURIComponent(`youtube ${query}`)}`, {
          label: t('Google에서 검색', 'Search on Google'),
          variant: 'quiet',
        })
      )
    )
  );
  return section;
}

/**
 * Render a YouTube address into a tab.
 *
 * @param {object} tab the browser tab record from `index.js`
 * @param {{kind:'watch'|'results'|'home', videoId:string, query:string}} view
 * @param {object} host the content host callbacks from `index.js`
 */
export function renderYouTubePage(tab, view, host) {
  const page = h('div.fx-page.fx-yt');
  tab.canReader = false;

  page.appendChild(
    liveNotice(
      t(
        'YouTube 워치 페이지 자체는 삽입이 거부되지만, YouTube의 개인정보 보호 강화 플레이어(youtube-nocookie.com/embed)는 허용됩니다. 아래 영상은 진짜로 재생됩니다.',
        "YouTube's own pages refuse to be framed, but its privacy-enhanced player (youtube-nocookie.com/embed) allows it. The video below really plays."
      )
    )
  );
  page.appendChild(ytHeader(view, host));

  if (view.kind === 'watch' && embedUrl(view.videoId) !== '') {
    page.appendChild(watchSection(view));
    host.setTitle(tab, (CURATED_BY_ID.get(view.videoId) || {}).title || `YouTube · ${view.videoId}`);
  } else if (view.kind === 'results') {
    page.appendChild(resultsSection(view));
    host.setTitle(tab, `${view.query} — YouTube`);
  } else {
    host.setTitle(tab, 'YouTube');
  }

  const grid = h('div.fx-yt-grid');
  for (const item of CURATED) grid.appendChild(videoCard(item, host));

  page.appendChild(
    h(
      'section.fx-yt-shelf',
      {},
      h('h2.fx-yt-shelf-title', { text: t('바로 재생되는 영상', 'One-click demos that really play') }),
      h('p.fx-yt-shelf-note', {
        text: t(
          '아래 영상들은 실제 YouTube 플레이어로 재생됩니다. 주소창에 youtube.com/watch?v=… 링크나 youtu.be 링크, 또는 11자리 영상 ID를 입력해도 됩니다.',
          'These play in the genuine YouTube player. The address bar also accepts a youtube.com/watch?v=… link, a youtu.be link, or a bare 11-character video id.'
        ),
      }),
      grid
    )
  );

  clear(tab.view);
  tab.view.appendChild(page);
  host.setLoading(tab, false);
  if (host.isActive(tab)) host.updateChrome();
}
