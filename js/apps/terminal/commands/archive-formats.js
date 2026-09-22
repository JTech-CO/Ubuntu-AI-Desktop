/**
 * archive-formats.js — byte-level gzip, tar and zip.
 *
 * Pure functions over Uint8Array with no filesystem or terminal access, so
 * they can be tested in isolation. The files they produce open in real
 * tools: a `.tar.gz` made here extracts with GNU tar on a real machine, and
 * a `.zip` opens in any unzip.
 *
 * Compression uses the browser's CompressionStream('deflate-raw'). Where
 * that is missing, deflate falls back to stored blocks — still a valid
 * deflate stream, just not smaller. Decompression is done here in plain
 * JavaScript rather than with DecompressionStream, because gzip members and
 * zip entries need to know exactly where each deflate stream ends, and the
 * stream API refuses input that carries anything after it.
 */

/* ------------------------------------------------------------------ *
 * CRC-32 (IEEE 802.3, as used by gzip and zip)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} [crc] running value, for incremental use
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(bytes, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function put16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function put32(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }

/* ------------------------------------------------------------------ *
 * inflate (RFC 1951) — the classic canonical-Huffman decoder
 * ------------------------------------------------------------------ */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths) {
  const count = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i += 1) count[lengths[i]] += 1;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len += 1) offs[len + 1] = offs[len] + count[len];
  const symbol = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i += 1) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: huffman(l), dist: huffman(d) };
  return FIXED;
}

/**
 * Decompress one raw deflate stream.
 * @param {Uint8Array} input
 * @param {number} [start] byte offset where the stream begins
 * @returns {{data: Uint8Array, end: number}} `end` is the offset just past the stream
 */
export function inflateRaw(input, start = 0) {
  let pos = start;
  let bitbuf = 0;
  let bitcnt = 0;
  let out = new Uint8Array(Math.max(1024, (input.length - start) * 3));
  let outLen = 0;

  const bits = (n) => {
    while (bitcnt < n) {
      if (pos >= input.length) throw new FormatError('unexpected end of file');
      bitbuf |= input[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  };

  const ensure = (extra) => {
    if (outLen + extra <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outLen));
    out = next;
  };

  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len += 1) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new FormatError('invalid compressed data--format violated');
  };

  const codes = (lit, dist) => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new FormatError('invalid compressed data--format violated');
        const len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
        const ds = decode(dist);
        if (ds >= 30) throw new FormatError('invalid compressed data--format violated');
        const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
        if (d > outLen) throw new FormatError('invalid compressed data--format violated');
        ensure(len);
        for (let k = 0; k < len; k += 1) { out[outLen] = out[outLen - d]; outLen += 1; }
      }
    }
  };

  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > input.length) throw new FormatError('unexpected end of file');
      const len = u16(input, pos);
      const nlen = u16(input, pos + 2);
      pos += 4;
      if (len !== (~nlen & 0xffff)) throw new FormatError('invalid compressed data--format violated');
      if (pos + len > input.length) throw new FormatError('unexpected end of file');
      ensure(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else if (type === 1) {
      const f = fixedTables();
      codes(f.lit, f.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new FormatError('invalid compressed data--format violated');
      const cl = new Uint8Array(19);
      for (let k = 0; k < ncode; k += 1) cl[CL_ORDER[k]] = bits(3);
      const clh = huffman(cl);
      const lengths = new Uint8Array(nlen + ndist);
      let k = 0;
      while (k < nlen + ndist) {
        const sym = decode(clh);
        if (sym < 16) {
          lengths[k++] = sym;
        } else {
          let rep = 0;
          let val = 0;
          if (sym === 16) {
            if (k === 0) throw new FormatError('invalid compressed data--format violated');
            val = lengths[k - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) {
            rep = 3 + bits(3);
          } else {
            rep = 11 + bits(7);
          }
          if (k + rep > nlen + ndist) throw new FormatError('invalid compressed data--format violated');
          while (rep--) lengths[k++] = val;
        }
      }
      codes(huffman(lengths.subarray(0, nlen)), huffman(lengths.subarray(nlen)));
    } else {
      throw new FormatError('invalid compressed data--format violated');
    }
  } while (!last);

  return { data: out.slice(0, outLen), end: pos };
}

/* ------------------------------------------------------------------ *
 * deflate
 * ------------------------------------------------------------------ */

/** Stored-block deflate: valid everywhere, no compression. */
function deflateStored(bytes) {
  const blocks = [];
  let off = 0;
  do {
    const len = Math.min(0xffff, bytes.length - off);
    const head = new Uint8Array(5);
    head[0] = off + len >= bytes.length ? 1 : 0;
    put16(head, 1, len);
    put16(head, 3, ~len & 0xffff);
    blocks.push(head, bytes.subarray(off, off + len));
    off += len;
  } while (off < bytes.length);
  return concat(blocks);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>} a raw deflate stream
 */
export async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* 'deflate-raw' unsupported in this browser: fall through */
    }
  }
  return deflateStored(bytes);
}

/* ------------------------------------------------------------------ *
 * gzip (RFC 1952)
 * ------------------------------------------------------------------ */

/** Latin-1 bytes for a header name field, as gzip writes it. */
function latin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {{name?: string, mtime?: number}} [meta] mtime in epoch ms; a name is stored as FNAME
 * @returns {Promise<Uint8Array>}
 */
export async function gzipEncode(bytes, { name = '', mtime = 0 } = {}) {
  const head = new Uint8Array(10);
  head[0] = 0x1f; head[1] = 0x8b; head[2] = 8;
  head[3] = name ? 0x08 : 0;
  put32(head, 4, Math.max(0, Math.floor(mtime / 1000)));
  head[8] = 0;
  head[9] = 3;                                   // OS = Unix
  const nameBytes = name ? concat([enc.encode(name), new Uint8Array(1)]) : new Uint8Array(0);
  const body = await deflateRaw(bytes);
  const tail = new Uint8Array(8);
  put32(tail, 0, crc32(bytes));
  put32(tail, 4, bytes.length >>> 0);
  return concat([head, nameBytes, body, tail]);
}

/** @param {Uint8Array} b @returns {boolean} */
export function isGzip(b) {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * Decompress every member of a gzip file.
 * @param {Uint8Array} bytes
 * @returns {{data: Uint8Array, name: string, mtime: number, warning: string, members: number, compressed: number}}
 */
export function gzipDecode(bytes) {
  if (!isGzip(bytes)) throw new FormatError('not in gzip format');
  const parts = [];
  let pos = 0;
  let name = '';
  let mtime = 0;
  let members = 0;
  let warning = '';
  let payload = 0;

  while (pos < bytes.length) {
    if (!(bytes[pos] === 0x1f && bytes[pos + 1] === 0x8b)) {
      const rest = bytes.subarray(pos);
      warning = rest.every((x) => x === 0) ? 'decompression OK, trailing zero bytes ignored' : 'decompression OK, trailing garbage ignored';
      break;
    }
    if (pos + 10 > bytes.length) throw new FormatError('unexpected end of file');
    if (bytes[pos + 2] !== 8) throw new FormatError(`unknown method ${bytes[pos + 2]} -- not supported`);
    const flags = bytes[pos + 3];
    if (flags & 0xe0) throw new FormatError('has flags 0x' + flags.toString(16) + ' -- not supported');
    const m = u32(bytes, pos + 4);
    let p = pos + 10;
    if (flags & 0x04) {
      if (p + 2 > bytes.length) throw new FormatError('unexpected end of file');
      p += 2 + u16(bytes, p);
    }
    let memberName = '';
    if (flags & 0x08) {
      const z = bytes.indexOf(0, p);
      if (z < 0) throw new FormatError('unexpected end of file');
      memberName = dec.decode(bytes.subarray(p, z));
      p = z + 1;
    }
    if (flags & 0x10) {
      const z = bytes.indexOf(0, p);
      if (z < 0) throw new FormatError('unexpected end of file');
      p = z + 1;
    }
    if (flags & 0x02) p += 2;
    const headerEnd = p;
    const { data, end } = inflateRaw(bytes, p);
    if (end + 8 > bytes.length) throw new FormatError('unexpected end of file');
    const crc = u32(bytes, end);
    const size = u32(bytes, end + 4);
    if (crc !== crc32(data)) throw new FormatError('invalid compressed data--crc error');
    if (size !== (data.length >>> 0)) throw new FormatError('invalid compressed data--length error');
    if (members === 0) { name = memberName; mtime = m * 1000; }
    payload += end - headerEnd;
    parts.push(data);
    members += 1;
    pos = end + 8;
  }
  return { data: concat(parts), name, mtime, warning, members, compressed: payload };
}

/* ------------------------------------------------------------------ *
 * tar (GNU format, as `tar` on Ubuntu writes by default)
 * ------------------------------------------------------------------ */

const BLOCK = 512;
const RECORD = BLOCK * 20;

function octal(value, width) {
  // width includes the trailing NUL
  return value.toString(8).padStart(width - 1, '0').slice(-(width - 1));
}

function writeField(buf, off, width, str) {
  const b = enc.encode(str);
  buf.set(b.subarray(0, width), off);
}

function readField(buf, off, width) {
  let end = off;
  while (end < off + width && buf[end] !== 0) end += 1;
  return dec.decode(buf.subarray(off, end));
}

function readOctal(buf, off, width) {
  if (buf[off] & 0x80) {
    // GNU base-256 for values that do not fit in octal
    let v = buf[off] & 0x7f;
    for (let i = 1; i < width; i += 1) v = v * 256 + buf[off + i];
    return v;
  }
  const s = readField(buf, off, width).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

function header({ name, type, size = 0, mode = 0o644, mtime = 0, linkname = '', uname = 'ubuntu', gname = 'ubuntu', uid = 1000, gid = 1000 }) {
  const h = new Uint8Array(BLOCK);
  writeField(h, 0, 100, name);
  writeField(h, 100, 8, octal(mode & 0o7777, 8));
  writeField(h, 108, 8, octal(uid, 8));
  writeField(h, 116, 8, octal(gid, 8));
  writeField(h, 124, 12, octal(size, 12));
  writeField(h, 136, 12, octal(Math.max(0, Math.floor(mtime / 1000)), 12));
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  writeField(h, 157, 100, linkname);
  writeField(h, 257, 8, 'ustar  ');           // GNU magic + version: "ustar  \0"
  writeField(h, 265, 32, uname);
  writeField(h, 297, 32, gname);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += h[i];
  writeField(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

function padBlock(len) {
  const rem = len % BLOCK;
  return rem ? new Uint8Array(BLOCK - rem) : new Uint8Array(0);
}

/** A GNU ././@LongLink pseudo-entry carrying a name longer than 100 bytes. */
function longLink(kind, value) {
  const data = concat([enc.encode(value), new Uint8Array(1)]);
  return [
    header({ name: '././@LongLink', type: kind, size: data.length, mode: 0, uid: 0, gid: 0, uname: 'root', gname: 'root' }),
    data,
    padBlock(data.length),
  ];
}

/**
 * @typedef {object} TarEntry
 * @property {string} name        path inside the archive; directories end in '/'
 * @property {'file'|'dir'|'symlink'} type
 * @property {Uint8Array} [data]  file contents
 * @property {string} [linkname]  symlink target
 * @property {number} [mode]
 * @property {number} [mtime]     epoch ms
 * @property {string} [uname]
 * @property {string} [gname]
 */

/**
 * @param {TarEntry[]} entries
 * @returns {Uint8Array} a complete archive, padded to a 10240-byte record
 */
export function tarPack(entries) {
  const parts = [];
  for (const e of entries) {
    const type = e.type === 'dir' ? '5' : e.type === 'symlink' ? '2' : '0';
    const data = e.type === 'file' ? (e.data || new Uint8Array(0)) : new Uint8Array(0);
    const nameBytes = enc.encode(e.name).length;
    const linkBytes = enc.encode(e.linkname || '').length;
    if (linkBytes > 100) parts.push(...longLink('K', e.linkname));
    if (nameBytes > 100) parts.push(...longLink('L', e.name));
    const uid = e.uname === 'root' ? 0 : 1000;
    parts.push(header({
      name: nameBytes > 100 ? e.name.slice(0, 100) : e.name,
      type,
      size: data.length,
      mode: e.mode === undefined ? (e.type === 'dir' ? 0o755 : 0o644) : e.mode,
      mtime: e.mtime || 0,
      linkname: linkBytes > 100 ? '' : (e.linkname || ''),
      uname: e.uname || 'ubuntu',
      gname: e.gname || e.uname || 'ubuntu',
      uid,
      gid: uid,
    }));
    if (data.length) parts.push(data, padBlock(data.length));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  let total = 0;
  for (const p of parts) total += p.length;
  if (total % RECORD) parts.push(new Uint8Array(RECORD - (total % RECORD)));
  return concat(parts);
}

function parsePax(text) {
  const out = {};
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** @param {Uint8Array} b @returns {boolean} */
export function isTar(b) {
  if (b.length < BLOCK) return false;
  const magic = dec.decode(b.subarray(257, 263));
  if (magic === 'ustar\0' || magic === 'ustar ') return true;
  // Pre-POSIX v7 archives have no magic; trust a valid checksum.
  return checksumOk(b.subarray(0, BLOCK));
}

function checksumOk(h) {
  const stored = readOctal(h, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const v = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += v;
    signed += v > 127 ? v - 256 : v;
  }
  return stored === unsigned || stored === signed;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{entries: Array<TarEntry & {size: number, typeflag: string}>, warnings: string[]}}
 */
export function tarUnpack(bytes) {
  const entries = [];
  const warnings = [];
  let pos = 0;
  let longName = null;
  let longLinkName = null;
  let pax = {};
  let sawEnd = false;

  while (pos + BLOCK <= bytes.length) {
    const h = bytes.subarray(pos, pos + BLOCK);
    if (h.every((x) => x === 0)) { sawEnd = true; break; }
    if (!checksumOk(h)) {
      if (entries.length === 0 && pos === 0) throw new FormatError('This does not look like a tar archive');
      warnings.push('Skipping to next header');
      pos += BLOCK;
      continue;
    }
    const typeflag = String.fromCharCode(h[156] || 0x30);
    let size = readOctal(h, 124, 12);
    if (pax.size !== undefined) size = Number(pax.size);
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new FormatError('Unexpected EOF in archive');
    const data = bytes.subarray(dataStart, dataEnd);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') { longName = readField(data, 0, data.length); continue; }
    if (typeflag === 'K') { longLinkName = readField(data, 0, data.length); continue; }
    if (typeflag === 'x') { pax = { ...pax, ...parsePax(dec.decode(data)) }; continue; }
    if (typeflag === 'g') continue;

    let name = readField(h, 0, 100);
    const magic = dec.decode(h.subarray(257, 263));
    if (magic === 'ustar\0') {
      const prefix = readField(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName !== null) name = longName;
    if (pax.path !== undefined) name = pax.path;
    let linkname = readField(h, 157, 100);
    if (longLinkName !== null) linkname = longLinkName;
    if (pax.linkpath !== undefined) linkname = pax.linkpath;
    let mtime = readOctal(h, 136, 12) * 1000;
    if (pax.mtime !== undefined) mtime = Math.round(Number(pax.mtime) * 1000);

    const base = {
      name,
      typeflag,
      size,
      mode: readOctal(h, 100, 8),
      mtime,
      uname: readField(h, 265, 32) || String(readOctal(h, 108, 8)),
      gname: readField(h, 297, 32) || String(readOctal(h, 116, 8)),
    };
    longName = null;
    longLinkName = null;
    pax = {};

    if (typeflag === '5' || (typeflag === '0' && name.endsWith('/'))) {
      entries.push({ ...base, type: 'dir', size: 0 });
    } else if (typeflag === '2') {
      entries.push({ ...base, type: 'symlink', linkname, size: 0 });
    } else if (typeflag === '1') {
      entries.push({ ...base, type: 'hardlink', linkname, size: 0 });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ ...base, type: 'file', data: data.slice() });
    } else {
      entries.push({ ...base, type: 'other' });
    }
  }
  if (!sawEnd && entries.length) warnings.push('A lone zero block is missing');
  return { entries, warnings };
}

/* ------------------------------------------------------------------ *
 * zip (PKWARE APPNOTE; the subset Info-ZIP writes)
 * ------------------------------------------------------------------ */

/** Local wall-clock time packed as MS-DOS date/time. */
export function toDosTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function fromDosTime(date, time) {
  return new Date(
    ((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f,
    (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2,
  ).getTime();
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name        directories end in '/'
 * @property {boolean} [dir]
 * @property {boolean} [link]    a symlink; `data` holds the target path
 * @property {Uint8Array} [data]
 * @property {number} [mode]
 * @property {number} [mtime]     epoch ms
 */

/**
 * Compress one entry, choosing store when deflate does not help, as Info-ZIP does.
 * @param {ZipEntry} e
 * @returns {Promise<{entry: ZipEntry, method: number, body: Uint8Array, crc: number, size: number}>}
 */
export async function zipPrepare(e) {
  const data = e.dir ? new Uint8Array(0) : (e.data || new Uint8Array(0));
  let method = 0;
  let body = data;
  if (data.length > 0) {
    const deflated = await deflateRaw(data);
    if (deflated.length < data.length) { method = 8; body = deflated; }
  }
  return { entry: e, method, body, crc: crc32(data), size: data.length };
}

/** 0x5455 "UT" extended timestamp: the exact UTC mtime that DOS time cannot hold. */
function utExtra(mtime) {
  const b = new Uint8Array(9);
  put16(b, 0, 0x5455);
  put16(b, 2, 5);
  b[4] = 1;
  put32(b, 5, Math.max(0, Math.floor((mtime || 0) / 1000)));
  return b;
}

/**
 * @param {Array<Awaited<ReturnType<typeof zipPrepare>>>} prepared
 * @returns {Uint8Array}
 */
export function zipPack(prepared) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const p of prepared) {
    const e = p.entry;
    const nameBytes = enc.encode(e.name);
    const utf8 = /[^\x00-\x7f]/.test(e.name) ? 0x0800 : 0;
    const { time, date } = toDosTime(e.mtime);
    const extra = utExtra(e.mtime);
    const need = p.method === 8 || e.dir ? 20 : 10;

    const lh = new Uint8Array(30);
    put32(lh, 0, 0x04034b50);
    put16(lh, 4, need);
    put16(lh, 6, utf8);
    put16(lh, 8, p.method);
    put16(lh, 10, time);
    put16(lh, 12, date);
    put32(lh, 14, p.crc);
    put32(lh, 18, p.body.length);
    put32(lh, 22, p.size);
    put16(lh, 26, nameBytes.length);
    put16(lh, 28, extra.length);
    locals.push(lh, nameBytes, extra, p.body);

    const mode = e.mode === undefined ? (e.dir ? 0o755 : 0o644) : e.mode;
    const unixType = e.dir ? 0o040000 : e.link ? 0o120000 : 0o100000;
    const ch = new Uint8Array(46);
    put32(ch, 0, 0x02014b50);
    put16(ch, 4, 0x031e);                        // made by: Unix, spec 3.0
    put16(ch, 6, need);
    put16(ch, 8, utf8);
    put16(ch, 10, p.method);
    put16(ch, 12, time);
    put16(ch, 14, date);
    put32(ch, 16, p.crc);
    put32(ch, 20, p.body.length);
    put32(ch, 24, p.size);
    put16(ch, 28, nameBytes.length);
    put16(ch, 30, extra.length);
    put16(ch, 32, 0);
    put16(ch, 34, 0);
    put16(ch, 36, 0);
    put32(ch, 38, (((unixType | mode) << 16) | (e.dir ? 0x10 : 0)) >>> 0);
    put32(ch, 42, offset);
    centrals.push(ch, nameBytes, extra);

    offset += lh.length + nameBytes.length + extra.length + p.body.length;
  }
  const cd = concat(centrals);
  const eocd = new Uint8Array(22);
  put32(eocd, 0, 0x06054b50);
  put16(eocd, 8, prepared.length);
  put16(eocd, 10, prepared.length);
  put32(eocd, 12, cd.length);
  put32(eocd, 16, offset);
  return concat([...locals, cd, eocd]);
}

/** @param {Uint8Array} b @returns {boolean} */
export function isZip(b) {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
}

/**
 * Read the central directory. Entry data is decompressed lazily by `zipExtract`.
 * @param {Uint8Array} bytes
 * @returns {Array<{name: string, dir: boolean, method: number, crc: number, csize: number, size: number, mtime: number, mode: number, offset: number}>}
 */
export function zipList(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new FormatError('End-of-central-directory signature not found.');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new FormatError('bad zipfile offset (central directory)');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const time = u16(bytes, p + 12);
    const date = u16(bytes, p + 14);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nlen = u16(bytes, p + 28);
    const elen = u16(bytes, p + 30);
    const clen = u16(bytes, p + 32);
    const madeBy = u16(bytes, p + 4) >> 8;
    const ext = u32(bytes, p + 38);
    const offset = u32(bytes, p + 42);
    const rawName = bytes.subarray(p + 46, p + 46 + nlen);
    const name = flags & 0x0800 ? dec.decode(rawName) : safeName(rawName);
    let mtime = fromDosTime(date, time);
    // Prefer the exact UTC time from a UT extra field.
    let e = p + 46 + nlen;
    const eEnd = e + elen;
    while (e + 4 <= eEnd) {
      const id = u16(bytes, e);
      const len = u16(bytes, e + 2);
      if (id === 0x5455 && len >= 5 && (bytes[e + 4] & 1)) mtime = u32(bytes, e + 5) * 1000;
      e += 4 + len;
    }
    const unixMode = madeBy === 3 ? (ext >>> 16) & 0o7777 : 0;
    const link = madeBy === 3 && ((ext >>> 16) & 0o170000) === 0o120000;
    const dir = name.endsWith('/') || (ext & 0x10) !== 0;
    entries.push({ name, dir, link, method, crc, csize, size, mtime, mode: unixMode || (dir ? 0o755 : 0o644), offset });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

function safeName(raw) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    // CP437 names from old DOS tools: keep ASCII, replace the rest
    return Array.from(raw, (c) => (c < 0x80 ? String.fromCharCode(c) : '?')).join('');
  }
}

/**
 * @param {Uint8Array} bytes the whole archive
 * @param {ReturnType<typeof zipList>[number]} entry
 * @returns {Uint8Array}
 */
export function zipExtract(bytes, entry) {
  const p = entry.offset;
  if (u32(bytes, p) !== 0x04034b50) throw new FormatError('bad zipfile offset (local header sig)');
  const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28);
  const body = bytes.subarray(start, start + entry.csize);
  let data;
  if (entry.method === 0) data = body.slice();
  else if (entry.method === 8) data = inflateRaw(body, 0).data;
  else throw new FormatError(`unsupported compression method ${entry.method}`);
  if (crc32(data) !== entry.crc) throw new FormatError(`bad CRC ${crc32(data).toString(16).padStart(8, '0')}  (should be ${entry.crc.toString(16).padStart(8, '0')})`);
  return data;
}
