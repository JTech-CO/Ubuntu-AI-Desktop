/**
 * js/apps/terminal/commands/pkg.js — apt, apt-get, apt-cache, dpkg, snap,
 * add-apt-repository and do-release-upgrade.
 *
 * All state lives in `./pkg-db.js`; nothing here keeps its own store. An
 * install really does create the package's binaries under /usr/bin (mode
 * 0755) so `which` and `ls /usr/bin` agree with dpkg, and every state change
 * is appended to /var/log/dpkg.log in the genuine format.
 */

import { fs } from '../../../core/fs.js';
import { env } from '../../../core/env.js';
import { pkgdb } from './pkg-db.js';
import {
  ok, fail, wait, aborted, isRoot, group, aptSize, wrap, termCols, pad0,
} from './util.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const SUITE = 'noble';
const ARCHIVE = 'http://archive.ubuntu.com/ubuntu';
const SECURITY = 'http://security.ubuntu.com/ubuntu';
const MAINTAINER = 'Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>';
const MANDB_VERSION = '2.12.0-4build2';
const DPKG_LOG = '/var/log/dpkg.log';

/** The two lines apt prints when it cannot take the dpkg frontend lock. */
const LOCK_ERROR =
  'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\n'
  + 'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * Refuse an operation that needs root, exactly the way apt does.
 * @param {object} ctx
 * @returns {{stdout:string, stderr:string, code:number}|null} null when root
 */
function needRoot(ctx) {
  if (isRoot(ctx)) return null;
  return fail(LOCK_ERROR, 100);
}

/** The archive component a package is published in. */
function component(pkg) {
  return pkg.priority === 'important' ? 'main' : 'universe';
}

/** `2026-08-18 07:31:22` — the /var/log/dpkg.log timestamp. */
function dpkgStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad0(d.getMonth() + 1)}-${pad0(d.getDate())} `
    + `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}`;
}

/**
 * Append lines to /var/log/dpkg.log, creating it if a previous reset removed
 * it. Never throws: a read-only log must not break an install.
 * @param {string[]} lines
 */
function logDpkg(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  try {
    fs.writeFile(DPKG_LOG, `${lines.join('\n')}\n`, { append: true, create: true });
  } catch {
    /* the log is a convenience, not a precondition */
  }
}

/** The dpkg.log record set for one install. */
function installLog(pkg, when = new Date()) {
  const id = `${pkg.name}:${pkg.arch}`;
  const t0 = dpkgStamp(when);
  const t1 = dpkgStamp(new Date(when.getTime() + 1000));
  return [
    `${t0} startup archives unpack`,
    `${t0} install ${id} <none> ${pkg.version}`,
    `${t0} status half-installed ${id} ${pkg.version}`,
    `${t1} status unpacked ${id} ${pkg.version}`,
    `${t1} startup packages configure`,
    `${t1} configure ${id} ${pkg.version} <none>`,
    `${t1} status unpacked ${id} ${pkg.version}`,
    `${t1} status half-configured ${id} ${pkg.version}`,
    `${t1} status installed ${id} ${pkg.version}`,
  ];
}

/** The dpkg.log record set for one removal. */
function removeLog(pkg, when = new Date()) {
  const id = `${pkg.name}:${pkg.arch}`;
  const t0 = dpkgStamp(when);
  const t1 = dpkgStamp(new Date(when.getTime() + 1000));
  return [
    `${t0} startup packages remove`,
    `${t0} remove ${id} ${pkg.version} <none>`,
    `${t0} status half-configured ${id} ${pkg.version}`,
    `${t0} status half-installed ${id} ${pkg.version}`,
    `${t1} status config-files ${id} ${pkg.version}`,
    `${t1} status not-installed ${id} <none>`,
  ];
}

/** The dpkg.log record set for one upgrade. */
function upgradeLog(pkg, from, to, when = new Date()) {
  const id = `${pkg.name}:${pkg.arch}`;
  const t0 = dpkgStamp(when);
  const t1 = dpkgStamp(new Date(when.getTime() + 1000));
  return [
    `${t0} startup archives unpack`,
    `${t0} upgrade ${id} ${from} ${to}`,
    `${t0} status half-configured ${id} ${from}`,
    `${t0} status unpacked ${id} ${to}`,
    `${t1} startup packages configure`,
    `${t1} configure ${id} ${to} <none>`,
    `${t1} status half-configured ${id} ${to}`,
    `${t1} status installed ${id} ${to}`,
  ];
}

/**
 * Create the package's programs under /usr/bin so `which` finds them.
 * @param {object} pkg
 */
function materialise(pkg) {
  for (const bin of pkg.binaries) {
    if (!/^[A-Za-z0-9._+-]+$/.test(bin)) continue;
    try {
      fs.writeFile(`/usr/bin/${bin}`, '', { mode: 0o755, owner: 'root', group: 'root' });
    } catch {
      /* a pre-existing directory of that name is not worth aborting for */
    }
  }
}

/**
 * Delete the package's programs from /usr/bin.
 * @param {object} pkg
 */
function dematerialise(pkg) {
  for (const bin of pkg.binaries) {
    const p = `/usr/bin/${bin}`;
    try {
      if (fs.exists(p) && fs.isFile(p)) fs.unlink(p);
    } catch {
      /* already gone */
    }
  }
}

/** The file count dpkg reports; stable for a given installed set. */
function databaseCount() {
  return 181_204 + pkgdb.installed().length * 47;
}

/**
 * apt's two-space-indented, terminal-width-wrapped package list.
 * @param {string[]} names
 * @param {number} cols
 * @returns {string[]}
 */
function indentedList(names, cols) {
  if (names.length === 0) return [];
  return wrap(names.join(' '), Math.max(20, cols - 2)).map((l) => `  ${l}`);
}

/** "0 upgraded, N newly installed, M to remove and K not upgraded." */
function tallyLine(upgraded, installed, removed) {
  const pending = pkgdb.upgradable().length;
  return `${upgraded} upgraded, ${installed} newly installed, ${removed} to remove and ${pending} not upgraded.`;
}

/**
 * Suggestions for a package: same-section neighbours that are not installed
 * and not part of this transaction. Derived, so it can never name something
 * the catalogue does not have.
 * @param {object[]} pkgs
 * @param {Set<string>} exclude
 * @returns {string[]}
 */
function suggestionsFor(pkgs, exclude) {
  const out = [];
  const sections = new Set(pkgs.map((p) => p.section));
  for (const candidate of pkgdb.all()) {
    if (out.length >= 4) break;
    if (candidate.installed || exclude.has(candidate.name)) continue;
    if (!sections.has(candidate.section)) continue;
    if (candidate.name.startsWith('lib')) continue;
    out.push(candidate.name);
  }
  return out;
}

/**
 * Write a batch of lines to the terminal with a small delay between them so
 * the transfer looks like a transfer. Stops immediately on Ctrl+C.
 * @param {object} ctx
 * @param {string[]} lines
 * @param {number} [delay]
 * @returns {Promise<boolean>} false when interrupted
 */
async function stream(ctx, lines, delay = 45) {
  for (const line of lines) {
    if (aborted(ctx.signal)) return false;
    ctx.term.write(`${line}\n`);
    if (delay > 0) await wait(delay, ctx.signal);
  }
  return !aborted(ctx.signal);
}

/**
 * Ask apt's confirmation question.
 * @param {object} ctx
 * @param {boolean} assumeYes
 * @returns {Promise<boolean>}
 */
async function confirm(ctx, assumeYes) {
  if (assumeYes) return true;
  const answer = await ctx.term.ask('Do you want to continue? [Y/n] ');
  const value = String(answer === null || answer === undefined ? '' : answer).trim().toLowerCase();
  return value === '' || value === 'y' || value === 'yes';
}

/** The `Get:` lines for a transaction. */
function getLines(pkgs, upgrade = false) {
  const lines = [];
  pkgs.forEach((pkg, i) => {
    const suite = upgrade ? `${SUITE}-updates` : SUITE;
    const host = upgrade && pkg.priority === 'important' ? SECURITY : ARCHIVE;
    const version = upgrade ? pkg.candidate : pkg.version;
    lines.push(
      `Get:${i + 1} ${host} ${suite}/${component(pkg)} amd64 ${pkg.name} ${pkg.arch} `
      + `${version} [${aptSize(pkg.download)}]`,
    );
  });
  return lines;
}

/** "Fetched 3,412 kB in 2s (1,706 kB/s)". */
function fetchedLine(kb) {
  const seconds = Math.max(1, Math.round(kb / 1400));
  const bytes = kb * 1024;
  const shown = bytes < 1000 * 1000 ? `${group(bytes / 1000)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
  const rate = bytes / 1000 / seconds;
  const rateText = rate < 1000 ? `${group(rate)} kB/s` : `${(rate / 1000).toFixed(1)} MB/s`;
  return `Fetched ${shown} in ${seconds}s (${rateText})`;
}

const READING_LISTS = [
  'Reading package lists... Done',
  'Building dependency tree... Done',
  'Reading state information... Done',
];

/* ------------------------------------------------------------------ *
 * apt update
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function aptUpdate(ctx) {
  const denied = needRoot(ctx);
  if (denied) return denied;

  const rows = [
    { host: ARCHIVE, suite: SUITE, kind: 'InRelease', kb: 0 },
    { host: ARCHIVE, suite: `${SUITE}-updates`, kind: 'InRelease', kb: 126 },
    { host: ARCHIVE, suite: `${SUITE}-backports`, kind: 'InRelease', kb: 126 },
    { host: SECURITY, suite: `${SUITE}-security`, kind: 'InRelease', kb: 126 },
    { host: ARCHIVE, suite: `${SUITE}-updates`, kind: 'main amd64 Packages', kb: 1024 },
    { host: ARCHIVE, suite: `${SUITE}-updates`, kind: 'main Translation-en', kb: 232 },
    { host: ARCHIVE, suite: `${SUITE}-updates`, kind: 'universe amd64 Packages', kb: 1114 },
    { host: ARCHIVE, suite: `${SUITE}-updates`, kind: 'universe Translation-en', kb: 296 },
    { host: ARCHIVE, suite: `${SUITE}-backports`, kind: 'main amd64 Packages', kb: 12 },
    { host: SECURITY, suite: `${SUITE}-security`, kind: 'main amd64 Packages', kb: 812 },
    { host: SECURITY, suite: `${SUITE}-security`, kind: 'main Translation-en', kb: 168 },
    { host: SECURITY, suite: `${SUITE}-security`, kind: 'universe amd64 Packages', kb: 749 },
  ];

  const lines = [];
  let n = 0;
  let fetched = 0;
  for (const row of rows) {
    n += 1;
    const label = row.kind === 'InRelease' ? `${row.suite} InRelease` : `${row.suite}/${row.kind}`;
    if (row.kb === 0) {
      lines.push(`Hit:${n} ${row.host} ${label}`);
    } else {
      fetched += row.kb;
      lines.push(`Get:${n} ${row.host} ${label} [${aptSize(row.kb)}]`);
    }
  }

  if (!await stream(ctx, lines, 55)) return { stdout: '', stderr: '', code: 130 };

  const tail = [
    fetchedLine(fetched),
    ...READING_LISTS,
  ];
  const pending = pkgdb.upgradable().length;
  tail.push(pending === 0
    ? 'All packages are up to date.'
    : `${pending} package${pending === 1 ? '' : 's'} can be upgraded. Run 'apt list --upgradable' to see them.`);

  if (!await stream(ctx, tail, 90)) return { stdout: '', stderr: '', code: 130 };

  pkgdb.touchUpdate();
  return { stdout: '', stderr: '', code: 0 };
}

/* ------------------------------------------------------------------ *
 * apt install
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx
 * @param {string[]} names
 * @param {{yes:boolean, simulate:boolean}} opts
 */
async function aptInstall(ctx, names, opts) {
  const denied = needRoot(ctx);
  if (denied) return denied;

  if (names.length === 0) {
    return fail(`${ctx.name}: no packages specified\n`, 100);
  }

  for (const name of names) {
    if (!pkgdb.has(name)) return fail(`E: Unable to locate package ${name}\n`, 100);
  }

  const cols = termCols(ctx);
  const head = [...READING_LISTS];

  const already = names.filter((n) => pkgdb.isInstalled(n));
  const wanted = names.filter((n) => !pkgdb.isInstalled(n));

  /* --- nothing to do -------------------------------------------- */
  if (wanted.length === 0) {
    for (const n of already) {
      const pkg = pkgdb.get(n);
      head.push(`${pkg.name} is already the newest version (${pkg.version}).`);
      if (pkg.auto) {
        head.push(`${pkg.name} set to manually installed.`);
        pkgdb.markInstalled(pkg.name, { auto: false });
      }
    }
    head.push(tallyLine(0, 0, 0));
    if (!await stream(ctx, head, 60)) return { stdout: '', stderr: '', code: 130 };
    return { stdout: '', stderr: '', code: 0 };
  }

  /* --- resolve ---------------------------------------------------- */
  const extraSet = new Set();
  for (const n of wanted) {
    for (const dep of pkgdb.resolveDeps(n)) {
      if (!names.includes(dep)) extraSet.add(dep);
    }
  }
  const extras = Array.from(extraSet).sort();
  const newNames = [...extras, ...wanted].sort();
  const newPkgs = newNames.map((n) => pkgdb.get(n)).filter(Boolean);

  for (const n of already) {
    const pkg = pkgdb.get(n);
    head.push(`${pkg.name} is already the newest version (${pkg.version}).`);
  }

  if (extras.length > 0) {
    head.push('The following additional packages will be installed:');
    head.push(...indentedList(extras, cols));
  }

  const suggested = suggestionsFor(newPkgs, new Set(newNames));
  if (suggested.length > 0) {
    head.push('Suggested packages:');
    head.push(...indentedList(suggested, cols));
  }

  head.push('The following NEW packages will be installed:');
  head.push(...indentedList(newNames, cols));
  head.push(tallyLine(0, newNames.length, 0));

  const downloadKb = pkgdb.sumDownload(newNames);
  const installKb = pkgdb.sumInstalled(newNames);
  head.push(`Need to get ${aptSize(downloadKb)} of archives.`);
  head.push(`After this operation, ${aptSize(installKb)} of additional disk space will be used.`);

  if (!await stream(ctx, head, 50)) return { stdout: '', stderr: '', code: 130 };

  if (opts.simulate) {
    const sim = [];
    for (const pkg of newPkgs) sim.push(`Inst ${pkg.name} (${pkg.version} Ubuntu:24.04/${SUITE} [${pkg.arch}])`);
    for (const pkg of newPkgs) sim.push(`Conf ${pkg.name} (${pkg.version} Ubuntu:24.04/${SUITE} [${pkg.arch}])`);
    await stream(ctx, sim, 20);
    return { stdout: '', stderr: '', code: 0 };
  }

  if (!await confirm(ctx, opts.yes)) {
    ctx.term.write('Abort.\n');
    return { stdout: '', stderr: '', code: 1 };
  }
  if (aborted(ctx.signal)) return { stdout: '', stderr: '', code: 130 };

  /* --- fetch ------------------------------------------------------ */
  if (!await stream(ctx, getLines(newPkgs), 90)) return { stdout: '', stderr: '', code: 130 };
  if (!await stream(ctx, [fetchedLine(downloadKb)], 120)) return { stdout: '', stderr: '', code: 130 };

  /* --- unpack + configure ----------------------------------------- */
  const body = [];
  let first = true;
  for (const pkg of newPkgs) {
    body.push(`Selecting previously unselected package ${pkg.name}.`);
    if (first) {
      body.push(`(Reading database ... ${databaseCount()} files and directories currently installed.)`);
      first = false;
    }
    body.push(`Preparing to unpack .../${pkg.name}_${pkg.version}_${pkg.arch}.deb ...`);
    body.push(`Unpacking ${pkg.name} (${pkg.version}) ...`);
  }
  for (const pkg of newPkgs) {
    body.push(`Setting up ${pkg.name} (${pkg.version}) ...`);
  }
  body.push(`Processing triggers for man-db (${MANDB_VERSION}) ...`);

  if (!await stream(ctx, body, 70)) return { stdout: '', stderr: '', code: 130 };

  /* --- commit ------------------------------------------------------ */
  const log = [];
  const now = new Date();
  for (const pkg of newPkgs) {
    pkgdb.markInstalled(pkg.name, { auto: extraSet.has(pkg.name) });
    materialise(pkg);
    log.push(...installLog(pkg, now));
  }
  logDpkg(log);

  return { stdout: '', stderr: '', code: 0 };
}

/* ------------------------------------------------------------------ *
 * apt remove / purge / autoremove
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx
 * @param {string[]} names
 * @param {{yes:boolean, purge:boolean, simulate:boolean}} opts
 */
async function aptRemove(ctx, names, opts) {
  const denied = needRoot(ctx);
  if (denied) return denied;

  if (names.length === 0) return fail(`${ctx.name}: no packages specified\n`, 100);

  const cols = termCols(ctx);
  const head = [...READING_LISTS];

  const unknown = names.filter((n) => !pkgdb.has(n));
  if (unknown.length > 0) return fail(`E: Unable to locate package ${unknown[0]}\n`, 100);

  const doomed = names.filter((n) => pkgdb.isInstalled(n));
  const absent = names.filter((n) => !pkgdb.isInstalled(n));

  for (const n of absent) head.push(`Package '${n}' is not installed, so not removed`);

  if (doomed.length === 0) {
    head.push(tallyLine(0, 0, 0));
    if (!await stream(ctx, head, 60)) return { stdout: '', stderr: '', code: 130 };
    return { stdout: '', stderr: '', code: 0 };
  }

  const orphans = pkgdb.autoremovable().filter((n) => !doomed.includes(n));
  if (orphans.length > 0) {
    head.push('The following packages were automatically installed and are no longer required:');
    head.push(...indentedList(orphans, cols));
    head.push("Use 'sudo apt autoremove' to remove them.");
  }

  head.push('The following packages will be REMOVED:');
  head.push(...indentedList(doomed.map((n) => (opts.purge ? `${n}*` : n)).sort(), cols));
  head.push(tallyLine(0, 0, doomed.length));
  head.push(`After this operation, ${aptSize(pkgdb.sumInstalled(doomed))} disk space will be freed.`);

  if (!await stream(ctx, head, 50)) return { stdout: '', stderr: '', code: 130 };

  if (opts.simulate) {
    await stream(ctx, doomed.map((n) => `Remv ${n} [${pkgdb.get(n).version}]`), 25);
    return { stdout: '', stderr: '', code: 0 };
  }

  if (!await confirm(ctx, opts.yes)) {
    ctx.term.write('Abort.\n');
    return { stdout: '', stderr: '', code: 1 };
  }
  if (aborted(ctx.signal)) return { stdout: '', stderr: '', code: 130 };

  const body = [`(Reading database ... ${databaseCount()} files and directories currently installed.)`];
  for (const n of doomed) {
    const pkg = pkgdb.get(n);
    body.push(`Removing ${pkg.name} (${pkg.version}) ...`);
    if (opts.purge) body.push(`Purging configuration files for ${pkg.name} (${pkg.version}) ...`);
  }
  body.push(`Processing triggers for man-db (${MANDB_VERSION}) ...`);

  if (!await stream(ctx, body, 70)) return { stdout: '', stderr: '', code: 130 };

  const log = [];
  const now = new Date();
  for (const n of doomed) {
    const pkg = pkgdb.get(n);
    dematerialise(pkg);
    log.push(...removeLog(pkg, now));
    pkgdb.markRemoved(n);
  }
  logDpkg(log);

  return { stdout: '', stderr: '', code: 0 };
}

/**
 * @param {object} ctx
 * @param {{yes:boolean, simulate:boolean}} opts
 */
async function aptAutoremove(ctx, opts) {
  const denied = needRoot(ctx);
  if (denied) return denied;

  const cols = termCols(ctx);
  const orphans = pkgdb.autoremovable();
  const head = [...READING_LISTS];

  if (orphans.length === 0) {
    head.push(tallyLine(0, 0, 0));
    if (!await stream(ctx, head, 60)) return { stdout: '', stderr: '', code: 130 };
    return { stdout: '', stderr: '', code: 0 };
  }

  head.push('The following packages will be REMOVED:');
  head.push(...indentedList(orphans, cols));
  head.push(tallyLine(0, 0, orphans.length));
  head.push(`After this operation, ${aptSize(pkgdb.sumInstalled(orphans))} disk space will be freed.`);

  if (!await stream(ctx, head, 50)) return { stdout: '', stderr: '', code: 130 };
  if (opts.simulate) return { stdout: '', stderr: '', code: 0 };

  if (!await confirm(ctx, opts.yes)) {
    ctx.term.write('Abort.\n');
    return { stdout: '', stderr: '', code: 1 };
  }

  const body = [`(Reading database ... ${databaseCount()} files and directories currently installed.)`];
  for (const n of orphans) body.push(`Removing ${n} (${pkgdb.get(n).version}) ...`);
  body.push(`Processing triggers for man-db (${MANDB_VERSION}) ...`);
  if (!await stream(ctx, body, 60)) return { stdout: '', stderr: '', code: 130 };

  const log = [];
  const now = new Date();
  for (const n of orphans) {
    const pkg = pkgdb.get(n);
    dematerialise(pkg);
    log.push(...removeLog(pkg, now));
    pkgdb.markRemoved(n);
  }
  logDpkg(log);

  return { stdout: '', stderr: '', code: 0 };
}

/* ------------------------------------------------------------------ *
 * apt upgrade
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx
 * @param {{yes:boolean, simulate:boolean, dist:boolean}} opts
 */
async function aptUpgrade(ctx, opts) {
  const denied = needRoot(ctx);
  if (denied) return denied;

  const cols = termCols(ctx);
  const pending = pkgdb.upgradable();
  const head = [...READING_LISTS, 'Calculating upgrade... Done'];

  if (pending.length === 0) {
    head.push('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');
    if (!await stream(ctx, head, 60)) return { stdout: '', stderr: '', code: 130 };
    return { stdout: '', stderr: '', code: 0 };
  }

  const names = pending.map((p) => p.name).sort();
  head.push('The following packages will be upgraded:');
  head.push(...indentedList(names, cols));
  head.push(`${pending.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`);
  head.push(`Need to get ${aptSize(pkgdb.sumDownload(names))} of archives.`);
  head.push('After this operation, 0 B of additional disk space will be used.');

  if (!await stream(ctx, head, 50)) return { stdout: '', stderr: '', code: 130 };

  if (opts.simulate) {
    await stream(ctx, pending.map((p) => `Inst ${p.name} [${p.version}] (${p.candidate} Ubuntu:24.04/${SUITE}-updates [${p.arch}])`), 20);
    return { stdout: '', stderr: '', code: 0 };
  }

  if (!await confirm(ctx, opts.yes)) {
    ctx.term.write('Abort.\n');
    return { stdout: '', stderr: '', code: 1 };
  }
  if (aborted(ctx.signal)) return { stdout: '', stderr: '', code: 130 };

  if (!await stream(ctx, getLines(pending, true), 80)) return { stdout: '', stderr: '', code: 130 };
  if (!await stream(ctx, [fetchedLine(pkgdb.sumDownload(names))], 120)) return { stdout: '', stderr: '', code: 130 };

  const body = [`(Reading database ... ${databaseCount()} files and directories currently installed.)`];
  for (const pkg of pending) {
    body.push(`Preparing to unpack .../${pkg.name}_${pkg.candidate}_${pkg.arch}.deb ...`);
    body.push(`Unpacking ${pkg.name} (${pkg.candidate}) over (${pkg.version}) ...`);
  }
  for (const pkg of pending) body.push(`Setting up ${pkg.name} (${pkg.candidate}) ...`);
  body.push(`Processing triggers for man-db (${MANDB_VERSION}) ...`);
  body.push('Processing triggers for libc-bin (2.39-0ubuntu8.3) ...');

  if (!await stream(ctx, body, 55)) return { stdout: '', stderr: '', code: 130 };

  const log = [];
  const now = new Date();
  for (const pkg of pending) {
    const from = pkg.version;
    const to = pkg.candidate;
    pkgdb.markUpgraded(pkg.name);
    materialise(pkg);
    log.push(...upgradeLog(pkg, from, to, now));
  }
  logDpkg(log);

  return { stdout: '', stderr: '', code: 0 };
}

/* ------------------------------------------------------------------ *
 * apt list / search / show / policy
 * ------------------------------------------------------------------ */

function listVersionSuffix(pkg) {
  if (!pkg.installed) return '';
  return pkg.auto ? ' [installed,automatic]' : ' [installed]';
}

function aptList(ctx, argv) {
  const installedOnly = argv.includes('--installed');
  const upgradableOnly = argv.includes('--upgradable') || argv.includes('--upgradeable');
  const allVersions = argv.includes('--all-versions');
  const patterns = argv.filter((a) => !a.startsWith('-'));

  let list = pkgdb.all();
  if (installedOnly) list = list.filter((p) => p.installed);
  if (upgradableOnly) list = list.filter((p) => p.installed && p.candidate !== p.version);
  if (patterns.length > 0) {
    const res = patterns.map((p) => new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`, 'i'));
    list = list.filter((p) => res.some((r) => r.test(p.name)));
  }

  const lines = ['Listing... Done'];
  for (const pkg of list) {
    const upgradable = pkg.installed && pkg.candidate !== pkg.version;
    if (upgradable) {
      lines.push(`${pkg.name}/${SUITE}-updates ${pkg.candidate} ${pkg.arch} [upgradable from: ${pkg.version}]`);
      if (allVersions) lines.push(`${pkg.name}/${SUITE},now ${pkg.version} ${pkg.arch} [installed]`);
      continue;
    }
    const origin = pkg.installed ? `${SUITE},now` : SUITE;
    lines.push(`${pkg.name}/${origin} ${pkg.version} ${pkg.arch}${listVersionSuffix(pkg)}`);
  }
  return ok(`${lines.join('\n')}\n`);
}

/** Escape a literal for use inside a RegExp. */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aptSearch(ctx, argv) {
  const terms = argv.filter((a) => !a.startsWith('-'));
  if (terms.length === 0) return fail('E: You must give at least one search pattern\n', 100);

  const results = pkgdb.search(terms[0]).filter((p) => terms.every(
    (t) => p.name.toLowerCase().includes(t.toLowerCase()) || p.description.toLowerCase().includes(t.toLowerCase()),
  ));

  const lines = ['Sorting... Done', 'Full Text Search... Done'];
  for (const pkg of results) {
    const suffix = pkg.installed ? `,now ${pkg.version} ${pkg.arch} [installed]` : ` ${pkg.version} ${pkg.arch}`;
    lines.push(`${pkg.name}/${SUITE}${suffix}`);
    lines.push(`  ${pkg.description}`);
    lines.push('');
  }
  return ok(`${lines.join('\n')}\n`);
}

function showBlock(pkg, full) {
  const lines = [
    `Package: ${pkg.name}`,
    `Version: ${pkg.version}`,
    `Priority: ${pkg.priority}`,
    `Section: ${component(pkg) === 'main' ? pkg.section : `universe/${pkg.section}`}`,
    'Origin: Ubuntu',
    `Maintainer: ${MAINTAINER}`,
    'Bugs: https://bugs.launchpad.net/ubuntu/+filebug',
    `Installed-Size: ${aptSize(pkg.installedKb)}`,
  ];
  if (pkg.depends.length > 0) lines.push(`Depends: ${pkg.depends.join(', ')}`);
  lines.push(`Download-Size: ${aptSize(pkg.download)}`);
  if (pkg.installed) lines.push(`APT-Manual-Installed: ${pkg.auto ? 'no' : 'yes'}`);
  lines.push(`APT-Sources: ${ARCHIVE} ${SUITE}/${component(pkg)} amd64 Packages`);
  lines.push(`Description: ${pkg.description}`);
  if (full) {
    lines.push(` ${pkg.name} is part of the Ubuntu 24.04 LTS (Noble Numbat) archive.`);
    lines.push(' .');
    lines.push(` This package provides ${pkg.binaries.length > 0 ? pkg.binaries.join(', ') : 'shared data and libraries'}.`);
  }
  lines.push('');
  return lines;
}

function aptShow(ctx, argv, full) {
  const names = argv.filter((a) => !a.startsWith('-'));
  if (names.length === 0) return fail('E: No packages found\n', 100);

  const lines = [];
  const missing = [];
  for (const name of names) {
    const pkg = pkgdb.get(name);
    if (!pkg) { missing.push(name); continue; }
    lines.push(...showBlock(pkg, full));
  }
  if (lines.length === 0) {
    return fail(`E: No packages found\n`, 100);
  }
  const warn = missing.map((n) => `N: Unable to locate package ${n}`).join('\n');
  return {
    stdout: `${lines.join('\n')}`,
    stderr: warn === '' ? '' : `${warn}\n`,
    code: 0,
  };
}

function aptPolicy(ctx, argv) {
  const names = argv.filter((a) => !a.startsWith('-'));

  if (names.length === 0) {
    return ok([
      'Package files:',
      ' 100 /var/lib/dpkg/status',
      '     release a=now',
      ` 500 ${SECURITY} ${SUITE}-security/universe amd64 Packages`,
      `     release v=24.04,o=Ubuntu,a=${SUITE}-security,n=${SUITE},l=Ubuntu,c=universe,b=amd64`,
      `     origin security.ubuntu.com`,
      ` 500 ${SECURITY} ${SUITE}-security/main amd64 Packages`,
      `     release v=24.04,o=Ubuntu,a=${SUITE}-security,n=${SUITE},l=Ubuntu,c=main,b=amd64`,
      `     origin security.ubuntu.com`,
      ` 100 ${ARCHIVE} ${SUITE}-backports/main amd64 Packages`,
      `     release v=24.04,o=Ubuntu,a=${SUITE}-backports,n=${SUITE},l=Ubuntu,c=main,b=amd64`,
      `     origin archive.ubuntu.com`,
      ` 500 ${ARCHIVE} ${SUITE}-updates/universe amd64 Packages`,
      `     release v=24.04,o=Ubuntu,a=${SUITE}-updates,n=${SUITE},l=Ubuntu,c=universe,b=amd64`,
      `     origin archive.ubuntu.com`,
      ` 500 ${ARCHIVE} ${SUITE}-updates/main amd64 Packages`,
      `     release v=24.04,o=Ubuntu,a=${SUITE}-updates,n=${SUITE},l=Ubuntu,c=main,b=amd64`,
      `     origin archive.ubuntu.com`,
      ` 500 ${ARCHIVE} ${SUITE}/universe amd64 Packages`,
      `     release v=24.04,o=Ubuntu,a=${SUITE},n=${SUITE},l=Ubuntu,c=universe,b=amd64`,
      `     origin archive.ubuntu.com`,
      ` 500 ${ARCHIVE} ${SUITE}/main amd64 Packages`,
      `     release v=24.04,o=Ubuntu,a=${SUITE},n=${SUITE},l=Ubuntu,c=main,b=amd64`,
      `     origin archive.ubuntu.com`,
      'Pinned packages:',
      '',
    ].join('\n'));
  }

  const lines = [];
  const missing = [];
  for (const name of names) {
    const pkg = pkgdb.get(name);
    if (!pkg) { missing.push(name); continue; }
    lines.push(`${pkg.name}:`);
    lines.push(`  Installed: ${pkg.installed ? pkg.version : '(none)'}`);
    lines.push(`  Candidate: ${pkg.candidate}`);
    lines.push('  Version table:');
    if (pkg.candidate !== pkg.version) {
      lines.push(`     ${pkg.candidate} 500`);
      lines.push(`        500 ${ARCHIVE} ${SUITE}-updates/${component(pkg)} amd64 Packages`);
    }
    lines.push(`${pkg.installed && pkg.candidate === pkg.version ? ' *** ' : '     '}${pkg.version} 500`);
    lines.push(`        500 ${ARCHIVE} ${SUITE}/${component(pkg)} amd64 Packages`);
    if (pkg.installed) lines.push('        100 /var/lib/dpkg/status');
  }
  const warn = missing.map((n) => `N: Unable to locate package ${n}`).join('\n');
  return {
    stdout: lines.length ? `${lines.join('\n')}\n` : '',
    stderr: warn === '' ? '' : `${warn}\n`,
    code: missing.length && lines.length === 0 ? 100 : 0,
  };
}

function aptDepends(ctx, argv, reverse) {
  const names = argv.filter((a) => !a.startsWith('-'));
  if (names.length === 0) return fail('E: No packages found\n', 100);

  const lines = [];
  for (const name of names) {
    const pkg = pkgdb.get(name);
    if (!pkg) {
      lines.push(`N: Unable to locate package ${name}`);
      continue;
    }
    lines.push(pkg.name);
    if (reverse) {
      lines.push('Reverse Depends:');
      for (const other of pkgdb.all()) {
        if (other.depends.includes(pkg.name)) lines.push(`  ${other.name}`);
      }
    } else {
      for (const dep of pkg.depends) lines.push(`  Depends: ${dep}`);
    }
  }
  return ok(`${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ *
 * apt / apt-get front end
 * ------------------------------------------------------------------ */

const APT_HELP = `apt 2.7.14build2 (amd64)
Usage: apt [options] command

apt is a commandline package manager and provides commands for
searching and managing as well as querying information about packages.
It provides the same functionality as the specialized APT tools,
like apt-get and apt-cache, but enables options more suitable for
interactive use by default.

Most used commands:
  list - list packages based on package names
  search - search in package descriptions
  show - show package details
  install - install packages
  reinstall - reinstall packages
  remove - remove packages
  autoremove - automatically remove all unused packages
  update - update list of available packages
  upgrade - upgrade the system by installing/upgrading packages
  full-upgrade - upgrade the system by removing/installing/upgrading packages
  edit-sources - edit the source information file
  satisfy - satisfy dependency strings

See apt(8) for more information about the available commands.
`;

const MAN_APT = `NAME
       apt - command-line interface

SYNOPSIS
       apt [-y] [-s] command [package...]

DESCRIPTION
       apt provides a high-level commandline interface for the package
       management system. It is intended as an end user interface.

       The package database is simulated (see commands/pkg-db.js) and persists
       through localStorage, so an install survives a reload. Installing a
       package really does create its programs under /usr/bin, and removing it
       deletes them again; every transaction is appended to /var/log/dpkg.log.

COMMANDS
       update
              Retrieve new lists of packages. Requires root.

       install pkg...
              Install packages, pulling in their dependencies. Requires root.

       remove pkg... / purge pkg...
              Remove packages. Requires root.

       autoremove
              Remove packages that were automatically installed and are no
              longer needed. Requires root.

       upgrade / full-upgrade / dist-upgrade
              Install the newest versions of all installed packages.

       list [--installed] [--upgradable] [--all-versions]
              List packages.

       search pattern
              Search package names and descriptions.

       show pkg / policy pkg
              Show package details or the version table.

OPTIONS
       -y, --yes, --assume-yes
              Assume yes to all queries.

       -s, --simulate, --dry-run
              No action; perform a simulation.

       -q, --quiet
              Quiet; produces output suitable for logging.

EXIT STATUS
       100 is returned for a usage error, an unknown package, or when the dpkg
       frontend lock cannot be acquired.`;

/**
 * The shared apt / apt-get implementation.
 * @param {object} ctx
 * @param {boolean} isGet true for apt-get, which rejects the query verbs
 */
async function runApt(ctx, isGet) {
  const argv = ctx.argv.slice();
  const opts = { yes: false, simulate: false, purge: false, dist: false };
  const rest = [];
  const passthrough = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-y' || a === '--yes' || a === '--assume-yes' || a === '--force-yes') { opts.yes = true; continue; }
    if (a === '-s' || a === '--simulate' || a === '--dry-run' || a === '--just-print' || a === '--no-act') { opts.simulate = true; continue; }
    if (a === '--purge') { opts.purge = true; continue; }
    if (a === '-h' || a === '--help') return ok(APT_HELP);
    if (a === '-v' || a === '--version') return ok(`apt 2.7.14build2 (amd64)\n`);
    if (a === '-o' || a === '--option' || a === '-t' || a === '--target-release' || a === '-c' || a === '--config-file') { i += 1; continue; }
    /* Anything else long-form belongs to the sub-command (--installed,
       --upgradable, --all-versions …) and is handed through untouched. */
    if (a.startsWith('--')) { passthrough.push(a); continue; }
    if (a.startsWith('-')) continue;
    rest.push(a);
  }

  const verb = (rest.shift() || '').toLowerCase();

  if (verb === '') return ok(APT_HELP);

  const queryVerbs = ['list', 'search', 'show', 'policy', 'depends', 'rdepends'];
  if (isGet && queryVerbs.includes(verb)) {
    return fail(`E: Invalid operation ${verb}\n`, 100);
  }

  switch (verb) {
    case 'update':
      return aptUpdate(ctx);
    case 'install':
    case 'reinstall':
      return aptInstall(ctx, rest, opts);
    case 'remove':
      return aptRemove(ctx, rest, opts);
    case 'purge':
      return aptRemove(ctx, rest, { ...opts, purge: true });
    case 'autoremove':
    case 'auto-remove':
      return aptAutoremove(ctx, opts);
    case 'upgrade':
      return aptUpgrade(ctx, opts);
    case 'full-upgrade':
    case 'dist-upgrade':
      return aptUpgrade(ctx, { ...opts, dist: true });
    case 'list':
      return aptList(ctx, [...passthrough, ...rest]);
    case 'search':
      return aptSearch(ctx, [...passthrough, ...rest]);
    case 'show':
      return aptShow(ctx, [...passthrough, ...rest], true);
    case 'policy':
      return aptPolicy(ctx, [...passthrough, ...rest]);
    case 'depends':
      return aptDepends(ctx, [...passthrough, ...rest], false);
    case 'rdepends':
      return aptDepends(ctx, [...passthrough, ...rest], true);
    case 'clean':
    case 'autoclean': {
      const denied = needRoot(ctx);
      if (denied) return denied;
      return ok('');
    }
    case 'moo':
      return ok(`                 (__)\n                 (oo)\n           /------\\/\n          / |    ||\n         *  /\\---/\\\n            ~~   ~~\n..."Have you mooed today?"...\n`);
    case 'help':
      return ok(APT_HELP);
    default:
      return fail(`E: Invalid operation ${verb}\n`, 100);
  }
}

const aptCommand = {
  name: 'apt',
  aliases: [],
  synopsis: 'apt [-y] [-s] COMMAND [PACKAGE...]',
  description: 'Command-line interface to the package manager',
  man: MAN_APT,
  async run(ctx) { return runApt(ctx, false); },
};

const aptGetCommand = {
  name: 'apt-get',
  aliases: [],
  synopsis: 'apt-get [-y] [-s] COMMAND [PACKAGE...]',
  description: 'APT package handling utility -- command-line interface',
  man: MAN_APT.split('apt - command-line interface').join('apt-get - APT package handling utility'),
  async run(ctx) { return runApt(ctx, true); },
};

/* ------------------------------------------------------------------ *
 * apt-cache
 * ------------------------------------------------------------------ */

const aptCacheCommand = {
  name: 'apt-cache',
  aliases: [],
  synopsis: 'apt-cache { search | show | showpkg | policy | depends | stats } ...',
  description: 'Query the APT cache',
  man: `NAME
       apt-cache - query the APT cache

SYNOPSIS
       apt-cache [options] command
       apt-cache [options] show pkg [pkg ...]

DESCRIPTION
       apt-cache performs a variety of operations on APT's package cache. It
       does not manipulate the state of the system.

COMMANDS
       search regex
              Search the package names and descriptions.

       show pkg
              Display the package record.

       showpkg pkg
              Display information about the package's versions and reverse
              dependencies.

       policy [pkg]
              Show the priority table, or the version table for a package.

       depends pkg / rdepends pkg
              Show the (reverse) dependencies of a package.

       pkgnames [prefix]
              Print the name of every package in the cache.

       stats  Display cache statistics.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    const verb = (argv.shift() || '').toLowerCase();

    switch (verb) {
      case 'search': {
        const terms = argv.filter((a) => !a.startsWith('-'));
        if (terms.length === 0) return fail('E: You must give at least one search pattern\n', 100);
        const namesOnly = argv.includes('-n') || argv.includes('--names-only');
        const q = terms[0].toLowerCase();
        const results = pkgdb.all().filter((p) => (namesOnly
          ? p.name.toLowerCase().includes(q)
          : p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
        return ok(`${results.map((p) => `${p.name} - ${p.description}`).join('\n')}\n`);
      }
      case 'show':
        return aptShow(ctx, argv, false);
      case 'showpkg': {
        const lines = [];
        for (const name of argv.filter((a) => !a.startsWith('-'))) {
          const pkg = pkgdb.get(name);
          if (!pkg) { lines.push(`N: Unable to locate package ${name}`); continue; }
          lines.push(`Package: ${pkg.name}`);
          lines.push('Versions: ');
          lines.push(`${pkg.version} (/var/lib/apt/lists/${SUITE}_${component(pkg)}_binary-amd64_Packages)`);
          lines.push('');
          lines.push('Reverse Depends: ');
          for (const other of pkgdb.all()) {
            if (other.depends.includes(pkg.name)) lines.push(`  ${other.name},${pkg.name}`);
          }
          lines.push('Dependencies: ');
          lines.push(`${pkg.version} - ${pkg.depends.map((d) => `${d} `).join('')}`);
          lines.push('Provides: ');
          lines.push(`${pkg.version} - `);
          lines.push('Reverse Provides: ');
        }
        return ok(`${lines.join('\n')}\n`);
      }
      case 'policy':
        return aptPolicy(ctx, argv);
      case 'depends':
        return aptDepends(ctx, argv, false);
      case 'rdepends':
        return aptDepends(ctx, argv, true);
      case 'pkgnames': {
        const prefix = argv.find((a) => !a.startsWith('-')) || '';
        return ok(`${pkgdb.all().filter((p) => p.name.startsWith(prefix)).map((p) => p.name).join('\n')}\n`);
      }
      case 'stats': {
        const all = pkgdb.all();
        const installed = all.filter((p) => p.installed).length;
        return ok([
          `Total package names: ${group(all.length)} (${aptSize(all.length * 0.03)})`,
          `Total package structures: ${group(all.length)} (${aptSize(all.length * 0.07)})`,
          `  Normal packages: ${group(all.length - installed)}`,
          '  Pure virtual packages: 0',
          '  Single virtual packages: 0',
          '  Mixed virtual packages: 0',
          '  Missing: 0',
          `Total distinct versions: ${group(all.length + pkgdb.upgradable().length)} (${aptSize(all.length * 0.06)})`,
          'Total distinct descriptions: ' + group(all.length),
          `Total dependencies: ${group(all.reduce((n, p) => n + p.depends.length, 0))}`,
          '',
        ].join('\n'));
      }
      case '':
      case 'help':
        return ok('apt-cache 2.7.14build2 (amd64)\nUsage: apt-cache [options] command\n');
      default:
        return fail(`E: Invalid operation ${verb}\n`, 100);
    }
  },
};

/* ------------------------------------------------------------------ *
 * dpkg
 * ------------------------------------------------------------------ */

/** The file list dpkg -L reports for a package. */
function packageFiles(pkg) {
  const files = ['/.', '/usr'];
  if (pkg.binaries.length > 0) {
    files.push('/usr/bin');
    for (const bin of pkg.binaries) files.push(`/usr/bin/${bin}`);
  } else {
    files.push('/usr/lib', '/usr/lib/x86_64-linux-gnu', `/usr/lib/x86_64-linux-gnu/${pkg.name}.so.1`);
  }
  files.push('/usr/share', '/usr/share/doc', `/usr/share/doc/${pkg.name}`);
  files.push(`/usr/share/doc/${pkg.name}/changelog.Debian.gz`);
  files.push(`/usr/share/doc/${pkg.name}/copyright`);
  if (pkg.binaries.length > 0) {
    files.push('/usr/share/man', '/usr/share/man/man1');
    for (const bin of pkg.binaries) files.push(`/usr/share/man/man1/${bin}.1.gz`);
  }
  return files;
}

/** dpkg -l's dynamically-sized table. */
function dpkgTable(list) {
  const nameW = Math.max(4, ...list.map((p) => p.name.length));
  const verW = Math.max(7, ...list.map((p) => p.version.length));
  const archW = Math.max(12, ...list.map((p) => p.arch.length));
  const descW = Math.max(11, ...list.map((p) => p.description.length));

  const lines = [
    'Desired=Unknown/Install/Remove/Purge/Hold',
    '| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend',
    '|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)',
    `||/ ${'Name'.padEnd(nameW)} ${'Version'.padEnd(verW)} ${'Architecture'.padEnd(archW)} Description`,
    `+++-${'='.repeat(nameW)}-${'='.repeat(verW)}-${'='.repeat(archW)}-${'='.repeat(descW)}`,
  ];
  for (const pkg of list) {
    lines.push(`ii  ${pkg.name.padEnd(nameW)} ${pkg.version.padEnd(verW)} ${pkg.arch.padEnd(archW)} ${pkg.description}`);
  }
  return `${lines.join('\n')}\n`;
}

/** dpkg -s / dpkg-query -s status stanza. */
function dpkgStatus(pkg) {
  const lines = [
    `Package: ${pkg.name}`,
    'Status: install ok installed',
    `Priority: ${pkg.priority}`,
    `Section: ${pkg.section}`,
    `Installed-Size: ${pkg.installedKb}`,
    `Maintainer: ${MAINTAINER}`,
    `Architecture: ${pkg.arch}`,
    `Version: ${pkg.version}`,
  ];
  if (pkg.depends.length > 0) lines.push(`Depends: ${pkg.depends.join(', ')}`);
  lines.push(`Description: ${pkg.description}`);
  lines.push(` ${pkg.name} is part of the Ubuntu 24.04 LTS (Noble Numbat) archive.`);
  lines.push('Original-Maintainer: Debian Developers <debian-devel@lists.debian.org>');
  lines.push('');
  return lines.join('\n');
}

const dpkgCommand = {
  name: 'dpkg',
  aliases: ['dpkg-query'],
  synopsis: 'dpkg { -l | -L PKG | -S PATTERN | -s PKG | -i FILE } ...',
  description: 'Package manager for Debian',
  man: `NAME
       dpkg - package manager for Debian

SYNOPSIS
       dpkg [option...] action

DESCRIPTION
       dpkg is a tool to install, build, remove and manage Debian packages.

ACTIONS
       -i, --install package-file
              Install the package. Requires root.

       -r, --remove package
              Remove an installed package. Requires root.

       -l, --list [package-name-pattern...]
              List packages matching the given pattern.

       -L, --listfiles package-name...
              List files installed to your system from package-name.

       -S, --search filename-search-pattern...
              Search for a filename from installed packages.

       -s, --status package-name...
              Report the status of the specified package.

       -p, --print-avail package-name...
              Display details about the package, as found in the available
              packages file.

       --get-selections
              Get a list of package selections.

       -C, --audit
              Perform database sanity and consistency checks.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    if (argv.length === 0) {
      return fail("dpkg: error: need an action option\n\nType dpkg --help for help about installing and deinstalling packages [*];\n", 2);
    }

    const first = argv[0];
    if (first === '--version') {
      return ok("Debian 'dpkg' package management program version 1.22.6 (amd64).\nThis is free software; see the GNU General Public License version 2 or\nlater for copying conditions. There is NO warranty.\n");
    }
    if (first === '--help' || first === '-h') {
      return ok('Usage: dpkg [<option>...] <command>\n\nCommands:\n  -i|--install       <.deb file name>\n  -r|--remove        <package>\n  -l|--list          [<pattern>...]\n  -L|--listfiles     <package>...\n  -S|--search        <pattern>...\n  -s|--status        <package>...\n');
    }

    const action = argv.shift();
    const operands = argv.filter((a) => !a.startsWith('-'));

    /* --- -l / --list ------------------------------------------------ */
    if (action === '-l' || action === '--list') {
      let list = pkgdb.installed();
      if (operands.length > 0) {
        const res = operands.map((p) => new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`, 'i'));
        const matched = list.filter((p) => res.some((r) => r.test(p.name)));
        if (matched.length === 0) {
          return fail(`dpkg-query: no packages found matching ${operands[0]}\n`, 1);
        }
        list = matched;
      }
      return ok(dpkgTable(list));
    }

    /* --- -L / --listfiles ------------------------------------------- */
    if (action === '-L' || action === '--listfiles') {
      if (operands.length === 0) return fail('dpkg-query: error: --listfiles needs at least one package name argument\n', 2);
      const out = [];
      for (const name of operands) {
        const pkg = pkgdb.get(name);
        if (!pkg || !pkg.installed) {
          return fail(
            `dpkg-query: package '${name}' is not installed and no information is available\n`
            + 'Use dpkg --info (= dpkg-deb --info) to examine archive files.\n',
            1,
          );
        }
        out.push(...packageFiles(pkg));
      }
      return ok(`${out.join('\n')}\n`);
    }

    /* --- -S / --search ---------------------------------------------- */
    if (action === '-S' || action === '--search') {
      if (operands.length === 0) return fail('dpkg-query: error: --search needs at least one file name pattern argument\n', 2);
      const hits = [];
      for (const pattern of operands) {
        const re = new RegExp(pattern.includes('*')
          ? `^${pattern.split('*').map(escapeRe).join('.*')}$`
          : escapeRe(pattern));
        for (const pkg of pkgdb.installed()) {
          for (const file of packageFiles(pkg)) {
            if (re.test(file)) hits.push(`${pkg.name}: ${file}`);
          }
        }
      }
      if (hits.length === 0) {
        return fail(`dpkg-query: no path found matching pattern ${operands[0]}\n`, 1);
      }
      return ok(`${Array.from(new Set(hits)).join('\n')}\n`);
    }

    /* --- -s / --status ---------------------------------------------- */
    if (action === '-s' || action === '--status' || action === '-p' || action === '--print-avail') {
      if (operands.length === 0) return fail('dpkg-query: error: --status needs at least one package name argument\n', 2);
      const blocks = [];
      for (const name of operands) {
        const pkg = pkgdb.get(name);
        if (!pkg || (!pkg.installed && action !== '-p' && action !== '--print-avail')) {
          return fail(
            `dpkg-query: package '${name}' is not installed and no information is available\n`
            + 'Use dpkg --info (= dpkg-deb --info) to examine archive files.\n',
            1,
          );
        }
        blocks.push(dpkgStatus(pkg));
      }
      return ok(blocks.join('\n'));
    }

    /* --- --get-selections ------------------------------------------- */
    if (action === '--get-selections') {
      const width = Math.max(...pkgdb.installed().map((p) => `${p.name}:${p.arch}`.length)) + 4;
      return ok(`${pkgdb.installed().map((p) => `${`${p.name}:${p.arch}`.padEnd(width)}install`).join('\n')}\n`);
    }

    /* --- -C / --audit ------------------------------------------------ */
    if (action === '-C' || action === '--audit') return ok('');

    /* --- -i / --install ---------------------------------------------- */
    if (action === '-i' || action === '--install') {
      const denied = isRoot(ctx) ? null : fail(
        "dpkg: error: requested operation requires superuser privilege\n", 2,
      );
      if (denied) return denied;
      if (operands.length === 0) return fail('dpkg: error: --install needs at least one package archive file argument\n', 2);

      const out = [];
      for (const spec of operands) {
        const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec, env.home));
        if (!fs.exists(target)) {
          return fail(`dpkg: error: cannot access archive '${spec}': No such file or directory\n`, 2);
        }
        const base = ctx.path.basename(target);
        const name = base.replace(/\.deb$/i, '').split('_')[0];
        const pkg = pkgdb.get(name);
        if (!pkg) {
          return fail(`dpkg-deb: error: '${spec}' is not a Debian format archive\ndpkg: error processing archive ${spec} (--install):\n dpkg-deb --control subprocess returned error exit status 2\nErrors were encountered while processing:\n ${spec}\n`, 1);
        }
        if (!pkg.installed) out.push(`Selecting previously unselected package ${pkg.name}.`);
        out.push(`(Reading database ... ${databaseCount()} files and directories currently installed.)`);
        out.push(`Preparing to unpack ${base} ...`);
        out.push(`Unpacking ${pkg.name} (${pkg.version}) ${pkg.installed ? `over (${pkg.version}) ` : ''}...`);
        out.push(`Setting up ${pkg.name} (${pkg.version}) ...`);
        pkgdb.markInstalled(pkg.name, { auto: false });
        materialise(pkg);
        logDpkg(installLog(pkg));
      }
      out.push(`Processing triggers for man-db (${MANDB_VERSION}) ...`);
      if (!await stream(ctx, out, 70)) return { stdout: '', stderr: '', code: 130 };
      return { stdout: '', stderr: '', code: 0 };
    }

    /* --- -r / --remove ----------------------------------------------- */
    if (action === '-r' || action === '--remove' || action === '-P' || action === '--purge') {
      if (!isRoot(ctx)) return fail('dpkg: error: requested operation requires superuser privilege\n', 2);
      if (operands.length === 0) return fail('dpkg: error: --remove needs at least one package name argument\n', 2);
      const out = [`(Reading database ... ${databaseCount()} files and directories currently installed.)`];
      for (const name of operands) {
        const pkg = pkgdb.get(name);
        if (!pkg || !pkg.installed) {
          return fail(`dpkg: warning: ignoring request to remove ${name} which isn't installed\n`, 0);
        }
        out.push(`Removing ${pkg.name} (${pkg.version}) ...`);
        dematerialise(pkg);
        logDpkg(removeLog(pkg));
        pkgdb.markRemoved(pkg.name);
      }
      out.push(`Processing triggers for man-db (${MANDB_VERSION}) ...`);
      if (!await stream(ctx, out, 70)) return { stdout: '', stderr: '', code: 130 };
      return { stdout: '', stderr: '', code: 0 };
    }

    return fail(`dpkg: error: unknown option '${action}'\n\nType dpkg --help for help about installing and deinstalling packages [*];\n`, 2);
  },
};

/* ------------------------------------------------------------------ *
 * snap
 * ------------------------------------------------------------------ */

/** Format a snap size the way `snap find` does. */
function snapSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}kB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

/** Build a snap-style column table. */
function snapTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells
    .map((c, i) => (i === cells.length - 1 ? String(c) : String(c).padEnd(widths[i])))
    .join('  ')
    .replace(/\s+$/, '');
  return [line(headers), ...rows.map(line)].join('\n');
}

const snapCommand = {
  name: 'snap',
  aliases: [],
  synopsis: 'snap { list | install | remove | find | info | version } ...',
  description: 'Tool to interact with snaps',
  man: `NAME
       snap - tool to interact with snaps

SYNOPSIS
       snap <command> [<options>...]

DESCRIPTION
       The snap command lets you install, configure, refresh and remove snaps.
       Snaps are packages that work across many different Linux distributions,
       enabling secure delivery and operation of the latest apps and utilities.

COMMANDS
       list [snap...]
              List installed snaps.

       install <snap>
              Install a snap from the store. Requires root; classic snaps also
              require --classic.

       remove <snap>
              Remove a snap. Requires root.

       find [query]
              Find packages to install.

       info <snap>
              Show detailed information about a snap.

       version
              Show version details.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    const verb = (argv.shift() || '').toLowerCase();
    const classic = argv.includes('--classic');
    const operands = argv.filter((a) => !a.startsWith('-'));

    switch (verb) {
      case '':
      case 'help':
      case '--help':
        return ok('Usage: snap <command> [<options>...]\n\nCommonly used commands can be classified as follows:\n\n         Basics: find, info, install, remove, list\n        ...more: refresh, revert, switch, disable, enable, create-cohort\n\nFor more information about a command, run "snap help <command>".\n');

      case 'version':
        return ok([
          'snap    2.63+24.04',
          'snapd   2.63+24.04',
          'series  16',
          'ubuntu  24.04',
          'kernel  6.8.0-45-generic',
          '',
        ].join('\n'));

      case 'list': {
        let list = pkgdb.snapList();
        if (operands.length > 0) {
          list = list.filter((s) => operands.includes(s.name));
          if (list.length === 0) {
            return fail(`error: no matching snaps installed\n`, 1);
          }
        }
        if (list.length === 0) {
          return fail('No snaps are installed yet. Try \'snap install hello-world\'.\n', 1);
        }
        const rows = list
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => [s.name, s.version, s.rev, s.tracking, s.publisher, s.notes]);
        return ok(`${snapTable(['Name', 'Version', 'Rev', 'Tracking', 'Publisher', 'Notes'], rows)}\n`);
      }

      case 'find':
      case 'search': {
        const results = pkgdb.snapSearch(operands[0] || '');
        if (results.length === 0) {
          return fail(`error: no matching snaps for "${operands[0] || ''}"\n`, 1);
        }
        const rows = results.map((s) => [s.name, s.version, s.publisher, s.notes, s.summary]);
        return ok(`${snapTable(['Name', 'Version', 'Publisher', 'Notes', 'Summary'], rows)}\n`);
      }

      case 'info': {
        if (operands.length === 0) return fail('error: the required argument `<snap>` was not provided\n', 1);
        const name = operands[0];
        const installed = pkgdb.snapList().find((s) => s.name === name);
        const store = pkgdb.snapLookup(name);
        if (!installed && !store) {
          return fail(`error: no snap found for "${name}"\n`, 1);
        }
        const entry = store || installed;
        const lines = [
          `name:      ${entry.name}`,
          `summary:   ${store ? store.summary : entry.name}`,
          `publisher: ${entry.publisher}`,
          `store-url: https://snapcraft.io/${entry.name}`,
          'license:   unset',
          'description: |',
          `  ${store ? store.summary : `The ${entry.name} snap.`}`,
          `snap-id:   ${entry.name.padEnd(12, 'x')}QnKvbCLtLKQm1yAd`,
        ];
        if (installed) {
          lines.push('commands:');
          lines.push(`  - ${entry.name}`);
          lines.push(`refresh-date: today at ${pad0(new Date().getHours())}:${pad0(new Date().getMinutes())} UTC`);
        }
        lines.push('channels:');
        lines.push(`  latest/stable:    ${entry.version} 2024-08-15 (${installed ? installed.rev : '162'}) ${snapSize(entry.size)} ${entry.notes === 'classic' ? 'classic' : '-'}`);
        lines.push('  latest/candidate: ↑                    ');
        lines.push('  latest/beta:      ↑                    ');
        lines.push('  latest/edge:      ↑                    ');
        if (installed) {
          lines.push(`installed:          ${installed.version}            (${installed.rev}) ${snapSize(installed.size)} ${installed.notes === 'classic' ? 'classic' : '-'}`);
        }
        lines.push('');
        return ok(lines.join('\n'));
      }

      case 'install': {
        if (!isRoot(ctx)) return fail('error: access denied (try with sudo)\n', 1);
        if (operands.length === 0) return fail('error: the required argument `<snap>` was not provided\n', 1);
        const out = [];
        for (const name of operands) {
          const store = pkgdb.snapLookup(name);
          if (!store) {
            return fail(
              `error: snap "${name}" not found\n`
              + `\nPlease be mindful pre-release channels may include features not\n`
              + 'completely tested or implemented. Get more information with \'snap info\n'
              + `${name}\'.\n`,
              1,
            );
          }
          if (store.notes === 'classic' && !classic) {
            return fail(
              `error: This revision of snap "${name}" was published using classic confinement and thus may perform\n`
              + '       arbitrary system changes outside of the security sandbox that snaps are usually confined to,\n'
              + '       which may put your system at risk.\n\n'
              + '       If you understand and want to proceed repeat the command including --classic.\n',
              1,
            );
          }
          if (pkgdb.snapList().some((s) => s.name === store.name)) {
            out.push(`snap "${store.name}" is already installed, see 'snap help refresh'`);
            continue;
          }
          out.push(`Download snap "${store.name}" (${store.version}) from channel "stable"`);
          const record = pkgdb.snapInstall(store.name);
          out.push(`${store.name} ${record ? record.version : store.version} from ${store.publisher} installed`);
        }
        if (!await stream(ctx, out, 220)) return { stdout: '', stderr: '', code: 130 };
        return { stdout: '', stderr: '', code: 0 };
      }

      case 'remove': {
        if (!isRoot(ctx)) return fail('error: access denied (try with sudo)\n', 1);
        if (operands.length === 0) return fail('error: the required argument `<snap>` was not provided\n', 1);
        const out = [];
        for (const name of operands) {
          if (!pkgdb.snapRemove(name)) {
            return fail(`error: snap "${name}" is not installed\n`, 1);
          }
          out.push(`${name} removed`);
        }
        if (!await stream(ctx, out, 220)) return { stdout: '', stderr: '', code: 130 };
        return { stdout: '', stderr: '', code: 0 };
      }

      case 'refresh': {
        if (!isRoot(ctx)) return fail('error: access denied (try with sudo)\n', 1);
        return ok('All snaps up to date.\n');
      }

      case 'changes':
        return ok('ID   Status  Spawn  Ready  Summary\n');

      default:
        return fail(`error: unknown command "${verb}", see 'snap help'.\n`, 1);
    }
  },
};

/* ------------------------------------------------------------------ *
 * add-apt-repository
 * ------------------------------------------------------------------ */

const addAptRepositoryCommand = {
  name: 'add-apt-repository',
  aliases: ['apt-add-repository'],
  synopsis: 'add-apt-repository [-y] [-r] ppa:USER/PPA | REPO-LINE',
  description: 'Add or remove an APT repository',
  man: `NAME
       add-apt-repository - Adds a repository into the /etc/apt/sources.list.d
       directory

SYNOPSIS
       add-apt-repository <sourceline>

DESCRIPTION
       add-apt-repository is a script which adds an external APT repository to
       either /etc/apt/sources.list or a file in /etc/apt/sources.list.d/.

OPTIONS
       -r, --remove
              Remove the specified repository.

       -y, --yes
              Assume yes to all queries.

       -n, --no-update
              Do not update the package cache after adding the repository.`,
  async run(ctx) {
    const denied = needRoot(ctx);
    if (denied) {
      return fail('ERROR: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n', 1);
    }

    const argv = ctx.argv.slice();
    const yes = argv.includes('-y') || argv.includes('--yes');
    const remove = argv.includes('-r') || argv.includes('--remove');
    const noUpdate = argv.includes('-n') || argv.includes('--no-update');
    const spec = argv.find((a) => !a.startsWith('-'));

    if (!spec) {
      return fail('usage: add-apt-repository <sourceline>\n\nadd-apt-repository: error: the following arguments are required: sourceline\n', 2);
    }

    const ppa = /^ppa:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(spec);
    if (!ppa) {
      return fail(`ERROR: '${spec}' invalid\n`, 1);
    }
    const [, owner, name] = ppa;
    const listFile = `/etc/apt/sources.list.d/${owner}-ubuntu-${name}-${SUITE}.sources`;

    if (remove) {
      try {
        if (fs.exists(listFile)) fs.unlink(listFile);
      } catch {
        /* nothing to remove */
      }
      return ok(`Removing repository.\nRemoved ${listFile}\n`);
    }

    const out = [
      `Repository: 'Types: deb`,
      `URIs: https://ppa.launchpadcontent.net/${owner}/${name}/ubuntu/`,
      `Suites: ${SUITE}`,
      `Components: main`,
      `'`,
      'Description:',
      `PPA published by ~${owner}.`,
      `More info: https://launchpad.net/~${owner}/+archive/ubuntu/${name}`,
      'Adding repository.',
    ];
    if (!await stream(ctx, out, 60)) return { stdout: '', stderr: '', code: 130 };

    if (!yes) {
      const answer = await ctx.term.ask('Press [ENTER] to continue or Ctrl-c to cancel.');
      if (answer === null || aborted(ctx.signal)) return { stdout: '', stderr: '', code: 130 };
    }

    try {
      fs.writeFile(listFile,
        'Types: deb\n'
        + `URIs: https://ppa.launchpadcontent.net/${owner}/${name}/ubuntu/\n`
        + `Suites: ${SUITE}\n`
        + 'Components: main\n'
        + `Signed-By: /etc/apt/keyrings/${owner}-ubuntu-${name}.gpg\n`);
    } catch (err) {
      return fail(`ERROR: could not write ${listFile}\n`, 1);
    }

    const tail = [
      `Adding deb entry to ${listFile}`,
      `Adding disabled deb-src entry to ${listFile}`,
      'Found existing deb entry in /etc/apt/sources.list.d/',
    ];
    if (!await stream(ctx, tail, 60)) return { stdout: '', stderr: '', code: 130 };

    if (!noUpdate) return aptUpdate(ctx);
    return { stdout: '', stderr: '', code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * do-release-upgrade
 * ------------------------------------------------------------------ */

const doReleaseUpgradeCommand = {
  name: 'do-release-upgrade',
  aliases: [],
  synopsis: 'do-release-upgrade [-c] [-d] [-p]',
  description: 'Upgrade the operating system to the latest release',
  man: `NAME
       do-release-upgrade - Ubuntu Release Upgrader

SYNOPSIS
       do-release-upgrade [options]

DESCRIPTION
       do-release-upgrade is the Ubuntu release upgrader. The upgrade policy is
       read from /etc/update-manager/release-upgrades; on this LTS image it is
       set to Prompt=lts, so nothing is offered until the next LTS point
       release.

OPTIONS
       -c, --check-dist-upgrade-only
              Check only if a new distribution release is available and report
              the result via the exit code.

       -d, --devel-release
              Check if upgrading to the latest devel release is possible.

       -p, --proposed
              Try upgrading to the latest release using the upgrader from
              $distro-proposed.`,
  async run(ctx) {
    const argv = ctx.argv;
    const devel = argv.includes('-d') || argv.includes('--devel-release');
    const checkOnly = argv.includes('-c') || argv.includes('--check-dist-upgrade-only');

    const lines = ['Checking for a new Ubuntu release'];
    if (!await stream(ctx, lines, 400)) return { stdout: '', stderr: '', code: 130 };

    if (devel) {
      const tail = [
        'There is no development version of an LTS available.',
        'To upgrade to the latest non-LTS development release',
        'set Prompt=normal in /etc/update-manager/release-upgrades.',
      ];
      if (!await stream(ctx, tail, 120)) return { stdout: '', stderr: '', code: 130 };
      return { stdout: '', stderr: '', code: 1 };
    }

    const tail = checkOnly
      ? ['No new release found.']
      : [
        'Please install all available updates for your release before upgrading.',
        '',
        'There is no development version of an LTS available.',
        'To upgrade to the latest non-LTS development release',
        'set Prompt=normal in /etc/update-manager/release-upgrades.',
      ];
    if (!await stream(ctx, tail, 120)) return { stdout: '', stderr: '', code: 130 };
    return { stdout: '', stderr: '', code: 1 };
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const pkgCommands = [
  aptCommand,
  aptGetCommand,
  aptCacheCommand,
  dpkgCommand,
  snapCommand,
  addAptRepositoryCommand,
  doReleaseUpgradeCommand,
];

export default pkgCommands;
