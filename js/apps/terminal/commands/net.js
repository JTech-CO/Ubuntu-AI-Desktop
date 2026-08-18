/**
 * js/apps/terminal/commands/net.js — networking commands.
 *
 * Everything here is **simulated**. No command in this module ever issues a
 * real request to an arbitrary host: `curl` and `wget` synthesise a response
 * locally, optionally asking Gemini (the one endpoint this project already
 * talks to) for a plausible body when the user has configured a key.
 *
 * Addresses, MACs, route tables and socket lists are one shared model so that
 * `ip`, `ifconfig`, `netstat`, `ss`, `route`, `arp` and `nmcli` never disagree
 * with each other — or with the daemons in js/core/procs.js.
 */

import { env } from '../../../core/env.js';
import { fs } from '../../../core/fs.js';
import { procs } from '../../../core/procs.js';
import { users } from '../../../core/users.js';
import {
  ok, fail, wait, aborted, pad0, MONTHS_SHORT, DAYS_SHORT, tzAbbr,
} from './util.js';

/* ------------------------------------------------------------------ *
 * The emulated host's network model
 * ------------------------------------------------------------------ */

/** The link-layer + IP configuration every tool in this file reports. */
export const IFACES = [
  {
    index: 1,
    name: 'lo',
    kind: 'loopback',
    mtu: 65536,
    qdisc: 'noqueue',
    state: 'UNKNOWN',
    operUp: true,
    flags: ['LOOPBACK', 'UP', 'LOWER_UP'],
    ifconfigFlags: { value: 73, names: ['UP', 'LOOPBACK', 'RUNNING'] },
    mac: '00:00:00:00:00:00',
    brd: '00:00:00:00:00:00',
    qlen: 1000,
    inet: { addr: '127.0.0.1', prefix: 8, netmask: '255.0.0.0', broadcast: null, scope: 'host', extra: 'lo' },
    inet6: { addr: '::1', prefix: 128, scope: 'host', scopeid: '0x10<host>', extra: 'noprefixroute' },
    rx: { packets: 4218, bytes: 412887 },
    tx: { packets: 4218, bytes: 412887 },
    netstatFlags: 'LRU',
    nmType: 'loopback',
    nmState: 'connected (externally)',
    nmConnection: 'lo',
  },
  {
    index: 2,
    name: 'enp0s3',
    kind: 'ether',
    mtu: 1500,
    qdisc: 'fq_codel',
    state: 'UP',
    operUp: true,
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    ifconfigFlags: { value: 4163, names: ['UP', 'BROADCAST', 'RUNNING', 'MULTICAST'] },
    mac: '08:00:27:4b:9c:1e',
    brd: 'ff:ff:ff:ff:ff:ff',
    qlen: 1000,
    inet: {
      addr: '192.168.1.42', prefix: 24, netmask: '255.255.255.0',
      broadcast: '192.168.1.255', scope: 'global', extra: 'dynamic noprefixroute enp0s3',
      lft: '84532sec',
    },
    inet6: { addr: 'fe80::a00:27ff:fe4b:9c1e', prefix: 64, scope: 'link', scopeid: '0x20<link>', extra: 'noprefixroute' },
    rx: { packets: 128437, bytes: 174829301 },
    tx: { packets: 74210, bytes: 8213944 },
    netstatFlags: 'BMRU',
    nmType: 'ethernet',
    nmState: 'connected',
    nmConnection: 'Wired connection 1',
  },
  {
    index: 3,
    name: 'docker0',
    kind: 'ether',
    mtu: 1500,
    qdisc: 'noqueue',
    state: 'DOWN',
    operUp: false,
    flags: ['NO-CARRIER', 'BROADCAST', 'MULTICAST', 'UP'],
    ifconfigFlags: { value: 4099, names: ['UP', 'BROADCAST', 'MULTICAST'] },
    mac: '02:42:8a:1f:c3:7d',
    brd: 'ff:ff:ff:ff:ff:ff',
    qlen: 0,
    inet: {
      addr: '172.17.0.1', prefix: 16, netmask: '255.255.0.0',
      broadcast: '172.17.255.255', scope: 'global', extra: 'docker0',
    },
    inet6: null,
    rx: { packets: 0, bytes: 0 },
    tx: { packets: 0, bytes: 0 },
    netstatFlags: 'BMU',
    nmType: 'bridge',
    nmState: 'connected (externally)',
    nmConnection: 'docker0',
  },
];

/** nmcli lists managed devices before the loopback. */
const NM_ORDER = ['enp0s3', 'docker0', 'lo'];

/** The default gateway. */
export const GATEWAY = '192.168.1.1';
/** systemd-resolved's stub listener, matching /etc/resolv.conf. */
export const NAMESERVER = '127.0.0.53';

/** The neighbour (ARP) cache. */
const NEIGHBOURS = [
  { ip: '192.168.1.1', mac: '3c:37:86:2b:1f:04', dev: 'enp0s3', state: 'REACHABLE', name: '_gateway' },
  { ip: '192.168.1.15', mac: 'b8:27:eb:9a:41:c2', dev: 'enp0s3', state: 'STALE', name: 'raspberrypi.lan' },
  { ip: '192.168.1.64', mac: '9c:2d:cd:41:07:b3', dev: 'enp0s3', state: 'STALE', name: 'printer.lan' },
];

/** Hostnames with a fixed answer, so repeated lookups never drift. */
const HOSTS = new Map(Object.entries({
  localhost: '127.0.0.1',
  'ubuntu-ai': '127.0.1.1',
  'ubuntu-ai.local': '192.168.1.42',
  '_gateway': GATEWAY,
  'archive.ubuntu.com': '185.125.190.36',
  'security.ubuntu.com': '185.125.190.81',
  'ports.ubuntu.com': '185.125.190.39',
  'changelogs.ubuntu.com': '91.189.91.48',
  'api.snapcraft.io': '185.125.188.58',
  'ubuntu.com': '185.125.190.21',
  'canonical.com': '185.125.190.29',
  'google.com': '142.250.196.110',
  'www.google.com': '142.250.196.100',
  'github.com': '140.82.121.4',
  'raw.githubusercontent.com': '185.199.108.133',
  'example.com': '93.184.216.34',
  'www.example.com': '93.184.216.34',
  'example.org': '93.184.216.34',
  'cloudflare.com': '104.16.132.229',
  'one.one.one.one': '1.1.1.1',
  'dns.google': '8.8.8.8',
  'debian.org': '151.101.66.132',
  'kernel.org': '139.178.84.217',
  'wikipedia.org': '208.80.154.224',
  'generativelanguage.googleapis.com': '142.250.196.106',
}));

/** TLDs a resolver in this emulator refuses, per RFC 2606 / 6761. */
const DEAD_TLDS = new Set(['invalid', 'test', 'localdomain', 'nope', 'example']);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * @param {string} value
 * @returns {boolean} true when `value` is a dotted-quad IPv4 literal
 */
export function isIpv4(value) {
  const m = IPV4_RE.exec(String(value));
  return Boolean(m) && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * FNV-1a, so every derived value (address, latency, hop count) is stable for
 * a given name across reloads.
 * @param {string} text
 * @returns {number} unsigned 32-bit
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Plausible first octets for a synthesised public address. */
const PUBLIC_PREFIXES = [23, 34, 52, 54, 64, 72, 88, 104, 128, 151, 162, 185, 199, 203, 213];

/**
 * Resolve a host to a stable address.
 * @param {string} host
 * @returns {{ip:string, canonical:string, literal:boolean}|null} null when the
 *          name does not resolve
 */
export function lookup(host) {
  const name = String(host).trim().replace(/\.$/, '');
  if (name === '') return null;
  if (isIpv4(name)) return { ip: name, canonical: name, literal: true };

  const known = HOSTS.get(name.toLowerCase());
  if (known) return { ip: known, canonical: name, literal: false };

  const labels = name.toLowerCase().split('.');
  const tld = labels[labels.length - 1];
  if (labels.length < 2) return null;
  if (DEAD_TLDS.has(tld)) return null;
  if (!/^[a-z][a-z0-9-]{1,}$/.test(tld)) return null;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return null;

  const h = fnv1a(name.toLowerCase());
  const a = PUBLIC_PREFIXES[h % PUBLIC_PREFIXES.length];
  const b = (h >>> 8) & 0xff;
  const c = (h >>> 16) & 0xff;
  const d = 1 + (((h >>> 24) & 0xff) % 254);
  return { ip: `${a}.${b}.${c}.${d}`, canonical: name, literal: false };
}

/**
 * Reverse lookup: a plausible PTR for an address we invented.
 * @param {string} ip
 * @returns {string|null}
 */
export function reverseLookup(ip) {
  for (const [name, addr] of HOSTS) {
    if (addr === ip) return name;
  }
  for (const n of NEIGHBOURS) {
    if (n.ip === ip) return n.name;
  }
  if (ip === '192.168.1.42') return 'ubuntu-ai.lan';
  if (ip.startsWith('127.')) return 'localhost';
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts.join('-')}.static.example-isp.net`;
}

/**
 * Latency profile for a destination: base round trip and TTL.
 * @param {string} ip
 * @returns {{base:number, ttl:number, hops:number}}
 */
export function latencyProfile(ip) {
  if (ip.startsWith('127.')) return { base: 0.032, ttl: 64, hops: 1 };
  if (ip.startsWith('192.168.') || ip.startsWith('172.17.') || ip.startsWith('10.')) {
    return { base: 0.42, ttl: 64, hops: 1 };
  }
  const h = fnv1a(ip);
  const hops = 6 + (h % 8);
  return { base: 6 + ((h >>> 5) % 90) / 2, ttl: 64 - hops + 55, hops };
}

/** Round to three decimals the way iputils prints its timings. */
function ms3(n) {
  return n.toFixed(3);
}

/* ------------------------------------------------------------------ *
 * Sockets (shared by netstat and ss)
 * ------------------------------------------------------------------ */

/**
 * pid/program for a daemon, taken live from the process table so the socket
 * list can never name a process that is not running.
 * @param {string} name
 * @returns {{pid:number, name:string}|null}
 */
function daemon(name) {
  const found = procs.find(name);
  if (!found || found.length === 0) return null;
  return { pid: found[0].pid, name: found[0].name };
}

/**
 * The emulated socket table.
 * @returns {object[]}
 */
export function sockets() {
  const resolved = daemon('systemd-resolved');
  const nm = daemon('NetworkManager');
  const avahi = daemon('avahi-daemon');
  const snapd = daemon('snapd');
  const cups = daemon('cupsd');

  const rows = [
    { proto: 'tcp', v6: false, local: '127.0.0.53:53', peer: '0.0.0.0:*', state: 'LISTEN', owner: resolved, ownerName: 'systemd-resolve' },
    { proto: 'tcp', v6: false, local: '127.0.0.54:53', peer: '0.0.0.0:*', state: 'LISTEN', owner: resolved, ownerName: 'systemd-resolve' },
    { proto: 'udp', v6: false, local: '127.0.0.53:53', peer: '0.0.0.0:*', state: '', owner: resolved, ownerName: 'systemd-resolve' },
    { proto: 'udp', v6: false, local: '127.0.0.54:53', peer: '0.0.0.0:*', state: '', owner: resolved, ownerName: 'systemd-resolve' },
    { proto: 'udp', v6: false, local: '0.0.0.0:5353', peer: '0.0.0.0:*', state: '', owner: avahi, ownerName: 'avahi-daemon: r' },
    { proto: 'udp', v6: true, local: ':::5353', peer: ':::*', state: '', owner: avahi, ownerName: 'avahi-daemon: r' },
    { proto: 'udp', v6: false, local: '0.0.0.0:46215', peer: '0.0.0.0:*', state: '', owner: avahi, ownerName: 'avahi-daemon: r' },
    { proto: 'udp', v6: false, local: '192.168.1.42:68', peer: '0.0.0.0:*', state: '', owner: nm, ownerName: 'NetworkManager' },
    { proto: 'tcp', v6: false, local: '192.168.1.42:47214', peer: '185.125.188.58:443', state: 'ESTABLISHED', owner: snapd, ownerName: 'snapd' },
  ];
  if (cups) {
    rows.push({ proto: 'tcp', v6: false, local: '127.0.0.1:631', peer: '0.0.0.0:*', state: 'LISTEN', owner: cups, ownerName: 'cupsd' });
  }
  return rows.filter((r) => r.owner !== null);
}

/** Unix domain sockets, for `netstat -x` / `ss -x`. */
function unixSockets() {
  return [
    { type: 'DGRAM', state: '', inode: 14329, path: '/run/systemd/journal/dev-log', owner: daemon('systemd-journald') },
    { type: 'STREAM', state: 'LISTENING', inode: 14712, path: '/run/systemd/journal/stdout', owner: daemon('systemd-journald') },
    { type: 'STREAM', state: 'LISTENING', inode: 18820, path: '/run/dbus/system_bus_socket', owner: daemon('dbus-daemon') },
    { type: 'STREAM', state: 'LISTENING', inode: 21044, path: '/run/snapd.socket', owner: daemon('snapd') },
    { type: 'STREAM', state: 'LISTENING', inode: 21045, path: '/run/snapd-snap.socket', owner: daemon('snapd') },
    { type: 'STREAM', state: 'LISTENING', inode: 23901, path: '/run/user/1000/bus', owner: daemon('systemd') },
  ].filter((s) => s.owner !== null);
}

/* ------------------------------------------------------------------ *
 * Small formatting helpers
 * ------------------------------------------------------------------ */

/** `ifconfig`'s "(174.8 MB)" byte annotation. */
function ifconfigBytes(bytes) {
  if (bytes < 1000) return `${bytes.toFixed(1)} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** `Mon Aug 18 07:31:22 KST 2026` — dig's WHEN line. */
function digWhen(d) {
  return `${DAYS_SHORT[d.getDay()]} ${MONTHS_SHORT[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} `
    + `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())} ${tzAbbr(d)} ${d.getFullYear()}`;
}

/** `2026-08-18 07:31:22` — wget's log stamp. */
function wgetStamp(d) {
  return `${d.getFullYear()}-${pad0(d.getMonth() + 1)}-${pad0(d.getDate())} `
    + `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}`;
}

/** RFC 7231 date, for synthesised HTTP headers. */
function httpDate(d) {
  return `${DAYS_SHORT[d.getUTCDay()]}, ${pad0(d.getUTCDate())} ${MONTHS_SHORT[d.getUTCMonth()]} `
    + `${d.getUTCFullYear()} ${pad0(d.getUTCHours())}:${pad0(d.getUTCMinutes())}:${pad0(d.getUTCSeconds())} GMT`;
}

/** Left-align to a fixed width without ever truncating. */
function col(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Split argv into flags and operands, honouring `--`.
 * @param {string[]} argv
 * @returns {{flags:Set<string>, opts:Map<string,string>, rest:string[]}}
 */
function simpleFlags(argv, withValue = new Set()) {
  const flags = new Set();
  const opts = new Map();
  const rest = [];
  let endOfFlags = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (endOfFlags) { rest.push(a); continue; }
    if (a === '--') { endOfFlags = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { opts.set(a.slice(0, eq), a.slice(eq + 1)); continue; }
      if (withValue.has(a)) { opts.set(a, argv[i + 1] || ''); i += 1; continue; }
      flags.add(a);
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) {
      let consumed = false;
      for (let j = 1; j < a.length; j += 1) {
        const key = `-${a[j]}`;
        if (withValue.has(key)) {
          const inline = a.slice(j + 1);
          if (inline !== '') opts.set(key, inline);
          else { opts.set(key, argv[i + 1] || ''); i += 1; }
          consumed = true;
          break;
        }
        flags.add(key);
      }
      if (consumed) continue;
      continue;
    }
    rest.push(a);
  }
  return { flags, opts, rest };
}

/* ------------------------------------------------------------------ *
 * ping
 * ------------------------------------------------------------------ */

const MAN_PING = `NAME
       ping - send ICMP ECHO_REQUEST to network hosts

SYNOPSIS
       ping [-aAbBdDfhLnOqrRUvV46] [-c count] [-i interval] [-s packetsize]
            [-W timeout] [-w deadline] destination

DESCRIPTION
       ping uses the ICMP protocol's mandatory ECHO_REQUEST datagram to elicit
       an ICMP ECHO_RESPONSE from a host or gateway.

       This emulator never puts a packet on the wire: replies are synthesised
       with a stable per-host latency profile and jittered per packet.

OPTIONS
       -c count
              Stop after sending count ECHO_REQUEST packets.

       -i interval
              Wait interval seconds between sending each packet. The default is
              one second.

       -n     Numeric output only. No attempt is made to look up symbolic names
              for host addresses.

       -q     Quiet output. Nothing is displayed except the summary lines at
              startup time and when finished.

       -s packetsize
              Specify the number of data bytes to be sent. The default is 56,
              which translates into 64 ICMP data bytes when combined with the 8
              bytes of ICMP header data.

       -w deadline
              Specify a timeout, in seconds, before ping exits regardless of
              how many packets have been sent or received.

EXIT STATUS
       ping returns 0 if at least one response was received, 1 if it sent the
       requested packets but received no replies, and 2 on any other error.`;

const pingCommand = {
  name: 'ping',
  aliases: [],
  synopsis: 'ping [-c COUNT] [-i INTERVAL] [-s SIZE] [-nq] DESTINATION',
  description: 'Send ICMP ECHO_REQUEST to network hosts',
  man: MAN_PING,
  async run(ctx) {
    const { flags, opts, rest } = simpleFlags(
      ctx.argv,
      new Set(['-c', '-i', '-s', '-w', '-W', '-t', '-I', '-M', '-p']),
    );

    if (flags.has('--help')) {
      return ok(`\nUsage: ping [OPTION...] HOST ...\n${MAN_PING.split('OPTIONS')[1] || ''}\n`);
    }
    if (flags.has('-V') || flags.has('--version')) {
      return ok('ping from iputils 20240117\nlibcap: yes, IDN: yes, NLS: yes, error.h: yes, getrandom(): yes, __fpending(): yes\n');
    }

    const target = rest[0];
    if (target === undefined) {
      return fail('ping: usage error: Destination address required\n', 2);
    }

    const count = opts.has('-c') ? Math.trunc(Number(opts.get('-c'))) : Infinity;
    if (opts.has('-c') && (!Number.isFinite(count) || count < 0)) {
      return fail(`ping: bad number of packets to transmit: ${opts.get('-c')}\n`, 2);
    }
    const interval = opts.has('-i') ? Number(opts.get('-i')) : 1;
    if (!Number.isFinite(interval) || interval <= 0) {
      return fail('ping: bad timing interval\n', 2);
    }
    const size = opts.has('-s') ? Math.trunc(Number(opts.get('-s'))) : 56;
    if (!Number.isFinite(size) || size < 0 || size > 65507) {
      return fail(`ping: illegal packet size (must be 0..65507)\n`, 2);
    }
    const deadline = opts.has('-w') ? Number(opts.get('-w')) : Infinity;
    const quiet = flags.has('-q');
    const numeric = flags.has('-n');

    const resolved = lookup(target);
    if (!resolved) {
      return fail(`ping: ${target}: Name or service not known\n`, 2);
    }
    if (flags.has('-6')) {
      return fail(`ping: ${target}: Address family for hostname not supported\n`, 2);
    }

    const { ip } = resolved;
    const profile = latencyProfile(ip);
    /** How the reply lines address the peer. */
    const peer = resolved.literal || numeric ? ip : `${resolved.canonical} (${ip})`;

    const out = [];
    const emit = (line) => {
      out.push(line);
      ctx.term.write(`${line}\n`);
    };

    emit(`PING ${target} (${ip}) ${size}(${size + 28}) bytes of data.`);

    const started = Date.now();
    const rtts = [];
    let transmitted = 0;
    let received = 0;
    let seq = 0;
    /** Roughly one packet in forty is dropped on a long path. */
    const lossChance = profile.hops > 1 ? 0.025 : 0;

    while (!aborted(ctx.signal) && seq < count) {
      seq += 1;
      transmitted += 1;

      const jitter = (Math.random() - 0.35) * Math.max(0.4, profile.base * 0.22);
      const rtt = Math.max(0.012, profile.base + jitter);
      await wait(Math.min(rtt, 250), ctx.signal);
      if (aborted(ctx.signal)) break;

      if (Math.random() >= lossChance) {
        received += 1;
        rtts.push(rtt);
        if (!quiet) {
          emit(`${size + 8} bytes from ${peer}: icmp_seq=${seq} ttl=${profile.ttl} time=${rtt < 10 ? rtt.toFixed(3) : rtt.toFixed(1)} ms`);
        }
      }

      if (seq >= count) break;
      if ((Date.now() - started) / 1000 >= deadline) break;

      const remaining = Math.max(0, interval * 1000 - Math.min(rtt, 250));
      await wait(remaining, ctx.signal);
      if ((Date.now() - started) / 1000 >= deadline) break;
    }

    const elapsed = Date.now() - started;
    const loss = transmitted === 0 ? 0 : ((transmitted - received) / transmitted) * 100;
    const lossText = Number.isInteger(loss) ? String(loss) : loss.toFixed(0);

    emit('');
    emit(`--- ${target} ping statistics ---`);
    emit(`${transmitted} packets transmitted, ${received} received, ${lossText}% packet loss, time ${Math.round(elapsed)}ms`);

    if (rtts.length > 0) {
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      const variance = rtts.reduce((a, b) => a + (b - avg) ** 2, 0) / rtts.length;
      const mdev = Math.sqrt(variance);
      emit(`rtt min/avg/max/mdev = ${ms3(min)}/${ms3(avg)}/${ms3(max)}/${ms3(mdev)} ms`);
    }

    return { stdout: '', stderr: '', code: received > 0 ? 0 : 1 };
  },
};

/* ------------------------------------------------------------------ *
 * ifconfig
 * ------------------------------------------------------------------ */

/**
 * One net-tools interface block.
 * @param {object} iface
 * @returns {string}
 */
function ifconfigBlock(iface) {
  const lines = [];
  lines.push(`${iface.name}: flags=${iface.ifconfigFlags.value}<${iface.ifconfigFlags.names.join(',')}>  mtu ${iface.mtu}`);
  if (iface.inet) {
    let line = `        inet ${iface.inet.addr}  netmask ${iface.inet.netmask}`;
    if (iface.inet.broadcast) line += `  broadcast ${iface.inet.broadcast}`;
    lines.push(line);
  }
  if (iface.inet6) {
    lines.push(`        inet6 ${iface.inet6.addr}  prefixlen ${iface.inet6.prefix}  scopeid ${iface.inet6.scopeid}`);
  }
  if (iface.kind === 'loopback') {
    lines.push(`        loop  txqueuelen ${iface.qlen}  (Local Loopback)`);
  } else {
    lines.push(`        ether ${iface.mac}  txqueuelen ${iface.qlen}  (Ethernet)`);
  }
  lines.push(`        RX packets ${iface.rx.packets}  bytes ${iface.rx.bytes} (${ifconfigBytes(iface.rx.bytes)})`);
  lines.push('        RX errors 0  dropped 0  overruns 0  frame 0');
  lines.push(`        TX packets ${iface.tx.packets}  bytes ${iface.tx.bytes} (${ifconfigBytes(iface.tx.bytes)})`);
  lines.push('        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0');
  return lines.join('\n');
}

const ifconfigCommand = {
  name: 'ifconfig',
  aliases: [],
  synopsis: 'ifconfig [-a] [-s] [INTERFACE]',
  description: 'Configure a network interface',
  man: `NAME
       ifconfig - configure a network interface

SYNOPSIS
       ifconfig [-v] [-a] [-s] [interface]

DESCRIPTION
       Ifconfig is used to configure the kernel-resident network interfaces.
       If no arguments are given, ifconfig displays the status of the currently
       active interfaces.

       This emulator is read-only: address assignment is not supported.

OPTIONS
       -a     Display all interfaces which are currently available, even if
              down.

       -s     Display a short list, in the format of netstat -i.

NOTE
       This program is obsolete! For replacement check ip addr and ip link.`,
  async run(ctx) {
    const { flags, rest } = simpleFlags(ctx.argv);
    const all = flags.has('-a');
    const short = flags.has('-s');
    const wanted = rest[0];

    const list = [...IFACES].sort((a, b) => a.name.localeCompare(b.name));

    if (wanted !== undefined) {
      const iface = list.find((i) => i.name === wanted);
      if (!iface) return fail(`${wanted}: error fetching interface information: Device not found\n`, 1);
      return ok(`${ifconfigBlock(iface)}\n\n`);
    }

    if (short) return ok(netstatInterfaces(false));

    const shown = all ? list : list.filter((i) => i.ifconfigFlags.names.includes('UP'));
    return ok(`${shown.map(ifconfigBlock).join('\n\n')}\n\n`);
  },
};

/* ------------------------------------------------------------------ *
 * ip
 * ------------------------------------------------------------------ */

/**
 * `ip addr` / `ip link` body for one interface.
 * @param {object} iface
 * @param {{link:boolean, family:number, brief:boolean}} opts
 * @returns {string[]}
 */
function ipBlock(iface, opts) {
  const lines = [];
  const mode = opts.link ? ' mode DEFAULT' : '';
  /* iproute2 emits a trailing space when a device has no queue length. */
  const qlen = iface.qlen > 0 ? ` qlen ${iface.qlen}` : ' ';
  lines.push(
    `${iface.index}: ${iface.name}: <${iface.flags.join(',')}> mtu ${iface.mtu} `
    + `qdisc ${iface.qdisc} state ${iface.state}${mode} group default${qlen}`,
  );
  const linkKind = iface.kind === 'loopback' ? 'link/loopback' : 'link/ether';
  lines.push(`    ${linkKind} ${iface.mac} brd ${iface.brd}`);
  if (opts.link) return lines;

  if (iface.inet && opts.family !== 6) {
    const brd = iface.inet.broadcast ? ` brd ${iface.inet.broadcast}` : '';
    lines.push(`    inet ${iface.inet.addr}/${iface.inet.prefix}${brd} scope ${iface.inet.scope} ${iface.inet.extra}`);
    const lft = iface.inet.lft || 'forever';
    lines.push(`       valid_lft ${lft} preferred_lft ${lft}`);
  }
  if (iface.inet6 && opts.family !== 4) {
    lines.push(`    inet6 ${iface.inet6.addr}/${iface.inet6.prefix} scope ${iface.inet6.scope} ${iface.inet6.extra} `);
    lines.push('       valid_lft forever preferred_lft forever');
  }
  return lines;
}

/** `ip -br addr` / `ip -br link`. */
function ipBrief(iface, link, family) {
  if (link) {
    return `${col(iface.name, 17)}${col(iface.state, 15)}${iface.mac} <${iface.flags.join(',')}>`;
  }
  const addrs = [];
  if (iface.inet && family !== 6) addrs.push(`${iface.inet.addr}/${iface.inet.prefix}`);
  if (iface.inet6 && family !== 4) addrs.push(`${iface.inet6.addr}/${iface.inet6.prefix}`);
  return `${col(iface.name, 17)}${col(iface.state, 15)}${addrs.join(' ')} `;
}

/** The kernel routing table, as `ip route` renders it. */
function ipRoutes() {
  return [
    `default via ${GATEWAY} dev enp0s3 proto dhcp src 192.168.1.42 metric 100 `,
    '172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown ',
    '192.168.1.0/24 dev enp0s3 proto kernel scope link src 192.168.1.42 metric 100 ',
    `${GATEWAY} dev enp0s3 proto dhcp scope link src 192.168.1.42 metric 100 `,
  ];
}

const ipCommand = {
  name: 'ip',
  aliases: [],
  synopsis: 'ip [-4|-6] [-br] OBJECT { COMMAND | help }',
  description: 'Show / manipulate routing, network devices, interfaces and tunnels',
  man: `NAME
       ip - show / manipulate routing, network devices, interfaces and tunnels

SYNOPSIS
       ip [ OPTIONS ] OBJECT { COMMAND | help }
       OBJECT := { address | link | route | neighbour }
       OPTIONS := { -4 | -6 | -br[ief] | -c[olor] | -s[tatistics] }

DESCRIPTION
       ip is the iproute2 replacement for ifconfig, route and arp.

       This emulator implements the read-only subcommands: address show, link
       show, route show and neighbour show. Anything that would modify the
       configuration is refused.

OBJECTS
       address (a, addr)
              protocol (IP or IPv6) address on a device.

       link (l)
              network device.

       route (r)
              routing table entry.

       neighbour (n, neigh)
              ARP or NDISC cache entry.`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let family = 0;
    let brief = false;

    while (argv.length > 0 && argv[0].startsWith('-')) {
      const a = argv.shift();
      if (a === '-4') family = 4;
      else if (a === '-6') family = 6;
      else if (a === '-br' || a === '-brief') brief = true;
      else if (a === '-c' || a === '-color' || a === '-s' || a === '-stats' || a === '-statistics' || a === '-o' || a === '-oneline') { /* accepted, no effect */ }
      else if (a === '-V' || a === '-Version' || a === '--version') return ok('ip utility, iproute2-6.1.0, libbpf 1.3.0\n');
      else if (a === '-h' || a === '--help') return ok(`Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | neigh }\n`);
      else return fail(`Option "${a}" is unknown, try "ip -help".\n`, 255);
    }

    const object = (argv.shift() || 'addr').toLowerCase();
    const verb = (argv.shift() || 'show').toLowerCase();

    if (['add', 'del', 'delete', 'change', 'replace', 'set', 'flush'].includes(verb)) {
      return fail('RTNETLINK answers: Operation not permitted\n', 2);
    }

    const ordered = [...IFACES].sort((a, b) => a.index - b.index);
    const nameFilter = argv.filter((a) => !a.startsWith('-'));
    const filtered = nameFilter.length > 0 && nameFilter[0] !== 'dev'
      ? ordered.filter((i) => nameFilter.includes(i.name))
      : ordered;

    if (['a', 'addr', 'address'].includes(object)) {
      if (nameFilter.length > 0 && filtered.length === 0) {
        return fail(`Device "${nameFilter[0]}" does not exist.\n`, 1);
      }
      if (brief) return ok(`${filtered.map((i) => ipBrief(i, false, family)).join('\n')}\n`);
      const lines = [];
      for (const iface of filtered) lines.push(...ipBlock(iface, { link: false, family, brief }));
      return ok(`${lines.join('\n')}\n`);
    }

    if (['l', 'link'].includes(object)) {
      if (nameFilter.length > 0 && filtered.length === 0) {
        return fail(`Device "${nameFilter[0]}" does not exist.\n`, 1);
      }
      if (brief) return ok(`${filtered.map((i) => ipBrief(i, true, family)).join('\n')}\n`);
      const lines = [];
      for (const iface of filtered) lines.push(...ipBlock(iface, { link: true, family, brief }));
      return ok(`${lines.join('\n')}\n`);
    }

    if (['r', 'route', 'ro', 'rou'].includes(object)) {
      return ok(`${ipRoutes().join('\n')}\n`);
    }

    if (['n', 'neigh', 'neighbor', 'neighbour'].includes(object)) {
      const lines = NEIGHBOURS.map((n) => `${n.ip} dev ${n.dev} lladdr ${n.mac} ${n.state}`);
      return ok(`${lines.join('\n')}\n`);
    }

    if (object === 'help' || object === '-help') {
      return ok('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | neigh }\n');
    }

    return fail(`Object "${object}" is unknown, try "ip help".\n`, 255);
  },
};

/* ------------------------------------------------------------------ *
 * netstat
 * ------------------------------------------------------------------ */

/** `netstat -i` / `ifconfig -s`. */
function netstatInterfaces(withHeader = true) {
  const lines = [];
  if (withHeader) lines.push('Kernel Interface table');
  lines.push('Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg');
  for (const i of [...IFACES].sort((a, b) => a.name.localeCompare(b.name))) {
    /* net-tools' own column quirk: RX-OVR is printed unpadded and TX-OK
       absorbs the slack, which is why the body never quite lines up with the
       header on a real machine either. */
    lines.push(
      `${col(i.name, 9)}${String(i.mtu).padStart(5)}${String(i.rx.packets).padStart(9)}`
      + `${'0'.padStart(7)}${'0'.padStart(7)} 0${String(i.tx.packets).padStart(14)}`
      + `${'0'.padStart(7)}${'0'.padStart(7)}${'0'.padStart(7)} ${i.netstatFlags}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** `netstat -r` / `route` (net-tools layout, symbolic gateway). */
function netstatRoutes(numeric) {
  const gw = numeric ? GATEWAY : '_gateway';
  const dflt = numeric ? '0.0.0.0' : 'default';
  const lines = ['Kernel IP routing table'];
  lines.push('Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface');
  lines.push(`${col(dflt, 16)}${col(gw, 16)}${col('0.0.0.0', 16)}UG        0 0          0 enp0s3`);
  lines.push(`${col('172.17.0.0', 16)}${col('0.0.0.0', 16)}${col('255.255.0.0', 16)}U         0 0          0 docker0`);
  lines.push(`${col('192.168.1.0', 16)}${col('0.0.0.0', 16)}${col('255.255.255.0', 16)}U         0 0          0 enp0s3`);
  return `${lines.join('\n')}\n`;
}

/** Kernel counters for `netstat -s`. */
function netstatStatistics() {
  return `Ip:
    Forwarding: 2
    128437 total packets received
    0 forwarded
    0 incoming packets discarded
    128401 incoming packets delivered
    74210 requests sent out
Icmp:
    24 ICMP messages received
    0 input ICMP message failed
    ICMP input histogram:
        echo replies: 24
    26 ICMP messages sent
    0 ICMP messages failed
    ICMP output histogram:
        echo requests: 26
Tcp:
    1842 active connection openings
    0 passive connection openings
    12 failed connection attempts
    3 connection resets received
    1 connections established
    104219 segments received
    68411 segments sent out
    41 segments retransmitted
    0 bad segments received
    18 resets sent
Udp:
    22874 packets received
    2 packets to unknown port received
    0 packet receive errors
    22901 packets sent
    0 receive buffer errors
    0 send buffer errors
TcpExt:
    18 TCP sockets finished time wait in fast timer
    2094 delayed acks sent
IpExt:
    InOctets: 174829301
    OutOctets: 8213944
`;
}

const netstatCommand = {
  name: 'netstat',
  aliases: [],
  synopsis: 'netstat [-a] [-t] [-u] [-x] [-l] [-n] [-p] [-r] [-i] [-s]',
  description: 'Print network connections, routing tables, interface statistics',
  man: `NAME
       netstat - Print network connections, routing tables, interface
       statistics, masquerade connections, and multicast memberships

SYNOPSIS
       netstat [-vWeenNcCF] [<Af>] -r
       netstat [-vWnNcaeol] [<Socket> ...]
       netstat { [-vWeenNac] -i | [-cnNe] -M | -s }

DESCRIPTION
       netstat prints information about the Linux networking subsystem. The
       socket list is generated from the live process table, so every PID and
       program name shown belongs to a daemon that is actually running.

OPTIONS
       -a, --all          display all sockets (default: connected)
       -l, --listening    display listening server sockets
       -t, --tcp          TCP sockets
       -u, --udp          UDP sockets
       -x, --unix         UNIX domain sockets
       -n, --numeric      don't resolve names
       -p, --programs     display PID/Program name for sockets
       -r, --route        display routing table
       -i, --interfaces   display interface table
       -s, --statistics   display networking statistics

NOTE
       This program is obsolete. Replacement for netstat is ss.`,
  async run(ctx) {
    const { flags } = simpleFlags(ctx.argv);
    const has = (short, long) => flags.has(short) || flags.has(long);

    if (has('-V', '--version')) return ok('net-tools 2.10-alpha\n');
    if (has('-r', '--route')) return ok(netstatRoutes(has('-n', '--numeric')));
    if (has('-i', '--interfaces')) return ok(netstatInterfaces(true));
    if (has('-s', '--statistics')) return ok(netstatStatistics());

    const listening = has('-l', '--listening');
    const all = has('-a', '--all');
    const showProg = has('-p', '--programs');
    const wantTcp = has('-t', '--tcp');
    const wantUdp = has('-u', '--udp');
    const wantUnix = has('-x', '--unix');
    const anyProto = wantTcp || wantUdp || wantUnix;

    const lines = [];
    /* `-x` on its own asks for UNIX sockets only. */
    if (!wantUnix || wantTcp || wantUdp) {
      lines.push(listening && !all
        ? 'Active Internet connections (only servers)'
        : all ? 'Active Internet connections (servers and established)'
          : 'Active Internet connections (w/o servers)');
      lines.push(`Proto Recv-Q Send-Q Local Address           Foreign Address         State       ${showProg ? 'PID/Program name    ' : ''}`.replace(/\s+$/, showProg ? ' ' : ''));

      for (const s of sockets()) {
        if (anyProto) {
          if (s.proto === 'tcp' && !wantTcp) continue;
          if (s.proto === 'udp' && !wantUdp) continue;
        }
        const isServer = s.state === 'LISTEN' || s.proto === 'udp';
        if (listening && !all && !isServer) continue;
        if (!listening && !all && isServer) continue;

        const proto = s.v6 ? `${s.proto}6` : s.proto;
        const prog = showProg ? `${s.owner.pid}/${s.ownerName}` : '';
        lines.push(
          `${col(proto, 6)}${String(0).padStart(6)} ${String(0).padStart(6)} `
          + `${col(s.local, 24)}${col(s.peer, 24)}${col(s.state, 12)}${prog}`.replace(/\s+$/, ''),
        );
      }
    }

    if (wantUnix || all || !anyProto) {
      if (lines.length > 0) lines.push('');
      lines.push('Active UNIX domain sockets (w/o servers)');
      lines.push(`Proto RefCnt Flags       Type       State         I-Node   ${showProg ? 'PID/Program name     ' : ''}Path`);
      for (const s of unixSockets()) {
        if (!s.state && listening && !all) continue;
        const prog = showProg ? col(`${s.owner.pid}/${s.owner.name}`, 21) : '';
        lines.push(
          `unix  ${String(3).padStart(6)} ${col('[ ACC ]', 12)}${col(s.type, 11)}${col(s.state || 'CONNECTED', 14)}`
          + `${col(String(s.inode), 9)}${prog}${s.path}`,
        );
      }
    }

    return ok(`${lines.join('\n')}\n`);
  },
};

/* ------------------------------------------------------------------ *
 * ss
 * ------------------------------------------------------------------ */

const ssCommand = {
  name: 'ss',
  aliases: [],
  synopsis: 'ss [-t] [-u] [-x] [-l] [-a] [-n] [-p]',
  description: 'Another utility to investigate sockets',
  man: `NAME
       ss - another utility to investigate sockets

SYNOPSIS
       ss [options] [ FILTER ]

DESCRIPTION
       ss is used to dump socket statistics. It allows showing information
       similar to netstat.

OPTIONS
       -a, --all        Display both listening and non-listening sockets.
       -l, --listening  Display only listening sockets.
       -t, --tcp        Display TCP sockets.
       -u, --udp        Display UDP sockets.
       -x, --unix       Display Unix domain sockets.
       -n, --numeric    Do not try to resolve service names.
       -p, --processes  Show process using socket.
       -s, --summary    Print summary statistics.`,
  async run(ctx) {
    const { flags } = simpleFlags(ctx.argv);
    const has = (short, long) => flags.has(short) || flags.has(long);

    if (has('-V', '--version')) return ok('ss utility, iproute2-6.1.0\n');

    if (has('-s', '--summary')) {
      const list = sockets();
      const tcp = list.filter((s) => s.proto === 'tcp').length;
      const udp = list.filter((s) => s.proto === 'udp').length;
      const unix = unixSockets().length;
      return ok(
        `Total: ${tcp + udp + unix}\n`
        + 'TCP:   1 (estab 1, closed 0, orphaned 0, timewait 0)\n\n'
        + 'Transport Total     IP        IPv6\n'
        + `RAW\t  0         0         0        \n`
        + `UDP\t  ${udp}         ${udp - 1}         1        \n`
        + `TCP\t  ${tcp}         ${tcp}         0        \n`
        + `INET\t  ${tcp + udp}         ${tcp + udp - 1}         1        \n`
        + `FRAG\t  0         0         0        \n`,
      );
    }

    const listening = has('-l', '--listening');
    const all = has('-a', '--all');
    const showProg = has('-p', '--processes');
    const wantTcp = has('-t', '--tcp');
    const wantUdp = has('-u', '--udp');
    const wantUnix = has('-x', '--unix');
    const anyProto = wantTcp || wantUdp || wantUnix;

    const rows = [];
    for (const s of sockets()) {
      if (anyProto) {
        if (s.proto === 'tcp' && !wantTcp) continue;
        if (s.proto === 'udp' && !wantUdp) continue;
        if (!wantTcp && !wantUdp) continue;
      }
      const isServer = s.state === 'LISTEN' || s.proto === 'udp';
      if (listening && !all && !isServer) continue;
      if (!listening && !all && isServer) continue;

      const state = s.proto === 'udp' ? 'UNCONN' : s.state === 'LISTEN' ? 'LISTEN' : 'ESTAB';
      const local = s.local === '0.0.0.0:*' ? '0.0.0.0:*' : s.local.replace(/^127\.0\.0\.5([34]):/, '127.0.0.5$1%lo:');
      rows.push({
        netid: s.proto,
        state,
        local,
        peer: s.peer,
        process: showProg ? `users:(("${s.ownerName.split(':')[0]}",pid=${s.owner.pid},fd=${11 + rows.length}))` : '',
      });
    }

    if (wantUnix) {
      for (const s of unixSockets()) {
        rows.push({
          netid: `u_${s.type === 'DGRAM' ? 'dgr' : 'str'}`,
          state: s.state ? 'LISTEN' : 'ESTAB',
          local: `${s.path} ${s.inode}`,
          peer: '* 0',
          process: showProg ? `users:(("${s.owner.name}",pid=${s.owner.pid},fd=3))` : '',
        });
      }
    }

    /* ss right-aligns the address half of an endpoint and left-aligns the port
       half, so the colons line up into a column. */
    const halves = (endpoint) => {
      const idx = endpoint.lastIndexOf(':');
      return idx < 0 ? [endpoint, ''] : [endpoint.slice(0, idx), endpoint.slice(idx + 1)];
    };
    const localHalves = rows.map((r) => halves(r.local));
    const peerHalves = rows.map((r) => halves(r.peer));
    const localAddrW = Math.max(13, ...localHalves.map((h) => h[0].length));
    const localPortW = Math.max(4, ...localHalves.map((h) => h[1].length));
    const peerAddrW = Math.max(12, ...peerHalves.map((h) => h[0].length));
    const peerPortW = Math.max(4, ...peerHalves.map((h) => h[1].length));
    const endpoint = (h, addrW, portW) => `${h[0].padStart(addrW)}:${h[1].padEnd(portW)}`;

    const header = `${col('Netid', 6)}${col('State', 7)}${col('Recv-Q', 7)}${col('Send-Q', 7)}`
      + `${col('Local Address:Port', localAddrW + localPortW + 1)}  `
      + `${col('Peer Address:Port', peerAddrW + peerPortW + 1)}  ${showProg ? 'Process' : ''}`;
    const lines = [header.replace(/\s+$/, '')];
    rows.forEach((r, i) => {
      lines.push(
        `${col(r.netid, 6)}${col(r.state, 7)}${col('0', 7)}${col('0', 7)}`
        + `${endpoint(localHalves[i], localAddrW, localPortW)}  `
        + `${endpoint(peerHalves[i], peerAddrW, peerPortW)}  ${r.process}`.replace(/\s+$/, ''),
      );
    });
    return ok(`${lines.join('\n')}\n`);
  },
};

/* ------------------------------------------------------------------ *
 * HTTP simulation shared by curl and wget
 * ------------------------------------------------------------------ */

/**
 * Split a URL into its parts without using the URL constructor's network-ish
 * quirks. Returns null when the input cannot be a URL at all.
 * @param {string} raw
 * @returns {{scheme:string, host:string, port:number, path:string, href:string}|null}
 */
export function parseUrl(raw) {
  const text = String(raw).trim();
  if (text === '') return null;
  const m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?([^/?#\s]+)([^\s]*)$/.exec(text);
  if (!m) return null;
  const scheme = (m[1] || 'http').toLowerCase();
  const authority = m[2];
  const rest = m[3] || '';
  const hostPort = authority.includes('@') ? authority.slice(authority.indexOf('@') + 1) : authority;
  const colonIdx = hostPort.lastIndexOf(':');
  const hasPort = colonIdx > 0 && /^\d+$/.test(hostPort.slice(colonIdx + 1));
  const host = hasPort ? hostPort.slice(0, colonIdx) : hostPort;
  const port = hasPort ? Number(hostPort.slice(colonIdx + 1)) : scheme === 'https' ? 443 : scheme === 'ftp' ? 21 : 80;
  const path = rest === '' ? '/' : rest;
  return { scheme, host, port, path, href: `${scheme}://${hostPort}${path}` };
}

/** MIME type guessed from the request path. */
function mimeFor(path) {
  const clean = path.split('?')[0];
  if (/\.json$/i.test(clean)) return 'application/json';
  if (/\.(txt|md|log)$/i.test(clean)) return 'text/plain; charset=utf-8';
  if (/\.(css)$/i.test(clean)) return 'text/css';
  if (/\.(js|mjs)$/i.test(clean)) return 'text/javascript';
  if (/\.(xml|rss)$/i.test(clean)) return 'application/xml';
  if (/\.(png|jpg|jpeg|gif|webp|ico|svg)$/i.test(clean)) return 'image/png';
  if (/\.(tar\.gz|tgz|zip|deb|iso)$/i.test(clean)) return 'application/octet-stream';
  return 'text/html; charset=UTF-8';
}

/** The canned body used whenever Gemini is unavailable. */
function offlineBody(url, mime) {
  if (mime.startsWith('application/json')) {
    return `{\n  "url": "${url.href}",\n  "host": "${url.host}",\n  "simulated": true,\n  "note": "Ubuntu AI Desktop does not make real network requests."\n}\n`;
  }
  if (mime.startsWith('text/plain')) {
    return `${url.href}\n\nThis response was generated locally by the Ubuntu AI Desktop\nnetwork emulator. No request left the browser.\n`;
  }
  if (mime.startsWith('application/octet-stream') || mime.startsWith('image/')) {
    return `<simulated ${mime} payload for ${url.href}>\n`;
  }
  return `<!doctype html>
<html>
<head>
    <title>${url.host}</title>
    <meta charset="utf-8" />
</head>
<body>
<h1>${url.host}</h1>
<p>This page was produced by the Ubuntu AI Desktop network emulator.
No request was made to a real server.</p>
<p>Configure a Gemini API key in Settings &gt; AI Configuration to have
plausible page bodies generated instead.</p>
</body>
</html>
`;
}

/**
 * Produce a response body for a simulated request, using Gemini when a key is
 * configured and falling back to a canned body otherwise.
 * @param {object} ctx command context
 * @param {object} url parsed URL
 * @param {string} mime
 * @returns {Promise<string>}
 */
async function synthesiseBody(ctx, url, mime) {
  if (!ctx.gemini || !ctx.gemini.hasKey()) return offlineBody(url, mime);
  try {
    const text = await ctx.gemini.generate(
      `Produce ONLY the raw response body a GET request to ${url.href} would plausibly return.\n`
      + `The Content-Type is ${mime}. Do not wrap the answer in markdown fences, do not explain it, `
      + 'and keep it under 40 lines.',
      { temperature: 0.4, signal: ctx.signal },
    );
    const trimmed = String(text).replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
    if (trimmed === '') return offlineBody(url, mime);
    return `${trimmed}\n`;
  } catch {
    return offlineBody(url, mime);
  }
}

/**
 * Status line for a simulated request. Paths that look like an error are
 * honoured so `curl example.com/missing` behaves sensibly.
 * @param {object} url
 * @returns {{code:number, reason:string}}
 */
function statusFor(url) {
  if (/\/(404|missing|notfound)(\b|\/|$)/i.test(url.path)) return { code: 404, reason: 'Not Found' };
  if (/\/(403|forbidden)(\b|\/|$)/i.test(url.path)) return { code: 403, reason: 'Forbidden' };
  if (/\/(500|error)(\b|\/|$)/i.test(url.path)) return { code: 500, reason: 'Internal Server Error' };
  return { code: 200, reason: 'OK' };
}

/* ------------------------------------------------------------------ *
 * curl
 * ------------------------------------------------------------------ */

const CURL_VERSION = `curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.7
Release-Date: 2023-12-06, security patched: 8.5.0-2ubuntu10.6
Protocols: dict file ftp ftps gopher gophers http https imap imaps ldap ldaps mqtt pop3 pop3s rtmp rtsp scp sftp smb smbs smtp smtps telnet tftp
Features: alt-svc AsynchDNS brotli GSS-API HSTS HTTP2 HTTPS-proxy IDN IPv6 Largefile libz NTLM NTLM_WB PSL SPNEGO SSL threadsafe TLS-SRP UnixSockets zstd
`;

const curlCommand = {
  name: 'curl',
  aliases: [],
  synopsis: 'curl [-sSILv] [-o FILE] [-O] [-X METHOD] [-H HEADER] [-d DATA] URL',
  description: 'Transfer a URL',
  man: `NAME
       curl - transfer a URL

SYNOPSIS
       curl [options...] <url>

DESCRIPTION
       curl is a tool for transferring data from or to a server.

       In the Ubuntu AI Desktop no request ever leaves the browser. The status
       line, headers and timings are synthesised locally; when a Gemini API key
       is configured the response body is generated by the model, otherwise a
       clearly-labelled placeholder body is returned.

OPTIONS
       -d, --data <data>     Send the given data in a POST request.
       -H, --header <header> Add a header to the request. May be repeated.
       -I, --head            Fetch the headers only.
       -i, --include         Include the response headers in the output.
       -L, --location        Follow redirects.
       -o, --output <file>   Write output to <file> instead of stdout.
       -O, --remote-name     Write output to a file named as the remote file.
       -s, --silent          Silent mode. Do not show progress or errors.
       -S, --show-error      Show an error message even when -s is used.
       -X, --request <verb>  Use the given request method.
       -A, --user-agent <ua> Send the given User-Agent header.
       -w, --write-out <fmt> Print the given format after the transfer.
       -v, --verbose         Make the operation more talkative.
       --version             Show the curl version and exit.

EXIT STATUS
       0   success
       3   URL malformed
       6   could not resolve host
       22  HTTP page not retrieved (with -f)`,
  async run(ctx) {
    const argv = ctx.argv;
    const headers = [];
    let output = null;
    let remoteName = false;
    let method = null;
    let data = null;
    let silent = false;
    let headOnly = false;
    let include = false;
    let follow = false;
    let verbose = false;
    let failFast = false;
    let userAgent = 'curl/8.5.0';
    let writeOut = null;
    const urls = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      const next = () => argv[++i];
      if (a === '--version' || a === '-V') return ok(CURL_VERSION);
      if (a === '--help' || a === '-h') return ok('Usage: curl [options...] <url>\n -o, --output <file>  Write to file instead of stdout\n -O, --remote-name    Write output to a file named as the remote file\n -I, --head           Show document info only\n -s, --silent         Silent mode\n');
      if (a === '-o' || a === '--output') { output = next(); continue; }
      if (a === '-O' || a === '--remote-name') { remoteName = true; continue; }
      if (a === '-X' || a === '--request') { method = String(next() || '').toUpperCase(); continue; }
      if (a === '-H' || a === '--header') { headers.push(String(next() || '')); continue; }
      if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary') { data = String(next() || ''); continue; }
      if (a === '-A' || a === '--user-agent') { userAgent = String(next() || ''); continue; }
      if (a === '-w' || a === '--write-out') { writeOut = String(next() || ''); continue; }
      if (a === '-I' || a === '--head') { headOnly = true; continue; }
      if (a === '-i' || a === '--include') { include = true; continue; }
      if (a === '-L' || a === '--location') { follow = true; continue; }
      if (a === '-v' || a === '--verbose') { verbose = true; continue; }
      if (a === '-f' || a === '--fail') { failFast = true; continue; }
      if (a === '-k' || a === '--insecure' || a === '-g' || a === '--globoff' || a === '--compressed') continue;
      if (a === '-sS' || a === '-Ss') { silent = true; continue; }
      if (a === '-s' || a === '--silent') { silent = true; continue; }
      if (a === '-S' || a === '--show-error') continue;
      if (a.startsWith('-') && a.length > 1 && !a.startsWith('--') && /^-[a-zA-Z]+$/.test(a)) {
        for (const ch of a.slice(1)) {
          if (ch === 's') silent = true;
          else if (ch === 'I') headOnly = true;
          else if (ch === 'i') include = true;
          else if (ch === 'L') follow = true;
          else if (ch === 'v') verbose = true;
          else if (ch === 'O') remoteName = true;
          else if (ch === 'f') failFast = true;
        }
        continue;
      }
      if (a.startsWith('-')) continue;
      urls.push(a);
    }

    if (urls.length === 0) {
      return fail('curl: try \'curl --help\' or \'curl --manual\' for more information\n', 2);
    }

    const out = [];
    const errOut = [];
    let exitCode = 0;

    for (const raw of urls) {
      if (aborted(ctx.signal)) break;
      const url = parseUrl(raw);
      if (!url) {
        errOut.push(`curl: (3) URL rejected: Malformed input to a URL function`);
        exitCode = 3;
        continue;
      }
      if (!['http', 'https', 'ftp', 'file'].includes(url.scheme)) {
        errOut.push(`curl: (1) Protocol "${url.scheme}" not supported or disabled in libcurl`);
        exitCode = 1;
        continue;
      }

      const resolved = lookup(url.host);
      if (!resolved) {
        errOut.push(`curl: (6) Could not resolve host: ${url.host}`);
        exitCode = 6;
        continue;
      }

      const status = statusFor(url);
      const verb = method || (data !== null ? 'POST' : headOnly ? 'HEAD' : 'GET');
      const mime = mimeFor(url.path);

      if (verbose) {
        errOut.push(`*   Trying ${resolved.ip}:${url.port}...`);
        errOut.push(`* Connected to ${url.host} (${resolved.ip}) port ${url.port}`);
        errOut.push(`> ${verb} ${url.path} HTTP/1.1`);
        errOut.push(`> Host: ${url.host}`);
        errOut.push(`> User-Agent: ${userAgent}`);
        errOut.push('> Accept: */*');
        for (const h of headers) errOut.push(`> ${h}`);
        errOut.push('>');
      }

      await wait(60 + (fnv1a(url.href) % 240), ctx.signal);
      if (aborted(ctx.signal)) break;

      const body = headOnly || status.code >= 400 ? '' : await synthesiseBody(ctx, url, mime);
      /* A HEAD still has to report a length, so measure the offline body. */
      const measured = headOnly ? offlineBody(url, mime) : body;
      const bytes = new TextEncoder().encode(measured).length;
      const now = new Date();

      const headerLines = [
        `HTTP/1.1 ${status.code} ${status.reason}`,
        `Date: ${httpDate(now)}`,
        'Server: nginx/1.24.0 (Ubuntu)',
        `Content-Type: ${mime}`,
        `Content-Length: ${bytes}`,
        'Connection: keep-alive',
        'Accept-Ranges: bytes',
      ];
      if (follow && status.code === 200) headerLines.splice(1, 0, `Vary: Accept-Encoding`);

      if (verbose) for (const line of headerLines) errOut.push(`< ${line}`);

      if (headOnly || include) out.push(`${headerLines.join('\n')}\n`);
      if (headOnly) continue;

      if (status.code >= 400) {
        if (failFast) {
          errOut.push(`curl: (22) The requested URL returned error: ${status.code}`);
          exitCode = 22;
          continue;
        }
        out.push(`<html>\n<head><title>${status.code} ${status.reason}</title></head>\n<body>\n<center><h1>${status.code} ${status.reason}</h1></center>\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\n</body>\n</html>\n`);
        continue;
      }

      const target = output || (remoteName ? (url.path.split('/').filter(Boolean).pop() || 'index.html') : null);
      if (target) {
        const dest = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(target, env.home));
        try {
          fs.writeFile(dest, body);
        } catch (err) {
          errOut.push(`curl: (23) Failure writing output to destination, passed ${bytes} returned 0`);
          exitCode = 23;
          continue;
        }
        if (!silent) {
          const speed = Math.max(1, Math.round(bytes / 0.1));
          errOut.push('  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current');
          errOut.push('                                 Dload  Upload   Total   Spent    Left  Speed');
          errOut.push(
            `100 ${String(bytes).padStart(5)}  100 ${String(bytes).padStart(5)}    0     0  `
            + `${String(speed).padStart(5)}      0 --:--:-- --:--:-- --:--:-- ${String(speed).padStart(5)}`,
          );
        }
      } else {
        out.push(body);
      }

      if (writeOut) {
        out.push(writeOut
          .split('%{http_code}').join(String(status.code))
          .split('%{size_download}').join(String(bytes))
          .split('%{remote_ip}').join(resolved.ip)
          .split('%{url_effective}').join(url.href)
          .split('%{time_total}').join('0.108')
          .split('\\n').join('\n'));
      }
    }

    if (aborted(ctx.signal)) return { stdout: out.join(''), stderr: '', code: 130 };
    const stderr = silent ? errOut.filter((l) => l.startsWith('curl:')).join('\n') : errOut.join('\n');
    return {
      stdout: out.join(''),
      stderr: stderr === '' ? '' : `${stderr}\n`,
      code: exitCode,
    };
  },
};

/* ------------------------------------------------------------------ *
 * wget
 * ------------------------------------------------------------------ */

const wgetCommand = {
  name: 'wget',
  aliases: [],
  synopsis: 'wget [-q] [-O FILE] [--spider] URL...',
  description: 'The non-interactive network downloader',
  man: `NAME
       wget - The non-interactive network downloader

SYNOPSIS
       wget [option]... [URL]...

DESCRIPTION
       GNU Wget is a free utility for non-interactive download of files from
       the Web.

       In the Ubuntu AI Desktop nothing is downloaded from a real server: the
       resolve/connect/response log is synthesised and the saved file contains
       a locally generated body (produced by Gemini when a key is configured).

OPTIONS
       -O, --output-document=FILE
              Write documents to FILE. Use - for standard output.

       -q, --quiet
              Turn off Wget's output.

       -nv, --no-verbose
              Turn off verbose without being completely quiet.

       -P, --directory-prefix=PREFIX
              Save files to PREFIX/...

       --spider
              Do not download anything, just check that the pages are there.

EXIT STATUS
       0  No problems occurred.
       4  Network failure.
       8  Server issued an error response.`,
  async run(ctx) {
    const argv = ctx.argv;
    let output = null;
    let quiet = false;
    let spider = false;
    let prefix = null;
    const urls = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--version' || a === '-V') return ok('GNU Wget 1.21.4 built on linux-gnu.\n');
      if (a === '--help') return ok('GNU Wget 1.21.4, a non-interactive network retriever.\nUsage: wget [OPTION]... [URL]...\n');
      if (a === '-O' || a === '--output-document') { output = argv[++i]; continue; }
      if (a.startsWith('--output-document=')) { output = a.slice(18); continue; }
      if (a === '-P' || a === '--directory-prefix') { prefix = argv[++i]; continue; }
      if (a.startsWith('--directory-prefix=')) { prefix = a.slice(19); continue; }
      if (a === '-q' || a === '--quiet') { quiet = true; continue; }
      if (a === '-nv' || a === '--no-verbose') { quiet = true; continue; }
      if (a === '--spider') { spider = true; continue; }
      if (a.startsWith('-')) continue;
      urls.push(a);
    }

    if (urls.length === 0) {
      return fail('wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry `wget --help\' for more options.\n', 1);
    }

    const log = [];
    const stdout = [];
    let code = 0;

    for (const raw of urls) {
      if (aborted(ctx.signal)) break;
      const url = parseUrl(raw);
      const now = new Date();
      if (!url) {
        log.push(`${wgetStamp(now)} ERROR: Invalid URL ${raw}: Invalid host name`);
        code = 1;
        continue;
      }

      log.push(`--${wgetStamp(now)}--  ${url.href}`);
      const resolved = lookup(url.host);
      if (!resolved) {
        log.push(`Resolving ${url.host} (${url.host})... failed: Name or service not known.`);
        log.push(`wget: unable to resolve host address ‘${url.host}’`);
        code = 4;
        continue;
      }
      log.push(`Resolving ${url.host} (${url.host})... ${resolved.ip}`);
      log.push(`Connecting to ${url.host} (${url.host})|${resolved.ip}|:${url.port}... connected.`);

      await wait(80 + (fnv1a(url.href) % 200), ctx.signal);
      if (aborted(ctx.signal)) break;

      const status = statusFor(url);
      if (status.code >= 400) {
        log.push(`HTTP request sent, awaiting response... ${status.code} ${status.reason}`);
        log.push(`${wgetStamp(new Date())} ERROR ${status.code}: ${status.reason}.`);
        code = 8;
        continue;
      }
      log.push('HTTP request sent, awaiting response... 200 OK');

      const mime = mimeFor(url.path);
      const body = await synthesiseBody(ctx, url, mime);
      const bytes = new TextEncoder().encode(body).length;
      log.push(`Length: ${bytes} (${(bytes / 1024).toFixed(1)}K) [${mime.split(';')[0]}]`);

      if (spider) {
        log.push('Remote file exists.');
        log.push('');
        continue;
      }

      const base = url.path.split('?')[0].split('/').filter(Boolean).pop() || 'index.html';
      const name = output !== null ? output : prefix ? `${prefix}/${base}` : base;

      if (name === '-') {
        log.push('Saving to: ‘STDOUT’');
        log.push('');
        stdout.push(body);
      } else {
        const dest = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(name, env.home));
        log.push(`Saving to: ‘${name}’`);
        log.push('');
        try {
          fs.writeFile(dest, body);
        } catch (err) {
          log.push(`${name}: ${err && err.message ? err.message : 'Cannot write'}`);
          code = 3;
          continue;
        }
        const bar = `${'='.repeat(19)}>`;
        log.push(`${name.slice(0, 19).padEnd(19)} 100%[${bar}] ${(bytes / 1024).toFixed(2).padStart(7)}K  --.-KB/s    in 0s      `);
        log.push('');
        log.push(`${wgetStamp(new Date())} (24.5 MB/s) - ‘${name}’ saved [${bytes}/${bytes}]`);
        log.push('');
      }
    }

    return {
      stdout: stdout.join(''),
      stderr: quiet || log.length === 0 ? '' : `${log.join('\n')}\n`,
      code: aborted(ctx.signal) ? 130 : code,
    };
  },
};

/* ------------------------------------------------------------------ *
 * dig / nslookup / host
 * ------------------------------------------------------------------ */

const DIG_VERSION = '9.18.28-0ubuntu0.24.04.1';

/**
 * Synthesise the RRset for a query.
 * @param {string} name
 * @param {string} type
 * @param {{ip:string}} resolved
 * @returns {string[]} answer section rows
 */
function answerRows(name, type, resolved) {
  const fqdn = `${name.replace(/\.$/, '')}.`;
  const ttl = 60 + (fnv1a(name) % 3540);
  const h = fnv1a(`${name}:${type}`);
  switch (type) {
    case 'A':
      return [`${col(fqdn, 24)}${ttl}\tIN\tA\t${resolved.ip}`];
    case 'AAAA':
      return [`${col(fqdn, 24)}${ttl}\tIN\tAAAA\t2606:${(h & 0xffff).toString(16)}::${((h >>> 16) & 0xffff).toString(16)}`];
    case 'MX':
      return [
        `${col(fqdn, 24)}${ttl}\tIN\tMX\t10 mail1.${fqdn}`,
        `${col(fqdn, 24)}${ttl}\tIN\tMX\t20 mail2.${fqdn}`,
      ];
    case 'NS':
      return [
        `${col(fqdn, 24)}${ttl}\tIN\tNS\tns1.${fqdn}`,
        `${col(fqdn, 24)}${ttl}\tIN\tNS\tns2.${fqdn}`,
      ];
    case 'TXT':
      return [`${col(fqdn, 24)}${ttl}\tIN\tTXT\t"v=spf1 include:_spf.${fqdn} ~all"`];
    case 'CNAME':
      return [`${col(fqdn, 24)}${ttl}\tIN\tCNAME\twww.${fqdn}`];
    case 'SOA':
      return [`${col(fqdn, 24)}${ttl}\tIN\tSOA\tns1.${fqdn} hostmaster.${fqdn} ${2024000000 + (h % 999999)} 7200 3600 1209600 3600`];
    case 'PTR':
      return [`${col(fqdn, 24)}${ttl}\tIN\tPTR\t${reverseLookup(resolved.ip) || 'unknown'}.`];
    default:
      return [`${col(fqdn, 24)}${ttl}\tIN\tA\t${resolved.ip}`];
  }
}

/** `1.2.3.4` -> `4.3.2.1.in-addr.arpa` */
function toArpa(ip) {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
}

const digCommand = {
  name: 'dig',
  aliases: [],
  synopsis: 'dig [@server] [NAME] [TYPE] [+short] [+noall +answer] [-x ADDR]',
  description: 'DNS lookup utility',
  man: `NAME
       dig - DNS lookup utility

SYNOPSIS
       dig [@server] [name] [type] [queryopt...]
       dig -x addr [queryopt...]

DESCRIPTION
       dig is a flexible tool for interrogating DNS name servers. It performs
       DNS lookups and displays the answers that are returned from the
       name server(s) that were queried.

       Answers in this emulator are synthesised from a stable per-name hash, so
       the same query always produces the same record.

OPTIONS
       @server        The name server to query. Defaults to the first entry in
                      /etc/resolv.conf (${NAMESERVER}).

       -x addr        Simplified reverse lookup, for mapping addresses to
                      names.

       -t type        The resource record type to query.

QUERY OPTIONS
       +short         Provide a terse answer.
       +noall +answer Print only the answer section.
       +trace         Not supported by the emulator; treated as +noall +answer.`,
  async run(ctx) {
    const argv = ctx.argv;
    let server = NAMESERVER;
    let type = null;
    let name = null;
    let short = false;
    let answerOnly = false;
    let reverse = false;

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a.startsWith('@')) { server = a.slice(1); continue; }
      if (a === '-x') { reverse = true; name = argv[++i]; continue; }
      if (a === '-t') { type = String(argv[++i] || 'A').toUpperCase(); continue; }
      if (a === '-v' || a === '-version' || a === '--version') return ok(`DiG ${DIG_VERSION}\n`);
      if (a.startsWith('+')) {
        const opt = a.slice(1).toLowerCase();
        if (opt === 'short') short = true;
        else if (opt === 'answer' || opt === 'trace') answerOnly = true;
        else if (opt === 'noall') answerOnly = true;
        continue;
      }
      if (a.startsWith('-')) continue;
      if (name === null) { name = a; continue; }
      if (type === null) { type = a.toUpperCase(); continue; }
    }

    if (name === null) {
      return fail('dig: no name to look up\n', 1);
    }
    if (type === null) type = reverse ? 'PTR' : 'A';

    const queryName = reverse ? toArpa(name) : name;
    const resolved = reverse
      ? (isIpv4(name) ? { ip: name, canonical: name, literal: true } : null)
      : lookup(name);

    await wait(4 + (fnv1a(queryName) % 40), ctx.signal);

    const id = 1 + (fnv1a(`${queryName}${type}`) % 65534);
    const now = new Date();
    const queryTime = 1 + (fnv1a(queryName) % 60);

    if (!resolved) {
      if (short) return { stdout: '', stderr: '', code: 0 };
      const zone = queryName.split('.').slice(-1)[0];
      const lines = [
        `; <<>> DiG ${DIG_VERSION} <<>> ${type === 'A' ? '' : `${type} `}${name}`.replace(/ +$/, ''),
        ';; global options: +cmd',
        ';; Got answer:',
        `;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: ${id}`,
        ';; flags: qr rd ra ad; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1',
        '',
        ';; OPT PSEUDOSECTION:',
        '; EDNS: version: 0, flags:; udp: 65494',
        ';; QUESTION SECTION:',
        `;${queryName}.\t\t\tIN\t${type}`,
        '',
        ';; AUTHORITY SECTION:',
        `${col(`${zone}.`, 24)}900\tIN\tSOA\ta.root-servers.net. nstld.verisign-grs.com. 2026081800 1800 900 604800 86400`,
        '',
        `;; Query time: ${queryTime} msec`,
        `;; SERVER: ${server}#53(${server}) (UDP)`,
        `;; WHEN: ${digWhen(now)}`,
        `;; MSG SIZE  rcvd: ${110 + (fnv1a(queryName) % 20)}`,
        '',
      ];
      return { stdout: `\n${lines.join('\n')}\n`, stderr: '', code: 0 };
    }

    const answers = answerRows(queryName, type, resolved);

    if (short) {
      const values = answers.map((row) => row.split('\t').pop());
      return ok(`${values.join('\n')}\n`);
    }

    const answerBlock = [';; ANSWER SECTION:', ...answers, ''];
    if (answerOnly) return ok(`\n${answerBlock.join('\n')}\n`);

    const lines = [
      `; <<>> DiG ${DIG_VERSION} <<>> ${type === 'A' && !reverse ? '' : reverse ? '-x ' : `${type} `}${name}`.replace(/ +$/, ''),
      ';; global options: +cmd',
      ';; Got answer:',
      `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: ${id}`,
      `;; flags: qr rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1`,
      '',
      ';; OPT PSEUDOSECTION:',
      '; EDNS: version: 0, flags:; udp: 65494',
      ';; QUESTION SECTION:',
      `;${queryName}.\t\t\tIN\t${type}`,
      '',
      ...answerBlock,
      `;; Query time: ${queryTime} msec`,
      `;; SERVER: ${server}#53(${server}) (UDP)`,
      `;; WHEN: ${digWhen(now)}`,
      `;; MSG SIZE  rcvd: ${55 + answers.length * 16 + (fnv1a(queryName) % 12)}`,
      '',
    ];
    return ok(`\n${lines.join('\n')}\n`);
  },
};

const nslookupCommand = {
  name: 'nslookup',
  aliases: [],
  synopsis: 'nslookup [-type=TYPE] NAME [SERVER]',
  description: 'Query Internet name servers interactively',
  man: `NAME
       nslookup - query Internet name servers interactively

SYNOPSIS
       nslookup [-option] [name | -] [server]

DESCRIPTION
       Nslookup is a program to query Internet domain name servers.

OPTIONS
       -type=TYPE, -querytype=TYPE
              The record type to look up (A, AAAA, MX, NS, TXT, PTR).

       Interactive mode is not available in this emulator.`,
  async run(ctx) {
    const argv = ctx.argv;
    let type = 'A';
    let server = NAMESERVER;
    const operands = [];

    for (const a of argv) {
      if (a.startsWith('-type=') || a.startsWith('-querytype=') || a.startsWith('-q=')) {
        type = a.slice(a.indexOf('=') + 1).toUpperCase();
        continue;
      }
      if (a === '-version' || a === '--version') return ok('nslookup 9.18.28-0ubuntu0.24.04.1-Ubuntu\n');
      if (a.startsWith('-')) continue;
      operands.push(a);
    }

    const name = operands[0];
    if (name === undefined) {
      return fail('Usage: nslookup [-opt ...] # interactive mode\n       nslookup [-opt ...] host # just look up "host"\n', 1);
    }
    if (operands[1]) server = operands[1];

    await wait(6 + (fnv1a(name) % 30), ctx.signal);

    const head = `Server:\t\t${server}\nAddress:\t${server}#53\n\n`;

    if (isIpv4(name)) {
      const ptr = reverseLookup(name);
      if (!ptr) return { stdout: head, stderr: `** server can't find ${toArpa(name)}: NXDOMAIN\n`, code: 1 };
      return ok(`${head}${toArpa(name)}\tname = ${ptr}.\n\n`);
    }

    const resolved = lookup(name);
    if (!resolved) {
      return { stdout: head, stderr: `** server can't find ${name}: NXDOMAIN\n`, code: 1 };
    }

    if (type === 'MX') {
      return ok(`${head}Non-authoritative answer:\n${name}\tmail exchanger = 10 mail1.${name}.\n${name}\tmail exchanger = 20 mail2.${name}.\n\n`);
    }
    if (type === 'NS') {
      return ok(`${head}Non-authoritative answer:\n${name}\tnameserver = ns1.${name}.\n${name}\tnameserver = ns2.${name}.\n\n`);
    }
    if (type === 'TXT') {
      return ok(`${head}Non-authoritative answer:\n${name}\ttext = "v=spf1 include:_spf.${name} ~all"\n\n`);
    }

    const authoritative = resolved.ip.startsWith('127.') ? '' : 'Non-authoritative answer:\n';
    return ok(`${head}${authoritative}Name:\t${name}\nAddress: ${resolved.ip}\n\n`);
  },
};

const hostCommand = {
  name: 'host',
  aliases: [],
  synopsis: 'host [-t TYPE] NAME [SERVER]',
  description: 'DNS lookup utility',
  man: `NAME
       host - DNS lookup utility

SYNOPSIS
       host [-aCdlnrsTwv] [-t type] {name} [server]

DESCRIPTION
       host is a simple utility for performing DNS lookups. It is normally used
       to convert names to IP addresses and vice versa.

OPTIONS
       -t type   Query for the given record type.
       -a        Equivalent to -v -t ANY.
       -v        Verbose output.`,
  async run(ctx) {
    const argv = ctx.argv;
    let type = null;
    const operands = [];
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-t') { type = String(argv[++i] || 'A').toUpperCase(); continue; }
      if (a === '-a') { type = 'ANY'; continue; }
      if (a === '-V' || a === '--version') return ok('host 9.18.28-0ubuntu0.24.04.1-Ubuntu\n');
      if (a.startsWith('-')) continue;
      operands.push(a);
    }

    const name = operands[0];
    if (name === undefined) {
      return fail('Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]\n            [-R number] [-m flag] [-p port] hostname [server]\n', 1);
    }

    await wait(5 + (fnv1a(name) % 25), ctx.signal);

    if (isIpv4(name)) {
      const ptr = reverseLookup(name);
      if (!ptr) return fail(`Host ${toArpa(name)} not found: 3(NXDOMAIN)\n`, 1);
      return ok(`${toArpa(name)} domain name pointer ${ptr}.\n`);
    }

    const resolved = lookup(name);
    if (!resolved) return fail(`Host ${name} not found: 3(NXDOMAIN)\n`, 1);

    const lines = [];
    if (type === null || type === 'A' || type === 'ANY') lines.push(`${name} has address ${resolved.ip}`);
    if (type === 'AAAA' || type === 'ANY') {
      const h = fnv1a(name);
      lines.push(`${name} has IPv6 address 2606:${(h & 0xffff).toString(16)}::${((h >>> 16) & 0xffff).toString(16)}`);
    }
    if (type === null || type === 'MX' || type === 'ANY') {
      lines.push(`${name} mail is handled by 10 mail1.${name}.`);
      lines.push(`${name} mail is handled by 20 mail2.${name}.`);
    }
    if (type === 'NS') {
      lines.push(`${name} name server ns1.${name}.`);
      lines.push(`${name} name server ns2.${name}.`);
    }
    if (type === 'TXT') lines.push(`${name} descriptive text "v=spf1 include:_spf.${name} ~all"`);
    if (lines.length === 0) lines.push(`${name} has no ${type} record`);
    return ok(`${lines.join('\n')}\n`);
  },
};

/* ------------------------------------------------------------------ *
 * traceroute
 * ------------------------------------------------------------------ */

const tracerouteCommand = {
  name: 'traceroute',
  aliases: ['tracepath'],
  synopsis: 'traceroute [-n] [-m MAXHOPS] [-q NQUERIES] HOST',
  description: 'Print the route packets trace to network host',
  man: `NAME
       traceroute - print the route packets trace to network host

SYNOPSIS
       traceroute [options] host [packetlen]

DESCRIPTION
       traceroute tracks the route packets taken from an IP network on their
       way to a given host. It utilizes the IP protocol's time to live (TTL)
       field and attempts to elicit an ICMP TIME_EXCEEDED response from each
       gateway along the path to the host.

       The path shown by this emulator is synthesised from the destination
       address and is stable for a given host.

OPTIONS
       -n     Do not resolve IP addresses to their domain names.
       -m max_ttl
              Set the max number of hops (default 30).
       -q nqueries
              Set the number of probes per hop (default 3).`,
  async run(ctx) {
    const { flags, opts, rest } = simpleFlags(ctx.argv, new Set(['-m', '-q', '-w', '-f', '-p', '-i', '-s']));
    const target = rest[0];
    if (target === undefined) {
      return fail('Usage: traceroute [OPTION...] HOST\nTry \'traceroute --help\' for more information.\n', 2);
    }

    const resolved = lookup(target);
    if (!resolved) return fail(`traceroute: unknown host ${target}\n`, 2);

    const numeric = flags.has('-n');
    const maxHops = opts.has('-m') ? Math.max(1, Number(opts.get('-m')) || 30) : 30;
    const probes = opts.has('-q') ? Math.max(1, Number(opts.get('-q')) || 3) : 3;

    const profile = latencyProfile(resolved.ip);
    const hopCount = Math.min(maxHops, profile.hops);

    const out = [];
    const emit = (line) => { out.push(line); ctx.term.write(`${line}\n`); };

    emit(`traceroute to ${target} (${resolved.ip}), ${maxHops} hops max, 60 byte packets`);

    /** Deterministic transit addresses for the middle of the path. */
    const hopAddress = (n) => {
      if (n === 1) return { ip: GATEWAY, name: '_gateway' };
      if (n === hopCount) return { ip: resolved.ip, name: resolved.literal ? resolved.ip : resolved.canonical };
      const h = fnv1a(`${resolved.ip}#${n}`);
      const ip = `${[62, 77, 129, 149, 195, 212][h % 6]}.${(h >>> 8) & 0xff}.${(h >>> 16) & 0xff}.${1 + ((h >>> 24) % 254)}`;
      return { ip, name: `ae${n}-${h % 40}.cr${n}.lon${n % 4}.core.example-transit.net` };
    };

    for (let hop = 1; hop <= hopCount; hop += 1) {
      if (aborted(ctx.signal)) break;
      await wait(180, ctx.signal);
      if (aborted(ctx.signal)) break;

      const h = fnv1a(`${resolved.ip}!${hop}`);
      /** One transit hop in eight refuses to answer, exactly like the real thing. */
      if (hop > 1 && hop < hopCount && h % 11 === 0) {
        emit(`${String(hop).padStart(2)}  ${Array.from({ length: probes }, () => '*').join(' ')}`);
        continue;
      }

      const { ip, name } = hopAddress(hop);
      /* The first hop is the LAN gateway; latency ramps to the target's. */
      const span = Math.max(1, hopCount - 1);
      const base = 0.42 + ((profile.base - 0.42) * (hop - 1)) / span;
      const timings = [];
      for (let p = 0; p < probes; p += 1) {
        timings.push(`${ms3(Math.max(0.05, base + (Math.random() - 0.4) * base * 0.12))} ms`);
      }
      const label = numeric ? ip : `${name} (${ip})`;
      emit(`${String(hop).padStart(2)}  ${label}  ${timings.join('  ')}`);
    }

    return { stdout: '', stderr: '', code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * arp / route / nmcli
 * ------------------------------------------------------------------ */

const arpCommand = {
  name: 'arp',
  aliases: [],
  synopsis: 'arp [-a] [-n] [HOST]',
  description: 'Manipulate the system ARP cache',
  man: `NAME
       arp - manipulate the system ARP cache

SYNOPSIS
       arp [-vn] [-i if] [-a] [hostname]

DESCRIPTION
       Arp manipulates or displays the kernel's IPv4 network neighbour cache.

OPTIONS
       -a     Use alternate BSD style output format (with no fixed columns).
       -n     Show numerical addresses instead of trying to determine symbolic
              host names.

NOTE
       This program is obsolete. Use ip neigh instead.`,
  async run(ctx) {
    const { flags, rest } = simpleFlags(ctx.argv);
    const bsd = flags.has('-a');
    const numeric = flags.has('-n');
    const wanted = rest[0];

    let list = NEIGHBOURS;
    if (wanted) {
      const resolved = lookup(wanted);
      list = NEIGHBOURS.filter((n) => n.ip === wanted || n.name === wanted || (resolved && n.ip === resolved.ip));
      if (list.length === 0) return fail(`${wanted} (${(lookup(wanted) || { ip: wanted }).ip}) -- no entry\n`, 1);
    }

    if (bsd) {
      const lines = list.map((n) => `${numeric ? n.ip : n.name} (${n.ip}) at ${n.mac} [ether] on ${n.dev}`);
      return ok(`${lines.join('\n')}\n`);
    }

    const lines = ['Address                  HWtype  HWaddress           Flags Mask            Iface'];
    for (const n of list) {
      lines.push(`${col(numeric ? n.ip : n.name, 25)}${col('ether', 8)}${col(n.mac, 20)}${col('C', 22)}${n.dev}`);
    }
    return ok(`${lines.join('\n')}\n`);
  },
};

const routeCommand = {
  name: 'route',
  aliases: [],
  synopsis: 'route [-n] [-e]',
  description: 'Show / manipulate the IP routing table',
  man: `NAME
       route - show / manipulate the IP routing table

SYNOPSIS
       route [-CFvnee]
       route [-v] [-A family] add|del [-net|-host] target ...

DESCRIPTION
       route manipulates the kernel's IP routing tables. This emulator is
       read-only: add and del are refused.

OPTIONS
       -n     Show numerical addresses instead of trying to determine symbolic
              host names.

NOTE
       This program is obsolete. Use ip route instead.`,
  async run(ctx) {
    const { flags, rest } = simpleFlags(ctx.argv);
    if (rest[0] === 'add' || rest[0] === 'del' || rest[0] === 'delete') {
      return fail('SIOCADDRT: Operation not permitted\n', 7);
    }
    if (flags.has('-V') || flags.has('--version')) return ok('net-tools 2.10-alpha\n');
    return ok(netstatRoutes(flags.has('-n')));
  },
};

/** IFACES in nmcli's display order. */
function nmDevices() {
  return NM_ORDER.map((name) => IFACES.find((i) => i.name === name)).filter(Boolean);
}

const NMCLI_UUIDS = {
  'Wired connection 1': 'd6c2f9e1-5a44-4b71-9f2e-8b1c3a7d5e02',
  docker0: '9b41e7c8-2f60-4d3a-8e15-c07a94b6d331',
  lo: '02f2a1d6-7c39-4e58-b0a4-1d6e8f3c9b47',
};

const nmcliCommand = {
  name: 'nmcli',
  aliases: [],
  synopsis: 'nmcli [general|networking|device|connection] [status|show|...]',
  description: "Command-line tool for controlling NetworkManager",
  man: `NAME
       nmcli - command-line tool for controlling NetworkManager

SYNOPSIS
       nmcli [OPTIONS] OBJECT { COMMAND | help }
       OBJECT := { general | networking | radio | connection | device }

DESCRIPTION
       nmcli is a command-line tool for controlling NetworkManager and
       reporting network status.

       This emulator implements the read-only status subcommands. Anything that
       would change the configuration reports that the operation is not
       permitted.

OBJECTS
       general (g)     NetworkManager's general status and operations
       networking (n)  overall networking control
       radio (r)       NetworkManager radio switches
       connection (c)  NetworkManager's connections
       device (d)      devices managed by NetworkManager`,
  async run(ctx) {
    const argv = ctx.argv.filter((a) => a !== '-t' && a !== '--terse' && a !== '-p' && a !== '--pretty');
    if (argv.includes('-v') || argv.includes('--version')) return ok('nmcli tool, version 1.46.0\n');

    const object = (argv[0] || 'general').toLowerCase();
    const verb = (argv[1] || '').toLowerCase();

    const mutating = ['up', 'down', 'add', 'delete', 'modify', 'edit', 'clone', 'reload', 'set', 'connect', 'disconnect'];
    if (mutating.includes(verb)) {
      return fail('Error: Could not create NMClient object: Operation not permitted by the desktop emulator.\n', 1);
    }

    if (['g', 'gen', 'general'].includes(object)) {
      if (verb === 'hostname') return ok(`${users.hostname}\n`);
      return ok(
        'STATE      CONNECTIVITY  WIFI-HW  WIFI     WWAN-HW  WWAN    \n'
        + 'connected  full          enabled  enabled  enabled  enabled \n',
      );
    }

    if (['n', 'net', 'networking'].includes(object)) {
      if (verb === 'connectivity') return ok('full\n');
      return ok('enabled\n');
    }

    if (['r', 'radio'].includes(object)) {
      return ok('WIFI-HW  WIFI     WWAN-HW  WWAN    \nenabled  enabled  enabled  enabled \n');
    }

    if (['d', 'dev', 'device'].includes(object)) {
      if (verb === 'wifi') {
        return ok(
          'IN-USE  BSSID              SSID              MODE   CHAN  RATE        SIGNAL  BARS  SECURITY \n'
          + '*       3C:37:86:2B:1F:04  home-wifi         Infra  6     130 Mbit/s  92      ▂▄▆█  WPA2     \n'
          + '        7A:11:C4:9E:02:5D  home-wifi-5G      Infra  44    405 Mbit/s  74      ▂▄▆_  WPA2 WPA3\n'
          + '        E4:8D:8C:B7:63:21  Neighbour-2.4     Infra  11    130 Mbit/s  41      ▂▄__  WPA2     \n',
        );
      }
      if (verb === 'show') {
        const lines = [];
        for (const i of nmDevices()) {
          lines.push(`GENERAL.DEVICE:                         ${i.name}`);
          lines.push(`GENERAL.TYPE:                           ${i.nmType}`);
          lines.push(`GENERAL.HWADDR:                         ${i.mac.toUpperCase()}`);
          lines.push(`GENERAL.MTU:                            ${i.mtu}`);
          lines.push(`GENERAL.STATE:                          ${i.operUp ? '100 (connected)' : '20 (unavailable)'}`);
          lines.push(`GENERAL.CONNECTION:                     ${i.nmConnection}`);
          if (i.inet) {
            lines.push(`IP4.ADDRESS[1]:                         ${i.inet.addr}/${i.inet.prefix}`);
            if (i.name === 'enp0s3') {
              lines.push(`IP4.GATEWAY:                            ${GATEWAY}`);
              lines.push(`IP4.DNS[1]:                             ${NAMESERVER}`);
            } else {
              lines.push('IP4.GATEWAY:                            --');
            }
          }
          lines.push('');
        }
        return ok(`${lines.join('\n')}`);
      }
      return ok(
        'DEVICE   TYPE      STATE                   CONNECTION         \n'
        + nmDevices().map((i) => `${col(i.name, 9)}${col(i.nmType, 10)}${col(i.nmState, 24)}${col(i.nmConnection, 19)}`).join('\n')
        + '\n',
      );
    }

    if (['c', 'con', 'conn', 'connection'].includes(object)) {
      const rows = nmDevices().map((i) => `${col(i.nmConnection, 20)}${col(NMCLI_UUIDS[i.nmConnection] || NMCLI_UUIDS.lo, 38)}${col(i.nmType, 10)}${col(i.name, 8)}`);
      return ok(`NAME                UUID                                  TYPE      DEVICE  \n${rows.join('\n')}\n`);
    }

    if (object === 'help' || object === '--help' || object === '-h') {
      return ok('Usage: nmcli [OPTIONS] OBJECT { COMMAND | help }\n\nOBJECT\n  g[eneral]       NetworkManager\'s general status and operations\n  n[etworking]    overall networking control\n  r[adio]         NetworkManager radio switches\n  c[onnection]    NetworkManager\'s connections\n  d[evice]        devices managed by NetworkManager\n');
    }

    return fail(`Error: Object '${object}' is unknown, try 'nmcli help'.\n`, 2);
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const netCommands = [
  pingCommand,
  ifconfigCommand,
  ipCommand,
  netstatCommand,
  ssCommand,
  curlCommand,
  wgetCommand,
  digCommand,
  nslookupCommand,
  hostCommand,
  tracerouteCommand,
  arpCommand,
  routeCommand,
  nmcliCommand,
];

export default netCommands;
