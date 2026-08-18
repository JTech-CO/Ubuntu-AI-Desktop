/**
 * js/core/fs-tree.js — pristine Ubuntu 24.04.1 LTS filesystem, plus the
 * generators behind the live `/proc` files.
 *
 * Sibling of js/core/fs.js — see ARCHITECTURE §6.
 */

import { users } from './users.js';
import { procs, CORES } from './procs.js';
import { device } from './device.js';
import * as D from './fs-data.js';
import * as P from './fs-projects.js';
import { HELP_TXT } from './fs-help.js';
import { PICTURES } from './fs-pictures.js';

const DAY = 86400000;

/* ------------------------------------------------------------------ *
 * node constructors
 * ------------------------------------------------------------------ */

/**
 * @param {string} name
 * @param {{mode?:number, owner?:string, group?:string, mtime?:number}} [opts]
 */
export function dirNode(name, opts = {}) {
  return {
    type: 'dir',
    name,
    mode: opts.mode === undefined ? 0o755 : opts.mode,
    owner: opts.owner || 'root',
    group: opts.group || 'root',
    mtime: opts.mtime === undefined ? Date.now() : opts.mtime,
    children: Object.create(null),
  };
}

/**
 * @param {string} name
 * @param {string} content
 * @param {{mode?:number, owner?:string, group?:string, mtime?:number, size?:number}} [opts]
 */
export function fileNode(name, content, opts = {}) {
  const node = {
    type: 'file',
    name,
    mode: opts.mode === undefined ? 0o644 : opts.mode,
    owner: opts.owner || 'root',
    group: opts.group || 'root',
    mtime: opts.mtime === undefined ? Date.now() : opts.mtime,
    content: content === undefined || content === null ? '' : String(content),
  };
  // Sparse/oversized files (installer images, /proc) report a size that is not
  // derived from their stored content.
  if (typeof opts.size === 'number') node.size = opts.size;
  return node;
}

/**
 * @param {string} name
 * @param {string} target
 * @param {{mtime?:number, owner?:string, group?:string}} [opts]
 */
export function linkNode(name, target, opts = {}) {
  return {
    type: 'link',
    name,
    mode: 0o777,
    owner: opts.owner || 'root',
    group: opts.group || 'root',
    mtime: opts.mtime === undefined ? Date.now() : opts.mtime,
    target: String(target),
  };
}

/* ------------------------------------------------------------------ *
 * /proc generators — registered by fs.js, called on every read
 * ------------------------------------------------------------------ */

function meminfoRow(label, kb) {
  return `${`${label}:`.padEnd(15)} ${String(Math.max(0, Math.round(kb))).padStart(8)} kB`;
}

/**
 * `/proc/meminfo`, sized from the host's real RAM.
 *
 * `MemTotal` is `device.memTotalMib()` — `navigator.deviceMemory`, which the
 * spec buckets and caps at 8 GiB, so it is a lower bound rather than a
 * measurement (`device.memoryLabel()` is what says so to the user).
 * `procs.totals()` floors the same figure to a size the simulated process
 * table fits inside, so taking the larger of the two keeps this file, `free`
 * and `top` reporting one identical total.
 *
 * Every other row is derived from that total and from the live process table,
 * so the columns always add up: MemFree + used + Buffers + Cached +
 * SReclaimable == MemTotal by construction.
 *
 * @returns {string}
 */
export function meminfo() {
  const t = procs.totals();
  const total = Math.max(Math.round(device.memTotalMib()), t.memTotalMb) * 1024;
  const used = Math.min(total, Math.max(0, Math.round(t.memUsedMb * 1024)));
  const slack = total - used;

  // Page cache, buffers and reclaimable slab take a share of whatever the
  // processes left behind, capped at the proportions a settled Ubuntu desktop
  // shows. The three fractions sum to well under 1, so MemFree stays positive
  // even when the process table has eaten almost everything.
  const jitter = () => 0.96 + Math.random() * 0.08;
  const buffers = Math.round(Math.min(total * 0.0165, slack * 0.05) * jitter());
  const cached = Math.round(Math.min(total * 0.228, slack * 0.55) * jitter());
  const rest = Math.max(0, slack - buffers - cached);
  const sReclaimable = Math.round(Math.min(total * 0.0176, rest * 0.5) * jitter());
  const sUnreclaim = Math.round(sReclaimable * 0.818);
  const slab = sReclaimable + sUnreclaim;
  const free = Math.max(0, total - used - buffers - cached - sReclaimable);
  const available = Math.min(total, free + Math.round((cached + sReclaimable) * 0.86) + buffers);
  const swapTotal = t.swapTotalMb * 1024;
  const swapFree = Math.max(0, swapTotal - Math.round(t.swapUsedMb * 1024));
  const shmem = Math.round(total * 0.0255);

  // The direct map covers physical RAM, so it has to track the real total too.
  const directMap4k = 512_000;
  const directMap1G = Math.max(0, Math.floor((total - 2 * 1024 * 1024) / (1024 * 1024)) * 1024 * 1024);
  const directMap2M = Math.max(0, total - directMap4k - directMap1G);

  return `${[
    meminfoRow('MemTotal', total),
    meminfoRow('MemFree', free),
    meminfoRow('MemAvailable', available),
    meminfoRow('Buffers', buffers),
    meminfoRow('Cached', cached),
    meminfoRow('SwapCached', 0),
    meminfoRow('Active', Math.round(used * 0.61)),
    meminfoRow('Inactive', Math.round(used * 0.32) + cached),
    meminfoRow('Active(anon)', Math.round(used * 0.48)),
    meminfoRow('Inactive(anon)', shmem),
    meminfoRow('Active(file)', Math.round(used * 0.13)),
    meminfoRow('Inactive(file)', Math.round(used * 0.32)),
    meminfoRow('Unevictable', 5_120),
    meminfoRow('Mlocked', 5_120),
    meminfoRow('SwapTotal', swapTotal),
    meminfoRow('SwapFree', swapFree),
    meminfoRow('Zswap', 0),
    meminfoRow('Zswapped', 0),
    meminfoRow('Dirty', 512 + Math.round(Math.random() * 800)),
    meminfoRow('Writeback', 0),
    meminfoRow('AnonPages', Math.round(used * 0.52)),
    meminfoRow('Mapped', Math.round(used * 0.21)),
    meminfoRow('Shmem', shmem),
    meminfoRow('KReclaimable', sReclaimable),
    meminfoRow('Slab', slab),
    meminfoRow('SReclaimable', sReclaimable),
    meminfoRow('SUnreclaim', sUnreclaim),
    meminfoRow('KernelStack', 14_768),
    meminfoRow('PageTables', Math.round(used * 0.0166)),
    meminfoRow('NFS_Unstable', 0),
    meminfoRow('Bounce', 0),
    meminfoRow('WritebackTmp', 0),
    meminfoRow('CommitLimit', Math.round(total / 2) + swapTotal),
    meminfoRow('Committed_AS', Math.round(used * 2.4)),
    meminfoRow('VmallocTotal', 34_359_738_367),
    meminfoRow('VmallocUsed', 61_236),
    meminfoRow('VmallocChunk', 0),
    meminfoRow('Percpu', 6_016),
    meminfoRow('HugePages_Total', 0).replace(' kB', ''),
    meminfoRow('HugePages_Free', 0).replace(' kB', ''),
    meminfoRow('HugePages_Rsvd', 0).replace(' kB', ''),
    meminfoRow('HugePages_Surp', 0).replace(' kB', ''),
    meminfoRow('Hugepagesize', 2_048),
    meminfoRow('Hugetlb', 0),
    meminfoRow('DirectMap4k', directMap4k),
    meminfoRow('DirectMap2M', directMap2M),
    meminfoRow('DirectMap1G', directMap1G),
  ].join('\n')}\n`;
}

/** @returns {string} /proc/uptime */
export function uptimeFile() {
  const up = procs.uptime();
  const busy = Math.min(0.35, procs.totals().cpu / 100);
  const idle = up * CORES * (1 - busy);
  return `${up.toFixed(2)} ${idle.toFixed(2)}\n`;
}

/** @returns {string} /proc/loadavg */
export function loadavgFile() {
  const t = procs.totals();
  const running = Math.max(1, Math.round(t.load[0]));
  const lastPid = 2500 + Math.round(procs.uptime() * 1.7);
  return `${t.load[0].toFixed(2)} ${t.load[1].toFixed(2)} ${t.load[2].toFixed(2)} ${running}/${t.threadCount} ${lastPid}\n`;
}

/** @returns {string} /proc/cpuinfo for the host's real CPU count and architecture */
export function cpuinfoFile() {
  return D.cpuinfo(CORES, device.arch());
}

/**
 * Paths whose contents are produced on demand rather than stored.
 * @type {Record<string, () => string>}
 */
export const PROC_GENERATORS = {
  '/proc/uptime': uptimeFile,
  '/proc/loadavg': loadavgFile,
  '/proc/meminfo': meminfo,
  '/proc/cpuinfo': cpuinfoFile,
};

/* ------------------------------------------------------------------ *
 * default tree
 * ------------------------------------------------------------------ */

function ensureDir(root, path, opts) {
  const parts = path.split('/').filter(Boolean);
  let node = root;
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    let child = node.children[name];
    if (!child || child.type !== 'dir') {
      const isLeaf = i === parts.length - 1;
      child = dirNode(name, isLeaf ? opts : { mtime: opts && opts.mtime });
      node.children[name] = child;
    }
    node = child;
  }
  return node;
}

function placeFile(root, path, content, opts) {
  const idx = path.lastIndexOf('/');
  const parent = ensureDir(root, path.slice(0, idx), { mtime: opts && opts.mtime });
  const name = path.slice(idx + 1);
  parent.children[name] = fileNode(name, content, opts);
  return parent.children[name];
}

function placeLink(root, path, target, opts) {
  const idx = path.lastIndexOf('/');
  const parent = ensureDir(root, path.slice(0, idx), { mtime: opts && opts.mtime });
  const name = path.slice(idx + 1);
  parent.children[name] = linkNode(name, target, opts);
  return parent.children[name];
}

/**
 * Build the pristine Ubuntu 24.04.1 LTS tree.
 * @param {number} [now] epoch ms treated as "the present"
 * @returns {object} the root directory node
 */
export function buildDefaultTree(now = Date.now()) {
  const boot = procs.bootTime;
  const installed = now - 97 * DAY; // installed just over three months ago
  const upgraded = now - 4 * DAY;
  const root = dirNode('', { mtime: installed });

  const U = { owner: 'ubuntu', group: 'ubuntu' };
  const D_ = (p, opts) => ensureDir(root, p, { mtime: installed, ...opts });
  const F_ = (p, c, opts) => placeFile(root, p, c, { mtime: installed, ...opts });
  const L_ = (p, t, opts) => placeLink(root, p, t, { mtime: installed, ...opts });

  /* --- top level ------------------------------------------------- */
  for (const d of ['/boot', '/dev', '/etc', '/home', '/media', '/mnt', '/opt', '/proc', '/run', '/snap', '/srv', '/sys', '/usr', '/var']) {
    D_(d);
  }
  D_('/root', { mode: 0o700 });
  D_('/tmp', { mode: 0o1777, mtime: boot });
  D_('/lost+found', { mode: 0o700 });

  L_('/bin', 'usr/bin');
  L_('/sbin', 'usr/sbin');
  L_('/lib', 'usr/lib');
  L_('/lib64', 'usr/lib64');

  /* --- /usr ------------------------------------------------------ */
  for (const d of ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/libexec', '/usr/local', '/usr/share', '/usr/include', '/usr/src']) {
    D_(d);
  }
  for (const d of ['/usr/local/bin', '/usr/local/sbin', '/usr/local/lib', '/usr/local/share', '/usr/local/etc', '/usr/local/games']) {
    D_(d);
  }
  for (const d of ['/usr/share/applications', '/usr/share/icons', '/usr/share/fonts', '/usr/share/doc', '/usr/share/man', '/usr/share/themes', '/usr/share/backgrounds', '/usr/games']) {
    D_(d);
  }
  for (const name of D.USR_BIN) {
    F_(`/usr/bin/${name}`, '', { mode: 0o755, mtime: installed });
  }
  for (const name of D.USR_SBIN) {
    F_(`/usr/sbin/${name}`, '', { mode: 0o755, mtime: installed });
  }

  /* --- /boot ----------------------------------------------------- */
  D_('/boot/grub');
  D_('/boot/efi');
  F_(`/boot/vmlinuz-${D.KERNEL_RELEASE}`, '', { size: 14_213_312, mtime: upgraded });
  F_(`/boot/initrd.img-${D.KERNEL_RELEASE}`, '', { size: 78_413_824, mtime: upgraded });
  F_(`/boot/config-${D.KERNEL_RELEASE}`, `# Automatically generated file; DO NOT EDIT.\n# Linux/x86 6.8.0-45-generic Kernel Configuration\n`, { size: 287_654, mtime: upgraded });
  F_(`/boot/System.map-${D.KERNEL_RELEASE}`, '', { size: 8_931_240, mtime: upgraded });
  F_('/boot/grub/grub.cfg', `#\n# DO NOT EDIT THIS FILE\n#\n# It is automatically generated by grub-mkconfig using templates\n# from /etc/grub.d and settings from /etc/default/grub\n#\n`, { mode: 0o444, mtime: upgraded });

  /* --- /dev ------------------------------------------------------ */
  F_('/dev/null', '', { mode: 0o666 });
  F_('/dev/zero', '', { mode: 0o666 });
  F_('/dev/full', '', { mode: 0o666 });
  F_('/dev/random', '', { mode: 0o666 });
  F_('/dev/urandom', '', { mode: 0o666 });
  F_('/dev/tty', '', { mode: 0o666 });
  F_('/dev/console', '', { mode: 0o600 });
  F_('/dev/sda', '', { mode: 0o660, group: 'disk' });
  F_('/dev/sda1', '', { mode: 0o660, group: 'disk' });
  F_('/dev/sda2', '', { mode: 0o660, group: 'disk' });
  D_('/dev/pts');
  D_('/dev/shm', { mode: 0o1777 });
  L_('/dev/fd', '/proc/self/fd');
  L_('/dev/stdin', '/proc/self/fd/0');
  L_('/dev/stdout', '/proc/self/fd/1');
  L_('/dev/stderr', '/proc/self/fd/2');

  /* --- /etc ------------------------------------------------------ */
  F_('/etc/os-release', D.OS_RELEASE);
  F_('/etc/lsb-release', D.LSB_RELEASE);
  F_('/etc/hostname', D.HOSTNAME_FILE);
  F_('/etc/hosts', D.HOSTS);
  F_('/etc/shells', D.SHELLS);
  F_('/etc/fstab', D.FSTAB);
  F_('/etc/resolv.conf', D.RESOLV_CONF, { mtime: boot });
  F_('/etc/issue', D.ISSUE);
  F_('/etc/issue.net', D.ISSUE_NET);
  F_('/etc/debian_version', D.DEBIAN_VERSION);
  F_('/etc/machine-id', D.MACHINE_ID, { mode: 0o444 });
  F_('/etc/timezone', D.TIMEZONE);
  F_('/etc/environment', D.ENVIRONMENT_FILE);
  F_('/etc/passwd', users.passwdFile());
  F_('/etc/group', users.groupFile());
  F_('/etc/shadow', users.shadowFile(), { mode: 0o640, group: 'shadow' });
  F_('/etc/gshadow', '', { mode: 0o640, group: 'shadow' });
  F_('/etc/sudoers', `#\n# This file MUST be edited with the 'visudo' command as root.\n#\nDefaults\tenv_reset\nDefaults\tmail_badpass\nDefaults\tsecure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"\n\nroot\tALL=(ALL:ALL) ALL\n%admin ALL=(ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n\n@includedir /etc/sudoers.d\n`, { mode: 0o440 });
  F_('/etc/apt/sources.list', D.SOURCES_LIST);
  F_('/etc/apt/sources.list.d/ubuntu.sources', D.UBUNTU_SOURCES);
  F_('/etc/netplan/50-cloud-init.yaml', `network:\n  version: 2\n  ethernets:\n    enp0s3:\n      dhcp4: true\n`, { mode: 0o600 });
  F_('/etc/skel/.bashrc', D.BASHRC);
  F_('/etc/skel/.profile', D.PROFILE);
  F_('/etc/skel/.bash_logout', D.BASH_LOGOUT);
  for (const d of ['/etc/apt/apt.conf.d', '/etc/apt/preferences.d', '/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly', '/etc/default', '/etc/init.d', '/etc/network', '/etc/pam.d', '/etc/security', '/etc/ssh', '/etc/ssl', '/etc/sudoers.d', '/etc/systemd/system', '/etc/systemd/user', '/etc/udev/rules.d', '/etc/X11', '/etc/xdg']) {
    D_(d);
  }

  /* --- /proc ----------------------------------------------------- */
  F_('/proc/cpuinfo', '', { mode: 0o444, mtime: boot });
  F_('/proc/meminfo', '', { mode: 0o444, mtime: boot });
  F_('/proc/uptime', '', { mode: 0o444, mtime: boot });
  F_('/proc/loadavg', '', { mode: 0o444, mtime: boot });
  F_('/proc/version', D.PROC_VERSION, { mode: 0o444, mtime: boot });
  F_('/proc/cmdline', `BOOT_IMAGE=/boot/vmlinuz-${D.KERNEL_RELEASE} root=UUID=8c2f19f4-6c2e-4d51-9a1f-0d3b7c5e41a2 ro quiet splash vt.handoff=7\n`, { mode: 0o444, mtime: boot });
  F_('/proc/filesystems', `nodev\tsysfs\nnodev\ttmpfs\nnodev\tproc\nnodev\tdevtmpfs\nnodev\tcgroup2\nnodev\toverlay\n\text4\n\tvfat\n\tsquashfs\n`, { mode: 0o444, mtime: boot });
  F_('/proc/mounts', `/dev/sda2 / ext4 rw,relatime,errors=remount-ro 0 0\n/dev/sda1 /boot/efi vfat rw,relatime 0 0\ntmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=811148k,mode=755 0 0\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\nsysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0\n`, { mode: 0o444, mtime: boot });

  /* --- /run, /sys, /var ------------------------------------------ */
  D_('/run/user/1000', { mode: 0o700, ...U, mtime: boot });
  D_('/run/lock', { mode: 0o1777, mtime: boot });
  D_('/run/systemd', { mtime: boot });
  D_('/sys/class');
  D_('/sys/devices');
  D_('/sys/kernel');
  for (const d of ['/var/backups', '/var/cache/apt/archives', '/var/lib/apt/lists', '/var/lib/dpkg', '/var/lib/snapd', '/var/lib/systemd', '/var/lib/gdm3', '/var/local', '/var/log/apt', '/var/mail', '/var/opt', '/var/spool/cron', '/var/www/html']) {
    D_(d);
  }
  D_('/var/tmp', { mode: 0o1777 });
  F_('/var/log/syslog', P.syslog(boot), { mode: 0o640, owner: 'syslog', group: 'adm', mtime: now });
  F_('/var/log/auth.log', P.authLog(boot), { mode: 0o640, owner: 'syslog', group: 'adm', mtime: now });
  F_('/var/log/dpkg.log', P.dpkgLog(boot), { mode: 0o644, mtime: upgraded });
  F_('/var/log/kern.log', P.syslog(boot).split('\n').filter((l) => l.includes('kernel:')).join('\n') + '\n', { mode: 0o640, owner: 'syslog', group: 'adm', mtime: now });
  F_('/var/log/wtmp', P.lastLog(boot), { mode: 0o664, group: 'utmp', mtime: boot });
  F_('/var/log/boot.log', `[\u001b[0;32m  OK  \u001b[0m] Reached target graphical.target - Graphical Interface.\n[\u001b[0;32m  OK  \u001b[0m] Started gdm.service - GNOME Display Manager.\n[\u001b[0;32m  OK  \u001b[0m] Reached target multi-user.target - Multi-User System.\n`, { mode: 0o640, mtime: boot });
  F_('/var/lib/dpkg/arch', 'amd64\n');

  /* --- /root ----------------------------------------------------- */
  F_('/root/.bashrc', D.BASHRC, { owner: 'root', group: 'root', mode: 0o644 });
  F_('/root/.profile', `# ~/.profile: executed by Bourne-compatible login shells.\n\nif [ "$BASH" ]; then\n  if [ -f ~/.bashrc ]; then\n    . ~/.bashrc\n  fi\nfi\n\nmesg n 2> /dev/null || true\n`, { owner: 'root', group: 'root' });

  /* --- /home/ubuntu ---------------------------------------------- */
  const homeOpts = { ...U, mtime: now - 2 * 3600_000 };
  D_('/home/ubuntu', homeOpts);
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos', 'Projects']) {
    D_(`/home/ubuntu/${name}`, { ...U, mtime: installed + DAY });
  }
  for (const d of ['/home/ubuntu/.cache', '/home/ubuntu/.config/dconf', '/home/ubuntu/.config/gtk-3.0', '/home/ubuntu/.config/gtk-4.0', '/home/ubuntu/.config/autostart', '/home/ubuntu/.config/systemd/user', '/home/ubuntu/.local/bin', '/home/ubuntu/.local/share/applications', '/home/ubuntu/.local/share/Trash/files', '/home/ubuntu/.local/share/Trash/info', '/home/ubuntu/.ssh']) {
    D_(d, { ...U, mtime: installed + DAY });
  }
  const ssh = ensureDir(root, '/home/ubuntu/.ssh', {});
  ssh.mode = 0o700;

  F_('/home/ubuntu/.bashrc', D.BASHRC, { ...U, mtime: installed });
  F_('/home/ubuntu/.profile', D.PROFILE, { ...U, mtime: installed });
  F_('/home/ubuntu/.bash_logout', D.BASH_LOGOUT, { ...U, mtime: installed });
  F_('/home/ubuntu/.bash_history', D.BASH_HISTORY, { ...U, mode: 0o600, mtime: now - 3600_000 });
  F_('/home/ubuntu/.sudo_as_admin_successful', '', { ...U, mtime: installed + DAY });
  F_('/home/ubuntu/.gitconfig', `[user]\n\tname = Ubuntu User\n\temail = ubuntu@ubuntu-ai.local\n[init]\n\tdefaultBranch = main\n[core]\n\teditor = nano\n[pull]\n\trebase = false\n`, { ...U, mtime: installed + 3 * DAY });
  F_('/home/ubuntu/.config/gtk-3.0/settings.ini', `[Settings]\ngtk-theme-name=Yaru\ngtk-icon-theme-name=Yaru\ngtk-font-name=Ubuntu 11\ngtk-cursor-theme-name=Yaru\ngtk-application-prefer-dark-theme=0\n`, { ...U, mtime: installed + DAY });

  F_('/home/ubuntu/README.md', P.README_MD, { ...U, mtime: now - 6 * DAY });
  F_('/home/ubuntu/hello.py', P.HELLO_PY, { ...U, mode: 0o755, mtime: now - 9 * DAY });
  F_('/home/ubuntu/Desktop/welcome.txt', P.WELCOME_TXT, { ...U, mtime: now - 12 * DAY });
  F_('/home/ubuntu/Desktop/help.txt', HELP_TXT, { ...U, mtime: now - 12 * DAY });
  F_('/home/ubuntu/Documents/notes.md', P.NOTES_MD, { ...U, mtime: now - 4 * DAY });
  F_('/home/ubuntu/Documents/todo.txt', P.TODO_TXT, { ...U, mtime: now - 2 * DAY });
  F_('/home/ubuntu/Downloads/ubuntu-24.04.1-desktop-amd64.iso', '', { ...U, size: D.ISO_SIZE, mtime: now - 21 * DAY });
  F_('/home/ubuntu/Templates/Empty Document', '', { ...U, mtime: installed + DAY });
  // Real, openable images rather than a zero-byte stub — see fs-pictures.js for
  // why these are SVG and not PNG.
  for (const [name, content] of PICTURES) {
    F_(`/home/ubuntu/Pictures/${name}`, content, { ...U, mtime: installed + DAY });
  }
  F_('/home/ubuntu/Pictures/Screenshots/.keep', '', { ...U, mtime: installed + DAY });

  let projectMtime = now - 3 * DAY;
  for (const [rel, content] of Object.entries(P.PROJECT_FILES)) {
    const executable = rel.endsWith('main.py');
    F_(`/home/ubuntu/Projects/${rel}`, content, {
      ...U,
      mode: executable ? 0o755 : 0o644,
      mtime: projectMtime,
    });
    projectMtime += 1200_000;
  }

  return root;
}
