/**
 * The virtual filesystem: text and binary contents, modes and times,
 * links, trash, errors, and the snapshot that persistence is built on.
 * (Saving to IndexedDB itself is exercised in the browser; Node has none.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/harness.mjs';

const { fs, FsError } = await load('js/core/fs.js');

test('text round trip, append and stat', () => {
  fs.writeFile('/tmp/t.txt', 'héllo\n');
  fs.writeFile('/tmp/t.txt', 'more\n', { append: true });
  assert.equal(fs.readFile('/tmp/t.txt'), 'héllo\nmore\n');
  const st = fs.stat('/tmp/t.txt');
  assert.equal(st.isFile, true);
  assert.equal(st.size, 12, 'size is in UTF-8 bytes');
  assert.equal(st.binary, false);
});

test('bytes: clean UTF-8 is stored as text, anything else as binary', () => {
  fs.writeBytes('/tmp/u.txt', new TextEncoder().encode('plain text\n'));
  assert.equal(fs.stat('/tmp/u.txt').binary, false);
  assert.equal(fs.readFile('/tmp/u.txt'), 'plain text\n');

  const raw = Uint8Array.from({ length: 256 }, (_, i) => i);
  fs.writeBytes('/tmp/b.bin', raw);
  const st = fs.stat('/tmp/b.bin');
  assert.equal(st.binary, true);
  assert.equal(st.size, 256);
  assert.deepEqual(Array.from(fs.readBytes('/tmp/b.bin')), Array.from(raw));
  assert.deepEqual(Array.from(fs.readBytes('/tmp/u.txt')), Array.from(new TextEncoder().encode('plain text\n')));
});

test('snapshot and restore keep binary files, modes and times', () => {
  fs.writeFile('/tmp/mode.sh', 'echo\n', { mode: 0o755 });
  fs.utimes('/tmp/mode.sh', 1700000000000);
  const snap = fs.snapshot();
  fs.writeFile('/tmp/b.bin', 'overwritten');
  fs.restore(snap);
  assert.equal(fs.stat('/tmp/b.bin').binary, true);
  assert.equal(fs.readBytes('/tmp/b.bin')[255], 255);
  assert.equal(fs.stat('/tmp/mode.sh').mode, 0o755);
  assert.equal(fs.stat('/tmp/mode.sh').mtime, 1700000000000);
});

test('directories, links and errno errors', () => {
  fs.mkdir('/tmp/d/e/f', { parents: true });
  assert.equal(fs.isDir('/tmp/d/e'), true);
  assert.throws(() => fs.mkdir('/tmp/d'), (e) => e instanceof FsError && e.code === 'EEXIST');
  assert.throws(() => fs.rmdir('/tmp/d'), (e) => e.code === 'ENOTEMPTY');
  assert.throws(() => fs.readFile('/tmp/none'), (e) => e.code === 'ENOENT' && e.message === 'No such file or directory');
  assert.throws(() => fs.readFile('/tmp/d'), (e) => e.code === 'EISDIR');

  fs.writeFile('/tmp/target.txt', 'pointed at\n');
  fs.symlink('target.txt', '/tmp/link');
  assert.equal(fs.readlink('/tmp/link'), 'target.txt');
  assert.equal(fs.readFile('/tmp/link'), 'pointed at\n');
  assert.equal(fs.lstat('/tmp/link').isLink, true);
  assert.equal(fs.stat('/tmp/link').isFile, true);

  fs.rm('/tmp/d', { recursive: true });
  assert.equal(fs.exists('/tmp/d'), false);
});

test('trash and restore', () => {
  fs.writeFile('/home/ubuntu/doomed.txt', 'bye\n');
  fs.trash('/home/ubuntu/doomed.txt');
  assert.equal(fs.exists('/home/ubuntu/doomed.txt'), false);
  const entry = fs.listTrash().find((e) => e.originalPath === '/home/ubuntu/doomed.txt');
  assert.ok(entry, 'listed in the trash');
  fs.restoreFromTrash(entry.name);
  assert.equal(fs.readFile('/home/ubuntu/doomed.txt'), 'bye\n');
});

test('utimes sets a time without following a final link', () => {
  fs.utimes('/tmp/link', 1234000);
  assert.equal(fs.lstat('/tmp/link').mtime, 1234000);
  assert.notEqual(fs.stat('/tmp/target.txt').mtime, 1234000);
});
