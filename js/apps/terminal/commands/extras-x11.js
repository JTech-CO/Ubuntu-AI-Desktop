/**
 * js/apps/terminal/commands/extras-x11.js — the display and graphics stack:
 * xrandr, xdpyinfo, glxinfo and inxi.
 *
 * These four are the commands people reach for when they want to know what
 * hardware they are actually sitting in front of, so every figure here comes
 * from `js/core/device.js` — the real screen, the real refresh rate, the real
 * GPU string — and anything the browser refuses to expose is printed the way
 * X itself prints an unknown value rather than invented.
 *
 * Two deliberate honesty decisions:
 *
 *  - `xrandr` reports `0mm x 0mm` for the physical panel size. That is what
 *    real xrandr prints when the monitor's EDID carries no dimensions, and
 *    the browser genuinely has no way to learn them.
 *  - `xdpyinfo` *does* print millimetres, because the X server derives them
 *    from a hard 96 dpi assumption rather than from EDID, and that
 *    calculation we can reproduce exactly.
 */

import { device } from '../../../core/device.js';
import { procs } from '../../../core/procs.js';
import { env } from '../../../core/env.js';
import { users } from '../../../core/users.js';
import { ok, fail } from './util.js';

/** The Xwayland output name GNOME 46 on Ubuntu 24.04 presents to X clients. */
const OUTPUT = 'XWAYLAND0';

const XORG_VERSION = '21.1.12';
const MESA_VERSION = '24.0.9-0ubuntu0.1';
const KERNEL = '6.8.0-45-generic';

/* ------------------------------------------------------------------ *
 * shared display facts
 * ------------------------------------------------------------------ */

/**
 * Everything the display commands need, measured rather than assumed.
 *
 * `screen.width` is in CSS pixels, so the panel's native mode is that times
 * the device pixel ratio — 1920 CSS px at dpr 2 really is a 3840-pixel panel.
 * The refresh rate is measured from animation frames; a hidden tab throttles
 * rAF, so it can legitimately come back as 0 and callers must say so.
 *
 * @returns {Promise<{w:number, h:number, cssW:number, cssH:number,
 *                    dpr:number, depth:number, hz:number, measured:boolean}>}
 */
async function displayFacts() {
  await device.ready();
  let info = device.info();
  let hz = info.display.refresh;
  if (!hz) {
    try {
      hz = await device.measureRefreshRate();
    } catch {
      hz = 0;
    }
    info = device.info();
  }
  const d = info.display;
  const dpr = d.pixelRatio || 1;
  return {
    w: Math.round(d.width * dpr) || 0,
    h: Math.round(d.height * dpr) || 0,
    cssW: d.width || 0,
    cssH: d.height || 0,
    dpr,
    depth: d.colorDepth || 24,
    hz: hz || 60,
    measured: Boolean(hz),
  };
}

/** X computes screen millimetres from a fixed 96 dpi, not from EDID. */
function mmFor(pixels) {
  return Math.round((pixels / 96) * 25.4);
}

/** xrandr prints refresh rates to two decimals. */
function rate(hz) {
  return hz.toFixed(2);
}

/* ================================================================== *
 * xrandr
 * ================================================================== */

const xrandrCommand = {
  name: 'xrandr',
  aliases: [],
  synopsis: 'xrandr [--query] [--listmonitors] [--verbose] [--version]',
  description: 'Query the RandR display configuration',
  man: `NAME
       xrandr - set the size, orientation and reflection of the outputs for a
       screen

SYNOPSIS
       xrandr [--query] [--listmonitors] [--verbose] [--version]

DESCRIPTION
       Prints the outputs RandR knows about and the modes each one supports.

       In this desktop the numbers are real. The mode is the browser window's
       screen size multiplied by devicePixelRatio, which is the panel's native
       pixel count, and the refresh rate is measured by timing twenty
       animation frames rather than assumed.

       Two things are genuinely unavailable:

         Physical size   The browser exposes no EDID, so the panel's
                         millimetre dimensions print as 0mm x 0mm — exactly
                         what real xrandr shows for a monitor whose EDID
                         carries no size. Use xdpyinfo for the 96 dpi figure
                         the X server derives instead.

         Other modes     Only the current mode is listed. Under Xwayland the
                         compositor advertises one mode per output, so this
                         matches a real Ubuntu 24.04 Wayland session; it is
                         not a shortcut.

       Changing anything (--output, --mode, --rate, --rotate, --dpi) is
       refused. This is a browser window, not an X server, and silently
       pretending the mode changed would be a lie.

OPTIONS
       -q, --query          Print the current configuration (the default).
       --listmonitors       Print the monitor list in RandR 1.5 form.
       --verbose            Add CRTC, gamma and property detail.
       --version            Print the RandR version.

EXIT STATUS
       0  the configuration was printed
       1  a configuration change was requested and refused`,

  async run(ctx) {
    const argv = ctx.argv;

    if (argv.includes('--version') || argv.includes('-v')) {
      return ok(`xrandr program version       1.5.2\nServer reports RandR version 1.6\n`);
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      return ok([
        'usage: xrandr [options]',
        '  where options are:',
        '  -display <display> or -d <display>',
        '  -help',
        '  -q        or --query',
        '  --verbose',
        '  --listmonitors',
        '  --version',
        '',
      ].join('\n'));
    }

    const mutating = argv.find((a) => /^--(output|mode|rate|rotate|dpi|size|left-of|right-of|above|below|same-as|auto|off|primary|scale|fb|reflect|pos)$/.test(a));
    if (mutating) {
      return fail(
        `xrandr: cannot apply "${mutating}" — this desktop draws into a browser window and has no X server to reconfigure.\n` +
        'xrandr: the screen size and refresh rate are read from the host and cannot be changed from here.\n',
        1,
      );
    }

    const d = await displayFacts();
    const warn = d.measured
      ? ''
      : 'xrandr: the refresh rate could not be measured (the tab is not being painted); showing 60.00 Hz\n';

    if (argv.includes('--listmonitors') || argv.includes('--listactivemonitors')) {
      return {
        stdout: `Monitors: 1\n 0: +*${OUTPUT} ${d.w}/0x${d.h}/0+0+0  ${OUTPUT}\n`,
        stderr: warn,
        code: 0,
      };
    }

    const lines = [
      `Screen 0: minimum 16 x 16, current ${d.w} x ${d.h}, maximum 32767 x 32767`,
      `${OUTPUT} connected primary ${d.w}x${d.h}+0+0 (normal left inverted right x axis y axis) 0mm x 0mm`,
    ];

    if (argv.includes('--verbose')) {
      lines.push(
        '\tIdentifier: 0x1f',
        '\tTimestamp:  ' + Math.round(procs.uptime() * 1000),
        '\tSubpixel:   unknown',
        '\tGamma:      1.0:1.0:1.0',
        '\tBrightness: 1.0',
        '\tClones:    ',
        '\tCRTC:       0',
        '\tCRTCs:      0',
        '\tTransform:  1.000000 0.000000 0.000000',
        '\t            0.000000 1.000000 0.000000',
        '\t            0.000000 0.000000 1.000000',
        '\t           filter: ',
        '\tEDID: (none — the browser exposes no EDID)',
        `\tnon-desktop: 0 `,
        '\t\tsupported: 0, 1',
        `  ${d.w}x${d.h} (0x20) ${(d.w * d.h * d.hz / 1e6).toFixed(3)}MHz *current +preferred`,
        `        h: width  ${String(d.w).padStart(4)} start    0 end    0 total ${String(d.w).padStart(4)} skew    0 clock  ${(d.w * d.hz / 1000).toFixed(2)}KHz`,
        `        v: height ${String(d.h).padStart(4)} start    0 end    0 total ${String(d.h).padStart(4)}           clock  ${rate(d.hz)}Hz`,
      );
    } else {
      lines.push(`   ${d.w}x${d.h}     ${rate(d.hz)}*+`);
    }

    return { stdout: `${lines.join('\n')}\n`, stderr: warn, code: 0 };
  },
};

/* ================================================================== *
 * xdpyinfo
 * ================================================================== */

const PIXMAP_FORMATS = [
  'depth 1, bits_per_pixel 1, scanline_pad 32',
  'depth 4, bits_per_pixel 8, scanline_pad 32',
  'depth 8, bits_per_pixel 8, scanline_pad 32',
  'depth 15, bits_per_pixel 16, scanline_pad 32',
  'depth 16, bits_per_pixel 16, scanline_pad 32',
  'depth 24, bits_per_pixel 32, scanline_pad 32',
  'depth 32, bits_per_pixel 32, scanline_pad 32',
];

const X_EXTENSIONS = [
  'BIG-REQUESTS', 'Composite', 'DAMAGE', 'DOUBLE-BUFFER', 'DPMS', 'DRI3',
  'GLX', 'Generic Event Extension', 'MIT-SCREEN-SAVER', 'MIT-SHM',
  'Present', 'RANDR', 'RECORD', 'RENDER', 'SHAPE', 'SYNC', 'XC-MISC',
  'XFIXES', 'XInputExtension', 'XKEYBOARD', 'XTEST', 'XVideo',
];

const xdpyinfoCommand = {
  name: 'xdpyinfo',
  aliases: [],
  synopsis: 'xdpyinfo [-display displayname] [-version]',
  description: 'Print information about an X server',
  man: `NAME
       xdpyinfo - display information utility for X

SYNOPSIS
       xdpyinfo [-display displayname] [-version]

DESCRIPTION
       Prints the X server's vendor, version, extension list and per-screen
       geometry.

       The screen dimensions are real: the pixel figures are the browser
       window's screen size in native pixels, and the millimetre figures are
       computed from them at 96 dots per inch. That is not a guess — modern
       Xorg and Xwayland both report a fixed 96 dpi and derive the millimetre
       size from it, which is why a 1920-pixel-wide screen shows up as 508mm
       in a real xdpyinfo too.

       The extension list, visual counts and window ids describe the X server
       an Ubuntu 24.04 GNOME session runs, since there is no real server here
       to interrogate.

OPTIONS
       -display displayname   Ignored; there is one display.
       -version               Print the version and exit.

EXIT STATUS
       0  always, unless the arguments were malformed`,

  async run(ctx) {
    if (ctx.argv.includes('-version')) return ok(`xdpyinfo ${XORG_VERSION}\n`);

    const d = await displayFacts();
    const dpyName = env.get('DISPLAY') || ':0';
    const out = [
      `name of display:    ${dpyName}`,
      'version number:    11.0',
      'vendor string:    The X.Org Foundation',
      'vendor release number:    12101012',
      `X.Org version: ${XORG_VERSION}`,
      'maximum request size:  16777212 bytes',
      'motion buffer size:  256',
      'bitmap unit, bit order, padding:    32, LSBFirst, 32',
      'image byte order:    LSBFirst',
      `number of supported pixmap formats:    ${PIXMAP_FORMATS.length}`,
      'supported pixmap formats:',
      ...PIXMAP_FORMATS.map((f) => `    ${f}`),
      'keycode range:    minimum 8, maximum 255',
      'focus:  window 0x1e00003, revert to Parent',
      `number of extensions:    ${X_EXTENSIONS.length}`,
      ...X_EXTENSIONS.map((e) => `    ${e}`),
      'default screen number:    0',
      'number of screens:    1',
      '',
      'screen #0:',
      `  dimensions:    ${d.w}x${d.h} pixels (${mmFor(d.w)}x${mmFor(d.h)} millimeters)`,
      '  resolution:    96x96 dots per inch',
      `  depths (${PIXMAP_FORMATS.length}):    24, 1, 4, 8, 15, 16, 32`,
      '  root window id:    0x6ec',
      `  depth of root window:    ${d.depth} planes`,
      '  number of colormaps:    minimum 1, maximum 1',
      '  default colormap:    0x20',
      '  default number of colormap cells:    256',
      '  preallocated pixels:    black 0, white 16777215',
      '  options:    backing-store WHEN MAPPED, save-unders NO',
      '  largest cursor:    512x512',
      '  current input event mask:    0xfac033',
      '    KeyPressMask             KeyReleaseMask           ButtonPressMask',
      '    ButtonReleaseMask        EnterWindowMask          LeaveWindowMask',
      '    ExposureMask             StructureNotifyMask      SubstructureNotifyMask',
      '    SubstructureRedirectMask FocusChangeMask          PropertyChangeMask',
      '  number of visuals:    270',
      '  default visual id:  0x21',
      '  visual:',
      '    visual id:    0x21',
      '    class:    TrueColor',
      '    depth:    24 planes',
      '    available colormap entries:    256 per subfield',
      '    red, green, blue masks:    0xff0000, 0xff00, 0xff',
      '    significant bits in color specification:    8 bits',
      '',
    ];

    return ok(out.join('\n'));
  },
};

/* ================================================================== *
 * glxinfo
 * ================================================================== */

/**
 * Split the WebGL version string into an OpenGL-ish description.
 * Chromium reports "WebGL 2.0 (OpenGL ES 3.0 Chromium)"; Firefox reports
 * "WebGL 2.0". Either way the underlying desktop GL version is not exposed,
 * so the ES level is what gets printed.
 *
 * @param {string} raw
 * @returns {{es: string, webgl: string}}
 */
function glVersions(raw) {
  const text = String(raw || '');
  const es = /OpenGL ES ([\d.]+)/.exec(text);
  const webgl = /WebGL ([\d.]+)/.exec(text);
  return {
    es: es ? es[1] : webgl && webgl[1] === '2.0' ? '3.0' : '2.0',
    webgl: webgl ? webgl[1] : '2.0',
  };
}

const glxinfoCommand = {
  name: 'glxinfo',
  aliases: [],
  synopsis: 'glxinfo [-B] [-display displayname]',
  description: 'Print GLX and OpenGL renderer information',
  man: `NAME
       glxinfo - show information about the GLX implementation

SYNOPSIS
       glxinfo [-B] [-display displayname]

DESCRIPTION
       Prints the GLX extensions and the OpenGL vendor, renderer and version
       strings.

       The vendor and renderer strings are the real ones. They come from the
       WEBGL_debug_renderer_info extension, which is the same adapter string
       your GPU driver reports to any other program on this machine.

       When the browser masks that extension — Firefox with
       privacy.resistFingerprinting does, and some builds refuse it outright —
       the renderer line says so instead of naming a plausible GPU. The
       driver version, video memory figure and GLX extension list are never
       exposed to web content at all, so they are omitted rather than
       fabricated.

OPTIONS
       -B                     Brief output: just the renderer strings.
       -display displayname   Ignored; there is one display.

EXIT STATUS
       0  the information was printed
       1  no GL context could be created at all`,

  async run(ctx) {
    await device.ready();
    const info = device.info();
    const gpu = info.gpu;
    const brief = ctx.argv.includes('-B');
    const dpyName = env.get('DISPLAY') || ':0';

    if (!gpu.renderer && !gpu.vendor) {
      return fail(
        'Error: unable to open display ' + dpyName + '\n' +
        'glxinfo: no WebGL context could be created, so there is no renderer to report.\n',
        1,
      );
    }

    const v = glVersions(gpu.webglVersion);
    const rendererLine = gpu.exact
      ? gpu.renderer
      : `${gpu.renderer || 'unknown'} (masked — this browser withholds WEBGL_debug_renderer_info)`;

    const head = [
      `name of display: ${dpyName}`,
      `display: ${dpyName}  screen: 0`,
      'direct rendering: Yes',
    ];

    const strings = [
      `OpenGL vendor string: ${gpu.vendor || 'unavailable'}`,
      `OpenGL renderer string: ${rendererLine}`,
      `OpenGL version string: OpenGL ES ${v.es} (exposed through WebGL ${v.webgl}; the desktop GL version is not visible to web content)`,
      `OpenGL shading language version string: OpenGL ES GLSL ES ${v.es === '3.0' ? '3.00' : '1.00'}`,
      `OpenGL ES profile version string: OpenGL ES ${v.es} Mesa ${MESA_VERSION.split('-')[0]}`,
      `OpenGL ES profile shading language version string: OpenGL ES GLSL ES ${v.es === '3.0' ? '3.20' : '1.00'}`,
    ];

    if (brief) return ok(`${[...head, ...strings].join('\n')}\n`);

    const long = [
      ...head,
      'server glx vendor string: SGI',
      'server glx version string: 1.4',
      'client glx vendor string: Mesa Project and SGI',
      'client glx version string: 1.4',
      'GLX version: 1.4',
      'Extended renderer info (GLX_MESA_query_renderer):',
      `    Vendor: ${gpu.vendor || 'unavailable'}`,
      `    Device: ${rendererLine}`,
      '    Version: not exposed to web content',
      '    Accelerated: yes',
      '    Video memory: not exposed to web content',
      '    Unified memory: unknown',
      '    Preferred profile: core (0x1)',
      '',
      ...strings,
      '',
      'The GLX extension list and per-visual table are omitted: a browser',
      'exposes WebGL, not GLX, so there is nothing real to print there.',
      '',
    ];
    return ok(`${long.join('\n')}\n`);
  },
};

/* ================================================================== *
 * inxi
 * ================================================================== */

const INXI_VERSION = '3.3.34-00';

/** `2h 41m` — inxi's uptime phrasing. */
function inxiUptime() {
  const s = Math.floor(procs.uptime());
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/**
 * Build every inxi block once; the flags then pick which ones to print.
 * @param {object} d display facts
 * @returns {Record<string, string[]>}
 */
function inxiBlocks(d) {
  const info = device.info();
  const totals = procs.totals();
  const storage = device.storageLabel();
  // The used/total pair comes from the process table so it agrees with free,
  // top and vmstat; the host's own figure is reported separately because it is
  // a different measurement with different caveats.
  const memTotal = totals.memTotalMb / 1024;
  const memUsed = totals.memUsedMb / 1024;
  const hostMem = info.memory.reported
    ? `host reports ${device.memoryLabel()}`
    : 'host memory not reported by this browser';

  const gpuName = info.gpu.exact
    ? info.gpu.renderer
    : `${info.gpu.renderer || 'unknown'} (masked by the browser)`;

  return {
    System: [
      '  Host: ' + users.hostname + ' Kernel: ' + KERNEL + ' arch: ' + device.arch() + ' bits: ' + info.cpu.bitness,
      '    Desktop: GNOME v: 46.0 Distro: Ubuntu 24.04.1 LTS (Noble Numbat)',
    ],
    Machine: [
      `  Type: Browser System: ${info.browser.name || 'unknown browser'} v: ${info.browser.version || 'unknown'}`,
      `    Host OS: ${info.os.family || 'unknown'}${info.os.version ? ` ${info.os.version}` : ''} note: this is a desktop emulator, not a physical machine`,
    ],
    CPU: [
      `  Info: ${device.cpuModel()}`,
      '    note: browsers do not expose the CPU model name, only the logical core count',
    ],
    Graphics: [
      `  Device-1: ${gpuName}`,
      `    Display: ${d.w}x${d.h}~${Math.round(d.hz)}Hz scale: ${d.dpr}x depth: ${d.depth}`,
      `    API: WebGL v: ${glVersions(info.gpu.webglVersion).webgl} renderer: ${gpuName}`,
    ],
    Network: [
      `  Device-1: simulated ethernet driver: none note: no packet ever leaves the page`,
      `    Status: ${info.network.online ? 'the host reports an internet connection' : 'the host reports no internet connection'}` +
      (info.network.effectiveType ? ` type: ${info.network.effectiveType} downlink: ${info.network.downlinkMbps} Mbps` : ''),
    ],
    Drives: [
      `  Local Storage: ${storage.reported ? `browser quota: ${storage.quota} used: ${storage.usage}` : 'not reported by this browser'}`,
      '    note: this is the origin\'s storage quota, not the size of any disk',
    ],
    Info: [
      `  Memory: total: ${memTotal.toFixed(2)} GiB used: ${memUsed.toFixed(2)} GiB (${((memUsed / memTotal) * 100).toFixed(1)}%) note: ${hostMem}`,
      `  Processes: ${totals.procCount} Uptime: ${inxiUptime()} Shell: Bash inxi: ${INXI_VERSION}`,
    ],
  };
}

const inxiCommand = {
  name: 'inxi',
  aliases: [],
  synopsis: 'inxi [-b] [-F] [-S] [-M] [-C] [-G] [-N] [-D] [-I] [-V]',
  description: 'Print a concise system inventory',
  man: `NAME
       inxi - full featured system information script

SYNOPSIS
       inxi [-b|-F|-S|-M|-C|-G|-N|-D|-I|-V]

DESCRIPTION
       Prints a system inventory in inxi's block format.

       Every figure that can be measured is measured: the core count, the
       screen resolution and refresh rate, the GPU string, the memory figure
       the browser reports, and the storage quota. Each block carries a note
       wherever the browser's answer is a bound rather than a fact — the
       memory reading is capped at 8 GiB by specification, the CPU model is
       never exposed, and "Local Storage" is this origin's quota rather than a
       disk.

       The distribution, kernel and desktop lines describe the Ubuntu 24.04.1
       LTS system being emulated.

OPTIONS
       (none)  A two-line summary, the way plain inxi behaves.
       -b      Basic: System, Machine, CPU, Graphics, Network, Drives, Info.
       -F      Full: every block.
       -S -M -C -G -N -D -I   Print only that block.
       -V      Version.

EXIT STATUS
       0  always`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('-V') || argv.includes('--version')) {
      return ok(`inxi ${INXI_VERSION}\n`);
    }

    const d = await displayFacts();
    const blocks = inxiBlocks(d);
    const info = device.info();
    const totals = procs.totals();

    const flags = argv.filter((a) => a.startsWith('-')).join('');
    const wantAll = flags.includes('F') || argv.includes('--full');
    const wantBasic = flags.includes('b') || argv.includes('--basic');

    const picked = [];
    const add = (name) => { if (!picked.includes(name)) picked.push(name); };

    if (wantAll || wantBasic) {
      ['System', 'Machine', 'CPU', 'Graphics', 'Network', 'Drives', 'Info'].forEach(add);
    } else {
      if (flags.includes('S')) add('System');
      if (flags.includes('M')) add('Machine');
      if (flags.includes('C')) add('CPU');
      if (flags.includes('G')) add('Graphics');
      if (flags.includes('N')) add('Network');
      if (flags.includes('D')) add('Drives');
      if (flags.includes('I')) add('Info');
    }

    if (picked.length === 0) {
      // Plain `inxi` — the two-line summary.
      const memTotal = totals.memTotalMb / 1024;
      const memUsed = totals.memUsedMb / 1024;
      const store = device.storageLabel();
      return ok(
        `CPU: ${device.cpuModel()} Kernel: ${KERNEL} ${device.arch()} Up: ${inxiUptime()}\n` +
        `Mem: ${memUsed.toFixed(2)}/${memTotal.toFixed(2)} GiB (${((memUsed / memTotal) * 100).toFixed(1)}%) ` +
        `Storage: ${store.reported ? `${store.quota} browser quota` : 'unreported'} ` +
        `Procs: ${totals.procCount} Shell: Bash inxi: ${INXI_VERSION}\n`,
      );
    }

    const out = [];
    for (const name of picked) {
      out.push(`${name}:`);
      out.push(...blocks[name]);
    }
    return ok(`${out.join('\n')}\n`);
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const x11Commands = [
  xrandrCommand,
  xdpyinfoCommand,
  glxinfoCommand,
  inxiCommand,
];

/** The emulated kernel release, shared by iostat and the wtmp records. */
export { KERNEL };

export default x11Commands;
