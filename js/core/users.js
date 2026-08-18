/**
 * js/core/users.js — account database (ARCHITECTURE §8).
 *
 * Mirrors a stock Ubuntu 24.04.1 LTS desktop install: the Debian base system
 * accounts, the systemd/dbus/gdm service accounts, and one human user
 * `ubuntu` at uid 1000 in the `sudo` group.
 */

import { bus } from './bus.js';

/** sudo remembers your password for 15 minutes by default (timestamp_timeout). */
const SUDO_TIMEOUT_MS = 15 * 60 * 1000;
const SUDO_PASSWORD = 'ubuntu';

/**
 * Ordered exactly as `/etc/passwd` is written by the Ubuntu installer.
 * @type {{name:string, uid:number, gid:number, gecos:string, home:string, shell:string}[]}
 */
const PASSWD = [
  { name: 'root', uid: 0, gid: 0, gecos: 'root', home: '/root', shell: '/bin/bash' },
  { name: 'daemon', uid: 1, gid: 1, gecos: 'daemon', home: '/usr/sbin', shell: '/usr/sbin/nologin' },
  { name: 'bin', uid: 2, gid: 2, gecos: 'bin', home: '/bin', shell: '/usr/sbin/nologin' },
  { name: 'sys', uid: 3, gid: 3, gecos: 'sys', home: '/dev', shell: '/usr/sbin/nologin' },
  { name: 'sync', uid: 4, gid: 65534, gecos: 'sync', home: '/bin', shell: '/bin/sync' },
  { name: 'games', uid: 5, gid: 60, gecos: 'games', home: '/usr/games', shell: '/usr/sbin/nologin' },
  { name: 'man', uid: 6, gid: 12, gecos: 'man', home: '/var/cache/man', shell: '/usr/sbin/nologin' },
  { name: 'lp', uid: 7, gid: 7, gecos: 'lp', home: '/var/spool/lpd', shell: '/usr/sbin/nologin' },
  { name: 'mail', uid: 8, gid: 8, gecos: 'mail', home: '/var/mail', shell: '/usr/sbin/nologin' },
  { name: 'news', uid: 9, gid: 9, gecos: 'news', home: '/var/spool/news', shell: '/usr/sbin/nologin' },
  { name: 'uucp', uid: 10, gid: 10, gecos: 'uucp', home: '/var/spool/uucp', shell: '/usr/sbin/nologin' },
  { name: 'proxy', uid: 13, gid: 13, gecos: 'proxy', home: '/bin', shell: '/usr/sbin/nologin' },
  { name: 'www-data', uid: 33, gid: 33, gecos: 'www-data', home: '/var/www', shell: '/usr/sbin/nologin' },
  { name: 'backup', uid: 34, gid: 34, gecos: 'backup', home: '/var/backups', shell: '/usr/sbin/nologin' },
  { name: 'list', uid: 38, gid: 38, gecos: 'Mailing List Manager', home: '/var/list', shell: '/usr/sbin/nologin' },
  { name: 'irc', uid: 39, gid: 39, gecos: 'ircd', home: '/run/ircd', shell: '/usr/sbin/nologin' },
  { name: '_apt', uid: 42, gid: 65534, gecos: '', home: '/nonexistent', shell: '/usr/sbin/nologin' },
  { name: 'nobody', uid: 65534, gid: 65534, gecos: 'nobody', home: '/nonexistent', shell: '/usr/sbin/nologin' },
  { name: 'systemd-network', uid: 998, gid: 998, gecos: 'systemd Network Management', home: '/', shell: '/usr/sbin/nologin' },
  { name: 'systemd-resolve', uid: 997, gid: 997, gecos: 'systemd Resolver', home: '/', shell: '/usr/sbin/nologin' },
  { name: 'messagebus', uid: 100, gid: 107, gecos: '', home: '/nonexistent', shell: '/usr/sbin/nologin' },
  { name: 'syslog', uid: 101, gid: 104, gecos: '', home: '/nonexistent', shell: '/usr/sbin/nologin' },
  { name: 'uuidd', uid: 102, gid: 108, gecos: '', home: '/run/uuidd', shell: '/usr/sbin/nologin' },
  { name: 'gdm', uid: 117, gid: 123, gecos: 'Gnome Display Manager', home: '/var/lib/gdm3', shell: '/bin/false' },
  { name: 'ubuntu', uid: 1000, gid: 1000, gecos: 'Ubuntu User,,,', home: '/home/ubuntu', shell: '/bin/bash' },
];

/**
 * Ordered exactly as `/etc/group` is written by the Ubuntu installer.
 * @type {{name:string, gid:number, members:string[]}[]}
 */
const GROUPS = [
  { name: 'root', gid: 0, members: [] },
  { name: 'daemon', gid: 1, members: [] },
  { name: 'bin', gid: 2, members: [] },
  { name: 'sys', gid: 3, members: [] },
  { name: 'adm', gid: 4, members: ['syslog', 'ubuntu'] },
  { name: 'tty', gid: 5, members: [] },
  { name: 'disk', gid: 6, members: [] },
  { name: 'lp', gid: 7, members: [] },
  { name: 'mail', gid: 8, members: [] },
  { name: 'news', gid: 9, members: [] },
  { name: 'uucp', gid: 10, members: [] },
  { name: 'man', gid: 12, members: [] },
  { name: 'proxy', gid: 13, members: [] },
  { name: 'kmem', gid: 15, members: [] },
  { name: 'dialout', gid: 20, members: [] },
  { name: 'fax', gid: 21, members: [] },
  { name: 'voice', gid: 22, members: [] },
  { name: 'cdrom', gid: 24, members: ['ubuntu'] },
  { name: 'floppy', gid: 25, members: [] },
  { name: 'tape', gid: 26, members: [] },
  { name: 'sudo', gid: 27, members: ['ubuntu'] },
  { name: 'audio', gid: 29, members: [] },
  { name: 'dip', gid: 30, members: ['ubuntu'] },
  { name: 'www-data', gid: 33, members: [] },
  { name: 'backup', gid: 34, members: [] },
  { name: 'operator', gid: 37, members: [] },
  { name: 'list', gid: 38, members: [] },
  { name: 'irc', gid: 39, members: [] },
  { name: 'src', gid: 40, members: [] },
  { name: 'shadow', gid: 42, members: [] },
  { name: 'utmp', gid: 43, members: [] },
  { name: 'video', gid: 44, members: [] },
  { name: 'sasl', gid: 45, members: [] },
  { name: 'plugdev', gid: 46, members: ['ubuntu'] },
  { name: 'staff', gid: 50, members: [] },
  { name: 'games', gid: 60, members: [] },
  { name: 'users', gid: 100, members: [] },
  { name: 'nogroup', gid: 65534, members: [] },
  { name: 'systemd-journal', gid: 999, members: [] },
  { name: 'systemd-network', gid: 998, members: [] },
  { name: 'systemd-resolve', gid: 997, members: [] },
  { name: 'crontab', gid: 101, members: [] },
  { name: 'messagebus', gid: 107, members: [] },
  { name: 'syslog', gid: 104, members: [] },
  { name: 'uuidd', gid: 108, members: [] },
  { name: 'ssh', gid: 109, members: [] },
  { name: 'lpadmin', gid: 110, members: ['ubuntu'] },
  { name: 'netdev', gid: 111, members: [] },
  { name: 'rdma', gid: 112, members: [] },
  { name: 'gdm', gid: 123, members: [] },
  { name: 'ubuntu', gid: 1000, members: [] },
];

let sudoUnlockedAt = 0;

function sudoStillValid() {
  return sudoUnlockedAt > 0 && Date.now() - sudoUnlockedAt < SUDO_TIMEOUT_MS;
}

export const users = {
  /** The logged-in human user. */
  current: {
    name: 'ubuntu',
    uid: 1000,
    gid: 1000,
    gecos: 'Ubuntu User',
    home: '/home/ubuntu',
    shell: '/bin/bash',
  },

  hostname: 'ubuntu-ai',

  /** True while the sudo timestamp is still inside its 15 minute window. */
  get sudoUnlocked() {
    if (!sudoStillValid()) {
      sudoUnlockedAt = 0;
      return false;
    }
    return true;
  },

  /**
   * Validate the sudo password and (re)start the 15 minute timestamp.
   * @param {string} password
   * @returns {boolean}
   */
  unlockSudo(password) {
    if (password === SUDO_PASSWORD) {
      sudoUnlockedAt = Date.now();
      bus.emit('settings:change', { key: 'sudo', value: true });
      return true;
    }
    return false;
  },

  /** Forget the sudo timestamp (`sudo -k`). */
  lockSudo() {
    sudoUnlockedAt = 0;
  },

  /** Milliseconds remaining on the sudo timestamp, 0 when locked. */
  sudoRemaining() {
    if (!sudoStillValid()) return 0;
    return SUDO_TIMEOUT_MS - (Date.now() - sudoUnlockedAt);
  },

  /** @returns {string} full `/etc/passwd` contents, newline terminated */
  passwdFile() {
    return `${PASSWD.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`).join('\n')}\n`;
  },

  /** @returns {string} full `/etc/group` contents, newline terminated */
  groupFile() {
    return `${GROUPS.map((g) => `${g.name}:x:${g.gid}:${g.members.join(',')}`).join('\n')}\n`;
  },

  /** @returns {string} `/etc/shadow`-style stub — no real hashes are stored. */
  shadowFile() {
    const day = Math.floor(Date.now() / 86400000);
    return `${PASSWD.map((u) => {
      const pw = u.uid === 0 ? '!' : u.uid >= 1000 && u.uid < 65534 ? '$y$j9T$' : '*';
      return `${u.name}:${pw}:${day}:0:99999:7:::`;
    }).join('\n')}\n`;
  },

  /** @returns {ReadonlyArray<object>} every passwd entry (copies) */
  list() {
    return PASSWD.map((u) => ({ ...u }));
  },

  /** @returns {ReadonlyArray<object>} every group entry (copies) */
  groups() {
    return GROUPS.map((g) => ({ ...g, members: g.members.slice() }));
  },

  /**
   * @param {string|number} nameOrUid
   * @returns {object|null}
   */
  lookup(nameOrUid) {
    const found =
      typeof nameOrUid === 'number'
        ? PASSWD.find((u) => u.uid === nameOrUid)
        : PASSWD.find((u) => u.name === nameOrUid);
    return found ? { ...found } : null;
  },

  /**
   * @param {string|number} nameOrGid
   * @returns {object|null}
   */
  lookupGroup(nameOrGid) {
    const found =
      typeof nameOrGid === 'number'
        ? GROUPS.find((g) => g.gid === nameOrGid)
        : GROUPS.find((g) => g.name === nameOrGid);
    return found ? { ...found, members: found.members.slice() } : null;
  },

  /**
   * Every group a user belongs to, primary first — backs `id` and `groups`.
   * @param {string} [name]
   * @returns {{name:string, gid:number}[]}
   */
  groupsOf(name = users.current.name) {
    const user = PASSWD.find((u) => u.name === name);
    if (!user) return [];
    const out = [];
    const primary = GROUPS.find((g) => g.gid === user.gid);
    if (primary) out.push({ name: primary.name, gid: primary.gid });
    for (const g of GROUPS) {
      if (g.gid === user.gid) continue;
      if (g.members.includes(name)) out.push({ name: g.name, gid: g.gid });
    }
    return out;
  },
};
