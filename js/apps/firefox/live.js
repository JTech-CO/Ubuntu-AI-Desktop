/**
 * js/apps/firefox/live.js — real web browsing for Firefox.
 *
 * This module loads genuine pages. It does that the only way a page inside a
 * browser tab can: an `<iframe>`. That has hard limits, and the code below
 * respects them rather than papering over them.
 *
 *   - Most large sites send `X-Frame-Options: DENY/SAMEORIGIN` or a CSP
 *     `frame-ancestors` directive, so they simply refuse to appear. Google,
 *     YouTube watch pages, most news sites and every social network do.
 *   - The refusal cannot be *read*: the frame is cross-origin, so its document
 *     is not reachable from here. Detection is therefore a heuristic — start a
 *     timer on navigation, clear it in the frame's `load` event, and treat a
 *     `load` that never arrives as a block.
 *   - A blocked frame sometimes *does* fire `load`, with an empty
 *     about:blank-ish document. That case is caught by probing the frame for
 *     same-origin access: a readable empty document means the load was refused,
 *     while a `SecurityError` (or a null `contentDocument`, which is what
 *     Chromium returns) means real cross-origin content is in there.
 *   - Chromium makes a refused frame indistinguishable from a loaded one after
 *     `load` fires, so hosts whose real headers were checked and found to
 *     forbid framing get the interstitial immediately instead of a blank
 *     rectangle, and any host seen to time out is remembered for the session.
 *   - Because the deadline can also punish a merely slow site, the frame is
 *     hidden rather than destroyed when it expires: a `load` that arrives late
 *     takes the screen back and the host is un-remembered.
 *   - When the page itself is served over https, an `http://` target is
 *     blocked as mixed content before a request is ever made. That is checked
 *     up front and reported as its own case.
 *
 * When a site refuses, the browser says so and offers the two things that do
 * work: opening it in a real browser tab, and copying the link. It never
 * pretends the emulator rendered the page.
 *
 * SAFETY: nothing is ever injected into a frame, no frame document is read
 * beyond the one-bit same-origin probe, and every string that comes from a URL
 * or from the network is inserted with `textContent` via `h({ text })`.
 */

import { h, clear } from '../../core/dom.js';
import { fxIcon, hostOf, prettyUrl, button } from './pages.js';

/* ================================================================ i18n === */

/**
 * The desktop's language, used for the handful of user-facing strings the
 * live-web pages show. Korean when the browser is Korean, English otherwise.
 * @returns {string} a BCP-47 primary subtag
 */
export function uiLang() {
  const raw = typeof navigator === 'object' && navigator ? navigator.language || '' : '';
  const tag = String(raw).toLowerCase().split('-')[0];
  return /^[a-z]{2,3}$/.test(tag) ? tag : 'en';
}

/**
 * Pick the Korean or the English string.
 * @param {string} ko
 * @param {string} en
 * @returns {string}
 */
export function t(ko, en) {
  return uiLang() === 'ko' ? ko : en;
}

/* ============================================================ utilities == */

/**
 * Open a real browser tab. `noopener` is mandatory: without it the opened page
 * gets a handle on this window through `window.opener`.
 * @param {string} url
 */
export function openExternal(url) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return;
  window.open(raw, '_blank', 'noopener,noreferrer');
}

/**
 * Copy text to the clipboard, with a fallback for browsers that refuse the
 * async API outside a secure context.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  const value = String(text || '');
  if (value === '') return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the textarea route */
  }
  try {
    const scratch = h('textarea', { value, 'aria-hidden': 'true', tabindex: '-1' });
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    scratch.style.pointerEvents = 'none';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * A button that copies a link and confirms it in place.
 * @param {string} url
 * @returns {HTMLButtonElement}
 */
export function copyLinkButton(url) {
  const label = t('링크 복사', 'Copy link');
  const btn = button(label, () => {
    copyText(url).then((ok) => {
      const span = btn.querySelector('span');
      if (!span) return;
      span.textContent = ok ? t('복사했습니다', 'Copied') : t('복사할 수 없습니다', 'Could not copy');
      window.setTimeout(() => {
        span.textContent = label;
      }, 1600);
    });
  }, { icon: 'copy', variant: 'quiet' });
  return btn;
}

/**
 * A button that opens the address in a genuine browser tab.
 * @param {string} url
 * @param {{label?:string, variant?:string}} [opts]
 * @returns {HTMLButtonElement}
 */
export function openExternalButton(url, opts = {}) {
  return button(opts.label || t('실제 브라우저 탭에서 열기', 'Open in a real browser tab'), () => openExternal(url), {
    icon: 'external',
    variant: opts.variant || 'primary',
    title: url,
  });
}

/** @returns {boolean} true when this desktop is itself served over https */
export function pageIsHttps() {
  return typeof location === 'object' && location && location.protocol === 'https:';
}

/**
 * Mixed content: an https page may not frame an http one, and the browser
 * blocks it before any request leaves.
 * @param {string} url
 * @returns {boolean}
 */
export function isMixedContent(url) {
  return pageIsHttps() && /^http:\/\//i.test(String(url || '').trim());
}

/**
 * Is this address served by the desktop's own origin?
 *
 * Such an address must never reach the frame, for two independent reasons:
 *
 *   1. **Sandbox escape.** The frame carries `allow-scripts allow-same-origin`,
 *      which real sites need to function. That pair is only safe while the
 *      framed document is cross-origin. A same-origin document with scripts
 *      enabled can reach `parent`/`top` directly and strip the `sandbox`
 *      attribute off its own frame element, so the sandbox stops being a
 *      boundary at all.
 *   2. **Recursive boot.** This desktop's own URL is same-origin, and framing
 *      it starts a second full desktop inside the first: two process tables,
 *      two sets of interval timers, and two writers racing on the same
 *      `uad:` localStorage keys, which corrupts the virtual filesystem.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSameOrigin(url) {
  const raw = String(url || '').trim();
  if (raw === '') return false;
  try {
    return new URL(raw, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/* ================================================ known frame refusers === */

/**
 * Hosts whose real responses were checked and carry `X-Frame-Options` or a
 * `frame-ancestors` directive that excludes this origin. They can never load
 * in a frame, so the browser skips the wait and shows the interstitial at once
 * instead of leaving the user staring at a blank rectangle.
 *
 * This is a fast path, not the whole detection: anything not listed still goes
 * through the load-timeout heuristic below.
 */
const KNOWN_FRAME_REFUSERS = Object.freeze([
  'youtube.com',
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'stackexchange.com',
  'askubuntu.com',
  'superuser.com',
  'serverfault.com',
  'facebook.com',
  'instagram.com',
  'threads.net',
  'x.com',
  'twitter.com',
  'reddit.com',
  'linkedin.com',
  'tiktok.com',
  'twitch.tv',
  'discord.com',
  'netflix.com',
  'developer.mozilla.org',
  'openstreetmap.org',
  'ubuntu.com',
  'canonical.com',
  'kernel.org',
  'debian.org',
  'manpages.ubuntu.com',
  'naver.com',
  'daum.net',
  'kakao.com',
  'tistory.com',
  'coupang.com',
  'amazon.com',
  'apple.com',
  'microsoft.com',
  'live.com',
  'paypal.com',
  'nytimes.com',
  'bbc.com',
  'bbc.co.uk',
  'cnn.com',
  'medium.com',
  'notion.so',
  'chatgpt.com',
  'openai.com',
  'anthropic.com',
  'claude.ai',
]);

/** Google runs on ~200 country domains, all of them `SAMEORIGIN`. */
const GOOGLE_HOST_RE = /(^|\.)google(\.[a-z]{2,3}){1,2}$/i;

/** Hosts this session watched time out. Learned once, remembered until reload. */
const observedRefusers = new Set();

/**
 * @param {string} url
 * @returns {boolean} true when the host is known to refuse being framed
 */
export function knownToRefuseFraming(url) {
  const host = hostOf(url);
  if (host === '') return false;
  const name = host.split(':')[0];
  if (GOOGLE_HOST_RE.test(name)) return true;
  if (observedRefusers.has(name)) return true;
  return KNOWN_FRAME_REFUSERS.some((entry) => name === entry || name.endsWith(`.${entry}`));
}

/**
 * Remember that a host never produced a frame load, so the next visit is
 * immediate instead of waiting for the timeout again.
 * @param {string} url
 */
export function rememberRefusal(url) {
  const host = hostOf(url).split(':')[0];
  if (host !== '') observedRefusers.add(host);
}

/**
 * Take it back: the frame did load after all, the site was merely slow.
 * @param {string} url
 */
export function forgetRefusal(url) {
  observedRefusers.delete(hostOf(url).split(':')[0]);
}

/* ====================================================== YouTube addresses = */

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Is this string an 11-character YouTube video id?
 *
 * The bare-id shortcut has to be conservative: `programming` is also eleven
 * characters of the allowed alphabet, and it is obviously a search. A real id
 * practically always mixes cases or contains a digit, `-` or `_`, so that is
 * the test — a plain lower-case or plain upper-case word stays a search.
 *
 * @param {string} text
 * @returns {string} the id, or '' when it is not one
 */
export function bareVideoId(text) {
  const raw = String(text || '').trim();
  if (!VIDEO_ID_RE.test(raw)) return '';
  const mixedCase = /[a-z]/.test(raw) && /[A-Z]/.test(raw);
  const hasSymbolOrDigit = /[0-9_-]/.test(raw);
  return mixedCase || hasSymbolOrDigit ? raw : '';
}

/**
 * Pull a video id out of any of the shapes YouTube uses.
 * @param {string} text a URL, a `youtu.be` short link, or a bare id
 * @returns {string} the id, or ''
 */
export function extractVideoId(text) {
  const raw = String(text || '').trim();
  if (raw === '') return '';

  const bare = bareVideoId(raw);
  if (bare) return bare;

  let parsed = null;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return '';

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0] || '';
    return VIDEO_ID_RE.test(id) ? id : '';
  }
  const v = parsed.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return v;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && (segments[0] === 'embed' || segments[0] === 'shorts' || segments[0] === 'live' || segments[0] === 'v')) {
    return VIDEO_ID_RE.test(segments[1]) ? segments[1] : '';
  }
  return '';
}

/**
 * Classify a YouTube address so `index.js` can route it to the player page.
 * @param {string} url
 * @returns {{kind:'watch'|'results'|'home', videoId:string, query:string}|null}
 *          null when the address is not YouTube at all
 */
export function parseYouTube(url) {
  const raw = String(url || '').trim();
  if (raw === '') return null;
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!YT_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const videoId = extractVideoId(raw);
  if (videoId) return { kind: 'watch', videoId, query: '' };

  const query = parsed.searchParams.get('search_query') || parsed.searchParams.get('q') || '';
  if (query.trim() !== '') return { kind: 'results', videoId: '', query: query.trim() };

  return { kind: 'home', videoId: '', query: '' };
}

const YT_KEYWORDS = new Set(['youtube', 'yt', '유튜브', 'youtube.com', 'www.youtube.com', 'youtu.be']);

/**
 * Address-bar shortcuts that only make sense with a real network: the word
 * "youtube" in either language, and a bare video id.
 * @param {string} text
 * @returns {string} an absolute URL, or '' when there is no shortcut
 */
export function resolveLiveInput(text) {
  const raw = String(text || '').trim();
  if (raw === '') return '';
  if (YT_KEYWORDS.has(raw.toLowerCase())) return 'https://www.youtube.com/';
  const id = bareVideoId(raw);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return '';
}

/* ========================================================== interstitial == */

/**
 * The reasons a live load can fail, each with its own honest explanation.
 * @type {Record<string, {title:(host:string)=>string, lede:(host:string)=>string, tips:string[]}>}
 */
const BLOCK_COPY = {
  frame: {
    title: (host) => t(`${host} 사이트는 창 안에 표시될 수 없습니다`, `${host} refuses to be displayed in a frame`),
    lede: () =>
      t(
        '이 사이트는 X-Frame-Options 또는 CSP frame-ancestors 헤더로 다른 페이지 안에 삽입되는 것을 거부합니다. 이 데스크톱은 브라우저 탭 안에서 동작하므로 그 결정을 우회할 수 없습니다.',
        'The site sends an X-Frame-Options or CSP frame-ancestors header that forbids being embedded in another page. This desktop runs inside a browser tab, so that decision cannot be overridden from here.'
      ),
    tips: [
      t('아래 버튼으로 진짜 브라우저 탭에서 여세요.', 'Use the button below to open it in a real browser tab.'),
      t('링크를 복사해 다른 곳에 붙여넣을 수 있습니다.', 'Copy the link and paste it wherever you need it.'),
      t(
        'Wikipedia, archive.org, man7.org, Project Gutenberg, xkcd 같은 사이트는 여기에서 그대로 열립니다. YouTube 영상도 재생됩니다.',
        'Wikipedia, archive.org, man7.org, Project Gutenberg and xkcd do load here — and YouTube videos really play.'
      ),
    ],
  },
  timeout: {
    title: (host) => t(`${host} 페이지가 프레임에 나타나지 않았습니다`, `${host} did not appear in the frame`),
    lede: () =>
      t(
        '기다리는 동안 아무것도 로드되지 않았습니다. 사이트가 삽입을 거부했거나(X-Frame-Options / CSP frame-ancestors), 서버가 응답하지 않거나 주소에 도달할 수 없는 것입니다. 브라우저 안에서는 이 둘을 구분할 수 없기 때문에, 추측 대신 있는 그대로 알려 드립니다.',
        'Nothing loaded while the browser waited. Either the site refuses to be embedded (X-Frame-Options / CSP frame-ancestors), or the server is not answering and the address cannot be reached. A page inside a browser tab cannot tell those two apart, so this screen reports both instead of guessing.'
      ),
    tips: [
      t('주소에 오타가 없는지, 네트워크가 연결되어 있는지 확인하세요.', 'Check the address for typing errors, and check your network connection.'),
      t('아래 버튼으로 진짜 브라우저 탭에서 열어 보세요. 열린다면 삽입 거부였던 것입니다.', 'Open it in a real browser tab below — if it opens there, framing was the problem.'),
      t('페이지가 느렸을 뿐이라면, 늦게 도착하는 즉시 자동으로 표시됩니다.', 'If the site was merely slow, it appears here by itself the moment it arrives.'),
    ],
  },
  mixed: {
    title: () => t('안전하지 않은 http 주소는 차단되었습니다', 'An insecure http address was blocked'),
    lede: (host) =>
      t(
        `이 데스크톱은 https로 제공되고 있어서, 브라우저가 http://${host} 로의 요청을 혼합 콘텐츠(mixed content)로 차단합니다. 요청은 아예 전송되지 않았습니다.`,
        `This desktop is served over https, so the browser blocks a request to http://${host} as mixed content. No request was sent at all.`
      ),
    tips: [
      t('https:// 주소가 있다면 그것으로 다시 시도하세요.', 'Try the https:// address instead, if the site has one.'),
      t('진짜 브라우저 탭에서는 그대로 열 수 있습니다.', 'A real browser tab can still open it.'),
    ],
  },
  self: {
    title: () => t('이 데스크톱 자신은 열 수 없습니다', 'This desktop cannot open itself'),
    lede: () =>
      t(
        '이 주소는 데스크톱이 실행되고 있는 바로 그 출처(origin)입니다. 프레임 안에 넣으면 샌드박스가 경계 역할을 하지 못하게 되고, 데스크톱이 자기 자신 안에서 한 번 더 부팅되면서 두 인스턴스가 같은 저장소를 두고 경쟁하게 됩니다. 그래서 요청을 보내지 않았습니다.',
        'That address is the very origin this desktop is served from. Framing it would stop the sandbox from being a boundary, and would boot a second desktop inside the first, leaving two instances racing over the same storage. No request was sent.'
      ),
    tips: [
      t('다른 사이트 주소를 입력해 보세요.', 'Try the address of a different site.'),
      t('이 페이지를 다시 보려면 진짜 브라우저 탭에서 여세요.', 'To see this page again, open it in a real browser tab.'),
    ],
  },
  error: {
    title: (host) => t(`${host} 에 연결하지 못했습니다`, `Could not connect to ${host}`),
    lede: () =>
      t(
        '프레임이 오류를 보고했습니다. 주소가 잘못되었거나, 서버가 응답하지 않거나, 네트워크가 끊겨 있을 수 있습니다.',
        'The frame reported an error. The address may be wrong, the server may be down, or this machine may be offline.'
      ),
    tips: [
      t('주소에 오타가 없는지 확인하세요.', 'Check the address for typing errors.'),
      t('네트워크 연결을 확인하세요.', 'Check your network connection.'),
    ],
  },
};

/**
 * Firefox-style interstitial. Deliberately blunt: it names the mechanism, and
 * the primary action is the one that actually works.
 *
 * @param {string} url
 * @param {'frame'|'timeout'|'mixed'|'self'|'error'} reason
 * @param {{onRetry:() => void, onSearch:(query:string) => void}} actions
 * @returns {HTMLElement}
 */
export function blockInterstitial(url, reason, actions) {
  const copy = BLOCK_COPY[reason] || BLOCK_COPY.frame;
  const host = hostOf(url) || prettyUrl(url);

  const tips = h('ul.fx-block-tips');
  for (const tip of copy.tips) tips.appendChild(h('li', { text: tip }));

  const card = h(
    'div.fx-block',
    {},
    fxIcon(reason === 'mixed' ? 'broken' : reason === 'timeout' ? 'warning' : 'frame', 42, { class: 'fx-block-icon' }),
    h('h1.fx-block-title', { text: copy.title(host) }),
    h('p.fx-block-lede', { text: copy.lede(host) }),
    h('div.fx-block-url', {}, fxIcon('globe', 14), h('span.fx-block-urltext', { text: url })),
    h('p.fx-block-sub', { text: t('할 수 있는 것:', 'What you can do:') }),
    tips,
    h(
      'div.fx-block-actions',
      {},
      openExternalButton(url),
      copyLinkButton(url),
      button(t('다시 시도', 'Try again'), () => actions.onRetry(), { icon: 'reload', variant: 'quiet' }),
      button(t('이 사이트 검색하기', 'Search for this site'), () => actions.onSearch(host), { icon: 'search', variant: 'quiet' })
    ),
    h('p.fx-block-note', {
      text: t(
        '이 화면은 에뮬레이터가 만들어 낸 페이지가 아닙니다. 사이트의 내용은 하나도 표시되지 않았고, 무슨 일이 있었는지만 알려 드립니다.',
        'This is not a page the emulator invented. Nothing from the site was rendered — this screen only reports what happened.'
      ),
    })
  );
  return h('div.fx-page.fx-block-page', {}, card);
}

/* ============================================================ live frame == */

/** How long to wait for a `load` event before calling the frame blocked. */
const LOAD_TIMEOUT_MS = 3500;

/**
 * Build the sandboxed frame. The sandbox is as tight as real content tolerates
 * and nothing is ever written into the frame.
 * @param {string} url
 * @returns {HTMLIFrameElement}
 */
export function buildFrame(url) {
  // Defence in depth. `renderLivePage` already refuses these, but this is the
  // one place a URL becomes a live document, so the invariant is enforced here
  // too: only a foreign http(s) origin may be framed. `allow-same-origin` is
  // safe for those and only for those — see `isSameOrigin`.
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw) || isSameOrigin(raw)) {
    throw new Error(`refusing to frame a non-remote address: ${raw}`);
  }

  return h('iframe.fx-frame', {
    src: raw,
    title: `Web content: ${url}`,
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation',
    referrerpolicy: 'no-referrer-when-downgrade',
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
    allowfullscreen: true,
    loading: 'eager',
  });
}

/**
 * Did a frame that fired `load` actually get content?
 *
 * A cross-origin document throws on access — that throw is the success signal.
 * A readable document that is still about:blank with an empty body is the
 * shape a refused load leaves behind.
 *
 * @param {HTMLIFrameElement} frame
 * @returns {boolean} true when the frame looks empty, i.e. blocked
 */
export function frameLooksEmpty(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return false;
    const href = doc.location ? String(doc.location.href) : '';
    const body = doc.body;
    const empty = !body || (body.childElementCount === 0 && String(body.textContent || '').trim() === '');
    return empty && (href === '' || href === 'about:blank');
  } catch {
    // SecurityError — genuine cross-origin content is in there. That is a win.
    return false;
  }
}

/**
 * The strip above a live frame.
 *
 * It exists because the detection above cannot be perfect: in Chromium a
 * frame refused by `X-Frame-Options` fires `load` and exposes exactly the same
 * cross-origin document as a frame that worked. Rather than guess silently,
 * every live page carries the escape hatch and one line saying what to do if
 * the area below stays blank.
 *
 * @param {string} url
 * @returns {HTMLElement}
 */
function frameBar(url) {
  return h(
    'div.fx-frame-bar',
    {},
    fxIcon('frame', 14, { class: 'fx-frame-bar-icon' }),
    h('span.fx-frame-bar-text', {
      text: t(
        `${hostOf(url)} 페이지를 샌드박스 프레임에 실제로 불러왔습니다. 아래가 계속 비어 있다면 사이트가 삽입을 거부한 것입니다.`,
        `${hostOf(url)} really loaded in a sandboxed frame. If the area below stays blank, the site refused to be embedded.`
      ),
    }),
    h(
      'div.fx-frame-bar-actions',
      {},
      h(
        'button.fx-frame-bar-btn',
        { type: 'button', title: url, on: { click: () => openExternal(url) } },
        fxIcon('external', 13),
        h('span', { text: t('실제 탭에서 열기', 'Open in a real tab') })
      ),
      h(
        'button.fx-frame-bar-btn',
        { type: 'button', on: { click: () => copyText(url) } },
        fxIcon('copy', 13),
        h('span', { text: t('링크 복사', 'Copy link') })
      )
    )
  );
}

/**
 * Load a real address into a tab.
 *
 * @param {object} tab the browser tab record from `index.js`
 * @param {string} url absolute http(s) URL
 * @param {object} host the content host callbacks from `index.js`
 */
export function renderLivePage(tab, url, host) {
  const nav = tab.nav;
  const page = h('div.fx-page.fx-livepage');
  const stage = h('div.fx-frame-stage');
  const bar = frameBar(url);
  const progress = h('div.fx-frame-progress', { 'aria-hidden': 'true' });
  page.appendChild(progress);
  page.appendChild(bar);
  page.appendChild(stage);
  tab.view.appendChild(page);

  tab.canReader = false;
  host.setTitle(tab, hostOf(url) || prettyUrl(url));

  const retry = () => host.reload();
  const search = (query) => host.search(query);

  /** @type {HTMLElement|null} the interstitial, while one is shown */
  let notice = null;

  /**
   * Show the interstitial. The frame is hidden rather than destroyed, so a
   * slow site that arrives after the deadline can still take the screen back
   * (see `recover`).
   * @param {'frame'|'timeout'|'mixed'|'self'|'error'} reason
   * @param {boolean} keepFrame
   */
  const fail = (reason, keepFrame) => {
    if (tab.nav !== nav || notice) return;
    if (!keepFrame) {
      clear(page);
    } else {
      progress.hidden = true;
      bar.hidden = true;
      stage.hidden = true;
    }
    notice = blockInterstitial(url, reason, { onRetry: retry, onSearch: search });
    page.appendChild(notice);
    host.setLoading(tab, false);
    if (host.isActive(tab)) host.updateChrome();
  };

  /** The frame won the race after all: put the real page back. */
  const recover = () => {
    if (!notice) return;
    notice.remove();
    notice = null;
    progress.hidden = false;
    bar.hidden = false;
    stage.hidden = false;
    forgetRefusal(url);
  };

  // Must come before every other check: framing our own origin defeats the
  // sandbox and boots a second desktop inside this one. See `isSameOrigin`.
  if (isSameOrigin(url)) {
    fail('self', false);
    return;
  }

  if (isMixedContent(url)) {
    fail('mixed', false);
    return;
  }

  // Known refuser: say so at once instead of showing a blank rectangle.
  if (knownToRefuseFraming(url)) {
    fail('frame', false);
    return;
  }

  const frame = buildFrame(url);
  stage.appendChild(frame);
  host.setLoading(tab, true);

  let aborted = false;
  let deadlinePassed = false;
  const timer = window.setTimeout(() => {
    if (aborted || tab.nav !== nav) return;
    deadlinePassed = true;
    rememberRefusal(url);
    fail('timeout', true);
  }, LOAD_TIMEOUT_MS);

  frame.addEventListener('load', () => {
    if (aborted || tab.nav !== nav) return;
    window.clearTimeout(timer);
    if (frameLooksEmpty(frame)) {
      rememberRefusal(url);
      fail('frame', true);
      return;
    }
    // A late arrival: the site was slow, not hostile.
    if (deadlinePassed) recover();
    progress.classList.add('is-done');
    host.setLoading(tab, false);
    if (host.isActive(tab)) host.updateChrome();
  });

  frame.addEventListener('error', () => {
    if (aborted || tab.nav !== nav) return;
    window.clearTimeout(timer);
    fail('error', true);
  });

  // `index.js` aborts the previous load by calling `tab.controller.abort()`.
  tab.controller = {
    abort() {
      aborted = true;
      window.clearTimeout(timer);
    },
  };
}
