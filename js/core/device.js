/**
 * device.js — real hardware facts about the machine the browser is running on.
 *
 * Everything the desktop reports about "this computer" comes from here: the
 * About page, /proc/cpuinfo, /proc/meminfo, lscpu, free, df, neofetch and the
 * System Monitor. Before this module those were invented constants, so the
 * emulator claimed to be a Dell XPS 13 with 8 GiB on every machine.
 *
 * HONESTY RULES
 * -------------
 * Browsers expose a deliberately narrow, partly fuzzed view of the host, so:
 *
 *  - `navigator.deviceMemory` is bucketed and capped at 8 GiB by the spec. A
 *    32 GiB machine reports 8. It is a lower bound, never an exact figure.
 *  - `navigator.storage.estimate()` reports the *browser's storage quota*, not
 *    the size of the disk. It is typically a fraction of free space.
 *  - The exact CPU model string is not exposed to web content at all. The best
 *    available is architecture plus core count.
 *  - The GPU string comes from WEBGL_debug_renderer_info, which some browsers
 *    (and Firefox's resistFingerprinting) mask or refuse outright.
 *
 * Every field therefore carries an `exact` flag. Callers that render a value a
 * user might act on must not present an inexact figure as measured fact — the
 * About page marks them with "at least" / "reported as" wording, and `lscpu`
 * and friends fall back to a plausible simulated value only where the real one
 * is genuinely unavailable.
 *
 * Some sources are async (storage quota, battery, high-entropy UA data). They
 * are probed once at boot; until they land, `info()` returns the synchronous
 * subset with `pending: true`. Commands can call `info()` freely and await
 * `ready()` when they want the full picture.
 */

import { bus } from './bus.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/** @type {object} the live snapshot, mutated in place as probes resolve */
const snapshot = {
  pending: true,

  cpu: {
    cores: 1,
    architecture: 'x86_64',
    bitness: '64',
    model: '',
    exact: false,
  },
  memory: {
    totalGib: 0,
    /** True only when the browser gave a real figure rather than our fallback. */
    reported: false,
    /** deviceMemory is capped at 8 by spec, so treat it as a floor. */
    isLowerBound: true,
  },
  gpu: {
    vendor: '',
    renderer: '',
    webglVersion: '',
    exact: false,
  },
  storage: {
    quotaBytes: 0,
    usageBytes: 0,
    reported: false,
  },
  display: {
    width: 0,
    height: 0,
    availWidth: 0,
    availHeight: 0,
    pixelRatio: 1,
    colorDepth: 24,
    refresh: 0,
  },
  os: {
    platform: '',
    version: '',
    family: '',
  },
  browser: {
    name: '',
    version: '',
    engine: '',
    userAgent: '',
  },
  locale: {
    language: 'en-US',
    languages: [],
    timeZone: 'UTC',
  },
  network: {
    online: true,
    effectiveType: '',
    downlinkMbps: 0,
    rtt: 0,
  },
  battery: {
    supported: false,
    level: null,
    charging: null,
  },
};

/* ------------------------------------------------------------------ *
 * synchronous probes
 * ------------------------------------------------------------------ */

/**
 * Parse the classic user-agent string. Only used to fill gaps that
 * `navigator.userAgentData` cannot — it is unreliable by design.
 *
 * @param {string} ua
 * @returns {{osFamily: string, osVersion: string, browser: string, version: string, engine: string}}
 */
function parseUserAgent(ua) {
  const out = { osFamily: '', osVersion: '', browser: '', version: '', engine: '' };

  if (/Windows NT ([\d.]+)/.test(ua)) {
    const nt = RegExp.$1;
    out.osFamily = 'Windows';
    // Windows 11 still reports NT 10.0; the UA cannot distinguish it from 10.
    const names = { '10.0': '10 or 11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    out.osVersion = names[nt] || `NT ${nt}`;
  } else if (/Mac OS X ([\d_.]+)/.test(ua)) {
    out.osFamily = 'macOS';
    out.osVersion = RegExp.$1.replace(/_/g, '.');
  } else if (/Android ([\d.]+)/.test(ua)) {
    out.osFamily = 'Android';
    out.osVersion = RegExp.$1;
  } else if (/(iPhone|iPad).*OS ([\d_]+)/.test(ua)) {
    out.osFamily = 'iOS';
    out.osVersion = RegExp.$2.replace(/_/g, '.');
  } else if (/Linux/.test(ua)) {
    out.osFamily = 'Linux';
  } else if (/CrOS/.test(ua)) {
    out.osFamily = 'ChromeOS';
  }

  // Order matters: Edge and Opera both carry "Chrome" in their UA.
  if (/Edg\/([\d.]+)/.test(ua)) { out.browser = 'Edge'; out.version = RegExp.$1; out.engine = 'Blink'; }
  else if (/OPR\/([\d.]+)/.test(ua)) { out.browser = 'Opera'; out.version = RegExp.$1; out.engine = 'Blink'; }
  else if (/Firefox\/([\d.]+)/.test(ua)) { out.browser = 'Firefox'; out.version = RegExp.$1; out.engine = 'Gecko'; }
  else if (/Chrome\/([\d.]+)/.test(ua)) { out.browser = 'Chrome'; out.version = RegExp.$1; out.engine = 'Blink'; }
  else if (/Version\/([\d.]+).*Safari/.test(ua)) { out.browser = 'Safari'; out.version = RegExp.$1; out.engine = 'WebKit'; }

  return out;
}

/**
 * Query the GPU string through WEBGL_debug_renderer_info.
 * The context is discarded immediately; keeping it alive would hold a GPU
 * process open for the life of the page.
 *
 * @returns {{vendor: string, renderer: string, webglVersion: string, exact: boolean}}
 */
function probeGpu() {
  const empty = { vendor: '', renderer: '', webglVersion: '', exact: false };
  let canvas = null;
  try {
    canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    if (!gl) return empty;

    const version = gl.getParameter(gl.VERSION) || '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const out = {
      vendor: ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '') : String(gl.getParameter(gl.VENDOR) || ''),
      renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : String(gl.getParameter(gl.RENDERER) || ''),
      webglVersion: String(version),
      // Without the extension the strings are the generic masked ones
      // ("WebKit WebGL"), which say nothing about the actual adapter.
      exact: Boolean(ext),
    };

    const loseContext = gl.getExtension('WEBGL_lose_context');
    if (loseContext) loseContext.loseContext();
    return out;
  } catch {
    return empty;
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
  }
}

/**
 * Read the display metrics.
 *
 * Kept separate and re-runnable because `window.screen` is not always
 * meaningful at module-evaluation time: an embedded/headless surface can report
 * 0 × 0 until the first layout, and the numbers change when the window moves
 * between monitors. The refresh rate is preserved because it is measured
 * separately and costs 20 frames to obtain.
 */
function readDisplay() {
  const s = window.screen || {};
  const root = document.documentElement;
  // screen.* is the monitor; innerWidth is the window; clientWidth is the
  // laid-out viewport. Fall through in that order — an embedded surface can
  // report 0 for the first two until it is actually composited.
  const width = s.width || window.innerWidth || (root && root.clientWidth) || 0;
  const height = s.height || window.innerHeight || (root && root.clientHeight) || 0;
  snapshot.display = {
    width,
    height,
    availWidth: s.availWidth || width,
    availHeight: s.availHeight || height,
    pixelRatio: window.devicePixelRatio || 1,
    colorDepth: s.colorDepth || 24,
    refresh: snapshot.display ? snapshot.display.refresh : 0,
  };
}

/**
 * Map a Windows UA-CH platformVersion to a marketing name.
 *
 * Windows reports a "UniversalApiContract" version here, not the product
 * version, so Windows 11 comes through as 13.0.0 or higher and Windows 10 as
 * 1–12. Printing the raw number would show nonsense like "Windows 19.0.0".
 * See Microsoft's documented UA-CH mapping.
 *
 * @param {string} raw
 * @returns {string}
 */
function windowsVersionName(raw) {
  const major = parseInt(String(raw).split('.')[0], 10);
  if (!Number.isFinite(major)) return '';
  if (major === 0) return '7, 8 or 8.1';
  if (major >= 13) return '11';
  return '10';
}

/** Fill everything obtainable without awaiting. */
function probeSync() {
  const nav = navigator;

  /* --- CPU --- */
  const cores = Number(nav.hardwareConcurrency) || 0;
  snapshot.cpu.cores = cores > 0 ? cores : 1;
  snapshot.cpu.exact = cores > 0;

  /* --- memory --- */
  const mem = Number(nav.deviceMemory) || 0;
  if (mem > 0) {
    snapshot.memory.totalGib = mem;
    snapshot.memory.reported = true;
    // deviceMemory is bucketed to a power of two, and the original spec clamped
    // it at 8 GiB. A reading of exactly 8 is therefore ambiguous — it can mean
    // "8" or "anything above 8" — while other values are approximate but not
    // truncated. Only 8 gets the "or more" wording.
    snapshot.memory.isLowerBound = mem === 8;
  } else {
    // Firefox and Safari do not implement deviceMemory at all. 8 GiB is the
    // most common configuration on a desktop, and it is flagged as unreported
    // so callers can say so.
    snapshot.memory.totalGib = 8;
    snapshot.memory.reported = false;
    snapshot.memory.isLowerBound = true;
  }

  /* --- GPU --- */
  snapshot.gpu = probeGpu();

  /* --- display --- */
  readDisplay();

  /* --- OS + browser --- */
  const ua = nav.userAgent || '';
  const parsed = parseUserAgent(ua);
  snapshot.os.family = parsed.osFamily;
  snapshot.os.version = parsed.osVersion;
  snapshot.os.platform = nav.platform || parsed.osFamily;
  snapshot.browser = {
    name: parsed.browser,
    version: parsed.version,
    engine: parsed.engine,
    userAgent: ua,
  };

  /* --- architecture --- */
  // Only Chromium exposes architecture, and only asynchronously. Guess from
  // the UA meanwhile so lscpu/uname have something coherent to print.
  if (/aarch64|arm64/i.test(ua)) snapshot.cpu.architecture = 'aarch64';
  else if (/x86_64|Win64|x64|WOW64/i.test(ua)) snapshot.cpu.architecture = 'x86_64';
  else if (/i686|i386/i.test(ua)) { snapshot.cpu.architecture = 'i686'; snapshot.cpu.bitness = '32'; }

  /* --- locale --- */
  snapshot.locale = {
    language: nav.language || 'en-US',
    languages: Array.isArray(nav.languages) ? nav.languages.slice() : [],
    timeZone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })(),
  };

  /* --- network --- */
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  snapshot.network = {
    online: nav.onLine !== false,
    effectiveType: conn ? String(conn.effectiveType || '') : '',
    downlinkMbps: conn ? Number(conn.downlink) || 0 : 0,
    rtt: conn ? Number(conn.rtt) || 0 : 0,
  };
}

/* ------------------------------------------------------------------ *
 * asynchronous probes
 * ------------------------------------------------------------------ */

async function probeStorage() {
  try {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return;
    const est = await navigator.storage.estimate();
    snapshot.storage = {
      quotaBytes: Number(est.quota) || 0,
      usageBytes: Number(est.usage) || 0,
      reported: true,
    };
  } catch {
    /* Safari in private mode throws; leave the defaults. */
  }
}

async function probeUserAgentData() {
  try {
    const uad = navigator.userAgentData;
    if (!uad || typeof uad.getHighEntropyValues !== 'function') return;
    const hi = await uad.getHighEntropyValues([
      'architecture',
      'bitness',
      'model',
      'platformVersion',
      'fullVersionList',
    ]);
    if (hi.architecture) {
      snapshot.cpu.architecture =
        hi.architecture === 'x86' ? (hi.bitness === '64' ? 'x86_64' : 'i686') : hi.architecture;
    }
    if (hi.bitness) snapshot.cpu.bitness = String(hi.bitness);
    if (hi.model) snapshot.cpu.model = String(hi.model);
    if (uad.platform) snapshot.os.family = String(uad.platform);
    if (hi.platformVersion) {
      snapshot.os.version =
        snapshot.os.family === 'Windows'
          ? windowsVersionName(hi.platformVersion)
          : String(hi.platformVersion);
    }
    if (Array.isArray(hi.fullVersionList) && hi.fullVersionList.length) {
      const brand = hi.fullVersionList.find((b) => !/Not.?A.?Brand/i.test(b.brand));
      if (brand) {
        snapshot.browser.name = brand.brand;
        snapshot.browser.version = brand.version;
      }
    }
  } catch {
    /* getHighEntropyValues can reject on permissions-policy grounds. */
  }
}

async function probeBattery() {
  try {
    if (typeof navigator.getBattery !== 'function') return;
    const b = await navigator.getBattery();
    const sync = () => {
      snapshot.battery = {
        supported: true,
        level: typeof b.level === 'number' ? Math.round(b.level * 100) : null,
        charging: Boolean(b.charging),
      };
      bus.emit('device:battery', { ...snapshot.battery });
    };
    sync();
    b.addEventListener('levelchange', sync);
    b.addEventListener('chargingchange', sync);
  } catch {
    /* Firefox and Safari removed the Battery API. */
  }
}

/**
 * Measure the display refresh rate by timing animation frames.
 * Resolves to 0 when the tab is hidden (rAF is throttled and the figure would
 * be meaningless).
 *
 * @returns {Promise<number>} rounded Hz
 */
export function measureRefreshRate() {
  return new Promise((resolve) => {
    // requestAnimationFrame is throttled to a crawl in a background tab, so a
    // measurement taken there would be fiction. Report "unknown" and let the
    // visibilitychange listener below retry once the tab is actually on screen.
    if (document.hidden) { resolve(0); return; }
    const samples = [];
    let last = performance.now();
    let frames = 0;

    const tick = (now) => {
      const delta = now - last;
      last = now;
      if (delta > 0 && delta < 100) samples.push(delta);
      frames += 1;
      if (frames < 20) {
        requestAnimationFrame(tick);
        return;
      }
      if (!samples.length) { resolve(0); return; }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      const hz = Math.round(1000 / median);
      snapshot.display.refresh = hz;
      resolve(hz);
    };
    requestAnimationFrame(tick);
  });
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

probeSync();

const readyPromise = (async () => {
  await Promise.allSettled([probeStorage(), probeUserAgentData(), probeBattery()]);
  snapshot.pending = false;
  bus.emit('device:ready', device.info());
  // Not awaited: the refresh rate needs 20 frames and nothing blocks on it.
  measureRefreshRate().catch(() => {});
  return device.info();
})();

if (typeof window !== 'undefined') {
  // screen.* can be 0 until the first layout on an embedded surface, and it
  // changes when the window is dragged to a monitor with a different DPI.
  window.addEventListener('resize', readDisplay);

  // A desktop that boots in a background tab cannot measure the refresh rate:
  // rAF is throttled there, so the boot probe resolves 0 and every caller of
  // `displayLabel()` omits the Hz. Without this, that omission would outlive
  // the reason for it. Measure on the first genuine reveal and then stop
  // listening: the figure does not change while the page stays on one monitor,
  // and the matchMedia handler above already covers a monitor change.
  //
  // No event is emitted. `device:ready` means "the boot probes have landed" and
  // firing it twice would mislead anything treating it as one-shot; the pages
  // that show the rate (About, neofetch, xrandr) read the snapshot when they
  // render, which is necessarily after the reveal.
  if (typeof document !== 'undefined') {
    const onReveal = () => {
      if (document.hidden || snapshot.display.refresh) return;
      document.removeEventListener('visibilitychange', onReveal);
      measureRefreshRate().catch(() => {});
    };
    document.addEventListener('visibilitychange', onReveal);
  }
  if (typeof window.matchMedia === 'function') {
    const dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    if (typeof dpr.addEventListener === 'function') {
      dpr.addEventListener('change', () => {
        readDisplay();
        measureRefreshRate().catch(() => {});
      });
    }
  }

  window.addEventListener('online', () => {
    snapshot.network.online = true;
    bus.emit('net:online', {});
  });
  window.addEventListener('offline', () => {
    snapshot.network.online = false;
    bus.emit('net:offline', {});
  });
}

/* ------------------------------------------------------------------ *
 * derived, presentation-ready values
 * ------------------------------------------------------------------ */

/**
 * Best available CPU description. Browsers never expose the real model name,
 * so this is composed from architecture, core count and (on Chromium) the
 * device model, and is explicitly marked inexact.
 *
 * @returns {string}
 */
function cpuModelString() {
  const { cores, architecture, model } = snapshot.cpu;
  if (model) return `${model} (${architecture}, ${cores} threads)`;
  const family =
    architecture === 'aarch64' ? 'ARM64 processor'
    : architecture === 'i686' ? 'x86 processor'
    : 'x86-64 processor';
  return `${family} × ${cores}`;
}

/** @returns {string} e.g. "Mesa Intel(R) UHD Graphics (TGL GT1)" or a fallback */
function gpuString() {
  const { renderer, vendor, exact } = snapshot.gpu;
  if (renderer && exact) return renderer;
  if (renderer) return `${renderer} (masked by the browser)`;
  if (vendor) return vendor;
  return 'Unknown — the browser does not expose the GPU';
}

/**
 * Format bytes the way GNOME does (decimal GB for storage).
 * @param {number} bytes
 * @returns {string}
 */
function formatStorage(bytes) {
  if (!bytes) return 'Unknown';
  const gb = bytes / 1e9;
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(1)} GB`;
}

export const device = {
  /** @returns {object} a deep-ish copy of the current snapshot */
  info() {
    // A surface that had no layout when this module first evaluated reports
    // 0 × 0; retry rather than caching the zero forever.
    if (!snapshot.display.width) readDisplay();
    return {
      pending: snapshot.pending,
      cpu: { ...snapshot.cpu },
      memory: { ...snapshot.memory },
      gpu: { ...snapshot.gpu },
      storage: { ...snapshot.storage },
      display: { ...snapshot.display },
      os: { ...snapshot.os },
      browser: { ...snapshot.browser },
      locale: { ...snapshot.locale, languages: snapshot.locale.languages.slice() },
      network: { ...snapshot.network },
      battery: { ...snapshot.battery },
    };
  },

  /** @returns {Promise<object>} resolves once the async probes have landed */
  ready() {
    return readyPromise;
  },

  /* --- presentation helpers, shared by About / neofetch / lscpu --- */

  cpuModel: cpuModelString,
  gpuModel: gpuString,

  /** @returns {number} logical CPUs */
  cores() {
    return snapshot.cpu.cores;
  },

  /** @returns {string} 'x86_64' | 'aarch64' | 'i686' */
  arch() {
    return snapshot.cpu.architecture;
  },

  /** @returns {number} total RAM in MiB, as reported (or the 8 GiB fallback) */
  memTotalMib() {
    return snapshot.memory.totalGib * 1024;
  },

  /** @returns {number} total RAM in bytes */
  memTotalBytes() {
    return snapshot.memory.totalGib * GIB;
  },

  /**
   * Human memory string. Includes the "at least" qualifier when the figure is
   * a spec-imposed lower bound rather than a measurement.
   * @param {{qualify?: boolean}} [opts]
   * @returns {string}
   */
  memoryLabel({ qualify = true } = {}) {
    const { totalGib, reported, isLowerBound } = snapshot.memory;
    const base = `${totalGib.toFixed(1)} GiB`;
    if (!qualify) return base;
    if (!reported) return `${base} (not reported by this browser)`;
    if (isLowerBound) return `${base} or more`;
    // Bucketed to a power of two by the spec, so it is close but not exact.
    return `${base} (approx.)`;
  },

  /** @returns {{quota: string, usage: string, quotaBytes: number, usageBytes: number, reported: boolean}} */
  storageLabel() {
    return {
      quota: formatStorage(snapshot.storage.quotaBytes),
      usage: formatStorage(snapshot.storage.usageBytes),
      quotaBytes: snapshot.storage.quotaBytes,
      usageBytes: snapshot.storage.usageBytes,
      reported: snapshot.storage.reported,
    };
  },

  /** @returns {string} e.g. "1920 × 1080 @ 2x, 60 Hz" */
  displayLabel() {
    if (!snapshot.display.width) readDisplay();
    const d = snapshot.display;
    if (!d.width) return 'Unknown — the browser does not expose the screen size';
    const scale = d.pixelRatio !== 1 ? ` @ ${d.pixelRatio}x` : '';
    const hz = d.refresh ? `, ${d.refresh} Hz` : '';
    return `${d.width} × ${d.height}${scale}${hz}`;
  },

  /** @returns {string} e.g. "Chrome 140 on Windows 10 or 11" */
  hostLabel() {
    const b = snapshot.browser;
    const o = snapshot.os;
    const browser = b.name ? `${b.name} ${String(b.version).split('.')[0]}` : 'Unknown browser';
    const os = o.family ? `${o.family}${o.version ? ` ${o.version}` : ''}` : 'unknown OS';
    return `${browser} on ${os}`;
  },

  /** @returns {number} bytes, for `df` — the browser storage quota */
  diskTotalBytes() {
    return snapshot.storage.quotaBytes || 0;
  },

  measureRefreshRate,
  MIB,
  GIB,
};

export default device;
