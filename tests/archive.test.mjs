/**
 * tar, gzip and zip — the byte formats round-trip, and the commands behave
 * like GNU tar, gzip and Info-ZIP. Interoperability with the real tools is
 * checked by tests/differential.mjs where they are installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { boot, load, plain } from './helpers/harness.mjs';

const A = await load('js/apps/terminal/commands/archive-formats.js');
const enc = new TextEncoder();
const text = enc.encode('hello world\n'.repeat(500) + '한글 텍스트\n');
const rand = new Uint8Array(randomBytes(70000));
const empty = new Uint8Array(0);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test('crc32 check value', () => {
  assert.equal(A.crc32(enc.encode('123456789')), 0xcbf43926);
});

test('gzip round trips, keeps name and mtime, and catches corruption', async () => {
  for (const data of [text, rand, empty]) {
    const gz = await A.gzipEncode(data, { name: 'x.bin', mtime: 1700000000000 });
    const back = A.gzipDecode(gz);
    assert.ok(same(back.data, data));
    assert.equal(back.name, 'x.bin');
    assert.equal(back.mtime, 1700000000000);
  }
  const two = new Uint8Array([...(await A.gzipEncode(enc.encode('ab'))), ...(await A.gzipEncode(enc.encode('cd')))]);
  assert.equal(new TextDecoder().decode(A.gzipDecode(two).data), 'abcd', 'multi-member');
  const broken = (await A.gzipEncode(text)).slice();
  broken[broken.length - 6] ^= 0xff;
  assert.throws(() => A.gzipDecode(broken), /crc error/);
});

test('stored-block deflate fallback is still valid gzip', async () => {
  const saved = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  try {
    assert.ok(same(A.gzipDecode(await A.gzipEncode(rand)).data, rand));
  } finally {
    globalThis.CompressionStream = saved;
  }
});

test('tar round trip with long names, symlinks and modes', () => {
  const long = `proj/deep/${'x'.repeat(120)}.txt`;
  const entries = [
    { name: 'proj/', type: 'dir', mode: 0o755, mtime: 1700000000000 },
    { name: 'proj/a.txt', type: 'file', data: text, mode: 0o644, mtime: 1700000000000 },
    { name: 'proj/run.sh', type: 'file', data: enc.encode('#!/bin/sh\n'), mode: 0o755, mtime: 1700000000000 },
    { name: 'proj/link', type: 'symlink', linkname: 'a.txt', mode: 0o777, mtime: 1700000000000 },
    { name: long, type: 'file', data: rand, mode: 0o600, mtime: 1700000000000 },
  ];
  const tar = A.tarPack(entries);
  assert.equal(tar.length % 10240, 0, 'padded to a record');
  assert.ok(A.isTar(tar));
  const { entries: back } = A.tarUnpack(tar);
  assert.equal(back.length, entries.length);
  entries.forEach((e, i) => {
    assert.equal(back[i].name, e.name);
    assert.equal(back[i].type, e.type);
    assert.equal(back[i].mode, e.mode);
    assert.equal(back[i].mtime, e.mtime);
    if (e.data) assert.ok(same(back[i].data, e.data));
    if (e.linkname) assert.equal(back[i].linkname, e.linkname);
  });
});

test('zip round trip stores what does not compress', async () => {
  const items = [
    { name: 'd/', dir: true, mode: 0o755, mtime: 1700000000000 },
    { name: 'd/a.txt', data: text, mode: 0o644, mtime: 1700000000000 },
    { name: 'd/rand.bin', data: rand, mode: 0o644, mtime: 1700000000000 },
    { name: 'd/한글.txt', data: enc.encode('안녕\n'), mode: 0o600, mtime: 1700000000000 },
  ];
  const prepared = [];
  for (const it of items) prepared.push(await A.zipPrepare(it));
  assert.equal(prepared[1].method, 8);
  assert.equal(prepared[2].method, 0);
  const zip = A.zipPack(prepared);
  const list = A.zipList(zip);
  items.forEach((it, i) => {
    assert.equal(list[i].name, it.name);
    assert.equal(list[i].mode, it.mode);
    assert.equal(list[i].mtime, it.mtime);
    if (!it.dir) assert.ok(same(A.zipExtract(zip, list[i]), it.data));
  });
});

test('tar, gzip, zip and unzip commands', async () => {
  const { sh } = await boot();
  const out = async (line) => {
    const r = await sh(line);
    return plain(r.stdout);
  };
  await sh(`mkdir -p ~/w/proj/sub && cd ~/w && printf 'hello\\nworld\\n' > proj/a.txt && echo deep > proj/sub/b.txt && ln -s a.txt proj/link`);

  assert.equal(await out('tar czf proj.tgz proj && tar tzf proj.tgz'), 'proj/\nproj/a.txt\nproj/link\nproj/sub/\nproj/sub/b.txt\n');
  assert.match(await out('tar tvf proj.tgz | head -1'), /^drwxr-xr-x ubuntu\/ubuntu +0 \d{4}-\d\d-\d\d \d\d:\d\d proj\/\n$/);
  assert.equal(await out('mkdir out && tar xzf proj.tgz -C out && cat out/proj/sub/b.txt && readlink out/proj/link'), 'deep\na.txt\n');
  assert.equal(await out('tar xOzf proj.tgz proj/sub/b.txt'), 'deep\n');
  assert.equal(await out('tar cf - proj | tar tf - | wc -l'), '5\n');
  assert.equal(await out('tar --exclude="*.txt" -cf ex.tar proj && tar tf ex.tar'), 'proj/\nproj/link\nproj/sub/\n');
  let r = await sh('tar czf - proj');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Refusing to write archive contents to terminal/);
  r = await sh('tar cf x.tar nosuch');
  assert.match(r.stderr, /tar: nosuch: Cannot stat: No such file or directory/);
  assert.equal(r.code, 2);
  assert.match((await sh('tar -cjf x.tbz proj')).stderr, /bzip2/);

  assert.equal(await out('cp proj/a.txt g.txt && gzip g.txt && ls g.txt* | cat'), 'g.txt.gz\n');
  assert.equal(await out('zcat g.txt.gz'), 'hello\nworld\n');
  assert.match(await out('gzip -l g.txt.gz'), /^ {9}compressed {8}uncompressed  ratio uncompressed_name\n.* g\.txt\n$/);
  assert.equal(await out('echo hi | gzip | gunzip'), 'hi\n');
  assert.equal(await out('gzip -c proj/a.txt > h.gz && gzip -dc < h.gz'), 'hello\nworld\n');
  r = await sh('gzip -c g.txt.gz');
  assert.match(r.stderr, /compressed data not written to a terminal/);
  r = await sh('gzip g.txt.gz');
  assert.match(r.stderr, /already has \.gz suffix -- unchanged/);
  assert.equal(r.code, 2);
  assert.match((await sh('zcat proj/a.txt')).stderr, /not in gzip format/);
  assert.equal(await out('zcat -f proj/a.txt'), 'hello\nworld\n');

  assert.match(await out('zip -r p.zip proj'), /  adding: proj\/ \(stored 0%\)/);
  assert.match(await out('unzip -l p.zip'), /^Archive:  p\.zip\n  Length      Date    Time    Name\n/);
  assert.match(await out('unzip -t p.zip'), /No errors detected in compressed data of p\.zip\./);
  assert.equal(await out('mkdir z && unzip -q p.zip -d z && cat z/proj/sub/b.txt'), 'deep\n');
  r = await sh('unzip p.zip -d z', ['A']);
  assert.equal(r.prompts[0], 'replace proj/a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: ');
  assert.equal(await out('unzip -p p.zip proj/a.txt'), 'hello\nworld\n');
  r = await sh('unzip nope');
  assert.equal(r.stderr, 'unzip:  cannot find or open nope, nope.zip or nope.ZIP.\n');
  assert.equal(r.code, 9);
  assert.match(await out('zip p.zip proj/a.txt'), /updating: proj\/a\.txt/);
  assert.match(await out('zip -d p.zip "proj/sub/*"'), /deleting: proj\/sub\/b\.txt/);
  r = await sh('zip empty.zip nothing');
  assert.equal(r.code, 12);

  const f = await out('file p.tar proj.tgz p.zip 2>/dev/null; tar cf p.tar proj; file p.tar proj.tgz p.zip');
  assert.match(f, /p\.tar: +POSIX tar archive \(GNU\)/);
  assert.match(f, /proj\.tgz: gzip compressed data, from Unix, original size modulo 2\^32 10240/);
  assert.match(f, /p\.zip: +Zip archive data, at least v2\.0 to extract, compression method=store/);
});
