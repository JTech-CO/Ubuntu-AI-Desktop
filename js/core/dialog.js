/**
 * js/core/dialog.js — Adwaita modal dialogs (ARCHITECTURE §12).
 *
 * Reproduces the GNOME 46 AlertDialog: dimmed backdrop, rounded card, centred
 * heading and body, and a full-width button row whose entries are separated by
 * hairlines, with `suggested` and `destructive` accents.
 *
 * All text is inserted with `textContent`.
 */

import { h } from './dom.js';

/** Dialogs currently on screen, innermost last. */
const stack = [];

function closeTop(result) {
  const top = stack[stack.length - 1];
  if (top) top.finish(result);
}

function onKeyDown(ev) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    top.finish(top.cancelValue);
    return;
  }
  if (ev.key === 'Tab') {
    const focusable = Array.from(
      top.card.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
}

/**
 * Core dialog builder shared by alert/confirm/prompt.
 * @param {{title:string, body?:string, buttons:object[], cancelValue:any,
 *          entry?:{value?:string, placeholder?:string, password?:boolean},
 *          defaultIndex?:number}} spec
 * @returns {Promise<any>}
 */
function openDialog(spec) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;

    const heading = h('h2.dialog__heading', { text: spec.title === undefined ? '' : String(spec.title) });
    const children = [heading];
    if (spec.body) children.push(h('p.dialog__body', { text: String(spec.body) }));

    let input = null;
    if (spec.entry) {
      input = h('input.dialog__entry', {
        type: spec.entry.password ? 'password' : 'text',
        value: spec.entry.value === undefined ? '' : String(spec.entry.value),
        placeholder: spec.entry.placeholder === undefined ? '' : String(spec.entry.placeholder),
        autocomplete: spec.entry.password ? 'current-password' : 'off',
        spellcheck: 'false',
      });
      children.push(h('div.dialog__field', {}, input));
    }

    const actions = h('div.dialog__actions');
    const card = h(
      'div.dialog',
      { role: 'dialog', 'aria-modal': 'true' },
      h('div.dialog__content', {}, ...children),
      actions,
    );
    const backdrop = h('div.dialog-backdrop', {}, card);

    const record = {
      card,
      backdrop,
      cancelValue: spec.cancelValue,
      finish(value) {
        if (record.done) return;
        record.done = true;
        const idx = stack.indexOf(record);
        if (idx >= 0) stack.splice(idx, 1);
        if (stack.length === 0) document.removeEventListener('keydown', onKeyDown, true);
        backdrop.classList.remove('dialog-backdrop--in');
        backdrop.classList.add('dialog-backdrop--out');
        setTimeout(() => {
          backdrop.remove();
          if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
            previousFocus.focus();
          }
        }, 160);
        resolve(value);
      },
      done: false,
    };

    const valueOf = (button) => (typeof button.value === 'function' ? button.value(card) : button.value);

    let defaultButton = null;
    spec.buttons.forEach((button, index) => {
      const classes = ['dialog__button'];
      if (button.style === 'suggested') classes.push('dialog__button--suggested');
      if (button.style === 'destructive') classes.push('dialog__button--destructive');
      const node = h('button', {
        class: classes,
        type: 'button',
        text: String(button.label),
      });
      node.addEventListener('click', () => record.finish(valueOf(button)));
      actions.appendChild(node);
      if (index === (spec.defaultIndex === undefined ? spec.buttons.length - 1 : spec.defaultIndex)) {
        defaultButton = node;
      }
    });

    backdrop.addEventListener('mousedown', (ev) => {
      if (ev.target === backdrop) record.finish(record.cancelValue);
    });

    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const accept = spec.buttons.find((b) => b.style === 'suggested') || spec.buttons[spec.buttons.length - 1];
          record.finish(valueOf(accept));
        }
      });
    }

    document.body.appendChild(backdrop);
    if (stack.length === 0) document.addEventListener('keydown', onKeyDown, true);
    stack.push(record);

    void backdrop.offsetHeight;
    backdrop.classList.add('dialog-backdrop--in');

    if (input) {
      input.focus();
      input.select();
    } else if (defaultButton) {
      defaultButton.focus();
    }
  });
}

export const dialog = {
  /**
   * @param {{title:string, body?:string, okLabel?:string}} spec
   * @returns {Promise<void>}
   */
  alert({ title, body = '', okLabel = 'OK' } = {}) {
    return openDialog({
      title,
      body,
      cancelValue: undefined,
      buttons: [{ label: okLabel, style: 'suggested', value: undefined }],
    }).then(() => undefined);
  },

  /**
   * @param {{title:string, body?:string, okLabel?:string, cancelLabel?:string, destructive?:boolean}} spec
   * @returns {Promise<boolean>}
   */
  confirm({ title, body = '', okLabel = 'OK', cancelLabel = 'Cancel', destructive = false } = {}) {
    return openDialog({
      title,
      body,
      cancelValue: false,
      buttons: [
        { label: cancelLabel, style: '', value: false },
        { label: okLabel, style: destructive ? 'destructive' : 'suggested', value: true },
      ],
    });
  },

  /**
   * @param {{title:string, body?:string, value?:string, placeholder?:string,
   *          password?:boolean, okLabel?:string, cancelLabel?:string}} spec
   * @returns {Promise<string|null>} the entered text, or null when cancelled
   */
  prompt({
    title,
    body = '',
    value = '',
    placeholder = '',
    password = false,
    okLabel = 'OK',
    cancelLabel = 'Cancel',
  } = {}) {
    return openDialog({
      title,
      body,
      cancelValue: null,
      entry: { value, placeholder, password },
      buttons: [
        { label: cancelLabel, style: '', value: null },
        {
          label: okLabel,
          style: 'suggested',
          value: (card) => {
            const field = card.querySelector('.dialog__entry');
            return field ? field.value : '';
          },
        },
      ],
    });
  },

  /** @returns {boolean} true while any dialog is on screen */
  isOpen() {
    return stack.length > 0;
  },

  /** Close the topmost dialog with its cancel value. */
  closeTop() {
    closeTop(stack.length ? stack[stack.length - 1].cancelValue : undefined);
  },
};
