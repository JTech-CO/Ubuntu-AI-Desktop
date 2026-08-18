/**
 * js/apps/codeoss/panel.js — the Code-OSS bottom panel.
 *
 * Three tabs, all of them honest:
 *   Terminal — the real terminal engine (`apps/terminal/shell.js`), rendered
 *              through `apps/terminal/ansi.js`. Not a mock.
 *   Problems — genuine checks the browser can actually perform (JSON parsing,
 *              bracket balance from the tokenizer), never invented diagnostics.
 *   Output   — where Run reports. Shell scripts really execute; interpreted
 *              languages are labelled clearly as AI-simulated, and with no API
 *              key the panel says so instead of faking a result.
 */

import { h, clear, on } from '../../core/dom.js';
import * as path from '../../core/path.js';
import { env } from '../../core/env.js';
import { fs } from '../../core/fs.js';
import { gemini } from '../../services/gemini.js';
import { execute } from '../terminal/shell.js';
import { ansiToNodes } from '../terminal/ansi.js';
import { tokenize, languageLabel, normalizeLanguage } from './highlight.js';

const TABS = [
  { id: 'problems', label: 'PROBLEMS' },
  { id: 'output', label: 'OUTPUT' },
  { id: 'terminal', label: 'TERMINAL' },
];

/** Languages Run can hand to the model as a simulated interpreter. */
const SIMULATED = {
  python: { command: 'python3', label: 'Python 3.12' },
  javascript: { command: 'node', label: 'Node.js' },
  typescript: { command: 'npx tsx', label: 'TypeScript' },
  cpp: { command: 'g++ -std=c++20 -o /tmp/a.out … && /tmp/a.out', label: 'GNU C++' },
  c: { command: 'gcc -o /tmp/a.out … && /tmp/a.out', label: 'GNU C' },
  java: { command: 'java', label: 'OpenJDK' },
};

/* ------------------------------------------------------------------ *
 * honest problem detection
 * ------------------------------------------------------------------ */

const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const NON_CODE = new Set(['comment', 'string', 'template', 'regexp']);

function positionOf(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

/**
 * Real diagnostics only: a JSON parse error, or an unbalanced bracket found
 * outside strings and comments.
 * @param {{path:string|null, content:string, language:string}} doc
 * @returns {{severity:string, message:string, line:number, column:number}[]}
 */
export function findProblems(doc) {
  const problems = [];
  if (!doc || typeof doc.content !== 'string' || doc.content === '') return problems;
  const language = normalizeLanguage(doc.language);
  const text = doc.content;

  if (language === 'json') {
    try {
      JSON.parse(text);
    } catch (err) {
      const message = (err && err.message) || 'Invalid JSON';
      const at = /position (\d+)/.exec(message);
      const where = at ? positionOf(text, Number(at[1])) : { line: 1, column: 1 };
      problems.push({ severity: 'error', message, line: where.line, column: where.column });
    }
    return problems;
  }

  if (language === 'text' || language === 'markdown') return problems;

  const stack = [];
  let offset = 0;
  for (const token of tokenize(text, language)) {
    if (!NON_CODE.has(token.type)) {
      for (let i = 0; i < token.value.length; i += 1) {
        const ch = token.value[i];
        if (OPENERS[ch]) {
          stack.push({ ch, offset: offset + i });
        } else if (CLOSERS[ch]) {
          const top = stack.pop();
          if (!top) {
            const where = positionOf(text, offset + i);
            problems.push({
              severity: 'error',
              message: `Unmatched '${ch}'.`,
              line: where.line,
              column: where.column,
            });
          } else if (OPENERS[top.ch] !== ch) {
            const where = positionOf(text, offset + i);
            problems.push({
              severity: 'error',
              message: `Expected '${OPENERS[top.ch]}' but found '${ch}'.`,
              line: where.line,
              column: where.column,
            });
          }
        }
      }
    }
    offset += token.value.length;
  }

  for (const left of stack) {
    const where = positionOf(text, left.offset);
    problems.push({
      severity: 'error',
      message: `'${left.ch}' is never closed.`,
      line: where.line,
      column: where.column,
    });
  }

  return problems.slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * panel
 * ------------------------------------------------------------------ */

/**
 * @param {{getActiveDoc?:()=>object|null, onOpenLocation?:(p:string, line:number, col:number)=>void,
 *          onVisibility?:(visible:boolean)=>void}} [options]
 */
export function createPanel(options = {}) {
  const getActiveDoc = typeof options.getActiveDoc === 'function' ? options.getActiveDoc : () => null;
  const onOpenLocation = typeof options.onOpenLocation === 'function' ? options.onOpenLocation : () => {};
  const onVisibility = typeof options.onVisibility === 'function' ? options.onVisibility : () => {};

  let active = 'terminal';
  let visible = false;

  const tabsRow = h('div.panel__tabs', { role: 'tablist' });
  const badge = h('span.panel__badge', { hidden: true });
  const closeButton = h('button.panel__icon', { type: 'button', text: '✕', title: 'Close Panel' });
  const header = h('div.panel__header', {}, tabsRow, h('div.panel__spacer'), closeButton);

  const problemsView = h('div.panel__view.panel__view--problems');
  const outputView = h('div.panel__view.panel__view--output');
  const terminalView = h('div.panel__view.panel__view--terminal');
  const views = h('div.panel__views', {}, problemsView, outputView, terminalView);
  const element = h('div.panel', {}, header, views);

  const tabButtons = new Map();
  for (const tab of TABS) {
    const button = h('button.panel__tab', { type: 'button', role: 'tab', text: tab.label });
    button.addEventListener('click', () => api.show(tab.id));
    if (tab.id === 'problems') button.appendChild(badge);
    tabButtons.set(tab.id, button);
    tabsRow.appendChild(button);
  }

  /* --- output ---------------------------------------------------- */

  const outputLog = h('div.panel-output__log');
  outputView.appendChild(h('div.panel-output__channel', { text: 'Tasks' }));
  outputView.appendChild(outputLog);

  function output(text, kind) {
    const line = h('div.panel-output__line', { text: String(text) });
    if (kind) line.classList.add(`panel-output__line--${kind}`);
    outputLog.appendChild(line);
    outputLog.scrollTop = outputLog.scrollHeight;
    return line;
  }

  function outputBlock(text, kind) {
    for (const line of String(text).replace(/\n$/, '').split('\n')) output(line, kind);
  }

  /* --- problems -------------------------------------------------- */

  function renderProblems(list, doc) {
    clear(problemsView);
    if (!list || list.length === 0) {
      problemsView.appendChild(
        h('p.panel__empty', {
          text: doc && doc.path
            ? 'No problems have been detected in this file.'
            : 'No problems have been detected in the workspace so far.',
        }),
      );
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.textContent = String(list.length);

    const file = h('div.problem-file');
    file.appendChild(h('span.problem-file__name', { text: doc && doc.path ? path.basename(doc.path) : 'untitled' }));
    file.appendChild(h('span.problem-file__path', { text: doc && doc.path ? path.contract(path.dirname(doc.path), fs.HOME) : '' }));
    problemsView.appendChild(file);

    for (const problem of list) {
      const row = h('button.problem', { type: 'button' });
      row.appendChild(h('span.problem__severity', { text: problem.severity === 'error' ? '✕' : '⚠' }));
      row.appendChild(h('span.problem__message', { text: problem.message }));
      row.appendChild(h('span.problem__where', { text: `[Ln ${problem.line}, Col ${problem.column}]` }));
      row.addEventListener('click', () => {
        if (doc && doc.path) onOpenLocation(doc.path, problem.line, problem.column);
      });
      problemsView.appendChild(row);
    }
  }

  /* --- terminal -------------------------------------------------- */

  const termLog = h('div.panel-term__log');
  const termInput = h('input.panel-term__input', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Terminal input',
  });
  const termPrompt = h('span.panel-term__prompt');
  const termLine = h('div.panel-term__line', {}, termPrompt, termInput);
  const termBody = h('div.panel-term__body', {}, termLog, termLine);
  terminalView.appendChild(termBody);

  const termHistory = [];
  let historyIndex = 0;
  let running = false;
  let runController = null;
  let askResolver = null;

  function promptText() {
    const cwd = path.contract(env.cwd, env.home);
    return `${env.user}@${env.host}:${cwd}$ `;
  }

  function refreshPrompt() {
    termPrompt.textContent = promptText();
  }

  function termWrite(text, className) {
    if (text === undefined || text === null || text === '') return;
    const node = h('div.panel-term__out');
    if (className) node.classList.add(className);
    node.appendChild(ansiToNodes(String(text)));
    termLog.appendChild(node);
    termBody.scrollTop = termBody.scrollHeight;
  }

  const term = {
    write(text) {
      termWrite(text);
    },
    writeLine(text) {
      termWrite(`${text === undefined ? '' : text}\n`);
    },
    clear() {
      clear(termLog);
    },
    ask(question, opts = {}) {
      return new Promise((resolve) => {
        termPrompt.textContent = String(question === undefined ? '' : question);
        termInput.type = opts.password ? 'password' : 'text';
        termInput.value = '';
        termInput.focus();
        askResolver = (value) => {
          askResolver = null;
          termInput.type = 'text';
          refreshPrompt();
          resolve(value);
        };
      });
    },
  };

  async function runLine(line) {
    runController = new AbortController();
    try {
      const result = await execute(line, { term, signal: runController.signal });
      if (result && result.stdout) termWrite(result.stdout);
      if (result && result.stderr) termWrite(result.stderr, 'is-stderr');
      return result && typeof result.code === 'number' ? result.code : 0;
    } catch (err) {
      termWrite(`${(err && err.message) || String(err)}\n`, 'is-stderr');
      return 1;
    } finally {
      runController = null;
    }
  }

  async function submitLine(line) {
    termWrite(`${promptText()}${line}\n`, 'is-echo');
    if (line.trim() !== '') {
      termHistory.push(line);
      historyIndex = termHistory.length;
    }
    running = true;
    termInput.disabled = true;
    await runLine(line);
    running = false;
    termInput.disabled = false;
    refreshPrompt();
    termInput.focus();
  }

  const offTermKeys = on(termInput, 'keydown', (ev) => {
    ev.stopPropagation();

    if (askResolver) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const value = termInput.value;
        termInput.value = '';
        askResolver(value);
      }
      return;
    }

    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (running) return;
      const line = termInput.value;
      termInput.value = '';
      void submitLine(line);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (historyIndex > 0) {
        historyIndex -= 1;
        termInput.value = termHistory[historyIndex] || '';
      }
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (historyIndex < termHistory.length - 1) {
        historyIndex += 1;
        termInput.value = termHistory[historyIndex] || '';
      } else {
        historyIndex = termHistory.length;
        termInput.value = '';
      }
      return;
    }
    if (ev.key === 'c' && ev.ctrlKey) {
      ev.preventDefault();
      if (runController) runController.abort();
      termWrite('^C\n');
      termInput.value = '';
      return;
    }
    if (ev.key === 'l' && ev.ctrlKey) {
      ev.preventDefault();
      clear(termLog);
    }
  });

  const offTermFocus = on(termBody, 'mousedown', (ev) => {
    if (ev.target === termInput) return;
    if (window.getSelection && String(window.getSelection()).length > 0) return;
    window.setTimeout(() => termInput.focus(), 0);
  });

  refreshPrompt();
  termWrite('Ubuntu 24.04.1 LTS — integrated terminal (bash 5.2.21)\n', 'is-dim');

  /* --- run ------------------------------------------------------- */

  function rule(title) {
    output('', null);
    output(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`, 'rule');
  }

  async function runShellScript(doc) {
    rule('Shell script');
    output(`Running ${doc.path} line by line through the terminal engine.`, 'note');
    output('There is no real /bin/bash process here; each line is executed by the', 'note');
    output('same shell implementation the Terminal app uses.', 'note');
    output('');

    const lines = String(doc.content).split('\n');
    let executed = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      output(`$ ${line}`, 'command');
      try {
        const result = await execute(line, { term: silentTerm, signal: undefined });
        if (result && result.stdout) outputBlock(result.stdout);
        if (result && result.stderr) outputBlock(result.stderr, 'error');
        if (result && result.code) output(`exit status ${result.code}`, 'error');
      } catch (err) {
        output(`${(err && err.message) || String(err)}`, 'error');
      }
      executed += 1;
    }
    output('');
    output(`Finished — ${executed} command${executed === 1 ? '' : 's'} executed.`, 'note');
  }

  const silentTerm = {
    write(text) {
      outputBlock(text);
    },
    writeLine(text) {
      output(String(text === undefined ? '' : text));
    },
    clear() {},
    ask() {
      return Promise.resolve('');
    },
  };

  async function runSimulated(doc, language) {
    const spec = SIMULATED[language];
    rule('AI-simulated execution');
    output(`This desktop has no real ${spec.label} runtime.`, 'note');

    if (!gemini.hasKey()) {
      output('', null);
      output(`Cannot run ${path.basename(doc.path || 'this file')}.`, 'error');
      output('No Gemini API key is configured, so nothing here can produce this', 'error');
      output("program's output. Rather than invent a plausible-looking result, Run", 'error');
      output('stops here.', 'error');
      output('');
      output('Add a key in Settings → AI Configuration to get an AI-simulated run.', 'note');
      return;
    }

    output(`Asking ${gemini.model} to predict what \`${spec.command}\` would print.`, 'note');
    output('The result below is a model prediction, not a real program run, and it', 'note');
    output('may be wrong.', 'note');
    output('');
    const pending = output('  … running', 'dim');

    const prompt =
      `Act as the ${spec.label} runtime. Below is the complete contents of ` +
      `${doc.path || 'a program'}. Determine exactly what this program writes to stdout and ` +
      'stderr when run, and reply with that output and nothing else — no explanation, no ' +
      'markdown fences, no commentary. If the program would fail to compile or would raise ' +
      'an error, reply with the exact error text the real toolchain would print. If the ' +
      'program reads from stdin, assume stdin is empty.\n\n' +
      `\`\`\`${language}\n${String(doc.content).slice(0, 20000)}\n\`\`\``;

    try {
      const reply = await gemini.generate(prompt, { temperature: 0 });
      pending.remove();
      const cleaned = reply.replace(/^```[A-Za-z0-9_+-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
      outputBlock(cleaned === '' ? '(the program produced no output)' : cleaned, 'program');
      output('');
      output('── end of AI-simulated output ──', 'note');
    } catch (err) {
      pending.remove();
      const message = (err && err.message) || String(err);
      if (message === 'NO_API_KEY') {
        output('No Gemini API key is configured. Add one in Settings → AI Configuration.', 'error');
      } else {
        output(`The simulated run failed — ${message}`, 'error');
      }
    }
  }

  /* --- public API ------------------------------------------------- */

  const api = {
    element,

    /** @param {string} id one of problems|output|terminal */
    show(id) {
      active = TABS.some((t) => t.id === id) ? id : 'terminal';
      visible = true;
      element.classList.remove('is-hidden');
      for (const [tabId, button] of tabButtons) button.classList.toggle('is-active', tabId === active);
      problemsView.hidden = active !== 'problems';
      outputView.hidden = active !== 'output';
      terminalView.hidden = active !== 'terminal';
      if (active === 'terminal') termInput.focus();
      onVisibility(true);
    },

    hide() {
      visible = false;
      element.classList.add('is-hidden');
      onVisibility(false);
    },

    toggle(id) {
      if (visible && (!id || id === active)) api.hide();
      else api.show(id || active);
    },

    isVisible() {
      return visible;
    },

    activeTab() {
      return active;
    },

    focusTerminal() {
      api.show('terminal');
      termInput.focus();
    },

    /** Re-run the honest checks for a document and refresh the Problems tab. */
    updateProblems(doc) {
      const list = findProblems(doc);
      renderProblems(list, doc);
      return list;
    },

    /** Re-check whatever document the host says is active. */
    refresh() {
      return api.updateProblems(getActiveDoc());
    },

    appendOutput(text, kind) {
      outputBlock(text, kind);
    },

    /**
     * Run a document. Shell scripts really execute; interpreted languages are
     * clearly labelled AI-simulated; anything else says so.
     * @param {{path:string|null, content:string, language:string}} doc
     */
    async run(doc) {
      if (!doc || typeof doc.content !== 'string') return;
      api.show('output');
      const language = normalizeLanguage(doc.language);
      const name = doc.path ? path.basename(doc.path) : 'untitled';
      output('');
      output(`> Run ${name}   (${languageLabel(language)})`, 'command');

      if (language === 'shell') {
        await runShellScript(doc);
        return;
      }
      if (SIMULATED[language]) {
        await runSimulated(doc, language);
        return;
      }
      rule('Nothing to run');
      output(`Code-OSS does not know how to run a ${languageLabel(language)} file.`, 'note');
      output('Shell scripts run for real through the terminal engine; Python, JavaScript,', 'note');
      output('TypeScript, C, C++ and Java can be executed as an AI simulation.', 'note');
    },

    destroy() {
      offTermKeys();
      offTermFocus();
      if (runController) runController.abort();
    },
  };

  renderProblems([], null);
  api.show('terminal');
  api.hide();

  return api;
}
