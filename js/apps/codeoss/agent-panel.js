/**
 * js/apps/codeoss/agent-panel.js — the Gemini agent side panel for Code-OSS.
 *
 * Sends the active file (or the current selection) as context, streams the
 * reply with `gemini.stream`, and renders it as safe text: every fenced code
 * block becomes a styled card with working "Apply to editor" and "Copy"
 * buttons, and every piece of model output reaches the DOM through
 * `textContent`.
 */

import { h, clear, on } from '../../core/dom.js';
import { gemini } from '../../services/gemini.js';
import { highlight, detectLanguage, languageLabel } from './highlight.js';

/** The quick actions across the top of the panel. */
export const AGENT_ACTIONS = Object.freeze([
  {
    id: 'explain',
    label: 'Explain',
    title: 'Explain the selection, or the whole file',
    instruction:
      'Explain what this code does. Cover its purpose, the flow through it, and anything ' +
      'surprising. Be concise and concrete; do not restate the code line by line.',
  },
  {
    id: 'refactor',
    label: 'Refactor',
    title: 'Suggest a cleaner version',
    instruction:
      'Refactor this code for clarity without changing its behaviour. Return the full ' +
      'refactored code in one fenced block, then a short bullet list of what changed and why.',
  },
  {
    id: 'fix',
    label: 'Fix Bugs',
    title: 'Look for real defects',
    instruction:
      'Find real bugs in this code: off-by-one errors, unhandled cases, wrong types, ' +
      'resource leaks, incorrect logic. For each, say what breaks and give the fixed code in ' +
      'a fenced block. If you find no genuine bug, say so plainly instead of inventing one.',
  },
  {
    id: 'comment',
    label: 'Add Comments',
    title: 'Document the code',
    instruction:
      'Add clear comments and docstrings to this code following the conventions of its ' +
      'language. Return the complete commented code in a single fenced block. Do not change ' +
      'any behaviour.',
  },
  {
    id: 'tests',
    label: 'Write Tests',
    title: 'Generate a test suite',
    instruction:
      'Write a focused test suite for this code using the idiomatic test framework for its ' +
      'language. Cover the happy path, the edge cases and the error paths. Return the tests ' +
      'in a single fenced block.',
  },
]);

const SYSTEM_PROMPT =
  'You are the Gemini agent embedded in Code-OSS on an Ubuntu 24.04 desktop. ' +
  'You are a careful, concise engineer. Answer in short paragraphs and bullet lists. ' +
  'Whenever you produce code, put it in a fenced block tagged with its language. ' +
  'Never claim to have run, compiled or tested anything — you cannot execute code.';

const MAX_CONTEXT_CHARS = 14000;

/* ------------------------------------------------------------------ *
 * safe rendering of a model reply
 * ------------------------------------------------------------------ */

const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*/g;

/**
 * Turn inline markdown into nodes. All text goes through `textContent`.
 * @param {string} text
 * @returns {DocumentFragment}
 */
function inlineNodes(text) {
  const fragment = document.createDocumentFragment();
  const source = String(text);
  INLINE_RE.lastIndex = 0;
  let last = 0;
  let match = INLINE_RE.exec(source);
  while (match) {
    if (match.index > last) fragment.appendChild(document.createTextNode(source.slice(last, match.index)));
    if (match[1] !== undefined) fragment.appendChild(h('code.agent-inline', { text: match[1] }));
    else if (match[2] !== undefined) fragment.appendChild(h('strong', { text: match[2] }));
    else if (match[3] !== undefined) fragment.appendChild(h('strong', { text: match[3] }));
    else fragment.appendChild(h('em', { text: match[4] }));
    last = INLINE_RE.lastIndex;
    match = INLINE_RE.exec(source);
  }
  if (last < source.length) fragment.appendChild(document.createTextNode(source.slice(last)));
  return fragment;
}

function copyText(text, button) {
  const done = () => {
    const original = button.textContent;
    button.textContent = 'Copied';
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    return;
  }
  fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const scratch = h('textarea', { value: text, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
  document.body.appendChild(scratch);
  scratch.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    /* clipboard unavailable — nothing else to do */
  }
  scratch.remove();
}

/**
 * Build a code card with Apply / Copy actions.
 * @param {string} code
 * @param {string} lang
 * @param {boolean} complete false while the fence is still streaming
 * @param {(code:string, lang:string)=>void} applyToEditor
 */
function codeCard(code, lang, complete, applyToEditor) {
  const language = lang || 'text';
  const body = h('code.agent-code__code');
  body.appendChild(highlight(code, language));

  const copyButton = h('button.agent-code__action', { type: 'button', text: 'Copy' });
  copyButton.addEventListener('click', () => copyText(code, copyButton));

  const applyButton = h('button.agent-code__action', { type: 'button', text: 'Apply to editor' });
  applyButton.addEventListener('click', () => applyToEditor(code, language));

  const actions = h('div.agent-code__actions', {}, applyButton, copyButton);
  const head = h(
    'div.agent-code__head',
    {},
    h('span.agent-code__lang', { text: languageLabel(language) }),
    complete ? actions : h('span.agent-code__lang', { text: 'streaming…' }),
  );

  return h('div.agent-code', {}, head, h('pre.agent-code__body', {}, body));
}

/**
 * Render a whole reply. Called again on every stream chunk.
 * @param {string} text
 * @param {(code:string, lang:string)=>void} applyToEditor
 * @returns {DocumentFragment}
 */
function renderReply(text, applyToEditor) {
  const fragment = document.createDocumentFragment();
  const lines = String(text).split('\n');
  let paragraph = [];
  let list = null;
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = h('p.agent-p');
    p.appendChild(inlineNodes(paragraph.join(' ')));
    fragment.appendChild(p);
    paragraph = [];
  };
  const flushList = () => {
    if (list) fragment.appendChild(list);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);

    if (fence) {
      flushParagraph();
      flushList();
      const lang = fence[1] || '';
      const bodyLines = [];
      i += 1;
      while (i < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[i])) {
        bodyLines.push(lines[i]);
        i += 1;
      }
      const complete = i < lines.length;
      i += 1;
      fragment.appendChild(codeCard(bodyLines.join('\n'), lang, complete, applyToEditor));
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      fragment.appendChild(h('h4.agent-h', { text: heading[2] }));
      i += 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== wanted) {
        flushList();
        list = h(`${wanted}.agent-list`);
      }
      const item = h('li');
      item.appendChild(inlineNodes(bullet ? bullet[1] : numbered[1]));
      list.appendChild(item);
      i += 1;
      continue;
    }

    flushList();
    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph();
  flushList();
  return fragment;
}

/* ------------------------------------------------------------------ *
 * panel
 * ------------------------------------------------------------------ */

/**
 * @param {{getContext:()=>({path:string|null, language:string, selection:string, content:string}),
 *          applyToEditor?:(code:string, lang:string)=>void,
 *          onNotice?:(message:string)=>void}} options
 */
export function createAgentPanel(options = {}) {
  const getContext = typeof options.getContext === 'function'
    ? options.getContext
    : () => ({ path: null, language: 'text', selection: '', content: '' });
  const applyToEditor = typeof options.applyToEditor === 'function' ? options.applyToEditor : () => {};
  const onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {};

  const history = [];
  let controller = null;
  let busy = false;

  const log = h('div.agent__log', { role: 'log' });
  const actionBar = h('div.agent__actions');
  const textarea = h('textarea.agent__input', {
    rows: '2',
    placeholder: 'Ask Gemini about this file…',
    spellcheck: 'false',
    'aria-label': 'Message the Gemini agent',
  });
  const sendButton = h('button.agent__send', { type: 'button', text: 'Send' });
  const stopButton = h('button.agent__stop', { type: 'button', text: 'Stop', hidden: true });

  const composer = h(
    'div.agent__composer',
    {},
    textarea,
    h('div.agent__composer-row', {}, h('span.agent__hint', { text: 'Enter to send · Shift+Enter for a new line' }), stopButton, sendButton),
  );

  const element = h(
    'div.agent',
    {},
    h(
      'div.agent__header',
      {},
      h('span.agent__title', { text: 'GEMINI AGENT' }),
      h('button.agent__clear', { type: 'button', text: 'Clear', title: 'Clear the conversation' }),
    ),
    actionBar,
    log,
    composer,
  );

  const clearButton = element.querySelector('.agent__clear');

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function addUserMessage(text) {
    const bubble = h('div.agent-msg.agent-msg--user');
    bubble.appendChild(h('div.agent-msg__who', { text: 'You' }));
    const body = h('div.agent-msg__body');
    body.appendChild(inlineNodes(text));
    bubble.appendChild(body);
    log.appendChild(bubble);
    scrollToEnd();
  }

  function addModelMessage() {
    const bubble = h('div.agent-msg.agent-msg--model');
    bubble.appendChild(h('div.agent-msg__who', { text: `Gemini · ${gemini.model}` }));
    const body = h('div.agent-msg__body');
    bubble.appendChild(body);
    log.appendChild(bubble);
    scrollToEnd();
    return body;
  }

  function addNotice(title, detail, withSettings) {
    const notice = h('div.agent-notice', {}, h('strong', { text: title }));
    if (detail) notice.appendChild(h('p.agent-p', { text: detail }));
    if (withSettings) {
      const button = h('button.agent-notice__button', { type: 'button', text: 'Open Settings' });
      button.addEventListener('click', () => {
        import('../../shell/window-manager.js')
          .then((module) => {
            if (module && module.wm && typeof module.wm.open === 'function') {
              module.wm.open('settings', { section: 'ai' });
            } else {
              onNotice('Open Settings → AI Configuration to add your Gemini API key.');
            }
          })
          .catch(() => onNotice('Open Settings → AI Configuration to add your Gemini API key.'));
      });
      notice.appendChild(button);
    }
    log.appendChild(notice);
    scrollToEnd();
  }

  function setBusy(value) {
    busy = value;
    sendButton.disabled = value;
    stopButton.hidden = !value;
    for (const button of actionBar.querySelectorAll('button')) button.disabled = value;
  }

  /** Build the context block that precedes every request. */
  function contextBlock() {
    const ctx = getContext();
    const selection = (ctx.selection || '').trim();
    const usingSelection = selection !== '';
    const source = usingSelection ? ctx.selection : ctx.content || '';
    const truncated = source.length > MAX_CONTEXT_CHARS;
    const body = truncated ? `${source.slice(0, MAX_CONTEXT_CHARS)}\n… (truncated)` : source;
    const language = ctx.language || detectLanguage(ctx.path || '');
    const label = ctx.path ? ctx.path : 'untitled buffer';

    if (body.trim() === '') {
      return { text: `There is no file open in the editor. File: ${label}.`, language, usingSelection: false, empty: true };
    }

    return {
      text:
        `File: ${label}\nLanguage: ${languageLabel(language)}\n` +
        `${usingSelection ? 'The user has selected this region:' : 'Full file contents:'}\n` +
        '```' + language + '\n' + body + '\n```',
      language,
      usingSelection,
      empty: false,
    };
  }

  async function send(userText, instruction) {
    if (busy) return;
    const ctx = contextBlock();
    const prompt = instruction
      ? `${instruction}\n\n${ctx.text}`
      : `${ctx.text}\n\nQuestion: ${userText}`;

    addUserMessage(userText);
    const body = addModelMessage();
    setBusy(true);

    controller = new AbortController();
    let full = '';
    let pending = 0;

    const paint = () => {
      pending = 0;
      clear(body);
      body.appendChild(renderReply(full, applyToEditor));
      scrollToEnd();
    };

    try {
      await gemini.stream(
        prompt,
        (chunk, sofar) => {
          full = sofar;
          if (!pending) pending = window.requestAnimationFrame(paint);
        },
        { system: SYSTEM_PROMPT, temperature: 0.3, history: history.slice(-8), signal: controller.signal },
      );
      if (pending) window.cancelAnimationFrame(pending);
      paint();
      history.push({ role: 'user', text: prompt });
      history.push({ role: 'model', text: full });
    } catch (err) {
      if (pending) window.cancelAnimationFrame(pending);
      const message = (err && err.message) || String(err);
      if (err && err.name === 'AbortError') {
        paint();
        body.appendChild(h('p.agent-p.agent-p--dim', { text: 'Stopped.' }));
      } else if (message === 'NO_API_KEY') {
        const bubble = body.parentElement;
        if (bubble) bubble.remove();
        addNotice(
          'No Gemini API key configured',
          'The agent needs a Google Gemini API key before it can answer. Add one in Settings → ' +
            'AI Configuration; the key is kept in this browser only and is never committed anywhere.',
          true,
        );
      } else {
        clear(body);
        body.appendChild(h('p.agent-p.agent-p--error', { text: `Request failed — ${message}` }));
      }
    } finally {
      controller = null;
      setBusy(false);
      textarea.focus();
    }
  }

  for (const action of AGENT_ACTIONS) {
    const button = h('button.agent__action', { type: 'button', text: action.label, title: action.title });
    button.addEventListener('click', () => {
      const ctx = contextBlock();
      if (ctx.empty) {
        addNotice('Nothing to work on', 'Open a file in the editor first, then run this action again.', false);
        return;
      }
      void send(`${action.label}${ctx.usingSelection ? ' (selection)' : ''}`, action.instruction);
    });
    actionBar.appendChild(button);
  }

  const offSend = on(sendButton, 'click', () => {
    const text = textarea.value.trim();
    if (text === '') return;
    textarea.value = '';
    void send(text, null);
  });

  const offStop = on(stopButton, 'click', () => {
    if (controller) controller.abort();
  });

  const offClear = on(clearButton, 'click', () => {
    history.length = 0;
    clear(log);
    log.appendChild(h('p.agent__empty', { text: 'Ask about the open file, or pick one of the actions above.' }));
  });

  const offKeys = on(textarea, 'keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendButton.click();
    }
  });

  log.appendChild(h('p.agent__empty', { text: 'Ask about the open file, or pick one of the actions above.' }));

  return {
    element,

    /** Run one of AGENT_ACTIONS by id. */
    runAction(id) {
      const action = AGENT_ACTIONS.find((a) => a.id === id);
      if (!action) return;
      const ctx = contextBlock();
      if (ctx.empty) {
        addNotice('Nothing to work on', 'Open a file in the editor first, then run this action again.', false);
        return;
      }
      void send(action.label, action.instruction);
    },

    /** Send a free-form question. */
    ask(text) {
      const trimmed = String(text || '').trim();
      if (trimmed !== '') void send(trimmed, null);
    },

    focusInput() {
      textarea.focus();
    },

    destroy() {
      if (controller) controller.abort();
      offSend();
      offStop();
      offClear();
      offKeys();
    },
  };
}
