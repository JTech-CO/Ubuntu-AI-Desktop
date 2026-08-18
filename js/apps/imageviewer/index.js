/**
 * js/apps/imageviewer/index.js — Image Viewer (Eye of GNOME), ARCHITECTURE §16.
 *
 * A GNOME 46 `eog` window: header bar with the file name and prev/next, the
 * image surface with fit / 1:1 / pointer-anchored Ctrl+scroll zoom, rotation
 * and mirroring, a status bar carrying dimensions, size, zoom and position, a
 * slideshow, a fullscreen mode and the properties dialog.
 *
 * Opened with `wm.open('imageviewer', { path })`. Images live in the virtual
 * filesystem as data URLs (or raw SVG markup) — see `./gallery.js`, which owns
 * every decision about what is displayable and in what order.
 *
 * The pieces live in sibling modules: `gallery.js` (folder scanning and
 * prev/next), `surface.js` (the zoom/pan/rotate transform), `chrome.js` (header
 * bar, status bar, empty state, properties dialog), `keys.js` (the accelerator
 * table) and `wallpaper.js` ("Set as Wallpaper").
 */

import { fs } from '../../core/fs.js';
import { bus } from '../../core/bus.js';
import { store } from '../../core/store.js';
import { h, on } from '../../core/dom.js';
import { dialog } from '../../core/dialog.js';
import { notify } from '../../core/notify.js';
import { basename, dirname, extname, contract, expandTilde, isAbsolute, resolve, normalize } from '../../core/path.js';
import { wm } from '../../shell/window-manager.js';
import { openMenu } from '../../shell/context-menu.js';
import { formatSize, formatFullTime } from '../files/format.js';
import { createGallery, openImageSource, toDataUrl, typeLabelFor, guessMime } from './gallery.js';
import { createSurface } from './surface.js';
import { createKeyHandler } from './keys.js';
import { createHeader, createStatusBar, createEmptyState, openPropertiesDialog, viewerIcon } from './chrome.js';
import { setWallpaperFromImage, installWallpaperBridge } from './wallpaper.js';

const PREFS_KEY = 'imageviewer:prefs';
const MIN_SLIDESHOW = 1;
const MAX_SLIDESHOW = 600;

/** @type {Map<string, object>} instanceId -> controller */
const instances = new Map();

// Keeps a background chosen through "Set as Wallpaper" applied across reloads.
installWallpaperBridge();

function loadPrefs() {
  const saved = store.get(PREFS_KEY, null);
  const base = { slideshowInterval: 5 };
  if (!saved || typeof saved !== 'object') return base;
  const interval = Number(saved.slideshowInterval);
  return {
    slideshowInterval: Number.isFinite(interval)
      ? Math.min(MAX_SLIDESHOW, Math.max(MIN_SLIDESHOW, Math.round(interval)))
      : base.slideshowInterval,
  };
}

/**
 * `~/Pictures/Screenshots` for a folder, like the Files breadcrumb.
 * @param {string} p
 * @returns {string}
 */
function prettyDir(p) {
  return contract(p, fs.HOME);
}

/* ------------------------------------------------------------------ *
 * controller
 * ------------------------------------------------------------------ */

function createViewer(root, ctx) {
  const prefs = loadPrefs();
  const cleanups = [];

  const startPath = ctx && ctx.args && typeof ctx.args.path === 'string' ? normalize(ctx.args.path) : '';
  const gallery = createGallery(startPath || `${fs.HOME}/Pictures`);

  /** @type {{url:string, mime:string, revoke:(()=>void)|null}|null} */
  let source = null;
  let stat = null;
  let fullscreen = false;
  let slideshow = 0;
  let refreshTimer = 0;
  let browserFullscreenRequested = false;

  /* --- structure ---------------------------------------------------- */

  const header = createHeader({
    onPrev: () => step(-1),
    onNext: () => step(1),
    onZoomIn: () => surface.zoomIn(),
    onZoomOut: () => surface.zoomOut(),
    onRotate: () => surface.rotateBy(90),
    onFullscreen: () => setFullscreen(!fullscreen),
    onMenu: (anchor) => showMenu(anchor),
  });

  const empty = createEmptyState();
  const status = createStatusBar();

  const surface = createSurface({
    onChange: () => updateStatus(),
    onLoad: () => {
      empty.hide();
      updateStatus();
    },
    onError: () => showUndisplayable(),
  });

  surface.element.appendChild(empty.element);

  const shell = h(
    'div.eog-root',
    { tabindex: '-1' },
    header.element,
    surface.element,
    status.element,
  );
  root.classList.add('eog-window');
  root.appendChild(shell);

  /* --- current file -------------------------------------------------- */

  function currentPath() {
    return gallery.path();
  }

  function releaseSource() {
    if (source && typeof source.revoke === 'function') source.revoke();
    source = null;
  }

  function readStat(p) {
    try {
      return fs.stat(p);
    } catch {
      return null;
    }
  }

  function showUndisplayable() {
    const p = currentPath();
    const name = basename(p) || 'image';
    empty.show({
      title: `Could not display “${name}”`,
      body: fs.exists(p)
        ? 'The file does not contain an image this viewer can decode. ' +
          'Images in this filesystem are stored as data URLs, or as SVG markup in a .svg file.'
        : `${prettyDir(p)}: No such file or directory`,
      actions: [
        { label: 'Show in Files', onClick: () => showInFiles() },
        gallery.count() > 1 ? { label: 'Next Image', onClick: () => step(1) } : null,
      ].filter(Boolean),
    });
    updateStatus();
  }

  function showNoImages() {
    empty.show({
      title: 'No Images Found',
      body: `There are no images in ${prettyDir(gallery.dir())}.`,
      actions: [{ label: 'Show in Files', onClick: () => showInFiles() }],
    });
    updateStatus();
  }

  /** Load whatever `gallery.path()` currently points at. */
  function load() {
    releaseSource();
    const p = currentPath();
    stat = readStat(p);

    const name = basename(p) || 'Image Viewer';
    if (ctx && typeof ctx.setTitle === 'function') ctx.setTitle(name);
    const count = gallery.count();
    header.setTitle(name, count > 1 ? `${gallery.position()} of ${count}` : '');
    header.setNavEnabled(count > 1);
    surface.setAlt(name);

    if (!p || (!stat && count === 0)) {
      surface.clearImage();
      header.setImageActionsEnabled(false);
      showNoImages();
      return;
    }

    source = openImageSource(p);
    if (!source) {
      surface.clearImage();
      header.setImageActionsEnabled(false);
      showUndisplayable();
      return;
    }

    empty.hide();
    header.setImageActionsEnabled(true);
    surface.setImage(source.url);
    updateStatus();
  }

  /**
   * Move through the folder.
   * @param {number} direction -1 or 1
   */
  function step(direction) {
    if (gallery.count() === 0) return;
    if (direction < 0) gallery.prev();
    else gallery.next();
    load();
  }

  function goTo(index) {
    if (gallery.count() === 0) return;
    gallery.goTo(index);
    load();
  }

  /* --- status bar ----------------------------------------------------- */

  function updateStatus() {
    const natural = surface.natural();
    const loaded = surface.isLoaded();
    const count = gallery.count();

    status.set({
      dimensions: loaded ? `${natural.w} × ${natural.h} pixels` : '',
      size: stat ? formatSize(stat.size) : '',
      zoom: loaded ? `${Math.round(surface.zoom() * 100)}%` : '',
      position: count > 0 ? `${gallery.position()} of ${count}` : '',
    });
  }

  /* --- actions --------------------------------------------------------- */

  function showInFiles() {
    wm.open('files', { path: gallery.dir() });
  }

  async function setAsWallpaper() {
    const p = currentPath();
    const url = toDataUrl(p);
    if (!url) {
      await dialog.alert({
        title: 'Could not set the background',
        body: 'This file does not hold an image that can be used as a wallpaper.',
      });
      return;
    }
    setWallpaperFromImage(url, { path: p, name: basename(p) });
    notify.show({
      app: 'Image Viewer',
      title: 'Background changed',
      body: `${basename(p)} is now the desktop background.`,
      icon: viewerIcon(18),
      timeout: 5000,
      actions: [{ label: 'Background Settings', onClick: () => wm.open('settings', { section: 'background' }) }],
    });
  }

  async function saveACopy() {
    const p = currentPath();
    let content = '';
    try {
      content = fs.readFile(p);
    } catch {
      await dialog.alert({ title: 'Could not read the image', body: `${p}: No such file or directory` });
      return;
    }

    const ext = extname(p);
    const stem = basename(p, ext);
    const suggestion = `${gallery.dir()}/${stem} (copy)${ext}`;
    const typed = await dialog.prompt({
      title: 'Save a Copy',
      body: 'Save the image to this path',
      value: suggestion,
    });
    if (typed === null) return;

    const trimmed = String(typed).trim();
    if (trimmed === '') return;
    const expanded = expandTilde(trimmed, fs.HOME);
    const target = isAbsolute(expanded) ? normalize(expanded) : resolve(gallery.dir(), expanded);

    if (fs.isDir(target)) {
      await dialog.alert({ title: 'Could not save the copy', body: `${target}: Is a directory` });
      return;
    }
    if (!fs.isDir(dirname(target))) {
      await dialog.alert({
        title: 'Could not save the copy',
        body: `${dirname(target)}: No such file or directory`,
      });
      return;
    }
    if (fs.exists(target)) {
      const overwrite = await dialog.confirm({
        title: `Replace “${basename(target)}”?`,
        body: 'A file with that name already exists. Replacing it overwrites its contents.',
        okLabel: 'Replace',
        destructive: true,
      });
      if (!overwrite) return;
    }

    try {
      fs.writeFile(target, content);
    } catch (err) {
      await dialog.alert({
        title: 'Could not save the copy',
        body: `${target}: ${err && err.message ? err.message : 'write failed'}`,
      });
      return;
    }

    notify.show({
      app: 'Image Viewer',
      title: 'Image saved',
      body: prettyDir(target),
      icon: viewerIcon(18),
      timeout: 5000,
      actions: [{ label: 'Show in Files', onClick: () => wm.open('files', { path: dirname(target) }) }],
    });
  }

  async function moveToTrash() {
    const p = currentPath();
    if (!fs.exists(p)) return;
    const name = basename(p);
    const confirmed = await dialog.confirm({
      title: `Move “${name}” to the Trash?`,
      body: 'You can restore it later from the Trash.',
      okLabel: 'Move to Trash',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      fs.trash(p);
    } catch (err) {
      await dialog.alert({
        title: 'Could not move the image to the Trash',
        body: `${name}: ${err && err.message ? err.message : 'operation failed'}`,
      });
      return;
    }
    // `fs:change` drives the reload; nothing else to do here.
  }

  function showProperties() {
    const p = currentPath();
    const natural = surface.natural();
    const mime = source ? source.mime : guessMime(p);
    openPropertiesDialog({
      name: basename(p) || '—',
      location: prettyDir(gallery.dir()),
      path: p || '—',
      type: typeLabelFor(mime, p),
      dimensions: surface.isLoaded() ? `${natural.w} × ${natural.h} pixels` : 'Unknown',
      size: stat ? `${formatSize(stat.size)} (${stat.size.toLocaleString('en-US')} bytes)` : 'Unknown',
      modified: stat ? formatFullTime(stat.mtime) : 'Unknown',
      zoom: surface.isLoaded() ? `${Math.round(surface.zoom() * 100)}%` : '—',
    });
  }

  /* --- fullscreen ------------------------------------------------------- */

  /**
   * eog's fullscreen: the image fills the whole screen with no chrome.
   *
   * The window content is promoted to a fixed, full-viewport layer rather than
   * being pushed into the browser's fullscreen top layer, because the top layer
   * would hide the context menu, the dialogs and the notifications that this
   * app still needs. The browser is asked to go fullscreen on `<html>` as well,
   * so the browser's own chrome gets out of the way without stranding any
   * overlay.
   *
   * @param {boolean} value
   */
  function setFullscreen(value) {
    const next = Boolean(value);
    if (next === fullscreen) return;
    fullscreen = next;
    shell.classList.toggle('eog-root--fullscreen', fullscreen);
    if (ctx && ctx.win instanceof HTMLElement) {
      ctx.win.classList.toggle('window--eog-fullscreen', fullscreen);
    }

    if (fullscreen) {
      const el = document.documentElement;
      if (!document.fullscreenElement && typeof el.requestFullscreen === 'function') {
        browserFullscreenRequested = true;
        Promise.resolve(el.requestFullscreen()).catch(() => {
          // Fullscreen needs a user gesture and can be blocked by policy; the
          // in-page fullscreen above already did the important half.
          browserFullscreenRequested = false;
        });
      }
    } else {
      stopSlideshow();
      if (browserFullscreenRequested && document.fullscreenElement) {
        browserFullscreenRequested = false;
        Promise.resolve(document.exitFullscreen()).catch(() => {});
      }
      browserFullscreenRequested = false;
    }
    surface.relayout();
    shell.focus();
  }

  cleanups.push(
    on(document, 'fullscreenchange', () => {
      if (!document.fullscreenElement && fullscreen && browserFullscreenRequested) {
        browserFullscreenRequested = false;
        setFullscreen(false);
      }
    }),
  );

  /* --- slideshow --------------------------------------------------------- */

  function stopSlideshow() {
    if (!slideshow) return;
    clearInterval(slideshow);
    slideshow = 0;
    shell.classList.remove('eog-root--slideshow');
  }

  function startSlideshow() {
    if (slideshow) return;
    if (gallery.count() < 2) {
      notify.show({
        app: 'Image Viewer',
        title: 'Slideshow needs more than one image',
        body: `${prettyDir(gallery.dir())} holds ${gallery.count()} image${gallery.count() === 1 ? '' : 's'}.`,
        icon: viewerIcon(18),
        timeout: 4000,
      });
      return;
    }
    setFullscreen(true);
    shell.classList.add('eog-root--slideshow');
    slideshow = setInterval(() => step(1), prefs.slideshowInterval * 1000);
  }

  function toggleSlideshow() {
    if (slideshow) stopSlideshow();
    else startSlideshow();
  }

  async function askSlideshowInterval() {
    const typed = await dialog.prompt({
      title: 'Slideshow Interval',
      body: `Seconds between images (${MIN_SLIDESHOW}–${MAX_SLIDESHOW})`,
      value: String(prefs.slideshowInterval),
    });
    if (typed === null) return;
    const value = Number(String(typed).trim());
    if (!Number.isFinite(value) || value < MIN_SLIDESHOW || value > MAX_SLIDESHOW) {
      await dialog.alert({
        title: 'Invalid interval',
        body: `Enter a whole number of seconds between ${MIN_SLIDESHOW} and ${MAX_SLIDESHOW}.`,
      });
      return;
    }
    prefs.slideshowInterval = Math.round(value);
    store.set(PREFS_KEY, prefs);
    if (slideshow) {
      stopSlideshow();
      startSlideshow();
    }
  }

  /* --- menu ---------------------------------------------------------------- */

  function showMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    const has = surface.isLoaded();
    const exists = fs.exists(currentPath());

    openMenu(rect.left, rect.bottom + 4, [
      { label: 'Zoom In', accel: '+', disabled: !has, onClick: () => surface.zoomIn() },
      { label: 'Zoom Out', accel: '−', disabled: !has, onClick: () => surface.zoomOut() },
      { label: 'Best Fit', accel: '0', disabled: !has, onClick: () => surface.fitToWindow() },
      { label: 'Normal Size (1:1)', accel: '1', disabled: !has, onClick: () => surface.actualSize() },
      { separator: true },
      { label: 'Rotate Left', accel: 'Ctrl+L', disabled: !has, onClick: () => surface.rotateBy(-90) },
      { label: 'Rotate Right', accel: 'Ctrl+R', disabled: !has, onClick: () => surface.rotateBy(90) },
      { label: 'Flip Horizontally', accel: 'Ctrl+M', disabled: !has, onClick: () => surface.flipHorizontal() },
      { label: 'Flip Vertically', accel: 'Ctrl+Shift+M', disabled: !has, onClick: () => surface.flipVertical() },
      { label: 'Reset Transform', disabled: !has, onClick: () => surface.resetTransform() },
      { separator: true },
      {
        label: slideshow ? 'Stop Slideshow' : 'Start Slideshow',
        accel: 'F5',
        disabled: gallery.count() < 2,
        onClick: () => toggleSlideshow(),
      },
      {
        label: `Slideshow Interval… (${prefs.slideshowInterval}s)`,
        onClick: () => void askSlideshowInterval(),
      },
      {
        label: fullscreen ? 'Leave Fullscreen' : 'Fullscreen',
        accel: 'F11',
        onClick: () => setFullscreen(!fullscreen),
      },
      { separator: true },
      { label: 'Set as Wallpaper', disabled: !has, onClick: () => void setAsWallpaper() },
      { label: 'Save a Copy…', accel: 'Ctrl+S', disabled: !exists, onClick: () => void saveACopy() },
      { label: 'Show in Files', onClick: () => showInFiles() },
      { label: 'Move to Trash', accel: 'Delete', disabled: !exists, onClick: () => void moveToTrash() },
      { separator: true },
      { label: 'Properties', accel: 'Ctrl+I', onClick: () => showProperties() },
    ]);
  }

  /* --- keyboard -------------------------------------------------------------- */

  const onKeyDown = createKeyHandler({
    prev: () => step(-1),
    next: () => step(1),
    first: () => goTo(0),
    last: () => goTo(gallery.count() - 1),
    zoomIn: () => surface.zoomIn(),
    zoomOut: () => surface.zoomOut(),
    fit: () => surface.fitToWindow(),
    actualSize: () => surface.actualSize(),
    rotateLeft: () => surface.rotateBy(-90),
    rotateRight: () => surface.rotateBy(90),
    flipHorizontal: () => surface.flipHorizontal(),
    flipVertical: () => surface.flipVertical(),
    resetTransform: () => surface.resetTransform(),
    properties: () => showProperties(),
    saveCopy: () => void saveACopy(),
    trash: () => void moveToTrash(),
    toggleSlideshow: () => toggleSlideshow(),
    toggleFullscreen: () => setFullscreen(!fullscreen),
    panBy: (dx, dy) => surface.panBy(dx, dy),
    dismiss: () => {
      if (slideshow) {
        stopSlideshow();
        return true;
      }
      if (fullscreen) {
        setFullscreen(false);
        return true;
      }
      return false;
    },
  });

  cleanups.push(on(shell, 'keydown', onKeyDown));
  cleanups.push(
    on(shell, 'pointerdown', () => {
      if (!shell.contains(document.activeElement)) shell.focus();
    }),
  );
  cleanups.push(
    on(surface.element, 'dblclick', (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.eog-empty')) return;
      setFullscreen(!fullscreen);
    }),
  );

  /* --- filesystem ------------------------------------------------------------- */

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      const before = currentPath();
      const mtimeBefore = stat ? stat.mtime : 0;
      gallery.reload();
      if (fs.exists(before) && gallery.index() >= 0 && gallery.path() === before) {
        const fresh = readStat(before);
        // The file itself was rewritten — reload the pixels.
        if (fresh && fresh.mtime !== mtimeBefore) {
          load();
          return;
        }
        // Only the neighbours changed; keep the current view and transform.
        const count = gallery.count();
        header.setTitle(basename(before), count > 1 ? `${gallery.position()} of ${count}` : '');
        header.setNavEnabled(count > 1);
        stat = fresh;
        updateStatus();
        return;
      }
      if (gallery.count() > 0 && gallery.index() >= 0) {
        gallery.goTo(gallery.index());
      }
      load();
    }, 60);
  }

  cleanups.push(bus.on('fs:change', scheduleRefresh), bus.on('fs:trash', scheduleRefresh));

  /* --- start -------------------------------------------------------------------- */

  if (startPath && gallery.index() === -1 && fs.isFile(startPath)) {
    // A path that is not in the listing (an unreadable stub, say) still opens:
    // eog shows its error page rather than silently jumping elsewhere.
    gallery.setPath(startPath);
  }
  load();
  shell.focus();

  // `eog -f` / `eog -s` route through wm.open('imageviewer', { … }).
  const args = (ctx && ctx.args) || {};
  if (args.slideshow) startSlideshow();
  else if (args.fullscreen) setFullscreen(true);

  return {
    focus: () => shell.focus(),
    relayout: () => surface.relayout(),
    destroy() {
      if (refreshTimer) clearTimeout(refreshTimer);
      stopSlideshow();
      if (fullscreen) setFullscreen(false);
      for (const off of cleanups) off();
      cleanups.length = 0;
      surface.destroy();
      releaseSource();
      if (ctx && ctx.win instanceof HTMLElement) ctx.win.classList.remove('window--eog-fullscreen');
      shell.remove();
      root.classList.remove('eog-window');
    },
  };
}

/* ------------------------------------------------------------------ *
 * app module (ARCHITECTURE §16)
 * ------------------------------------------------------------------ */

export default {
  id: 'imageviewer',
  name: 'Image Viewer',
  genericName: 'Image Viewer',
  icon: () => viewerIcon(48),
  pinned: false,
  singleton: false,
  width: 900,
  height: 620,
  minWidth: 420,
  minHeight: 300,
  resizable: true,
  themeClass: 'app-imageviewer',
  darkChrome: false,

  mount(root, ctx) {
    instances.set(ctx.instanceId, createViewer(root, ctx));
  },

  onFocus(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (instance) instance.focus();
  },

  onResize(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (instance) instance.relayout();
  },

  onClose(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (instance) instance.destroy();
    instances.delete(ctx.instanceId);
  },
};
