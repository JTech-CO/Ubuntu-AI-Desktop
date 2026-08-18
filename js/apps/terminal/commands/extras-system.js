/**
 * js/apps/terminal/commands/extras-system.js — rfkill, upower, resolvectl and
 * systemd-analyze.
 *
 * Three of these are wired to something real:
 *
 *  - rfkill drives the same Wi-Fi and Bluetooth switches the quick-settings
 *    menu owns, so `rfkill block wifi` really does turn the indicator off.
 *  - upower reports the host's actual battery through the Battery Status API
 *    where the browser implements it, and says plainly that it does not when
 *    the browser has removed it (Firefox and Safari both have).
 *  - systemd-analyze takes its "userspace" figure from the page's real
 *    Navigation Timing, which is the closest thing this desktop has to a boot.
 *
 * resolvectl reads the same interface and resolver tables `ip`, `nmcli` and
 * `dig` use, so all four agree about the network they are pretending to have.
 */

import { procs } from '../../../core/procs.js';
import { device } from '../../../core/device.js';
import { settings } from '../../settings/state.js';
import { IFACES, GATEWAY, lookup } from './net.js';
import { ok, fail, pad0, DAYS_SHORT, MONTHS_SHORT, tzAbbr } from './util.js';

/* ================================================================== *
 * rfkill
 * ================================================================== */

/** The radios this desktop actually has switches for. */
function radios() {
  return [
    {
      id: 0,
      type: 'bluetooth',
      device: 'hci0',
      key: 'bluetooth.enabled',
      names: ['bluetooth', 'bt', 'all'],
    },
    {
      id: 1,
      type: 'wlan',
      device: 'phy0',
      key: 'wifi.enabled',
      names: ['wifi', 'wlan', 'all'],
    },
  ];
}

function rfkillRow(radio) {
  const soft = settings.get(radio.key) ? 'unblocked' : 'blocked';
  return `${String(radio.id).padStart(2)} ${radio.type.padEnd(9)} ${radio.device.padEnd(11)}${soft.padStart(9)} ${'unblocked'.padStart(9)}`;
}

const rfkillCommand = {
  name: 'rfkill',
  aliases: [],
  synopsis: 'rfkill [list|block|unblock|toggle] [ID|TYPE]',
  description: 'Enable and disable wireless devices',
  man: `NAME
       rfkill - tool for enabling and disabling wireless devices

SYNOPSIS
       rfkill [list [id|type]]
       rfkill block id|type
       rfkill unblock id|type
       rfkill toggle id|type

DESCRIPTION
       Lists and changes the soft-block state of the wireless switches.

       These are not decorative. The two switches are the Wi-Fi and Bluetooth
       toggles the quick-settings menu and the Settings app own, so blocking
       Wi-Fi here turns the indicator off in the top bar, and toggling it back
       in the menu is visible from the next \`rfkill list\`.

       The hard block column always reads unblocked: a hard block is a
       physical switch or BIOS setting, and there is no such thing to read.

TYPES
       all, wifi (wlan), bluetooth (bt)

EXIT STATUS
       0  success
       1  an unknown id or type`,

  async run(ctx) {
    const argv = ctx.argv.filter((a) => !a.startsWith('-'));
    const verb = argv[0] || 'list';
    const target = argv[1];

    if (ctx.argv.includes('--version') || ctx.argv.includes('-V')) {
      return ok('rfkill from util-linux 2.39.3\n');
    }

    if (verb === 'list') {
      const list = radios().filter((r) => !target || r.names.includes(String(target).toLowerCase()) || String(r.id) === target);
      if (!list.length) return fail(`rfkill: invalid identifier: ${target}\n`, 1);
      const header = `ID TYPE      DEVICE     ${'SOFT'.padStart(9)} ${'HARD'.padStart(9)}`;
      return ok(`${[header, ...list.map(rfkillRow)].join('\n')}\n`);
    }

    if (verb === 'block' || verb === 'unblock' || verb === 'toggle') {
      if (!target) return fail(`rfkill: ${verb} requires an identifier\n`, 1);
      const list = radios().filter((r) => r.names.includes(String(target).toLowerCase()) || String(r.id) === target);
      if (!list.length) return fail(`rfkill: invalid identifier: ${target}\n`, 1);
      for (const radio of list) {
        const current = Boolean(settings.get(radio.key));
        const next = verb === 'block' ? false : verb === 'unblock' ? true : !current;
        settings.set(radio.key, next);
      }
      return ok('');
    }

    return fail(`rfkill: unknown command '${verb}'\nUsage: rfkill [list|block|unblock|toggle] [id|type]\n`, 1);
  },
};

/* ================================================================== *
 * upower
 * ================================================================== */

const AC_PATH = '/org/freedesktop/UPower/devices/line_power_AC';
const BAT_PATH = '/org/freedesktop/UPower/devices/battery_BAT0';
const DISPLAY_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

/** `Tue 18 Aug 2026 09:14:22 AM KST` — upower's timestamp. */
function upowerStamp(d) {
  const h = d.getHours();
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAYS_SHORT[d.getDay()]} ${pad0(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()} ` +
    `${pad0(h12)}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())} ${ampm} ${tzAbbr(d)}`;
}

/**
 * The battery block, or null when the browser exposes no battery at all.
 * @returns {string[]|null}
 */
function batteryBlock() {
  const b = device.info().battery;
  if (!b.supported || b.level === null) return null;
  const state = b.charging ? (b.level >= 100 ? 'fully-charged' : 'charging') : 'discharging';
  return [
    `  native-path:          BAT0`,
    `  power supply:         yes`,
    `  updated:              ${upowerStamp(new Date())} (0 seconds ago)`,
    `  has history:          no`,
    `  has statistics:       no`,
    `  battery`,
    `    present:             yes`,
    `    rechargeable:        yes`,
    `    state:               ${state}`,
    `    warning-level:       ${b.level <= 10 ? 'low' : 'none'}`,
    `    percentage:          ${b.level}%`,
    `    icon-name:          'battery-${b.level >= 90 ? 'full' : b.level >= 60 ? 'good' : b.level >= 30 ? 'normal' : b.level >= 10 ? 'low' : 'caution'}${b.charging ? '-charging' : ''}-symbolic'`,
    '',
    '  vendor, model, serial, energy, voltage, capacity and time-to-empty are',
    '  omitted: the browser Battery Status API reports only level and charging',
    '  state, and inventing the rest would make this output a fiction.',
  ];
}

const upowerCommand = {
  name: 'upower',
  aliases: [],
  synopsis: 'upower [-e] [-i PATH] [-d] [--version]',
  description: 'UPower command line tool',
  man: `NAME
       upower - UPower command line tool

SYNOPSIS
       upower [-e|--enumerate] [-i|--show-info PATH] [-d|--dump]

DESCRIPTION
       Reports the power devices UPower knows about.

       The battery is the host's real one. Chromium-based browsers implement
       the Battery Status API and this command reports what it returns —
       charge percentage and charging state, live. Firefox and Safari removed
       that API for fingerprinting reasons, and on those browsers upower says
       there is no battery device rather than inventing one.

       Even where the battery is visible, the API exposes only the level and
       the charging flag. Energy in watt-hours, design capacity, vendor,
       model and time-to-empty are not available to web content, so those
       lines are omitted instead of filled in.

OPTIONS
       -e, --enumerate    List device object paths.
       -i, --show-info    Show information about a device path.
       -d, --dump         Show information about every device.
       --version          Print the version.

EXIT STATUS
       0  success
       1  the requested device does not exist`,

  async run(ctx) {
    await device.ready();
    const argv = ctx.argv;
    if (argv.includes('--version')) return ok('UPower client version 1.90.2\n');

    const battery = batteryBlock();

    if (argv.includes('-e') || argv.includes('--enumerate')) {
      const paths = [AC_PATH];
      if (battery) paths.push(BAT_PATH);
      paths.push(DISPLAY_PATH);
      return ok(`${paths.join('\n')}\n`);
    }

    const acBlock = [
      '  native-path:          AC',
      '  power supply:         yes',
      `  updated:              ${upowerStamp(new Date())} (0 seconds ago)`,
      '  has history:          no',
      '  has statistics:       no',
      '  line-power',
      `    online:             ${battery ? (device.info().battery.charging ? 'yes' : 'no') : 'yes'}`,
      '',
    ];

    const infoIndex = argv.findIndex((a) => a === '-i' || a === '--show-info');
    if (infoIndex >= 0) {
      const path = argv[infoIndex + 1];
      if (path === AC_PATH) return ok(`Device: ${AC_PATH}\n${acBlock.join('\n')}\n`);
      if (path === BAT_PATH || path === DISPLAY_PATH) {
        if (!battery) {
          return fail(
            `upower: device ${path} does not exist.\n` +
            'upower: this browser does not implement the Battery Status API, so there is\n' +
            'upower: no battery to report. Chromium-based browsers do implement it.\n',
            1,
          );
        }
        return ok(`Device: ${path}\n${battery.join('\n')}\n`);
      }
      return fail(`upower: device ${path || ''} does not exist.\n`, 1);
    }

    if (argv.includes('-d') || argv.includes('--dump')) {
      const parts = [`Device: ${AC_PATH}`, ...acBlock];
      if (battery) parts.push(`Device: ${BAT_PATH}`, ...battery, '');
      parts.push('Daemon:');
      parts.push('  daemon-version:  1.90.2');
      parts.push(`  on-battery:      ${battery && !device.info().battery.charging ? 'yes' : 'no'}`);
      parts.push('  lid-is-closed:   no');
      parts.push('  lid-is-present:  ' + (battery ? 'yes' : 'no'));
      parts.push('  critical-action: HybridSleep');
      parts.push('');
      return ok(`${parts.join('\n')}\n`);
    }

    return ok([
      'Usage:',
      '  upower [OPTION…] UPower tool',
      '',
      'Help Options:',
      '  -h, --help       Show help options',
      '',
      'Application Options:',
      '  -e, --enumerate  Enumerate objects paths for devices',
      '  -d, --dump       Dump all parameters for all objects',
      '  -i, --show-info  Show information about object path',
      '  -v, --version    Print version of client and daemon',
      '',
    ].join('\n'));
  },
};

/* ================================================================== *
 * resolvectl
 * ================================================================== */

/** Interfaces systemd-resolved would attach a DNS scope to. */
function resolvedLinks() {
  return IFACES.filter((i) => i.name !== 'lo').map((i) => ({
    index: i.index,
    name: i.name,
    routable: i.name !== 'docker0',
  }));
}

const resolvectlCommand = {
  name: 'resolvectl',
  aliases: [],
  synopsis: 'resolvectl [status|dns|domain|statistics|flush-caches|query NAME]',
  description: 'Resolve names and inspect systemd-resolved',
  man: `NAME
       resolvectl - Resolve domain names, IPV4 and IPv6 addresses, DNS
       resource records and services

SYNOPSIS
       resolvectl [status|dns|domain|statistics|flush-caches]
       resolvectl query HOSTNAME

DESCRIPTION
       Inspects the systemd-resolved stub resolver.

       The interfaces, addresses and upstream server come from the same table
       that ip, ifconfig, nmcli and netstat read, so all of them describe one
       consistent network.

       That network is simulated. No packet leaves the page: resolvectl query
       answers from the same deterministic resolver dig and ping use, which
       returns a stable address for a syntactically valid name and NXDOMAIN
       for one that is not. The Gemini API is the only host this desktop ever
       really contacts, and that goes through the browser's own stack, not
       through anything here.

COMMANDS
       status         Show the global and per-link resolver configuration.
       dns            Show the DNS servers per link.
       domain         Show the search domains per link.
       statistics     Show cache and transaction statistics.
       flush-caches   Flush the resolver caches.
       query NAME     Resolve a name.

EXIT STATUS
       0  success
       1  the name did not resolve, or the command is unknown`,

  async run(ctx) {
    const argv = ctx.argv.filter((a) => !a.startsWith('-'));
    const verb = argv[0] || 'status';

    if (ctx.argv.includes('--version')) return ok('systemd 255 (255.4-1ubuntu8.4)\n');

    if (verb === 'status') {
      const out = [
        'Global',
        '         Protocols: LLMNR=resolve -mDNS -DNSOverTLS DNSSEC=no/unsupported',
        '  resolv.conf mode: stub',
      ];
      for (const link of resolvedLinks()) {
        out.push('');
        out.push(`Link ${link.index} (${link.name})`);
        out.push(`    Current Scopes: ${link.routable ? 'DNS LLMNR/IPv4 LLMNR/IPv6' : 'none'}`);
        out.push(`         Protocols: ${link.routable ? '+DefaultRoute' : '-DefaultRoute'} +LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported`);
        if (link.routable) {
          out.push(`Current DNS Server: ${GATEWAY}`);
          out.push(`       DNS Servers: ${GATEWAY}`);
          out.push('        DNS Domain: lan');
        }
      }
      out.push('');
      return ok(`${out.join('\n')}\n`);
    }

    if (verb === 'dns') {
      const out = ['Global:'];
      for (const link of resolvedLinks()) {
        out.push(`Link ${link.index} (${link.name}): ${link.routable ? GATEWAY : ''}`.trimEnd());
      }
      out.push('');
      return ok(out.join('\n'));
    }

    if (verb === 'domain') {
      const out = ['Global:'];
      for (const link of resolvedLinks()) {
        out.push(`Link ${link.index} (${link.name}): ${link.routable ? 'lan' : ''}`.trimEnd());
      }
      out.push('');
      return ok(out.join('\n'));
    }

    if (verb === 'statistics') {
      const up = Math.max(1, Math.floor(procs.uptime()));
      const transactions = Math.round(up * 0.13) + 12;
      const hits = Math.round(transactions * 0.7);
      return ok([
        'DNSSEC verdicts',
        '===============',
        'secure:            0',
        'insecure:          0',
        'bogus:             0',
        'indeterminate:     0',
        '',
        'Transactions',
        '============',
        'Current Transactions: 0',
        `  Total Transactions: ${transactions}`,
        '',
        'Cache',
        '=====',
        `  Current Cache Size: ${Math.min(64, Math.round(transactions / 8))}`,
        `          Cache Hits: ${hits}`,
        `        Cache Misses: ${transactions - hits}`,
        '',
      ].join('\n'));
    }

    if (verb === 'flush-caches') return ok('');

    if (verb === 'query') {
      const name = argv[1];
      if (!name) return fail('resolvectl: query requires a name\n', 1);
      const found = lookup(name);
      if (!found) {
        return fail(`${name}: Name or service not known\n`, 1);
      }
      const link = resolvedLinks().find((l) => l.routable);
      const ms = (8 + (name.length % 30)).toFixed(1);
      return ok([
        `${name}: ${found.ip}${link ? `                     -- link: ${link.name}` : ''}`,
        '',
        `-- Information acquired via protocol DNS in ${ms}ms.`,
        '-- Data is authenticated: no; Data was acquired via local or encrypted transport: no',
        '-- Data from: network',
        '',
      ].join('\n'));
    }

    return fail(`Unknown command verb "${verb}".\n`, 1);
  },
};

/* ================================================================== *
 * systemd-analyze
 * ================================================================== */

/** Fixed pre-userspace phases; there is no firmware or kernel to time. */
const BOOT_PHASES = { firmware: 6.128, loader: 2.281, kernel: 1.472 };

/**
 * The real time this page took to become usable, from Navigation Timing.
 * Falls back to `performance.now()` when the entry is unavailable.
 * @returns {number} seconds
 */
function userspaceSeconds() {
  try {
    const entries = performance.getEntriesByType('navigation');
    const nav = entries && entries[0];
    const ms = nav ? (nav.loadEventEnd || nav.domComplete || nav.duration) : 0;
    if (ms > 0) return ms / 1000;
  } catch {
    /* Navigation Timing Level 2 is missing on very old engines. */
  }
  return Math.max(0.2, performance.now() / 1000);
}

/** The units systemd-analyze blame would list, scaled to the real boot time. */
function blameUnits(userspace) {
  const shares = [
    ['snapd.service', 0.51],
    ['NetworkManager-wait-online.service', 0.17],
    ['systemd-journal-flush.service', 0.09],
    ['udisks2.service', 0.06],
    ['snapd.seeded.service', 0.05],
    ['accounts-daemon.service', 0.04],
    ['ModemManager.service', 0.03],
    ['polkit.service', 0.02],
    ['systemd-udev-trigger.service', 0.02],
    ['gdm.service', 0.01],
  ];
  return shares.map(([unit, share]) => ({ unit, seconds: userspace * share }));
}

/** `1.472s` or `312ms` — systemd's duration format. */
function span(seconds) {
  if (seconds >= 1) return `${seconds.toFixed(3)}s`;
  return `${Math.round(seconds * 1000)}ms`;
}

const systemdAnalyzeCommand = {
  name: 'systemd-analyze',
  aliases: [],
  synopsis: 'systemd-analyze [time|blame|critical-chain]',
  description: 'Analyse system boot-up performance',
  man: `NAME
       systemd-analyze - Analyze and debug system manager

SYNOPSIS
       systemd-analyze [time|blame|critical-chain]

DESCRIPTION
       Reports how long the boot took and which units took longest.

       The userspace figure is real. It is the page's own Navigation Timing —
       the time from the browser starting the navigation to the load event
       finishing — which is genuinely how long this desktop took to come up on
       this machine, on this network, today. Reload the page on a slow
       connection and the number changes.

       The firmware, loader and kernel figures are fixed constants: there is
       no firmware and no kernel here to time, and the man page says so rather
       than the numbers pretending otherwise.

       blame and critical-chain distribute the real userspace figure across
       the unit list that systemctl shows, so the totals stay consistent with
       the time report.

COMMANDS
       time            Print the boot time breakdown (the default).
       blame           List units by initialisation time, slowest first.
       critical-chain  Print the tree of time-critical units.

EXIT STATUS
       0  always`,

  async run(ctx) {
    const verb = ctx.argv.find((a) => !a.startsWith('-')) || 'time';
    if (ctx.argv.includes('--version')) {
      return ok('systemd 255 (255.4-1ubuntu8.4)\n+PAM +AUDIT +SELINUX +APPARMOR +IMA\n');
    }

    const userspace = userspaceSeconds();
    const total = BOOT_PHASES.firmware + BOOT_PHASES.loader + BOOT_PHASES.kernel + userspace;

    if (verb === 'time') {
      return ok(
        `Startup finished in ${span(BOOT_PHASES.firmware)} (firmware) + ${span(BOOT_PHASES.loader)} (loader) + ` +
        `${span(BOOT_PHASES.kernel)} (kernel) + ${span(userspace)} (userspace) = ${span(total)} \n` +
        `graphical.target reached after ${span(userspace * 0.998)} in userspace.\n`,
      );
    }

    if (verb === 'blame') {
      const units = blameUnits(userspace).sort((a, b) => b.seconds - a.seconds);
      const width = Math.max(...units.map((u) => span(u.seconds).length));
      return ok(`${units.map((u) => `${span(u.seconds).padStart(width)} ${u.unit}`).join('\n')}\n`);
    }

    if (verb === 'critical-chain') {
      const units = blameUnits(userspace);
      const reached = userspace * 0.998;
      return ok([
        'The time when unit became active or started is printed after the "@" character.',
        'The time the unit took to start is printed after the "+" character.',
        '',
        `graphical.target @${span(reached)}`,
        `└─multi-user.target @${span(reached)}`,
        `  └─snapd.seeded.service @${span(reached - units[4].seconds)} +${span(units[4].seconds)}`,
        `    └─snapd.service @${span(reached - units[0].seconds)} +${span(units[0].seconds)}`,
        `      └─basic.target @${span(reached - units[0].seconds - 0.01)}`,
        `        └─sockets.target @${span(reached - units[0].seconds - 0.02)}`,
        `          └─snapd.socket @${span(reached - units[0].seconds - 0.03)} +${span(0.008)}`,
        `            └─sysinit.target @${span(reached - units[0].seconds - 0.04)}`,
        '',
      ].join('\n'));
    }

    return fail(`Unknown operation ${verb}.\n`, 1);
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const systemExtras = [
  rfkillCommand,
  upowerCommand,
  resolvectlCommand,
  systemdAnalyzeCommand,
];

export default systemExtras;
