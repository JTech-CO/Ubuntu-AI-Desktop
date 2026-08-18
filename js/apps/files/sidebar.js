/**
 * js/apps/files/sidebar.js — the Nautilus places sidebar.
 *
 * Home, the XDG user folders, Trash and "Other Locations", drawn as rounded
 * selection pills. Every row is a drop target: dropping a selection on a place
 * moves it there (or into the Trash), with the accent-tinted highlight Nautilus
 * shows while hovering.
 */

import { h, clear } from '../../core/dom.js';
import { symbolic } from './icons.js';
import { DRAG_TYPE } from './view.js';

/**
 * @param {{
 *   places: {id:string, label:string, icon:string, path:string}[],
 *   onActivate?: (place: object) => void,
 *   onMenu?: (place: object, x: number, y: number) => void,
 *   onDrop?: (place: object, paths: string[], ev: DragEvent) => void,
 *   separatorBefore?: string[] ids that get a separator drawn above them,
 * }} opts
 * @returns {{element: HTMLElement, setActive: (location: string) => void}}
 */
export function createSidebar(opts) {
  const places = Array.isArray(opts.places) ? opts.places : [];
  const separatorBefore = new Set(opts.separatorBefore || []);
  const rows = new Map();
  const element = h('div.files-sidebar', { role: 'navigation', 'aria-label': 'Places' });
  const list = h('div.files-sidebar__list');

  const call = (name, ...args) => {
    const fn = opts[name];
    if (typeof fn === 'function') fn(...args);
  };

  function dragPaths(ev) {
    try {
      const raw = JSON.parse(ev.dataTransfer.getData(DRAG_TYPE));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  for (const place of places) {
    if (separatorBefore.has(place.id)) list.appendChild(h('div.files-sidebar__separator'));

    const row = h('button.files-place', { type: 'button', dataset: { place: place.id } });
    row.appendChild(h('span.files-place__icon', {}, symbolic(place.icon, 16)));
    row.appendChild(h('span.files-place__label', { text: place.label }));

    row.addEventListener('click', () => call('onActivate', place));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      call('onMenu', place, ev.clientX, ev.clientY);
    });
    row.addEventListener('dragover', (ev) => {
      if (!place.droppable) return;
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes(DRAG_TYPE)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = place.id !== 'trash' && ev.ctrlKey ? 'copy' : 'move';
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', (ev) => {
      row.classList.remove('is-drop-target');
      if (!place.droppable) return;
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes(DRAG_TYPE)) return;
      ev.preventDefault();
      const paths = dragPaths(ev);
      if (paths.length === 0) return;
      call('onDrop', place, paths, ev);
    });

    rows.set(place.id, row);
    list.appendChild(row);
  }
  element.appendChild(list);

  return {
    element,

    /**
     * Highlight the row matching a location, if any.
     * @param {string} location
     */
    setActive(location) {
      for (const place of places) {
        const row = rows.get(place.id);
        if (row) row.classList.toggle('is-active', place.path === location);
      }
    },
  };
}
