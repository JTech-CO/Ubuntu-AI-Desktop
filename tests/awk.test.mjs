/**
 * awk — every program in fixtures/awk-cases.json must print what GNU awk
 * printed for it (tests/differential.mjs regenerates that comparison against
 * whatever real awk is installed). Cases with a `note` document where the
 * emulator follows mawk-on-a-terminal instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boot, q, ROOT } from './helpers/harness.mjs';

const cases = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'awk-cases.json'), 'utf8'));
const { sh, fs } = await boot();

test('awk programs match GNU awk', async (t) => {
  for (const c of cases) {
    await t.test(c.program.slice(0, 70), async () => {
      for (const [p, text] of Object.entries(c.files || {})) fs.writeFile(p, text);
      fs.writeFile('/tmp/awk-in', c.stdin || '');
      const line = c.args ? `awk ${q(c.program)} ${c.args.join(' ')}` : `awk ${q(c.program)} < /tmp/awk-in`;
      const r = await sh(line);
      assert.equal(r.stdout, c.expect, r.stderr);
    });
  }
});

test('awk errors read like mawk', async () => {
  let r = await sh(`awk 'BEGIN{print 1/0}'`);
  assert.equal(r.stderr, 'awk: division by zero\n');
  assert.equal(r.code, 2);
  r = await sh(`awk 'BEGIN{print 1%0}'`);
  assert.equal(r.stderr, 'awk: division by zero in %\n');
  r = await sh(`awk 'BEGIN{x = }'`);
  assert.equal(r.stderr, 'awk: line 1: syntax error at or near }\n');
  r = await sh(`awk '{print $1'`);
  assert.match(r.stderr, /^awk: line 1: syntax error at or near/);
  r = await sh(`awk 'BEGIN{f()}'`);
  assert.equal(r.stderr, 'awk: line 1: function f never defined\n');
  r = await sh(`awk 'BEGIN{printf "%s %s\\n", "a"}'`);
  assert.match(r.stderr, /^awk: run time error: not enough arguments passed to printf\("%s %s/);
  assert.match(r.stderr, /FILENAME="" FNR=0 NR=0/);
  r = await sh(`awk '{print}' nofile`);
  assert.equal(r.stderr, 'awk: cannot open nofile (No such file or directory)\n');
  assert.equal(r.code, 2);
  r = await sh(`awk 'BEGIN { x = 1; x[1] = 2 }'`);
  assert.match(r.stderr, /can't use scalar x as array/);
});

test('awk options', async () => {
  assert.equal((await sh(`awk -W version | head -1`)).stdout, 'mawk 1.3.4 20240123\n');
  assert.match((await sh('awk')).stderr, /^Usage: mawk \[Options\] \[Program\] \[file \.\.\.\]/);
  assert.equal((await sh(`awk -v x=5 -v s='a\\tb' 'BEGIN{print x*2, s}'`)).stdout, '10 a\tb\n');
  assert.equal((await sh(`awk -v bad`)).stderr, 'awk: improper assignment: -v bad\n');
  assert.equal((await sh(`printf 'a:b:c\\n' | awk -F: '{print $2}'`)).stdout, 'b\n');
  assert.equal((await sh(`printf 'a\\tb c\\n' | awk -F'\\t' '{print $2}'`)).stdout, 'b c\n');
  assert.equal((await sh(`printf 'x y\\n' | awk '{print v, $2}' v=1`)).stdout, '1 y\n');
  assert.equal((await sh(`echo 'BEGIN { print "from file" }' > p.awk && awk -f p.awk`)).stdout, 'from file\n');
  assert.equal((await sh(`mawk 'BEGIN{print "m"}'; nawk 'BEGIN{print "n"}'`)).stdout, 'm\nn\n');
});

test('awk getline, system, pipes and files', async () => {
  await sh(`printf '1\\n2\\n3\\n' > n.txt`);
  assert.equal((await sh(`awk '{s+=$1} END{print s, NR, FILENAME}' n.txt n.txt`)).stdout, '12 6 n.txt\n');
  assert.equal((await sh(`awk 'BEGIN{while((getline l < "n.txt")>0) s=s l; print s}'`)).stdout, '123\n');
  assert.equal((await sh(`awk 'BEGIN{print (getline l < "missing")}'`)).stdout, '-1\n');
  assert.equal((await sh(`awk '{print > "out_" $1 ".txt"}' n.txt && cat out_2.txt`)).stdout, '2\n');
  const both = await sh(`awk 'BEGIN{print "err" > "/dev/stderr"; print "out"}'`);
  assert.equal(both.stdout, 'out\n');
  assert.equal(both.stderr, 'err\n');
  assert.equal((await sh(`awk 'BEGIN{r = system("exit 3"); print r}'`)).stdout, '3\n');
  assert.equal((await sh(`printf 'b\\na\\n' | awk '{print | "sort"} END{close("sort"); print "done"}'`)).stdout, 'a\nb\ndone\n');
  assert.equal((await sh(`echo 65 | awk '{printf "%c\\n", $1}'`)).stdout, 'A\n');
  assert.equal((await sh(`awk 'BEGIN{print ARGC, ARGV[0], ARGV[1]}' foo`)).stdout, '2 awk foo\n');
});

test('FS changes apply from the next record', async () => {
  assert.equal((await sh(`printf 'a:b\\nc:d\\n' | awk '{FS=":"; print $1}'`)).stdout, 'a:b\nc\n');
});

test('awk keeps up with a 20,000-line pipe', async () => {
  const t0 = Date.now();
  const r = await sh(`seq 1 20000 | awk '{ s += $1; c[$1 % 7]++ } END { print s, c[0] }'`);
  assert.equal(r.stdout, '200010000 2857\n');
  assert.ok(Date.now() - t0 < 10000, 'too slow');
});
