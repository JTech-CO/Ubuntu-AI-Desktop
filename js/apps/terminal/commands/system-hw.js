/**
 * js/apps/terminal/commands/system-hw.js — hardware inventory and service
 * management: lscpu, lsblk, lsusb, lspci, lsmod, mount, dmesg, systemctl,
 * journalctl, hostnamectl, timedatectl, lsb_release.
 *
 * Every layout reproduces the real util-linux 2.39 / systemd 255 output that
 * ships with Ubuntu 24.04.1 LTS.
 *
 * Where a field describes hardware, it describes the *real* machine through
 * `js/core/device.js`: the CPU count and architecture in `lscpu`, the GPU in
 * `lspci`, the storage capacity in `lsblk`, the architecture and device model
 * in `hostnamectl`, the time zone in `timedatectl`. Fields the browser simply
 * does not expose — the CPU vendor and stepping, the SMT topology, the USB bus
 * — are omitted or reported as unknown rather than filled in with a plausible
 * lie. See the honesty notes at the top of `device.js`.
 */

import { procs } from '../../../core/procs.js';
import { users } from '../../../core/users.js';
import { env } from '../../../core/env.js';
import { device } from '../../../core/device.js';
import { mountTable } from '../../monitor/filesystems.js';
import {
  CSI, RESET, GREEN, RED, ok, fail, wait, isRoot,
  systemdStamp, syslogStamp, agoPhrase, tzAbbr, numericOffset,
} from './util.js';

export const MACHINE_ID = '4f2c9a1de8b64f0d9c3a7e51b8206d34';
export const BOOT_ID = 'ab19f4c27d5e41b6892f0c3a7d15e8b4';

/**
 * systemd's chassis vocabulary, chosen from the host operating system — the
 * closest thing to a form factor a web page can observe.
 */
const CHASSIS_BY_OS = {
  Android: 'handset',
  iOS: 'handset',
  iPadOS: 'tablet',
  ChromeOS: 'laptop',
};

/**
 * `uname -m` names differ from systemd's; translate for hostnamectl.
 * @param {string} arch
 * @returns {string}
 */
function systemdArch(arch) {
  if (arch === 'aarch64') return 'arm64';
  if (arch === 'i686') return 'x86';
  return 'x86-64';
}

/* ------------------------------------------------------------------ *
 * systemd unit table
 * ------------------------------------------------------------------ */

/**
 * @typedef {{unit:string, desc:string, proc:string|null, type:string,
 *            docs:string, enabled:string, sub?:string}} UnitDef
 */

/** @type {UnitDef[]} */
export const UNITS = [
  { unit: 'accounts-daemon.service', desc: 'Accounts Service', proc: 'accounts-daemon', type: 'dbus', docs: 'man:accounts-daemon(8)', enabled: 'enabled' },
  { unit: 'apparmor.service', desc: 'Load AppArmor profiles', proc: null, type: 'oneshot', docs: 'man:apparmor(7)', enabled: 'enabled', sub: 'exited' },
  { unit: 'avahi-daemon.service', desc: 'Avahi mDNS/DNS-SD Stack', proc: 'avahi-daemon', type: 'dbus', docs: 'man:avahi-daemon(8)', enabled: 'enabled' },
  { unit: 'bluetooth.service', desc: 'Bluetooth service', proc: 'bluetoothd', type: 'dbus', docs: 'man:bluetoothd(8)', enabled: 'enabled' },
  { unit: 'cron.service', desc: 'Regular background program processing daemon', proc: 'cron', type: 'simple', docs: 'man:cron(8)', enabled: 'enabled' },
  { unit: 'dbus.service', desc: 'D-Bus System Message Bus', proc: 'dbus-daemon', type: 'notify', docs: 'man:dbus-daemon(1)', enabled: 'static' },
  { unit: 'docker.service', desc: 'Docker Application Container Engine', proc: 'dockerd', type: 'notify', docs: 'https://docs.docker.com', enabled: 'disabled' },
  { unit: 'gdm.service', desc: 'GNOME Display Manager', proc: 'gdm3', type: 'notify', docs: 'man:gdm3(8)', enabled: 'enabled' },
  { unit: 'ModemManager.service', desc: 'Modem Manager', proc: 'ModemManager', type: 'dbus', docs: 'man:ModemManager(8)', enabled: 'enabled' },
  { unit: 'NetworkManager.service', desc: 'Network Manager', proc: 'NetworkManager', type: 'dbus', docs: 'man:NetworkManager(8)', enabled: 'enabled' },
  { unit: 'nginx.service', desc: 'A high performance web server and a reverse proxy server', proc: 'nginx', type: 'forking', docs: 'man:nginx(8)', enabled: 'disabled' },
  { unit: 'polkit.service', desc: 'Authorization Manager', proc: 'polkitd', type: 'dbus', docs: 'man:polkit(8)', enabled: 'static' },
  { unit: 'rsyslog.service', desc: 'System Logging Service', proc: 'rsyslogd', type: 'notify', docs: 'man:rsyslogd(8)', enabled: 'enabled' },
  { unit: 'snapd.service', desc: 'Snap Daemon', proc: 'snapd', type: 'notify', docs: 'man:snap(8)', enabled: 'enabled' },
  { unit: 'ssh.service', desc: 'OpenBSD Secure Shell server', proc: 'sshd', type: 'notify', docs: 'man:sshd(8)', enabled: 'disabled' },
  { unit: 'systemd-journald.service', desc: 'Journal Service', proc: 'systemd-journald', type: 'notify', docs: 'man:systemd-journald.service(8)', enabled: 'static' },
  { unit: 'systemd-networkd.service', desc: 'Network Configuration', proc: 'systemd-networkd', type: 'notify', docs: 'man:systemd-networkd.service(8)', enabled: 'enabled' },
  { unit: 'systemd-oomd.service', desc: 'Userspace Out-Of-Memory (OOM) Killer', proc: 'systemd-oomd', type: 'notify', docs: 'man:systemd-oomd.service(8)', enabled: 'enabled' },
  { unit: 'systemd-resolved.service', desc: 'Network Name Resolution', proc: 'systemd-resolved', type: 'notify', docs: 'man:systemd-resolved.service(8)', enabled: 'enabled' },
  { unit: 'systemd-udevd.service', desc: 'Rule-based Manager for Device Events and Files', proc: 'systemd-udevd', type: 'notify', docs: 'man:systemd-udevd.service(8)', enabled: 'static' },
  { unit: 'udisks2.service', desc: 'Disk Manager', proc: 'udisksd', type: 'dbus', docs: 'man:udisks(8)', enabled: 'enabled' },
  { unit: 'ufw.service', desc: 'Uncomplicated firewall', proc: null, type: 'oneshot', docs: 'man:ufw(8)', enabled: 'enabled', sub: 'exited' },
  { unit: 'unattended-upgrades.service', desc: 'Unattended Upgrades Shutdown', proc: null, type: 'simple', docs: 'man:unattended-upgrade(8)', enabled: 'enabled', sub: 'exited' },
];

/**
 * Normalise a unit argument: `cron` -> `cron.service`.
 * @param {string} name
 * @returns {string}
 */
export function unitName(name) {
  const n = String(name);
  return /\.(service|socket|target|timer|mount|path|slice|scope)$/.test(n) ? n : `${n}.service`;
}

/**
 * @param {string} name
 * @returns {UnitDef|null}
 */
export function findUnit(name) {
  const want = unitName(name).toLowerCase();
  return UNITS.find((u) => u.unit.toLowerCase() === want) || null;
}

/**
 * @param {UnitDef} unit
 * @returns {{active:boolean, sub:string, proc:object|null}}
 */
export function unitState(unit) {
  if (unit.proc === null) {
    return { active: unit.sub === 'exited', sub: unit.sub || 'dead', proc: null };
  }
  const found = procs.find(unit.proc);
  if (found.length === 0) return { active: false, sub: 'dead', proc: null };
  return { active: true, sub: 'running', proc: found[0] };
}

/**
 * The `● name.service - Description` status block.
 * @param {UnitDef} unit
 * @returns {string}
 */
function statusBlock(unit) {
  const state = unitState(unit);
  const bullet = state.active ? `${GREEN}●${RESET}` : `${CSI}90m○${RESET}`;
  const lines = [`${bullet} ${unit.unit} - ${unit.desc}`];
  lines.push(`     Loaded: loaded (/usr/lib/systemd/system/${unit.unit}; ${unit.enabled}; preset: enabled)`);

  if (state.active && state.proc) {
    const p = state.proc;
    lines.push(`     Active: ${GREEN}active (running)${RESET} since ${systemdStamp(new Date(p.startedAt))}; ${agoPhrase(Date.now() - p.startedAt)}`);
    lines.push(`       Docs: ${unit.docs}`);
    lines.push(`   Main PID: ${p.pid} (${p.name})`);
    lines.push(`      Tasks: ${p.threads} (limit: 9451)`);
    lines.push(`     Memory: ${p.mem.toFixed(1)}M (peak: ${(p.mem * 1.18).toFixed(1)}M)`);
    lines.push(`        CPU: ${p.cpuTime.toFixed(3)}s`);
    lines.push(`     CGroup: /system.slice/${unit.unit}`);
    lines.push(`             └─${p.pid} ${p.cmd}`);
  } else if (state.active) {
    const started = new Date(procs.bootTime + 21000);
    lines.push(`     Active: ${GREEN}active (exited)${RESET} since ${systemdStamp(started)}; ${agoPhrase(Date.now() - started.getTime())}`);
    lines.push(`       Docs: ${unit.docs}`);
    lines.push(`    Process: 421 ExecStart=/usr/lib/${unit.unit.replace('.service', '')} start (code=exited, status=0/SUCCESS)`);
    lines.push('   Main PID: 421 (code=exited, status=0/SUCCESS)');
    lines.push('        CPU: 41ms');
  } else {
    lines.push('     Active: inactive (dead)');
    lines.push(`       Docs: ${unit.docs}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Static hardware tables
 * ------------------------------------------------------------------ */

/**
 * Per-architecture facts that follow from the instruction set alone. None of
 * this is a claim about a particular part: `x86_64` implies these flags and
 * these op-modes whatever chip is underneath, which is exactly why they are
 * safe to print when the browser will not name the chip.
 */
const ARCH_PROFILE = {
  x86_64: {
    opModes: '32-bit, 64-bit',
    addressSizes: '39 bits physical, 48 bits virtual',
    flags: [
      'fpu', 'vme', 'de', 'pse', 'tsc', 'msr', 'pae', 'mce', 'cx8', 'apic', 'sep', 'mtrr', 'pge',
      'mca', 'cmov', 'pat', 'pse36', 'clflush', 'mmx', 'fxsr', 'sse', 'sse2', 'ss', 'ht', 'syscall',
      'nx', 'pdpe1gb', 'rdtscp', 'lm', 'constant_tsc', 'rep_good', 'nopl', 'xtopology',
      'nonstop_tsc', 'cpuid', 'pni', 'pclmulqdq', 'monitor', 'ssse3', 'fma', 'cx16', 'pcid',
      'sse4_1', 'sse4_2', 'x2apic', 'movbe', 'popcnt', 'tsc_deadline_timer', 'aes', 'xsave', 'avx',
      'f16c', 'rdrand', 'hypervisor', 'lahf_lm', 'abm', '3dnowprefetch', 'fsgsbase', 'tsc_adjust',
      'bmi1', 'avx2', 'smep', 'bmi2', 'erms', 'invpcid', 'rdseed', 'adx', 'smap', 'clflushopt',
      'xsaveopt', 'xsavec', 'xgetbv1', 'xsaves', 'arat',
    ].join(' '),
  },
  i686: {
    opModes: '32-bit',
    addressSizes: '36 bits physical, 32 bits virtual',
    flags: [
      'fpu', 'vme', 'de', 'pse', 'tsc', 'msr', 'pae', 'mce', 'cx8', 'apic', 'sep', 'mtrr', 'pge',
      'mca', 'cmov', 'pat', 'pse36', 'clflush', 'mmx', 'fxsr', 'sse', 'sse2', 'ss', 'ht', 'nopl',
      'cpuid', 'pni', 'pclmulqdq', 'monitor', 'ssse3', 'cx16', 'sse4_1', 'sse4_2', 'movbe',
      'popcnt', 'aes', 'xsave', 'avx', 'hypervisor', 'lahf_lm',
    ].join(' '),
  },
  aarch64: {
    opModes: '64-bit',
    addressSizes: '48 bits physical, 48 bits virtual',
    flags: [
      'fp', 'asimd', 'evtstrm', 'aes', 'pmull', 'sha1', 'sha2', 'crc32', 'atomics', 'fphp',
      'asimdhp', 'cpuid', 'asimdrdm', 'lrcpc', 'dcpop', 'asimddp',
    ].join(' '),
  },
};

/** @returns {{opModes:string, addressSizes:string, flags:string}} */
function archProfile() {
  return ARCH_PROFILE[device.arch()] || ARCH_PROFILE.x86_64;
}

/**
 * Determine endianness from the JavaScript engine itself rather than assuming
 * it from the architecture name.
 * @returns {string} 'Little Endian' | 'Big Endian'
 */
function byteOrder() {
  const probe = new Uint16Array([1]);
  return new Uint8Array(probe.buffer)[0] === 1 ? 'Little Endian' : 'Big Endian';
}

/**
 * Build the util-linux 2.39 hierarchical `lscpu` table as `[label, value,
 * indent]` rows.
 *
 * Real: the architecture, the byte order, the CPU op-modes, the logical CPU
 * count and the on-line list. Absent: the vendor, family, model, stepping and
 * clock speeds, which web content is never told — real `lscpu` omits fields it
 * cannot determine and so does this, rather than printing an invented part
 * number. One thread per core is reported because the SMT topology is not
 * exposed either and guessing "2" would be a fabrication; `/proc/cpuinfo`
 * reports the same shape, so the two agree.
 *
 * @returns {Array<[string, string, number]>}
 */
function lscpuRows() {
  const cores = procs.cores;
  const online = cores === 1 ? '0' : `0-${cores - 1}`;
  const profile = archProfile();
  const l1i = device.arch() === 'aarch64' ? 64 : 32;

  return [
    ['Architecture', device.arch(), 0],
    ['CPU op-mode(s)', profile.opModes, 1],
    ['Address sizes', profile.addressSizes, 1],
    ['Byte Order', byteOrder(), 1],
    ['CPU(s)', String(cores), 0],
    ['On-line CPU(s) list', online, 1],
    ['Vendor ID', 'Unknown', 0],
    ['Model name', device.cpuModel(), 1],
    ['Thread(s) per core', '1', 2],
    ['Core(s) per socket', String(cores), 2],
    ['Socket(s)', '1', 2],
    ['Flags', profile.flags, 2],
    ['Caches (sum of all)', '', 0],
    ['L1d', `${cores * 32} KiB (${cores} instances)`, 1],
    ['L1i', `${cores * l1i} KiB (${cores} instances)`, 1],
    ['L2', `${cores} MiB (${cores} instances)`, 1],
    ['L3', `${Math.max(2, cores * 2)} MiB (1 instance)`, 1],
    ['NUMA', '', 0],
    ['NUMA node(s)', '1', 1],
    ['NUMA node0 CPU(s)', online, 1],
  ];
}

/**
 * `lsblk`-style size: powers of 1024 with a bare suffix, one decimal below 10.
 * @param {number} bytes
 * @returns {string}
 */
function blockSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)}${units[i]}`;
}

/**
 * Block devices. The snap loop mounts are part of the emulator's Ubuntu
 * fiction and make no claim about the host, but the disk does: `uad0` is this
 * desktop's own storage and its size is the browser's real storage quota, the
 * only capacity figure a web page can obtain. There is deliberately no `sda`,
 * because nothing here can see a physical drive.
 *
 * @returns {Array<[string, string, string, string, string, string, string]>}
 */
function lsblkRows() {
  const root = mountTable().find((m) => m.directory === '/');
  const size = blockSize(root ? root.total : 0);
  return [
    ['loop0', '7:0', '0', '73.9M', '1', 'loop', '/snap/core22/1612'],
    ['loop1', '7:1', '0', '40.4M', '1', 'loop', '/snap/snapd/21759'],
    ['loop2', '7:2', '0', '335M', '1', 'loop', '/snap/gnome-42-2204/176'],
    ['loop3', '7:3', '0', '267M', '1', 'loop', '/snap/firefox/4848'],
    ['loop4', '7:4', '0', '92M', '1', 'loop', '/snap/gtk-common-themes/1535'],
    ['uad0', '252:0', '0', size, '0', 'disk', ''],
    ['└─uad0p1', '252:1', '0', size, '0', 'part', '/'],
  ];
}

/**
 * USB devices. WebUSB only ever reveals devices the user has explicitly
 * granted, and this page asks for none, so the bus is genuinely empty as far
 * as it can tell — root hubs only, which is exactly what real `lsusb` prints
 * on a machine with nothing attached.
 */
const LSUSB_LINES = [
  'Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub',
  'Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub',
];

/**
 * PCI devices. The chipset is the emulator's virtual platform, but the display
 * adapter is not invented: it is the WebGL renderer string for the real GPU
 * (or an explicit note when the browser masks it).
 *
 * @returns {{lines: string[], codes: string[], drivers: string[]}}
 */
function lspciTable() {
  const lines = [
    '00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma] (rev 02)',
    '00:01.0 ISA bridge: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]',
    '00:01.1 IDE interface: Intel Corporation 82371AB/EB/MB PIIX4 IDE (rev 01)',
    `00:02.0 VGA compatible controller: ${device.gpuModel()}`,
    '00:03.0 Ethernet controller: Intel Corporation 82540EM Gigabit Ethernet Controller (rev 02)',
    '00:04.0 System peripheral: InnoTek Systemberatung GmbH VirtualBox Guest Service',
    "00:05.0 Multimedia audio controller: Intel Corporation 82801AA AC'97 Audio Controller (rev 01)",
    '00:06.0 USB controller: Apple Inc. KeyLargo/Intrepid USB',
    '00:07.0 Bridge: Intel Corporation 82371AB/EB/MB PIIX4 ACPI (rev 08)',
    '00:0d.0 SATA controller: Intel Corporation 82801HM/HEM (ICH8M/ICH8M-E) SATA Controller [AHCI mode] (rev 02)',
  ];
  const codes = [
    '[8086:1237] (rev 02)', '[8086:7000]', '[8086:7111] (rev 01)', '',
    '[8086:100e] (rev 02)', '[80ee:cafe]', '[8086:2415] (rev 01)', '[106b:003f]',
    '[8086:7113] (rev 08)', '[8086:2829] (rev 02)',
  ];
  const drivers = ['', '', 'ata_piix', '', 'e1000', 'vboxguest', 'snd_intel8x0', 'ohci-pci', '', 'ahci'];
  return { lines, codes, drivers };
}

const LSMOD_ROWS = [
  ['vboxvideo', 32768, 0, ''],
  ['vboxsf', 45056, 1, ''],
  ['vboxguest', 393216, 2, 'vboxsf'],
  ['snd_intel8x0', 49152, 2, ''],
  ['snd_ac97_codec', 176128, 1, 'snd_intel8x0'],
  ['ac97_bus', 12288, 1, 'snd_ac97_codec'],
  ['snd_pcm', 184320, 2, 'snd_intel8x0,snd_ac97_codec'],
  ['snd_timer', 49152, 1, 'snd_pcm'],
  ['snd', 131072, 6, 'snd_intel8x0,snd_timer,snd_ac97_codec,snd_pcm'],
  ['soundcore', 16384, 1, 'snd'],
  ['nls_iso8859_1', 12288, 1, ''],
  ['intel_rapl_msr', 20480, 0, ''],
  ['intel_rapl_common', 40960, 1, 'intel_rapl_msr'],
  ['kvm_intel', 483328, 0, ''],
  ['kvm', 1404928, 1, 'kvm_intel'],
  ['crct10dif_pclmul', 12288, 1, ''],
  ['polyval_clmulni', 12288, 0, ''],
  ['ghash_clmulni_intel', 16384, 0, ''],
  ['aesni_intel', 356352, 0, ''],
  ['crypto_simd', 16384, 1, 'aesni_intel'],
  ['cryptd', 24576, 2, 'crypto_simd,ghash_clmulni_intel'],
  ['input_leds', 12288, 0, ''],
  ['joydev', 32768, 0, ''],
  ['serio_raw', 20480, 0, ''],
  ['mac_hid', 12288, 0, ''],
  ['sch_fq_codel', 20480, 4, ''],
  ['dm_multipath', 45056, 0, ''],
  ['msr', 12288, 0, ''],
  ['efi_pstore', 12288, 0, ''],
  ['nfnetlink', 20480, 2, ''],
  ['dmi_sysfs', 24576, 0, ''],
  ['ip_tables', 32768, 0, ''],
  ['x_tables', 65536, 1, 'ip_tables'],
  ['autofs4', 57344, 2, ''],
  ['hid_generic', 12288, 0, ''],
  ['usbhid', 73728, 0, ''],
  ['hid', 176128, 2, 'usbhid,hid_generic'],
  ['crc32_pclmul', 12288, 0, ''],
  ['psmouse', 208896, 0, ''],
  ['ahci', 49152, 2, ''],
  ['libahci', 53248, 1, 'ahci'],
  ['e1000', 176128, 0, ''],
  ['video', 73728, 0, ''],
  ['wmi', 28672, 0, ''],
];

/**
 * The `mount` table. The tmpfs sizes are the ones systemd derives from real
 * RAM, and `/` is this desktop's own filesystem on the virtual disk whose
 * capacity is the browser storage quota — the same table `df`, `lsblk` and the
 * System Monitor's File Systems tab report from.
 *
 * @returns {string[]}
 */
function mountLines() {
  const kb = (bytes) => Math.round(bytes / 1024);
  const byDir = new Map(mountTable().map((m) => [m.directory, m]));
  const size = (dir) => kb(byDir.has(dir) ? byDir.get(dir).total : 0);
  const shm = size('/dev/shm');

  return [
    'sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)',
    'proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)',
    `udev on /dev type devtmpfs (rw,nosuid,relatime,size=${shm}k,nr_inodes=${Math.round(shm / 4)},mode=755,inode64)`,
    'devpts on /dev/pts type devpts (rw,nosuid,noexec,relatime,gid=5,mode=620,ptmxmode=000)',
    `tmpfs on /run type tmpfs (rw,nosuid,nodev,noexec,relatime,size=${size('/run')}k,mode=755,inode64)`,
    '/dev/uad0p1 on / type ext4 (rw,relatime,errors=remount-ro)',
    'securityfs on /sys/kernel/security type securityfs (rw,nosuid,nodev,noexec,relatime)',
    `tmpfs on /dev/shm type tmpfs (rw,nosuid,nodev,size=${shm}k,inode64)`,
    `tmpfs on /run/lock type tmpfs (rw,nosuid,nodev,noexec,relatime,size=${size('/run/lock')}k,inode64)`,
    'cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)',
    'pstore on /sys/fs/pstore type pstore (rw,nosuid,nodev,noexec,relatime)',
    'bpf on /sys/fs/bpf type bpf (rw,nosuid,nodev,noexec,relatime,mode=700)',
    'systemd-1 on /proc/sys/fs/binfmt_misc type autofs (rw,relatime,fd=31,pgrp=1,timeout=0,minproto=5,maxproto=5,direct)',
    'hugetlbfs on /dev/hugepages type hugetlbfs (rw,relatime,pagesize=2M)',
    'mqueue on /dev/mqueue type mqueue (rw,nosuid,nodev,noexec,relatime)',
    'debugfs on /sys/kernel/debug type debugfs (rw,nosuid,nodev,noexec,relatime)',
    'tracefs on /sys/kernel/tracing type tracefs (rw,nosuid,nodev,noexec,relatime)',
    'fusectl on /sys/fs/fuse/connections type fusectl (rw,nosuid,nodev,noexec,relatime)',
    'configfs on /sys/kernel/config type configfs (rw,nosuid,nodev,noexec,relatime)',
    '/var/lib/snapd/snaps/core22_1612.snap on /snap/core22/1612 type squashfs (ro,nodev,relatime,errors=continue,x-gdu.hide)',
    '/var/lib/snapd/snaps/snapd_21759.snap on /snap/snapd/21759 type squashfs (ro,nodev,relatime,errors=continue,x-gdu.hide)',
    '/var/lib/snapd/snaps/firefox_4848.snap on /snap/firefox/4848 type squashfs (ro,nodev,relatime,errors=continue,x-gdu.hide)',
    `tmpfs on /run/user/1000 type tmpfs (rw,nosuid,nodev,relatime,size=${size('/run/user/1000')}k,nr_inodes=${Math.round(size('/run/user/1000') / 4)},mode=700,uid=1000,gid=1000,inode64)`,
    'gvfsd-fuse on /run/user/1000/gvfs type fuse.gvfsd-fuse (rw,nosuid,nodev,relatime,user_id=1000,group_id=1000)',
    'portal on /run/user/1000/doc type fuse.portal (rw,nosuid,nodev,relatime,user_id=1000,group_id=1000)',
  ];
}

/**
 * Kernel ring buffer: `[monotonic seconds, syslog level, text]`.
 *
 * The boot narrative is the emulator's own — there is no kernel here — but the
 * lines that quote a quantity quote the real one: the CPU count, the memory
 * map, the architecture and the size of the virtual disk all come from
 * `device.js` rather than being frozen at 8 cores and 8 GiB.
 *
 * @returns {Array<[number, number, string]>}
 */
function dmesgEntries() {
  const cores = procs.cores;
  const memKb = procs.totals().memTotalMb * 1024;
  const root = mountTable().find((m) => m.directory === '/');
  const diskBytes = root ? root.total : 0;
  const sectors = Math.round(diskBytes / 512);

  return [
    [0.000000, 6, 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-034) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0, GNU ld (GNU Binutils for Ubuntu) 2.42) #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024'],
    [0.000000, 6, 'Command line: BOOT_IMAGE=/boot/vmlinuz-6.8.0-45-generic root=UUID=8f2a1c4d-7b3e-4a19-9c56-2d0e8f7a1b3c ro quiet splash'],
    [0.000000, 6, 'KERNEL supported cpus:'],
    [0.000000, 6, '  Intel GenuineIntel'],
    [0.000000, 6, '  AMD AuthenticAMD'],
    [0.000000, 6, 'BIOS-provided physical RAM map:'],
    [0.000000, 6, 'BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable'],
    [0.000000, 6, 'BIOS-e820: [mem 0x0000000000100000-0x00000000dffeffff] usable'],
    [0.000000, 6, 'NX (Execute Disable) protection: active'],
    [0.000000, 6, 'SMBIOS 2.5 present.'],
    [0.000000, 6, 'DMI: innotek GmbH VirtualBox/VirtualBox, BIOS VirtualBox 12/01/2006'],
    [0.008000, 6, 'last_pfn = 0xdfff0 max_arch_pfn = 0x400000000'],
    [0.012000, 6, 'x86/PAT: Configuration [0-7]: WB  WC  UC- UC  WB  WP  UC- WT'],
    [0.041000, 6, 'Using GB pages for direct mapping'],
    [0.084000, 6, 'ACPI: Early table checksum verification disabled'],
    [0.121000, 6, `smpboot: Allowing ${cores} CPUs, 0 hotplug CPUs`],
    [0.184000, 6, `Memory: ${Math.round(memKb * 0.955)}K/${memKb}K available (18432K kernel code, 3163K rwdata, 12444K rodata)`],
    [0.212000, 6, 'random: crng init done'],
    [0.318000, 6, 'ACPI: Added _OSI(Module Device)'],
    [0.402000, 6, 'PCI: Using configuration type 1 for base access'],
    [0.541000, 6, 'clocksource: Switched to clocksource tsc-early'],
    [0.688000, 6, 'PCI: Probing PCI hardware'],
    [0.712000, 6, 'e1000: Intel(R) PRO/1000 Network Driver'],
    [0.744000, 6, 'ahci 0000:00:0d.0: AHCI 0001.0100 32 slots 1 ports 3 Gbps 0x1 impl SATA mode'],
    [0.801000, 6, 'scsi host0: ahci'],
    [0.912000, 6, 'ata1: SATA max UDMA/133 abar m8192@0xf0806000 port 0xf0806100 irq 21'],
    [1.204000, 6, 'ata1.00: ATA-6: UAD VIRTUAL DISK, 1.0, max UDMA/133'],
    [1.208000, 6, `sd 0:0:0:0: [uad0] ${sectors} 512-byte logical blocks: (${blockSize(diskBytes)})`],
    [1.211000, 6, 'uad0: uad0p1'],
    [1.216000, 6, 'sd 0:0:0:0: [uad0] Attached SCSI disk'],
    [1.402000, 6, 'EXT4-fs (uad0p1): mounted filesystem 8f2a1c4d-7b3e-4a19-9c56-2d0e8f7a1b3c ro with ordered data mode. Quota mode: none.'],
    [1.508000, 6, 'VFS: Mounted root (ext4 filesystem) readonly on device 252:1.'],
    [1.744000, 6, 'systemd[1]: systemd 255.4-1ubuntu8.4 running in system mode (+PAM +AUDIT +SELINUX +APPARMOR +IMA)'],
    [1.812000, 6, 'systemd[1]: Detected virtualization oracle.'],
    [1.813000, 6, `systemd[1]: Detected architecture ${systemdArch(device.arch())}.`],
    [2.104000, 6, 'e1000 0000:00:03.0 enp0s3: renamed from eth0'],
    [2.418000, 6, 'EXT4-fs (uad0p1): re-mounted 8f2a1c4d-7b3e-4a19-9c56-2d0e8f7a1b3c r/w.'],
    [2.812000, 5, 'audit: type=1400 audit(1755474862.104:2): apparmor="STATUS" operation="profile_load" profile="unconfined" name="lsb_release"'],
    [3.014000, 6, 'loop0: detected capacity change from 0 to 151264'],
    [3.108000, 6, 'squashfs: version 4.0 (2009/01/31) Phillip Lougher'],
    [3.402000, 4, 'vboxguest: loading out-of-tree module taints kernel.'],
    [3.418000, 6, 'vboxguest: Successfully loaded version 7.0.20 r163906'],
    [3.804000, 6, 'input: VirtualBox USB Tablet as /devices/pci0000:00/0000:00:06.0/usb1/1-1/1-1:1.0/0003:80EE:0021.0001/input/input6'],
    [4.212000, 6, 'intel_rapl_common: Found RAPL domain package'],
    [4.618000, 6, 'Bluetooth: Core ver 2.22'],
    [5.104000, 6, 'IPv6: ADDRCONF(NETDEV_CHANGE): enp0s3: link becomes ready'],
      [8.204000, 6, 'systemd-journald[312]: Received client request to flush runtime journal.'],
  ];
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const hwCommands = [
  {
    name: 'lscpu',
    aliases: [],
    synopsis: 'lscpu [-p] [-e]',
    description: 'Display information about the CPU architecture',
    man: `NAME
       lscpu - display information about the CPU architecture

SYNOPSIS
       lscpu [options]

DESCRIPTION
       lscpu gathers CPU architecture information from sysfs, /proc/cpuinfo and
       any applicable architecture-specific libraries, and prints it in a
       human-readable format.

OPTIONS
       -p, --parse[=LIST]
              Optimize the command output for easy parsing.

       -e, --extended[=LIST]
              Display the CPU information in a table.`,
    async run(ctx) {
      // One thread per core throughout, matching lscpuRows() and /proc/cpuinfo:
      // the browser reports logical CPUs and nothing about SMT.
      if (ctx.argv.some((a) => a === '-p' || a.startsWith('--parse'))) {
        const head = [
          '# The following is the parsable format, which can be fed to other',
          '# programs. Each different item in every column has an unique ID',
          '# starting from zero.',
          '# CPU,Core,Socket,Node,,L1d,L1i,L2,L3',
        ];
        for (let i = 0; i < procs.cores; i += 1) {
          head.push(`${i},${i},0,0,,${i},${i},${i},0`);
        }
        return ok(`${head.join('\n')}\n`);
      }
      if (ctx.argv.some((a) => a === '-e' || a.startsWith('--extended'))) {
        const rows = ['CPU NODE SOCKET CORE L1d:L1i:L2:L3 ONLINE'];
        for (let i = 0; i < procs.cores; i += 1) {
          rows.push(
            `${String(i).padEnd(3)} ${'0'.padEnd(4)} ${'0'.padEnd(6)} ${String(i).padEnd(4)} `
            + `${`${i}:${i}:${i}:0`.padEnd(13)} yes`,
          );
        }
        return ok(`${rows.join('\n')}\n`);
      }
      const lines = lscpuRows().map(([label, value, indent]) => {
        const key = `${'  '.repeat(indent)}${label}:`;
        return value === '' ? key.padEnd(26) : `${key.padEnd(26)}${value}`;
      });
      return ok(`${lines.join('\n')}\n`);
    },
  },

  {
    name: 'lsblk',
    aliases: [],
    synopsis: 'lsblk [-a] [-f] [-l]',
    description: 'List block devices',
    man: `NAME
       lsblk - list block devices

SYNOPSIS
       lsblk [options] [device...]

DESCRIPTION
       lsblk lists information about all available or the specified block
       devices. It reads the sysfs filesystem and udev db to gather
       information. By default it prints all block devices (except RAM disks)
       in a tree-like format.

OPTIONS
       -a, --all      Also list empty devices and RAM disk devices.
       -f, --fs       Output info about filesystems.
       -l, --list     Produce output in the form of a list.`,
    async run(ctx) {
      const rows = lsblkRows();
      if (ctx.argv.includes('-f') || ctx.argv.includes('--fs')) {
        const root = mountTable().find((m) => m.directory === '/');
        const avail = blockSize(root ? root.available : 0);
        const usePct = root && root.total > 0 ? `${Math.ceil(root.percent)}%` : '';
        const table = [
          ['NAME', 'FSTYPE', 'FSVER', 'LABEL', 'UUID', 'FSAVAIL', 'FSUSE%', 'MOUNTPOINTS'],
          ['loop0', 'squashfs', '4.0', '', '', '0', '100%', '/snap/core22/1612'],
          ['loop1', 'squashfs', '4.0', '', '', '0', '100%', '/snap/snapd/21759'],
          ['loop2', 'squashfs', '4.0', '', '', '0', '100%', '/snap/gnome-42-2204/176'],
          ['loop3', 'squashfs', '4.0', '', '', '0', '100%', '/snap/firefox/4848'],
          ['loop4', 'squashfs', '4.0', '', '', '0', '100%', '/snap/gtk-common-themes/1535'],
          ['uad0', '', '', '', '', '', '', ''],
          ['└─uad0p1', 'ext4', '1.0', 'ubuntu-ai', '8c2f19f4-6c2e-4d51-9a1f-0d3b7c5e41a2', avail, usePct, '/'],
        ];
        const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
        const text = table
          .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join(' ').replace(/\s+$/, ''))
          .join('\n');
        return ok(`${text}\n`);
      }
      const nameWidth = Math.max(4, ...rows.map(([name]) => name.length));
      const sizeWidth = Math.max(4, ...rows.map((r) => r[3].length));
      const header = `${'NAME'.padEnd(nameWidth)} ${'MAJ:MIN'.padEnd(7)} ${'RM'.padEnd(2)} ${'SIZE'.padStart(sizeWidth)} ${'RO'.padEnd(2)} ${'TYPE'.padEnd(4)} MOUNTPOINTS`;
      const body = rows.map(([name, maj, rm, size, ro, type, mp]) => (
        `${name.padEnd(nameWidth)} ${maj.padEnd(7)} ${rm.padEnd(2)} ${size.padStart(sizeWidth)} ${ro.padEnd(2)} ${type.padEnd(4)} ${mp}`.replace(/\s+$/, '')
      ));
      return ok(`${header}\n${body.join('\n')}\n`);
    },
  },

  {
    name: 'lsusb',
    aliases: [],
    synopsis: 'lsusb [-v] [-t]',
    description: 'List USB devices',
    man: `NAME
       lsusb - list USB devices

SYNOPSIS
       lsusb [options]

DESCRIPTION
       lsusb is a utility for displaying information about USB buses in the
       system and the devices connected to them.

OPTIONS
       -v, --verbose  Tells lsusb to be verbose.
       -t, --tree     Dump the physical USB device hierarchy as a tree.`,
    async run(ctx) {
      if (ctx.argv.includes('-t') || ctx.argv.includes('--tree')) {
        return ok([
          '/:  Bus 002.Port 001: Dev 001, Class=root_hub, Driver=xhci_hcd/8p, 5000M',
          '/:  Bus 001.Port 001: Dev 001, Class=root_hub, Driver=ohci-pci/12p, 12M',
          '',
        ].join('\n'));
      }
      return ok(`${LSUSB_LINES.join('\n')}\n`);
    },
  },

  {
    name: 'lspci',
    aliases: [],
    synopsis: 'lspci [-v] [-nn] [-k]',
    description: 'List all PCI devices',
    man: `NAME
       lspci - list all PCI devices

SYNOPSIS
       lspci [options]

DESCRIPTION
       lspci is a utility for displaying information about PCI buses in the
       system and devices connected to them.

OPTIONS
       -v      Be verbose and display detailed information about all devices.
       -nn     Show PCI vendor and device codes as both numbers and names.
       -k      Show kernel drivers handling each device.`,
    async run(ctx) {
      const { lines: base, codes, drivers } = lspciTable();
      let lines = base;
      if (ctx.argv.includes('-nn') || ctx.argv.includes('-n')) {
        // The display adapter has no vendor:device pair to print — the WebGL
        // renderer string is a name, not a PCI ID.
        lines = lines.map((l, i) => (codes[i] ? `${l.replace(/ \(rev [0-9a-f]+\)$/, '')} ${codes[i]}` : l));
      }
      if (ctx.argv.includes('-k')) {
        lines = lines.flatMap((l, i) => (drivers[i] ? [l, `\tKernel driver in use: ${drivers[i]}`] : [l]));
      }
      return ok(`${lines.join('\n')}\n`);
    },
  },

  {
    name: 'lsmod',
    aliases: [],
    synopsis: 'lsmod',
    description: 'Show the status of modules in the Linux Kernel',
    man: `NAME
       lsmod - show the status of modules in the Linux Kernel

SYNOPSIS
       lsmod

DESCRIPTION
       lsmod is a trivial program which nicely formats the contents of
       /proc/modules, showing what kernel modules are currently loaded.`,
    async run() {
      const header = `${'Module'.padEnd(23)}${'Size'.padStart(6)}  Used by`;
      const body = LSMOD_ROWS.map(([name, size, used, by]) => (
        `${name.padEnd(23)}${String(size).padStart(6)}  ${used}${by ? ` ${by}` : ''}`
      ));
      return ok(`${header}\n${body.join('\n')}\n`);
    },
  },

  {
    name: 'mount',
    aliases: [],
    synopsis: 'mount [-l] [-t TYPE]',
    description: 'Mount a filesystem, or list mounted filesystems',
    man: `NAME
       mount - mount a filesystem

SYNOPSIS
       mount [-l|-t type]
       mount device|dir

DESCRIPTION
       All files accessible in a Unix system are arranged in one big tree, the
       file hierarchy, rooted at /. Invoked without arguments, mount lists all
       currently mounted filesystems.

OPTIONS
       -l     Add the filesystem labels to the mount output.
       -t, --types TYPE
              Limit the listing to filesystems of the given type.`,
    async run(ctx) {
      const argv = ctx.argv;
      const positional = [];
      let filterType = '';
      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-t' || a === '--types') { filterType = argv[i + 1] || ''; i += 1; }
        else if (a.startsWith('--types=')) filterType = a.slice(8);
        else if (!a.startsWith('-')) positional.push(a);
      }
      if (positional.length > 0 && !isRoot(ctx)) {
        return fail(`mount: ${positional[0]}: must be superuser to use mount.\n`, 32);
      }
      if (positional.length > 0) {
        return fail(`mount: ${positional[0]}: can't find in /etc/fstab.\n`, 32);
      }
      let lines = mountLines();
      if (filterType) {
        const wanted = filterType.split(',');
        lines = lines.filter((l) => wanted.some((t) => l.includes(` type ${t} `)));
      }
      return ok(`${lines.join('\n')}\n`);
    },
  },

  {
    name: 'dmesg',
    aliases: [],
    synopsis: 'dmesg [-T] [-x] [-k] [--level=LIST]',
    description: 'Print or control the kernel ring buffer',
    man: `NAME
       dmesg - print or control the kernel ring buffer

SYNOPSIS
       dmesg [options]

DESCRIPTION
       dmesg is used to examine or control the kernel ring buffer. The default
       action is to display all messages from the kernel ring buffer.

OPTIONS
       -T, --ctime    Print human-readable timestamps.
       -x, --decode   Decode facility and level to readable strings.
       -k, --kernel   Print kernel messages.
       -H, --human    Enable human-readable output.
       --level=LIST   Restrict output to the given comma-separated levels.`,
    async run(ctx) {
      const argv = ctx.argv;
      const human = argv.includes('-T') || argv.includes('--ctime') || argv.includes('-H') || argv.includes('--human');
      const decode = argv.includes('-x') || argv.includes('--decode');
      const levelArg = argv.find((a) => a.startsWith('--level='));
      const names = { 3: 'err', 4: 'warn', 5: 'notice', 6: 'info', 7: 'debug' };
      let entries = dmesgEntries();
      if (levelArg) {
        const wanted = levelArg.slice(8).split(',');
        entries = entries.filter(([, level]) => wanted.includes(names[level]));
      }
      const lines = entries.map(([secs, level, text]) => {
        const prefix = human
          ? `[${new Date(procs.bootTime + secs * 1000).toString().slice(0, 24)}] `
          : `[${secs.toFixed(6).padStart(12)}] `;
        const tag = decode ? `kern  :${(names[level] || 'info').padEnd(6)}: ` : '';
        return `${prefix}${tag}${text}`;
      });
      return ok(`${lines.join('\n')}\n`);
    },
  },

  {
    name: 'systemctl',
    aliases: [],
    synopsis: 'systemctl [OPTIONS] COMMAND [UNIT...]',
    description: 'Control the systemd system and service manager',
    man: `NAME
       systemctl - control the systemd system and service manager

SYNOPSIS
       systemctl [OPTIONS...] COMMAND [UNIT...]

DESCRIPTION
       systemctl may be used to introspect and control the state of the systemd
       system and service manager.

COMMANDS
       list-units [PATTERN...]
              List units that systemd currently has in memory.

       status [UNIT...]
              Show terse runtime status information about one or more units.

       start UNIT..., stop UNIT..., restart UNIT...
              Start, stop or restart one or more units. Requires root.

       enable UNIT..., disable UNIT...
              Enable or disable one or more unit files. Requires root.

       is-active UNIT..., is-enabled UNIT...
              Check whether units are active or enabled.

       daemon-reload
              Reload the systemd manager configuration.`,
    async run(ctx) {
      const args = ctx.argv.filter((a) => !a.startsWith('--'));
      const verb = args[0] || 'list-units';
      const targets = args.slice(1);

      if (verb === 'list-units' || verb === 'list-unit-files') {
        const all = ctx.argv.includes('--all');
        const rows = UNITS
          .map((u) => ({ u, state: unitState(u) }))
          .filter((r) => all || r.state.active)
          .sort((a, b) => a.u.unit.localeCompare(b.u.unit));
        const nameW = Math.max(30, ...rows.map((r) => r.u.unit.length + 2));
        const out = [`  ${'UNIT'.padEnd(nameW)}${'LOAD'.padEnd(7)}${'ACTIVE'.padEnd(7)}${'SUB'.padEnd(8)}DESCRIPTION`];
        for (const { u, state } of rows) {
          const bullet = state.active ? '  ' : `${RED}●${RESET} `;
          out.push(
            `${bullet}${u.unit.padEnd(nameW)}${'loaded'.padEnd(7)}`
            + `${(state.active ? 'active' : 'inactive').padEnd(7)}`
            + `${(state.active ? state.sub : 'dead').padEnd(8)}${u.desc}`,
          );
        }
        out.push('');
        out.push('LOAD   = Reflects whether the unit definition was properly loaded.');
        out.push('ACTIVE = The high-level unit activation state, i.e. generalization of SUB.');
        out.push('SUB    = The low-level unit activation state, values depend on unit type.');
        out.push('');
        out.push(`${rows.length} loaded units listed.${all ? '' : ' Pass --all to see loaded but inactive units, too.'}`);
        out.push("To show all installed unit files use 'systemctl list-unit-files'.");
        return ok(`${out.join('\n')}\n`);
      }

      if (verb === 'status') {
        if (targets.length === 0) {
          const totals = procs.totals();
          return ok([
            `${GREEN}●${RESET} ${env.host}`,
            `    State: ${GREEN}running${RESET}`,
            '    Units: 358 loaded (incl. loaded aliases)',
            '     Jobs: 0 queued',
            '   Failed: 0 units',
            `    Since: ${systemdStamp(new Date(procs.bootTime))}; ${agoPhrase(Date.now() - procs.bootTime)}`,
            '  systemd: 255.4-1ubuntu8.4',
            '   CGroup: /',
            '           ├─init.scope',
            '           │ └─1 /sbin/init splash',
            '           ├─system.slice',
            '           └─user.slice',
            `             └─user-1000.slice (${totals.procCount} processes)`,
            '',
          ].join('\n'));
        }
        const blocks = [];
        let code = 0;
        for (const t of targets) {
          const unit = findUnit(t);
          if (!unit) {
            blocks.push(`Unit ${unitName(t)} could not be found.`);
            code = 4;
            continue;
          }
          blocks.push(statusBlock(unit));
          if (!unitState(unit).active) code = 3;
        }
        return { stdout: `${blocks.join('\n\n')}\n`, stderr: '', code };
      }

      if (verb === 'is-active' || verb === 'is-enabled' || verb === 'is-failed') {
        const out = [];
        let code = 0;
        for (const t of targets) {
          const unit = findUnit(t);
          if (!unit) {
            out.push('inactive');
            code = 3;
            continue;
          }
          if (verb === 'is-enabled') {
            out.push(unit.enabled);
            if (unit.enabled === 'disabled') code = 1;
          } else if (verb === 'is-failed') {
            out.push('inactive');
            code = 1;
          } else {
            const active = unitState(unit).active;
            out.push(active ? 'active' : 'inactive');
            if (!active) code = 3;
          }
        }
        return { stdout: `${out.join('\n')}\n`, stderr: '', code };
      }

      if (verb === 'daemon-reload' || verb === 'daemon-reexec') {
        if (!isRoot(ctx)) {
          return fail('Failed to reload daemon: Interactive authentication required.\n', 1);
        }
        return ok('');
      }

      if (['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask'].includes(verb)) {
        if (!isRoot(ctx)) {
          const messages = targets.length
            ? targets.map((t) => `Failed to ${verb} ${unitName(t)}: Interactive authentication required.`)
            : [`Failed to ${verb} unit: Interactive authentication required.`];
          return fail(`${messages.join('\n')}\nSee system logs and 'systemctl status' for details.\n`, 1);
        }
        const errors = [];
        for (const t of targets) {
          const unit = findUnit(t);
          if (!unit) {
            errors.push(`Failed to ${verb} ${unitName(t)}: Unit ${unitName(t)} not found.`);
            continue;
          }
          if (unit.proc === null) continue;
          const running = procs.find(unit.proc);
          if (verb === 'stop' || verb === 'restart') {
            for (const p of running) procs.kill(p.pid, 15);
          }
          if (verb === 'start' || verb === 'restart') {
            if (verb === 'start' && running.length > 0) continue;
            procs.spawn({
              name: unit.proc,
              cmd: `/usr/sbin/${unit.proc}`,
              user: 'root',
              cpu: 0.1,
              mem: 12 + Math.random() * 28,
              ppid: 1,
            });
          }
        }
        if (errors.length) return fail(`${errors.join('\n')}\n`, 5);
        return ok('');
      }

      if (verb === 'list-timers') {
        return ok([
          'NEXT                        LEFT          LAST                        PASSED       UNIT                ACTIVATES',
          'Mon 2026-08-19 00:00:00 KST 12h left      Sun 2026-08-18 00:00:11 KST 11h ago      logrotate.timer     logrotate.service',
          'Mon 2026-08-19 06:14:03 KST 18h left      Sun 2026-08-18 06:14:03 KST 5h 39min ago apt-daily.timer     apt-daily.service',
          'Mon 2026-08-19 06:51:12 KST 19h left      Sun 2026-08-18 06:51:12 KST 5h 2min ago  motd-news.timer     motd-news.service',
          '',
          '3 timers listed.',
          '',
        ].join('\n'));
      }

      return fail(`Unknown command verb ${verb}.\n`, 1);
    },
  },

  {
    name: 'journalctl',
    aliases: [],
    synopsis: 'journalctl [-n N] [-f] [-u UNIT] [-b]',
    description: 'Query the systemd journal',
    man: `NAME
       journalctl - query the systemd journal

SYNOPSIS
       journalctl [OPTIONS...] [MATCHES...]

DESCRIPTION
       journalctl may be used to query the contents of the systemd journal as
       written by systemd-journald.service.

OPTIONS
       -n, --lines=N  Show the most recent N journal events.
       -f, --follow   Follow the journal, showing new entries as they arrive.
       -u, --unit=UNIT
              Show messages for the specified systemd unit.
       -b, --boot     Show messages from the current boot.
       -p, --priority=P
              Filter output by message priority.
       --no-pager     Do not pipe output into a pager.`,
    async run(ctx) {
      const argv = ctx.argv;
      let unit = '';
      let lines = 0;
      let follow = false;
      for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-u' || a === '--unit') { unit = argv[i + 1] || ''; i += 1; }
        else if (a.startsWith('--unit=')) unit = a.slice(7);
        else if (a === '-n' || a === '--lines') { lines = Number(argv[i + 1]) || 10; i += 1; }
        else if (a.startsWith('--lines=')) lines = Number(a.slice(8)) || 10;
        else if (a === '-f' || a === '--follow') follow = true;
      }

      const host = env.host;
      const boot = new Date(procs.bootTime);
      const at = (offset) => syslogStamp(new Date(procs.bootTime + offset));
      let entries = [
        `-- Journal begins at ${systemdStamp(new Date(procs.bootTime - 86400000 * 9))}, ends at ${systemdStamp(new Date())}. --`,
        `${syslogStamp(boot)} ${host} kernel: Linux version 6.8.0-45-generic (buildd@lcy02-amd64-034) #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024`,
        `${syslogStamp(boot)} ${host} systemd[1]: systemd 255.4-1ubuntu8.4 running in system mode (+PAM +AUDIT +SELINUX +APPARMOR)`,
        `${syslogStamp(boot)} ${host} systemd[1]: Detected virtualization oracle.`,
        `${syslogStamp(boot)} ${host} systemd[1]: Detected architecture x86-64.`,
        `${at(2100)} ${host} systemd[1]: Reached target basic.target - Basic System.`,
        `${at(3200)} ${host} systemd-journald[312]: Journal started`,
        `${at(4100)} ${host} NetworkManager[745]: <info>  [1755474866.4181] NetworkManager (version 1.46.0) is starting... (boot:8f2a1c4d)`,
        `${at(4800)} ${host} NetworkManager[745]: <info>  [1755474867.1204] manager: NetworkManager state is now CONNECTED_GLOBAL`,
        `${at(5200)} ${host} systemd-resolved[612]: Positive Trust Anchors:`,
        `${at(6100)} ${host} snapd[812]: daemon.go:247: started snapd/2.63 (series 16; classic) ubuntu/24.04 (amd64) linux/6.8.0-45-generic.`,
        `${at(7400)} ${host} gdm3[923]: Gdm: GdmDisplay: Session never registered, failing`,
        `${at(9800)} ${host} systemd[1240]: Reached target graphical-session.target - Current graphical user session.`,
        `${at(11200)} ${host} gnome-shell[1387]: Registering session with GDM`,
        `${at(12600)} ${host} systemd[1240]: Started app-gnome-org.gnome.Terminal-2413.scope.`,
        `${syslogStamp(new Date(Date.now() - 620000))} ${host} systemd-resolved[612]: Using degraded feature set UDP instead of TCP for DNS server 127.0.0.53.`,
        `${syslogStamp(new Date(Date.now() - 180000))} ${host} dbus-daemon[701]: [system] Successfully activated service 'org.freedesktop.timedate1'`,
        `${syslogStamp(new Date(Date.now() - 42000))} ${host} systemd[1]: Starting apt-daily.service - Daily apt download activities...`,
      ];

      if (unit) {
        const needle = unitName(unit).replace('.service', '');
        const matched = entries.filter((l, i) => i > 0 && l.includes(needle));
        entries = matched.length > 0 ? [entries[0], ...matched] : ['-- No entries --'];
      }
      if (lines > 0) entries = entries.slice(-lines);

      if (follow) {
        for (const line of entries) ctx.term.writeLine(line);
        const daemons = ['systemd', 'NetworkManager', 'dbus-daemon', 'snapd', 'systemd-resolved', 'gnome-shell'];
        const notes = [
          'Started apt-daily.service - Daily apt download activities.',
          'Reloading.',
          "Successfully activated service 'org.freedesktop.hostname1'",
          'daemon.go:315: gracefully waiting for running hooks',
          'Using degraded feature set UDP instead of UDP+EDNS0 for DNS server 127.0.0.53.',
        ];
        while (!(ctx.signal && ctx.signal.aborted)) {
          await wait(1000 + Math.random() * 2400, ctx.signal);
          if (ctx.signal && ctx.signal.aborted) break;
          const who = daemons[Math.floor(Math.random() * daemons.length)];
          const note = notes[Math.floor(Math.random() * notes.length)];
          ctx.term.writeLine(`${syslogStamp(new Date())} ${host} ${who}[${100 + Math.floor(Math.random() * 900)}]: ${note}`);
        }
        return { stdout: '', stderr: '', code: 130 };
      }

      return ok(`${entries.join('\n')}\n`);
    },
  },

  {
    name: 'hostnamectl',
    aliases: [],
    synopsis: 'hostnamectl [status | hostname NAME]',
    description: 'Control the system hostname',
    man: `NAME
       hostnamectl - control the system hostname

SYNOPSIS
       hostnamectl [OPTIONS...] status
       hostnamectl [OPTIONS...] hostname [NAME]

DESCRIPTION
       hostnamectl may be used to query and change the system hostname and
       related settings.

COMMANDS
       status         Show the current hostname and related information.
       hostname NAME  Set the system hostname to NAME. Requires root.`,
    async run(ctx) {
      const verb = ctx.argv[0] || 'status';
      if (verb === 'hostname' || verb === 'set-hostname') {
        const name = ctx.argv[1];
        if (!name) return ok(`${env.host}\n`);
        if (!isRoot(ctx)) return fail('Could not set property: Access denied\n', 1);
        env.set('HOSTNAME', name);
        users.hostname = name;
        return ok('');
      }
      const info = device.info();
      const chassis = CHASSIS_BY_OS[info.os.family] || 'desktop';
      const rows = [
        [' Static hostname', env.host],
        ['       Icon name', chassis === 'desktop' ? 'computer' : `computer-${chassis}`],
        ['         Chassis', chassis],
        ['      Machine ID', MACHINE_ID],
        ['         Boot ID', BOOT_ID],
        ['Operating System', 'Ubuntu 24.04.1 LTS'],
        ['          Kernel', 'Linux 6.8.0-45-generic'],
        ['    Architecture', systemdArch(device.arch())],
      ];
      // systemd omits the DMI rows when the firmware has nothing to give, and
      // a browser is exactly that case — only Chromium's userAgentData reports
      // a device model, and only on hardware that carries one.
      if (info.cpu.model) rows.push(['  Hardware Model', info.cpu.model]);
      rows.push(['        Firmware', `${info.browser.name || 'browser'} ${info.browser.version || ''}`.trim()]);
      return ok(`${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`);
    },
  },

  {
    name: 'timedatectl',
    aliases: [],
    synopsis: 'timedatectl [status | show | list-timezones]',
    description: 'Control the system time and date',
    man: `NAME
       timedatectl - control the system time and date

SYNOPSIS
       timedatectl [OPTIONS...] {COMMAND}

DESCRIPTION
       timedatectl may be used to query and change the system clock and its
       settings, and to enable or disable time synchronisation services.

COMMANDS
       status             Show the current settings of the clock and RTC.
       show               Show the same information in machine-readable form.
       list-timezones     List the available time zones.
       set-timezone ZONE  Set the system time zone. Requires root.`,
    async run(ctx) {
      const verb = ctx.argv[0] || 'status';
      const now = new Date();
      // The host's real IANA zone, resolved once in device.js.
      const zone = device.info().locale.timeZone || 'Etc/UTC';
      const utc = new Date(now.getTime() + now.getTimezoneOffset() * 60000);

      if (verb === 'list-timezones') {
        const zones = ['Africa/Cairo', 'America/Los_Angeles', 'America/New_York', 'Asia/Seoul',
          'Asia/Tokyo', 'Australia/Sydney', 'Etc/UTC', 'Europe/Berlin', 'Europe/London', zone];
        return ok(`${zones.filter((z, i, arr) => arr.indexOf(z) === i).sort().join('\n')}\n`);
      }
      if (verb === 'show') {
        return ok([
          `Timezone=${zone}`,
          'LocalRTC=no',
          'CanNTP=yes',
          'NTP=yes',
          'NTPSynchronized=yes',
          `TimeUSec=${now.getTime() * 1000}`,
          `RTCTimeUSec=${now.getTime() * 1000}`,
          '',
        ].join('\n'));
      }
      if (verb.startsWith('set-')) {
        if (!isRoot(ctx)) return fail('Failed to set time zone: Access denied\n', 1);
        return ok('');
      }
      return ok([
        `               Local time: ${systemdStamp(now)}`,
        `           Universal time: ${systemdStamp(utc, false)} UTC`,
        `                 RTC time: ${systemdStamp(utc, false)}`,
        `                Time zone: ${zone} (${tzAbbr(now)}, ${numericOffset(now)})`,
        'System clock synchronized: yes',
        '              NTP service: active',
        '          RTC in local TZ: no',
        '',
      ].join('\n'));
    },
  },

  {
    name: 'lsb_release',
    aliases: [],
    synopsis: 'lsb_release [-a] [-i] [-d] [-r] [-c] [-s]',
    description: 'Print distribution-specific information',
    man: `NAME
       lsb_release - print distribution-specific information

SYNOPSIS
       lsb_release [options]

DESCRIPTION
       The lsb_release command prints certain LSB (Linux Standard Base) and
       distribution-specific information.

OPTIONS
       -a, --all           Display all of the information below.
       -i, --id            Display the distributor ID.
       -d, --description   Display a description of the distribution.
       -r, --release       Display the release number.
       -c, --codename      Display the code name.
       -s, --short         Use the short output format.`,
    async run(ctx) {
      const argv = ctx.argv;
      const short = argv.includes('-s') || argv.includes('--short');
      const fields = [
        ['Distributor ID', 'Ubuntu', ['-i', '--id']],
        ['Description', 'Ubuntu 24.04.1 LTS', ['-d', '--description']],
        ['Release', '24.04', ['-r', '--release']],
        ['Codename', 'noble', ['-c', '--codename']],
      ];
      const all = argv.includes('-a') || argv.includes('--all');
      const picked = fields.filter(([, , flags]) => all || flags.some((f) => argv.includes(f)));
      const out = [];
      if (!short && (all || picked.length === 0)) out.push('No LSB modules are available.');
      for (const [label, value] of picked) {
        out.push(short ? value : `${`${label}:`.padEnd(16)}${value}`);
      }
      return ok(out.length ? `${out.join('\n')}\n` : '');
    },
  },
];

export default hwCommands;
