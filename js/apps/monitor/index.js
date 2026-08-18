/**
 * js/apps/monitor/index.js — GNOME System Monitor (ARCHITECTURE §16, §18).
 *
 * Three tabs behind an Adwaita view switcher: Processes, Resources and
 * File Systems. A single one-second interval per window drives every tab, so
 * the charts keep a continuous one-minute history even while another tab is
 * on screen; only the visible tab repaints.
 */

import { h, svg, clear } from '../../core/dom.js';
import { createProcessesTab } from './processes.js';
import { createResourcesTab } from './resources.js';
import { createFileSystemsTab } from './filesystems.js';

/** Refresh cadence, matching System Monitor's default "Update interval". */
const REFRESH_MS = 1000;

const TABS = [
  { id: 'processes', label: 'Processes', create: createProcessesTab },
  { id: 'resources', label: 'Resources', create: createResourcesTab },
  { id: 'filesystems', label: 'File Systems', create: createFileSystemsTab },
];

/** @type {Map<string, {tabs:Map<string,object>, timer:number, active:string, buttons:Map<string,HTMLElement>, body:HTMLElement}>} */
const instances = new Map();

function monitorIcon() {
  return svg(
    [
      'M3 17.5l4-6 3.5 3.5L14 8l3 5 4-6',
      'M3 21h18',
    ],
    { size: 24, strokeWidth: 1.8, class: 'app-icon app-icon--monitor' },
  );
}

export default {
  id: 'monitor',
  name: 'System Monitor',
  genericName: 'Process Viewer',
  icon: monitorIcon,
  pinned: false,
  singleton: true,
  width: 940,
  height: 640,
  minWidth: 640,
  minHeight: 420,
  resizable: true,
  themeClass: 'app-monitor',
  darkChrome: false,

  /**
   * @param {HTMLElement} root window content element
   * @param {{instanceId:string, args:object, setTitle:(t:string)=>void}} ctx
   */
  mount(root, ctx) {
    clear(root);

    const switcher = h('div.mon-switcher', { role: 'tablist', 'aria-label': 'System Monitor views' });
    const body = h('div.mon-body');
    const buttons = new Map();
    const tabs = new Map();

    const state = { tabs, timer: 0, active: '', buttons, body };
    instances.set(ctx.instanceId, state);

    function activate(id) {
      if (state.active === id) return;
      state.active = id;
      for (const [key, button] of buttons) {
        const selected = key === id;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
        button.tabIndex = selected ? 0 : -1;
      }
      clear(body);
      const tab = tabs.get(id);
      if (!tab) return;
      body.appendChild(tab.el);
      tab.show();
      if (typeof ctx.setTitle === 'function') {
        const def = TABS.find((t) => t.id === id);
        ctx.setTitle(def ? `System Monitor — ${def.label}` : 'System Monitor');
      }
    }

    for (const def of TABS) {
      const tab = def.create();
      tabs.set(def.id, tab);

      const button = h('button.mon-switcher__button', {
        type: 'button',
        role: 'tab',
        text: def.label,
        'aria-selected': 'false',
        tabindex: '-1',
      });
      button.addEventListener('click', () => activate(def.id));
      button.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const order = TABS.map((t) => t.id);
        const index = order.indexOf(state.active);
        const next = order[(index + (ev.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
        activate(next);
        const target = buttons.get(next);
        if (target) target.focus();
      });
      buttons.set(def.id, button);
      switcher.appendChild(button);
    }

    root.appendChild(h('div.mon-headerbar', {}, switcher));
    root.appendChild(body);

    const requested = ctx.args && typeof ctx.args.tab === 'string' ? ctx.args.tab : 'processes';
    activate(TABS.some((t) => t.id === requested) ? requested : 'processes');

    // One timer per window. Every tab is stepped so histories stay continuous;
    // hidden canvases skip their repaint inside the chart itself.
    state.timer = window.setInterval(() => {
      for (const tab of tabs.values()) tab.update();
    }, REFRESH_MS);
  },

  onFocus(ctx) {
    const state = instances.get(ctx.instanceId);
    if (!state) return;
    const tab = state.tabs.get(state.active);
    if (tab) tab.show();
  },

  onResize(ctx) {
    const state = instances.get(ctx.instanceId);
    if (!state) return;
    const tab = state.tabs.get(state.active);
    if (tab) tab.show();
  },

  onClose(ctx) {
    const state = instances.get(ctx.instanceId);
    if (!state) return true;
    if (state.timer) window.clearInterval(state.timer);
    for (const tab of state.tabs.values()) tab.destroy();
    state.tabs.clear();
    instances.delete(ctx.instanceId);
    return true;
  },
};
