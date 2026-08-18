/**
 * js/apps/editor/find.js — the Text Editor's find & replace bar.
 *
 * Owns the search state (query, case sensitivity, regular expressions,
 * highlight-all) and hands the match list back to the editor, which paints the
 * highlights into its text mirror.
 *
 * Sibling of `js/apps/editor/index.js`.
 */

import { h, on } from '../../core/dom.js';

const MAX_MATCHES = 20000;

/**
 * Replace a range while keeping the browser's native undo stack.
 * @param {HTMLTextAreaElement} ta
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
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (typeof selStart === 'number') ta.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
}

/**
 * @param {{textarea:HTMLTextAreaElement, onMatchesChanged?:Function,
 *          onReveal?:(offset:number)=>void, onClose?:Function}} options
 */
export function createFindBar(options) {
  const textarea = options.textarea;
  const onMatchesChanged = typeof options.onMatchesChanged === 'function' ? options.onMatchesChanged : () => {};
  const onReveal = typeof options.onReveal === 'function' ? options.onReveal : () => {};
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};

  let matches = [];
  let current = -1;
  let caseSensitive = false;
  let useRegex = false;
  let highlightAll = true;
  let invalid = false;
  let visible = false;

  const searchInput = h('input.find__entry', {
    type: 'text',
    placeholder: 'Search',
    spellcheck: 'false',
    'aria-label': 'Search',
  });
  const counter = h('span.find__counter');

  const caseButton = h('button.find__toggle', { type: 'button', text: 'Aa', title: 'Match Case' });
  const regexButton = h('button.find__toggle', { type: 'button', text: '.*', title: 'Use Regular Expression' });
  const highlightButton = h('button.find__toggle.is-on', { type: 'button', text: '▤', title: 'Highlight All' });
  const prevButton = h('button.find__nav', { type: 'button', text: '↑', title: 'Previous Match (Shift+Enter)' });
  const nextButton = h('button.find__nav', { type: 'button', text: '↓', title: 'Next Match (Enter)' });
  const closeButton = h('button.find__close', { type: 'button', text: '✕', title: 'Close (Escape)' });

  const replaceInput = h('input.find__entry', {
    type: 'text',
    placeholder: 'Replace with',
    spellcheck: 'false',
    'aria-label': 'Replace with',
  });
  const replaceButton = h('button.find__action', { type: 'button', text: 'Replace' });
  const replaceAllButton = h('button.find__action', { type: 'button', text: 'Replace All' });

  const searchRow = h(
    'div.find__row',
    {},
    h('div.find__field', {}, searchInput, counter),
    h('div.find__toggles', {}, caseButton, regexButton, highlightButton),
    h('div.find__navs', {}, prevButton, nextButton),
    closeButton,
  );

  const replaceRow = h(
    'div.find__row.find__row--replace',
    {},
    h('div.find__field', {}, replaceInput),
    h('div.find__actions', {}, replaceButton, replaceAllButton),
  );

  const element = h('div.find', { hidden: true }, searchRow, replaceRow);

  /* --- matching ---------------------------------------------------- */

  function compute() {
    const text = textarea.value;
    const query = searchInput.value;
    invalid = false;
    const found = [];

    if (query === '') {
      matches = found;
      return;
    }

    if (useRegex) {
      let re;
      try {
        re = new RegExp(query, caseSensitive ? 'g' : 'gi');
      } catch {
        invalid = true;
        matches = found;
        return;
      }
      let match = re.exec(text);
      while (match !== null && found.length < MAX_MATCHES) {
        if (match[0] === '') {
          re.lastIndex += 1;
        } else {
          found.push({ start: match.index, end: match.index + match[0].length });
        }
        match = re.exec(text);
      }
    } else {
      const haystack = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      let at = haystack.indexOf(needle);
      while (at >= 0 && found.length < MAX_MATCHES) {
        found.push({ start: at, end: at + needle.length });
        at = haystack.indexOf(needle, at + needle.length);
      }
    }

    matches = found;
  }

  function renderCounter() {
    searchInput.classList.toggle('is-invalid', invalid);
    if (invalid) {
      counter.textContent = 'Invalid pattern';
      return;
    }
    if (searchInput.value === '') {
      counter.textContent = '';
      return;
    }
    if (matches.length === 0) {
      counter.textContent = 'No results';
      return;
    }
    counter.textContent = `${current >= 0 ? current + 1 : 1} of ${matches.length}`;
  }

  function publish() {
    renderCounter();
    onMatchesChanged(highlightAll ? matches : [], current, matches);
  }

  function selectMatch(index) {
    if (matches.length === 0) {
      current = -1;
      publish();
      return;
    }
    current = ((index % matches.length) + matches.length) % matches.length;
    const match = matches[current];
    textarea.focus();
    textarea.setSelectionRange(match.start, match.end);
    onReveal(match.start);
    publish();
  }

  function nearestForward(from) {
    for (let i = 0; i < matches.length; i += 1) {
      if (matches[i].start >= from) return i;
    }
    return 0;
  }

  function nearestBackward(from) {
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      if (matches[i].end <= from) return i;
    }
    return matches.length - 1;
  }

  function search(reset) {
    const caret = textarea.selectionStart;
    compute();
    if (matches.length === 0) {
      current = -1;
      publish();
      return;
    }
    if (reset) {
      current = nearestForward(caret);
      const match = matches[current];
      textarea.setSelectionRange(match.start, match.end);
      onReveal(match.start);
    } else if (current >= matches.length) {
      current = matches.length - 1;
    }
    publish();
  }

  /* --- replace ------------------------------------------------------ */

  function expandReplacement(match, text) {
    if (!useRegex) return replaceInput.value;
    try {
      const re = new RegExp(searchInput.value, caseSensitive ? '' : 'i');
      const slice = text.slice(match.start, match.end);
      return slice.replace(re, replaceInput.value);
    } catch {
      return replaceInput.value;
    }
  }

  function replaceCurrent() {
    if (matches.length === 0 || current < 0) {
      search(true);
      return;
    }
    const text = textarea.value;
    const match = matches[current];
    const replacement = expandReplacement(match, text);
    replaceRange(textarea, match.start, match.end, replacement, match.start + replacement.length);
    compute();
    if (matches.length === 0) {
      current = -1;
      publish();
      return;
    }
    current = nearestForward(match.start + replacement.length);
    const next = matches[current];
    textarea.setSelectionRange(next.start, next.end);
    onReveal(next.start);
    publish();
  }

  function replaceAll() {
    compute();
    if (matches.length === 0) {
      publish();
      return;
    }
    const text = textarea.value;
    let out = '';
    let cursor = 0;
    for (const match of matches) {
      out += text.slice(cursor, match.start);
      out += expandReplacement(match, text);
      cursor = match.end;
    }
    out += text.slice(cursor);
    const count = matches.length;
    replaceRange(textarea, 0, text.length, out, Math.min(textarea.selectionStart, out.length));
    compute();
    current = -1;
    renderCounter();
    counter.textContent = `Replaced ${count} occurrence${count === 1 ? '' : 's'}`;
    onMatchesChanged(highlightAll ? matches : [], current, matches);
  }

  /* --- wiring -------------------------------------------------------- */

  const offInput = on(searchInput, 'input', () => search(true));

  const offSearchKeys = on(searchInput, 'keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (matches.length === 0) search(true);
      else selectMatch(ev.shiftKey ? current - 1 : current + 1);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      api.close();
    }
  });

  const offReplaceKeys = on(replaceInput, 'keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      replaceCurrent();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      api.close();
    }
  });

  const offNext = on(nextButton, 'click', () => (matches.length === 0 ? search(true) : selectMatch(current + 1)));
  const offPrev = on(prevButton, 'click', () => (matches.length === 0 ? search(true) : selectMatch(current - 1)));
  const offClose = on(closeButton, 'click', () => api.close());
  const offReplace = on(replaceButton, 'click', replaceCurrent);
  const offReplaceAll = on(replaceAllButton, 'click', replaceAll);

  const offCase = on(caseButton, 'click', () => {
    caseSensitive = !caseSensitive;
    caseButton.classList.toggle('is-on', caseSensitive);
    search(true);
  });

  const offRegex = on(regexButton, 'click', () => {
    useRegex = !useRegex;
    regexButton.classList.toggle('is-on', useRegex);
    search(true);
  });

  const offHighlight = on(highlightButton, 'click', () => {
    highlightAll = !highlightAll;
    highlightButton.classList.toggle('is-on', highlightAll);
    publish();
  });

  const api = {
    element,

    /**
     * @param {'find'|'replace'} mode
     * @param {string} [initial] seed the query (usually the current selection)
     */
    open(mode, initial) {
      visible = true;
      element.hidden = false;
      replaceRow.hidden = mode !== 'replace';
      if (typeof initial === 'string' && initial !== '' && initial.indexOf('\n') < 0) {
        searchInput.value = initial;
      }
      searchInput.focus();
      searchInput.select();
      search(true);
    },

    close() {
      visible = false;
      element.hidden = true;
      matches = [];
      current = -1;
      onMatchesChanged([], -1, []);
      onClose();
      textarea.focus();
    },

    isOpen() {
      return visible;
    },

    /** Recompute after the document changed underneath us. */
    refresh() {
      if (!visible) return;
      const caret = textarea.selectionStart;
      compute();
      if (matches.length === 0) current = -1;
      else current = nearestForward(caret);
      publish();
    },

    matches() {
      return highlightAll ? matches : [];
    },

    allMatches() {
      return matches;
    },

    currentIndex() {
      return current;
    },

    next() {
      if (matches.length === 0) search(true);
      else selectMatch(current + 1);
    },

    previous() {
      if (matches.length === 0) {
        search(true);
        return;
      }
      if (current < 0) selectMatch(nearestBackward(textarea.selectionStart));
      else selectMatch(current - 1);
    },

    destroy() {
      offInput();
      offSearchKeys();
      offReplaceKeys();
      offNext();
      offPrev();
      offClose();
      offReplace();
      offReplaceAll();
      offCase();
      offRegex();
      offHighlight();
    },
  };

  return api;
}
