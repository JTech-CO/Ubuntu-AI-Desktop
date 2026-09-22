/**
 * jq — the engine against fixtures/jq-cases.json (mostly the examples from
 * the jq 1.7 manual, plus jq's exact error texts), and the command's options,
 * exit codes and install gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boot, load, plain, ROOT } from './helpers/harness.mjs';

const J = await load('js/apps/terminal/commands/jq-engine.js');
const { cases, errors } = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'jq-cases.json'), 'utf8'));

const io = {
  env: new Map([['HOME', '/home/ubuntu']]),
  named: new Map([['ARGS', new Map([['positional', []], ['named', new Map()]])]]),
  input: () => undefined,
  stderr: () => {},
};
const runJq = (program, input) => Array.from(J.run(J.compile(program, ['ARGS']), input === null ? null : J.parseJson(input), io))
  .map((v) => J.dump(v, {}));

test('jq manual examples', async (t) => {
  for (const c of cases) {
    await t.test(`${c.program}  <<< ${c.input ?? 'null'}`.slice(0, 90), () => {
      const want = c.expected.map((e) => J.dump(J.parseJson(e), {}));
      assert.deepEqual(runJq(c.program, c.input), want);
    });
  }
});

test('jq runtime error messages', async (t) => {
  for (const e of errors) {
    await t.test(e.program, () => {
      assert.throws(() => runJq(e.program, e.input), (err) => (err.value !== undefined ? err.value : err.message) === e.message);
    });
  }
});

test('jq compile errors', () => {
  for (const [prog, msg] of [
    ['.a |', 'syntax error, unexpected end of file (Unix shell quoting issues?)'],
    ['foo', 'foo/0 is not defined'],
    ['$x', '$x is not defined'],
    ['@nope', 'nope is not a valid format'],
    // not in the jq Ubuntu 24.04 ships (later additions, or removed)
    ['leaf_paths', 'leaf_paths/0 is not defined'],
    ['toarray', 'toarray/0 is not defined'],
    ['trim', 'trim/0 is not defined'],
  ]) {
    assert.throws(() => J.compile(prog, ['ARGS']), { message: msg }, prog);
  }
});

test('JSON input errors carry jq\'s positions', () => {
  for (const [text, msg] of [
    ['hello\n', 'Invalid numeric literal at line 2, column 0'],
    ['{"a":1', 'Unfinished JSON term at EOF at line 1, column 6'],
    ['[1 2]', 'Expected separator between values at line 1, column 4'],
    ['nope', 'Invalid literal at EOF at line 1, column 4'],
  ]) {
    const r = new J.JsonReader(text);
    assert.throws(() => { while (r.more()) r.next(); }, { message: msg }, text);
  }
});

test('pretty printing', () => {
  assert.equal(J.dump(J.parseJson('{"a":[1,{"b":null}],"c":{}}'), { indent: '  ' }),
    '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {}\n}');
  assert.equal(J.dump(J.parseJson('{"b":1,"2":2}'), {}), '{"b":1,"2":2}', 'insertion order, even for numeric keys');
});

test('jq the command', async () => {
  const { sh } = await boot();
  let r = await sh(`jq -n 1; echo "[$?]"`);
  assert.equal(r.stderr, "Command 'jq' not found, but can be installed with:\nsudo apt install jq\n");
  assert.equal(r.stdout, '[127]\n');
  await sh('sudo apt install -y jq', ['ubuntu']);
  assert.equal((await sh('which jq')).stdout, '/usr/bin/jq\n');
  assert.equal((await sh('jq --version')).stdout, 'jq-1.7\n', 'what Ubuntu\'s jq 1.7.1 package prints');

  r = await sh(`echo '{"a":1,"b":[1,2]}' | jq .`);
  assert.equal(plain(r.stdout), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
  assert.match(r.stdout, /\x1b\[/, 'colour on a terminal');
  assert.equal((await sh(`echo '{"a":1}' | jq . | cat`)).stdout, '{\n  "a": 1\n}\n', 'no colour into a pipe');

  await sh('export NO_COLOR=1');
  const out = async (line) => (await sh(line)).stdout;
  assert.equal(await out(`echo '{"a":"x"}' | jq -r .a`), 'x\n');
  assert.equal(await out(`echo '[1,2]' | jq -c 'map(.*10)'`), '[10,20]\n');
  assert.equal(await out(`jq -n --arg x hi '$x + "!"'`), '"hi!"\n');
  assert.equal(await out(`jq -n --argjson x '{"k":2}' '$x.k'`), '2\n');
  assert.match(await out(`jq -n -c '$ARGS' --args a b`), /"positional":\["a","b"\]/);
  assert.equal(await out(`printf '1 2 3' | jq -s -c .`), '[1,2,3]\n');
  assert.equal(await out(`printf 'a\\nb\\n' | jq -R .`), '"a"\n"b"\n');
  assert.equal(await out(`echo '{"b":1,"a":2}' | jq -S -c .`), '{"a":2,"b":1}\n');
  assert.equal(await out(`echo '[1]' | jq --tab .`), '[\n\t1\n]\n');
  assert.equal(await out(`echo '1 2' | jq -n -c '[inputs]'`), '[1,2]\n');
  assert.equal(await out(`echo '{"a":[1,2]}' | jq -c --stream .`), '[["a",0],1]\n[["a",1],2]\n[["a",1]]\n[["a"]]\n');
  assert.equal(await out(`jq . <<< '{"here":true}' | cat`), '{\n  "here": true\n}\n');

  r = await sh(`echo 'null' | jq -e .; echo "[$?]"`);
  assert.match(r.stdout, /\[1\]\n$/);
  r = await sh(`echo '1' | jq '.a'; echo "[$?]"`);
  assert.equal(r.stderr, 'jq: error (at <stdin>:1): Cannot index number with "a"\n');
  assert.equal(r.stdout, '[5]\n');
  r = await sh(`jq -n '.a |'; echo "[$?]"`);
  assert.equal(r.stderr, 'jq: error: syntax error, unexpected end of file (Unix shell quoting issues?) at <top-level>, line 1:\n.a |\njq: 1 compile error\n');
  assert.equal(r.stdout, '[3]\n');
  r = await sh(`echo 'hello' | jq .; echo "[$?]"`);
  assert.equal(r.stderr, 'jq: parse error: Invalid numeric literal at line 2, column 0\n');
  assert.equal(r.stdout, '[2]\n');
});
