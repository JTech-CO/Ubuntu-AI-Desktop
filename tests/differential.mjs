/**
 * tests/differential.mjs — compare the emulator with the real programs.
 *
 *   node tests/differential.mjs
 *
 * Runs whatever is installed: the awk fixtures through the system's awk
 * (mawk first, as Ubuntu's /usr/bin/awk), the jq fixtures through jq, and
 * archives both ways through tar, gzip and unzip. Anything missing is
 * skipped. Cases with a `note` in a fixture are known, documented
 * differences and are reported but not counted.
 *
 * Exits 1 when an undocumented difference is found. CI runs this on
 * Ubuntu 24.04, where mawk 1.3.4 and jq 1.7.1 are the real references.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { boot, load, q, ROOT } from './helpers/harness.mjs';

const has = (cmd, args = ['--version']) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !r.error && (r.status === 0 || r.status === 2);
};
const tmp = mkdtempSync(path.join(os.tmpdir(), 'uad-diff-'));
const real = (p) => path.join(tmp, p.replace(/^\/+/, '').replace(/\//g, '_')).replace(/\\/g, '/');

let differences = 0;
let documented = 0;
const report = (area, label, ours, theirs, note) => {
  if (note) {
    documented += 1;
    console.log(`  [known] ${area}: ${label}\n          ${note}`);
    return;
  }
  differences += 1;
  console.log(`  [DIFF]  ${area}: ${label}\n          ours:   ${JSON.stringify(ours)}\n          theirs: ${JSON.stringify(theirs)}`);
};

/* ------------------------------------------------------------------ awk */

// UAD_AWK / UAD_JQ pick an exact binary (CI uses Ubuntu's /usr/bin ones, not
// the runner's own jq 1.7 in /usr/local/bin).
const awkBin = [process.env.UAD_AWK, 'mawk', 'awk', 'gawk'].filter(Boolean).find((b) => has(b, ['-W', 'version']) || has(b));
const jqBin = process.env.UAD_JQ || 'jq';
if (awkBin) {
  const version = spawnSync(awkBin, ['-W', 'version'], { encoding: 'utf8' }).stdout.split('\n')[0]
    || spawnSync(awkBin, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  console.log(`awk: comparing with ${awkBin} (${version.trim()})`);
  const cases = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'awk-cases.json'), 'utf8'));
  const { sh, fs } = await boot();
  let n = 0;
  for (const c of cases) {
    for (const [p, text] of Object.entries(c.files || {})) {
      fs.writeFile(p, text);
      writeFileSync(real(p), text);
    }
    fs.writeFile('/tmp/awk-in', c.stdin || '');
    const line = c.args ? `awk ${q(c.program)} ${c.args.join(' ')}` : `awk ${q(c.program)} < /tmp/awk-in`;
    const ours = (await sh(line)).stdout;
    let prog = c.program;
    for (const p of ['/tmp/awk-out.txt']) prog = prog.replaceAll(p, real(p));
    const r = spawnSync(awkBin, [prog, ...(c.args || []).map(real)], { input: c.stdin || '', encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' } });
    n += 1;
    if (r.stdout !== ours) report('awk', c.program, ours, r.stdout, c.note);
  }
  console.log(`awk: ${n} programs checked`);
} else {
  console.log('awk: no awk installed — skipped');
}

/* ------------------------------------------------------------------- jq */

if (has(jqBin)) {
  const version = spawnSync(jqBin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  console.log(`jq: comparing with ${version} (${jqBin})`);
  const J = await load('js/apps/terminal/commands/jq-engine.js');
  const { cases } = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'jq-cases.json'), 'utf8'));
  const io = { env: new Map(Object.entries(process.env)), named: new Map([['ARGS', new Map([['positional', []], ['named', new Map()]])]]), input: () => undefined, stderr: () => {} };
  const toPlain = (text) => text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  let n = 0;
  for (const c of cases) {
    if (/\$ENV|env\.|input_filename|now|\$__loc__/.test(c.program)) continue;
    const args = c.input === null ? ['-n', '-c', c.program] : ['-c', c.program];
    const r = spawnSync(jqBin, args, { input: c.input === null ? '' : c.input, encoding: 'utf8' });
    let ours;
    try {
      ours = Array.from(J.run(J.compile(c.program, ['ARGS']), c.input === null ? null : J.parseJson(c.input), io)).map((v) => J.dump(v, {})).join('\n');
    } catch (err) {
      ours = `error: ${err.value !== undefined ? JSON.stringify(err.value) : err.message}`;
    }
    n += 1;
    let same;
    try {
      same = r.status === 0 && isDeepStrictEqual(toPlain(ours), toPlain(r.stdout));
    } catch {
      same = false;
    }
    if (!same) report('jq', c.program, ours, r.status === 0 ? r.stdout.trim() : `exit ${r.status}: ${r.stderr.trim()}`, c.note);
  }
  console.log(`jq: ${n} filters checked`);
} else {
  console.log('jq: not installed — skipped');
}

/* ------------------------------------------------------------- archives */

const A = await load('js/apps/terminal/commands/archive-formats.js');
const enc = new TextEncoder();
const sample = enc.encode('hello world\n'.repeat(300) + '한글\n');
const dir = path.join(tmp, 'arc');
mkdirSync(dir, { recursive: true });

if (has('gzip')) {
  const gzPath = path.join(dir, 'ours.gz');
  writeFileSync(gzPath, await A.gzipEncode(sample, { name: 'sample.txt', mtime: 1700000000000 }));
  const t = spawnSync('gzip', ['-t', gzPath], { encoding: 'utf8' });
  if (t.status !== 0) report('gzip', 'gzip -t on our .gz', 'ok', t.stderr);
  const d = spawnSync('gzip', ['-dc', gzPath]);
  if (Buffer.compare(d.stdout, Buffer.from(sample)) !== 0) report('gzip', 'gzip -dc of our .gz', 'sample', 'different bytes');
  const theirs = spawnSync('gzip', ['-9', '-c'], { input: Buffer.from(sample) }).stdout;
  const back = A.gzipDecode(new Uint8Array(theirs)).data;
  if (Buffer.compare(Buffer.from(back), Buffer.from(sample)) !== 0) report('gzip', 'decoding gzip -9 output', 'sample', 'different bytes');
  console.log('gzip: checked both ways');
}

if (has('tar')) {
  const tarPath = path.join(dir, 'ours.tar');
  writeFileSync(tarPath, A.tarPack([
    { name: 'p/', type: 'dir', mode: 0o755, mtime: 1700000000000 },
    { name: 'p/a.txt', type: 'file', data: sample, mode: 0o644, mtime: 1700000000000 },
    { name: `p/${'x'.repeat(120)}.txt`, type: 'file', data: sample, mode: 0o600, mtime: 1700000000000 },
  ]));
  // Relative names with cwd: on Windows, GNU tar reads "C:\…" as host:path.
  const list = spawnSync('tar', ['-tf', path.basename(tarPath)], { cwd: dir, encoding: 'utf8' });
  const want = `p/\np/a.txt\np/${'x'.repeat(120)}.txt\n`;
  if (list.stdout.replace(/\r/g, '') !== want) report('tar', 'tar -tf on our archive', want, list.stdout + list.stderr);
  const src = path.join(dir, 'src');
  mkdirSync(path.join(src, 'sub'), { recursive: true });
  writeFileSync(path.join(src, 'sub', 'f.txt'), sample);
  const made = path.join(dir, 'theirs.tgz');
  spawnSync('tar', ['-czf', '../theirs.tgz', 'sub'], { cwd: src });
  const names = A.tarUnpack(A.gzipDecode(new Uint8Array(readFileSync(made))).data).entries.map((e) => e.name).join(' ');
  if (!names.includes('sub/f.txt')) report('tar', 'reading tar -czf output', 'sub/ sub/f.txt', names);
  console.log('tar: checked both ways');
}

if (has('unzip', ['-v'])) {
  const prepared = [];
  for (const e of [{ name: 'z/', dir: true, mtime: 1700000000000 }, { name: 'z/a.txt', data: sample, mtime: 1700000000000 }]) prepared.push(await A.zipPrepare(e));
  const zipPath = path.join(dir, 'ours.zip');
  writeFileSync(zipPath, A.zipPack(prepared));
  const t = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  if (!/No errors detected/.test(t.stdout)) report('zip', 'unzip -t on our .zip', 'No errors detected', t.stdout + t.stderr);
  console.log('zip: checked with unzip');
}

console.log(`\n${differences} undocumented difference(s), ${documented} documented.`);
process.exit(differences ? 1 : 0);
