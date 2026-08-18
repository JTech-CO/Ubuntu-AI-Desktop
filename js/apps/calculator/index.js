/**
 * js/apps/calculator/index.js — GNOME Calculator (ARCHITECTURE §16, §18).
 *
 * Basic and Advanced modes, a scrolling history strip above the display, a
 * live result preview, full keyboard entry and memory registers. Every
 * evaluation goes through the tokenizer/parser in `./engine.js` — there is no
 * `eval` and no `new Function` in this app.
 */

import { h, svg, clear, on } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { calculate, formatNumber, groupDigits, CalcError } from './engine.js';

/** Persisted state key. */
const STORE_KEY = 'calculator';

/** History entries kept across sessions. */
const HISTORY_LIMIT = 40;

/**
 * Key descriptors. `r`/`c` are 1-based grid coordinates, `rs`/`cs` spans.
 * @type {{label:string, action:string, value?:string, variant?:string,
 *         r:number, c:number, rs?:number, cs?:number, aria?:string, key?:string}[]}
 */
const BASIC_KEYS = [
  { label: 'C', action: 'clear', variant: 'function', r: 1, c: 1, aria: 'Clear' },
  { label: '(', action: 'insert', value: '(', variant: 'function', r: 1, c: 2 },
  { label: ')', action: 'insert', value: ')', variant: 'function', r: 1, c: 3 },
  { label: '%', action: 'insert', value: '%', variant: 'function', r: 1, c: 4, aria: 'Percent' },
  { label: '⌫', action: 'backspace', variant: 'function', r: 1, c: 5, aria: 'Backspace' },

  { label: '7', action: 'insert', value: '7', r: 2, c: 1 },
  { label: '8', action: 'insert', value: '8', r: 2, c: 2 },
  { label: '9', action: 'insert', value: '9', r: 2, c: 3 },
  { label: '÷', action: 'insert', value: '÷', variant: 'operator', r: 2, c: 4, aria: 'Divide' },
  { label: '±', action: 'sign', variant: 'function', r: 2, c: 5, aria: 'Change sign' },

  { label: '4', action: 'insert', value: '4', r: 3, c: 1 },
  { label: '5', action: 'insert', value: '5', r: 3, c: 2 },
  { label: '6', action: 'insert', value: '6', r: 3, c: 3 },
  { label: '×', action: 'insert', value: '×', variant: 'operator', r: 3, c: 4, aria: 'Multiply' },
  { label: '=', action: 'equals', variant: 'suggested', r: 3, c: 5, rs: 3, aria: 'Equals' },

  { label: '1', action: 'insert', value: '1', r: 4, c: 1 },
  { label: '2', action: 'insert', value: '2', r: 4, c: 2 },
  { label: '3', action: 'insert', value: '3', r: 4, c: 3 },
  { label: '−', action: 'insert', value: '−', variant: 'operator', r: 4, c: 4, aria: 'Subtract' },

  { label: '0', action: 'insert', value: '0', r: 5, c: 1, cs: 2 },
  { label: '.', action: 'insert', value: '.', r: 5, c: 3, aria: 'Decimal point' },
  { label: '+', action: 'insert', value: '+', variant: 'operator', r: 5, c: 4, aria: 'Add' },
];

const ADVANCED_KEYS = [
  { label: 'x²', action: 'insert', value: '^2', variant: 'function', r: 1, c: 1, aria: 'Square' },
  { label: 'xʸ', action: 'insert', value: '^', variant: 'function', r: 1, c: 2, aria: 'Power' },
  { label: '√', action: 'insert', value: '√(', variant: 'function', r: 1, c: 3, aria: 'Square root' },
  { label: '∛', action: 'insert', value: '∛(', variant: 'function', r: 1, c: 4, aria: 'Cube root' },
  { label: 'mod', action: 'insert', value: ' mod ', variant: 'function', r: 1, c: 5, aria: 'Modulus' },

  { label: 'sin', action: 'insert', value: 'sin(', variant: 'function', r: 2, c: 1 },
  { label: 'cos', action: 'insert', value: 'cos(', variant: 'function', r: 2, c: 2 },
  { label: 'tan', action: 'insert', value: 'tan(', variant: 'function', r: 2, c: 3 },
  { label: 'ln', action: 'insert', value: 'ln(', variant: 'function', r: 2, c: 4, aria: 'Natural logarithm' },
  { label: 'log', action: 'insert', value: 'log(', variant: 'function', r: 2, c: 5, aria: 'Logarithm' },

  { label: 'π', action: 'insert', value: 'π', variant: 'function', r: 3, c: 1, aria: 'Pi' },
  { label: 'e', action: 'insert', value: 'e', variant: 'function', r: 3, c: 2, aria: "Euler's number" },
  { label: 'n!', action: 'insert', value: '!', variant: 'function', r: 3, c: 3, aria: 'Factorial' },
  { label: '¹⁄ₓ', action: 'reciprocal', variant: 'function', r: 3, c: 4, aria: 'Reciprocal' },
  { label: '|x|', action: 'insert', value: 'abs(', variant: 'function', r: 3, c: 5, aria: 'Absolute value' },

  { label: 'MC', action: 'memory-clear', variant: 'memory', r: 4, c: 1, aria: 'Memory clear' },
  { label: 'MR', action: 'memory-recall', variant: 'memory', r: 4, c: 2, aria: 'Memory recall' },
  { label: 'M+', action: 'memory-add', variant: 'memory', r: 4, c: 3, aria: 'Memory add' },
  { label: 'M−', action: 'memory-subtract', variant: 'memory', r: 4, c: 4, aria: 'Memory subtract' },
  { label: 'MS', action: 'memory-store', variant: 'memory', r: 4, c: 5, aria: 'Memory store' },
];

/** Physical key -> inserted text. */
const KEY_INSERTS = new Map([
  ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'],
  ['5', '5'], ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'],
  ['.', '.'], [',', '.'],
  ['+', '+'], ['-', '−'], ['*', '×'], ['/', '÷'],
  ['(', '('], [')', ')'], ['^', '^'], ['%', '%'], ['!', '!'],
]);

/** @type {Map<string, {teardown: Array<() => void>}>} */
const instances = new Map();

function calculatorIcon() {
  return svg(
    [
      'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
      'M8 6h8v3H8z',
      'M8.5 12.5h.01 M12 12.5h.01 M15.5 12.5h.01',
      'M8.5 16.5h.01 M12 16.5h.01 M15.5 16.5h.01',
    ],
    { size: 24, strokeWidth: 1.6, class: 'app-icon app-icon--calculator' },
  );
}

function loadState() {
  const saved = store.get(STORE_KEY, null);
  const base = { mode: 'basic', angleUnit: 'deg', memory: 0, history: [] };
  if (!saved || typeof saved !== 'object') return base;
  return {
    mode: saved.mode === 'advanced' ? 'advanced' : 'basic',
    angleUnit: saved.angleUnit === 'rad' ? 'rad' : 'deg',
    memory: Number.isFinite(saved.memory) ? saved.memory : 0,
    history: Array.isArray(saved.history)
      ? saved.history
          .filter((e) => e && typeof e.expression === 'string' && typeof e.result === 'string')
          .slice(-HISTORY_LIMIT)
      : [],
  };
}

export default {
  id: 'calculator',
  name: 'Calculator',
  genericName: 'Calculator',
  icon: calculatorIcon,
  pinned: false,
  singleton: false,
  width: 420,
  height: 640,
  minWidth: 340,
  minHeight: 470,
  resizable: true,
  themeClass: 'app-calculator',
  darkChrome: false,

  /**
   * @param {HTMLElement} root
   * @param {{instanceId:string, args:object, setTitle:(t:string)=>void}} ctx
   */
  mount(root, ctx) {
    clear(root);

    const state = loadState();
    let expression = '';
    let lastResult = '';

    /* --- chrome ------------------------------------------------- */

    const modeButtons = new Map();
    const modeGroup = h('div.calc-modes', { role: 'tablist', 'aria-label': 'Calculator mode' });
    for (const mode of [
      { id: 'basic', label: 'Basic' },
      { id: 'advanced', label: 'Advanced' },
    ]) {
      const button = h('button.calc-modes__button', {
        type: 'button',
        role: 'tab',
        text: mode.label,
        'aria-selected': 'false',
      });
      button.addEventListener('click', () => setMode(mode.id));
      modeButtons.set(mode.id, button);
      modeGroup.appendChild(button);
    }

    const angleButtons = new Map();
    const angleGroup = h('div.calc-angle', { role: 'group', 'aria-label': 'Angle unit' });
    for (const unit of [
      { id: 'deg', label: 'Deg' },
      { id: 'rad', label: 'Rad' },
    ]) {
      const button = h('button.calc-angle__button', {
        type: 'button',
        text: unit.label,
        'aria-pressed': 'false',
      });
      button.addEventListener('click', () => setAngleUnit(unit.id));
      angleButtons.set(unit.id, button);
      angleGroup.appendChild(button);
    }

    const clearHistoryButton = h('button.calc-iconbutton', {
      type: 'button',
      title: 'Clear History',
      'aria-label': 'Clear history',
      text: '⌫',
    });
    clearHistoryButton.addEventListener('click', () => {
      state.history = [];
      persist();
      renderHistory();
    });

    const topbar = h('div.calc-topbar', {}, modeGroup, h('div.calc-topbar__spacer'), angleGroup, clearHistoryButton);

    /* --- history + display -------------------------------------- */

    const historyList = h('div.calc-history', { role: 'log', 'aria-label': 'Calculation history' });
    const expressionNode = h('div.calc-display__expression', { text: '0' });
    const previewNode = h('div.calc-display__preview', { text: '' });
    const memoryBadge = h('span.calc-display__memory', { text: 'M', hidden: true });
    const display = h(
      'div.calc-display',
      {},
      memoryBadge,
      expressionNode,
      previewNode,
    );

    /* --- keypads ------------------------------------------------- */

    function buildPad(keys, className) {
      const pad = h(`div.calc-pad.${className}`);
      for (const key of keys) {
        const button = h('button.calc-key', {
          type: 'button',
          text: key.label,
          'aria-label': key.aria || key.label,
          'data-action': key.action,
          style: {
            'grid-column': key.cs ? `${key.c} / span ${key.cs}` : String(key.c),
            'grid-row': key.rs ? `${key.r} / span ${key.rs}` : String(key.r),
          },
        });
        if (key.variant) button.classList.add(`calc-key--${key.variant}`);
        button.addEventListener('click', () => runAction(key.action, key.value));
        pad.appendChild(button);
      }
      return pad;
    }

    const advancedPad = buildPad(ADVANCED_KEYS, 'calc-pad--advanced');
    const basicPad = buildPad(BASIC_KEYS, 'calc-pad--basic');
    const pads = h('div.calc-pads', {}, advancedPad, basicPad);

    const shell = h('div.calc', { tabindex: '0' }, topbar, historyList, display, pads);
    root.appendChild(shell);

    /* --- persistence --------------------------------------------- */

    function persist() {
      store.set(STORE_KEY, {
        mode: state.mode,
        angleUnit: state.angleUnit,
        memory: state.memory,
        history: state.history.slice(-HISTORY_LIMIT),
      });
    }

    /* --- rendering ------------------------------------------------ */

    function renderHistory() {
      clear(historyList);
      if (state.history.length === 0) {
        historyList.appendChild(h('div.calc-history__empty', { text: 'No calculations yet' }));
        return;
      }
      for (const entry of state.history) {
        const row = h('button.calc-history__entry', { type: 'button' });
        row.appendChild(h('span.calc-history__expression', { text: entry.expression }));
        row.appendChild(h('span.calc-history__result', { text: `= ${entry.result}` }));
        row.addEventListener('click', () => {
          expression += entry.result;
          renderDisplay();
        });
        historyList.appendChild(row);
      }
      historyList.scrollTop = historyList.scrollHeight;
    }

    function renderDisplay() {
      expressionNode.textContent = expression === '' ? lastResult || '0' : expression;
      memoryBadge.hidden = state.memory === 0;

      if (expression.trim() === '') {
        previewNode.textContent = '';
        previewNode.classList.remove('is-error');
        return;
      }
      try {
        const value = calculate(expression, { angleUnit: state.angleUnit });
        const formatted = groupDigits(formatNumber(value));
        previewNode.textContent = formatted === expression ? '' : `= ${formatted}`;
        previewNode.classList.remove('is-error');
      } catch {
        // Half-typed expressions are normal; stay quiet until "=" is pressed.
        previewNode.textContent = '';
        previewNode.classList.remove('is-error');
      }
    }

    function showError(message) {
      previewNode.textContent = message;
      previewNode.classList.add('is-error');
    }

    function setMode(mode) {
      state.mode = mode === 'advanced' ? 'advanced' : 'basic';
      for (const [id, button] of modeButtons) {
        const active = id === state.mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      shell.classList.toggle('is-advanced', state.mode === 'advanced');
      if (typeof ctx.setTitle === 'function') {
        ctx.setTitle(state.mode === 'advanced' ? 'Calculator — Advanced' : 'Calculator');
      }
      persist();
    }

    function setAngleUnit(unit) {
      state.angleUnit = unit === 'rad' ? 'rad' : 'deg';
      for (const [id, button] of angleButtons) {
        const active = id === state.angleUnit;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      persist();
      renderDisplay();
    }

    /* --- actions --------------------------------------------------- */

    /** Current numeric value: the live expression, else the last result. */
    function currentValue() {
      const source = expression.trim() !== '' ? expression : lastResult;
      if (source === '') return 0;
      try {
        return calculate(source, { angleUnit: state.angleUnit });
      } catch {
        return null;
      }
    }

    function toggleSign() {
      const match = /(\d+(?:\.\d+)?)$/.exec(expression);
      if (!match) {
        const value = currentValue();
        if (value === null) return;
        expression = formatNumber(-value);
        renderDisplay();
        return;
      }
      const start = expression.length - match[1].length;
      const before = expression.slice(0, start);
      if (before.endsWith('−') && (before.length === 1 || /[+−×÷^(]$/.test(before.slice(0, -1)))) {
        expression = before.slice(0, -1) + match[1];
      } else {
        expression = `${before}−${match[1]}`;
      }
      renderDisplay();
    }

    function equals() {
      const source = expression.trim();
      if (source === '') return;
      try {
        const value = calculate(source, { angleUnit: state.angleUnit });
        const formatted = formatNumber(value);
        state.history.push({ expression: source, result: groupDigits(formatted) });
        if (state.history.length > HISTORY_LIMIT) state.history.shift();
        lastResult = formatted;
        expression = formatted;
        persist();
        renderHistory();
        renderDisplay();
        previewNode.textContent = '';
      } catch (err) {
        showError(err instanceof CalcError ? err.message : 'Malformed expression');
      }
    }

    function copyResult() {
      const text = expression === '' ? lastResult : expressionNode.textContent;
      if (!text || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;
      navigator.clipboard.writeText(text).catch(() => {
        /* clipboard permission denied — nothing to recover */
      });
    }

    function runAction(action, value) {
      switch (action) {
        case 'insert':
          if (previewNode.classList.contains('is-error')) previewNode.classList.remove('is-error');
          expression += value;
          renderDisplay();
          break;
        case 'clear':
          expression = '';
          lastResult = '';
          previewNode.classList.remove('is-error');
          renderDisplay();
          break;
        case 'backspace':
          expression = expression.slice(0, -1);
          previewNode.classList.remove('is-error');
          renderDisplay();
          break;
        case 'sign':
          toggleSign();
          break;
        case 'equals':
          equals();
          break;
        case 'reciprocal': {
          const source = expression.trim() !== '' ? expression : lastResult;
          if (source === '') break;
          expression = `1/(${source})`;
          renderDisplay();
          break;
        }
        case 'memory-clear':
          state.memory = 0;
          persist();
          renderDisplay();
          break;
        case 'memory-recall':
          expression += formatNumber(state.memory);
          renderDisplay();
          break;
        case 'memory-store': {
          const stored = currentValue();
          if (stored === null) break;
          state.memory = stored;
          persist();
          renderDisplay();
          break;
        }
        case 'memory-add': {
          const added = currentValue();
          if (added === null) break;
          state.memory += added;
          persist();
          renderDisplay();
          break;
        }
        case 'memory-subtract': {
          const subtracted = currentValue();
          if (subtracted === null) break;
          state.memory -= subtracted;
          persist();
          renderDisplay();
          break;
        }
        default:
          break;
      }
    }

    /* --- keyboard --------------------------------------------------- */

    const offKeys = on(shell, 'keydown', (ev) => {
      if (ev.altKey || ev.metaKey) return;

      if (ev.ctrlKey) {
        const lower = ev.key.toLowerCase();
        if (lower === 'b') {
          ev.preventDefault();
          setMode('basic');
        } else if (lower === 'a') {
          ev.preventDefault();
          setMode('advanced');
        } else if (lower === 'c') {
          ev.preventDefault();
          copyResult();
        }
        return;
      }

      if (KEY_INSERTS.has(ev.key)) {
        ev.preventDefault();
        runAction('insert', KEY_INSERTS.get(ev.key));
        return;
      }

      switch (ev.key) {
        case 'Enter':
        case '=':
          ev.preventDefault();
          equals();
          break;
        case 'Backspace':
          ev.preventDefault();
          runAction('backspace');
          break;
        case 'Escape':
        case 'Delete':
          ev.preventDefault();
          runAction('clear');
          break;
        case 'p':
        case 'P':
          ev.preventDefault();
          runAction('insert', 'π');
          break;
        default:
          break;
      }
    });

    // Clicking a key must not steal the keyboard focus from the shell.
    const offPointer = on(shell, 'pointerdown', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('.calc-key')) ev.preventDefault();
      shell.focus();
    });

    instances.set(ctx.instanceId, { teardown: [offKeys, offPointer] });

    setMode(state.mode);
    setAngleUnit(state.angleUnit);
    renderHistory();
    renderDisplay();
    shell.focus();
  },

  onFocus(ctx) {
    const win = ctx.win;
    if (!win) return;
    const shell = win.querySelector('.calc');
    if (shell instanceof HTMLElement) shell.focus();
  },

  onClose(ctx) {
    const record = instances.get(ctx.instanceId);
    if (record) {
      for (const off of record.teardown) off();
      instances.delete(ctx.instanceId);
    }
    return true;
  },
};
