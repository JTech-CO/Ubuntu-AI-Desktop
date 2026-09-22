/**
 * storage-status.js — tell the user when their work is not being saved.
 *
 * Two situations, both previously invisible:
 *
 *   1. A save failed (usually: out of space). The in-memory desktop keeps
 *      working, so nothing looks wrong — until a reload silently rolls it
 *      back. A sticky notification now says so while there is still time to
 *      act, and is withdrawn automatically once a later save succeeds.
 *
 *   2. This tab is a reader because another tab owns the desktop
 *      (js/core/writer-lock.js). A persistent banner says that changes here
 *      are not saved, and offers to take over.
 *
 * All wording goes in through textContent via the h() helper.
 */

import { bus } from '../core/bus.js';
import { notify } from '../core/notify.js';
import { h } from '../core/dom.js';
import { fs } from '../core/fs.js';
import { writerLock } from '../core/writer-lock.js';
import { wm } from './window-manager.js';

const SCREENSHOTS = '/home/ubuntu/Pictures/Screenshots';

/** target -> notification id of the currently shown failure */
const failureNotes = new Map();
let banner = null;

/* ------------------------------------------------------------------ *
 * save failures
 * ------------------------------------------------------------------ */

/** Where to send someone looking for space to free. */
function biggestSuspect() {
  try {
    if (fs.exists(SCREENSHOTS) && fs.readdir(SCREENSHOTS).some((n) => !n.startsWith('.'))) {
      return SCREENSHOTS;
    }
  } catch {
    /* fall through */
  }
  return fs.HOME;
}

function onError(payload) {
  const p = payload || {};
  const target = p.target || 'fs';
  if (failureNotes.has(target)) return;

  const isFs = target === 'fs';
  const title = isFs ? '파일을 저장하지 못했습니다' : '설정을 저장하지 못했습니다';
  const why = p.quota
    ? p.backend === 'localStorage'
      ? '브라우저 저장 공간(localStorage, 약 5MB)이 가득 찼습니다.'
      : '브라우저가 이 사이트에 허락한 저장 공간이 가득 찼습니다.'
    : `저장소 오류: ${p.message || p.name || '알 수 없는 오류'}.`;
  const consequence = isFs
    ? ' 지금 새로 고치면 마지막으로 저장된 뒤의 변경이 사라집니다. 큰 파일(스크린샷 등)을 지우고 휴지통까지 비워야 공간이 확보됩니다.'
    : ' 이 설정은 새로 고치면 되돌아갑니다.';

  const actions = [
    {
      label: '다시 시도',
      onClick: () => {
        void fs.persist();
      },
    },
  ];
  if (isFs) {
    actions.push({ label: '파일 열기', onClick: () => wm.open('files', { path: biggestSuspect() }) });
    actions.push({ label: '휴지통', onClick: () => wm.open('trash') });
  }

  const id = notify.show({
    app: '저장소',
    title,
    body: why + consequence,
    timeout: 0, // sticky: this must not scroll away unread
    actions,
  });
  failureNotes.set(target, id);
}

function onRecovered(payload) {
  const target = (payload && payload.target) || 'fs';
  const id = failureNotes.get(target);
  if (id === undefined) return;
  failureNotes.delete(target);
  notify.dismiss(id);
  notify.show({
    app: '저장소',
    title: '다시 저장되고 있습니다',
    body: target === 'fs' ? '파일시스템이 정상적으로 저장되었습니다.' : '설정이 정상적으로 저장되었습니다.',
    timeout: 4000,
  });
}

function onDegraded(payload) {
  notify.show({
    app: '저장소',
    title: 'IndexedDB 를 쓸 수 없습니다',
    body:
      '이 브라우저에서는 파일을 localStorage 에 저장하므로 약 5MB 까지만 보관됩니다. ' +
      `(${(payload && payload.message) || '원인 불명'})`,
    timeout: 12000,
  });
}

/* ------------------------------------------------------------------ *
 * reader banner
 * ------------------------------------------------------------------ */

function hideBanner() {
  if (!banner) return;
  const node = banner;
  banner = null;
  node.classList.remove('is-shown');
  setTimeout(() => node.remove(), 260);
}

function showBanner(reason) {
  hideBanner();
  const takenOver = reason === 'handover' || reason === 'stolen';
  const button = h('button.storage-banner__button', {
    type: 'button',
    text: takenOver ? '여기서 다시 사용' : '여기서 사용',
  });
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = '넘겨받는 중…';
    void writerLock.takeOver();
  });

  banner = h(
    'div.storage-banner',
    { role: 'status', 'aria-live': 'polite' },
    h('span.storage-banner__dot', { 'aria-hidden': 'true' }),
    h(
      'span.storage-banner__text',
      {},
      h('b', {
        text: takenOver
          ? '다른 탭이 이 데스크톱을 이어받았습니다. '
          : '이 데스크톱은 다른 탭에서 열려 있습니다. ',
      }),
      h('span', { text: '이 탭에서 바꾼 내용은 저장되지 않습니다.' }),
    ),
    button,
  );
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner && banner.classList.add('is-shown'));
}

function onWriterChange(payload) {
  const role = payload && payload.role;
  if (role === 'reader') showBanner(payload.reason);
  else hideBanner();
}

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

let installed = false;

/** Wire the listeners, and reflect a role decided before install. */
export function install() {
  if (installed) return;
  installed = true;
  bus.on('storage:error', onError);
  bus.on('storage:recovered', onRecovered);
  bus.on('storage:degraded', onDegraded);
  bus.on('writer:change', onWriterChange);
  if (writerLock.getRole() === 'reader') showBanner('other-tab');
}

export const storageStatus = { install };
export default storageStatus;
