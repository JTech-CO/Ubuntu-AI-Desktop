/**
 * js/apps/files/format.js — presentation helpers shared by Files and Trash.
 *
 * Sizes follow `g_format_size()` (SI units, one decimal, "N bytes" below 1000)
 * and the type labels are the shared-mime-info comments GNOME actually shows
 * in the Nautilus "Type" column.
 */

import { basename, extname, dirname } from '../../core/path.js';

/* ------------------------------------------------------------------ *
 * sizes
 * ------------------------------------------------------------------ */

const SIZE_UNITS = ['kB', 'MB', 'GB', 'TB', 'PB'];

/**
 * @param {number} bytes
 * @returns {string} `4.1 kB`, `512 bytes`, `1 byte`
 */
export function formatSize(bytes) {
  const n = Number.isFinite(Number(bytes)) ? Math.max(0, Math.round(Number(bytes))) : 0;
  if (n < 1000) return n === 1 ? '1 byte' : `${n} bytes`;
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/**
 * @param {number} bytes
 * @returns {string} `1,536 bytes`
 */
export function formatBytes(bytes) {
  const n = Number.isFinite(Number(bytes)) ? Math.max(0, Math.round(Number(bytes))) : 0;
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'byte' : 'bytes'}`;
}

/**
 * The Properties-dialog form: `4.1 kB (4,096 bytes)`.
 * @param {number} bytes
 * @returns {string}
 */
export function formatSizeDetailed(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return formatBytes(n);
  return `${formatSize(n)} (${formatBytes(n)})`;
}

/* ------------------------------------------------------------------ *
 * times
 * ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The Nautilus "Modified" column: time for today, `Yesterday`, `12 Mar`,
 * `12 Mar 2023`.
 * @param {number} ms
 * @returns {string}
 */
export function formatModified(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '';
  const d = new Date(Number(ms));
  const now = new Date();
  const today = startOfDay(now);
  const day = startOfDay(d);
  if (day === today) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (day === today - 86400000) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The Properties-dialog form: `Tue 18 Aug 2026 09:41:02`.
 * @param {number} ms
 * @returns {string}
 */
export function formatFullTime(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return 'Unknown';
  const d = new Date(Number(ms));
  return (
    `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

/** extension -> [shared-mime-info comment, icon kind] */
const TYPES = {
  '.txt': ['Plain text document', 'text'],
  '.log': ['Plain text document', 'text'],
  '.conf': ['Plain text document', 'text'],
  '.cfg': ['Plain text document', 'text'],
  '.ini': ['Plain text document', 'text'],
  '.md': ['Markdown document', 'text'],
  '.rst': ['Plain text document', 'text'],
  '.csv': ['CSV document', 'text'],
  '.py': ['Python script', 'code'],
  '.js': ['JavaScript program', 'code'],
  '.mjs': ['JavaScript program', 'code'],
  '.cjs': ['JavaScript program', 'code'],
  '.ts': ['TypeScript source code', 'code'],
  '.json': ['JSON document', 'code'],
  '.sh': ['Shell script', 'code'],
  '.bash': ['Shell script', 'code'],
  '.zsh': ['Shell script', 'code'],
  '.css': ['CSS stylesheet', 'code'],
  '.html': ['HTML document', 'code'],
  '.htm': ['HTML document', 'code'],
  '.xml': ['XML document', 'code'],
  '.yaml': ['YAML document', 'code'],
  '.yml': ['YAML document', 'code'],
  '.toml': ['TOML document', 'code'],
  '.c': ['C source code', 'code'],
  '.h': ['C header', 'code'],
  '.cpp': ['C++ source code', 'code'],
  '.cc': ['C++ source code', 'code'],
  '.hpp': ['C++ header', 'code'],
  '.java': ['Java source code', 'code'],
  '.rs': ['Rust source code', 'code'],
  '.go': ['Go source code', 'code'],
  '.rb': ['Ruby script', 'code'],
  '.php': ['PHP script', 'code'],
  '.sql': ['SQL code', 'code'],
  '.desktop': ['Desktop configuration file', 'text'],
  '.png': ['PNG image', 'image'],
  '.jpg': ['JPEG image', 'image'],
  '.jpeg': ['JPEG image', 'image'],
  '.gif': ['GIF image', 'image'],
  '.bmp': ['Windows BMP image', 'image'],
  '.svg': ['SVG image', 'image'],
  '.webp': ['WebP image', 'image'],
  '.ico': ['Windows icon', 'image'],
  '.pdf': ['PDF document', 'pdf'],
  '.zip': ['Zip archive', 'archive'],
  '.tar': ['Tar archive', 'archive'],
  '.gz': ['Gzip archive', 'archive'],
  '.bz2': ['Bzip archive', 'archive'],
  '.xz': ['XZ archive', 'archive'],
  '.zst': ['Zstandard archive', 'archive'],
  '.7z': ['7-zip archive', 'archive'],
  '.deb': ['Debian package', 'package'],
  '.rpm': ['RPM package', 'package'],
  '.snap': ['Snap package', 'package'],
  '.appimage': ['AppImage application bundle', 'package'],
  '.iso': ['Raw CD image', 'disc'],
  '.img': ['Raw disk image', 'disc'],
  '.mp3': ['MP3 audio', 'audio'],
  '.ogg': ['Ogg Vorbis audio', 'audio'],
  '.wav': ['WAV audio', 'audio'],
  '.flac': ['FLAC audio', 'audio'],
  '.mp4': ['MPEG-4 video', 'video'],
  '.mkv': ['Matroska video', 'video'],
  '.webm': ['WebM video', 'video'],
  '.avi': ['AVI video', 'video'],
  '.ttf': ['TrueType font', 'font'],
  '.otf': ['OpenType font', 'font'],
  '.so': ['Shared library', 'binary'],
  '.o': ['Object code', 'binary'],
  '.bin': ['Executable', 'binary'],
};

/** Extensions the Text Editor claims; everything else code-ish goes to Code-OSS. */
const EDITOR_EXTS = new Set(['.txt', '.md', '.log', '.conf', '.cfg', '.ini', '.rst', '.csv', '.desktop', '']);
const CODE_EXTS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.json', '.sh', '.bash', '.zsh', '.css', '.html', '.htm',
  '.xml', '.yaml', '.yml', '.toml', '.c', '.h', '.cpp', '.cc', '.hpp', '.java', '.rs', '.go',
  '.rb', '.php', '.sql',
]);

/** Files that get a text-preview thumbnail in grid view (ARCHITECTURE §18). */
const PREVIEW_EXTS = new Set(['.txt', '.md', '.py', '.js']);

/**
 * @param {string} name
 * @returns {string} lowercase extension including the dot, or ''
 */
export function extOf(name) {
  return extname(String(name || '')).toLowerCase();
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function hasTextPreview(name) {
  return PREVIEW_EXTS.has(extOf(name));
}

/**
 * @param {string} name
 * @returns {boolean} true when the Text Editor / Code-OSS can open it
 */
export function isTextLike(name) {
  const ext = extOf(name);
  return EDITOR_EXTS.has(ext) || CODE_EXTS.has(ext);
}

/**
 * Which application handles a double click.
 * @param {string} name
 * @returns {'editor'|'code'|null}
 */
export function openerFor(name) {
  const ext = extOf(name);
  if (CODE_EXTS.has(ext)) return 'code';
  if (EDITOR_EXTS.has(ext)) return 'editor';
  return null;
}

/**
 * The shared-mime-info comment GNOME shows for a name.
 * @param {string} name
 * @param {boolean} [isDir]
 * @returns {string}
 */
export function typeLabelFor(name, isDir = false) {
  if (isDir) return 'Folder';
  const ext = extOf(name);
  if (ext === '') return 'Plain text document';
  const known = TYPES[ext];
  return known ? known[0] : 'Unknown';
}

/**
 * Icon family for a name.
 * @param {string} name
 * @param {boolean} [isDir]
 * @returns {string} 'folder'|'text'|'code'|'image'|'audio'|'video'|'archive'|
 *                   'package'|'disc'|'pdf'|'font'|'binary'|'unknown'
 */
export function kindFor(name, isDir = false) {
  if (isDir) return 'folder';
  const ext = extOf(name);
  if (ext === '') return 'text';
  const known = TYPES[ext];
  return known ? known[1] : 'unknown';
}

/* ------------------------------------------------------------------ *
 * permissions
 * ------------------------------------------------------------------ */

const RWX = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];

/**
 * `drwxr-xr-x`
 * @param {number} mode octal number
 * @param {string} [type] 'dir' | 'file' | 'link'
 * @returns {string}
 */
export function modeToSymbolic(mode, type = 'file') {
  const m = Number(mode) || 0;
  const lead = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
  const owner = RWX[(m >> 6) & 7].split('');
  const group = RWX[(m >> 3) & 7].split('');
  const other = RWX[m & 7].split('');
  if (m & 0o4000) owner[2] = owner[2] === 'x' ? 's' : 'S';
  if (m & 0o2000) group[2] = group[2] === 'x' ? 's' : 'S';
  if (m & 0o1000) other[2] = other[2] === 'x' ? 't' : 'T';
  return lead + owner.join('') + group.join('') + other.join('');
}

/**
 * `0755`
 * @param {number} mode
 * @returns {string}
 */
export function modeToOctal(mode) {
  return (Number(mode) || 0).toString(8).padStart(4, '0');
}

/* ------------------------------------------------------------------ *
 * sorting
 * ------------------------------------------------------------------ */

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Compare two view entries. Folders always sort first when `foldersFirst`,
 * regardless of the reverse flag — that is what Nautilus does.
 * @param {object} a
 * @param {object} b
 * @param {string} key 'name'|'size'|'type'|'modified'|'origin'|'deleted'
 * @param {boolean} reverse
 * @param {boolean} foldersFirst
 * @returns {number}
 */
export function compareEntries(a, b, key, reverse, foldersFirst = true) {
  if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  let r = 0;
  switch (key) {
    case 'size':
      r = (a.size || 0) - (b.size || 0);
      break;
    case 'type':
      r = collator.compare(a.typeLabel || '', b.typeLabel || '');
      break;
    case 'modified':
      r = (a.mtime || 0) - (b.mtime || 0);
      break;
    case 'origin':
      r = collator.compare(a.origin || '', b.origin || '');
      break;
    case 'deleted':
      r = (a.deletedAt || 0) - (b.deletedAt || 0);
      break;
    default:
      r = 0;
      break;
  }
  if (r === 0) r = collator.compare(a.label || '', b.label || '');
  return reverse ? -r : r;
}

/**
 * Natural-order string comparison used for search results and place lists.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareNames(a, b) {
  return collator.compare(String(a), String(b));
}

/**
 * Human label for a directory path, used by the breadcrumb and Properties.
 * @param {string} p
 * @param {string} home
 * @returns {string}
 */
export function displayNameFor(p, home) {
  if (p === '/') return 'Computer';
  if (p === home) return 'Home';
  return basename(p) || '/';
}

/**
 * `~/Documents` for a location row.
 * @param {string} p
 * @param {string} home
 * @returns {string}
 */
export function parentLabel(p, home) {
  const parent = dirname(p);
  if (parent === home) return 'Home';
  if (parent.startsWith(`${home}/`)) return `~${parent.slice(home.length)}`;
  return parent;
}
