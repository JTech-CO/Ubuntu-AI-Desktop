/**
 * js/core/metrics.js — rolling telemetry (ARCHITECTURE §10).
 *
 * Every series is a fixed-length ring of the last 60 samples so the System
 * Monitor and the AI panels can draw a one-minute window without allocating.
 */

import { bus } from './bus.js';

/** Samples kept per series. */
export const WINDOW = 60;

const series = new Map([
  ['latency', new Array(WINDOW).fill(0)],
  ['throughput', new Array(WINDOW).fill(0)],
  ['cpu', new Array(WINDOW).fill(0)],
  ['mem', new Array(WINDOW).fill(0)],
  ['net', new Array(WINDOW).fill(0)],
]);

const counters = {
  requests: 0,
  errors: 0,
  totalMs: 0,
  totalChars: 0,
};

function ring(name) {
  let arr = series.get(name);
  if (!arr) {
    arr = new Array(WINDOW).fill(0);
    series.set(name, arr);
  }
  return arr;
}

export const metrics = {
  /**
   * Record one completed AI request.
   * @param {number} ms wall-clock duration
   * @param {number} chars characters produced
   */
  recordRequest(ms, chars) {
    const duration = Number.isFinite(ms) && ms >= 0 ? ms : 0;
    const size = Number.isFinite(chars) && chars >= 0 ? chars : 0;
    counters.requests += 1;
    counters.totalMs += duration;
    counters.totalChars += size;
    metrics.push('latency', Math.round(duration));
    // Characters per second — the closest honest proxy for tokens/s.
    metrics.push('throughput', duration > 0 ? Math.round((size / duration) * 1000) : 0);
  },

  /** Record a failed AI request. */
  recordError() {
    counters.errors += 1;
  },

  /**
   * Append a sample, dropping the oldest.
   * @param {string} name
   * @param {number} value
   */
  push(name, value) {
    const arr = ring(name);
    const v = Number.isFinite(value) ? value : 0;
    arr.push(v);
    while (arr.length > WINDOW) arr.shift();
  },

  /**
   * @param {string} name
   * @returns {number} the most recent sample (0 when the series is empty)
   */
  last(name) {
    const arr = ring(name);
    return arr.length ? arr[arr.length - 1] : 0;
  },

  /**
   * @param {string} name
   * @returns {number[]} a copy of the whole series
   */
  read(name) {
    return ring(name).slice();
  },

  /** @returns {number[]} request latency in ms */
  latency() {
    return ring('latency').slice();
  },

  /** @returns {number[]} characters per second */
  throughput() {
    return ring('throughput').slice();
  },

  /** @returns {number[]} total CPU percentage */
  cpuHistory() {
    return ring('cpu').slice();
  },

  /** @returns {number[]} memory used, MiB */
  memHistory() {
    return ring('mem').slice();
  },

  /** @returns {number[]} network throughput, KiB/s */
  netHistory() {
    return ring('net').slice();
  },

  /**
   * @returns {{requests:number, errors:number, avgMs:number, totalChars:number}}
   */
  totals() {
    return {
      requests: counters.requests,
      errors: counters.errors,
      avgMs: counters.requests > 0 ? Math.round(counters.totalMs / counters.requests) : 0,
      totalChars: counters.totalChars,
    };
  },

  /** Zero every series and counter. */
  reset() {
    for (const name of series.keys()) series.set(name, new Array(WINDOW).fill(0));
    counters.requests = 0;
    counters.errors = 0;
    counters.totalMs = 0;
    counters.totalChars = 0;
  },
};

bus.on('ai:error', () => metrics.recordError());
