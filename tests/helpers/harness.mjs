/**
 * tests/helpers/harness.mjs — run the desktop's shell under Node.
 *
 * The terminal's modules are plain browser ES modules. A handful of browser
 * globals (window, document, localStorage, screen, matchMedia) are enough
 * shims for them to load: nothing here draws, and IndexedDB is absent, so
 * the filesystem simply stays in memory.
 *
 * boot() returns a live shell session. sh(line) runs a command line as if
 * typed at the prompt and returns { code, stdout, stderr, screen, prompts }:
 * `screen` is what reached the terminal, `prompts` every ask() prompt shown.
 * Commands see a terminal on stdout (isatty(1) is true), exactly as at the
 * prompt; pipe through `cat` to get plain output.
 */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const noop = () => {};

function installShims() {
  if (globalThis.__uadShims) return;
  globalThis.__uadShims = true;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    key: (i) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
    clear: () => mem.clear(),
  };
  const el = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, appendChild: noop, append: noop, remove: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
    getContext: () => null, children: [], childNodes: [],
  });
  globalThis.window = globalThis;
  globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary' } };
  globalThis.devicePixelRatio = 1;
  globalThis.innerWidth = 1920;
  globalThis.innerHeight = 1080;
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.document = {
    documentElement: el(), body: el(), head: el(), createElement: el, createElementNS: el,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, visibilityState: 'visible', hidden: false, fonts: { ready: Promise.resolve() },
  };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

/** Import a module of the app by its repository path. */
export function load(rel) {
  installShims();
  return import(pathToFileURL(path.join(ROOT, rel)).href);
}

/** Single-quote a word for the emulator's shell. */
export const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** ANSI SGR sequences removed. */
export const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

export async function boot() {
  installShims();
  const shell = await load('js/apps/terminal/shell.js');
  const { commands } = await load('js/apps/terminal/commands/index.js');
  for (const c of commands) shell.registerCommand(c);
  const { fs } = await load('js/core/fs.js');
  const { env } = await load('js/core/env.js');
  const { pkgdb } = await load('js/apps/terminal/commands/pkg-db.js');
  const session = shell.createSession({ cwd: env.home });
  shell.activateSession(session);

  const term = {
    cols: 80, rows: 24, out: '', answers: [], prompts: [],
    write(t) { this.out += t; },
    writeLine(t) { this.out += `${t}\n`; },
    clear() {},
    ask(prompt) {
      this.prompts.push(prompt);
      return Promise.resolve(this.answers.length ? this.answers.shift() : '');
    },
  };

  /**
   * Run a command line as if typed at the prompt.
   * @param {string} line
   * @param {string[]} [answers] replies to any prompts, in order
   */
  async function sh(line, answers = []) {
    term.out = '';
    term.answers = answers.slice();
    term.prompts = [];
    const res = await shell.execute(line, { session, term });
    shell.syncSession(session);
    return { code: res.code, stdout: res.stdout, stderr: res.stderr, screen: term.out, prompts: term.prompts.slice() };
  }

  return { shell, fs, env, pkgdb, session, term, sh };
}
