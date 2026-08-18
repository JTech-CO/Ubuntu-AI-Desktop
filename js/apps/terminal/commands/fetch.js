/**
 * js/apps/terminal/commands/fetch.js — neofetch / fastfetch / screenfetch.
 *
 * Renders the genuine 20-row Ubuntu ASCII logo in Ubuntu orange beside the
 * standard neofetch info block, followed by the two 8-cell colour rows.
 *
 * The hardware rows describe the real machine, via `js/core/device.js`: the CPU
 * core count, the GPU renderer string, the screen resolution and the memory
 * total are all read from the browser rather than invented. `Host` is the
 * browser and operating system actually running this page — the honest
 * equivalent of the DMI product name neofetch prints on real hardware — since
 * there is no laptop model for a web page to read.
 */

import { procs } from '../../../core/procs.js';
import { users } from '../../../core/users.js';
import { env } from '../../../core/env.js';
import { device } from '../../../core/device.js';
import { pkgdb } from './pkg-db.js';

/** CSI introducer, built from its code point so no control byte lives in source. */
export const CSI = `${String.fromCharCode(27)}[`;
/** Matches any SGR sequence — used by the plain-text `--stdout` / `-N` modes. */
export const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
/** Yaru Ubuntu orange #E95420 as a truecolor SGR sequence. */
const ORANGE = `${CSI}38;2;233;84;32m`;
const WHITE = `${CSI}97m`;

/** The upstream neofetch `ubuntu.txt` logo: 20 rows, 40 columns. */
const UBUNTU_LOGO = [
  '            .-/+oossssoo+/-.',
  '        `:+ssssssssssssssssss+:`',
  '      -+ssssssssssssssssssyyssss+-',
  '    .ossssssssssssssssssdMMMNysssso.',
  '   /ssssssssssshdmmNNmmyNMMMMhssssss/',
  '  +ssssssssshmydMMMMMMMNddddyssssssss+',
  ' /sssssssshNMMMyhhyyyyhmNMMMNhssssssss/',
  '.ssssssssdMMMNhsssssssssshNMMMdssssssss.',
  '+sssshhhyNMMNyssssssssssssyNMMMysssssss+',
  'ossyNMMMNyMMhsssssssssssssshmmmhssssssso',
  'ossyNMMMNyMMhsssssssssssssshmmmhssssssso',
  '+sssshhhyNMMNyssssssssssssyNMMMysssssss+',
  '.ssssssssdMMMNhsssssssssshNMMMdssssssss.',
  ' /sssssssshNMMMyhhyyyyhdNMMMNhssssssss/',
  '  +sssssssssdmydMMMMMMMMddddyssssssss+',
  '   /ssssssssssshdmNNNNmyNMMMMhssssss/',
  '    .ossssssssssssssssssdMMMNysssso.',
  '      -+sssssssssssssssssyyyssss+-',
  '        `:+ssssssssssssssssss+:`',
  '            .-/+oossssoo+/-.',
];

const LOGO_WIDTH = 40;
const GUTTER = '   ';

/**
 * Format the machine uptime the way neofetch does.
 * @returns {string} e.g. "2 hours, 41 mins"
 */
export function uptimePhrase() {
  const total = Math.floor(procs.uptime());
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} min${mins === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Screen geometry in neofetch's compact `1920x1080` form.
 *
 * `device.displayLabel()` is the single source — it re-reads the screen
 * metrics lazily, so calling it also covers the case where they were not
 * available at boot — and this only reshapes its GNOME-style punctuation.
 *
 * @returns {string}
 */
function resolutionPhrase() {
  const label = device.displayLabel();
  if (!/^\d/.test(label)) return 'Unknown (not reported by the browser)';
  return label.replace(' × ', 'x').replace(/, (\d+) Hz$/, ' @ $1Hz');
}

/**
 * The info rows shown to the right of the logo.
 * @returns {Array<[string, string]>} label / value pairs
 */
export function infoRows() {
  const totals = procs.totals();
  const deb = pkgdb.installed().length;
  const snapCount = pkgdb.snapList().length;
  return [
    ['OS', `Ubuntu 24.04.1 LTS ${device.arch()}`],
    ['Host', device.hostLabel()],
    ['Kernel', '6.8.0-45-generic'],
    ['Uptime', uptimePhrase()],
    ['Packages', `${deb} (dpkg), ${snapCount} (snap)`],
    ['Shell', 'bash 5.2.21'],
    ['Resolution', resolutionPhrase()],
    ['DE', 'GNOME 46.0'],
    ['WM', 'Mutter'],
    ['WM Theme', 'Yaru'],
    ['Theme', 'Yaru-dark [GTK2/3]'],
    ['Icons', 'Yaru [GTK2/3]'],
    ['Terminal', 'gnome-terminal'],
    ['CPU', device.cpuModel()],
    ['GPU', device.gpuModel()],
    ['Memory', `${Math.round(totals.memUsedMb)}MiB / ${Math.round(totals.memTotalMb)}MiB`],
    ['Locale', device.info().locale.language],
  ];
}

/** The two neofetch colour rows, drawn with block glyphs so any SGR subset works. */
function colourRows() {
  const block = '███';
  let dark = '';
  let bright = '';
  for (let i = 0; i < 8; i += 1) {
    dark += `${CSI}${30 + i}m${block}`;
    bright += `${CSI}${90 + i}m${block}`;
  }
  return [`${dark}${RESET}`, `${bright}${RESET}`];
}

/**
 * Compose the full neofetch screen.
 * @param {{ascii?:boolean}} [opts] `ascii:false` drops the logo (`--logo none`)
 * @returns {string}
 */
export function renderFetch(opts = {}) {
  const user = env.user || users.current.name;
  const host = env.host || users.hostname;
  const title = `${BOLD}${ORANGE}${user}${RESET}${WHITE}@${RESET}${BOLD}${ORANGE}${host}${RESET}`;
  const rule = `${WHITE}${'-'.repeat(user.length + host.length + 1)}${RESET}`;

  const right = [title, rule];
  for (const [label, value] of infoRows()) {
    right.push(`${BOLD}${ORANGE}${label}${RESET}${WHITE}: ${RESET}${value}`);
  }
  right.push('');
  for (const row of colourRows()) right.push(row);

  if (opts.ascii === false) return `${right.join('\n')}\n`;

  const rows = Math.max(UBUNTU_LOGO.length, right.length);
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const art = UBUNTU_LOGO[i] === undefined ? '' : UBUNTU_LOGO[i];
    const left = `${ORANGE}${art.padEnd(LOGO_WIDTH)}${RESET}`;
    const info = right[i] === undefined ? '' : right[i];
    out.push(`${left}${GUTTER}${info}`.replace(/[ \t]+$/, ''));
  }
  return `\n${out.join('\n')}\n\n`;
}

/**
 * Strip every SGR sequence from a rendered screen.
 * @param {string} text
 * @returns {string}
 */
export function stripSgr(text) {
  return String(text).replace(SGR_RE, '');
}

const MAN_FETCH = `NAME
       neofetch - simple system information script

SYNOPSIS
       neofetch [--off] [--logo none] [--stdout]

DESCRIPTION
       neofetch displays information about your operating system, software and
       hardware in an aesthetic and visually pleasing way. The overall purpose
       of neofetch is to be used in screenshots to show other users what
       operating system or distribution you are running, what theme or icon set
       you are using, and so on.

OPTIONS
       --off, --logo none
              Disable the ASCII distribution logo.

       --stdout
              Print without any colour escape sequences.`;

/** @type {object[]} */
const fetchCommands = [
  {
    name: 'neofetch',
    aliases: [],
    synopsis: 'neofetch [--off] [--stdout]',
    description: 'Show system information with the distribution logo',
    man: MAN_FETCH,
    async run(ctx) {
      const logoIdx = ctx.argv.indexOf('--logo');
      const off = ctx.argv.includes('--off')
        || ctx.argv.includes('--stdout')
        || (logoIdx >= 0 && ctx.argv[logoIdx + 1] === 'none');
      const text = renderFetch({ ascii: !off });
      const plain = ctx.argv.includes('--stdout');
      return { stdout: plain ? stripSgr(text) : text, stderr: '', code: 0 };
    },
  },
  {
    name: 'fastfetch',
    aliases: [],
    synopsis: 'fastfetch [--logo none] [--pipe]',
    description: 'Fast system information tool',
    man: MAN_FETCH.split('neofetch').join('fastfetch'),
    async run(ctx) {
      const logoIdx = ctx.argv.indexOf('--logo');
      const off = logoIdx >= 0 && ctx.argv[logoIdx + 1] === 'none';
      const text = renderFetch({ ascii: !off });
      return { stdout: ctx.argv.includes('--pipe') ? stripSgr(text) : text, stderr: '', code: 0 };
    },
  },
  {
    name: 'screenfetch',
    aliases: [],
    synopsis: 'screenfetch [-n] [-N]',
    description: 'Bash screenshot information tool',
    man: MAN_FETCH.split('neofetch').join('screenfetch'),
    async run(ctx) {
      const text = renderFetch({ ascii: !ctx.argv.includes('-n') });
      return { stdout: ctx.argv.includes('-N') ? stripSgr(text) : text, stderr: '', code: 0 };
    },
  },
];

export default fetchCommands;
