/**
 * js/apps/terminal/ansi.js — ANSI SGR → safe DOM (ARCHITECTURE §17).
 *
 * A real SGR state machine. Every glyph that reaches the document is written
 * with `textContent`; nothing here ever touches `innerHTML`, so command output,
 * file contents and AI responses can be rendered verbatim without risk.
 *
 * Supported: 0 1 2 3 4 7 9 21 22 23 24 27 29 39 49, 30–37, 90–97, 40–47,
 * 100–107, `38;5;N` / `48;5;N` (xterm-256, palette computed) and
 * `38;2;R;G;B` / `48;2;R;G;B` truecolour. Non-SGR CSI and OSC sequences are
 * consumed and discarded so raw control bytes never leak into the page.
 */

const ESC = '\u001B';
const BEL = '\u0007';

/**
 * Ubuntu ships the Tango palette as gnome-terminal's built-in default, so the
 * first sixteen slots are Tango, not the generic VGA colours.
 */
export const ANSI_16 = Object.freeze([
  '#2E3436', '#CC0000', '#4E9A06', '#C4A000',
  '#3465A4', '#75507B', '#06989A', '#D3D7CF',
  '#555753', '#EF2929', '#8AE234', '#FCE94F',
  '#729FCF', '#AD7FA8', '#34E2E2', '#EEEEEC',
]);

/** The six intensity steps of the xterm 6×6×6 colour cube. */
const CUBE_STEPS = Object.freeze([0, 95, 135, 175, 215, 255]);

function buildPalette() {
  const out = new Array(256);
  for (let i = 0; i < 16; i += 1) {
    // Themeable: terminal.css defines --term-ansi-0..15, the hex is the fallback.
    out[i] = `var(--term-ansi-${i}, ${ANSI_16[i]})`;
  }
  for (let i = 16; i < 232; i += 1) {
    const n = i - 16;
    const r = CUBE_STEPS[Math.floor(n / 36) % 6];
    const g = CUBE_STEPS[Math.floor(n / 6) % 6];
    const b = CUBE_STEPS[n % 6];
    out[i] = `rgb(${r}, ${g}, ${b})`;
  }
  for (let i = 232; i < 256; i += 1) {
    const v = 8 + (i - 232) * 10;
    out[i] = `rgb(${v}, ${v}, ${v})`;
  }
  return out;
}

/** @type {readonly string[]} 256 CSS colour strings, index = SGR colour number. */
export const PALETTE = Object.freeze(buildPalette());

/* ------------------------------------------------------------------ *
 * SGR state
 * ------------------------------------------------------------------ */

function newState() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
    hidden: false,
  };
}

function resetState(s) {
  s.fg = null;
  s.bg = null;
  s.bold = false;
  s.dim = false;
  s.italic = false;
  s.underline = false;
  s.inverse = false;
  s.strike = false;
  s.hidden = false;
}

function isPlain(s) {
  return (
    s.fg === null && s.bg === null && !s.bold && !s.dim && !s.italic &&
    !s.underline && !s.inverse && !s.strike && !s.hidden
  );
}

function clamp255(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Apply one SGR parameter string (the text between `ESC [` and `m`).
 * @param {object} s mutable state
 * @param {string} params
 */
function applySGR(s, params) {
  const raw = params === '' ? '0' : params;
  const codes = raw.split(/[;:]/).map((t) => (t === '' ? 0 : Number.parseInt(t, 10)));

  for (let i = 0; i < codes.length; i += 1) {
    const n = codes[i];
    if (!Number.isFinite(n)) continue;

    if (n === 0) { resetState(s); continue; }
    if (n === 1) { s.bold = true; continue; }
    if (n === 2) { s.dim = true; continue; }
    if (n === 3) { s.italic = true; continue; }
    if (n === 4) { s.underline = true; continue; }
    if (n === 5 || n === 6) { continue; }            /* blink — deliberately ignored */
    if (n === 7) { s.inverse = true; continue; }
    if (n === 8) { s.hidden = true; continue; }
    if (n === 9) { s.strike = true; continue; }
    if (n === 21) { s.bold = false; continue; }
    if (n === 22) { s.bold = false; s.dim = false; continue; }
    if (n === 23) { s.italic = false; continue; }
    if (n === 24) { s.underline = false; continue; }
    if (n === 25) { continue; }
    if (n === 27) { s.inverse = false; continue; }
    if (n === 28) { s.hidden = false; continue; }
    if (n === 29) { s.strike = false; continue; }

    if (n >= 30 && n <= 37) { s.fg = PALETTE[n - 30]; continue; }
    if (n === 39) { s.fg = null; continue; }
    if (n >= 40 && n <= 47) { s.bg = PALETTE[n - 40]; continue; }
    if (n === 49) { s.bg = null; continue; }
    if (n >= 90 && n <= 97) { s.fg = PALETTE[n - 90 + 8]; continue; }
    if (n >= 100 && n <= 107) { s.bg = PALETTE[n - 100 + 8]; continue; }

    if (n === 38 || n === 48) {
      const mode = codes[i + 1];
      if (mode === 5) {
        const idx = clamp255(codes[i + 2]);
        if (n === 38) s.fg = PALETTE[idx];
        else s.bg = PALETTE[idx];
        i += 2;
        continue;
      }
      if (mode === 2) {
        const col = `rgb(${clamp255(codes[i + 2])}, ${clamp255(codes[i + 3])}, ${clamp255(codes[i + 4])})`;
        if (n === 38) s.fg = col;
        else s.bg = col;
        i += 4;
        continue;
      }
      // Unknown sub-form: swallow the remaining parameters rather than
      // mis-reading them as further attributes.
      i = codes.length;
      continue;
    }
  }
}

/**
 * @param {string} text
 * @param {object} s
 * @returns {Node} a text node when no attributes are active, otherwise a span
 */
function styledNode(text, s) {
  if (isPlain(s)) return document.createTextNode(text);

  const span = document.createElement('span');
  span.textContent = text;                      /* SAFE: never innerHTML */

  const fg = s.inverse ? (s.bg || 'var(--term-bg)') : s.fg;
  const bg = s.inverse ? (s.fg || 'var(--term-fg)') : s.bg;

  if (fg) span.style.color = fg;
  if (bg) span.style.backgroundColor = bg;
  if (s.bold) span.style.fontWeight = '700';
  if (s.dim) span.style.opacity = '0.62';
  if (s.italic) span.style.fontStyle = 'italic';
  if (s.underline && s.strike) span.style.textDecoration = 'underline line-through';
  else if (s.underline) span.style.textDecoration = 'underline';
  else if (s.strike) span.style.textDecoration = 'line-through';
  if (s.hidden) span.style.visibility = 'hidden';

  return span;
}

/**
 * Convert a string containing ANSI escapes into styled DOM.
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function ansiToNodes(text) {
  const fragment = document.createDocumentFragment();
  if (text === null || text === undefined) return fragment;

  const src = String(text);
  const state = newState();
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf === '') return;
    fragment.appendChild(styledNode(buf, state));
    buf = '';
  };

  while (i < src.length) {
    const c = src[i];

    if (c !== ESC) {
      buf += c;
      i += 1;
      continue;
    }

    const next = src[i + 1];

    if (next === '[') {
      let j = i + 2;
      while (j < src.length && !/[@-~]/.test(src[j])) j += 1;
      const final = src[j];
      const params = src.slice(i + 2, j);
      i = j < src.length ? j + 1 : src.length;
      if (final === 'm') {
        flush();
        applySGR(state, params);
      }
      continue;
    }

    if (next === ']') {
      let j = i + 2;
      while (j < src.length) {
        if (src[j] === BEL) { j += 1; break; }
        if (src[j] === ESC && src[j + 1] === '\\') { j += 2; break; }
        j += 1;
      }
      i = j;
      continue;
    }

    if (next === undefined) { i += 1; continue; }
    i += 2;                                     /* two-character escape */
  }

  flush();
  return fragment;
}

/** Matches CSI, OSC and simple two-character escape sequences. */
const ANSI_RE =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/**
 * @param {string} text
 * @returns {string} the same text with every escape sequence removed
 */
export function stripAnsi(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(ANSI_RE, '');
}

/**
 * Printable width of a string, ignoring escape sequences.
 * @param {string} text
 * @returns {number}
 */
export function ansiWidth(text) {
  return stripAnsi(text).length;
}

/* ------------------------------------------------------------------ *
 * C — ergonomic colourisers for command implementations
 * ------------------------------------------------------------------ */

const RESET = `${ESC}[0m`;

function wrap(open, close) {
  return (s) => {
    const body = s === undefined || s === null ? '' : String(s);
    return `${ESC}[${open}m${body}${ESC}[${close}m`;
  };
}

/**
 * Colouriser helpers. Every member is a function `(text) => string` that wraps
 * `text` in the matching SGR pair, so they nest safely:
 * `C.bold(C.green('ok'))`.
 */
export const C = {
  /** Raw escape strings for the rare case a command needs to emit them. */
  raw: Object.freeze({
    reset: RESET,
    bold: `${ESC}[1m`,
    dim: `${ESC}[2m`,
    italic: `${ESC}[3m`,
    underline: `${ESC}[4m`,
    inverse: `${ESC}[7m`,
    clearLine: `${ESC}[2K\r`,
  }),

  reset: (s) => (s === undefined || s === null ? RESET : `${RESET}${String(s)}${RESET}`),

  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  strike: wrap(9, 29),

  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),

  gray: wrap(90, 39),
  grey: wrap(90, 39),
  brightRed: wrap(91, 39),
  brightGreen: wrap(92, 39),
  brightYellow: wrap(93, 39),
  brightBlue: wrap(94, 39),
  brightMagenta: wrap(95, 39),
  brightCyan: wrap(96, 39),
  brightWhite: wrap(97, 39),

  bgBlack: wrap(40, 49),
  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
  bgYellow: wrap(43, 49),
  bgBlue: wrap(44, 49),
  bgMagenta: wrap(45, 49),
  bgCyan: wrap(46, 49),
  bgWhite: wrap(47, 49),

  /**
   * xterm-256 foreground.
   * @param {number} n 0–255
   * @param {string} s
   */
  color(n, s) {
    return `${ESC}[38;5;${clamp255(n)}m${s === undefined ? '' : String(s)}${ESC}[39m`;
  },

  /**
   * xterm-256 background.
   * @param {number} n 0–255
   * @param {string} s
   */
  bg(n, s) {
    return `${ESC}[48;5;${clamp255(n)}m${s === undefined ? '' : String(s)}${ESC}[49m`;
  },

  /**
   * 24-bit foreground.
   * @param {number} r @param {number} g @param {number} b @param {string} s
   */
  rgb(r, g, b, s) {
    return `${ESC}[38;2;${clamp255(r)};${clamp255(g)};${clamp255(b)}m${s === undefined ? '' : String(s)}${ESC}[39m`;
  },

  /* --- LS_COLORS semantics, so `ls` and `tree` agree --------------- */
  dir: wrap('01;34', 0),
  exec: wrap('01;32', 0),
  link: wrap('01;36', 0),
  archive: wrap('01;31', 0),
  image: wrap('01;35', 0),
  media: wrap('01;35', 0),
  sock: wrap('01;35', 0),
  pipe: wrap('40;33', 0),
  broken: wrap('40;31;01', 0),

  /* --- Ubuntu accent, used by neofetch/apt style output ----------- */
  ubuntu: (s) => `${ESC}[38;2;233;84;32m${s === undefined ? '' : String(s)}${ESC}[39m`,
};

Object.freeze(C);
