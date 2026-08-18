/**
 * js/apps/codeoss/code-editor.js — the Code-OSS editing surface.
 *
 * A transparent <textarea> sits on top of a coloured mirror built from the
 * tokenizer in `highlight.js`, so the caret, selection, IME and native undo all
 * come from the browser while the colours come from a real token stream.
 *
 * Sibling of `js/apps/codeoss/index.js`.
 */

import { h, clear, on } from '../../core/dom.js';
import { tokenizeLines, renderTokens, normalizeLanguage, lineComment, tokenize } from './highlight.js';

/** Layout constants shared with css/apps/codeoss.css. */
const LINE_HEIGHT = 19;
const PAD_TOP = 4;
const PAD_LEFT = 4;
const INDENT = '    ';
const INDENT_WIDTH = 4;
const MAX_HIGHLIGHT_LINES = 6000;

const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const QUOTES = '"\'`';

const BLOCK_COMMENTS = {
  css: ['/* ', ' */'],
  html: ['<!-- ', ' -->'],
  json: ['// ', ''],
  markdown: ['<!-- ', ' -->'],
};

/** Token types whose text must be ignored by bracket matching. */
const NON_CODE = new Set(['comment', 'string', 'template', 'regexp']);

/**
 * Replace a range while keeping the browser's native undo stack intact.
 * @param {HTMLTextAreaElement} ta
 * @param {number} start
 * @param {number} end
 * @param {string} text
 * @param {number} [selStart]
 * @param {number} [selEnd]
 */
function replaceRange(ta, start, end, text, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const value = ta.value;
    ta.value = value.slice(0, start) + text + value.slice(end);
    ta.setSelectionRange(start + text.length, start + text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (typeof selStart === 'number') {
    ta.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
  }
}

/** Offsets at which each line starts, plus a sentinel past the end. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToPosition(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, column: offset - starts[low] };
}

/**
 * Create the editor widget.
 *
 * @param {{onChange?:(value:string)=>void, onCursor?:(info:object)=>void,
 *          onSave?:()=>void, onCommand?:(name:string)=>void}} [options]
 */
export function createCodeEditor(options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const onCursor = typeof options.onCursor === 'function' ? options.onCursor : () => {};
  const onSave = typeof options.onSave === 'function' ? options.onSave : () => {};
  const onCommand = typeof options.onCommand === 'function' ? options.onCommand : () => {};

  let language = 'text';
  let docPath = null;
  let starts = [0];
  let codeMask = new Uint8Array(0);
  let renderHandle = 0;
  let charWidth = 8.4;

  const gutterInner = h('div.ce-gutter__inner');
  const gutter = h('div.ce-gutter', {}, gutterInner);

  const currentLine = h('div.ce-current-line');
  const guidesInner = h('div.ce-guides__inner', {}, currentLine);
  const guides = h('div.ce-guides', {}, guidesInner);

  const lines = h('div.ce-lines');
  const brackets = h('div.ce-brackets');
  const layersInner = h('div.ce-layers__inner', {}, lines, brackets);
  const layers = h('div.ce-layers', {}, layersInner);

  const input = h('textarea.ce-input', {
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    wrap: 'off',
    'aria-label': 'Code editor',
  });

  const measure = h('span.ce-measure', { text: '0'.repeat(40), 'aria-hidden': 'true' });
  const main = h('div.ce-main', {}, guides, layers, input, measure);
  const element = h('div.ce', {}, gutter, main);

  /* --- rendering ------------------------------------------------- */

  function measureChar() {
    const width = measure.getBoundingClientRect().width;
    if (width > 0) charWidth = width / 40;
  }

  function renderGutter(count) {
    const current = gutterInner.childElementCount;
    if (current > count) {
      while (gutterInner.childElementCount > count) gutterInner.removeChild(gutterInner.lastChild);
    } else if (current < count) {
      const fragment = document.createDocumentFragment();
      for (let i = current; i < count; i += 1) {
        fragment.appendChild(h('div.ce-gutter__line', { text: String(i + 1) }));
      }
      gutterInner.appendChild(fragment);
    }
    const digits = String(Math.max(count, 1)).length;
    gutter.style.width = `${Math.max(48, 22 + digits * 8.4)}px`;
  }

  function buildCodeMask(text) {
    const mask = new Uint8Array(text.length);
    let offset = 0;
    for (const token of tokenize(text, language)) {
      const length = token.value.length;
      if (!NON_CODE.has(token.type)) mask.fill(1, offset, offset + length);
      offset += length;
    }
    return mask;
  }

  function renderLines() {
    renderHandle = 0;
    const text = input.value;
    starts = lineStarts(text);
    const rows = text.split('\n');

    clear(lines);
    const fragment = document.createDocumentFragment();

    if (rows.length > MAX_HIGHLIGHT_LINES) {
      codeMask = new Uint8Array(0);
      for (const row of rows) {
        fragment.appendChild(h('div.ce-line', { text: row }));
      }
    } else {
      codeMask = buildCodeMask(text);
      const tokenLines = tokenizeLines(text, language);
      for (let i = 0; i < rows.length; i += 1) {
        const line = h('div.ce-line');
        line.appendChild(renderTokens(tokenLines[i] || []));
        fragment.appendChild(line);
      }
    }

    lines.appendChild(fragment);
    renderGutter(rows.length);
    updateCaret();
  }

  function scheduleRender() {
    if (renderHandle) return;
    renderHandle = window.requestAnimationFrame(renderLines);
  }

  function syncScroll() {
    const x = input.scrollLeft;
    const y = input.scrollTop;
    layersInner.style.transform = `translate(${-x}px, ${-y}px)`;
    guidesInner.style.transform = `translateY(${-y}px)`;
    gutterInner.style.transform = `translateY(${-y}px)`;
  }

  /* --- caret, current line, bracket match ------------------------ */

  function isCode(offset) {
    return codeMask.length === 0 || codeMask[offset] === 1;
  }

  /** Find the bracket pair to highlight for the current caret position. */
  function findBracketPair(text, caret) {
    const candidates = [];
    if (caret < text.length) candidates.push(caret);
    if (caret > 0) candidates.push(caret - 1);

    for (const at of candidates) {
      const ch = text[at];
      if (!isCode(at)) continue;
      if (PAIRS[ch]) {
        const close = PAIRS[ch];
        let depth = 0;
        for (let i = at; i < text.length; i += 1) {
          if (!isCode(i)) continue;
          if (text[i] === ch) depth += 1;
          else if (text[i] === close) {
            depth -= 1;
            if (depth === 0) return [at, i];
          }
        }
        return null;
      }
      if (CLOSERS[ch]) {
        const open = CLOSERS[ch];
        let depth = 0;
        for (let i = at; i >= 0; i -= 1) {
          if (!isCode(i)) continue;
          if (text[i] === ch) depth += 1;
          else if (text[i] === open) {
            depth -= 1;
            if (depth === 0) return [i, at];
          }
        }
        return null;
      }
    }
    return null;
  }

  function renderBrackets(text, caret) {
    clear(brackets);
    if (text.length > 200000) return;
    const pair = findBracketPair(text, caret);
    if (!pair) return;
    for (const offset of pair) {
      const pos = offsetToPosition(starts, offset);
      brackets.appendChild(
        h('div.ce-bracket', {
          style: {
            top: `${PAD_TOP + pos.line * LINE_HEIGHT}px`,
            left: `${PAD_LEFT + pos.column * charWidth}px`,
            width: `${charWidth}px`,
            height: `${LINE_HEIGHT}px`,
          },
        }),
      );
    }
  }

  function updateCaret() {
    const text = input.value;
    const caret = input.selectionStart;
    const pos = offsetToPosition(starts, caret);
    currentLine.style.top = `${PAD_TOP + pos.line * LINE_HEIGHT}px`;
    currentLine.style.height = `${LINE_HEIGHT}px`;
    currentLine.style.display = input.selectionStart === input.selectionEnd ? '' : 'none';

    for (const node of gutterInner.children) node.classList.remove('is-active');
    const active = gutterInner.children[pos.line];
    if (active) active.classList.add('is-active');

    renderBrackets(text, caret);

    onCursor({
      line: pos.line + 1,
      column: pos.column + 1,
      offset: caret,
      selectionLength: Math.abs(input.selectionEnd - input.selectionStart),
      lineCount: starts.length,
    });
  }

  /* --- editing behaviour ----------------------------------------- */

  function lineRangeOf(value, start, end) {
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to < 0) to = value.length;
    return { from, to };
  }

  function handleEnter(ev) {
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const before = value.slice(0, start);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart);
    const indent = /^[ \t]*/.exec(line)[0];
    const trimmed = line.replace(/\s+$/, '');

    let nextIndent = indent;
    if (/[:{[(]$/.test(trimmed)) {
      nextIndent = indent + INDENT;
    } else if (language === 'python' && /^\s*(return|pass|break|continue|raise)\b/.test(line) && indent.length >= INDENT_WIDTH) {
      nextIndent = indent.slice(0, indent.length - INDENT_WIDTH);
    }

    const opener = trimmed.slice(-1);
    const nextChar = value[end];
    if (PAIRS[opener] && nextChar === PAIRS[opener] && start === end) {
      ev.preventDefault();
      const text = `\n${nextIndent}\n${indent}`;
      replaceRange(input, start, end, text, start + 1 + nextIndent.length);
      return;
    }

    ev.preventDefault();
    replaceRange(input, start, end, `\n${nextIndent}`);
  }

  function handleTab(ev) {
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const multiline = value.slice(start, end).indexOf('\n') >= 0;

    if (!multiline && !ev.shiftKey) {
      ev.preventDefault();
      const column = start - (value.lastIndexOf('\n', start - 1) + 1);
      const width = INDENT_WIDTH - (column % INDENT_WIDTH);
      replaceRange(input, start, end, ' '.repeat(width));
      return;
    }

    ev.preventDefault();
    const range = lineRangeOf(value, start, end);
    const block = value.slice(range.from, range.to);
    const rows = block.split('\n');
    let firstDelta = 0;
    let totalDelta = 0;

    const next = rows.map((row, index) => {
      if (ev.shiftKey) {
        const match = /^[ \t]{1,4}/.exec(row);
        if (!match) return row;
        const removed = match[0].length;
        if (index === 0) firstDelta = -removed;
        totalDelta -= removed;
        return row.slice(removed);
      }
      if (row.trim() === '' && rows.length > 1 && index === rows.length - 1) return row;
      if (index === 0) firstDelta = INDENT_WIDTH;
      totalDelta += INDENT_WIDTH;
      return INDENT + row;
    });

    replaceRange(
      input,
      range.from,
      range.to,
      next.join('\n'),
      Math.max(range.from, start + firstDelta),
      Math.max(range.from, end + totalDelta),
    );
  }

  function handleToggleComment(ev) {
    ev.preventDefault();
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const range = lineRangeOf(value, start, end);
    const rows = value.slice(range.from, range.to).split('\n');
    const prefix = lineComment(language);

    if (!prefix) {
      const block = BLOCK_COMMENTS[language];
      if (!block || !block[1]) return;
      const body = value.slice(range.from, range.to);
      const trimmedBody = body.trim();
      const wrapped = trimmedBody.startsWith(block[0].trim()) && trimmedBody.endsWith(block[1].trim());
      const next = wrapped
        ? body.replace(block[0].trim(), '').replace(new RegExp(`${block[1].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').trim()
        : `${block[0]}${body}${block[1]}`;
      replaceRange(input, range.from, range.to, next, range.from, range.from + next.length);
      return;
    }

    const meaningful = rows.filter((row) => row.trim() !== '');
    const allCommented = meaningful.length > 0 && meaningful.every((row) => row.trim().startsWith(prefix));

    let indentWidth = Infinity;
    for (const row of meaningful) indentWidth = Math.min(indentWidth, /^[ \t]*/.exec(row)[0].length);
    if (!Number.isFinite(indentWidth)) indentWidth = 0;

    const next = rows.map((row) => {
      if (row.trim() === '') return row;
      if (allCommented) {
        const idx = row.indexOf(prefix);
        const after = row.slice(idx + prefix.length);
        return row.slice(0, idx) + (after.startsWith(' ') ? after.slice(1) : after);
      }
      return row.slice(0, indentWidth) + prefix + ' ' + row.slice(indentWidth);
    });

    const joined = next.join('\n');
    replaceRange(input, range.from, range.to, joined, range.from, range.from + joined.length);
  }

  function handleAutoClose(ev) {
    const ch = ev.key;
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const nextChar = value[end] || '';

    // Type over an auto-inserted closer.
    if ((CLOSERS[ch] || QUOTES.indexOf(ch) >= 0) && start === end && nextChar === ch) {
      ev.preventDefault();
      input.setSelectionRange(start + 1, start + 1);
      updateCaret();
      return true;
    }

    if (PAIRS[ch]) {
      ev.preventDefault();
      if (start !== end) {
        const selected = value.slice(start, end);
        replaceRange(input, start, end, ch + selected + PAIRS[ch], start + 1, end + 1);
      } else {
        replaceRange(input, start, end, ch + PAIRS[ch], start + 1);
      }
      return true;
    }

    if (QUOTES.indexOf(ch) >= 0 && start === end) {
      const prevChar = value[start - 1] || '';
      if (/[\w"'`\\]/.test(prevChar) || /[\w]/.test(nextChar)) return false;
      ev.preventDefault();
      replaceRange(input, start, end, ch + ch, start + 1);
      return true;
    }

    if (QUOTES.indexOf(ch) >= 0 && start !== end) {
      ev.preventDefault();
      const selected = value.slice(start, end);
      replaceRange(input, start, end, ch + selected + ch, start + 1, end + 1);
      return true;
    }

    return false;
  }

  function handleBackspace(ev) {
    const value = input.value;
    const start = input.selectionStart;
    if (start !== input.selectionEnd || start === 0) return;
    const prevChar = value[start - 1];
    const nextChar = value[start];
    const closing = PAIRS[prevChar];
    if ((closing && nextChar === closing) || (QUOTES.indexOf(prevChar) >= 0 && nextChar === prevChar)) {
      ev.preventDefault();
      replaceRange(input, start - 1, start + 1, '');
    }
  }

  const offKeyDown = on(input, 'keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;

    if (mod && !ev.shiftKey && !ev.altKey) {
      const key = ev.key.toLowerCase();
      if (key === 's') {
        ev.preventDefault();
        ev.stopPropagation();
        onSave();
        return;
      }
      if (key === '/') {
        ev.stopPropagation();
        handleToggleComment(ev);
        return;
      }
      if (key === 'f' || key === 'h' || key === 'p' || key === 'b' || key === 'j' || key === '`') {
        ev.preventDefault();
        ev.stopPropagation();
        onCommand(key);
        return;
      }
    }

    if (ev.key === 'Tab' && !mod && !ev.altKey) {
      handleTab(ev);
      return;
    }
    if (ev.key === 'Enter' && !mod && !ev.altKey) {
      handleEnter(ev);
      return;
    }
    if (ev.key === 'Backspace' && !mod && !ev.altKey) {
      handleBackspace(ev);
      return;
    }
    if (ev.key.length === 1 && !mod && !ev.altKey) {
      handleAutoClose(ev);
    }
  });

  const offInput = on(input, 'input', () => {
    scheduleRender();
    onChange(input.value);
  });

  const offScroll = on(input, 'scroll', syncScroll);

  const caretEvents = ['keyup', 'click', 'select', 'focus'];
  const offCaret = caretEvents.map((name) => on(input, name, () => updateCaret()));

  const offSelectionChange = on(document, 'selectionchange', () => {
    if (document.activeElement === input) updateCaret();
  });

  /* --- public API ------------------------------------------------- */

  const api = {
    element,

    /**
     * @param {{path?:string, content?:string, language?:string}} doc
     */
    setDocument(doc = {}) {
      docPath = doc.path === undefined ? null : doc.path;
      language = normalizeLanguage(doc.language || (docPath ? docPath.split('/').pop() : 'text'));
      input.value = doc.content === undefined ? '' : String(doc.content);
      input.scrollTop = 0;
      input.scrollLeft = 0;
      syncScroll();
      if (renderHandle) {
        window.cancelAnimationFrame(renderHandle);
        renderHandle = 0;
      }
      renderLines();
    },

    getValue() {
      return input.value;
    },

    setValue(value) {
      const text = value === undefined || value === null ? '' : String(value);
      replaceRange(input, 0, input.value.length, text, Math.min(input.selectionStart, text.length));
      renderLines();
      onChange(input.value);
    },

    getPath() {
      return docPath;
    },

    getLanguage() {
      return language;
    },

    setLanguage(lang) {
      language = normalizeLanguage(lang);
      renderLines();
    },

    /** @returns {string} the selected text, or '' */
    getSelectionText() {
      return input.value.slice(input.selectionStart, input.selectionEnd);
    },

    getCursor() {
      const pos = offsetToPosition(starts, input.selectionStart);
      return { line: pos.line + 1, column: pos.column + 1, offset: input.selectionStart };
    },

    /** Insert text at the caret, replacing any selection. */
    insertText(text) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      replaceRange(input, start, end, String(text));
      renderLines();
      onChange(input.value);
    },

    /** Scroll a 1-based line into view and put the caret on it. */
    goToLine(lineNumber, column = 1) {
      const index = Math.max(0, Math.min(starts.length - 1, lineNumber - 1));
      const offset = starts[index] + Math.max(0, column - 1);
      input.focus();
      input.setSelectionRange(offset, offset);
      const target = PAD_TOP + index * LINE_HEIGHT;
      const viewport = input.clientHeight;
      if (target < input.scrollTop || target > input.scrollTop + viewport - LINE_HEIGHT * 2) {
        input.scrollTop = Math.max(0, target - viewport / 2);
      }
      syncScroll();
      updateCaret();
    },

    focus() {
      input.focus();
    },

    /** Re-measure after a window resize or a font change. */
    layout() {
      measureChar();
      syncScroll();
      updateCaret();
    },

    destroy() {
      if (renderHandle) window.cancelAnimationFrame(renderHandle);
      offKeyDown();
      offInput();
      offScroll();
      offSelectionChange();
      for (const off of offCaret) off();
    },
  };

  measureChar();
  renderLines();
  return api;
}
