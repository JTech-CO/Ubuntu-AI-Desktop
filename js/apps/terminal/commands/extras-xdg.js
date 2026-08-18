/**
 * js/apps/terminal/commands/extras-xdg.js — the freedesktop.org helpers:
 * xdg-user-dir and xdg-mime, plus the desktop-entry and MIME tables the rest
 * of the emulator shares.
 *
 * The MIME defaults here are deliberately the same dispatch `xdg-open` uses,
 * so `xdg-mime query default` tells you the truth about what will open when
 * you double-click a file in Files.
 */

import { fs } from '../../../core/fs.js';
import { env } from '../../../core/env.js';
import { ok, fail } from './util.js';

/* ------------------------------------------------------------------ *
 * desktop entry names
 * ------------------------------------------------------------------ */

/** App id -> the .desktop file name Ubuntu actually ships. */
export const DESKTOP_IDS = {
  terminal: 'org.gnome.Terminal.desktop',
  files: 'org.gnome.Nautilus.desktop',
  firefox: 'firefox_firefox.desktop',
  editor: 'org.gnome.TextEditor.desktop',
  codeoss: 'code.desktop',
  settings: 'gnome-control-center.desktop',
  monitor: 'gnome-system-monitor.desktop',
  calculator: 'org.gnome.Calculator.desktop',
  imageviewer: 'org.gnome.Loupe.desktop',
  trash: 'org.gnome.Nautilus.desktop',
};

/* ================================================================== *
 * xdg-user-dir
 * ================================================================== */

/** The XDG names and the directory each one defaults to. */
const USER_DIRS = {
  DESKTOP: 'Desktop',
  DOWNLOAD: 'Downloads',
  TEMPLATES: 'Templates',
  PUBLICSHARE: 'Public',
  DOCUMENTS: 'Documents',
  MUSIC: 'Music',
  PICTURES: 'Pictures',
  VIDEOS: 'Videos',
};

/**
 * Read ~/.config/user-dirs.dirs when it exists, so an edited file wins over
 * the defaults exactly as xdg-user-dirs behaves.
 * @param {string} home
 * @returns {Record<string, string>}
 */
function readUserDirs(home) {
  const out = {};
  const file = `${home}/.config/user-dirs.dirs`;
  let text = '';
  try {
    text = fs.readFile(file);
  } catch {
    return out;
  }
  for (const line of String(text).split('\n')) {
    const m = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^\$HOME/, home);
  }
  return out;
}

const xdgUserDirCommand = {
  name: 'xdg-user-dir',
  aliases: [],
  synopsis: 'xdg-user-dir [NAME]',
  description: 'Look up an XDG user directory',
  man: `NAME
       xdg-user-dir - Find an XDG user directory

SYNOPSIS
       xdg-user-dir [NAME]

DESCRIPTION
       Prints the path of a well known user directory. With no argument it
       prints the home directory.

       ~/.config/user-dirs.dirs is read when it exists and takes precedence,
       exactly as it does on a real system; otherwise the shipped defaults are
       used.

       NAME is one of DESKTOP, DOWNLOAD, TEMPLATES, PUBLICSHARE, DOCUMENTS,
       MUSIC, PICTURES or VIDEOS. An unknown name prints the home directory,
       which is what the real tool does rather than failing.

EXIT STATUS
       0  always`,

  async run(ctx) {
    const home = env.home;
    const name = (ctx.argv.find((a) => !a.startsWith('-')) || '').toUpperCase();
    if (!name) return ok(`${home}\n`);
    const configured = readUserDirs(home);
    if (configured[name]) return ok(`${configured[name]}\n`);
    if (USER_DIRS[name]) return ok(`${home}/${USER_DIRS[name]}\n`);
    return ok(`${home}\n`);
  },
};

/* ================================================================== *
 * xdg-mime
 * ================================================================== */

/** Extension -> MIME type, matching the shared-mime-info database. */
const MIME_TYPES = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  log: 'text/plain', conf: 'text/plain', cfg: 'text/plain', ini: 'text/plain',
  csv: 'text/csv', xml: 'application/xml', json: 'application/json',
  yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  ts: 'text/x-typescript', py: 'text/x-python', rb: 'application/x-ruby',
  sh: 'application/x-shellscript', bash: 'application/x-shellscript',
  c: 'text/x-csrc', h: 'text/x-chdr', cpp: 'text/x-c++src', hpp: 'text/x-c++hdr',
  java: 'text/x-java', rs: 'text/rust', go: 'text/x-go',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/x-wav', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  xz: 'application/x-xz', deb: 'application/vnd.debian.binary-package',
  iso: 'application/x-cd-image', desktop: 'application/x-desktop',
};

/** MIME type -> the desktop entry that handles it here. */
const MIME_DEFAULTS = {
  'text/plain': DESKTOP_IDS.editor,
  'text/markdown': DESKTOP_IDS.editor,
  'text/csv': DESKTOP_IDS.editor,
  'application/json': DESKTOP_IDS.codeoss,
  'application/xml': DESKTOP_IDS.editor,
  'application/yaml': DESKTOP_IDS.codeoss,
  'application/toml': DESKTOP_IDS.codeoss,
  'text/javascript': DESKTOP_IDS.codeoss,
  'text/x-typescript': DESKTOP_IDS.codeoss,
  'text/x-python': DESKTOP_IDS.codeoss,
  'text/x-csrc': DESKTOP_IDS.codeoss,
  'text/x-c++src': DESKTOP_IDS.codeoss,
  'application/x-shellscript': DESKTOP_IDS.codeoss,
  'text/css': DESKTOP_IDS.codeoss,
  'text/html': DESKTOP_IDS.firefox,
  'application/pdf': DESKTOP_IDS.firefox,
  'image/png': DESKTOP_IDS.imageviewer,
  'image/jpeg': DESKTOP_IDS.imageviewer,
  'image/gif': DESKTOP_IDS.imageviewer,
  'image/webp': DESKTOP_IDS.imageviewer,
  'image/svg+xml': DESKTOP_IDS.imageviewer,
  'inode/directory': DESKTOP_IDS.files,
};

/** Read the user's mimeapps.list overrides. */
function readMimeApps(home) {
  const out = {};
  let text = '';
  try {
    text = fs.readFile(`${home}/.config/mimeapps.list`);
  } catch {
    return out;
  }
  let section = '';
  for (const line of String(text).split('\n')) {
    const head = /^\s*\[(.+)\]\s*$/.exec(line);
    if (head) { section = head[1]; continue; }
    if (section !== 'Default Applications') continue;
    const m = /^\s*([^=\s]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const xdgMimeCommand = {
  name: 'xdg-mime',
  aliases: [],
  synopsis: 'xdg-mime query filetype FILE | query default MIME | default DESKTOP MIME...',
  description: 'Query or set file type handlers',
  man: `NAME
       xdg-mime - command line tool for querying information about file type
       handling and adding descriptions for new file types

SYNOPSIS
       xdg-mime query filetype FILE
       xdg-mime query default MIMETYPE
       xdg-mime default DESKTOP-FILE MIMETYPE...

DESCRIPTION
       query filetype reports the MIME type of a file. Directories report
       inode/directory, files with a #! line report
       application/x-shellscript, and everything else is matched by extension
       against the shared-mime-info table.

       query default reports which application would open that type, and
       matches what \`xdg-open\` actually does in this desktop.

       default records a new association in ~/.config/mimeapps.list, which is
       read back on the next query — the same file a real system writes.

EXIT STATUS
       0  success
       1  the file does not exist, or the arguments were malformed
       2  no handler is registered for that type`,

  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--version')) return ok('xdg-mime 1.1.3\n');
    const home = env.home;

    if (argv[0] === 'query' && argv[1] === 'filetype') {
      const spec = argv[2];
      if (!spec) return fail('xdg-mime: file argument missing\n', 1);
      const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(spec, home));
      if (!fs.exists(target)) {
        return fail(`xdg-mime: file '${spec}' does not exist\n`, 1);
      }
      if (fs.isDir(target)) return ok('inode/directory\n');
      let head = '';
      try {
        head = fs.readFile(target).slice(0, 2);
      } catch {
        head = '';
      }
      if (head === '#!') return ok('application/x-shellscript\n');
      const ext = ctx.path.extname(target).replace(/^\./, '').toLowerCase();
      return ok(`${MIME_TYPES[ext] || 'application/octet-stream'}\n`);
    }

    if (argv[0] === 'query' && argv[1] === 'default') {
      const mime = argv[2];
      if (!mime) return fail('xdg-mime: mimetype argument missing\n', 1);
      const overrides = readMimeApps(home);
      const handler = overrides[mime] || MIME_DEFAULTS[mime]
        || (mime.startsWith('text/') ? DESKTOP_IDS.editor : '');
      if (!handler) return { stdout: '', stderr: '', code: 2 };
      return ok(`${handler}\n`);
    }

    if (argv[0] === 'default') {
      const desktopFile = argv[1];
      const mimes = argv.slice(2);
      if (!desktopFile || !mimes.length) {
        return fail('xdg-mime: incorrect number of arguments\nUsage: xdg-mime default DESKTOP-FILE MIMETYPE...\n', 1);
      }
      if (!desktopFile.endsWith('.desktop')) {
        return fail(`xdg-mime: '${desktopFile}' is not a .desktop file\n`, 1);
      }
      const path = `${home}/.config/mimeapps.list`;
      const existing = readMimeApps(home);
      for (const m of mimes) existing[m] = desktopFile;
      const body = ['[Default Applications]'];
      for (const [m, app] of Object.entries(existing)) body.push(`${m}=${app}`);
      try {
        fs.writeFile(path, `${body.join('\n')}\n`);
      } catch (e) {
        return fail(`xdg-mime: cannot write ${path}: ${e && e.message ? e.message : 'error'}\n`, 1);
      }
      return ok('');
    }

    return fail([
      'Usage: xdg-mime query filetype FILE',
      '       xdg-mime query default MIMETYPE',
      '       xdg-mime default DESKTOP-FILE MIMETYPE...',
      '',
    ].join('\n'), 1);
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const xdgCommands = [
  xdgUserDirCommand,
  xdgMimeCommand,
];

export default xdgCommands;
