/**
 * js/apps/settings/widgets.js — libadwaita preference primitives.
 *
 * Everything GNOME Settings is built from: a page, rounded preference groups,
 * and the rows that live inside them (switch, combo, slider, entry, button,
 * info). Titles and subtitles always go through `textContent` via `h()`.
 */

import { h } from '../../core/dom.js';

/**
 * A scrollable settings page.
 * @param {{title?:string, description?:string}} spec
 * @param {...(Node|null|false)} groups
 * @returns {HTMLElement}
 */
export function prefPage(spec = {}, ...groups) {
  const page = h('div.adw-page');
  if (spec.title) page.appendChild(h('h1.adw-page__title', { text: spec.title }));
  if (spec.description) page.appendChild(h('p.adw-page__description', { text: spec.description }));
  for (const group of groups) {
    if (group) page.appendChild(group);
  }
  return page;
}

/**
 * A rounded card of rows with an optional heading.
 * @param {{title?:string, description?:string, header?:Node}} spec
 * @param {...(Node|null|false)} rows
 * @returns {HTMLElement}
 */
export function prefGroup(spec = {}, ...rows) {
  const group = h('section.adw-group');
  if (spec.title || spec.description || spec.header) {
    const head = h('div.adw-group__header');
    if (spec.title) head.appendChild(h('h2.adw-group__title', { text: spec.title }));
    if (spec.description) head.appendChild(h('p.adw-group__description', { text: spec.description }));
    if (spec.header) head.appendChild(spec.header);
    group.appendChild(head);
  }
  const list = h('div.adw-list');
  let count = 0;
  for (const row of rows) {
    if (!row) continue;
    list.appendChild(row);
    count += 1;
  }
  if (count > 0) group.appendChild(list);
  return group;
}

/** Free-form card body when a group needs more than a list of rows. */
export function prefCard(spec = {}, ...children) {
  const group = h('section.adw-group');
  if (spec.title) {
    const head = h('div.adw-group__header');
    head.appendChild(h('h2.adw-group__title', { text: spec.title }));
    if (spec.description) head.appendChild(h('p.adw-group__description', { text: spec.description }));
    group.appendChild(head);
  }
  const card = h('div.adw-card');
  for (const child of children) {
    if (child) card.appendChild(child);
  }
  group.appendChild(card);
  return group;
}

/**
 * The base row. Every specialised row below builds on this.
 * @param {{title:string, subtitle?:string, icon?:Node, prefix?:Node, suffix?:Node,
 *          activatable?:boolean, onActivate?:() => void, keywords?:string,
 *          class?:string, disabled?:boolean}} spec
 * @returns {HTMLElement}
 */
export function actionRow(spec) {
  const row = h('div.adw-row', {
    dataset: { keywords: `${spec.title} ${spec.subtitle || ''} ${spec.keywords || ''}`.toLowerCase() },
  });
  if (spec.class) {
    for (const cls of spec.class.split(/\s+/).filter(Boolean)) row.classList.add(cls);
  }
  if (spec.disabled) row.classList.add('is-disabled');

  if (spec.icon) row.appendChild(h('div.adw-row__icon', {}, spec.icon));
  if (spec.prefix) row.appendChild(h('div.adw-row__prefix', {}, spec.prefix));

  const text = h('div.adw-row__text', {}, h('span.adw-row__title', { text: spec.title }));
  if (spec.subtitle) text.appendChild(h('span.adw-row__subtitle', { text: spec.subtitle }));
  row.appendChild(text);

  if (spec.suffix) row.appendChild(h('div.adw-row__suffix', {}, spec.suffix));

  if (spec.activatable && typeof spec.onActivate === 'function') {
    row.classList.add('is-activatable');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', spec.onActivate);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        spec.onActivate();
      }
    });
    row.appendChild(h('span.adw-row__chevron', { 'aria-hidden': 'true', text: '›' }));
  }

  return row;
}

/**
 * A GTK switch.
 * @param {{value:boolean, onChange:(v:boolean)=>void, label?:string, disabled?:boolean}} spec
 * @returns {HTMLElement}
 */
export function switchControl(spec) {
  let value = spec.value === true;
  const control = h('button.adw-switch', {
    type: 'button',
    role: 'switch',
    'aria-checked': value ? 'true' : 'false',
    'aria-label': spec.label || 'Toggle',
    disabled: spec.disabled === true,
  });
  control.appendChild(h('span.adw-switch__slider', { 'aria-hidden': 'true' }));
  control.classList.toggle('is-on', value);

  control.addEventListener('click', () => {
    value = !value;
    control.classList.toggle('is-on', value);
    control.setAttribute('aria-checked', value ? 'true' : 'false');
    spec.onChange(value);
  });

  return control;
}

/**
 * @param {{title:string, subtitle?:string, value:boolean, onChange:(v:boolean)=>void,
 *          icon?:Node, keywords?:string, disabled?:boolean}} spec
 * @returns {HTMLElement}
 */
export function switchRow(spec) {
  return actionRow({
    ...spec,
    suffix: switchControl({
      value: spec.value,
      onChange: spec.onChange,
      label: spec.title,
      disabled: spec.disabled,
    }),
  });
}

/**
 * @param {{title:string, subtitle?:string, value:any, options:({value:any,label:string}|string)[],
 *          onChange:(v:string)=>void, keywords?:string, disabled?:boolean, icon?:Node}} spec
 * @returns {HTMLElement}
 */
export function comboRow(spec) {
  const select = h('select.adw-combo', { 'aria-label': spec.title, disabled: spec.disabled === true });
  for (const option of spec.options) {
    const value = typeof option === 'string' ? option : option.value;
    const label = typeof option === 'string' ? option : option.label;
    const node = h('option', { value: String(value), text: label });
    if (String(value) === String(spec.value)) node.selected = true;
    select.appendChild(node);
  }
  select.addEventListener('change', () => spec.onChange(select.value));
  return actionRow({ ...spec, suffix: select });
}

/**
 * @param {{title:string, subtitle?:string, value:number, min:number, max:number,
 *          step?:number, onChange:(v:number)=>void, format?:(v:number)=>string,
 *          keywords?:string, disabled?:boolean, icon?:Node}} spec
 * @returns {HTMLElement}
 */
export function sliderRow(spec) {
  const format = spec.format || ((v) => String(v));
  const readout = h('span.adw-slider__value', { text: format(spec.value) });
  const input = h('input.adw-slider', {
    type: 'range',
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step === undefined ? 1 : spec.step),
    value: String(spec.value),
    'aria-label': spec.title,
    disabled: spec.disabled === true,
  });
  input.addEventListener('input', () => {
    readout.textContent = format(Number(input.value));
  });
  input.addEventListener('change', () => spec.onChange(Number(input.value)));

  return actionRow({ ...spec, class: 'adw-row--slider', suffix: h('div.adw-slider__box', {}, input, readout) });
}

/**
 * @param {{title:string, subtitle?:string, value:string, placeholder?:string,
 *          password?:boolean, onCommit:(v:string)=>void, onInput?:(v:string)=>void,
 *          keywords?:string, disabled?:boolean, monospace?:boolean, icon?:Node}} spec
 * @returns {{row:HTMLElement, input:HTMLInputElement}}
 */
export function entryRow(spec) {
  const input = h('input.adw-entry', {
    type: spec.password ? 'password' : 'text',
    value: spec.value === undefined || spec.value === null ? '' : String(spec.value),
    placeholder: spec.placeholder || '',
    'aria-label': spec.title,
    disabled: spec.disabled === true,
    spellcheck: 'false',
    autocomplete: 'off',
  });
  if (spec.monospace) input.classList.add('adw-entry--mono');

  input.addEventListener('change', () => spec.onCommit(input.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      spec.onCommit(input.value);
      input.blur();
    }
  });
  if (typeof spec.onInput === 'function') {
    input.addEventListener('input', () => spec.onInput(input.value));
  }

  const row = actionRow({ ...spec, class: 'adw-row--entry', suffix: input });
  return { row, input };
}

/**
 * A plain push button, optionally styled suggested/destructive.
 * @param {{label:string, style?:'suggested'|'destructive'|'', onClick:()=>void,
 *          disabled?:boolean, ariaLabel?:string}} spec
 * @returns {HTMLButtonElement}
 */
export function button(spec) {
  const node = h('button.adw-button', {
    type: 'button',
    text: spec.label,
    disabled: spec.disabled === true,
  });
  if (spec.ariaLabel) node.setAttribute('aria-label', spec.ariaLabel);
  if (spec.style) node.classList.add(`adw-button--${spec.style}`);
  node.addEventListener('click', spec.onClick);
  return node;
}

/**
 * @param {{title:string, subtitle?:string, label:string, onClick:()=>void,
 *          style?:string, keywords?:string, disabled?:boolean, icon?:Node}} spec
 * @returns {HTMLElement}
 */
export function buttonRow(spec) {
  return actionRow({
    ...spec,
    suffix: button({ label: spec.label, style: spec.style, onClick: spec.onClick, disabled: spec.disabled }),
  });
}

/**
 * A read-only key/value row, as used by the About page.
 * @param {string} title
 * @param {string} value
 * @param {{keywords?:string, selectable?:boolean}} [opts]
 * @returns {HTMLElement}
 */
export function infoRow(title, value, opts = {}) {
  const valueNode = h('span.adw-row__value', { text: value });
  if (opts.selectable !== false) valueNode.classList.add('is-selectable');
  return actionRow({ title, keywords: opts.keywords, class: 'adw-row--info', suffix: valueNode });
}

/**
 * A coloured status banner (used for the API-key security warning).
 * @param {{title:string, body:string, style?:'warning'|'error'|'info'|'success', icon?:string}} spec
 * @returns {HTMLElement}
 */
export function banner(spec) {
  const node = h('div.adw-banner', {});
  node.classList.add(`adw-banner--${spec.style || 'info'}`);
  node.appendChild(h('span.adw-banner__icon', { 'aria-hidden': 'true', text: spec.icon || '!' }));
  const body = h('div.adw-banner__body', {}, h('strong.adw-banner__title', { text: spec.title }));
  for (const line of String(spec.body).split('\n')) {
    body.appendChild(h('p.adw-banner__text', { text: line }));
  }
  node.appendChild(body);
  return node;
}

/**
 * A mutually exclusive set of rows with a check mark on the active one —
 * libadwaita's usual stand-in for a radio group inside a preference list.
 *
 * @param {{options:{value:string, title:string, subtitle?:string}[], value:string,
 *          onChange:(v:string)=>void, keywords?:string}} spec
 * @returns {HTMLElement[]}
 */
export function radioRows(spec) {
  const rows = [];
  const byValue = new Map();

  for (const option of spec.options) {
    const check = h('span.adw-check', { 'aria-hidden': 'true', text: '✓' });
    const row = actionRow({
      title: option.title,
      subtitle: option.subtitle,
      keywords: spec.keywords,
      class: 'adw-row--radio',
      suffix: check,
    });
    row.setAttribute('role', 'radio');
    row.tabIndex = 0;
    row.setAttribute('aria-checked', option.value === spec.value ? 'true' : 'false');
    row.classList.toggle('is-selected', option.value === spec.value);

    const activate = () => {
      for (const [value, node] of byValue) {
        const selected = value === option.value;
        node.classList.toggle('is-selected', selected);
        node.setAttribute('aria-checked', selected ? 'true' : 'false');
      }
      spec.onChange(option.value);
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      }
    });

    byValue.set(option.value, row);
    rows.push(row);
  }

  return rows;
}

/**
 * A grid of selectable tiles — used for the style chooser, the accent swatches
 * and the wallpaper picker.
 *
 * @param {{items:{id:string, label?:string, title?:string, render:()=>Node}[],
 *          value:string, onChange:(id:string)=>void, columns?:number,
 *          class?:string, ariaLabel?:string}} spec
 * @returns {HTMLElement}
 */
export function tileGrid(spec) {
  const grid = h('div.adw-tiles', { role: 'radiogroup', 'aria-label': spec.ariaLabel || 'Choose' });
  if (spec.class) {
    for (const cls of spec.class.split(/\s+/).filter(Boolean)) grid.classList.add(cls);
  }
  if (spec.columns) grid.style.setProperty('--tile-columns', String(spec.columns));

  const buttons = new Map();
  for (const item of spec.items) {
    const tile = h('button.adw-tile', {
      type: 'button',
      role: 'radio',
      'aria-checked': item.id === spec.value ? 'true' : 'false',
      title: item.title || item.label || item.id,
      'aria-label': item.title || item.label || item.id,
    });
    tile.appendChild(h('span.adw-tile__preview', {}, item.render()));
    if (item.label) tile.appendChild(h('span.adw-tile__label', { text: item.label }));
    tile.classList.toggle('is-selected', item.id === spec.value);
    tile.addEventListener('click', () => {
      for (const [id, node] of buttons) {
        const selected = id === item.id;
        node.classList.toggle('is-selected', selected);
        node.setAttribute('aria-checked', selected ? 'true' : 'false');
      }
      spec.onChange(item.id);
    });
    buttons.set(item.id, tile);
    grid.appendChild(tile);
  }

  return grid;
}
