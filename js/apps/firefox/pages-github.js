/**
 * pages-github.js — the locally drawn GitHub repository page, and the scripted
 * sequence that drives Firefox to it.
 *
 * WHY IT IS DRAWN RATHER THAN LOADED
 * ----------------------------------
 * github.com sends `X-Frame-Options: deny`, so no browser tab can display it
 * inside another page. This is a re-creation, and it says so on its face — the
 * rest of this project is careful never to pass simulated output off as real,
 * and this page is the most tempting place to slip.
 *
 * The payoff is real, though: pressing Enter on the loaded page navigates the
 * actual browser tab to the project's GitHub Pages site.
 */

import { h, svg, clear } from '../../core/dom.js';
import { t } from './live.js';

/** Internal URL for the tab; the address bar shows DISPLAY_URL instead. */
export const GITHUB_URL = 'github:repo';
export const DISPLAY_URL = 'https://github.com/JTech-CO/Ubuntu-AI-Desktop';
export const PAGES_URL = 'https://jtech-co.github.io/';
export const GITHUB_TITLE = 'JTech-CO/Ubuntu-AI-Desktop: 브라우저에서 도는 Ubuntu 24.04 데스크톱';

/** What gets typed into the address bar, one character at a time. */
export const TYPED_TEXT = 'github.com';

/* ------------------------------------------------------------------ *
 * octicons, built as real SVG nodes (never markup strings)
 * ------------------------------------------------------------------ */

const OCTICON = {
  mark:
    'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.05-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.13 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
  repo:
    'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z',
  star: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z',
  fork:
    'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z',
  eye: 'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.61 3.005a1.64 1.64 0 0 1 0 1.834c-.423.66-1.34 1.914-2.61 3.005C11.671 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.457 8.916a1.64 1.64 0 0 1 0-1.834c.423-.66 1.34-1.914 2.61-3.005C4.329 2.992 6.019 2 8 2Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  file: 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Z',
  dir: 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z',
  code: 'M4.72 3.22a.75.75 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06Zm6.56 0a.75.75 0 1 0-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06l4.25-4.25a.75.75 0 0 0 0-1.06Z',
  book: 'M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Z',
  search: 'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-1.06 1.06Z',
};

/**
 * @param {string} name key in OCTICON
 * @param {number} size
 * @param {string} [colour]
 * @returns {SVGElement}
 */
function icon(name, size = 16, colour) {
  const el = svg(OCTICON[name] || OCTICON.file, { size, viewBox: '0 0 16 16' });
  el.setAttribute('fill', colour || 'currentColor');
  el.setAttribute('stroke', 'none');
  return el;
}

/* ------------------------------------------------------------------ *
 * the page
 * ------------------------------------------------------------------ */

/** Files shown in the listing — the project's real top level. */
const TREE = [
  ['dir', '.claude', 'Add the full Ubuntu 24.04 desktop emulator', 'now'],
  ['dir', 'assets', 'Add the OG card and favicon', 'now'],
  ['dir', 'css', '23 stylesheets, Yaru design tokens', 'now'],
  ['dir', 'docs', 'ARCHITECTURE.md — the module contract', 'now'],
  ['dir', 'js', '115 ES modules', 'now'],
  ['dir', 'legacy', 'The original single-file prototypes', 'now'],
  ['dir', 'tools', 'make-og-image.py', 'now'],
  ['file', '.gitattributes', 'Normalise line endings to LF', 'now'],
  ['file', '.gitignore', 'Never commit API keys', 'now'],
  ['file', '.nojekyll', 'Serve underscore paths on Pages', 'now'],
  ['file', 'LICENSE', 'Initial commit', '3 hours ago'],
  ['file', 'README.md', 'Add the full Ubuntu 24.04 desktop emulator', 'now'],
  ['file', 'index.html', '73 lines — skeleton and link tags only', 'now'],
  ['file', 'serve.py', 'Local dev server with no-store headers', 'now'],
];

const LANGUAGES = [
  ['JavaScript', 78.1, '#f1e05a'],
  ['CSS', 17.4, '#663399'],
  ['HTML', 2.9, '#e34c26'],
  ['Python', 1.6, '#3572A5'],
];

function chipButton(iconName, label, count) {
  const button = h('button.gh-chip', { type: 'button' }, icon(iconName, 16), h('span', { text: label }));
  if (count) button.appendChild(h('span.gh-chip__count', { text: count }));
  return button;
}

/**
 * The honest notice. Deliberately not dismissible and deliberately at the top:
 * the whole point is that nobody mistakes this for the real site.
 * @returns {HTMLElement}
 */
function simulationNotice() {
  return h(
    'div.gh-sim',
    { role: 'note' },
    h('span.gh-sim__badge', { text: t('시뮬레이션', 'SIMULATED') }),
    h('span.gh-sim__text', {
      text: t(
        '이 화면은 에뮬레이터가 직접 그린 것이며 github.com 에서 받아온 것이 아닙니다. ' +
          'GitHub 은 X-Frame-Options 헤더로 다른 페이지 안에 삽입되는 것을 거부하므로, 브라우저 탭 안에서는 실제 github.com 을 표시할 수 없습니다.',
        'This page was drawn by the emulator, not fetched from github.com. GitHub sends an ' +
          'X-Frame-Options header refusing to be embedded, so a browser tab cannot display the real site here.',
      ),
    }),
  );
}

/**
 * Build the repository page.
 * @param {{navigate: Function}} browser host handle from the Firefox app
 * @returns {HTMLElement}
 */
export function renderGitHubPage(browser) {
  const page = h('div.gh');

  /* --- global header --- */
  const search = h('div.gh-search', {}, icon('search', 14), h('span', { text: 'Type / to search' }));
  page.appendChild(
    h(
      'header.gh-top',
      {},
      h('span.gh-top__mark', {}, icon('mark', 30)),
      search,
      h('nav.gh-top__nav', {},
        ...['Pull requests', 'Issues', 'Marketplace', 'Explore'].map((label) =>
          h('span.gh-top__link', { text: label })),
      ),
      h('span.gh-top__avatar', { text: 'J' }),
    ),
  );

  page.appendChild(simulationNotice());

  /* --- repo header --- */
  page.appendChild(
    h(
      'div.gh-head',
      {},
      h('div.gh-head__title', {},
        icon('repo', 16),
        h('span.gh-owner', { text: 'JTech-CO' }),
        h('span.gh-slash', { text: '/' }),
        h('strong.gh-name', { text: 'Ubuntu-AI-Desktop' }),
        h('span.gh-public', { text: 'Public' }),
      ),
      h('div.gh-head__actions', {},
        chipButton('eye', 'Watch', '1'),
        chipButton('fork', 'Fork', '0'),
        chipButton('star', 'Star', '0'),
      ),
    ),
  );

  page.appendChild(
    h('nav.gh-tabs', {},
      ...[['Code', true], ['Issues', false], ['Pull requests', false], ['Actions', false],
        ['Projects', false], ['Security', false], ['Insights', false], ['Settings', false]]
        .map(([label, active]) =>
          h(`span.gh-tab${active ? '.is-active' : ''}`, { text: String(label) })),
    ),
  );

  /* --- body: file list + sidebar --- */
  const listing = h('div.gh-listing');
  listing.appendChild(
    h('div.gh-listing__head', {},
      h('span.gh-branch', {}, icon('code', 14), h('span', { text: 'main' })),
      h('span.gh-commits', { text: t('커밋 2개', '2 commits') }),
    ),
  );

  const table = h('div.gh-files');
  for (const [kind, name, message, when] of TREE) {
    table.appendChild(
      h('div.gh-file', {},
        h(`span.gh-file__icon.gh-file__icon--${kind}`, {}, icon(kind === 'dir' ? 'dir' : 'file', 16)),
        h('span.gh-file__name', { text: name }),
        h('span.gh-file__msg', { text: message }),
        h('span.gh-file__when', { text: when }),
      ),
    );
  }
  listing.appendChild(table);

  /* README card */
  listing.appendChild(
    h('div.gh-readme', {},
      h('div.gh-readme__head', {}, icon('book', 16), h('span', { text: 'README' })),
      h('div.gh-readme__body', {},
        h('h1.gh-readme__h1', { text: 'Ubuntu AI Desktop' }),
        h('p.gh-readme__lead', {
          text: t(
            '브라우저에서 그대로 도는 Ubuntu 24.04 LTS 데스크톱 에뮬레이터. 빌드 과정 없이 GitHub Pages 에 그대로 배포됩니다.',
            'An Ubuntu 24.04 LTS desktop emulator that runs entirely in the browser, deployed to GitHub Pages with no build step.',
          ),
        }),
        h('ul.gh-readme__list', {},
          ...[
            t('파이프·리다이렉션·글로빙이 되는 진짜 bash 셸, 명령어 188개', 'A real bash-style shell with pipes, redirection and globbing — 188 commands'),
            t('모든 앱이 공유하는 가상 파일시스템', 'A virtual filesystem every app shares'),
            t('8방향 리사이즈·에지 스냅·타일링을 갖춘 창 관리자', 'A window manager with eight-way resize, edge snapping and tiling'),
            t('호스트의 실제 CPU·GPU·메모리를 읽는 시스템 정보', 'System info read from the real host CPU, GPU and RAM'),
          ].map((text) => h('li', { text })),
        ),
      ),
    ),
  );

  const side = h('aside.gh-side');
  side.appendChild(
    h('div.gh-about', {},
      h('h2.gh-side__h', { text: 'About' }),
      h('p.gh-about__text', {
        text: t(
          '브라우저에서 그대로 도는 Ubuntu 24.04 LTS 데스크톱 에뮬레이터 — 진짜 bash 셸, 공유 가상 파일시스템, 앱 10개.',
          'An Ubuntu 24.04 LTS desktop that runs in your browser — real bash shell, shared virtual filesystem, ten apps.',
        ),
      }),
      h('p.gh-about__link', {}, icon('code', 14), h('span', { text: 'jtech-co.github.io/Ubuntu-AI-Desktop' })),
      h('div.gh-topics', {},
        ...['ubuntu', 'emulator', 'terminal', 'bash', 'gnome', 'javascript', 'es-modules', 'github-pages']
          .map((topic) => h('span.gh-topic', { text: topic })),
      ),
    ),
  );

  const bar = h('div.gh-langbar');
  for (const [, pct, colour] of LANGUAGES) {
    bar.appendChild(h('span.gh-langbar__seg', { style: { width: `${pct}%`, background: colour } }));
  }
  side.appendChild(
    h('div.gh-langs', {},
      h('h2.gh-side__h', { text: 'Languages' }),
      bar,
      h('ul.gh-langs__list', {},
        ...LANGUAGES.map(([name, pct, colour]) =>
          h('li', {},
            h('span.gh-dot', { style: { background: colour } }),
            h('span.gh-langs__name', { text: name }),
            h('span.gh-langs__pct', { text: `${pct}%` }),
          )),
      ),
    ),
  );

  page.appendChild(h('div.gh-body', {}, listing, side));
  return page;
}

/* ------------------------------------------------------------------ *
 * the Enter-to-continue prompt
 * ------------------------------------------------------------------ */

/**
 * Overlay the loaded page with the prompt that finishes the demo.
 *
 * Pressing Enter navigates the REAL browser tab away from the emulator, so it
 * says exactly where it is going and offers a way out. The key handler is
 * scoped to the overlay and torn down on either outcome — it must never be
 * left swallowing Enter for the rest of the session.
 *
 * @param {HTMLElement} host the tab's view element
 * @returns {() => void} teardown, for the app's own cleanup path
 */
export function showContinuePrompt(host) {
  const card = h(
    'div.gh-go',
    { role: 'dialog', 'aria-modal': 'false', 'aria-label': t('계속하기', 'Continue') },
    h('div.gh-go__inner', {},
      h('div.gh-go__key', {}, h('kbd', { text: 'Enter' })),
      h('div.gh-go__copy', {},
        h('p.gh-go__title', { text: t('Enter 를 눌러 실제 사이트로 이동합니다', 'Press Enter to go to the real site') }),
        h('p.gh-go__url', { text: PAGES_URL }),
        h('p.gh-go__note', {
          text: t(
            '이 브라우저 탭이 그대로 해당 주소로 바뀝니다. 즉 에뮬레이터에서 나갑니다. Esc 를 누르면 취소합니다.',
            'This browser tab will navigate there, which means leaving the emulator. Escape cancels.',
          ),
        }),
      ),
    ),
    h('div.gh-go__buttons', {},
      h('button.gh-go__cancel', { type: 'button', text: t('취소', 'Cancel') }),
      h('button.gh-go__ok', { type: 'button', text: t('이동', 'Go') }),
    ),
  );

  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    card.remove();
  };

  const go = () => {
    if (done) return;
    teardown();
    window.location.assign(PAGES_URL);
  };

  function onKey(ev) {
    if (done || !card.isConnected) return;
    // Never steal Enter from a field the user might be typing in.
    const target = ev.target;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    if (target && target.isContentEditable) return;

    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      go();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      teardown();
    }
  }

  card.querySelector('.gh-go__ok').addEventListener('click', go);
  card.querySelector('.gh-go__cancel').addEventListener('click', teardown);
  document.addEventListener('keydown', onKey, true);

  host.appendChild(card);
  requestAnimationFrame(() => card.classList.add('is-shown'));
  // Focus the primary button so Enter works for keyboard and screen-reader
  // users even without the document-level handler.
  requestAnimationFrame(() => card.querySelector('.gh-go__ok').focus());

  return teardown;
}

/** A GitHub-flavoured loading skeleton, shown while the "page" loads. */
export function renderGitHubSkeleton() {
  const page = h('div.gh.gh--loading');
  page.appendChild(h('div.gh-skel__top'));
  const body = h('div.gh-skel__body');
  for (let i = 0; i < 9; i += 1) body.appendChild(h('div.gh-skel__row'));
  page.appendChild(body);
  return page;
}

export { clear };
