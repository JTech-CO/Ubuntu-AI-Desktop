/**
 * js/apps/files/operations.js — file operations for Files and Trash.
 *
 * Every mutation goes through `js/core/fs.js`; failures are reported with the
 * real GNU coreutils phrasing (`cannot move 'a' to 'b': File exists`) inside an
 * Adwaita dialog, and every reversible operation is pushed onto an undo stack
 * so Ctrl+Z behaves like Nautilus.
 */

import { fs, FsError } from '../../core/fs.js';
import { dialog } from '../../core/dialog.js';
import { notify } from '../../core/notify.js';
import { basename, dirname, join } from '../../core/path.js';

const MAX_UNDO = 60;

/** The Files clipboard. Copy survives a paste; cut does not. */
const clipboard = { paths: [], mode: 'copy' };

/** @type {{label:string, run:() => void|Promise<void>}[]} */
const undoStack = [];

/* ------------------------------------------------------------------ *
 * error reporting
 * ------------------------------------------------------------------ */

function phrase(err) {
  if (err instanceof FsError) return err.message;
  if (err && err.message) return String(err.message);
  return 'Input/output error';
}

/**
 * Report a failed operation in an Adwaita alert.
 * @param {string} title
 * @param {string} detail already-composed coreutils phrasing
 * @returns {Promise<void>}
 */
export function reportError(title, detail) {
  return dialog.alert({ title, body: detail });
}

function quote(p) {
  return `'${p}'`;
}

/* ------------------------------------------------------------------ *
 * naming
 * ------------------------------------------------------------------ */

function splitName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * The GNOME copy-naming scheme: `x (copy).txt`, `x (another copy).txt`,
 * `x (3rd copy).txt`, …
 * @param {string} dir destination directory
 * @param {string} name source basename
 * @returns {string} a name that does not exist in `dir`
 */
export function duplicateName(dir, name) {
  const { stem, ext } = splitName(name);
  const base = stem
    .replace(/ \(copy\)$/, '')
    .replace(/ \(another copy\)$/, '')
    .replace(/ \(\d+(?:st|nd|rd|th) copy\)$/, '');
  for (let n = 1; n < 1000; n += 1) {
    let candidate;
    if (n === 1) candidate = `${base} (copy)${ext}`;
    else if (n === 2) candidate = `${base} (another copy)${ext}`;
    else candidate = `${base} (${ordinal(n)} copy)${ext}`;
    if (!fs.lexists(join(dir, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

/**
 * `Untitled Folder`, `Untitled Folder 1`, … like Nautilus.
 * @param {string} dir
 * @param {string} base
 * @returns {string}
 */
export function uniqueName(dir, base) {
  if (!fs.lexists(join(dir, base))) return base;
  const { stem, ext } = splitName(base);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} ${n}${ext}`;
    if (!fs.lexists(join(dir, candidate))) return candidate;
  }
  return `${stem} ${Date.now()}${ext}`;
}

/* ------------------------------------------------------------------ *
 * undo stack
 * ------------------------------------------------------------------ */

/**
 * @param {string} label e.g. `Move to Trash`
 * @param {() => void|Promise<void>} run
 */
export function pushUndo(label, run) {
  undoStack.push({ label, run });
  while (undoStack.length > MAX_UNDO) undoStack.shift();
}

/** @returns {boolean} */
export function canUndo() {
  return undoStack.length > 0;
}

/** @returns {string} the menu label, e.g. `Undo Rename` */
export function undoLabel() {
  const top = undoStack[undoStack.length - 1];
  return top ? `Undo ${top.label}` : 'Undo';
}

/**
 * Run the most recent reversible operation backwards.
 * @returns {Promise<boolean>}
 */
export async function undo() {
  const top = undoStack.pop();
  if (!top) return false;
  try {
    await top.run();
    notify.show({ app: 'Files', title: `Undid ${top.label.toLowerCase()}`, timeout: 2500 });
    return true;
  } catch (err) {
    await reportError('Could not undo the last operation', phrase(err));
    return false;
  }
}

/** Forget the undo history (used when a window closes). */
export function clearUndo() {
  undoStack.length = 0;
}

/* ------------------------------------------------------------------ *
 * clipboard
 * ------------------------------------------------------------------ */

/** @param {string[]} paths */
export function copyPaths(paths) {
  clipboard.paths = paths.slice();
  clipboard.mode = 'copy';
}

/** @param {string[]} paths */
export function cutPaths(paths) {
  clipboard.paths = paths.slice();
  clipboard.mode = 'cut';
}

/** @returns {boolean} */
export function hasClipboard() {
  return clipboard.paths.length > 0;
}

/** @returns {{paths:string[], mode:'copy'|'cut'}} a copy of the clipboard */
export function clipboardState() {
  return { paths: clipboard.paths.slice(), mode: clipboard.mode };
}

/** Drop the clipboard contents. */
export function clearClipboard() {
  clipboard.paths = [];
  clipboard.mode = 'copy';
}

/* ------------------------------------------------------------------ *
 * conflicts
 * ------------------------------------------------------------------ */

/**
 * The Nautilus replace prompt.
 * @param {string} name
 * @param {boolean} isDir
 * @returns {Promise<boolean>} true when the destination should be replaced
 */
async function askReplace(name, isDir) {
  return dialog.confirm({
    title: `A ${isDir ? 'folder' : 'file'} named “${name}” already exists. Do you want to replace it?`,
    body: isDir
      ? 'Replacing it will remove all files in the folder.'
      : 'Replacing it will overwrite its content.',
    okLabel: 'Replace',
    cancelLabel: 'Skip',
    destructive: true,
  });
}

/* ------------------------------------------------------------------ *
 * operations
 * ------------------------------------------------------------------ */

/**
 * Paste the clipboard into a directory.
 * @param {string} destDir absolute directory
 * @returns {Promise<string[]>} the paths that were created in `destDir`
 */
export async function pasteInto(destDir) {
  const { paths, mode } = clipboardState();
  const sources = paths.filter((p) => fs.lexists(p));
  if (sources.length === 0) {
    if (paths.length > 0) {
      await reportError('Could not paste files', 'The source files are no longer available.');
      clearClipboard();
    }
    return [];
  }

  const created = [];
  const moves = [];
  for (const src of sources) {
    const name = basename(src);
    let dst = join(destDir, name);

    if (mode === 'cut' && dirname(src) === destDir) continue;
    if (src === destDir || destDir.startsWith(`${src}/`)) {
      await reportError(
        'Could not paste files',
        `cannot copy a directory, ${quote(src)}, into itself, ${quote(destDir)}`,
      );
      continue;
    }

    if (fs.lexists(dst)) {
      if (mode === 'copy') {
        dst = join(destDir, duplicateName(destDir, name));
      } else {
        const replace = await askReplace(name, fs.isDir(dst));
        if (!replace) continue;
        try {
          fs.rm(dst, { recursive: true, force: true });
        } catch (err) {
          await reportError('Could not replace the file', `cannot remove ${quote(dst)}: ${phrase(err)}`);
          continue;
        }
      }
    }

    try {
      if (mode === 'copy') {
        fs.cp(src, dst, { recursive: fs.isDir(src) });
        created.push(dst);
      } else {
        fs.mv(src, dst);
        moves.push({ from: src, to: dst });
        created.push(dst);
      }
    } catch (err) {
      await reportError(
        mode === 'copy' ? 'Could not copy the file' : 'Could not move the file',
        `cannot ${mode === 'copy' ? 'copy' : 'move'} ${quote(src)} to ${quote(dst)}: ${phrase(err)}`,
      );
    }
  }

  if (mode === 'cut') clearClipboard();

  if (mode === 'copy' && created.length > 0) {
    const madePaths = created.slice();
    pushUndo('Copy', () => {
      for (const p of madePaths) {
        try {
          fs.rm(p, { recursive: true, force: true });
        } catch {
          /* the user may already have removed it */
        }
      }
    });
  } else if (moves.length > 0) {
    const done = moves.slice();
    pushUndo('Move', () => {
      for (const move of done.reverse()) fs.mv(move.to, move.from);
    });
  }
  return created;
}

/**
 * Move paths into a directory (drag and drop, sidebar drop).
 * @param {string[]} paths
 * @param {string} destDir
 * @returns {Promise<string[]>} destination paths
 */
export async function movePaths(paths, destDir) {
  const moves = [];
  for (const src of paths) {
    if (!fs.lexists(src)) continue;
    if (dirname(src) === destDir) continue;
    if (src === destDir || destDir.startsWith(`${src}/`)) {
      await reportError(
        'Could not move the folder',
        `cannot move ${quote(src)} to a subdirectory of itself, ${quote(destDir)}`,
      );
      continue;
    }
    const name = basename(src);
    const dst = join(destDir, name);
    if (fs.lexists(dst)) {
      const replace = await askReplace(name, fs.isDir(dst));
      if (!replace) continue;
      try {
        fs.rm(dst, { recursive: true, force: true });
      } catch (err) {
        await reportError('Could not replace the file', `cannot remove ${quote(dst)}: ${phrase(err)}`);
        continue;
      }
    }
    try {
      fs.mv(src, dst);
      moves.push({ from: src, to: dst });
    } catch (err) {
      await reportError('Could not move the file', `cannot move ${quote(src)} to ${quote(dst)}: ${phrase(err)}`);
    }
  }
  if (moves.length > 0) {
    const done = moves.slice();
    pushUndo('Move', () => {
      for (const move of done.slice().reverse()) fs.mv(move.to, move.from);
    });
  }
  return moves.map((m) => m.to);
}

/**
 * Copy paths into a directory (Ctrl-drag).
 * @param {string[]} paths
 * @param {string} destDir
 * @returns {Promise<string[]>}
 */
export async function copyPathsInto(paths, destDir) {
  const created = [];
  for (const src of paths) {
    if (!fs.lexists(src)) continue;
    const name = basename(src);
    let dst = join(destDir, name);
    if (fs.lexists(dst)) dst = join(destDir, duplicateName(destDir, name));
    try {
      fs.cp(src, dst, { recursive: fs.isDir(src) });
      created.push(dst);
    } catch (err) {
      await reportError('Could not copy the file', `cannot copy ${quote(src)} to ${quote(dst)}: ${phrase(err)}`);
    }
  }
  if (created.length > 0) {
    const madePaths = created.slice();
    pushUndo('Copy', () => {
      for (const p of madePaths) {
        try {
          fs.rm(p, { recursive: true, force: true });
        } catch {
          /* already gone */
        }
      }
    });
  }
  return created;
}

/**
 * Rename a single entry.
 * @param {string} p absolute path
 * @param {string} newName the new basename
 * @returns {Promise<string|null>} the new path, or null on failure
 */
export async function renamePath(p, newName) {
  const name = String(newName).trim();
  if (name === '' || name === basename(p)) return null;
  if (name.includes('/')) {
    await reportError('The name is not valid', 'File names cannot contain “/”.');
    return null;
  }
  const dir = dirname(p);
  const dst = join(dir, name);
  if (fs.lexists(dst)) {
    await reportError(
      'A file with that name already exists',
      `cannot rename ${quote(p)} to ${quote(dst)}: File exists`,
    );
    return null;
  }
  try {
    fs.mv(p, dst);
  } catch (err) {
    await reportError('Could not rename the file', `cannot rename ${quote(p)} to ${quote(dst)}: ${phrase(err)}`);
    return null;
  }
  pushUndo('Rename', () => {
    fs.mv(dst, p);
  });
  return dst;
}

/**
 * Move items to the trash and offer an Undo toast.
 * @param {string[]} paths
 * @returns {Promise<number>} how many items were trashed
 */
export async function moveToTrash(paths) {
  const entries = [];
  for (const p of paths) {
    try {
      entries.push(fs.trash(p));
    } catch (err) {
      await reportError('Could not move the file to the Trash', `cannot trash ${quote(p)}: ${phrase(err)}`);
    }
  }
  if (entries.length === 0) return 0;

  const restore = () => {
    for (const entry of entries.slice().reverse()) {
      try {
        fs.restoreFromTrash(entry.name);
      } catch {
        /* the entry may have been purged already */
      }
    }
  };
  pushUndo('Move to Trash', restore);

  const title =
    entries.length === 1
      ? `“${basename(entries[0].originalPath)}” moved to Trash`
      : `${entries.length} files moved to Trash`;
  notify.show({
    app: 'Files',
    title,
    timeout: 6000,
    actions: [
      {
        label: 'Undo',
        onClick: () => {
          const index = undoStack.findIndex((u) => u.run === restore);
          if (index >= 0) undoStack.splice(index, 1);
          restore();
        },
      },
    ],
  });
  return entries.length;
}

/**
 * Permanently delete items, asking first with the Nautilus wording.
 * @param {string[]} paths
 * @param {{confirm?: boolean}} [opts]
 * @returns {Promise<number>} how many items were deleted
 */
export async function deletePermanently(paths, { confirm = true } = {}) {
  if (paths.length === 0) return 0;
  if (confirm) {
    const ok = await dialog.confirm({
      title:
        paths.length === 1
          ? `Are you sure you want to permanently delete “${basename(paths[0])}”?`
          : `Are you sure you want to permanently delete the ${paths.length} selected items?`,
      body: 'If you delete an item, it will be permanently lost.',
      okLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return 0;
  }
  let count = 0;
  for (const p of paths) {
    try {
      fs.rm(p, { recursive: true, force: true });
      count += 1;
    } catch (err) {
      await reportError('Could not delete the file', `cannot remove ${quote(p)}: ${phrase(err)}`);
    }
  }
  return count;
}

/**
 * Create a new folder.
 * @param {string} dir
 * @param {string} [name]
 * @returns {Promise<string|null>} the created path
 */
export async function createFolder(dir, name = 'Untitled Folder') {
  const finalName = uniqueName(dir, name);
  const target = join(dir, finalName);
  try {
    fs.mkdir(target);
  } catch (err) {
    await reportError('Could not create the folder', `cannot create directory ${quote(target)}: ${phrase(err)}`);
    return null;
  }
  pushUndo('Create Folder', () => {
    fs.rm(target, { recursive: true, force: true });
  });
  return target;
}

/**
 * Create an empty document, the Nautilus "New Document → Empty Document" action.
 * @param {string} dir
 * @param {string} [name]
 * @returns {Promise<string|null>} the created path
 */
export async function createDocument(dir, name = 'Untitled Document') {
  const finalName = uniqueName(dir, name);
  const target = join(dir, finalName);
  try {
    fs.writeFile(target, '');
  } catch (err) {
    await reportError('Could not create the document', `cannot create file ${quote(target)}: ${phrase(err)}`);
    return null;
  }
  pushUndo('Create Document', () => {
    fs.rm(target, { force: true });
  });
  return target;
}

/* ------------------------------------------------------------------ *
 * trash operations
 * ------------------------------------------------------------------ */

/**
 * Restore trashed entries to their original locations.
 * @param {string[]} names names inside Trash/files
 * @returns {Promise<number>}
 */
export async function restoreFromTrash(names) {
  let count = 0;
  const restored = [];
  for (const name of names) {
    try {
      const target = fs.restoreFromTrash(name);
      restored.push(target);
      count += 1;
    } catch (err) {
      const detail =
        err instanceof FsError && err.code === 'EEXIST'
          ? `cannot restore ${quote(name)}: File exists at the original location`
          : `cannot restore ${quote(name)}: ${phrase(err)}`;
      await reportError('Could not restore the item', detail);
    }
  }
  if (restored.length > 0) {
    const done = restored.slice();
    pushUndo('Restore', () => {
      for (const p of done) {
        try {
          fs.trash(p);
        } catch {
          /* already gone */
        }
      }
    });
  }
  return count;
}

/**
 * Permanently delete trashed entries.
 * @param {string[]} names
 * @param {{confirm?: boolean, labels?: string[]}} [opts]
 * @returns {Promise<number>}
 */
export async function deleteFromTrash(names, { confirm = true, labels = [] } = {}) {
  if (names.length === 0) return 0;
  if (confirm) {
    const shown = labels.length ? labels : names;
    const ok = await dialog.confirm({
      title:
        names.length === 1
          ? `Are you sure you want to permanently delete “${shown[0]}” from the trash?`
          : `Are you sure you want to permanently delete the ${names.length} selected items from the trash?`,
      body: 'If you delete an item, it will be permanently lost.',
      okLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return 0;
  }
  let count = 0;
  for (const name of names) {
    if (fs.deleteFromTrash(name)) count += 1;
  }
  return count;
}

/**
 * Empty the whole trash after the destructive confirm dialog.
 * @param {{confirm?: boolean}} [opts]
 * @returns {Promise<number>} how many top-level entries were removed
 */
export async function emptyTrash({ confirm = true } = {}) {
  const items = fs.listTrash();
  if (items.length === 0) return 0;
  if (confirm) {
    const ok = await dialog.confirm({
      title: 'Empty all items from Trash?',
      body: 'All items in the Trash will be permanently deleted.',
      okLabel: 'Empty Trash',
      destructive: true,
    });
    if (!ok) return 0;
  }
  const count = fs.emptyTrash();
  return count;
}
