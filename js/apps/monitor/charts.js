/**
 * js/apps/monitor/charts.js — canvas chart primitives for System Monitor.
 *
 * Reproduces the GNOME System Monitor "Resources" graphs: a one-minute time
 * window scrolling right-to-left, horizontal grid lines with percentage (or
 * unit) labels down the left edge, second labels along the bottom, and one
 * smooth non-overshooting curve per series.
 *
 * Everything is HiDPI correct: the backing store is sized by
 * `devicePixelRatio` and the 2D context is scaled so all drawing maths stays
 * in CSS pixels. A `ResizeObserver` plus a `window.resize` listener keep the
 * backing store in step with layout and with browser-zoom changes.
 */

import { h } from '../../core/dom.js';

/** Samples retained per series — 60 seconds plus the leading edge. */
export const DEFAULT_POINTS = 61;

/** Per-core trace colours (Yaru accent family, maximally distinguishable). */
export const CPU_COLORS = Object.freeze([
  '#e95420', '#0073e5', '#03875b', '#b34cb3',
  '#f99b11', '#308280', '#7764d8', '#da3450',
  '#4b8501', '#787859', '#657b69', '#2c72b8',
]);

/** Memory / swap trace colours. */
export const MEM_COLORS = Object.freeze({ memory: '#7764d8', swap: '#e95420' });

/** Network receive / send trace colours. */
export const NET_COLORS = Object.freeze({ receiving: '#0073e5', sending: '#03875b' });

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const DECIMAL_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/* ------------------------------------------------------------------ *
 * formatting — shared by the charts, the legends and the tables
 * ------------------------------------------------------------------ */

/**
 * IEC formatting, exactly how GNOME System Monitor prints memory.
 * @param {number} bytes
 * @param {number} [digits]
 * @returns {string} e.g. `412.7 MiB`
 */
export function formatBinary(bytes, digits = 1) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < BINARY_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const places = unit === 0 ? 0 : digits;
  return `${scaled.toFixed(places)} ${BINARY_UNITS[unit]}`;
}

/**
 * SI formatting, how the File Systems tab prints disk capacities.
 * @param {number} bytes
 * @param {number} [digits]
 * @returns {string} e.g. `105.6 GB`
 */
export function formatDecimal(bytes, digits = 1) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  let unit = 0;
  let scaled = value;
  while (scaled >= 1000 && unit < DECIMAL_UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const places = unit === 0 ? 0 : digits;
  return `${scaled.toFixed(places)} ${DECIMAL_UNITS[unit]}`;
}

/**
 * @param {number} bytesPerSecond
 * @returns {string} e.g. `12.4 KiB/s`
 */
export function formatRate(bytesPerSecond) {
  return `${formatBinary(bytesPerSecond, 1)}/s`;
}

/**
 * @param {number} mib mebibytes
 * @returns {string} e.g. `3.4 GiB`
 */
export function formatGiB(mib) {
  const value = Number.isFinite(mib) ? Math.max(0, mib) : 0;
  return `${(value / 1024).toFixed(1)} GiB`;
}

/* ------------------------------------------------------------------ *
 * internals
 * ------------------------------------------------------------------ */

/**
 * Round a value up to 1, 2, 2.5 or 5 times a power of ten so the auto-scaled
 * axis lands on labels a human would have chosen.
 * @param {number} v
 * @returns {number}
 */
export function niceCeil(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exponent = Math.floor(Math.log10(v));
  const base = 10 ** exponent;
  const normalised = v / base;
  let step;
  if (normalised <= 1) step = 1;
  else if (normalised <= 2) step = 2;
  else if (normalised <= 2.5) step = 2.5;
  else if (normalised <= 5) step = 5;
  else step = 10;
  return step * base;
}

function readVar(node, name, fallback) {
  const value = getComputedStyle(node).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/** Convert `#rrggbb` to `rgba(r, g, b, a)`; other formats pass through. */
function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!hex) return color;
  const int = parseInt(hex[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Catmull-Rom spline emitted as cubic beziers, with control points clamped to
 * the segment's own y-range so the curve never overshoots a data point.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number, y:number}[]} pts
 */
function smoothPath(ctx, pts) {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const lo = Math.min(p1.y, p2.y);
    const hi = Math.max(p1.y, p2.y);
    const c1y = Math.min(hi, Math.max(lo, p1.y + (p2.y - p0.y) / 6));
    const c2y = Math.min(hi, Math.max(lo, p2.y - (p3.y - p1.y) / 6));
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
}

/* ------------------------------------------------------------------ *
 * createLineChart
 * ------------------------------------------------------------------ */

/**
 * Build a scrolling multi-series line chart on a `<canvas>`.
 *
 * @param {HTMLCanvasElement} canvas target canvas; it is sized from its own
 *        CSS box, so give it a width/height through CSS.
 * @param {{
 *   series: {id?:string, label?:string, color:string, fill?:boolean}[],
 *   max?: number | 'auto',
 *   min?: number,
 *   points?: number,
 *   timeSpan?: number,
 *   gridLines?: number,
 *   fill?: boolean,
 *   lineWidth?: number,
 *   headroom?: number,
 *   minMax?: number,
 *   formatY?: (value:number, fraction:number) => string,
 * }} opts
 * @returns {{
 *   push(values:number[]|Record<string,number>): void,
 *   resize(): void,
 *   draw(): void,
 *   destroy(): void,
 *   setMax(max:number|'auto'): void,
 *   values(index:number): number[],
 *   last(index:number): number,
 *   canvas: HTMLCanvasElement,
 * }}
 */
export function createLineChart(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createLineChart: a <canvas> element is required');
  }

  const ctx = canvas.getContext('2d');
  const seriesDefs = (opts.series || []).map((s, i) => ({
    id: s.id || `s${i}`,
    label: s.label || s.id || `Series ${i + 1}`,
    color: s.color || CPU_COLORS[i % CPU_COLORS.length],
    fill: s.fill === undefined ? opts.fill === true : s.fill === true,
  }));

  const points = Math.max(2, Math.floor(opts.points || DEFAULT_POINTS));
  const timeSpan = Math.max(1, Math.floor(opts.timeSpan || 60));
  const gridLines = Math.max(1, Math.floor(opts.gridLines || 5));
  const lineWidth = opts.lineWidth === undefined ? 1.6 : opts.lineWidth;
  const minValue = opts.min === undefined ? 0 : opts.min;
  const headroom = opts.headroom === undefined ? 1.15 : opts.headroom;
  const minMax = opts.minMax === undefined ? 1 : opts.minMax;
  const formatY =
    typeof opts.formatY === 'function'
      ? opts.formatY
      : (value) => `${Math.round(value)} %`;

  /** @type {number[][]} one ring per series, oldest first. */
  const data = seriesDefs.map(() => new Array(points).fill(minValue));

  let configuredMax = opts.max === undefined ? 100 : opts.max;
  let currentMax = configuredMax === 'auto' ? minMax : configuredMax;
  let frame = 0;
  let destroyed = false;
  let observer = null;

  function visible() {
    return canvas.isConnected && canvas.clientWidth > 0 && canvas.clientHeight > 0;
  }

  function syncBackingStore() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  function computeMax() {
    if (configuredMax !== 'auto') return configuredMax;
    let peak = minMax;
    for (const ring of data) {
      for (const v of ring) if (v > peak) peak = v;
    }
    const target = niceCeil(peak * headroom);
    // Ease toward the new scale so the axis does not jitter every second.
    currentMax = currentMax > target ? Math.max(target, currentMax * 0.9) : target;
    return Math.max(minMax, currentMax);
  }

  function draw() {
    if (destroyed || !visible()) return;
    const { w, h } = syncBackingStore();

    const gridColor = readVar(canvas, '--chart-grid', 'rgba(0,0,0,0.09)');
    const textColor = readVar(canvas, '--chart-text', 'rgba(0,0,0,0.55)');
    const bgColor = readVar(canvas, '--chart-bg', 'transparent');
    const font = readVar(canvas, '--chart-font', '11px Ubuntu, system-ui, sans-serif');

    ctx.clearRect(0, 0, w, h);
    if (bgColor !== 'transparent') {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.font = font;
    ctx.textBaseline = 'middle';

    const max = computeMax();

    // Reserve space for the widest y label and for the bottom time labels.
    let labelWidth = 0;
    for (let i = 0; i <= gridLines; i += 1) {
      const value = minValue + ((max - minValue) * i) / gridLines;
      labelWidth = Math.max(labelWidth, ctx.measureText(formatY(value, i / gridLines)).width);
    }
    const padLeft = Math.ceil(labelWidth) + 10;
    const padRight = 4;
    const padTop = 8;
    const padBottom = 18;

    const plotX = padLeft;
    const plotY = padTop;
    const plotW = Math.max(1, w - padLeft - padRight);
    const plotH = Math.max(1, h - padTop - padBottom);

    // --- grid ------------------------------------------------------
    ctx.lineWidth = 1;
    ctx.strokeStyle = gridColor;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right';

    for (let i = 0; i <= gridLines; i += 1) {
      const fraction = i / gridLines;
      const y = Math.round(plotY + plotH * fraction) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotX, y);
      ctx.lineTo(plotX + plotW, y);
      ctx.stroke();
      const value = minValue + (max - minValue) * (1 - fraction);
      ctx.fillText(formatY(value, 1 - fraction), plotX - 6, y);
    }

    // Vertical rules and the second labels along the bottom.
    const divisions = 6;
    ctx.textAlign = 'center';
    for (let i = 0; i <= divisions; i += 1) {
      const x = Math.round(plotX + (plotW * i) / divisions) + 0.5;
      if (i > 0 && i < divisions) {
        ctx.beginPath();
        ctx.moveTo(x, plotY);
        ctx.lineTo(x, plotY + plotH);
        ctx.stroke();
      }
      const seconds = Math.round(timeSpan - (timeSpan * i) / divisions);
      const label = i === 0 ? `${seconds} seconds` : String(seconds);
      const anchor = i === 0 ? 'left' : i === divisions ? 'right' : 'center';
      ctx.textAlign = anchor;
      const tx = i === 0 ? plotX : i === divisions ? plotX + plotW : x;
      ctx.fillText(label, tx, plotY + plotH + 10);
    }

    // --- traces ----------------------------------------------------
    const stepX = plotW / (points - 1);
    const span = Math.max(1e-9, max - minValue);

    for (let s = 0; s < seriesDefs.length; s += 1) {
      const ring = data[s];
      const def = seriesDefs[s];
      const pts = new Array(points);
      for (let i = 0; i < points; i += 1) {
        const clamped = Math.min(max, Math.max(minValue, ring[i]));
        pts[i] = {
          x: plotX + stepX * i,
          y: plotY + plotH * (1 - (clamped - minValue) / span),
        };
      }

      if (def.fill) {
        ctx.beginPath();
        smoothPath(ctx, pts);
        ctx.lineTo(plotX + plotW, plotY + plotH);
        ctx.lineTo(plotX, plotY + plotH);
        ctx.closePath();
        const gradient = ctx.createLinearGradient(0, plotY, 0, plotY + plotH);
        gradient.addColorStop(0, withAlpha(def.color, 0.34));
        gradient.addColorStop(1, withAlpha(def.color, 0.02));
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      ctx.beginPath();
      smoothPath(ctx, pts);
      ctx.strokeStyle = def.color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Frame the plot so the graph reads as a chart, not a floating scribble.
    ctx.lineWidth = 1;
    ctx.strokeStyle = gridColor;
    ctx.strokeRect(Math.round(plotX) + 0.5, Math.round(plotY) + 0.5, Math.round(plotW), Math.round(plotH));
  }

  function schedule() {
    if (destroyed || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function push(values) {
    for (let s = 0; s < seriesDefs.length; s += 1) {
      const ring = data[s];
      let next;
      if (Array.isArray(values)) next = values[s];
      else if (values && typeof values === 'object') next = values[seriesDefs[s].id];
      if (!Number.isFinite(next)) next = ring[ring.length - 1];
      ring.push(next);
      ring.shift();
    }
    schedule();
  }

  function resize() {
    schedule();
  }

  const onWindowResize = () => resize();
  window.addEventListener('resize', onWindowResize);

  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
  }

  function destroy() {
    destroyed = true;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener('resize', onWindowResize);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  schedule();

  return {
    canvas,
    push,
    resize,
    draw,
    destroy,
    setMax(max) {
      configuredMax = max === undefined ? 100 : max;
      if (configuredMax !== 'auto') currentMax = configuredMax;
      schedule();
    },
    values(index) {
      return (data[index] || []).slice();
    },
    last(index) {
      const ring = data[index];
      return ring && ring.length ? ring[ring.length - 1] : 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * legend
 * ------------------------------------------------------------------ */

/**
 * Build the colour-swatch legend GNOME shows under each resource graph.
 *
 * @param {{id?:string, label:string, color:string}[]} items
 * @param {{columns?:number}} [opts]
 * @returns {{el: HTMLElement, update(values: (string|number)[]|Record<string,string|number>): void}}
 */
export function createLegend(items, opts = {}) {
  const valueNodes = [];
  const root = h('div.mon-legend');
  if (opts.columns) root.style.setProperty('--legend-columns', String(opts.columns));

  items.forEach((item, index) => {
    const value = h('span.mon-legend__value', { text: '—' });
    valueNodes.push({ id: item.id || `s${index}`, node: value });
    root.appendChild(
      h(
        'div.mon-legend__item',
        {},
        h('span.mon-legend__swatch', { style: { background: item.color } }),
        h('span.mon-legend__label', { text: item.label }),
        value,
      ),
    );
  });

  return {
    el: root,
    update(values) {
      valueNodes.forEach((entry, index) => {
        let next;
        if (Array.isArray(values)) next = values[index];
        else if (values && typeof values === 'object') next = values[entry.id];
        entry.node.textContent = next === undefined || next === null ? '—' : String(next);
      });
    },
  };
}
