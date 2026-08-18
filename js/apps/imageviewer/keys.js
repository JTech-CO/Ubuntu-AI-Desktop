/**
 * js/apps/imageviewer/keys.js — the Image Viewer's keyboard map.
 *
 * Split out of `index.js` so the controller stays about the image and this
 * stays about the keys. `createKeyHandler` is pure: it is handed a table of
 * named actions and returns the `keydown` listener that drives them.
 *
 * Accelerators follow eog, with two additions the browser forces:
 *
 *   - `Ctrl+L` is eog's Rotate Left, but Chrome keeps that combination for its
 *     address bar and a page cannot take it back. `Ctrl+Shift+R` is bound to
 *     the same action so rotating left always has a working shortcut.
 *   - `Ctrl+W` is not bound at all: browsers close the tab on it and refuse to
 *     let a page intervene, so offering it would be a lie.
 */

/** Pixels one arrow-key scroll step moves a zoomed image. */
const PAN_STEP = 60;

/**
 * @param {object} target
 * @returns {boolean} true when the event came from a text field
 */
function isTyping(target) {
  if (!target) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true;
}

/**
 * Build the `keydown` listener.
 *
 * @param {{
 *   prev: () => void, next: () => void, first: () => void, last: () => void,
 *   zoomIn: () => void, zoomOut: () => void, fit: () => void, actualSize: () => void,
 *   rotateLeft: () => void, rotateRight: () => void,
 *   flipHorizontal: () => void, flipVertical: () => void,
 *   resetTransform: () => void,
 *   properties: () => void, saveCopy: () => void, trash: () => void,
 *   toggleSlideshow: () => void, toggleFullscreen: () => void,
 *   dismiss: () => boolean,
 *   panBy: (dx: number, dy: number) => boolean,
 * }} actions
 * @returns {(ev: KeyboardEvent) => void}
 */
export function createKeyHandler(actions) {
  /**
   * Ctrl-modified keys.
   * @param {KeyboardEvent} ev
   * @returns {boolean} true when the key was consumed
   */
  function onCtrl(ev) {
    const key = ev.key.toLowerCase();

    if (ev.shiftKey) {
      if (key === 'r') {
        actions.rotateLeft();
        return true;
      }
      if (key === 'm') {
        actions.flipVertical();
        return true;
      }
      return false;
    }

    switch (key) {
      case 'l':
        actions.rotateLeft();
        return true;
      case 'r':
        actions.rotateRight();
        return true;
      case 'm':
        actions.flipHorizontal();
        return true;
      case 'i':
        actions.properties();
        return true;
      case 's':
        actions.saveCopy();
        return true;
      case '0':
        actions.fit();
        return true;
      case '1':
        actions.actualSize();
        return true;
      case '+':
      case '=':
        actions.zoomIn();
        return true;
      case '-':
        actions.zoomOut();
        return true;
      default:
        return false;
    }
  }

  /**
   * Unmodified keys.
   * @param {KeyboardEvent} ev
   * @param {boolean} onButton true when a header button has focus
   * @returns {boolean} true when the key was consumed
   */
  function onPlain(ev, onButton) {
    switch (ev.key) {
      case 'ArrowLeft':
        actions.prev();
        return true;
      case 'ArrowRight':
        actions.next();
        return true;
      case 'ArrowUp':
        // Scroll a zoomed-in image; fall back to navigation when it all fits.
        if (!actions.panBy(0, PAN_STEP)) actions.prev();
        return true;
      case 'ArrowDown':
        if (!actions.panBy(0, -PAN_STEP)) actions.next();
        return true;
      case ' ':
      case 'Spacebar':
        // Space belongs to a focused button first, exactly as GTK behaves.
        if (onButton) return false;
        actions.next();
        return true;
      case 'Backspace':
        actions.prev();
        return true;
      case 'Home':
        actions.first();
        return true;
      case 'End':
        actions.last();
        return true;
      case '+':
      case '=':
        actions.zoomIn();
        return true;
      case '-':
      case '_':
        actions.zoomOut();
        return true;
      case '0':
        actions.fit();
        return true;
      case '1':
        actions.actualSize();
        return true;
      case 'F5':
        actions.toggleSlideshow();
        return true;
      case 'F11':
        actions.toggleFullscreen();
        return true;
      case 'Delete':
        actions.trash();
        return true;
      case 'Escape':
        return actions.dismiss();
      default:
        return false;
    }
  }

  return function onKeyDown(ev) {
    if (isTyping(ev.target)) return;

    if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (onCtrl(ev)) ev.preventDefault();
      return;
    }
    if (ev.altKey || ev.metaKey || ev.ctrlKey) return;

    const target = ev.target;
    const onButton = Boolean(target && typeof target.closest === 'function' && target.closest('button'));
    if (onPlain(ev, onButton)) ev.preventDefault();
  };
}
