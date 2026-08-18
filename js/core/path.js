/**
 * js/core/path.js — POSIX path utilities (ARCHITECTURE §5).
 *
 * Pure string manipulation: nothing here touches the filesystem, and nothing
 * here expands globs or environment variables.
 */

/** @param {string} p @returns {boolean} */
export function isAbsolute(p) {
  return typeof p === 'string' && p.charCodeAt(0) === 47; /* '/' */
}

/**
 * Collapse `.`, `..`, duplicate and trailing slashes. Keeps the leading `/`.
 * Relative input stays relative; an empty result becomes `.`.
 * @param {string} p
 * @returns {string}
 */
export function normalize(p) {
  if (typeof p !== 'string' || p === '') return '.';
  const abs = isAbsolute(p);
  const segs = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length > 0 && segs[segs.length - 1] !== '..') segs.pop();
      else if (!abs) segs.push('..');
      continue;
    }
    segs.push(seg);
  }
  if (abs) return `/${segs.join('/')}`;
  return segs.length === 0 ? '.' : segs.join('/');
}

/**
 * Join path fragments then normalize.
 * @param {...string} parts
 * @returns {string}
 */
export function join(...parts) {
  const usable = parts.filter((p) => typeof p === 'string' && p !== '');
  if (usable.length === 0) return '.';
  const joined = usable.join('/');
  const out = normalize(joined);
  return out;
}

/**
 * Resolve `p` against `cwd`. Performs no tilde or variable expansion.
 * @param {string} cwd absolute base directory
 * @param {string} p
 * @returns {string} absolute normalized path
 */
export function resolve(cwd, p) {
  const base = isAbsolute(cwd) ? cwd : `/${cwd || ''}`;
  if (p === undefined || p === null || p === '') return normalize(base);
  if (isAbsolute(p)) return normalize(p);
  return normalize(`${base}/${p}`);
}

/**
 * @param {string} p
 * @returns {string} the parent directory (`/` for root, `.` for a bare name)
 */
export function dirname(p) {
  if (typeof p !== 'string' || p === '') return '.';
  const norm = normalize(p);
  if (norm === '/') return '/';
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return norm.slice(0, idx);
}

/**
 * @param {string} p
 * @param {string} [ext] optional suffix to strip
 * @returns {string}
 */
export function basename(p, ext) {
  if (typeof p !== 'string' || p === '') return '';
  const norm = normalize(p);
  if (norm === '/') return '/';
  const idx = norm.lastIndexOf('/');
  let base = idx < 0 ? norm : norm.slice(idx + 1);
  if (ext && base !== ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
  return base;
}

/**
 * @param {string} p
 * @returns {string} `.txt` or `''` (a leading dot is not an extension)
 */
export function extname(p) {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base.slice(idx);
}

/**
 * @param {string} p
 * @returns {string[]} non-empty path segments
 */
export function split(p) {
  if (typeof p !== 'string' || p === '') return [];
  return normalize(p)
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

/**
 * Relative path from `from` to `to`. Returns `.` when they are the same.
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relative(from, to) {
  const a = normalize(isAbsolute(from) ? from : `/${from}`);
  const b = normalize(isAbsolute(to) ? to : `/${to}`);
  if (a === b) return '.';
  const as = a === '/' ? [] : a.slice(1).split('/');
  const bs = b === '/' ? [] : b.slice(1).split('/');
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i += 1;
  const up = new Array(as.length - i).fill('..');
  const down = bs.slice(i);
  const out = up.concat(down).join('/');
  return out === '' ? '.' : out;
}

/**
 * `/home/ubuntu/x` -> `~/x`
 * @param {string} p
 * @param {string} home
 * @returns {string}
 */
export function contract(p, home) {
  if (typeof p !== 'string' || typeof home !== 'string' || home === '') return p;
  const norm = normalize(p);
  const base = normalize(home);
  if (norm === base) return '~';
  if (norm.startsWith(`${base}/`)) return `~${norm.slice(base.length)}`;
  return norm;
}

/**
 * `~/x` -> `/home/ubuntu/x`. `~otheruser` is left untouched.
 * @param {string} p
 * @param {string} home
 * @returns {string}
 */
export function expandTilde(p, home) {
  if (typeof p !== 'string' || p === '' || p.charCodeAt(0) !== 126 /* '~' */) return p;
  const base = typeof home === 'string' && home !== '' ? home : '/home/ubuntu';
  if (p === '~') return base;
  if (p.charCodeAt(1) === 47 /* '/' */) return normalize(base + p.slice(1));
  return p;
}
