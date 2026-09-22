/**
 * archive.js — tar, gzip/gunzip/zcat, zip/unzip.
 *
 * The byte formats live in ./archive-formats.js; this module is the command
 * layer: option parsing, walking the virtual filesystem, and the messages
 * GNU tar, GNU gzip 1.12 and Info-ZIP print. Archives written here are real
 * files — download one and it opens on any machine.
 *
 * Binary data travels as a byte string (one char per byte) with
 * `binary: true` on the result, so `tar czf - dir | gzip -t` and
 * `gzip -c file > file.gz` keep every byte (see fs.readBytes/writeBytes).
 *
 * bzip2, xz and zstd are not implemented. Asking for them says so plainly
 * instead of pretending the tools are missing from the system.
 */

import { ok, fail } from './util.js';
import * as F from './archive-formats.js';

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

/** The umask of an ordinary Ubuntu login (002), applied like GNU tar does for non-root users. */
const UMASK = 0o002;

/** @returns {Uint8Array} */
function stdinBytes(ctx) {
  const s = ctx.stdin || '';
  return ctx.stdinBinary ? ctx.fs.byteStringToBytes(s) : encoder.encode(s);
}

/** Decode bytes as text when they are clean UTF-8 without NUL, else null. */
function asText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** A command result carrying bytes on stdout — text when it is text. */
function bytesOut(ctx, bytes, stderr = '', code = 0) {
  const text = asText(bytes);
  if (text !== null) return { stdout: text, stderr, code };
  return { stdout: ctx.fs.bytesToByteString(bytes), binary: true, stderr, code };
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

/** `-rw-r--r--` from a type letter and a mode. */
function permString(type, mode) {
  let out = type;
  for (let i = 2; i >= 0; i -= 1) {
    const b = (mode >> (i * 3)) & 7;
    out += b & 4 ? 'r' : '-';
    out += b & 2 ? 'w' : '-';
    let x = b & 1 ? 'x' : '-';
    if (i === 2 && mode & 0o4000) x = b & 1 ? 's' : 'S';
    if (i === 1 && mode & 0o2000) x = b & 1 ? 's' : 'S';
    if (i === 0 && mode & 0o1000) x = b & 1 ? 't' : 'T';
    out += x;
  }
  return out;
}

const p2 = (n) => String(n).padStart(2, '0');

/** `2024-05-01 10:00` in local time, as tar -tv and unzip -l print. */
function isoMinute(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** fnmatch without FNM_PATHNAME: `*` also matches '/', as in tar --exclude and unzip. */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) { re += '\\['; continue; }
      let body = pattern.slice(i + 1, end);
      if (body[0] === '!') body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (c === '\\' && i + 1 < pattern.length) {
      re += `\\${pattern[i + 1]}`;
      i += 1;
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Ask a y/n question on the terminal; anything but y/yes is no. */
async function confirm(ctx, prompt) {
  if (!ctx.term || typeof ctx.term.ask !== 'function') return false;
  const answer = await ctx.term.ask(prompt);
  return /^y(es)?$/i.test(String(answer || '').trim());
}

/** Make every missing directory above `abs`. */
function ensureParent(ctx, abs) {
  const parent = ctx.path.dirname(abs);
  if (!ctx.fs.exists(parent)) ctx.fs.mkdir(parent, { parents: true });
}

/* ------------------------------------------------------------------ *
 * tar
 * ------------------------------------------------------------------ */

const TAR_TRY = "Try 'tar --help' or 'tar --usage' for more information.\n";

const TAR_HELP = `Usage: tar [OPTION...] [FILE]...
GNU 'tar' saves many files together into a single tape or disk archive, and can
restore individual files from the archive.

Examples:
  tar -cf archive.tar foo bar  # Create archive.tar from files foo and bar.
  tar -tvf archive.tar         # List all files in archive.tar verbosely.
  tar -xf archive.tar          # Extract all files from archive.tar.

 Main operation mode:
  -c, --create               create a new archive
  -r, --append               append files to the end of an archive
  -t, --list                 list the contents of an archive
  -x, --extract, --get       extract files from an archive

 Common options:
  -C, --directory=DIR        change to directory DIR
  -f, --file=ARCHIVE         use archive file or device ARCHIVE
  -v, --verbose              verbosely list files processed
  -z, --gzip                 filter the archive through gzip
  -a, --auto-compress        use archive suffix to determine the compression
  -O, --to-stdout            extract files to standard output
  -k, --keep-old-files       don't replace existing files when extracting
      --exclude=PATTERN      exclude files, given as a PATTERN
      --strip-components=NUMBER   strip NUMBER leading components from file
                             names on extraction

See 'man tar' for the rest. bzip2, xz and zstd are not implemented here.
`;
const OTHER_COMPRESSION = { j: 'bzip2', J: 'xz', '--bzip2': 'bzip2', '--xz': 'xz', '--lzma': 'lzma', '--zstd': 'zstd' };

function parseTarArgs(argv) {
  const o = {
    op: null, file: null, gzip: false, other: '', verbose: 0, dir: null, strip: 0,
    toStdout: false, keepOld: false, excludes: [], auto: false, preserve: false,
    absolute: false, deref: false, files: [], error: '',
  };
  const setOp = (op) => {
    if (o.op && o.op !== op) o.error = "tar: You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option\n";
    o.op = op;
  };
  const letter = (ch) => {
    switch (ch) {
      case 'c': setOp('create'); return true;
      case 'x': setOp('extract'); return true;
      case 't': setOp('list'); return true;
      case 'r': setOp('append'); return true;
      case 'u': case 'A': case 'd': setOp(`unsupported-${ch}`); return true;
      case 'z': o.gzip = true; return true;
      case 'j': case 'J': o.other = OTHER_COMPRESSION[ch]; return true;
      case 'v': o.verbose += 1; return true;
      case 'k': o.keepOld = true; return true;
      case 'O': o.toStdout = true; return true;
      case 'p': o.preserve = true; return true;
      case 'a': o.auto = true; return true;
      case 'P': o.absolute = true; return true;
      case 'h': o.deref = true; return true;
      case 'o': case 'm': case 'w': case 'B': case 'S': case 'U': return true;
      default:
        o.error = `tar: invalid option -- '${ch}'\n`;
        return false;
    }
  };
  const withArg = (ch, value) => {
    if (value === undefined) { o.error = `tar: option requires an argument -- '${ch}'\n`; return; }
    if (ch === 'f') o.file = value;
    else if (ch === 'C') o.dir = value;
  };

  const args = argv.slice();
  // Old-style first argument: `tar czf out.tgz dir`.
  if (args.length && !args[0].startsWith('-')) {
    const bundle = args.shift();
    const pending = [];
    for (const ch of bundle) {
      if (ch === 'f' || ch === 'C') pending.push(ch);
      else if (!letter(ch)) return o;
    }
    for (const ch of pending) withArg(ch, args.shift());
  }

  let onlyFiles = false;
  for (let i = 0; i < args.length && !o.error; i += 1) {
    const a = args[i];
    if (onlyFiles || !a.startsWith('-') || a === '-') { o.files.push(a); continue; }
    if (a === '--') { onlyFiles = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq < 0 ? a : a.slice(0, eq);
      const val = eq < 0 ? undefined : a.slice(eq + 1);
      const need = () => (val !== undefined ? val : args[++i]);
      switch (key) {
        case '--create': setOp('create'); break;
        case '--extract': case '--get': setOp('extract'); break;
        case '--list': setOp('list'); break;
        case '--append': setOp('append'); break;
        case '--file': withArg('f', need()); break;
        case '--directory': withArg('C', need()); break;
        case '--gzip': case '--gunzip': case '--ungzip': o.gzip = true; break;
        case '--bzip2': case '--xz': case '--lzma': case '--zstd': o.other = OTHER_COMPRESSION[key]; break;
        case '--verbose': o.verbose += 1; break;
        case '--keep-old-files': case '--skip-old-files': o.keepOld = true; break;
        case '--to-stdout': o.toStdout = true; break;
        case '--auto-compress': o.auto = true; break;
        case '--preserve-permissions': case '--same-permissions': o.preserve = true; break;
        case '--absolute-names': o.absolute = true; break;
        case '--dereference': o.deref = true; break;
        case '--exclude': o.excludes.push(globToRegExp(need() || '')); break;
        case '--strip-components': {
          const n = Number(need());
          if (!Number.isInteger(n) || n < 0) o.error = `tar: Invalid number of elements: '${val}'\n`;
          else o.strip = n;
          break;
        }
        case '--help': o.op = 'help'; break;
        case '--version': o.op = 'version'; break;
        case '--usage': o.op = 'help'; break;
        case '--overwrite': case '--no-same-owner': case '--no-same-permissions': case '--numeric-owner':
        case '--sort': case '--totals': case '--wildcards': case '--recursion': case '--no-overwrite-dir':
          break;
        default:
          o.error = `tar: unrecognized option '${a}'\n`;
      }
      continue;
    }
    // Short cluster: -czvf out.tgz, -fout.tar, -C dir
    const cluster = a.slice(1);
    for (let k = 0; k < cluster.length && !o.error; k += 1) {
      const ch = cluster[k];
      if (ch === 'f' || ch === 'C') {
        const rest = cluster.slice(k + 1);
        withArg(ch, rest !== '' ? rest : args[++i]);
        break;
      }
      letter(ch);
    }
  }
  return o;
}

/** GNU tar's `-tv` line; `state.ugswidth` grows the way tar's column does. */
function tarLongLine(e, name, state) {
  const type = e.type === 'dir' ? 'd' : e.type === 'symlink' ? 'l' : e.type === 'hardlink' ? 'h' : '-';
  const perm = permString(type === 'h' ? '-' : type, e.mode || 0);
  const ug = `${e.uname || 'ubuntu'}/${e.gname || 'ubuntu'}`;
  const size = String(e.size || 0);
  let pad = state.ugswidth - ug.length - size.length;
  if (pad < 1) {
    state.ugswidth = ug.length + size.length + 1;
    pad = 1;
  }
  let tail = name;
  if (e.type === 'symlink') tail += ` -> ${e.linkname}`;
  if (e.type === 'hardlink') tail += ` link to ${e.linkname}`;
  return `${perm} ${ug}${' '.repeat(pad)}${size} ${isoMinute(e.mtime || 0)} ${tail}`;
}

/** Walk the named paths into tar entries. */
function tarCollect(ctx, o, base, archiveAbs) {
  const entries = [];
  let errs = '';
  let failed = false;
  let warnedSlash = false;
  const excluded = (name) => {
    if (!o.excludes.length) return false;
    const bare = name.replace(/\/+$/, '');
    const baseName = bare.slice(bare.lastIndexOf('/') + 1);
    return o.excludes.some((re) => re.test(bare) || re.test(baseName));
  };

  const add = (name, abs) => {
    if (archiveAbs && abs === archiveAbs) {
      errs += `tar: ${name}: file is the archive; not dumped\n`;
      return;
    }
    if (excluded(name)) return;
    let st;
    try {
      st = o.deref ? ctx.fs.stat(abs) : ctx.fs.lstat(abs);
    } catch (err) {
      errs += `tar: ${name}: Cannot stat: ${message(err)}\n`;
      failed = true;
      return;
    }
    const meta = { mode: st.mode, mtime: st.mtime, uname: st.owner, gname: st.group };
    if (st.isDir) {
      const dname = name === '' ? '' : `${name.replace(/\/+$/, '')}/`;
      if (dname) entries.push({ name: dname, type: 'dir', ...meta });
      let children = [];
      try {
        children = ctx.fs.readdir(abs);
      } catch (err) {
        errs += `tar: ${name}: Cannot open: ${message(err)}\n`;
        failed = true;
        return;
      }
      for (const child of children) add(`${dname}${child}`, abs === '/' ? `/${child}` : `${abs}/${child}`);
    } else if (st.isLink) {
      entries.push({ name, type: 'symlink', linkname: st.target, ...meta, mode: 0o777 });
    } else {
      let data;
      try {
        data = ctx.fs.readBytes(abs);
      } catch (err) {
        errs += `tar: ${name}: Cannot open: ${message(err)}\n`;
        failed = true;
        return;
      }
      entries.push({ name, type: 'file', data, ...meta });
    }
  };

  for (const member of o.files) {
    let name = member.replace(/\/{2,}/g, '/');
    if (name.startsWith('/') && !o.absolute) {
      name = name.replace(/^\/+/, '');
      if (!warnedSlash) {
        errs += "tar: Removing leading `/' from member names\n";
        warnedSlash = true;
      }
    }
    add(name, ctx.fs.resolve(member, base));
  }
  return { entries, errs, failed };
}

/** Read and, if needed, gunzip the archive for -t/-x/-r. */
function tarReadArchive(ctx, o, forAppend = false) {
  const fromStdin = o.file === null || o.file === '-';
  let bytes;
  if (fromStdin) {
    bytes = stdinBytes(ctx);
  } else {
    try {
      bytes = ctx.fs.readBytes(ctx.fs.resolve(o.file, ctx.cwd));
    } catch (err) {
      return { error: `tar: ${o.file}: Cannot open: ${message(err)}\ntar: Error is not recoverable: exiting now\n` };
    }
  }
  if (F.isGzip(bytes)) {
    if (forAppend) return { error: 'tar: Cannot update compressed archives\ntar: Error is not recoverable: exiting now\n' };
    try {
      bytes = F.gzipDecode(bytes).data;
    } catch (err) {
      return { error: `gzip: stdin: ${message(err)}\ntar: Child returned status 1\ntar: Error is not recoverable: exiting now\n` };
    }
  } else if (o.gzip) {
    return { error: 'gzip: stdin: not in gzip format\ntar: Child returned status 1\ntar: Error is not recoverable: exiting now\n' };
  } else if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return { error: 'tar: bzip2-compressed archives are not supported by this emulator (gzip only)\n' };
  } else if (bytes.length >= 6 && bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a) {
    return { error: 'tar: xz-compressed archives are not supported by this emulator (gzip only)\n' };
  } else if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    return { error: 'tar: zstd-compressed archives are not supported by this emulator (gzip only)\n' };
  }
  if (bytes.length === 0) {
    return { error: 'tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n' };
  }
  try {
    return { parsed: F.tarUnpack(bytes) };
  } catch (err) {
    const why = err instanceof F.FormatError ? err.message : 'This does not look like a tar archive';
    return { error: `tar: ${why}\ntar: Exiting with failure status due to previous errors\n` };
  }
}

const tar = {
  name: 'tar',
  aliases: [],
  synopsis: 'tar [OPTION...] [FILE]...',
  description: 'an archiving utility',
  man: `NAME
       tar - an archiving utility

SYNOPSIS
       tar -c [-f ARCHIVE] [OPTIONS] [FILE...]
       tar -x [-f ARCHIVE] [OPTIONS] [MEMBER...]
       tar -t [-f ARCHIVE] [OPTIONS] [MEMBER...]
       tar -r [-f ARCHIVE] [OPTIONS] [FILE...]

       Traditional usage: tar {c|x|t|r}[vzf...] [ARG...]

DESCRIPTION
       GNU tar saves many files together into a single archive, and can
       restore individual files from the archive. Archives are written in
       the GNU format and are byte-compatible with tar on a real machine.

OPERATIONS
       -c, --create        create a new archive
       -x, --extract       extract files from an archive
       -t, --list          list the contents of an archive
       -r, --append        append files to the end of an archive

OPTIONS
       -f, --file=ARCHIVE  use archive file ARCHIVE; - means stdin/stdout
                           (the default when -f is not given)
       -z, --gzip          filter the archive through gzip (detected
                           automatically when reading)
       -a, --auto-compress use the archive suffix (.tar.gz, .tgz) to decide
                           whether to compress
       -C, --directory=DIR change to DIR before creating or extracting
       -v, --verbose       list files processed; -vv for a long listing
       -O, --to-stdout     extract files to standard output
       -k, --keep-old-files
                           don't replace existing files when extracting
       -p, --preserve-permissions
                           don't apply the umask to extracted modes
       -P, --absolute-names
                           don't strip leading '/' from member names
       -h, --dereference   archive the files symlinks point to
       --exclude=PATTERN   exclude files matching the shell PATTERN
       --strip-components=N
                           strip N leading path components on extraction

       bzip2 (-j), xz (-J) and zstd are not implemented in this emulator.

EXAMPLES
       tar -cf archive.tar foo bar
              Create archive.tar from files foo and bar.
       tar -czvf project.tar.gz project/
              Create a gzip-compressed archive, listing each file.
       tar -tvf archive.tar
              List all files in archive.tar verbosely.
       tar -xf archive.tar.gz -C /tmp
              Extract all files into /tmp.

EXIT STATUS
       0 success, 1 some files differ, 2 fatal error.`,

  async run(ctx) {
    const o = parseTarArgs(ctx.argv);
    if (o.op === 'help') return ok(TAR_HELP);
    if (o.op === 'version') return ok('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.\n');
    if (o.error) return fail(`${o.error}${TAR_TRY}`, 2);
    if (!o.op) return fail(`tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\n${TAR_TRY}`, 2);
    if (o.op.startsWith('unsupported-')) return fail(`tar: -${o.op.slice(-1)} is not implemented in this emulator (use -c, -x, -t or -r)\n`, 2);
    if (o.other) return fail(`tar: ${o.other} compression is not supported by this emulator; use -z (gzip)\n`, 2);

    const base = o.dir ? ctx.fs.resolve(o.dir, ctx.cwd) : ctx.cwd;
    if (o.dir && !ctx.fs.isDir(base)) {
      return fail(`tar: ${o.dir}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n`, 2);
    }
    const toStdio = o.file === null || o.file === '-';
    const gz = o.gzip || (o.auto && !toStdio && /\.(tgz|taz|tar\.gz)$/i.test(o.file));

    /* ---- create / append ---- */
    if (o.op === 'create' || o.op === 'append') {
      if (o.files.length === 0) return fail(`tar: Cowardly refusing to create an empty archive\n${TAR_TRY}`, 2);
      if (toStdio && ctx.stdoutIsTTY) {
        return fail('tar: Refusing to write archive contents to terminal (missing -f option?)\ntar: Error is not recoverable: exiting now\n', 2);
      }
      const archiveAbs = toStdio ? null : ctx.fs.resolve(o.file, ctx.cwd);

      let prior = [];
      if (o.op === 'append') {
        if (toStdio) return fail('tar: Options \'-r\' and \'-f -\' cannot be used together\n', 2);
        if (gz) return fail('tar: Cannot update compressed archives\ntar: Error is not recoverable: exiting now\n', 2);
        if (ctx.fs.exists(archiveAbs)) {
          const read = tarReadArchive(ctx, o, true);
          if (read.error) return fail(read.error, 2);
          prior = read.parsed.entries.filter((e) => e.type !== 'other' && e.type !== 'hardlink');
        }
      }

      const { entries, errs, failed } = tarCollect(ctx, o, base, archiveAbs);
      const state = { ugswidth: 19 };
      const listing = o.verbose
        ? entries.map((e) => `${o.verbose > 1 ? tarLongLine({ ...e, size: e.data ? e.data.length : 0 }, e.name, state) : e.name}\n`).join('')
        : '';
      let bytes = F.tarPack(prior.concat(entries));
      if (gz) bytes = await F.gzipEncode(bytes);
      let stderr = errs;
      if (failed) stderr += 'tar: Exiting with failure status due to previous errors\n';
      const code = failed ? 2 : 0;

      if (toStdio) {
        return { stdout: ctx.fs.bytesToByteString(bytes), binary: true, stderr: listing + stderr, code };
      }
      try {
        ctx.fs.writeBytes(archiveAbs, bytes);
      } catch (err) {
        return fail(`${listing}tar: ${o.file}: Cannot open: ${message(err)}\ntar: Error is not recoverable: exiting now\n`, 2);
      }
      return { stdout: listing, stderr, code };
    }

    /* ---- list / extract ---- */
    const read = tarReadArchive(ctx, o);
    if (read.error) return fail(read.error, 2);
    const { entries, warnings } = read.parsed;

    const wanted = o.files.map((f) => f.replace(/\/+$/, ''));
    const matched = new Set();
    const selected = entries.filter((e) => {
      if (!wanted.length) return true;
      const bare = e.name.replace(/\/+$/, '');
      const hit = wanted.find((w) => bare === w || bare.startsWith(`${w}/`) || globToRegExp(w).test(bare));
      if (hit === undefined) return false;
      matched.add(hit);
      return true;
    });

    let stdout = '';
    let stderr = warnings.map((w) => `tar: ${w}\n`).join('');
    let failed = false;
    const state = { ugswidth: 19 };

    if (o.op === 'list') {
      for (const e of selected) stdout += `${o.verbose ? tarLongLine(e, e.name, state) : e.name}\n`;
    } else {
      // -O sends the data to stdout, so tar lists names on stderr instead.
      const listTo = (line) => {
        if (o.toStdout) stderr += line;
        else stdout += line;
      };
      const chunks = [];
      const dirTimes = [];
      let warnedSlash = false;

      for (const e of selected) {
        let name = e.name;
        if (name.startsWith('/') && !o.absolute) {
          name = name.replace(/^\/+/, '');
          if (!warnedSlash) {
            stderr += "tar: Removing leading `/' from member names\n";
            warnedSlash = true;
          }
        }
        if (!o.absolute && name.split('/').includes('..')) {
          stderr += `tar: ${e.name}: Member name contains '..'\n`;
          failed = true;
          continue;
        }
        if (o.strip) {
          const parts = name.split('/');
          const trailing = name.endsWith('/');
          const rest = parts.filter((x, idx) => !(idx === parts.length - 1 && x === '')).slice(o.strip);
          if (rest.length === 0) continue;
          name = rest.join('/') + (trailing ? '/' : '');
        }
        if (o.verbose) listTo(`${o.verbose > 1 ? tarLongLine(e, name, state) : name}\n`);

        if (o.toStdout) {
          if (e.type === 'file') chunks.push(e.data);
          continue;
        }

        const bare = name.replace(/\/+$/, '');
        if (bare === '' || bare === '.') continue;
        const target = ctx.fs.resolve(bare, base);
        const mode = (e.mode & 0o7777) & (o.preserve ? 0o7777 : ~UMASK);
        try {
          if (e.type === 'dir') {
            if (ctx.fs.lexists(target) && !ctx.fs.isDir(target)) {
              stderr += `tar: ${bare}: Cannot mkdir: File exists\n`;
              failed = true;
              continue;
            }
            ctx.fs.mkdir(target, { parents: true });
            ctx.fs.chmod(target, mode);
            dirTimes.push([target, e.mtime]);
            continue;
          }
          if (e.type === 'other') {
            stderr += `tar: ${bare}: Cannot extract -- unsupported file type '${e.typeflag}'\n`;
            failed = true;
            continue;
          }
          ensureParent(ctx, target);
          if (ctx.fs.lexists(target)) {
            if (o.keepOld) {
              stderr += `tar: ${bare}: Cannot open: File exists\n`;
              failed = true;
              continue;
            }
            if (ctx.fs.isDir(target) && !ctx.fs.isLink(target)) {
              stderr += `tar: ${bare}: Cannot open: Is a directory\n`;
              failed = true;
              continue;
            }
            ctx.fs.unlink(target);
          }
          if (e.type === 'symlink') {
            ctx.fs.symlink(e.linkname, target);
            ctx.fs.utimes(target, e.mtime);
          } else if (e.type === 'hardlink') {
            const src = ctx.fs.resolve(e.linkname, base);
            ctx.fs.writeBytes(target, ctx.fs.readBytes(src), { mode });
            ctx.fs.chmod(target, mode);
            ctx.fs.utimes(target, e.mtime);
          } else {
            ctx.fs.writeBytes(target, e.data, { mode });
            ctx.fs.chmod(target, mode);
            ctx.fs.utimes(target, e.mtime);
          }
        } catch (err) {
          stderr += `tar: ${bare}: Cannot open: ${message(err)}\n`;
          failed = true;
        }
      }
      // Directory times last: writing their contents bumped them.
      for (const [dir, mtime] of dirTimes.reverse()) {
        try { ctx.fs.utimes(dir, mtime); } catch { /* removed meanwhile */ }
      }
      if (o.toStdout) {
        let total = 0;
        for (const c of chunks) total += c.length;
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        const res = bytesOut(ctx, all);
        stdout = res.stdout;
        if (res.binary) {
          for (const w of wanted) if (!matched.has(w)) { stderr += `tar: ${w}: Not found in archive\n`; failed = true; }
          if (failed) stderr += 'tar: Exiting with failure status due to previous errors\n';
          return { stdout, binary: true, stderr, code: failed ? 2 : 0 };
        }
      }
    }

    for (const w of wanted) {
      if (!matched.has(w)) {
        stderr += `tar: ${w}: Not found in archive\n`;
        failed = true;
      }
    }
    if (failed) stderr += 'tar: Exiting with failure status due to previous errors\n';
    return { stdout, stderr, code: failed ? 2 : 0 };
  },
};

/* ------------------------------------------------------------------ *
 * gzip / gunzip / zcat
 * ------------------------------------------------------------------ */

const GZIP_HELP = `Usage: gzip [OPTION]... [FILE]...
Compress or uncompress FILEs (by default, compress FILES in-place).

Mandatory arguments to long options are mandatory for short options too.

  -c, --stdout      write on standard output, keep original files unchanged
  -d, --decompress  decompress
  -f, --force       force overwrite of output file and compress links
  -h, --help        give this help
  -k, --keep        keep (don't delete) input files
  -l, --list        list compressed file contents
  -n, --no-name     do not save or restore the original name and timestamp
  -N, --name        save or restore the original name and timestamp
  -q, --quiet       suppress all warnings
  -r, --recursive   operate recursively on directories
  -S, --suffix=SUF  use suffix SUF on compressed files
  -t, --test        test compressed file integrity
  -v, --verbose     verbose mode
  -V, --version     display version number
  -1, --fast        compress faster
  -9, --best        compress better

With no FILE, or when FILE is -, read standard input.
`;

/** gzip's `%5.1f%%` ratio. */
function ratio(original, compressed) {
  if (original === 0) return '  0.0%';
  const r = ((original - compressed) / original) * 100;
  return `${r.toFixed(1).padStart(5)}%`;
}

/** Strip a known compressed suffix: foo.gz → foo, foo.tgz → foo.tar. */
function gunzipName(name, suffix) {
  const lower = name.toLowerCase();
  if (suffix && suffix !== '.gz' && name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length);
  for (const s of ['.gz', '-gz', '.z', '-z', '_z']) {
    if (lower.endsWith(s) && name.length > s.length) return name.slice(0, -s.length);
  }
  if (lower.endsWith('.tgz') || lower.endsWith('.taz')) return `${name.slice(0, -4)}.tar`;
  return null;
}

function parseGzipArgs(argv, defaults) {
  const o = { stdout: false, decompress: false, force: false, keep: false, list: false, name: null,
    quiet: false, recursive: false, suffix: '.gz', test: false, verbose: false, files: [], error: '', help: false, version: false, ...defaults };
  let onlyFiles = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (onlyFiles || !a.startsWith('-') || a === '-') { o.files.push(a); continue; }
    if (a === '--') { onlyFiles = true; continue; }
    if (a.startsWith('--')) {
      const [key, val] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      const map = {
        '--stdout': 'stdout', '--to-stdout': 'stdout', '--decompress': 'decompress', '--uncompress': 'decompress',
        '--force': 'force', '--keep': 'keep', '--list': 'list', '--quiet': 'quiet', '--silent': 'quiet',
        '--recursive': 'recursive', '--test': 'test', '--verbose': 'verbose', '--help': 'help', '--version': 'version',
      };
      if (map[key]) o[map[key]] = true;
      else if (key === '--no-name') o.name = false;
      else if (key === '--name') o.name = true;
      else if (key === '--fast' || key === '--best' || key === '--rsyncable' || key === '--synchronous') { /* accepted */ }
      else if (key === '--suffix') o.suffix = val !== undefined ? val : argv[++i];
      else { o.error = `${o.prog}: unrecognized option '${a}'`; return o; }
      continue;
    }
    const cluster = a.slice(1);
    for (let k = 0; k < cluster.length; k += 1) {
      const ch = cluster[k];
      if (/[1-9]/.test(ch)) continue;
      if (ch === 'S') {
        const rest = cluster.slice(k + 1);
        o.suffix = rest !== '' ? rest : argv[++i];
        break;
      }
      const map = { c: 'stdout', d: 'decompress', f: 'force', k: 'keep', l: 'list', q: 'quiet', r: 'recursive', t: 'test', v: 'verbose', h: 'help', V: 'version', L: 'version' };
      if (map[ch]) o[map[ch]] = true;
      else if (ch === 'n') o.name = false;
      else if (ch === 'N') o.name = true;
      else { o.error = `${o.prog}: invalid option -- '${ch}'`; return o; }
    }
  }
  if (o.test || o.list) o.decompress = true;
  if (o.suffix === undefined || o.suffix === '') o.error = `${o.prog}: invalid suffix ''`;
  return o;
}

async function gzipMain(ctx, prog, defaults) {
  const o = parseGzipArgs(ctx.argv, { prog, ...defaults });
  if (o.help) return ok(GZIP_HELP);
  if (o.version) return ok('gzip 1.12\nCopyright (C) 2018 Free Software Foundation, Inc.\n');
  if (o.error) return fail(`${o.error}\nTry \`${prog} --help' for more information.\n`, 1);

  let stdout = [];          // Uint8Array chunks for -c / stdin mode
  let stderr = '';
  let code = 0;
  const warn = (msg) => { if (!o.quiet) stderr += `${prog}: ${msg}\n`; if (code === 0) code = 2; };
  const error = (msg) => { stderr += `${prog}: ${msg}\n`; code = 1; };

  const listRows = [];
  const listHeader = '         compressed        uncompressed  ratio uncompressed_name\n';

  /** Handle one input: bytes in, and where the output goes. */
  async function processBytes(input, label, outName, srcStat) {
    // zcat -f / gzip -dcf pass data that is not gzip through untouched.
    if (o.decompress && o.force && o.stdout && !F.isGzip(input)) return { data: input };
    if (o.decompress) {
      let res;
      try {
        res = F.gzipDecode(input);
      } catch (err) {
        error(`${label}: ${message(err)}`);
        return null;
      }
      if (res.warning) warn(`${label}: ${res.warning}`);
      if (o.list) {
        listRows.push([input.length, res.data.length, res.compressed, outName || label.replace(/\.gz$/, '')]);
        return null;
      }
      if (o.test) {
        if (o.verbose) stderr += `${label}:\t OK\n`;
        return null;
      }
      return { data: res.data, ratio: ratio(res.data.length, res.compressed), meta: res };
    }
    const data = await F.gzipEncode(input, {
      name: o.name === false || !srcStat ? '' : (srcStat.name || ''),
      mtime: o.name === false || !srcStat ? 0 : srcStat.mtime,
    });
    const headerLen = 10 + (srcStat && o.name !== false ? (encoder.encode(srcStat.name || '').length + 1) : 0);
    return { data, ratio: ratio(input.length, data.length - headerLen - 8) };
  }

  const files = o.files.length ? o.files : ['-'];

  // Compressed bytes never go to a terminal unless forced.
  const writesStdout = o.stdout || files.includes('-');
  if (!o.decompress && writesStdout && ctx.stdoutIsTTY && !o.force) {
    return fail(`${prog}: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: ${prog} -h\n`, 1);
  }

  const queue = [];
  for (const f of files) queue.push(f);

  while (queue.length) {
    const f = queue.shift();
    if (ctx.signal && ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');

    if (f === '-') {
      const input = stdinBytes(ctx);
      if (o.decompress && input.length === 0) { error('stdin: unexpected end of file'); continue; }
      const res = await processBytes(input, 'stdin', '', null);
      if (res) stdout.push(res.data);
      continue;
    }

    let abs = ctx.fs.resolve(f, ctx.cwd);
    let st;
    try {
      st = ctx.fs.lstat(abs);
    } catch {
      // zcat foo finds foo.gz
      if (o.decompress && ctx.fs.exists(`${abs}${o.suffix}`)) {
        abs = `${abs}${o.suffix}`;
        st = ctx.fs.lstat(abs);
      } else {
        error(`${f}: No such file or directory`);
        continue;
      }
    }
    const shown = abs === ctx.fs.resolve(f, ctx.cwd) ? f : `${f}${o.suffix}`;

    if (st.isDir) {
      if (!o.recursive) { warn(`${shown} is a directory -- ignored`); continue; }
      for (const child of ctx.fs.readdir(abs)) queue.push(`${shown.replace(/\/+$/, '')}/${child}`);
      continue;
    }
    if (st.isLink && !o.force && !o.stdout) { warn(`${shown} is not a directory or a regular file - ignored`); continue; }
    if (o.recursive && !o.decompress && shown.endsWith(o.suffix)) continue;

    let outName = null;
    if (o.decompress) {
      outName = gunzipName(shown, o.suffix);
      if (outName === null && !o.stdout && !o.test && !o.list) { warn(`${shown}: unknown suffix -- ignored`); continue; }
    } else if (shown.endsWith(o.suffix)) {
      warn(`${shown} already has ${o.suffix} suffix -- unchanged`);
      continue;
    } else {
      outName = `${shown}${o.suffix}`;
    }

    let input;
    try {
      input = ctx.fs.readBytes(abs);
    } catch (err) {
      error(`${shown}: ${message(err)}`);
      continue;
    }
    const res = await processBytes(input, shown, outName, { ...st, name: ctx.path.basename(abs) });
    if (!res) continue;

    if (o.stdout) {
      stdout.push(res.data);
      continue;
    }

    // In place: write the new file, carry mode and time over, drop the old one.
    let outAbs = ctx.fs.resolve(outName, ctx.cwd);
    if (o.decompress && o.name === true && res.meta && res.meta.name) {
      outAbs = ctx.path.join(ctx.path.dirname(abs), res.meta.name);
    }
    if (ctx.fs.lexists(outAbs) && !o.force) {
      const shownOut = outName;
      if (ctx.stdoutIsTTY && await confirm(ctx, `${prog}: ${shownOut} already exists; do you wish to overwrite (y or n)? `)) {
        /* overwrite */
      } else {
        stderr += ctx.stdoutIsTTY ? '\tnot overwritten\n' : `${prog}: ${shownOut} already exists; not overwritten\n`;
        if (code === 0) code = 2;
        continue;
      }
    }
    try {
      if (ctx.fs.lexists(outAbs) && !ctx.fs.isDir(outAbs)) ctx.fs.unlink(outAbs);
      ctx.fs.writeBytes(outAbs, res.data, { mode: st.mode });
      ctx.fs.chmod(outAbs, st.mode);
      const keepTime = o.decompress && o.name === true && res.meta && res.meta.mtime ? res.meta.mtime : st.mtime;
      ctx.fs.utimes(outAbs, keepTime);
      if (!o.keep) ctx.fs.unlink(abs);
    } catch (err) {
      error(`${outName}: ${message(err)}`);
      continue;
    }
    if (o.verbose) {
      stderr += `${shown}:\t${res.ratio} -- ${o.keep ? 'created' : 'replaced with'} ${outName}\n`;
    }
  }

  if (o.list) {
    let out = listHeader;
    let tc = 0;
    let tu = 0;
    let tp = 0;
    for (const [compressed, uncompressed, payload, name] of listRows) {
      out += `${String(compressed).padStart(19)} ${String(uncompressed).padStart(19)} ${ratio(uncompressed, payload)} ${name}\n`;
      tc += compressed; tu += uncompressed; tp += payload;
    }
    if (listRows.length > 1) out += `${String(tc).padStart(19)} ${String(tu).padStart(19)} ${ratio(tu, tp)} (totals)\n`;
    return { stdout: listRows.length ? out : '', stderr, code };
  }

  if (stdout.length) {
    let total = 0;
    for (const c of stdout) total += c.length;
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of stdout) { all.set(c, off); off += c.length; }
    return bytesOut(ctx, all, stderr, code);
  }
  return { stdout: '', stderr, code };
}

const gzipMan = `NAME
       gzip, gunzip, zcat - compress or expand files

SYNOPSIS
       gzip [ -cdfhklLnNrtvV19 ] [-S suffix] [ name ... ]
       gunzip [ -cfhklLnNrtvV ] [-S suffix] [ name ... ]
       zcat [ -fhLV ] [ name ... ]

DESCRIPTION
       gzip reduces the size of the named files using Lempel-Ziv coding
       (LZ77). Each file is replaced by one with the extension .gz, keeping
       the same ownership modes and modification time. The files it writes
       are standard gzip files that any gzip can read.

       gunzip restores files compressed by gzip. zcat is gunzip -c.

OPTIONS
       -c --stdout       write output on standard output; keep original files
       -d --decompress   decompress
       -f --force        force compression even if the output exists or
                         stdout is a terminal
       -k --keep         keep (don't delete) input files
       -l --list         for each compressed file, list the compressed size,
                         uncompressed size, ratio and uncompressed name
       -n --no-name      don't save/restore the original name and time
       -N --name         save/restore the original name and time
       -q --quiet        suppress all warnings
       -r --recursive    travel the directory structure recursively
       -S .suf           use suffix .suf instead of .gz
       -t --test         check the compressed file integrity
       -v --verbose      display the name and percentage reduction
       -1 .. -9          compression speed (accepted; the browser's deflate
                         uses one level)

EXIT STATUS
       0 normally, 1 if an error occurred, 2 on a warning.`;

const gzip = {
  name: 'gzip',
  aliases: [],
  synopsis: 'gzip [OPTION]... [FILE]...',
  description: 'compress or expand files',
  man: gzipMan,
  run(ctx) { return gzipMain(ctx, 'gzip', {}); },
};

const gunzip = {
  name: 'gunzip',
  aliases: [],
  synopsis: 'gunzip [OPTION]... [FILE]...',
  description: 'compress or expand files',
  man: gzipMan,
  run(ctx) { return gzipMain(ctx, 'gunzip', { decompress: true }); },
};

const zcat = {
  name: 'zcat',
  aliases: [],
  synopsis: 'zcat [OPTION]... [FILE]...',
  description: 'compress or expand files',
  man: gzipMan,
  run(ctx) { return gzipMain(ctx, 'zcat', { decompress: true, stdout: true }); },
};

/* ------------------------------------------------------------------ *
 * zip
 * ------------------------------------------------------------------ */

const ZIP_USAGE = `Copyright (c) 1990-2008 Info-ZIP - Type 'zip "-L"' for software license.
Zip 3.0 (July 5th 2008). Usage:
zip [-options] [-b path] [-t mmddyyyy] [-n suffixes] [zipfile list] [-xi list]
  The default action is to add or replace zipfile entries from list, which
  can include the special name - to compress standard input.
  If zipfile and list are omitted, zip compresses stdin to stdout.
  -f   freshen: only changed files  -u   update: only changed or new files
  -d   delete entries in zipfile    -m   move into zipfile (delete OS files)
  -r   recurse into directories     -j   junk (don't record) directory names
  -0   store only                   -l   convert LF to CR LF (-ll CR LF to LF)
  -1   compress faster              -9   compress better
  -q   quiet operation              -v   verbose operation/print version info
  -c   add one-line comments        -z   add zipfile comment
  -@   read names from stdin        -o   make zipfile as old as latest entry
  -x   exclude the following names  -i   include only the following names
  -F   fix zipfile (-FF try harder) -D   do not add directory entries
  -A   adjust self-extracting exe   -J   junk zipfile prefix (unzipsfx)
  -T   test zipfile integrity       -X   eXclude eXtra file attributes
  -y   store symbolic links as the link instead of the referenced file
  -e   encrypt                      -n   don't compress these suffixes
  -h2  show more help
`;

/** Existing archive entries, kept compressed so re-zipping never recompresses them. */
function zipLoadExisting(bytes) {
  const list = F.zipList(bytes);
  return list.map((e) => {
    const p = e.offset;
    const start = p + 30 + (bytes[p + 26] | (bytes[p + 27] << 8)) + (bytes[p + 28] | (bytes[p + 29] << 8));
    return {
      entry: { name: e.name, dir: e.dir, link: e.link, mode: e.mode, mtime: e.mtime },
      method: e.method,
      body: bytes.slice(start, start + e.csize),
      crc: e.crc,
      size: e.size,
    };
  });
}

const zip = {
  name: 'zip',
  aliases: [],
  synopsis: 'zip [-options] zipfile list',
  description: 'package and compress (archive) files',
  man: `NAME
       zip - package and compress (archive) files

SYNOPSIS
       zip [-rjqmdDy0-9] zipfile [file ...] [-x pattern ...]

DESCRIPTION
       zip is a compression and file packaging utility. It puts one or more
       files into a single zip archive, along with information about the
       files (name, path, date, time of last modification, protection).
       If the zipfile already exists, entries are added or replaced.
       If zipfile has no suffix, .zip is appended.

OPTIONS
       -r     travel the directory structure recursively
       -j     store just the name of a saved file (junk the path)
       -q     quiet mode
       -m     move the specified files into the zip archive (delete them)
       -d     remove (delete) entries from a zip archive
       -D     do not create entries for directories
       -y     store symbolic links as the link instead of the target
       -0     store only; -1 .. -9 are accepted
       -x     exclude the following names (shell patterns)

EXAMPLES
       zip -r project.zip project
       zip notes.zip *.txt
       zip -d project.zip project/tmp/*`,

  async run(ctx) {
    const argv = ctx.argv.slice();
    const o = { recurse: false, junk: false, quiet: false, move: false, del: false, noDirs: false, symlinks: false, store: false };
    const positional = [];
    const excludes = [];
    let inExclude = false;
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-x' || a === '--exclude') { inExclude = true; continue; }
      if (a.startsWith('-') && a !== '-' && a.length > 1) {
        inExclude = false;
        if (a === '-h' || a === '--help') return ok(ZIP_USAGE);
        if (a === '-v' && argv.length === 1) return ok('This is Zip 3.0 (July 5th 2008), by Info-ZIP.\n');
        for (const ch of a.slice(1)) {
          if (ch === 'r') o.recurse = true;
          else if (ch === 'j') o.junk = true;
          else if (ch === 'q') o.quiet = true;
          else if (ch === 'm') o.move = true;
          else if (ch === 'd') o.del = true;
          else if (ch === 'D') o.noDirs = true;
          else if (ch === 'y') o.symlinks = true;
          else if (ch === '0') o.store = true;
          else if (/[1-9vTXo]/.test(ch)) { /* accepted */ }
          else return fail(`\nzip error: Invalid command arguments (short option '${ch}' not supported)\n`, 16);
        }
        continue;
      }
      if (inExclude) excludes.push(globToRegExp(a));
      else positional.push(a);
    }
    if (positional.length === 0) return ok(ZIP_USAGE);

    let zipName = positional.shift();
    if (!/\.[^/]*$/.test(ctx.path.basename(zipName))) zipName += '.zip';
    const zipAbs = ctx.fs.resolve(zipName, ctx.cwd);

    let existing = [];
    if (ctx.fs.exists(zipAbs)) {
      try {
        existing = zipLoadExisting(ctx.fs.readBytes(zipAbs));
      } catch (err) {
        return fail(`\nzip error: Zip file structure invalid (${zipName})\n`, 3);
      }
    }

    let out = '';
    let err = '';
    const say = (line) => { if (!o.quiet) out += line; };

    /* ---- delete ---- */
    if (o.del) {
      if (!existing.length) return fail(`\nzip error: Nothing to do! (${zipName})\n`, 12);
      const pats = positional.map(globToRegExp);
      const keep = [];
      let removed = 0;
      for (const p of existing) {
        if (pats.some((re) => re.test(p.entry.name) || re.test(p.entry.name.replace(/\/$/, '')))) {
          say(`deleting: ${p.entry.name}\n`);
          removed += 1;
        } else keep.push(p);
      }
      if (!removed) {
        for (const n of positional) err += `\tzip warning: name not matched: ${n}\n`;
        return { stdout: out, stderr: `${err}\nzip error: Nothing to do! (${zipName})\n`, code: 12 };
      }
      ctx.fs.writeBytes(zipAbs, F.zipPack(keep));
      return { stdout: out, stderr: err, code: 0 };
    }

    /* ---- add / update ---- */
    const additions = [];                    // {name, abs, st}
    const seen = new Set();
    const excluded = (name) => excludes.some((re) => re.test(name) || re.test(name.replace(/\/$/, '')));
    const visit = (name, abs, top) => {
      let st;
      try {
        st = o.symlinks ? ctx.fs.lstat(abs) : ctx.fs.stat(abs);
      } catch {
        if (top) err += `\tzip warning: name not matched: ${name}\n`;
        return;
      }
      if (abs === zipAbs) return;
      let entryName = name.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
      if (o.junk) entryName = ctx.path.basename(entryName);
      if (st.isDir) {
        const dname = `${entryName.replace(/\/+$/, '')}/`;
        if (!o.junk && !o.noDirs && dname !== '/' && dname !== './' && !excluded(dname) && !seen.has(dname)) {
          seen.add(dname);
          additions.push({ name: dname, abs, st });
        }
        if (!o.recurse) return;
        for (const child of ctx.fs.readdir(abs)) {
          visit(`${name.replace(/\/+$/, '')}/${child}`, abs === '/' ? `/${child}` : `${abs}/${child}`, false);
        }
        return;
      }
      if (excluded(entryName) || seen.has(entryName)) return;
      seen.add(entryName);
      additions.push({ name: entryName, abs, st });
    };
    for (const p of positional) visit(p, ctx.fs.resolve(p, ctx.cwd), true);

    if (!additions.length) {
      return { stdout: out, stderr: `${err}\nzip error: Nothing to do! (${zipName})\n`, code: 12 };
    }

    const byName = new Map(existing.map((p, i) => [p.entry.name, i]));
    const result = existing.slice();
    for (const a of additions) {
      if (ctx.signal && ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
      const isDir = a.name.endsWith('/');
      let data = new Uint8Array(0);
      let mode = a.st.mode;
      const link = !isDir && a.st.isLink;
      if (!isDir) {
        if (link) {
          data = encoder.encode(a.st.target || '');
          mode = 0o777;
        } else {
          try {
            data = ctx.fs.readBytes(a.abs);
          } catch (e) {
            err += `\tzip warning: could not open for reading: ${a.name}\n`;
            continue;
          }
        }
      }
      let prepared = await F.zipPrepare({ name: a.name, dir: isDir, link, data, mode: mode & 0o7777, mtime: a.st.mtime });
      if (o.store && prepared.method !== 0) prepared = { ...prepared, method: 0, body: data };
      const verb = byName.has(a.name) ? 'updating' : '  adding';
      const how = prepared.method === 8
        ? `deflated ${Math.round((1 - prepared.body.length / Math.max(1, prepared.size)) * 100)}%`
        : 'stored 0%';
      say(`${verb}: ${a.name} (${how})\n`);
      if (byName.has(a.name)) result[byName.get(a.name)] = prepared;
      else { byName.set(a.name, result.length); result.push(prepared); }
    }

    try {
      ctx.fs.writeBytes(zipAbs, F.zipPack(result));
    } catch (e) {
      return { stdout: out, stderr: `${err}zip I/O error: ${message(e)}\n`, code: 15 };
    }
    if (o.move) {
      for (const a of additions.slice().reverse()) {
        try {
          if (a.name.endsWith('/')) {
            if (ctx.fs.readdir(a.abs).length === 0) ctx.fs.rmdir(a.abs);
          } else ctx.fs.unlink(a.abs);
        } catch { /* leave it */ }
      }
    }
    return { stdout: out, stderr: err, code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * unzip
 * ------------------------------------------------------------------ */

const UNZIP_USAGE = `UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.

Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]
  Default action is to extract files in list, except those in xlist, to exdir;
  file[.zip] may be a wildcard.  -Z => ZipInfo mode ("unzip -Z" for usage).

  -p  extract files to pipe, no messages     -l  list files (short format)
  -f  freshen existing files, create none    -t  test compressed archive data
  -u  update files, create if necessary      -z  display archive comment only
  -v  list verbosely/show version info       -T  timestamp archive to latest
  -x  exclude files that follow (in xlist)   -d  extract files into exdir
modifiers:
  -n  never overwrite existing files         -q  quiet mode (-qq => quieter)
  -o  overwrite files WITHOUT prompting      -a  auto-convert any text files
  -j  junk paths (do not make directories)   -aa treat ALL files as text
  -C  match filenames case-insensitively     -L  make (some) names lowercase

Examples (see unzip.txt for more info):
  unzip data1 -x joe   => extract all files except joe from zipfile data1.zip
  unzip -p foo | more  => send contents of foo.zip via pipe into program more
  unzip -fo foo ReadMe => quietly replace existing ReadMe if archive file newer
`;

const unzip = {
  name: 'unzip',
  aliases: [],
  synopsis: 'unzip [-opts] file[.zip] [list] [-x xlist] [-d exdir]',
  description: 'list, test and extract compressed files in a ZIP archive',
  man: `NAME
       unzip - list, test and extract compressed files in a ZIP archive

SYNOPSIS
       unzip [-lptqonj] file[.zip] [file(s) ...] [-x xfile(s) ...] [-d exdir]

DESCRIPTION
       unzip will list, test, or extract files from a ZIP archive. The
       default behavior (with no options) is to extract into the current
       directory (and subdirectories below it) all files from the archive.

OPTIONS
       -l     list archive files (short format)
       -t     test archive files: extract in memory and check each CRC
       -p     extract files to stdout, with no messages
       -d exdir
              extract files into exdir
       -o     overwrite existing files without prompting
       -n     never overwrite existing files
       -j     junk paths: extract every file into the same directory
       -q     perform operations quietly (-qq = even quieter)
       -x     exclude the files that follow

       Without -o or -n, each existing file prompts:
       replace NAME? [y]es, [n]o, [A]ll, [N]one, [r]ename

EXIT STATUS
       0 success, 1 warnings, 2 a generic error in the zipfile format,
       9 the zipfile was not found, 11 no matching files.`,

  async run(ctx) {
    const argv = ctx.argv.slice();
    if (argv.length === 0) return ok(UNZIP_USAGE);
    const o = { list: false, test: false, pipe: false, overwrite: null, junk: false, quiet: 0, exdir: null };
    const positional = [];
    const excludes = [];
    let inExclude = false;
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-x') { inExclude = true; continue; }
      if (a === '-d') { o.exdir = argv[++i]; inExclude = false; continue; }
      if (a.startsWith('-d') && a.length > 2) { o.exdir = a.slice(2); continue; }
      if (a.startsWith('-') && a.length > 1) {
        inExclude = false;
        if (a === '-h' || a === '--help') return ok(UNZIP_USAGE);
        for (const ch of a.slice(1)) {
          if (ch === 'l' || ch === 'v' || ch === 'Z') o.list = true;
          else if (ch === 't') o.test = true;
          else if (ch === 'p') o.pipe = true;
          else if (ch === 'o') o.overwrite = 'all';
          else if (ch === 'n') o.overwrite = 'none';
          else if (ch === 'j') o.junk = true;
          else if (ch === 'q') o.quiet += 1;
          else if (/[aCLXKfuT]/.test(ch)) { /* accepted */ }
          else return fail(`unzip:  error in option -${ch}\n`, 10);
        }
        continue;
      }
      if (inExclude) excludes.push(globToRegExp(a));
      else positional.push(a);
    }
    if (!positional.length) return ok(UNZIP_USAGE);

    const given = positional.shift();
    const includes = positional.map(globToRegExp);
    let archiveName = given;
    let abs = ctx.fs.resolve(given, ctx.cwd);
    if (!ctx.fs.isFile(abs)) {
      for (const suffix of ['.zip', '.ZIP']) {
        if (ctx.fs.isFile(`${abs}${suffix}`)) { abs = `${abs}${suffix}`; archiveName = `${given}${suffix}`; break; }
      }
    }
    if (!ctx.fs.isFile(abs)) {
      return fail(`unzip:  cannot find or open ${given}, ${given}.zip or ${given}.ZIP.\n`, 9);
    }
    const bytes = ctx.fs.readBytes(abs);
    let entries;
    try {
      entries = F.zipList(bytes);
    } catch {
      return {
        stdout: `Archive:  ${archiveName}\n`,
        stderr: '  End-of-central-directory signature not found.  Either this file is not\n'
          + '  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n'
          + '  latter case the central directory and zipfile comment will be found on\n'
          + '  the last disk(s) of this archive.\n'
          + `unzip:  cannot find zipfile directory in one of ${archiveName} or\n`
          + `        ${archiveName}.zip, and cannot find ${archiveName}.ZIP, period.\n`,
        code: 9,
      };
    }

    const matchedPatterns = new Set();
    const chosen = entries.filter((e) => {
      if (excludes.some((re) => re.test(e.name))) return false;
      if (!includes.length) return true;
      const idx = includes.findIndex((re) => re.test(e.name));
      if (idx < 0) return false;
      matchedPatterns.add(idx);
      return true;
    });
    const unmatched = positional.filter((_, i) => !matchedPatterns.has(i));
    const unmatchedMsg = unmatched.map((n) => `caution: filename not matched:  ${n}\n`).join('');

    /* ---- list ---- */
    if (o.list) {
      let out = o.quiet ? '' : `Archive:  ${archiveName}\n`;
      out += '  Length      Date    Time    Name\n---------  ---------- -----   ----\n';
      let total = 0;
      for (const e of chosen) {
        out += `${String(e.size).padStart(9)}  ${isoMinute(e.mtime)}   ${e.name}\n`;
        total += e.size;
      }
      out += `---------                     -------\n${String(total).padStart(9)}                     ${chosen.length} file${chosen.length === 1 ? '' : 's'}\n`;
      return { stdout: out, stderr: unmatchedMsg, code: unmatched.length ? 11 : 0 };
    }

    /* ---- test ---- */
    if (o.test) {
      let out = o.quiet ? '' : `Archive:  ${archiveName}\n`;
      let bad = 0;
      for (const e of chosen) {
        if (e.dir) continue;
        try {
          F.zipExtract(bytes, e);
          if (!o.quiet) out += `    testing: ${e.name.padEnd(23)}  OK\n`;
        } catch (err) {
          out += `    testing: ${e.name.padEnd(23)}  ${message(err)}\n`;
          bad += 1;
        }
      }
      if (bad) out += `At least one error was detected in ${archiveName}.\n`;
      else if (o.quiet < 2) out += `No errors detected in compressed data of ${archiveName}.\n`;
      return { stdout: out, stderr: unmatchedMsg, code: bad ? 2 : unmatched.length ? 11 : 0 };
    }

    /* ---- pipe ---- */
    if (o.pipe) {
      const parts = [];
      let stderr = unmatchedMsg;
      for (const e of chosen) {
        if (e.dir) continue;
        try { parts.push(F.zipExtract(bytes, e)); } catch (err) { stderr += `  error:  ${e.name}: ${message(err)}\n`; }
      }
      let total = 0;
      for (const p of parts) total += p.length;
      const all = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { all.set(p, off); off += p.length; }
      return bytesOut(ctx, all, stderr, unmatched.length ? 11 : 0);
    }

    /* ---- extract ---- */
    // Progress goes out as it happens so the replace prompt appears in order.
    const say = (line) => { if (!o.quiet) ctx.term.write(line); };
    say(`Archive:  ${archiveName}\n`);
    const base = o.exdir ? ctx.fs.resolve(o.exdir, ctx.cwd) : ctx.cwd;
    if (o.exdir && !ctx.fs.exists(base)) ctx.fs.mkdir(base, { parents: true });
    let stderr = '';
    let code = 0;
    let policy = o.overwrite;          // null = ask, 'all', 'none'
    const dirTimes = [];

    for (const e of chosen) {
      if (ctx.signal && ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
      let name = e.name;
      if (name.startsWith('/')) {
        stderr += `warning:  stripped absolute path spec from ${name}\n`;
        name = name.replace(/^\/+/, '');
        code = Math.max(code, 1);
      }
      if (name.split('/').includes('..')) {
        stderr += `warning:  skipped "../" path component(s) in ${name}\n`;
        name = name.split('/').filter((x) => x !== '..').join('/');
        code = Math.max(code, 1);
      }
      if (o.junk) {
        if (e.dir) continue;
        name = ctx.path.basename(name);
      }
      if (!name || name === '/') continue;
      let target = ctx.fs.resolve(name.replace(/\/+$/, ''), base);

      try {
        if (e.dir) {
          if (!ctx.fs.exists(target)) {
            ctx.fs.mkdir(target, { parents: true });
            say(`   creating: ${name}\n`);
          }
          dirTimes.push([target, e.mtime]);
          continue;
        }
        if (ctx.fs.lexists(target)) {
          let decision = policy === 'all' ? 'y' : policy === 'none' ? 'n' : null;
          while (decision === null) {
            const answer = String(await ctx.term.ask(`replace ${name}? [y]es, [n]o, [A]ll, [N]one, [r]ename: `) || '').trim();
            if (answer === 'y' || answer === 'yes') decision = 'y';
            else if (answer === 'n' || answer === 'no') decision = 'n';
            else if (answer === 'A') { policy = 'all'; decision = 'y'; }
            else if (answer === 'N') { policy = 'none'; decision = 'n'; }
            else if (answer === 'r') {
              const fresh = String(await ctx.term.ask('new name: ') || '').trim();
              if (fresh) {
                name = fresh;
                target = ctx.fs.resolve(fresh, base);
                decision = ctx.fs.lexists(target) ? null : 'y';
              }
            } else if (answer === '') {
              // EOF / non-interactive: unzip treats it as "no"
              decision = 'n';
            } else {
              say(`error:  invalid response [${answer}]\n`);
            }
          }
          if (decision === 'n') continue;
          if (ctx.fs.isDir(target) && !ctx.fs.isLink(target)) {
            stderr += `error:  cannot create ${name}\n        Is a directory\n`;
            code = Math.max(code, 1);
            continue;
          }
          ctx.fs.unlink(target);
        }
        const data = F.zipExtract(bytes, e);
        ensureParent(ctx, target);
        if (e.link) {
          ctx.fs.symlink(new TextDecoder().decode(data), target);
          say(`    linking: ${name}  -> ${new TextDecoder().decode(data)} \n`);
          continue;
        }
        const mode = (e.mode & 0o7777) || 0o644;
        ctx.fs.writeBytes(target, data, { mode });
        ctx.fs.chmod(target, mode & ~UMASK);
        ctx.fs.utimes(target, e.mtime);
        say(`${e.method === 0 ? ' extracting' : '  inflating'}: ${name}\n`);
      } catch (err) {
        stderr += err instanceof F.FormatError
          ? `  error:  invalid compressed data to inflate ${name}\n`
          : `error:  cannot create ${name}\n        ${message(err)}\n`;
        code = Math.max(code, 2);
      }
    }
    for (const [dir, mtime] of dirTimes.reverse()) {
      try { ctx.fs.utimes(dir, mtime); } catch { /* removed meanwhile */ }
    }
    if (unmatched.length) {
      stderr += unmatchedMsg;
      code = Math.max(code, 11);
    }
    return { stdout: '', stderr, code };
  },
};

export default [tar, gzip, gunzip, zcat, zip, unzip];
