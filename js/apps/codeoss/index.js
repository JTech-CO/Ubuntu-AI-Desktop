/**
 * js/apps/codeoss/index.js — Code-OSS (ARCHITECTURE §16, §18).
 *
 * A VS Code Dark+ workbench over the virtual filesystem: activity bar, explorer
 * tree, tabbed editors with real tokenizer-based highlighting, an integrated
 * terminal that runs the actual shell engine, and a Gemini agent panel.
 *
 * It is deliberately honest about being a simulation — nothing here pretends to
 * be a real compiler, debugger, extension host or source-control provider.
 */

import { h, svg, clear, on } from '../../core/dom.js';
import * as path from '../../core/path.js';
import { fs, FsError } from '../../core/fs.js';
import { bus } from '../../core/bus.js';
import { dialog } from '../../core/dialog.js';
import { notify } from '../../core/notify.js';
import { createTree, fileIcon } from './tree.js';
import { createCodeEditor } from './code-editor.js';
import { createAgentPanel } from './agent-panel.js';
import { createPanel } from './panel.js';
import { detectLanguage, languageLabel } from './highlight.js';

const WORKSPACE = '/home/ubuntu/Projects';

const ICONS = {
  explorer: [
    'M9.5 3.5h5l4 4v9.5a1.2 1.2 0 0 1-1.2 1.2H9.5a1.2 1.2 0 0 1-1.2-1.2V4.7A1.2 1.2 0 0 1 9.5 3.5z',
    'M14.5 3.5v4h4',
    'M5.7 7.4v11.4a1.2 1.2 0 0 0 1.2 1.2h8.4',
  ],
  search: ['M10.8 4.2a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2z', 'M15.6 15.6l4.4 4.4'],
  scm: [
    'M7 4.4a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
    'M7 15.2a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
    'M17 4.4a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
    'M7 8.8v6.4',
    'M17 8.8v1.8a3.4 3.4 0 0 1-3.4 3.4H9.6',
  ],
  run: ['M7 4.6l11.5 7.4L7 19.4z'],
  extensions: ['M4 4.4h6.6V11H4z', 'M13.4 4.4H20V11h-6.6z', 'M4 13.4h6.6V20H4z', 'M16.7 13.4v6.6', 'M13.4 16.7h6.6'],
  agent: ['M12 3.2l2.3 6.5 6.5 2.3-6.5 2.3L12 20.8l-2.3-6.5L3.2 12l6.5-2.3z'],
};

const VIEWS = [
  { id: 'explorer', label: 'Explorer', title: 'EXPLORER', accel: 'Ctrl+Shift+E' },
  { id: 'search', label: 'Search', title: 'SEARCH', accel: 'Ctrl+Shift+F' },
  { id: 'scm', label: 'Source Control', title: 'SOURCE CONTROL', accel: 'Ctrl+Shift+G' },
  { id: 'run', label: 'Run and Debug', title: 'RUN AND DEBUG', accel: 'Ctrl+Shift+D' },
  { id: 'extensions', label: 'Extensions', title: 'EXTENSIONS', accel: 'Ctrl+Shift+X' },
  { id: 'agent', label: 'Gemini Agent', title: 'GEMINI AGENT', accel: '' },
];

/** Extensions the workspace search will not try to read as text. */
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'iso', 'zip', 'gz', 'pdf', 'woff', 'woff2', 'class', 'pyc', 'o', 'so']);

/** Instance state, keyed by window instance id. */
const sessions = new Map();

function isTextFile(p) {
  const ext = path.extname(p).replace('.', '').toLowerCase();
  return !BINARY_EXT.has(ext);
}

/* ------------------------------------------------------------------ *
 * mount
 * ------------------------------------------------------------------ */

function mount(root, ctx) {
  const state = {
    docs: [],
    activeIndex: -1,
    view: 'explorer',
    sidebarVisible: true,
    forceClose: false,
    disposers: [],
  };
  sessions.set(ctx.instanceId, state);

  /* --- chrome ---------------------------------------------------- */

  const activityBar = h('div.activity-bar', { role: 'tablist' });
  const sidebarTitle = h('div.sidebar__title');
  const sidebarViews = h('div.sidebar__views');
  const sidebar = h('div.sidebar', {}, h('div.sidebar__header', {}, sidebarTitle), sidebarViews);
  const sidebarSplit = h('div.split.split--v', { title: 'Resize the side bar' });

  const tabsRow = h('div.tabs', { role: 'tablist' });
  const breadcrumbs = h('div.breadcrumbs');
  const editorHost = h('div.editor-host');
  const welcome = h('div.welcome');
  const panelSplit = h('div.split.split--h', { title: 'Resize the panel' });

  const main = h('div.workbench__main', {}, tabsRow, breadcrumbs, editorHost, panelSplit);
  const body = h('div.workbench__body', {}, activityBar, sidebar, sidebarSplit, main);

  const statusLeft = h('div.statusbar__left');
  const statusRight = h('div.statusbar__right');
  const statusBar = h('div.statusbar', {}, statusLeft, statusRight);

  const workbench = h('div.codeoss', {}, body, statusBar);
  root.appendChild(workbench);

  /* --- welcome screen -------------------------------------------- */

  welcome.appendChild(h('h1.welcome__title', { text: 'Code - OSS' }));
  welcome.appendChild(h('p.welcome__sub', { text: 'Editing evolved — on a simulated Ubuntu desktop' }));
  const welcomeList = h('ul.welcome__keys');
  for (const [keys, label] of [
    ['Ctrl+P', 'Go to File'],
    ['Ctrl+Shift+E', 'Explorer'],
    ['Ctrl+`', 'Integrated Terminal'],
    ['Ctrl+S', 'Save to the virtual filesystem'],
    ['F5', 'Run the current file'],
  ]) {
    const item = h('li');
    item.appendChild(h('kbd', { text: keys }));
    item.appendChild(h('span', { text: label }));
    welcomeList.appendChild(item);
  }
  welcome.appendChild(welcomeList);
  welcome.appendChild(
    h('p.welcome__note', {
      text:
        'This workbench is a simulation. The editor, filesystem and terminal are real code ' +
        'running in your browser; there is no extension host, no debugger and no compiler ' +
        'behind it. Run uses Gemini for interpreted languages and says so.',
    }),
  );

  /* --- status bar items --------------------------------------------
     Declared before the editor because createCodeEditor() fires onCursor
     synchronously while it builds its first frame. Referencing these from
     that callback any later would hit the temporal dead zone. They are
     appended to the status bar further down, once `panel` exists. */

  const cursorItem = h('span.statusbar__item', { text: 'Ln 1, Col 1' });
  const selectionItem = h('span.statusbar__item', { hidden: true });
  const indentItem = h('span.statusbar__item', { text: 'Spaces: 4' });
  const encodingItem = h('span.statusbar__item', { text: 'UTF-8' });
  const eolItem = h('span.statusbar__item', { text: 'LF' });
  const languageItem = h('span.statusbar__item', { text: 'Plain Text' });

  /* --- editor ----------------------------------------------------- */

  const editor = createCodeEditor({
    onChange(value) {
      const doc = activeDoc();
      if (!doc) return;
      doc.content = value;
      const dirty = value !== doc.saved;
      if (dirty !== doc.dirty) {
        doc.dirty = dirty;
        renderTabs();
        updateTitle();
      }
      scheduleProblemCheck();
    },
    onCursor(info) {
      cursorItem.textContent = `Ln ${info.line}, Col ${info.column}`;
      selectionItem.hidden = info.selectionLength === 0;
      if (info.selectionLength > 0) selectionItem.textContent = `(${info.selectionLength} selected)`;
    },
    onSave() {
      void saveActive();
    },
    onCommand(key) {
      if (key === 'p') openQuickOpen();
      else if (key === 'b') toggleSidebar();
      else if (key === 'j' || key === '`') panel.toggle();
      else if (key === 'f' || key === 'h') openSearchWithSelection();
    },
  });
  editorHost.appendChild(editor.element);
  editorHost.appendChild(welcome);

  /* --- bottom panel ------------------------------------------------ */

  // `let` rather than `const`: createPanel() invokes onVisibility while it is
  // still constructing, so the callback has to tolerate `panel` not being
  // assigned yet. With `const` that read would throw from the temporal dead
  // zone and take the whole mount() down.
  let panel;
  panel = createPanel({
    getActiveDoc: () => activeDoc(),
    onOpenLocation(p, line, column) {
      void openFile(p).then(() => editor.goToLine(line, column));
    },
    onVisibility() {
      if (!panel) return;
      panelSplit.hidden = !panel.isVisible();
    },
  });
  main.appendChild(panel.element);
  panelSplit.hidden = true;

  /* --- status bar --------------------------------------------------- */

  const problemsItem = h('button.statusbar__item.statusbar__item--button', { type: 'button', title: 'No problems' });
  problemsItem.appendChild(h('span', { text: '✕ 0  ⚠ 0' }));
  problemsItem.addEventListener('click', () => panel.show('problems'));

  const simulationItem = h('span.statusbar__item.statusbar__item--remote', {
    text: '⧉ Simulated',
    title: 'Code-OSS here is a browser simulation: real editor and filesystem, no extension host or compiler.',
  });

  statusLeft.appendChild(simulationItem);
  statusLeft.appendChild(problemsItem);

  statusRight.appendChild(cursorItem);
  statusRight.appendChild(selectionItem);
  statusRight.appendChild(indentItem);
  statusRight.appendChild(encodingItem);
  statusRight.appendChild(eolItem);
  statusRight.appendChild(languageItem);
  statusRight.appendChild(h('span.statusbar__item', { text: '🔔' }));

  function toast(message) {
    notify.show({ app: 'Code - OSS', title: 'Code - OSS', body: String(message), timeout: 5000 });
  }

  /* --- documents ---------------------------------------------------- */

  function activeDoc() {
    return state.activeIndex >= 0 ? state.docs[state.activeIndex] : null;
  }

  function updateTitle() {
    const doc = activeDoc();
    if (!doc) {
      ctx.setTitle('Welcome — Code - OSS');
      return;
    }
    const name = doc.path ? path.basename(doc.path) : doc.name;
    const project = doc.path && doc.path.startsWith(`${WORKSPACE}/`)
      ? path.split(path.relative(WORKSPACE, doc.path))[0]
      : 'Projects';
    ctx.setTitle(`${doc.dirty ? '● ' : ''}${name} — ${project} — Code - OSS`);
  }

  function renderBreadcrumbs() {
    clear(breadcrumbs);
    const doc = activeDoc();
    if (!doc) {
      breadcrumbs.hidden = true;
      return;
    }
    breadcrumbs.hidden = false;
    const target = doc.path || doc.name;
    const segments = doc.path && doc.path.startsWith(WORKSPACE)
      ? [path.basename(WORKSPACE)].concat(path.split(path.relative(WORKSPACE, doc.path)))
      : path.split(target);

    segments.forEach((segment, index) => {
      if (index > 0) breadcrumbs.appendChild(h('span.breadcrumbs__sep', { text: '›' }));
      breadcrumbs.appendChild(h('span.breadcrumbs__item', { text: segment }));
    });
  }

  function renderTabs() {
    clear(tabsRow);
    state.docs.forEach((doc, index) => {
      const tab = h('div.tab', { role: 'tab', title: doc.path || doc.name, dataset: { index: String(index) } });
      if (index === state.activeIndex) tab.classList.add('is-active');
      if (doc.dirty) tab.classList.add('is-dirty');

      tab.appendChild(fileIcon(doc.path ? path.basename(doc.path) : doc.name));
      tab.appendChild(h('span.tab__label', { text: doc.path ? path.basename(doc.path) : doc.name }));

      const close = h('button.tab__close', { type: 'button', title: 'Close (Ctrl+W)', 'aria-label': 'Close' });
      close.appendChild(h('span.tab__dot', { text: '●' }));
      close.appendChild(h('span.tab__x', { text: '✕' }));
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void closeTab(index);
      });
      tab.appendChild(close);

      tab.addEventListener('mousedown', (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          void closeTab(index);
          return;
        }
        if (ev.button === 0) activate(index);
      });
      tabsRow.appendChild(tab);
    });

    welcome.hidden = state.docs.length > 0;
    editor.element.hidden = state.docs.length === 0;
    tabsRow.hidden = state.docs.length === 0;
  }

  function activate(index) {
    if (index < 0 || index >= state.docs.length) {
      state.activeIndex = -1;
      renderTabs();
      renderBreadcrumbs();
      updateTitle();
      languageItem.textContent = 'Plain Text';
      panel.updateProblems(null);
      return;
    }
    const previous = activeDoc();
    if (previous) previous.cursor = editor.getCursor();

    state.activeIndex = index;
    const doc = state.docs[index];
    editor.setDocument({ path: doc.path, content: doc.content, language: doc.language });
    languageItem.textContent = languageLabel(doc.language);
    renderTabs();
    renderBreadcrumbs();
    updateTitle();
    refreshProblemCount();
    if (doc.cursor) editor.goToLine(doc.cursor.line, doc.cursor.column);
    if (doc.path) tree.reveal(doc.path);
    editor.focus();
  }

  let problemTimer = 0;

  function refreshProblemCount() {
    const doc = activeDoc();
    const list = panel.updateProblems(doc);
    const errors = list.filter((problem) => problem.severity === 'error').length;
    const warnings = list.length - errors;
    problemsItem.firstChild.textContent = `✕ ${errors}  ⚠ ${warnings}`;
    problemsItem.title = list.length === 0 ? 'No problems' : `${list.length} problem${list.length === 1 ? '' : 's'}`;
  }

  function scheduleProblemCheck() {
    if (problemTimer) window.clearTimeout(problemTimer);
    problemTimer = window.setTimeout(() => {
      problemTimer = 0;
      refreshProblemCount();
    }, 500);
  }

  async function openFile(target) {
    const p = fs.resolve(target);
    const existing = state.docs.findIndex((doc) => doc.path === p);
    if (existing >= 0) {
      activate(existing);
      return;
    }
    let content;
    try {
      if (fs.isDir(p)) return;
      content = fs.readFile(p);
    } catch (err) {
      const message = err instanceof FsError ? `${p}: ${err.message}` : (err && err.message) || String(err);
      toast(message);
      return;
    }
    state.docs.push({
      path: p,
      name: path.basename(p),
      content,
      saved: content,
      dirty: false,
      language: detectLanguage(p),
      cursor: null,
    });
    activate(state.docs.length - 1);
  }

  function newUntitled() {
    let n = 1;
    while (state.docs.some((doc) => !doc.path && doc.name === `Untitled-${n}`)) n += 1;
    state.docs.push({
      path: null,
      name: `Untitled-${n}`,
      content: '',
      saved: '',
      dirty: false,
      language: 'text',
      cursor: null,
    });
    activate(state.docs.length - 1);
  }

  async function saveActive() {
    const doc = activeDoc();
    if (!doc) return false;
    doc.content = editor.getValue();

    let target = doc.path;
    if (!target) {
      const answer = await dialog.prompt({
        title: 'Save As',
        body: 'Where should this file be written?',
        value: `${path.contract(WORKSPACE, fs.HOME)}/${doc.name}.txt`,
      });
      if (answer === null || answer.trim() === '') return false;
      target = fs.resolve(answer.trim());
    }

    try {
      fs.writeFile(target, doc.content);
    } catch (err) {
      const message = err instanceof FsError ? `${target}: ${err.message}` : (err && err.message) || String(err);
      await dialog.alert({ title: 'Unable to save', body: message });
      return false;
    }

    doc.path = target;
    doc.name = path.basename(target);
    doc.saved = doc.content;
    doc.dirty = false;
    doc.language = detectLanguage(target);
    editor.setLanguage(doc.language);
    languageItem.textContent = languageLabel(doc.language);
    renderTabs();
    renderBreadcrumbs();
    updateTitle();
    refreshProblemCount();
    tree.reveal(target);
    return true;
  }

  async function closeTab(index) {
    const doc = state.docs[index];
    if (!doc) return true;
    if (doc.dirty) {
      const discard = await dialog.confirm({
        title: `Do you want to save the changes you made to ${doc.path ? path.basename(doc.path) : doc.name}?`,
        body: "Your changes will be lost if you don't save them.",
        okLabel: "Don't Save",
        cancelLabel: 'Cancel',
        destructive: true,
      });
      if (!discard) return false;
    }
    state.docs.splice(index, 1);
    if (state.docs.length === 0) activate(-1);
    else activate(Math.min(index, state.docs.length - 1));
    return true;
  }

  /* --- side bar views ------------------------------------------------- */

  const tree = createTree({
    root: WORKSPACE,
    onOpenFile(p) {
      void openFile(p);
    },
    onError(message) {
      toast(message);
    },
  });

  const agent = createAgentPanel({
    getContext() {
      const doc = activeDoc();
      return {
        path: doc ? doc.path : null,
        language: doc ? doc.language : 'text',
        selection: doc ? editor.getSelectionText() : '',
        content: doc ? editor.getValue() : '',
      };
    },
    applyToEditor(code) {
      if (!activeDoc()) {
        newUntitled();
      }
      editor.insertText(code);
      editor.focus();
    },
    onNotice: toast,
  });

  // --- search view
  const searchInput = h('input.search__input', { type: 'search', placeholder: 'Search', spellcheck: 'false' });
  const searchCase = h('button.search__toggle', { type: 'button', text: 'Aa', title: 'Match Case' });
  const searchSummary = h('div.search__summary');
  const searchResults = h('div.search__results');
  const searchView = h(
    'div.view.view--search',
    {},
    h('div.search__row', {}, searchInput, searchCase),
    searchSummary,
    searchResults,
  );
  let searchCaseSensitive = false;
  let searchTimer = 0;

  searchCase.addEventListener('click', () => {
    searchCaseSensitive = !searchCaseSensitive;
    searchCase.classList.toggle('is-on', searchCaseSensitive);
    runSearch();
  });

  function runSearch() {
    const query = searchInput.value;
    clear(searchResults);
    if (query.trim() === '') {
      searchSummary.textContent = '';
      return;
    }
    const needle = searchCaseSensitive ? query : query.toLowerCase();
    let files = 0;
    let hits = 0;

    let paths;
    try {
      paths = fs.walk(WORKSPACE, { includeHidden: false });
    } catch {
      searchSummary.textContent = 'The workspace folder is missing.';
      return;
    }

    for (const p of paths) {
      if (hits >= 400) break;
      if (!fs.isFile(p) || !isTextFile(p)) continue;
      let content;
      try {
        content = fs.readFile(p);
      } catch {
        continue;
      }
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < 40; i += 1) {
        const haystack = searchCaseSensitive ? lines[i] : lines[i].toLowerCase();
        const at = haystack.indexOf(needle);
        if (at >= 0) matches.push({ line: i + 1, column: at + 1, text: lines[i] });
      }
      if (matches.length === 0) continue;
      files += 1;
      hits += matches.length;

      const fileRow = h('div.search__file');
      fileRow.appendChild(fileIcon(path.basename(p)));
      fileRow.appendChild(h('span.search__file-name', { text: path.basename(p) }));
      fileRow.appendChild(h('span.search__file-dir', { text: path.contract(path.dirname(p), fs.HOME) }));
      fileRow.appendChild(h('span.search__count', { text: String(matches.length) }));
      searchResults.appendChild(fileRow);

      for (const match of matches) {
        const row = h('button.search__hit', { type: 'button' });
        row.appendChild(h('span.search__hit-line', { text: String(match.line) }));
        row.appendChild(h('span.search__hit-text', { text: match.text.trim().slice(0, 160) }));
        row.addEventListener('click', () => {
          void openFile(p).then(() => editor.goToLine(match.line, match.column));
        });
        searchResults.appendChild(row);
      }
    }

    searchSummary.textContent = hits === 0
      ? 'No results found.'
      : `${hits} result${hits === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`;
  }

  searchInput.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 180);
  });
  searchInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') runSearch();
  });

  function openSearchWithSelection() {
    const selection = editor.getSelectionText();
    showView('search');
    if (selection && selection.indexOf('\n') < 0) searchInput.value = selection;
    searchInput.focus();
    searchInput.select();
    runSearch();
  }

  // --- source control view (honest)
  const scmView = h(
    'div.view.view--scm',
    {},
    h('p.view__empty', { text: 'No source control providers registered.' }),
    h('p.view__note', {
      text:
        'This desktop has no Git implementation. The Explorer and the integrated terminal ' +
        'both work against the same virtual filesystem, but nothing here tracks revisions.',
    }),
  );

  // --- run view (honest)
  const runButton = h('button.view__button', { type: 'button', text: 'Run Current File' });
  runButton.addEventListener('click', () => void runActive());
  const runView = h(
    'div.view.view--run',
    {},
    h('p.view__lead', { text: 'Run the file in the active editor.' }),
    runButton,
    h('p.view__note', {
      text:
        'Shell scripts really execute, line by line, through the same engine the Terminal app ' +
        'uses. Python, JavaScript, TypeScript, C, C++ and Java have no runtime here: Code-OSS ' +
        'asks Gemini to predict the output and labels the result as AI-simulated. Without an ' +
        'API key it tells you so rather than inventing output. There is no debugger, so no ' +
        'breakpoints, stepping or variable inspection.',
    }),
  );

  // --- extensions view (honest)
  const extensionsView = h('div.view.view--extensions');
  extensionsView.appendChild(
    h('p.view__note', {
      text:
        'There is no extension host in this simulation — nothing below is loaded or executed. ' +
        'The list shows what a comparable Ubuntu install of Code-OSS would typically carry.',
    }),
  );
  for (const ext of [
    { name: 'Python', publisher: 'ms-python', blurb: 'IntelliSense, linting, debugging' },
    { name: 'C/C++', publisher: 'ms-vscode', blurb: 'IntelliSense and debugging for C/C++' },
    { name: 'Markdown All in One', publisher: 'yzhang', blurb: 'Shortcuts, table of contents, preview' },
    { name: 'GitLens', publisher: 'eamodio', blurb: 'Supercharge Git in Code-OSS' },
    { name: 'Yaru Theme', publisher: 'ubuntu', blurb: 'Ubuntu colour theme' },
  ]) {
    const card = h('div.extension');
    card.appendChild(h('div.extension__icon', { text: ext.name.slice(0, 1) }));
    const meta = h('div.extension__meta');
    meta.appendChild(h('div.extension__name', { text: ext.name }));
    meta.appendChild(h('div.extension__blurb', { text: ext.blurb }));
    meta.appendChild(h('div.extension__pub', { text: ext.publisher }));
    card.appendChild(meta);
    extensionsView.appendChild(card);
  }

  const viewNodes = {
    explorer: tree.element,
    search: searchView,
    scm: scmView,
    run: runView,
    extensions: extensionsView,
    agent: agent.element,
  };
  for (const node of Object.values(viewNodes)) {
    node.hidden = true;
    sidebarViews.appendChild(node);
  }

  /**
   * Switch the side bar to a view.
   *
   * Clicking the activity-bar button of the view that is already showing
   * collapses the side bar, the way VS Code does. That is only right for a
   * user gesture — the initial render must not collapse anything, so mount()
   * passes `allowToggle: false`.
   *
   * @param {string} id
   * @param {{allowToggle?: boolean}} [opts]
   */
  function showView(id, { allowToggle = true } = {}) {
    if (!viewNodes[id]) return;
    if (allowToggle && state.view === id && state.sidebarVisible) {
      toggleSidebar();
      return;
    }
    state.view = id;
    state.sidebarVisible = true;
    sidebar.hidden = false;
    sidebarSplit.hidden = false;
    for (const [key, node] of Object.entries(viewNodes)) node.hidden = key !== id;
    const meta = VIEWS.find((v) => v.id === id);
    sidebarTitle.textContent = meta ? meta.title : '';
    for (const button of activityBar.querySelectorAll('.activity-bar__button')) {
      button.classList.toggle('is-active', button.dataset.view === id);
    }
    if (id === 'agent') agent.focusInput();
  }

  function toggleSidebar() {
    state.sidebarVisible = !state.sidebarVisible;
    sidebar.hidden = !state.sidebarVisible;
    sidebarSplit.hidden = !state.sidebarVisible;
    for (const button of activityBar.querySelectorAll('.activity-bar__button')) {
      button.classList.toggle('is-active', state.sidebarVisible && button.dataset.view === state.view);
    }
    editor.layout();
  }

  for (const view of VIEWS) {
    const button = h('button.activity-bar__button', {
      type: 'button',
      role: 'tab',
      dataset: { view: view.id },
      title: view.accel ? `${view.label} (${view.accel})` : view.label,
      'aria-label': view.label,
    });
    button.appendChild(svg(ICONS[view.id], { size: 24, strokeWidth: 1.4 }));
    button.addEventListener('click', () => showView(view.id));
    activityBar.appendChild(button);
  }

  /* --- run ------------------------------------------------------------ */

  async function runActive() {
    const doc = activeDoc();
    if (!doc) {
      toast('Open a file before running it.');
      return;
    }
    doc.content = editor.getValue();
    await panel.run({ path: doc.path, content: doc.content, language: doc.language });
  }

  /* --- quick open (Ctrl+P) --------------------------------------------- */

  const quickInput = h('input.quick__input', { type: 'text', placeholder: 'Search files by name', spellcheck: 'false' });
  const quickList = h('div.quick__list');
  const quick = h('div.quick', { hidden: true }, quickInput, quickList);
  workbench.appendChild(quick);
  let quickFiles = [];
  let quickIndex = 0;

  function renderQuick() {
    clear(quickList);
    const query = quickInput.value.trim().toLowerCase();
    const matches = quickFiles
      .filter((p) => (query === '' ? true : path.basename(p).toLowerCase().includes(query) || p.toLowerCase().includes(query)))
      .slice(0, 30);
    quickIndex = Math.min(quickIndex, Math.max(0, matches.length - 1));

    matches.forEach((p, index) => {
      const row = h('button.quick__row', { type: 'button' });
      if (index === quickIndex) row.classList.add('is-active');
      row.appendChild(fileIcon(path.basename(p)));
      row.appendChild(h('span.quick__name', { text: path.basename(p) }));
      row.appendChild(h('span.quick__dir', { text: path.contract(path.dirname(p), fs.HOME) }));
      row.addEventListener('click', () => {
        closeQuickOpen();
        void openFile(p);
      });
      quickList.appendChild(row);
    });

    if (matches.length === 0) quickList.appendChild(h('div.quick__empty', { text: 'No matching files' }));
    quick.dataset.count = String(matches.length);
  }

  function openQuickOpen() {
    try {
      quickFiles = fs.walk(WORKSPACE, { includeHidden: false }).filter((p) => fs.isFile(p));
    } catch {
      quickFiles = [];
    }
    quickIndex = 0;
    quickInput.value = '';
    quick.hidden = false;
    renderQuick();
    quickInput.focus();
  }

  function closeQuickOpen() {
    quick.hidden = true;
    editor.focus();
  }

  quickInput.addEventListener('input', () => {
    quickIndex = 0;
    renderQuick();
  });
  quickInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    const rows = quickList.querySelectorAll('.quick__row');
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeQuickOpen();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      quickIndex = Math.min(quickIndex + 1, Math.max(0, rows.length - 1));
      renderQuick();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      quickIndex = Math.max(quickIndex - 1, 0);
      renderQuick();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const row = rows[quickIndex];
      if (row) row.click();
    }
  });
  quickInput.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!quick.hidden && document.activeElement !== quickInput) closeQuickOpen();
    }, 120);
  });

  /* --- splitters -------------------------------------------------------- */

  function makeDrag(handle, apply) {
    const down = (ev) => {
      ev.preventDefault();
      const start = { x: ev.clientX, y: ev.clientY };
      const move = (moveEv) => apply(moveEv.clientX - start.x, moveEv.clientY - start.y, start);
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('is-dragging');
        editor.layout();
      };
      document.body.classList.add('is-dragging');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
    handle.addEventListener('mousedown', down);
  }

  makeDrag(sidebarSplit, (dx, dy, start) => {
    if (start.width === undefined) start.width = sidebar.getBoundingClientRect().width;
    const next = Math.max(170, Math.min(560, start.width + dx));
    sidebar.style.width = `${next}px`;
  });

  makeDrag(panelSplit, (dx, dy, start) => {
    if (start.height === undefined) start.height = panel.element.getBoundingClientRect().height;
    const next = Math.max(90, Math.min(root.clientHeight - 160, start.height - dy));
    panel.element.style.height = `${next}px`;
  });

  /* --- keyboard --------------------------------------------------------- */

  const offKeys = on(root, 'keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod) {
      if (ev.key === 'F5') {
        ev.preventDefault();
        void runActive();
      }
      return;
    }
    const key = ev.key.toLowerCase();

    if (ev.shiftKey) {
      const map = { e: 'explorer', f: 'search', g: 'scm', d: 'run', x: 'extensions', a: 'agent' };
      if (map[key]) {
        ev.preventDefault();
        ev.stopPropagation();
        showView(map[key]);
      }
      return;
    }

    if (key === 's') {
      ev.preventDefault();
      ev.stopPropagation();
      void saveActive();
    } else if (key === 'w') {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.activeIndex >= 0) void closeTab(state.activeIndex);
    } else if (key === 'n') {
      ev.preventDefault();
      ev.stopPropagation();
      newUntitled();
    } else if (key === 'p') {
      ev.preventDefault();
      ev.stopPropagation();
      openQuickOpen();
    } else if (key === 'b') {
      ev.preventDefault();
      ev.stopPropagation();
      toggleSidebar();
    } else if (key === '`' || key === 'j') {
      ev.preventDefault();
      ev.stopPropagation();
      panel.toggle();
    } else if (key === 'f' || key === 'h') {
      ev.preventDefault();
      ev.stopPropagation();
      openSearchWithSelection();
    }
  });

  const offFsChange = bus.on('fs:change', (payload) => {
    if (!payload || !payload.path) return;
    const doc = state.docs.find((d) => d.path === payload.path);
    if (!doc || doc.dirty) return;
    try {
      const fresh = fs.readFile(payload.path);
      if (fresh === doc.content) return;
      doc.content = fresh;
      doc.saved = fresh;
      if (doc === activeDoc()) editor.setDocument({ path: doc.path, content: fresh, language: doc.language });
    } catch {
      /* the file went away; the tab stays with its last known contents */
    }
  });

  state.disposers.push(
    offKeys,
    offFsChange,
    () => {
      if (problemTimer) window.clearTimeout(problemTimer);
      if (searchTimer) window.clearTimeout(searchTimer);
    },
    () => tree.destroy(),
    () => agent.destroy(),
    () => panel.destroy(),
    () => editor.destroy(),
  );

  /* --- initial state ------------------------------------------------------ */

  showView('explorer', { allowToggle: false });
  renderTabs();
  renderBreadcrumbs();
  updateTitle();
  panel.hide();

  state.api = {
    openFile,
    activate,
    closeTab,
    runActive,
    showView,
    focusPanel: () => panel.focusTerminal(),
    layout: () => editor.layout(),
  };

  const initial = ctx.args && (ctx.args.path || ctx.args.file);
  if (initial) {
    void openFile(initial);
  } else if (ctx.args && ctx.args.newFile) {
    newUntitled();
  }
}

/* ------------------------------------------------------------------ *
 * app definition
 * ------------------------------------------------------------------ */

const CODE_LOGO = [
  'M18.6 2.9 21.4 4.3a1.1 1.1 0 0 1 .6 1v13.4a1.1 1.1 0 0 1-.6 1l-2.8 1.4a1.1 1.1 0 0 1-1.2-.16L9.5 13.4 5.1 16.8l-2.5-1.25a.85.85 0 0 1 0-1.5L5.8 12 2.6 9.95a.85.85 0 0 1 0-1.5L5.1 7.2l4.4 3.4 7.9-7.54a1.1 1.1 0 0 1 1.2-.16z',
  'M18.3 7.3 12.6 12l5.7 4.7z',
];

export default {
  id: 'codeoss',
  name: 'Code - OSS',
  genericName: 'Code Editor',
  icon: () => svg(CODE_LOGO, { size: 24, filled: true, class: 'app-icon-codeoss' }),
  pinned: true,
  singleton: false,
  width: 1120,
  height: 720,
  minWidth: 720,
  minHeight: 420,
  resizable: true,
  themeClass: 'app-codeoss',
  darkChrome: true,

  mount,

  onFocus(ctx) {
    const state = sessions.get(ctx.instanceId);
    if (state && state.api) state.api.layout();
  },

  onResize(ctx) {
    const state = sessions.get(ctx.instanceId);
    if (state && state.api) state.api.layout();
  },

  onClose(ctx) {
    const state = sessions.get(ctx.instanceId);
    if (!state) return true;

    const dirty = state.docs.filter((doc) => doc.dirty);
    if (dirty.length > 0 && !state.forceClose) {
      const names = dirty.map((doc) => (doc.path ? path.basename(doc.path) : doc.name)).join(', ');
      dialog
        .confirm({
          title: dirty.length === 1
            ? `Do you want to save the changes you made to ${names}?`
            : `Do you want to save the changes to ${dirty.length} files?`,
          body: "Your changes will be lost if you don't save them.",
          okLabel: "Don't Save",
          cancelLabel: 'Cancel',
          destructive: true,
        })
        .then((discard) => {
          if (!discard) return;
          state.forceClose = true;
          ctx.close();
        });
      return false;
    }

    for (const dispose of state.disposers) {
      try {
        dispose();
      } catch {
        /* a listener already gone is not a problem */
      }
    }
    sessions.delete(ctx.instanceId);
    return true;
  },
};
