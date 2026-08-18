/**
 * desktop.js — commands that drive the desktop itself rather than the shell.
 *
 *   reset    put the machine back to a fresh install
 *   github   a scripted "the machine is driving itself" demo
 *
 * Both deliberately depart from what the real binaries of those names do:
 * on Ubuntu `reset` reinitialises the *terminal* (terminfo), and `github` is
 * not a command at all. Their man pages here say so, so nobody learns the
 * wrong thing from this emulator.
 */

import { wm } from '../../../shell/window-manager.js';
import { flashScreen } from '../../../shell/session.js';
import { factoryReset } from '../../../core/factory-reset.js';
import { ok, fail, wait, paint, BOLD, RESET, ORANGE, GREEN, YELLOW, GRAY, CYAN } from './util.js';

/* ================================================================== *
 * reset
 * ================================================================== */

const reset = {
  name: 'reset',
  aliases: [],
  synopsis: 'reset [-y] [--all] [--help]',
  description: 'Restore the desktop to a fresh install',
  man: `NAME
       reset - restore the desktop to a fresh install

SYNOPSIS
       reset [-y] [--all]

DESCRIPTION
       Puts this emulator back to the state a first-time visitor sees.
       Everything the desktop keeps in the browser is discarded:

         the whole filesystem, including files you created
         the wallpaper, accent colour, light/dark style and dock settings
         window positions and the restored session
         the browser's history and bookmarks
         shell history and one-off prompts

       Your Gemini API key is KEPT, because losing it only means pasting it
       in again. Use --all to wipe that too.

       The page reloads at the end. That is not cosmetic: the filesystem,
       the process table and every open window hold their own copy of the
       state, and a reload is the only way to be sure all of them agree.

       This cannot be undone. There is no trash to recover from — the
       trash is wiped as well.

OPTIONS
       -y, --yes    skip the confirmation prompt
       --all        also delete the stored Gemini API key
       --help       show this help

NOTE
       On a real Ubuntu system, reset(1) reinitialises the terminal after
       it has been left in a broken state — it does not touch your files.
       This command is specific to the emulator. To clear the screen the
       way you probably mean, use clear(1) or Ctrl+L.

EXIT STATUS
       0  the reset ran
       1  the user declined`,

  async run(ctx) {
    const argv = ctx.argv.filter((a) => a !== '--');
    if (argv.includes('--help') || argv.includes('-h')) {
      return ok(`Usage: reset [-y] [--all]\nRestore the desktop to a fresh install.\n`);
    }

    const wipeKey = argv.includes('--all');
    const assumeYes = argv.includes('-y') || argv.includes('--yes');

    const unknown = argv.find(
      (a) => a.startsWith('-') && !['-y', '--yes', '--all', '-h', '--help'].includes(a),
    );
    if (unknown) {
      return fail(`reset: unrecognized option '${unknown}'\nTry 'reset --help' for more information.\n`, 1);
    }

    if (!assumeYes) {
      ctx.term.writeLine('');
      ctx.term.writeLine(paint(ORANGE + BOLD, '  ⚠  이 컴퓨터를 공장 초기화합니다'));
      ctx.term.writeLine('');
      ctx.term.writeLine(`     ${paint(GRAY, '지워짐')}  파일시스템 전체 (직접 만든 파일 포함)`);
      ctx.term.writeLine(`     ${paint(GRAY, '지워짐')}  배경화면 · 강조색 · 테마 · 독 설정`);
      ctx.term.writeLine(`     ${paint(GRAY, '지워짐')}  창 배치 · 방문 기록 · 북마크 · 셸 기록 · 휴지통`);
      ctx.term.writeLine(
        `     ${paint(wipeKey ? GRAY : GREEN, wipeKey ? '지워짐' : '유지됨')}  Gemini API 키` +
          (wipeKey ? '' : `  ${paint(GRAY, '(--all 을 붙이면 함께 지웁니다)')}`),
      );
      ctx.term.writeLine('');
      ctx.term.writeLine(paint(GRAY, '     되돌릴 수 없습니다. 끝나면 페이지가 새로 고쳐집니다.'));
      ctx.term.writeLine('');

      const answer = await ctx.term.ask('     계속할까요? [y/N] ');
      const yes = /^(y|yes|예|ㅇ)$/i.test(String(answer || '').trim());
      if (!yes) {
        return ok(`${paint(GRAY, '     취소했습니다. 아무것도 바뀌지 않았습니다.')}\n\n`);
      }
    }

    ctx.term.writeLine('');
    const steps = [
      '파일시스템을 원본으로 되돌리는 중',
      '설정과 배경화면을 초기화하는 중',
      '세션과 방문 기록을 지우는 중',
    ];
    for (const label of steps) {
      ctx.term.write(`  ${paint(CYAN, '›')} ${label}…`);
      await wait(260, ctx.signal);
      ctx.term.writeLine(` ${paint(GREEN, '완료')}`);
    }

    const result = factoryReset.run({ keepApiKey: !wipeKey, reload: false });

    ctx.term.writeLine('');
    ctx.term.writeLine(
      `  ${paint(GREEN + BOLD, '✓')} ${paint(BOLD, '초기화되었습니다.')} ` +
        paint(GRAY, `저장된 항목 ${result.cleared.length}개 삭제` +
          (result.kept.length ? `, ${result.kept.length}개 유지` : '')),
    );
    ctx.term.writeLine(paint(GRAY, '    잠시 후 새로 고쳐집니다…'));
    ctx.term.writeLine('');

    await wait(900, ctx.signal);
    window.location.reload();

    // The reload takes over; this is only reached if it is somehow blocked.
    return ok('');
  },
};

/* ================================================================== *
 * github
 * ================================================================== */

const GITHUB_PAGES_URL = 'https://jtech-co.github.io/';

const github = {
  name: 'github',
  aliases: [],
  synopsis: 'github [--help]',
  description: 'Open GitHub in Firefox, driving the desktop automatically',
  man: `NAME
       github - open GitHub in Firefox, driving the desktop automatically

SYNOPSIS
       github

DESCRIPTION
       A scripted demonstration. The screen flashes once, Firefox opens on
       its own, "github.com" is typed into the address bar a character at a
       time, and the page loads — as though someone were driving the
       machine remotely.

       The page you land on is drawn by the emulator, not fetched. GitHub
       sends an X-Frame-Options header that forbids being embedded in
       another page, so no browser tab can display the real github.com
       inside this desktop. The page says so on its face.

       When it has loaded, pressing Enter leaves the emulator and takes
       this browser tab to ${GITHUB_PAGES_URL} — the real site, for real.
       Escape cancels and stays here.

NOTE
       There is no github(1) on Ubuntu. This command exists only in this
       emulator. The official GitHub command-line tool is gh(1).`,

  async run(ctx) {
    const argv = ctx.argv.filter((a) => a !== '--');
    if (argv.includes('--help') || argv.includes('-h')) {
      return ok(`Usage: github\nOpen GitHub in Firefox, driving the desktop automatically.\n`);
    }

    ctx.term.writeLine('');
    ctx.term.writeLine(`  ${paint(ORANGE + BOLD, '●')} ${paint(BOLD, '원격 세션을 시작합니다')}`);
    ctx.term.writeLine(paint(GRAY, '    이 데스크톱을 대신 조작합니다. 손 떼고 지켜보세요.'));
    ctx.term.writeLine('');

    await wait(320, ctx.signal);

    // One Ubuntu-style screen pulse — the same effect the screenshot tool uses.
    flashScreen();
    await wait(420, ctx.signal);

    ctx.term.writeLine(`  ${paint(CYAN, '›')} Firefox 를 실행하는 중…`);
    const instance = wm.open('firefox', { drive: 'github-demo' });
    if (!instance) {
      return fail('github: Firefox 를 열 수 없습니다. 앱이 등록되어 있는지 확인하세요.\n', 1);
    }

    await wait(260, ctx.signal);
    ctx.term.writeLine(`  ${paint(CYAN, '›')} 주소창에 ${paint(YELLOW, 'github.com')} 을 입력하는 중…`);
    ctx.term.writeLine('');
    ctx.term.writeLine(
      paint(GRAY, `    페이지가 뜨면 ${RESET}${paint(BOLD, 'Enter')}${paint(GRAY, ' 를 눌러 ')}` +
        `${RESET}${paint(BOLD, GITHUB_PAGES_URL)}${paint(GRAY, ' 로 이동합니다.')}`),
    );
    ctx.term.writeLine('');

    return ok('');
  },
};

export default [reset, github];
