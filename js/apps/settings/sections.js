/**
 * js/apps/settings/sections.js — the GNOME Settings section registry.
 *
 * Holds the sidebar order (ARCHITECTURE §18) and exposes the lookup and
 * search helpers `index.js` routes with. Each section is
 * `{ id, title, icon, keywords, build() -> HTMLElement }`; `build()` is called
 * fresh every time a panel is shown so its controls always reflect the current
 * value of every setting.
 */

import {
  appearanceSection,
  backgroundSection,
  displaysSection,
  notificationsSection,
  searchSection,
  multitaskingSection,
} from './sections-personal.js';
import { soundSection, powerSection, dateTimeSection } from './sections-system.js';
import { usersSection, keyboardSection, aboutSection } from './sections-about.js';
import { wifiSection, networkSection, bluetoothSection } from './sections-network.js';
import { aiSection } from './sections-ai.js';

/**
 * The sidebar, in GNOME 46's order. `group` inserts a separator heading.
 * @type {{id:string, title:string, icon:() => Node, keywords:string,
 *         group?:string, build:() => HTMLElement}[]}
 */
export const SECTIONS = Object.freeze([
  { ...wifiSection, group: 'Network' },
  networkSection,
  bluetoothSection,

  { ...backgroundSection, group: 'Personalisation' },
  appearanceSection,
  notificationsSection,
  searchSection,
  multitaskingSection,

  { ...soundSection, group: 'Hardware' },
  powerSection,
  displaysSection,
  keyboardSection,

  { ...usersSection, group: 'System' },
  dateTimeSection,
  aboutSection,

  { ...aiSection, group: 'Assistant' },
]);

/** Section shown when nothing else is requested. */
export const DEFAULT_SECTION = 'appearance';

/**
 * @param {string} id
 * @returns {{id:string, title:string, icon:() => Node, keywords:string, build:() => HTMLElement}|null}
 */
export function getSection(id) {
  return SECTIONS.find((section) => section.id === id) || null;
}

/**
 * Resolve a deep-link argument. Accepts an id, a title, or a familiar alias
 * ("apikey", "theme", "wallpaper", …) so `wm.open('settings', { section })`
 * is forgiving.
 *
 * @param {string} requested
 * @returns {string} a valid section id
 */
export function resolveSection(requested) {
  if (typeof requested !== 'string' || requested.trim() === '') return DEFAULT_SECTION;
  const needle = requested.trim().toLowerCase();

  const direct = SECTIONS.find((section) => section.id === needle);
  if (direct) return direct.id;

  const aliases = new Map([
    ['apikey', 'ai'],
    ['api-key', 'ai'],
    ['gemini', 'ai'],
    ['assistant', 'ai'],
    ['theme', 'appearance'],
    ['accent', 'appearance'],
    ['dock', 'appearance'],
    ['wallpaper', 'background'],
    ['desktop', 'background'],
    ['shortcuts', 'keyboard'],
    ['device', 'about'],
    ['system', 'about'],
    ['audio', 'sound'],
    ['battery', 'power'],
    ['monitor', 'displays'],
    ['screen', 'displays'],
    ['time', 'datetime'],
    ['date', 'datetime'],
    ['account', 'users'],
    ['wi-fi', 'wifi'],
    ['wireless', 'wifi'],
  ]);
  if (aliases.has(needle)) return aliases.get(needle);

  const byTitle = SECTIONS.find((section) => section.title.toLowerCase() === needle);
  if (byTitle) return byTitle.id;

  const byKeyword = SECTIONS.find((section) => section.keywords.includes(needle));
  if (byKeyword) return byKeyword.id;

  return DEFAULT_SECTION;
}

/**
 * Filter the sidebar for the search entry.
 * @param {string} query
 * @returns {string[]} matching section ids, in sidebar order
 */
export function searchSections(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle === '') return SECTIONS.map((section) => section.id);
  const terms = needle.split(/\s+/).filter(Boolean);
  return SECTIONS.filter((section) => {
    const haystack = `${section.title} ${section.keywords}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).map((section) => section.id);
}
