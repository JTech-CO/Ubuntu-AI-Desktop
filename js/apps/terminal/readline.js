/**
 * js/apps/terminal/readline.js — line editing, history, completion (§17).
 *
 * A hidden `<textarea>` collects keystrokes (so IME composition and the native
 * paste event keep working) while the visible line is rendered as three spans:
 * text-before-cursor, the cursor cell, text-after-cursor. That lets the cursor
 * be drawn as a real block that blinks only while the terminal has focus, and
 * keeps every character on screen inserted with `textContent`.
 *
 * Implements GNU readline's emacs bindings, `HISTCONTROL=ignoreboth` history
 * with `~/.bash_history` persistence, `Ctrl+R` reverse incremental search,
 * bash-shaped tab completion (commands first word, paths afterwards, longest
 * common prefix, aligned column listing on the second Tab) and bracketed-paste
 * handling that queues multi-line pastes to run in sequence.
 */

import { h, clear as clearNode } from '../../core/dom.js';
import { fs } from '../../core/fs.js';
import { store } from '../../core/store.js';
import * as path from '../../core/path.js';
import { completionNames, needsContinuation } from './shell.js';
import { renderPrompt, renderPS2 } from './prompt.js';
import { ansiToNodes, stripAnsi } from './ansi.js';

/** Ubuntu's stock HISTSIZE / HISTFILESIZE. */
const HISTSIZE = 1000;
const HISTFILESIZE = 2000;

const SPECIAL_CHARS = /[ \t'"\\$`&|;<>()*?[\]!#]/;

/* ------------------------------------------------------------------ *
 * word scanning
 * ------------------------------------------------------------------ */

/**
 * Find the word under the cursor, unescaped, plus the quote state it sits in.
 * @param {string} text
 * @param {number} pos
 * @returns {{start:number, word:string, quote:string, cmdPos:boolean}}
 */
function parseWordAt(text, pos) {
  let i = 0;
  let start = 0;
  let quote = '';
  let word = '';
  let started = false;
  let cmdPos = true;

  const boundary = (next, isCommandStart) => {
    if (started) cmdPos = isCommandStart;
    else if (isCommandStart) cmdPos = true;
    word = '';
    started = false;
    start = next;
  };

  while (i < pos) {
    const c = text[i];

    if (quote) {
      if (c === quote) { quote = ''; i += 1; continue; }
      if (quote === '"' && c === '\\' && i + 1 < pos) { word += text[i + 1]; i += 2; continue; }
      word += c;
      i += 1;
      continue;
    }

    if (c === '\\') {
      if (!started) { start = i; started = true; }
      if (i + 1 < pos) { word += text[i + 1]; i += 2; }
      else i += 1;
      continue;
    }

    if (c === "'" || c === '"') {
      if (!started) { start = i; started = true; }
      quote = c;
      i += 1;
      continue;
    }

    if (c === ' ' || c === '\t') { boundary(i + 1, false); i += 1; continue; }
    if (c === '|' || c === ';' || c === '&') { boundary(i + 1, true); i += 1; continue; }
    if (c === '<' || c === '>') { boundary(i + 1, false); i += 1; continue; }

    if (!started) { start = i; started = true; }
    word += c;
    i += 1;
  }

  return { start, word, quote, cmdPos };
}

function escapeForShell(text, quote) {
  if (quote) return String(text);
  if (!SPECIAL_CHARS.test(text)) return String(text);
  return String(text).replace(/([ \t'"\\$`&|;<>()*?[\]!#])/g, '\\$1');
}

function longestCommonPrefix(items) {
  if (items.length === 0) return '';
  let prefix = items[0];
  for (const item of items) {
    let k = 0;
    while (k < prefix.length && k < item.length && prefix[k] === item[k]) k += 1;
    prefix = prefix.slice(0, k);
    if (prefix === '') break;
  }
  return prefix;
}

/**
 * Lay candidates out the way GNU readline does: fixed-width cells, filled
 * left-to-right, wrapped to the terminal width.
 */
function columnize(items, cols) {
  if (items.length === 0) return '';
  const width = Math.max(...items.map((s) => s.length)) + 2;
  const perRow = Math.max(1, Math.floor(Math.max(20, cols) / width));
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow).map((s) => s.padEnd(width));
    rows.push(row.join('').replace(/\s+$/, ''));
  }
  return `${rows.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * history persistence
 * ------------------------------------------------------------------ */

function historyFile(session) {
  return `${session.home}/.bash_history`;
}

function readHistory(session) {
  let lines = [];
  try {
    lines = String(fs.readFile(historyFile(session)))
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l !== '');
  } catch {
    lines = [];
  }
  if (lines.length === 0) {
    const saved = store.get('history', null);
    if (Array.isArray(saved)) lines = saved.filter((l) => typeof l === 'string' && l !== '');
  }
  return lines.slice(-HISTFILESIZE);
}

/* ------------------------------------------------------------------ *
 * factory
 * ------------------------------------------------------------------ */

/**
 * @param {{
 *   session: object,
 *   container: Element,
 *   cols: () => number,
 *   write: (text: string) => void,
 *   clearScreen: () => void,
 *   onSubmit: (line: string) => Promise<any>,
 *   onEOF?: () => void,
 *   onInterrupt?: () => void,
 * }} options
 * @returns {object} the readline instance
 */
export function createReadline(options) {
  const session = options.session;
  const cols = typeof options.cols === 'function' ? options.cols : () => 80;
  const write = typeof options.write === 'function' ? options.write : () => {};
  const clearScreen = typeof options.clearScreen === 'function' ? options.clearScreen : () => {};
  const onSubmit = typeof options.onSubmit === 'function' ? options.onSubmit : async () => {};
  const onEOF = typeof options.onEOF === 'function' ? options.onEOF : () => {};
  const onInterrupt = typeof options.onInterrupt === 'function' ? options.onInterrupt : () => {};

  /* --- DOM -------------------------------------------------------- */
  const promptEl = h('span.term-prompt');
  const preEl = h('span.term-pre');
  const cursorEl = h('span.term-cursor');
  const postEl = h('span.term-post');
  const editEl = h('span.term-edit', {}, preEl, cursorEl, postEl);
  const keyboard = h('textarea.term-keyboard', {
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    rows: '1',
    'aria-label': 'Terminal input',
  });
  const el = h('div.term-line.term-inputline', {}, promptEl, editEl, keyboard);
  options.container.appendChild(el);

  /* --- state ------------------------------------------------------ */
  let buffer = '';
  let cursor = 0;
  let mode = 'edit';                    /* edit | running | search | ask */
  let historyIndex = -1;
  let draft = '';
  let killRing = '';
  let tabPrefix = null;
  let tabCount = 0;
  let pendingLines = [];
  let continuation = '';
  let continuationReason = '';
  let searchQuery = '';
  let searchIndex = -1;
  let searchFailed = false;
  let searchSaved = '';
  let askState = null;
  let askPrevMode = 'edit';
  let saveTimer = 0;
  let disposed = false;

  session.history = readHistory(session);

  /* --- rendering -------------------------------------------------- */

  function promptAnsi() {
    if (mode === 'ask' && askState) return askState.prompt;
    if (mode === 'search') {
      const label = searchFailed ? 'failed reverse-i-search' : 'reverse-i-search';
      return `(${label})\`${searchQuery}': `;
    }
    if (continuation !== '') return renderPS2(session);
    return renderPrompt(session);
  }

  function render() {
    if (disposed) return;
    clearNode(promptEl);
    promptEl.appendChild(ansiToNodes(promptAnsi()));

    const hidden = mode === 'ask' && askState && askState.options.password === true;
    const shown = hidden ? '' : buffer;
    const at = hidden ? 0 : cursor;

    preEl.textContent = shown.slice(0, at);
    cursorEl.textContent = shown.slice(at, at + 1) || ' ';
    postEl.textContent = shown.slice(at + 1);

    el.classList.toggle('is-hidden-input', hidden);
    keepInView();
  }

  function keepInView() {
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'end', inline: 'nearest' });
    }
  }

  function showInput() { el.classList.remove('is-busy'); }
  function hideInput() { el.classList.add('is-busy'); }

  /* --- history ---------------------------------------------------- */

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      saveHistory();
    }, 600);
  }

  function saveHistory() {
    const list = session.history.slice(-HISTFILESIZE);
    try {
      fs.writeFile(historyFile(session), list.length ? `${list.join('\n')}\n` : '');
    } catch (err) {
      console.warn('[terminal] could not write ~/.bash_history:', err);
    }
    store.set('history', list);
  }

  /** HISTCONTROL=ignoreboth: drop leading-space lines and consecutive dupes. */
  function historyAdd(line) {
    const text = String(line);
    if (text.trim() === '') return;
    if (text.startsWith(' ')) return;
    const last = session.history[session.history.length - 1];
    if (last === text) return;
    session.history.push(text);
    if (session.history.length > HISTSIZE) {
      session.history.splice(0, session.history.length - HISTSIZE);
    }
    scheduleSave();
  }

  function historyPrev() {
    if (session.history.length === 0) return;
    if (historyIndex === -1) {
      draft = buffer;
      historyIndex = session.history.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return;
    }
    buffer = session.history[historyIndex];
    cursor = buffer.length;
    render();
  }

  function historyNext() {
    if (historyIndex === -1) return;
    if (historyIndex < session.history.length - 1) {
      historyIndex += 1;
      buffer = session.history[historyIndex];
    } else {
      historyIndex = -1;
      buffer = draft;
    }
    cursor = buffer.length;
    render();
  }

  /* --- editing primitives ----------------------------------------- */

  function insert(text) {
    const s = String(text);
    if (s === '') return;
    buffer = buffer.slice(0, cursor) + s + buffer.slice(cursor);
    cursor += s.length;
    historyIndex = -1;
    resetTab();
    render();
  }

  function resetTab() {
    tabPrefix = null;
    tabCount = 0;
  }

  function wordStartBefore(pos) {
    let i = pos;
    while (i > 0 && /\s/.test(buffer[i - 1])) i -= 1;
    while (i > 0 && !/\s/.test(buffer[i - 1])) i -= 1;
    return i;
  }

  function wordEndAfter(pos) {
    let i = pos;
    while (i < buffer.length && /\s/.test(buffer[i])) i += 1;
    while (i < buffer.length && !/\s/.test(buffer[i])) i += 1;
    return i;
  }

  /* --- completion -------------------------------------------------- */

  function pathCandidates(prefix) {
    const slash = prefix.lastIndexOf('/');
    const dirPart = slash < 0 ? '' : prefix.slice(0, slash + 1);
    const basePart = slash < 0 ? prefix : prefix.slice(slash + 1);
    const dirAbs = path.resolve(session.cwd, path.expandTilde(dirPart === '' ? '.' : dirPart, session.home));

    let names;
    try {
      names = fs.readdir(dirAbs);
    } catch {
      return [];
    }

    const wantHidden = basePart.startsWith('.');
    const out = [];
    for (const name of names) {
      if (!name.startsWith(basePart)) continue;
      if (!wantHidden && name.startsWith('.')) continue;
      const isDir = fs.isDir(path.join(dirAbs, name));
      out.push({
        value: `${dirPart}${name}${isDir ? '/' : ''}`,
        display: `${name}${isDir ? '/' : ''}`,
        isDir,
      });
    }
    return out;
  }

  function commandCandidates(prefix) {
    return completionNames(session)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ value: n, display: n, isDir: false }));
  }

  function complete() {
    const info = parseWordAt(buffer, cursor);
    const usePaths = !info.cmdPos || info.word.includes('/') || info.word.startsWith('~') || info.word.startsWith('.');
    const candidates = usePaths ? pathCandidates(info.word) : commandCandidates(info.word);

    if (candidates.length === 0) { resetTab(); return; }

    const replace = (text, addSpace) => {
      const head = buffer.slice(0, info.start);
      const tail = buffer.slice(cursor);
      const inserted = escapeForShell(text, info.quote) + (addSpace ? (info.quote ? `${info.quote} ` : ' ') : '');
      buffer = head + inserted + tail;
      cursor = head.length + inserted.length;
      historyIndex = -1;
      render();
    };

    if (candidates.length === 1) {
      const only = candidates[0];
      replace(only.value, !only.isDir);
      resetTab();
      return;
    }

    const common = longestCommonPrefix(candidates.map((c) => c.value));
    if (common.length > info.word.length) {
      replace(common, false);
      resetTab();
      return;
    }

    const key = info.word;
    if (tabPrefix === key) tabCount += 1;
    else { tabPrefix = key; tabCount = 1; }

    if (tabCount >= 2) {
      const list = candidates.map((c) => c.display).sort();
      write(`${promptAnsi()}${buffer}\n`);
      write(columnize(list, cols()));
      render();
      tabCount = 0;
    }
  }

  /* --- reverse incremental search ---------------------------------- */

  function startSearch() {
    searchSaved = buffer;
    searchQuery = '';
    searchIndex = session.history.length;
    searchFailed = false;
    mode = 'search';
    render();
  }

  function runSearch(fromIndex) {
    if (searchQuery === '') {
      searchFailed = false;
      render();
      return;
    }
    for (let i = Math.min(fromIndex, session.history.length - 1); i >= 0; i -= 1) {
      if (session.history[i].includes(searchQuery)) {
        searchIndex = i;
        buffer = session.history[i];
        cursor = buffer.length;
        searchFailed = false;
        render();
        return;
      }
    }
    searchFailed = true;
    render();
  }

  function endSearch(keepLine) {
    mode = 'edit';
    if (!keepLine) {
      buffer = searchSaved;
      cursor = buffer.length;
    }
    searchQuery = '';
    searchFailed = false;
    render();
  }

  /* --- submission --------------------------------------------------- */

  function echoLine(text) {
    write(`${promptAnsi()}${text}\n`);
  }

  async function submit() {
    const line = buffer;
    echoLine(line);
    buffer = '';
    cursor = 0;
    historyIndex = -1;
    draft = '';
    resetTab();

    let full;
    if (continuation === '') full = line;
    else if (continuationReason === 'backslash') full = continuation.replace(/\\$/, '') + line;
    else if (continuationReason === 'operator') full = `${continuation} ${line}`;
    else full = `${continuation}\n${line}`;

    const reason = needsContinuation(full);
    if (reason) {
      continuation = full;
      continuationReason = reason;
      render();
      return;
    }
    continuation = '';
    continuationReason = '';

    if (full.trim() === '') { render(); drain(); return; }

    historyAdd(full);
    session.cmdNumber += 1;

    mode = 'running';
    hideInput();
    render();
    try {
      await onSubmit(full);
    } catch (err) {
      console.error('[terminal] command dispatch failed:', err);
    } finally {
      if (!disposed) {
        mode = 'edit';
        showInput();
        render();
      }
    }
    drain();
  }

  function drain() {
    if (disposed || pendingLines.length === 0) return;
    const next = pendingLines.shift();
    buffer = next;
    cursor = buffer.length;
    render();
    submit();
  }

  function interrupt() {
    pendingLines = [];
    continuation = '';
    continuationReason = '';
    if (mode === 'search') { endSearch(false); return; }
    if (mode === 'ask' && askState) {
      write(`${askState.prompt}\n`);
      const resolve = askState.resolve;
      askState = null;
      mode = askPrevMode;
      buffer = '';
      cursor = 0;
      if (mode === 'running') hideInput();
      render();
      resolve(null);
      return;
    }
    if (mode === 'running') { onInterrupt(); return; }
    write(`${promptAnsi()}${buffer}^C\n`);
    buffer = '';
    cursor = 0;
    historyIndex = -1;
    resetTab();
    render();
  }

  /* --- ask() -------------------------------------------------------- */

  function ask(prompt, opts = {}) {
    return new Promise((resolve) => {
      askPrevMode = mode === 'ask' ? 'running' : mode;
      askState = { prompt: String(prompt === undefined || prompt === null ? '' : prompt), options: opts || {}, resolve };
      mode = 'ask';
      buffer = '';
      cursor = 0;
      showInput();
      render();
      focus();
    });
  }

  function finishAsk() {
    const value = buffer;
    const hidden = askState.options.password === true;
    write(`${askState.prompt}${hidden ? '' : value}\n`);
    const resolve = askState.resolve;
    askState = null;
    buffer = '';
    cursor = 0;
    mode = askPrevMode;
    if (mode === 'running') hideInput();
    render();
    resolve(value);
  }

  /* --- key handling -------------------------------------------------- */

  /**
   * Insert arbitrary text, treating embedded newlines as line breaks that
   * submit rather than as literal characters.
   *
   * Both the `paste` event and the `input` event funnel through here. `input`
   * matters just as much as `paste`: middle-click paste on X11, drag-and-drop
   * of text, IME commits and mobile autocorrect all deliver their payload as
   * an `insertText` input event with no clipboard event at all. Letting a raw
   * "\n" through there would silently wedge a newline into the buffer and the
   * line would never run.
   *
   * @param {string} raw
   */
  function insertText(raw) {
    const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1) {
      insert(lines[0]);
      return;
    }

    insert(lines[0]);
    const rest = lines.slice(1);
    // A trailing newline means "run this line", not "start an empty one".
    while (rest.length && rest[rest.length - 1] === '') rest.pop();
    pendingLines = pendingLines.concat(rest);
    if (mode === 'ask') {
      finishAsk();
      drain();
      return;
    }
    submit();
  }

  function onInput() {
    const text = keyboard.value;
    keyboard.value = '';
    if (text === '') return;
    if (mode === 'running') return;
    if (mode === 'search') {
      // Reverse-i-search is a single-line prompt; flatten anything pasted in.
      searchQuery += text.replace(/[\r\n]+/g, ' ');
      runSearch(searchIndex);
      return;
    }
    insertText(text);
  }

  function onPaste(ev) {
    if (mode === 'running') { ev.preventDefault(); return; }
    const data = ev.clipboardData ? ev.clipboardData.getData('text') : '';
    ev.preventDefault();
    if (!data) return;
    insertText(data);
  }

  function onKeyDown(ev) {
    if (disposed) return;

    // Ctrl+Shift+… belongs to the terminal window (copy/paste/new tab).
    if (ev.ctrlKey && ev.shiftKey) return;

    const key = ev.key;

    if (mode === 'running') {
      if (ev.ctrlKey && (key === 'c' || key === 'C')) { ev.preventDefault(); interrupt(); }
      else if (ev.ctrlKey && (key === 'd' || key === 'D')) { ev.preventDefault(); }
      return;
    }

    /* --- reverse-i-search ------------------------------------------ */
    if (mode === 'search') {
      if (ev.ctrlKey && (key === 'r' || key === 'R')) {
        ev.preventDefault();
        runSearch(searchIndex - 1);
        return;
      }
      if (ev.ctrlKey && (key === 'g' || key === 'G')) { ev.preventDefault(); endSearch(false); return; }
      if (ev.ctrlKey && (key === 'c' || key === 'C')) { ev.preventDefault(); interrupt(); return; }
      if (key === 'Escape') { ev.preventDefault(); endSearch(true); return; }
      if (key === 'Backspace') {
        ev.preventDefault();
        searchQuery = searchQuery.slice(0, -1);
        runSearch(session.history.length - 1);
        return;
      }
      if (key === 'Enter') { ev.preventDefault(); endSearch(true); submit(); return; }
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') {
        ev.preventDefault();
        endSearch(true);
        return;
      }
      return;                                   /* printable keys go to onInput */
    }

    /* --- ask() prompt ---------------------------------------------- */
    if (mode === 'ask') {
      if (key === 'Enter') { ev.preventDefault(); finishAsk(); return; }
      if (ev.ctrlKey && (key === 'c' || key === 'C')) { ev.preventDefault(); interrupt(); return; }
      if (key === 'Backspace') {
        ev.preventDefault();
        if (cursor > 0) { buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor); cursor -= 1; render(); }
        return;
      }
      if (key === 'ArrowLeft') { ev.preventDefault(); if (cursor > 0) { cursor -= 1; render(); } return; }
      if (key === 'ArrowRight') { ev.preventDefault(); if (cursor < buffer.length) { cursor += 1; render(); } return; }
      if (key === 'Tab' || key === 'ArrowUp' || key === 'ArrowDown') { ev.preventDefault(); }
      return;
    }

    /* --- emacs bindings -------------------------------------------- */
    if (ev.ctrlKey && !ev.altKey) {
      switch (key) {
        case 'a': case 'A': ev.preventDefault(); cursor = 0; render(); return;
        case 'e': case 'E': ev.preventDefault(); cursor = buffer.length; render(); return;
        case 'b': case 'B': ev.preventDefault(); if (cursor > 0) cursor -= 1; render(); return;
        case 'f': case 'F': ev.preventDefault(); if (cursor < buffer.length) cursor += 1; render(); return;
        case 'u': case 'U':
          ev.preventDefault();
          killRing = buffer.slice(0, cursor);
          buffer = buffer.slice(cursor);
          cursor = 0;
          render();
          return;
        case 'k': case 'K':
          ev.preventDefault();
          killRing = buffer.slice(cursor);
          buffer = buffer.slice(0, cursor);
          render();
          return;
        case 'w': case 'W': {
          ev.preventDefault();
          const start = wordStartBefore(cursor);
          killRing = buffer.slice(start, cursor);
          buffer = buffer.slice(0, start) + buffer.slice(cursor);
          cursor = start;
          render();
          return;
        }
        case 'y': case 'Y': ev.preventDefault(); insert(killRing); return;
        case 'l': case 'L': ev.preventDefault(); clearScreen(); render(); return;
        case 'c': case 'C': ev.preventDefault(); interrupt(); return;
        case 'd': case 'D':
          ev.preventDefault();
          if (buffer === '') { write(`${promptAnsi()}exit\n`); onEOF(); return; }
          if (cursor < buffer.length) {
            buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
            render();
          }
          return;
        case 'r': case 'R': ev.preventDefault(); startSearch(); return;
        case 't': case 'T':
          ev.preventDefault();
          if (cursor > 0 && buffer.length > 1) {
            const at = cursor < buffer.length ? cursor : cursor - 1;
            buffer = buffer.slice(0, at - 1) + buffer[at] + buffer[at - 1] + buffer.slice(at + 1);
            if (cursor < buffer.length) cursor += 1;
            render();
          }
          return;
        case 'p': case 'P': ev.preventDefault(); historyPrev(); return;
        case 'n': case 'N': ev.preventDefault(); historyNext(); return;
        case 'ArrowLeft': ev.preventDefault(); cursor = wordStartBefore(cursor); render(); return;
        case 'ArrowRight': ev.preventDefault(); cursor = wordEndAfter(cursor); render(); return;
        default: return;
      }
    }

    if (ev.altKey) {
      switch (key) {
        case 'b': case 'B': ev.preventDefault(); cursor = wordStartBefore(cursor); render(); return;
        case 'f': case 'F': ev.preventDefault(); cursor = wordEndAfter(cursor); render(); return;
        case 'd': case 'D': {
          ev.preventDefault();
          const end = wordEndAfter(cursor);
          killRing = buffer.slice(cursor, end);
          buffer = buffer.slice(0, cursor) + buffer.slice(end);
          render();
          return;
        }
        case 'Backspace': {
          ev.preventDefault();
          const start = wordStartBefore(cursor);
          killRing = buffer.slice(start, cursor);
          buffer = buffer.slice(0, start) + buffer.slice(cursor);
          cursor = start;
          render();
          return;
        }
        default: return;
      }
    }

    switch (key) {
      case 'Enter':
        ev.preventDefault();
        submit();
        return;
      case 'Backspace':
        ev.preventDefault();
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor -= 1;
          historyIndex = -1;
          resetTab();
          render();
        }
        return;
      case 'Delete':
        ev.preventDefault();
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
          resetTab();
          render();
        }
        return;
      case 'Tab':
        ev.preventDefault();
        complete();
        return;
      case 'ArrowLeft':
        ev.preventDefault();
        if (cursor > 0) { cursor -= 1; render(); }
        return;
      case 'ArrowRight':
        ev.preventDefault();
        if (cursor < buffer.length) { cursor += 1; render(); }
        return;
      case 'ArrowUp': ev.preventDefault(); historyPrev(); return;
      case 'ArrowDown': ev.preventDefault(); historyNext(); return;
      case 'Home': ev.preventDefault(); cursor = 0; render(); return;
      case 'End': ev.preventDefault(); cursor = buffer.length; render(); return;
      case 'Escape': ev.preventDefault(); return;
      default:
        break;
    }
  }

  function onFocus() { el.classList.add('is-focused'); }
  function onBlur() { el.classList.remove('is-focused'); }

  keyboard.addEventListener('keydown', onKeyDown);
  keyboard.addEventListener('input', onInput);
  keyboard.addEventListener('paste', onPaste);
  keyboard.addEventListener('focus', onFocus);
  keyboard.addEventListener('blur', onBlur);

  function focus() {
    if (disposed) return;
    keyboard.focus({ preventScroll: true });
  }

  render();

  return {
    /** The input-line element (already inserted into `container`). */
    el,
    /** The hidden textarea, so the host can check `document.activeElement`. */
    keyboard,

    focus,
    blur() { keyboard.blur(); },
    render,

    /** @returns {string} */
    getLine() { return buffer; },
    /** @param {string} text */
    setLine(text) {
      buffer = String(text === undefined || text === null ? '' : text);
      cursor = buffer.length;
      render();
    },

    /** @returns {boolean} true while a command is running */
    isBusy() { return mode === 'running'; },
    /** @returns {'edit'|'running'|'search'|'ask'} */
    getMode() { return mode; },

    ask,
    interrupt,
    saveHistory,

    /** Re-read `~/.bash_history` into the session. */
    reloadHistory() { session.history = readHistory(session); },

    /** Run a line as though the user had typed it. */
    submitLine(line) {
      if (mode !== 'edit') return;
      buffer = String(line);
      cursor = buffer.length;
      submit();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      saveHistory();
      keyboard.removeEventListener('keydown', onKeyDown);
      keyboard.removeEventListener('input', onInput);
      keyboard.removeEventListener('paste', onPaste);
      keyboard.removeEventListener('focus', onFocus);
      keyboard.removeEventListener('blur', onBlur);
      el.remove();
    },
  };
}

export { stripAnsi };
