/**
 * js/apps/monitor/resources.js — the "Resources" tab of System Monitor.
 *
 * Three graph cards, exactly as GNOME lays them out: CPU History with one
 * trace per logical core, Memory and Swap History as filled areas, and
 * Network History with receive/send traces plus cumulative totals.
 *
 * CPU and memory come from `procs`, which takes its core count and RAM total
 * from the real machine via `js/core/device.js` — so this tab draws exactly one
 * trace per logical CPU the host actually has, and the memory card scales to
 * the host's actual RAM figure. The AI request series comes from `metrics`.
 * Network throughput is simulated here — nothing in this app makes real traffic
 * — and is biased by the AI activity `metrics` has recorded so the graph reacts
 * when the assistant is used.
 */

import { h } from '../../core/dom.js';
import { procs } from '../../core/procs.js';
import { metrics } from '../../core/metrics.js';
import {
  createLineChart,
  createLegend,
  CPU_COLORS,
  MEM_COLORS,
  NET_COLORS,
  formatBinary,
  formatRate,
  formatGiB,
} from './charts.js';

/**
 * A distinct trace colour per logical CPU. The shared palette covers twelve;
 * machines with more cores than that get evenly spaced hues beyond it rather
 * than a repeat, so no two adjacent traces collide on a 16- or 24-thread box.
 *
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
function coreColor(index, total) {
  if (index < CPU_COLORS.length) return CPU_COLORS[index];
  const extra = total - CPU_COLORS.length;
  const hue = Math.round((360 / Math.max(1, extra)) * (index - CPU_COLORS.length));
  return `hsl(${hue} 58% 52%)`;
}

/** Wrap a chart canvas plus its legend in the standard Adwaita card. */
function graphCard(title, canvas, legend, readouts) {
  const card = h('section.mon-card', {}, h('h2.mon-card__title', { text: title }));
  if (readouts) card.appendChild(readouts);
  card.appendChild(h('div.mon-card__canvas', {}, canvas));
  card.appendChild(legend);
  return card;
}

/**
 * @returns {{el: HTMLElement, update(): void, show(): void, destroy(): void}}
 */
export function createResourcesTab() {
  // `procs.cores` is navigator.hardwareConcurrency, clamped only against a
  // browser reporting nonsense. `procs.perCore()` returns exactly this many
  // samples, so the traces, the legend and the data can never disagree.
  const cores = procs.cores;

  /* --- CPU ------------------------------------------------------- */

  const cpuSeries = [];
  for (let i = 0; i < cores; i += 1) {
    cpuSeries.push({ id: `cpu${i}`, label: `CPU${i + 1}`, color: coreColor(i, cores) });
  }
  const cpuCanvas = h('canvas.mon-chart', { 'aria-label': `CPU history, ${cores} logical processors` });
  const cpuChart = createLineChart(cpuCanvas, {
    series: cpuSeries,
    max: 100,
    gridLines: 5,
    lineWidth: cores > 12 ? 1.2 : 1.5,
    formatY: (value) => `${Math.round(value)} %`,
  });
  const cpuLegend = createLegend(cpuSeries, { columns: Math.min(4, Math.max(1, cores)) });

  /* --- memory & swap --------------------------------------------- */

  const memSeries = [
    { id: 'memory', label: 'Memory', color: MEM_COLORS.memory, fill: true },
    { id: 'swap', label: 'Swap', color: MEM_COLORS.swap, fill: true },
  ];
  const memCanvas = h('canvas.mon-chart', { 'aria-label': 'Memory and swap history' });
  const memChart = createLineChart(memCanvas, {
    series: memSeries,
    max: 100,
    gridLines: 5,
    lineWidth: 1.7,
    formatY: (value) => `${Math.round(value)} %`,
  });

  const memReadout = h('span.mon-readout__value', { text: '—' });
  const swapReadout = h('span.mon-readout__value', { text: '—' });
  const memReadouts = h(
    'div.mon-readouts',
    {},
    h(
      'div.mon-readout',
      {},
      h('span.mon-readout__swatch', { style: { background: MEM_COLORS.memory } }),
      h('span.mon-readout__label', { text: 'Memory' }),
      memReadout,
    ),
    h(
      'div.mon-readout',
      {},
      h('span.mon-readout__swatch', { style: { background: MEM_COLORS.swap } }),
      h('span.mon-readout__label', { text: 'Swap' }),
      swapReadout,
    ),
  );

  /* --- network ---------------------------------------------------- */

  const netSeries = [
    { id: 'receiving', label: 'Receiving', color: NET_COLORS.receiving },
    { id: 'sending', label: 'Sending', color: NET_COLORS.sending },
  ];
  const netCanvas = h('canvas.mon-chart', { 'aria-label': 'Network history' });
  const netChart = createLineChart(netCanvas, {
    series: netSeries,
    max: 'auto',
    minMax: 4096,
    gridLines: 4,
    lineWidth: 1.7,
    formatY: (value) => formatRate(value),
  });

  const rxRateNode = h('span.mon-readout__value', { text: '0 B/s' });
  const txRateNode = h('span.mon-readout__value', { text: '0 B/s' });
  const rxTotalNode = h('span.mon-readout__value', { text: '0 B' });
  const txTotalNode = h('span.mon-readout__value', { text: '0 B' });

  const netReadouts = h(
    'div.mon-readouts.mon-readouts--net',
    {},
    h(
      'div.mon-readout',
      {},
      h('span.mon-readout__swatch', { style: { background: NET_COLORS.receiving } }),
      h('span.mon-readout__label', { text: 'Receiving' }),
      rxRateNode,
    ),
    h('div.mon-readout', {}, h('span.mon-readout__label', { text: 'Total Received' }), rxTotalNode),
    h(
      'div.mon-readout',
      {},
      h('span.mon-readout__swatch', { style: { background: NET_COLORS.sending } }),
      h('span.mon-readout__label', { text: 'Sending' }),
      txRateNode,
    ),
    h('div.mon-readout', {}, h('span.mon-readout__label', { text: 'Total Sent' }), txTotalNode),
  );

  const netLegend = h('div.mon-legend.mon-legend--empty');

  /* --- layout ----------------------------------------------------- */

  const el = h(
    'div.mon-tab.mon-tab--resources',
    {},
    graphCard('CPU History', cpuCanvas, cpuLegend.el, null),
    graphCard('Memory and Swap History', memCanvas, h('div.mon-legend.mon-legend--empty'), memReadouts),
    graphCard('Network History', netCanvas, netLegend, netReadouts),
  );

  /* --- simulated interface counters -------------------------------- */

  // The machine "has been up" for a while, so the totals start non-zero —
  // the same numbers `ifconfig`/`ip -s link` would already be showing.
  let rxTotal = 1_284_663_552;
  let txTotal = 213_884_032;
  let rxRate = 24_576;
  let txRate = 6_144;
  let lastAiRequests = metrics.totals().requests;

  function stepNetwork() {
    const totals = metrics.totals();
    // A finished AI request produces a visible burst on both directions.
    const burst = totals.requests > lastAiRequests;
    lastAiRequests = totals.requests;

    const load = procs.totals().cpu / 100;
    const rxTarget = 12_000 + load * 180_000 + (burst ? 900_000 + Math.random() * 1_400_000 : 0);
    const txTarget = 3_000 + load * 40_000 + (burst ? 120_000 + Math.random() * 260_000 : 0);

    rxRate = Math.max(0, rxRate * 0.55 + rxTarget * 0.45 + (Math.random() - 0.5) * 14_000);
    txRate = Math.max(0, txRate * 0.55 + txTarget * 0.45 + (Math.random() - 0.5) * 4_000);

    rxTotal += rxRate;
    txTotal += txRate;
  }

  function update() {
    const totals = procs.totals();
    const perCore = procs.perCore();

    cpuChart.push(perCore);
    cpuLegend.update(perCore.map((v) => `${v.toFixed(1)} %`));

    const memPercent = (totals.memUsedMb / totals.memTotalMb) * 100;
    const swapPercent = totals.swapTotalMb > 0 ? (totals.swapUsedMb / totals.swapTotalMb) * 100 : 0;
    memChart.push([memPercent, swapPercent]);
    memReadout.textContent =
      `${formatGiB(totals.memUsedMb)} (${memPercent.toFixed(1)}%) of ${formatGiB(totals.memTotalMb)}`;
    swapReadout.textContent =
      `${formatGiB(totals.swapUsedMb)} (${swapPercent.toFixed(1)}%) of ${formatGiB(totals.swapTotalMb)}`;

    stepNetwork();
    netChart.push([rxRate, txRate]);
    rxRateNode.textContent = formatRate(rxRate);
    txRateNode.textContent = formatRate(txRate);
    rxTotalNode.textContent = formatBinary(rxTotal);
    txTotalNode.textContent = formatBinary(txTotal);
  }

  update();

  return {
    el,
    update,
    show() {
      cpuChart.resize();
      memChart.resize();
      netChart.resize();
    },
    destroy() {
      cpuChart.destroy();
      memChart.destroy();
      netChart.destroy();
    },
  };
}
