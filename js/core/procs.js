/**
 * js/core/procs.js — simulated process table (ARCHITECTURE §9).
 *
 * Backs `ps`, `top`, `kill`, `pidof`, `uptime`, `free`, the System Monitor and
 * the generated `/proc` files. `tick()` is driven by a single 1s interval in
 * `js/main.js`; it random-walks each process inside believable bounds and
 * feeds an exponentially smoothed load average, exactly like the kernel does.
 */

import { bus } from './bus.js';
import { device } from './device.js';

/**
 * Logical CPUs reported everywhere (`/proc/cpuinfo`, `nproc`, `lscpu`, `top`,
 * the Resources tab). This is the host's real `navigator.hardwareConcurrency`,
 * clamped only to keep the simulation sane: a browser that reports 0 or a
 * nonsense figure must not produce a zero-core machine or 4096 chart traces.
 */
export const CORES = Math.min(256, Math.max(1, Math.round(device.cores()) || 1));

/**
 * Total RAM in MiB, from `navigator.deviceMemory` via device.js.
 *
 * That figure is bucketed and capped at 8 GiB by spec, so it is a *lower
 * bound*, never a measurement — anything user-facing must say so (the About
 * page uses `device.memoryLabel()` for exactly this reason). The floor below
 * exists because the baseline daemon table alone occupies ~1.9 GiB; a machine
 * reporting 0.25 GiB would otherwise be permanently over-committed.
 */
const MEM_TOTAL_MB = Math.max(2048, Math.round(device.memTotalMib()) || 8192);

/**
 * Ubuntu 24.04's installer sizes the swap file at roughly a quarter of RAM,
 * bounded either side. At 8 GiB that reproduces the usual 2 GiB swapfile.
 */
const SWAP_TOTAL_MB = Math.min(8192, Math.max(512, Math.round(MEM_TOTAL_MB / 4)));

/**
 * Memory attributed to the kernel, slab and tmpfs — not to any one process.
 * Scales with RAM the way slab and page tables really do (~7.5% of total,
 * which is the 612 MiB the 8 GiB baseline used to hard-code).
 */
const KERNEL_MB = Math.max(192, Math.round(MEM_TOTAL_MB * 0.0747));

/** The machine "booted" 2h 41m before the page loaded. */
const INITIAL_UPTIME_MS = (2 * 3600 + 41 * 60 + 13) * 1000;
const BOOT_TIME = Date.now() - INITIAL_UPTIME_MS;

/** Load-average smoothing constants for a 1 second sampling interval. */
const EXP_1 = Math.exp(-1 / 60);
const EXP_5 = Math.exp(-1 / 300);
const EXP_15 = Math.exp(-1 / 900);

/**
 * Baseline daemons of a freshly logged-in Ubuntu 24.04 GNOME session.
 * `cpu` is top-style %CPU (percent of a single core); `mem` is RSS in MiB.
 * `drift` bounds the random walk; `peak` is the highest %CPU it may reach.
 * @type {{pid:number, ppid:number, user:string, name:string, cmd:string,
 *         cpu:number, mem:number, state:string, peak:number, kernel?:boolean}[]}
 */
const BASELINE = [
  { pid: 1, ppid: 0, user: 'root', name: 'systemd', cmd: '/sbin/init splash', cpu: 0.1, mem: 12.4, state: 'S', peak: 1.2 },
  { pid: 2, ppid: 0, user: 'root', name: 'kthreadd', cmd: '[kthreadd]', cpu: 0.0, mem: 0, state: 'S', peak: 0.2, kernel: true },
  { pid: 3, ppid: 2, user: 'root', name: 'rcu_gp', cmd: '[rcu_gp]', cpu: 0.0, mem: 0, state: 'I', peak: 0.1, kernel: true },
  { pid: 11, ppid: 2, user: 'root', name: 'ksoftirqd/0', cmd: '[ksoftirqd/0]', cpu: 0.0, mem: 0, state: 'S', peak: 0.6, kernel: true },
  { pid: 13, ppid: 2, user: 'root', name: 'rcu_preempt', cmd: '[rcu_preempt]', cpu: 0.1, mem: 0, state: 'I', peak: 1.0, kernel: true },
  { pid: 96, ppid: 2, user: 'root', name: 'kworker/u17:2-events_unbound', cmd: '[kworker/u17:2-events_unbound]', cpu: 0.0, mem: 0, state: 'I', peak: 1.4, kernel: true },
  { pid: 312, ppid: 1, user: 'root', name: 'systemd-journald', cmd: '/usr/lib/systemd/systemd-journald', cpu: 0.2, mem: 42.8, state: 'S', peak: 2.4 },
  { pid: 345, ppid: 1, user: 'root', name: 'systemd-udevd', cmd: '/usr/lib/systemd/systemd-udevd', cpu: 0.0, mem: 14.2, state: 'S', peak: 1.1 },
  { pid: 612, ppid: 1, user: 'systemd-resolve', name: 'systemd-resolved', cmd: '/usr/lib/systemd/systemd-resolved', cpu: 0.0, mem: 17.6, state: 'S', peak: 0.9 },
  { pid: 618, ppid: 1, user: 'systemd-network', name: 'systemd-networkd', cmd: '/usr/lib/systemd/systemd-networkd', cpu: 0.0, mem: 11.3, state: 'S', peak: 0.7 },
  { pid: 640, ppid: 1, user: 'systemd-oom', name: 'systemd-oomd', cmd: '/usr/lib/systemd/systemd-oomd', cpu: 0.0, mem: 7.1, state: 'S', peak: 0.5 },
  { pid: 701, ppid: 1, user: 'messagebus', name: 'dbus-daemon', cmd: '/usr/bin/dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only', cpu: 0.3, mem: 8.9, state: 'S', peak: 3.0 },
  { pid: 745, ppid: 1, user: 'root', name: 'NetworkManager', cmd: '/usr/sbin/NetworkManager --no-daemon', cpu: 0.1, mem: 24.1, state: 'S', peak: 1.8 },
  { pid: 752, ppid: 1, user: 'avahi', name: 'avahi-daemon', cmd: 'avahi-daemon: running [ubuntu-ai.local]', cpu: 0.0, mem: 3.6, state: 'S', peak: 0.4 },
  { pid: 758, ppid: 1, user: 'syslog', name: 'rsyslogd', cmd: '/usr/sbin/rsyslogd -n -iNONE', cpu: 0.0, mem: 6.2, state: 'S', peak: 0.8 },
  { pid: 760, ppid: 1, user: 'root', name: 'cron', cmd: '/usr/sbin/cron -f -P', cpu: 0.0, mem: 3.4, state: 'S', peak: 0.3 },
  { pid: 766, ppid: 1, user: 'root', name: 'polkitd', cmd: '/usr/lib/polkit-1/polkitd --no-debug', cpu: 0.0, mem: 12.8, state: 'S', peak: 0.6 },
  { pid: 774, ppid: 1, user: 'root', name: 'udisksd', cmd: '/usr/libexec/udisks2/udisksd', cpu: 0.0, mem: 15.7, state: 'S', peak: 0.7 },
  { pid: 781, ppid: 1, user: 'root', name: 'ModemManager', cmd: '/usr/sbin/ModemManager', cpu: 0.0, mem: 13.9, state: 'S', peak: 0.5 },
  { pid: 789, ppid: 1, user: 'root', name: 'bluetoothd', cmd: '/usr/libexec/bluetooth/bluetoothd', cpu: 0.0, mem: 5.8, state: 'S', peak: 0.5 },
  { pid: 812, ppid: 1, user: 'root', name: 'snapd', cmd: '/usr/lib/snapd/snapd', cpu: 0.4, mem: 62.5, state: 'S', peak: 4.5 },
  { pid: 830, ppid: 1, user: 'root', name: 'accounts-daemon', cmd: '/usr/libexec/accounts-daemon', cpu: 0.0, mem: 9.2, state: 'S', peak: 0.5 },
  { pid: 923, ppid: 1, user: 'root', name: 'gdm3', cmd: '/usr/sbin/gdm3', cpu: 0.0, mem: 9.8, state: 'S', peak: 0.4 },
  { pid: 1041, ppid: 923, user: 'root', name: 'gdm-session-wor', cmd: 'gdm-session-worker [pam/gdm-password]', cpu: 0.0, mem: 8.4, state: 'S', peak: 0.4 },
  { pid: 1104, ppid: 1041, user: 'root', name: 'Xorg', cmd: '/usr/lib/xorg/Xorg vt2 -displayfd 3 -auth /run/user/1000/gdm/Xauthority -background none -noreset -keeptty -verbose 3', cpu: 1.8, mem: 138.4, state: 'S', peak: 22.0 },
  { pid: 1240, ppid: 1, user: 'ubuntu', name: 'systemd', cmd: '/usr/lib/systemd/systemd --user', cpu: 0.1, mem: 11.7, state: 'S', peak: 1.4 },
  { pid: 1242, ppid: 1240, user: 'ubuntu', name: '(sd-pam)', cmd: '(sd-pam)', cpu: 0.0, mem: 2.6, state: 'S', peak: 0.1 },
  { pid: 1387, ppid: 1104, user: 'ubuntu', name: 'gnome-shell', cmd: '/usr/bin/gnome-shell', cpu: 3.4, mem: 412.7, state: 'S', peak: 38.0 },
  { pid: 1420, ppid: 1240, user: 'ubuntu', name: 'gsd-media-keys', cmd: '/usr/libexec/gsd-media-keys', cpu: 0.0, mem: 27.4, state: 'S', peak: 1.2 },
  { pid: 1425, ppid: 1240, user: 'ubuntu', name: 'gsd-power', cmd: '/usr/libexec/gsd-power', cpu: 0.0, mem: 25.9, state: 'S', peak: 1.0 },
  { pid: 1432, ppid: 1240, user: 'ubuntu', name: 'gsd-color', cmd: '/usr/libexec/gsd-color', cpu: 0.0, mem: 22.1, state: 'S', peak: 0.9 },
  { pid: 1502, ppid: 1240, user: 'ubuntu', name: 'pipewire', cmd: '/usr/bin/pipewire', cpu: 0.6, mem: 12.6, state: 'S', peak: 5.0 },
  { pid: 1508, ppid: 1240, user: 'ubuntu', name: 'wireplumber', cmd: '/usr/bin/wireplumber', cpu: 0.4, mem: 18.9, state: 'S', peak: 3.5 },
  { pid: 1601, ppid: 1387, user: 'ubuntu', name: 'gjs', cmd: '/usr/bin/gjs /usr/share/gnome-shell/extensions/ding@rastersoft.com/ding.js -E -P /usr/share/gnome-shell/extensions/ding@rastersoft.com/', cpu: 0.3, mem: 88.5, state: 'S', peak: 6.0 },
  { pid: 1650, ppid: 1240, user: 'ubuntu', name: 'nautilus', cmd: '/usr/bin/nautilus --gapplication-service', cpu: 0.1, mem: 96.2, state: 'S', peak: 8.0 },
  { pid: 1702, ppid: 1240, user: 'ubuntu', name: 'tracker-miner-f', cmd: '/usr/libexec/tracker-miner-fs-3', cpu: 0.2, mem: 46.8, state: 'S', peak: 12.0 },
  { pid: 1744, ppid: 1240, user: 'ubuntu', name: 'ibus-daemon', cmd: 'ibus-daemon --panel disable -r --xim', cpu: 0.0, mem: 17.3, state: 'S', peak: 1.0 },
  { pid: 1980, ppid: 1240, user: 'ubuntu', name: 'update-notifier', cmd: '/usr/bin/update-notifier', cpu: 0.0, mem: 33.5, state: 'S', peak: 1.5 },
  { pid: 2413, ppid: 1240, user: 'ubuntu', name: 'gnome-terminal-', cmd: '/usr/libexec/gnome-terminal-server', cpu: 0.5, mem: 74.3, state: 'S', peak: 9.0 },
];

/** @type {Map<number, object>} */
const table = new Map();

/** appId or instanceId -> pids to reap when the window closes. */
const windowBinds = new Map();

let nextPid = 2500;
let lastTickAt = Date.now();
let load = [0.42, 0.38, 0.31];
let swapUsedMb = 0;
let perCoreLoad = new Array(CORES).fill(2);
let contextSwitches = 4821334;
let forksTotal = 51844;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function allocPid() {
  do {
    nextPid += 1 + Math.floor(Math.random() * 3);
    if (nextPid > 4194304) nextPid = 2500;
  } while (table.has(nextPid));
  return nextPid;
}

function makeProc(spec) {
  return {
    pid: spec.pid,
    ppid: spec.ppid,
    user: spec.user,
    name: spec.name,
    cmd: spec.cmd,
    cpu: spec.cpu,
    mem: spec.mem,
    state: spec.state || 'S',
    startedAt: spec.startedAt === undefined ? BOOT_TIME : spec.startedAt,
    cpuTime: spec.cpuTime === undefined ? (Date.now() - BOOT_TIME) / 1000 * (spec.cpu / 100) : spec.cpuTime,
    peak: spec.peak === undefined ? Math.max(2, spec.cpu * 4) : spec.peak,
    baseCpu: spec.cpu,
    baseMem: spec.mem,
    kernel: spec.kernel === true,
    nice: spec.nice === undefined ? 0 : spec.nice,
    prio: spec.prio === undefined ? 20 : spec.prio,
    threads: spec.threads === undefined ? (spec.kernel ? 1 : 1 + Math.floor(Math.random() * 12)) : spec.threads,
  };
}

function seedBaseline() {
  table.clear();
  for (const spec of BASELINE) table.set(spec.pid, makeProc(spec));
}

seedBaseline();

/**
 * Random-walk a value toward its baseline with occasional bursts.
 * @param {number} current
 * @param {number} base
 * @param {number} peak
 * @returns {number}
 */
function walkCpu(current, base, peak) {
  const pull = (base - current) * 0.18;
  const noise = (Math.random() - 0.5) * Math.max(0.4, base * 0.9);
  let next = current + pull + noise;
  if (Math.random() < 0.02) next += Math.random() * (peak - base) * 0.8;
  return clamp(round1(next), 0, peak);
}

function walkMem(current, base) {
  if (base === 0) return 0;
  const pull = (base - current) * 0.06;
  const noise = (Math.random() - 0.5) * Math.max(0.2, base * 0.012);
  return clamp(round1(current + pull + noise), base * 0.85, base * 1.35);
}

export const procs = {
  /** Epoch ms the simulated machine booted. */
  bootTime: BOOT_TIME,

  /** Logical CPU count. */
  cores: CORES,

  /** @returns {number} seconds since boot */
  uptime() {
    return (Date.now() - BOOT_TIME) / 1000;
  },

  /**
   * Create a process.
   * @param {{name:string, cmd?:string, user?:string, cpu?:number, mem?:number,
   *          ppid?:number, state?:string, nice?:number}} spec
   * @returns {number} pid
   */
  spawn({ name, cmd, user = 'ubuntu', cpu = 0, mem = 0, ppid = 1, state = 'S', nice = 0 } = {}) {
    if (!name) throw new TypeError('procs.spawn: name is required');
    const pid = allocPid();
    const proc = makeProc({
      pid,
      ppid,
      user,
      name,
      cmd: cmd || name,
      cpu,
      mem,
      state,
      nice,
      startedAt: Date.now(),
      cpuTime: 0,
      peak: Math.max(4, cpu * 6),
    });
    table.set(pid, proc);
    forksTotal += 1;
    bus.emit('proc:spawn', { pid, name });
    return pid;
  },

  /**
   * Send a signal. Signal 0 only probes for existence.
   * SIGSTOP/SIGCONT change state; everything else terminates.
   * @param {number} pid
   * @param {number} [signal]
   * @returns {boolean} true when the signal was delivered
   */
  kill(pid, signal = 15) {
    const key = Number(pid);
    const proc = table.get(key);
    if (!proc) return false;
    if (signal === 0) return true;
    if (signal === 19 || signal === 23 || signal === 24) {
      proc.state = 'T';
      return true;
    }
    if (signal === 18) {
      proc.state = 'S';
      return true;
    }
    // init and kthreadd ignore every fatal signal, exactly like the real kernel.
    if (key === 1 || key === 2) return false;
    table.delete(key);
    for (const [bindKey, pids] of windowBinds) {
      const idx = pids.indexOf(key);
      if (idx >= 0) {
        pids.splice(idx, 1);
        if (pids.length === 0) windowBinds.delete(bindKey);
      }
    }
    bus.emit('proc:exit', { pid: key, name: proc.name });
    return true;
  },

  /**
   * @param {number} pid
   * @returns {object|null} a copy of the process record
   */
  get(pid) {
    const proc = table.get(Number(pid));
    return proc ? publicView(proc) : null;
  },

  /**
   * Exact-name lookup (also matches the basename of the command line),
   * which is what `pidof` and `pkill` need.
   * @param {string} name
   * @returns {object[]}
   */
  find(name) {
    if (!name) return [];
    const needle = String(name);
    const out = [];
    for (const proc of table.values()) {
      const cmdBase = proc.cmd.split(' ')[0].split('/').pop();
      if (proc.name === needle || cmdBase === needle) out.push(publicView(proc));
    }
    return out.sort((a, b) => a.pid - b.pid);
  },

  /**
   * Substring search, used by `pkill -f` and the System Monitor filter box.
   * @param {string} needle
   * @returns {object[]}
   */
  search(needle) {
    if (!needle) return [];
    const q = String(needle).toLowerCase();
    const out = [];
    for (const proc of table.values()) {
      if (proc.name.toLowerCase().includes(q) || proc.cmd.toLowerCase().includes(q)) {
        out.push(publicView(proc));
      }
    }
    return out.sort((a, b) => a.pid - b.pid);
  },

  /** @returns {object[]} every process, ordered by pid */
  list() {
    return Array.from(table.values())
      .sort((a, b) => a.pid - b.pid)
      .map(publicView);
  },

  /**
   * Aggregate system statistics.
   * @returns {{cpu:number, memUsedMb:number, memTotalMb:number,
   *            swapUsedMb:number, swapTotalMb:number, procCount:number,
   *            threadCount:number, load:number[]}}
   */
  totals() {
    let cpuSum = 0;
    let memSum = 0;
    let threads = 0;
    for (const proc of table.values()) {
      cpuSum += proc.cpu;
      memSum += proc.mem;
      threads += proc.threads;
    }
    return {
      cpu: clamp(round1(cpuSum / CORES), 0, 100),
      // Never report more in use than exists — /proc/meminfo and free(1) both
      // derive their free/available columns by subtracting from the total.
      memUsedMb: Math.min(MEM_TOTAL_MB, Math.round(memSum + KERNEL_MB)),
      memTotalMb: MEM_TOTAL_MB,
      swapUsedMb: Math.round(swapUsedMb),
      swapTotalMb: SWAP_TOTAL_MB,
      procCount: table.size,
      threadCount: threads,
      load: load.slice(),
    };
  },

  /** @returns {number[]} per-core utilisation percentages */
  perCore() {
    return perCoreLoad.map((v) => clamp(round1(v), 0, 100));
  },

  /** @returns {number[]} the 1/5/15 minute load averages */
  load() {
    return load.slice();
  },

  /** Extra counters consumed by `/proc/stat`-style output. */
  counters() {
    return { contextSwitches, forksTotal, bootTime: BOOT_TIME };
  },

  /**
   * Advance the simulation one step. Called once per second from main.js.
   */
  tick() {
    const now = Date.now();
    const dt = Math.max(0.05, Math.min(5, (now - lastTickAt) / 1000));
    lastTickAt = now;

    let cpuSum = 0;
    for (const proc of table.values()) {
      if (proc.state === 'T' || proc.state === 'Z') {
        proc.cpu = 0;
        continue;
      }
      proc.cpu = walkCpu(proc.cpu, proc.baseCpu, proc.peak);
      proc.mem = walkMem(proc.mem, proc.baseMem);
      proc.cpuTime += (proc.cpu / 100) * dt;
      proc.state = proc.cpu > proc.peak * 0.6 ? 'R' : proc.kernel ? (proc.baseCpu > 0 ? 'I' : 'S') : 'S';
      cpuSum += proc.cpu;
    }

    const utilisation = clamp(cpuSum / CORES, 0, 100);

    // Runnable-task estimate feeding the load average, plus rare queue spikes.
    let runq = (utilisation / 100) * CORES;
    if (Math.random() < 0.05) runq += Math.random() * 1.6;

    load = [
      round2(load[0] * EXP_1 + runq * (1 - EXP_1)),
      round2(load[1] * EXP_5 + runq * (1 - EXP_5)),
      round2(load[2] * EXP_15 + runq * (1 - EXP_15)),
    ];

    // Spread the aggregate across cores with per-core inertia so the System
    // Monitor draws eight distinct but correlated traces.
    for (let i = 0; i < CORES; i += 1) {
      const target = clamp(utilisation * (0.45 + Math.random() * 1.35), 0, 100);
      perCoreLoad[i] = perCoreLoad[i] * 0.72 + target * 0.28;
    }

    // Swap creeps up under memory pressure and never comes back down quickly.
    const memPct = (procs.totals().memUsedMb / MEM_TOTAL_MB) * 100;
    if (memPct > 82) swapUsedMb = Math.min(SWAP_TOTAL_MB, swapUsedMb + Math.random() * 3);
    else if (swapUsedMb > 0) swapUsedMb = Math.max(0, swapUsedMb - Math.random() * 0.2);

    contextSwitches += Math.round(1800 + utilisation * 260 + Math.random() * 900);
  },

  /**
   * Tie a window to one or more pids so closing the window reaps them.
   * @param {string} appId app id or window instance id
   * @param {number} pid
   */
  bindWindow(appId, pid) {
    if (!appId || !Number.isFinite(Number(pid))) return;
    const key = String(appId);
    const list = windowBinds.get(key) || [];
    if (!list.includes(Number(pid))) list.push(Number(pid));
    windowBinds.set(key, list);
  },

  /**
   * Kill every process bound to a window key. Called automatically on
   * `win:close`, exposed for explicit teardown.
   * @param {string} appId
   */
  unbindWindow(appId) {
    const key = String(appId);
    const list = windowBinds.get(key);
    if (!list) return;
    windowBinds.delete(key);
    for (const pid of list.slice()) procs.kill(pid, 15);
  },

  /** Restore the pristine boot-time process table. */
  reset() {
    seedBaseline();
    windowBinds.clear();
    load = [0.42, 0.38, 0.31];
    swapUsedMb = 0;
    perCoreLoad = new Array(CORES).fill(2);
  },
};

function round2(v) {
  return Math.round(v * 100) / 100;
}

function publicView(proc) {
  return {
    pid: proc.pid,
    ppid: proc.ppid,
    user: proc.user,
    name: proc.name,
    cmd: proc.cmd,
    cpu: proc.cpu,
    mem: proc.mem,
    state: proc.state,
    startedAt: proc.startedAt,
    cpuTime: proc.cpuTime,
    nice: proc.nice,
    prio: proc.prio,
    threads: proc.threads,
    kernel: proc.kernel,
  };
}

// Closing a window reaps whatever it spawned.
bus.on('win:close', (payload) => {
  if (!payload) return;
  if (payload.instanceId) procs.unbindWindow(payload.instanceId);
  if (payload.appId) procs.unbindWindow(payload.appId);
});
