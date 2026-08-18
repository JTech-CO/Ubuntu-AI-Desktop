/**
 * js/core/dom.js — safe DOM construction helpers (ARCHITECTURE §4).
 *
 * The `text` prop and plain-string children always go through `textContent`.
 * `html` exists only for literal developer-authored template strings that
 * interpolate nothing — never route file contents, AI output, filenames or
 * user input through it.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `div`, `div.a.b`, `span#id`, `button#id.a.b`, `div.a#id`, `.only-classes`,
 * `#only-id` — id and classes may appear in any order.
 */
const TAG_RE = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][^.#\s]+)*)$/;

/** Props that must be assigned as IDL properties rather than attributes. */
const PROP_KEYS = new Set([
  'value',
  'checked',
  'selected',
  'indeterminate',
  'disabled',
  'readOnly',
  'multiple',
  'defaultValue',
  'defaultChecked',
  'textContent',
  'innerText',
  'srcObject',
]);

function parseTag(tag) {
  const m = TAG_RE.exec(String(tag).trim());
  if (!m) return { name: 'div', id: '', classes: [] };
  const classes = [];
  let id = '';
  const qualifiers = m[2] || '';
  let i = 0;
  while (i < qualifiers.length) {
    const kind = qualifiers[i];
    let j = i + 1;
    while (j < qualifiers.length && qualifiers[j] !== '.' && qualifiers[j] !== '#') j += 1;
    const value = qualifiers.slice(i + 1, j);
    if (value) {
      if (kind === '#') id = value;
      else classes.push(value);
    }
    i = j;
  }
  return { name: m[1] || 'div', id, classes };
}

function classToString(value) {
  if (value == null || value === false) return '';
  if (Array.isArray(value)) return value.filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.keys(value)
      .filter((k) => value[k])
      .join(' ');
  }
  return String(value);
}

function applyStyle(node, style) {
  if (typeof style === 'string') {
    node.setAttribute('style', style);
    return;
  }
  if (!style || typeof style !== 'object') return;
  for (const [key, value] of Object.entries(style)) {
    if (value == null || value === false) continue;
    if (key.startsWith('--')) node.style.setProperty(key, String(value));
    else if (key.includes('-')) node.style.setProperty(key, String(value));
    else node.style[key] = String(value);
  }
}

function applyListeners(node, listeners) {
  if (!listeners || typeof listeners !== 'object') return;
  for (const [event, spec] of Object.entries(listeners)) {
    if (!spec) continue;
    if (Array.isArray(spec)) node.addEventListener(event, spec[0], spec[1]);
    else node.addEventListener(event, spec);
  }
}

function appendChild(node, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(node, c);
    return;
  }
  if (child instanceof Node) {
    node.appendChild(child);
    return;
  }
  node.appendChild(document.createTextNode(String(child)));
}

/**
 * Create an element.
 * @param {string} tag CSS-ish shorthand: `div`, `div.cls`, `div#id.cls`
 * @param {object} [props]
 * @param {...any} children strings (text nodes) or Nodes; falsy values skipped
 * @returns {HTMLElement|SVGElement}
 */
export function h(tag, props = {}, ...children) {
  const { name, id, classes } = parseTag(tag);
  const node =
    name === 'svg' || name === 'path' || name === 'g' || name === 'circle' || name === 'rect'
      ? document.createElementNS(SVG_NS, name)
      : document.createElement(name);

  if (id) node.id = id;
  if (classes.length) {
    for (const c of classes) node.classList.add(c);
  }

  let attrs = props;
  if (
    attrs === null ||
    attrs === undefined ||
    typeof attrs === 'string' ||
    typeof attrs === 'number' ||
    attrs instanceof Node ||
    Array.isArray(attrs)
  ) {
    // `h('div', 'text')` shorthand — treat the second argument as a child.
    if (attrs !== null && attrs !== undefined) children.unshift(attrs);
    attrs = {};
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;

    switch (key) {
      case 'class':
      case 'className': {
        const str = classToString(value);
        if (str) {
          for (const c of str.split(/\s+/).filter(Boolean)) node.classList.add(c);
        }
        continue;
      }
      case 'id':
        node.id = String(value);
        continue;
      case 'text':
        node.textContent = value == null ? '' : String(value);
        continue;
      case 'html':
        // Developer-authored literal strings only. See ARCHITECTURE §0.4.
        node.innerHTML = String(value);
        continue;
      case 'style':
        applyStyle(node, value);
        continue;
      case 'dataset':
        if (value && typeof value === 'object') {
          for (const [dk, dv] of Object.entries(value)) {
            if (dv == null || dv === false) continue;
            node.dataset[dk] = String(dv);
          }
        }
        continue;
      case 'on':
        applyListeners(node, value);
        continue;
      case 'attrs':
        if (value && typeof value === 'object') {
          for (const [ak, av] of Object.entries(value)) {
            if (av == null || av === false) node.removeAttribute(ak);
            else node.setAttribute(ak, av === true ? '' : String(av));
          }
        }
        continue;
      default:
        break;
    }

    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }

    if (PROP_KEYS.has(key)) {
      node[key] = value;
      continue;
    }

    if (value === false || value === null) {
      node.removeAttribute(key);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) appendChild(node, child);
  return node;
}

/**
 * Build a stroke-based 24x24 symbolic icon.
 * @param {string|string[]} pathData one or more SVG path `d` strings
 * @param {{size?:number, class?:string, viewBox?:string, stroke?:string,
 *          fill?:string, strokeWidth?:number, filled?:boolean, title?:string}} [opts]
 * @returns {SVGElement}
 */
export function svg(pathData, opts = {}) {
  const size = opts.size === undefined ? 24 : opts.size;
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', opts.viewBox || '0 0 24 24');
  root.setAttribute('width', String(size));
  root.setAttribute('height', String(size));
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  if (opts.class) {
    for (const c of String(opts.class).split(/\s+/).filter(Boolean)) root.classList.add(c);
  }

  const filled = opts.filled === true;
  const fill = opts.fill || (filled ? 'currentColor' : 'none');
  const stroke = opts.stroke || (filled ? 'none' : 'currentColor');
  root.setAttribute('fill', fill);
  root.setAttribute('stroke', stroke);
  if (stroke !== 'none') {
    root.setAttribute('stroke-width', String(opts.strokeWidth === undefined ? 1.7 : opts.strokeWidth));
    root.setAttribute('stroke-linecap', 'round');
    root.setAttribute('stroke-linejoin', 'round');
  }

  if (opts.title) {
    const titleEl = document.createElementNS(SVG_NS, 'title');
    titleEl.textContent = opts.title;
    root.appendChild(titleEl);
    root.setAttribute('aria-hidden', 'false');
    root.setAttribute('role', 'img');
  }

  const paths = Array.isArray(pathData) ? pathData : [pathData];
  for (const d of paths) {
    if (!d) continue;
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', String(d));
    if (opts.fillRule) p.setAttribute('fill-rule', opts.fillRule);
    root.appendChild(p);
  }
  return root;
}

/**
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {Element|null}
 */
export function el(sel, root = document) {
  return root.querySelector(sel);
}

/**
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {Element[]}
 */
export function els(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * Remove every child of a node.
 * @param {Node} node
 * @returns {Node} the same node
 */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Escape a string for safe interpolation into an HTML literal.
 * Prefer `textContent`; this exists for the rare attribute-building case.
 * @param {any} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {...any} children
 * @returns {DocumentFragment}
 */
export function frag(...children) {
  const f = document.createDocumentFragment();
  for (const child of children) appendChild(f, child);
  return f;
}

/**
 * addEventListener that returns its own unsubscribe function.
 * @param {EventTarget} target
 * @param {string} event
 * @param {EventListener} handler
 * @param {boolean|AddEventListenerOptions} [opts]
 * @returns {() => void}
 */
export function on(target, event, handler, opts) {
  if (!target || typeof target.addEventListener !== 'function') {
    throw new TypeError('dom.on: target is not an EventTarget');
  }
  target.addEventListener(event, handler, opts);
  return () => target.removeEventListener(event, handler, opts);
}

/**
 * Delegated listener. The handler receives `(event, matchedElement)`.
 * @param {Element|Document} root
 * @param {string} sel
 * @param {string} event
 * @param {(ev: Event, matched: Element) => void} handler
 * @returns {() => void}
 */
export function delegate(root, sel, event, handler) {
  const listener = (ev) => {
    const start = ev.target;
    if (!start || typeof start.closest !== 'function') return;
    const matched = start.closest(sel);
    if (matched && root.contains(matched)) handler(ev, matched);
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}
