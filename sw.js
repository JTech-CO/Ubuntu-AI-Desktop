/**
 * sw.js — the service worker, used for one thing only: letting Python block.
 *
 * Python's input() and time.sleep() are synchronous. Python runs in a Web
 * Worker (js/apps/terminal/python-worker.js), and a worker can only block on
 * a synchronous XMLHttpRequest — SharedArrayBuffer would need cross-origin
 * isolation headers, which GitHub Pages cannot send and which would break the
 * browser app's embedded sites.
 *
 * So the worker asks for  …/__uad_py__/stdin/<key>  and this service worker
 * holds that request open until the page posts the line the user typed, and
 * answers  …/__uad_py__/sleep/<ms>  after that many milliseconds.
 *
 * Every other request is left alone: no respondWith, no cache, so the site
 * behaves exactly as it would without a service worker.
 */

/* global self, Response */

const PREFIX = '/__uad_py__/';
/** Stay well inside the browser's limit for one fetch event; the worker re-asks. */
const HOLD_MS = 4 * 60 * 1000;

const pending = new Map();   // key -> deliver(value)
const early = new Map();     // key -> value that arrived before the request

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'uad-py-stdin' || typeof data.key !== 'string') return;
  const deliver = pending.get(data.key);
  if (deliver) {
    pending.delete(data.key);
    deliver(data.value);
  } else {
    early.set(data.key, data.value);
  }
});

function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const at = url.pathname.indexOf(PREFIX);
  if (at < 0) return;
  const [kind, arg] = url.pathname.slice(at + PREFIX.length).split('/');

  if (kind === 'ping') {
    event.respondWith(new Response('pong', { headers: { 'Cache-Control': 'no-store' } }));
    return;
  }

  if (kind === 'sleep') {
    const ms = Math.max(0, Math.min(Number(arg) || 0, HOLD_MS));
    event.respondWith(new Promise((resolve) => {
      setTimeout(() => resolve(new Response('', { headers: { 'Cache-Control': 'no-store' } })), ms);
    }));
    return;
  }

  if (kind === 'stdin' && arg) {
    event.respondWith(new Promise((resolve) => {
      if (early.has(arg)) {
        const value = early.get(arg);
        early.delete(arg);
        resolve(json(value));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(arg);
        resolve(json({ retry: true }));
      }, HOLD_MS);
      pending.set(arg, (value) => {
        clearTimeout(timer);
        resolve(json(value));
      });
    }));
  }
});
