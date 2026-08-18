/**
 * js/apps/terminal/commands/extras.js — the fidelity commands.
 *
 * These are the tools that make the emulator feel like a machine rather than
 * a demo: the display stack, the performance counters, the desktop
 * configuration database, the freedesktop helpers, the login records and the
 * bits of systemd a user actually types.
 *
 * This file is an aggregator, exactly like `system.js`. The implementations
 * live in siblings so no single module grows past a readable size, and only
 * this one is listed in `index.js` — listing the siblings too would register
 * every command twice.
 *
 *   extras-x11.js        xrandr xdpyinfo glxinfo inxi
 *   extras-perf.js       vmstat iostat
 *   extras-lsof.js       lsof fuser
 *   extras-dev.js        strace ldd getconf dpkg-architecture update-alternatives
 *   extras-gsettings.js  gsettings dconf
 *   extras-xdg.js        xdg-user-dir xdg-mime
 *   extras-system.js     rfkill upower resolvectl systemd-analyze
 *   extras-users.js      w users last lastlog passwd adduser useradd crontab
 *
 * The through-line is honesty. Where a real figure exists — the screen, the
 * refresh rate, the GPU, the core count, the architecture, the battery, the
 * page's own load time — these commands report the real one. Where the
 * browser refuses to say (physical panel size, CPU model, driver version) or
 * the emulator genuinely cannot do the job (ptrace, ELF linkage, adding a
 * user), they say so in the tool's own voice instead of inventing a
 * plausible number.
 */

import x11Commands from './extras-x11.js';
import perfCommands from './extras-perf.js';
import lsofCommands from './extras-lsof.js';
import devCommands from './extras-dev.js';
import gsettingsCommands from './extras-gsettings.js';
import xdgCommands from './extras-xdg.js';
import systemExtras from './extras-system.js';
import userCommands from './extras-users.js';

/** @type {object[]} every extra command, in registration order */
const extraCommands = [
  ...x11Commands,
  ...perfCommands,
  ...lsofCommands,
  ...devCommands,
  ...gsettingsCommands,
  ...xdgCommands,
  ...systemExtras,
  ...userCommands,
];

export default extraCommands;
