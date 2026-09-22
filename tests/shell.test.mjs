/**
 * The shell: expansion, pipes, redirection, here-documents, comments,
 * running programs by path, command-not-found text, and the small tools
 * that pipelines lean on (env, printenv, expr, xargs, clear, wc).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, load, plain } from './helpers/harness.mjs';

const { sh, shell } = await boot();
const out = async (line) => plain((await sh(line)).stdout);

test('expansion and quoting', async () => {
  assert.equal(await out(`X=world; echo "hello $X" 'lit $X' \\$X`), 'hello world lit $X $X\n');
  assert.equal(await out('echo ${UNSET:-fallback} $((6 * 7)) $(echo nested)'), 'fallback 42 nested\n');
  assert.equal(await out('false; echo $?; true; echo $?'), '1\n0\n');
  assert.equal(await out('mkdir -p /tmp/g && cd /tmp/g && touch a1 a2 b1 && echo a*'), 'a1 a2\n');
  assert.equal(await out('cd ~ && echo ok'), 'ok\n');
});

test('pipes, redirection and isatty(1)', async () => {
  assert.equal(await out('printf "b\\na\\nc\\n" | sort | head -2'), 'a\nb\n');
  assert.equal(await out('echo one > /tmp/r.txt; echo two >> /tmp/r.txt; cat < /tmp/r.txt'), 'one\ntwo\n');
  const r = await sh('ls /nope 2>&1 | wc -l');
  assert.equal(r.stdout, '1\n');
  assert.equal(await out('ls / | wc -l') !== '1\n', true, 'ls prints one entry per line into a pipe');
  assert.equal(await out('echo hi | wc -l'), '1\n', 'one count, one input: no padding');
  assert.equal(await out('printf "a\\nb\\n" > /tmp/w.txt; wc /tmp/w.txt'), '2 2 4 /tmp/w.txt\n', 'width from the file size, as GNU wc');
});

test('here-strings and here-documents', async () => {
  assert.equal(await out('cat <<< "hello world"'), 'hello world\n');
  assert.equal(await out('x=5; cat <<< "x is $x"'), 'x is 5\n');
  assert.equal(await out('name=Ada\ncat <<EOF\nHi $name\nsum: $((2+3))\nnow: $(echo sub)\nliteral \\$name and \\\\\nEOF'),
    'Hi Ada\nsum: 5\nnow: sub\nliteral $name and \\\n');
  assert.equal(await out("cat <<'EOF'\nno $expansion here\nEOF"), 'no $expansion here\n');
  assert.equal(await out('cat <<-EOF\n\tindented\n\t\tmore\n\tEOF'), 'indented\nmore\n');
  assert.equal(await out('cat <<EOF > /tmp/h.txt\nline1\nline2\nEOF\ncat /tmp/h.txt'), 'line1\nline2\n');
  assert.equal(await out('cat <<A; cat <<B\none\nA\ntwo\nB'), 'one\ntwo\n');
  assert.equal(await out('cat <<EOF | wc -l\na\nb\nc\nEOF'), '3\n');
  const r = await sh('cat <<EOF\nunterminated');
  assert.equal(r.stdout, 'unterminated\n');
  assert.match(r.stderr, /here-document delimited by end-of-file \(wanted `EOF'\)/);
});

test('comments', async () => {
  assert.equal(await out('# a comment line\necho after'), 'after\n');
  assert.equal(await out('echo a # trailing comment\necho b'), 'a\nb\n');
  assert.equal(await out('cat <<EOF\n# not a comment\nEOF'), '# not a comment\n');
});

test('needsContinuation asks for more where bash would', () => {
  const nc = shell.needsContinuation;
  assert.equal(nc('cat <<EOF'), 'heredoc');
  assert.equal(nc('cat <<EOF\nline'), 'heredoc');
  assert.equal(nc('cat <<EOF\nline\nEOF'), '');
  assert.equal(nc("cat <<'END'\n$x\nEND"), '');
  assert.equal(nc('cat <<< word'), '');
  assert.equal(nc('echo hi # comment |'), '');
  assert.equal(nc('echo "a#b" |'), 'operator');
  assert.equal(nc("echo 'open"), 'squote');
  assert.equal(nc('echo a \\'), 'backslash');
});

test('running programs by path', async () => {
  assert.equal(await out(`printf 'echo from script\\n' > /tmp/s.sh && chmod +x /tmp/s.sh && /tmp/s.sh`), 'from script\n');
  assert.equal(await out(`printf '#!/usr/bin/awk -f\\n{ print "awk:", $1 }\\n' > /tmp/a.awk && chmod +x /tmp/a.awk && echo hi | /tmp/a.awk`), 'awk: hi\n');
  let r = await sh(`printf '#!/usr/bin/env nosuch\\n' > /tmp/n.x && chmod +x /tmp/n.x && /tmp/n.x`);
  assert.equal(r.stderr, "/usr/bin/env: 'nosuch': No such file or directory\n");
  assert.equal(r.code, 127);
  r = await sh(`printf 'echo hi\\n' > /tmp/p.sh && /tmp/p.sh`);
  assert.equal(r.stderr, 'bash: /tmp/p.sh: Permission denied\n');
  assert.equal(r.code, 126);
  r = await sh('./nope');
  assert.equal(r.stderr, 'bash: ./nope: No such file or directory\n');
  assert.equal(r.code, 127);
  assert.equal(await out('/usr/bin/echo via-path'), 'via-path\n');
  assert.equal(await out('chmod +x /tmp/p.sh && chmod -x /tmp/p.sh && ls -l /tmp/p.sh | cut -c1-10'), '-rw-r--r--\n', 'chmod -x is a mode');
});

test('command-not-found reads like Ubuntu', async () => {
  let r = await sh('python');
  assert.equal(r.stderr, "Command 'python' not found, did you mean:\n  command 'python3' from deb python3\n  command 'python' from deb python-is-python3\n");
  assert.equal(r.code, 127);
  r = await sh('pip3');
  assert.match(r.stderr, /sudo apt install python3-pip/);
  r = await sh('definitely-not-a-command');
  assert.equal(r.stderr, 'definitely-not-a-command: command not found\n');
});

test('env and printenv', async () => {
  assert.equal(await out('env FOO=bar printenv FOO'), 'bar\n');
  assert.equal(await out('printenv FOO; echo "[$?]"'), '[1]\n', 'the assignment did not leak');
  assert.equal(await out('env -u HOME printenv HOME; echo "[$?]"'), '[1]\n');
  assert.match(await out('printenv HOME'), /^\/home\//);
  assert.equal(await out('env -i printenv | wc -l'), '0\n');
});

test('expr', async () => {
  const E = await load('js/apps/terminal/commands/shell-utils.js');
  const expr = E.default.find((c) => c.name === 'expr');
  const run = async (...argv) => {
    const r = await expr.run({ argv });
    return `${r.code}:${(r.stdout || r.stderr).trim()}`;
  };
  assert.equal(await run('1', '+', '2'), '0:3');
  assert.equal(await run('99999999999999999999', '+', '1'), '0:100000000000000000000');
  assert.equal(await run('-7', '%', '3'), '0:-1');
  assert.equal(await run('foo.txt', ':', String.raw`\(.*\)\.txt`), '0:foo');
  assert.equal(await run('abc', ':', 'x'), '1:0');
  assert.equal(await run('substr', 'hello', '2', '3'), '0:ell');
  assert.equal(await run('index', 'hello', 'lo'), '0:3');
  assert.equal(await run('', '|', 'x'), '0:x');
  assert.equal(await run('1', '/', '0'), '2:expr: division by zero');
  assert.equal(await run('1', '+'), "2:expr: syntax error: missing argument after '+'");
  assert.equal(await out('n=3; n=$(expr $n + 1); echo $n'), '4\n');
});

test('xargs', async () => {
  assert.equal(await out('echo a b c | xargs'), 'a b c\n');
  assert.equal(await out('echo a b c d e | xargs -n 2 echo'), 'a b\nc d\ne\n');
  assert.equal(await out('printf "x\\ny\\n" | xargs -I{} echo "<{}>"'), '<x>\n<y>\n');
  assert.equal(await out('printf "a b\\0c\\0" | xargs -0 -n1 echo'), 'a b\nc\n');
  const t = await sh('echo "one two" | xargs -t echo');
  assert.equal(t.stdout, 'one two\n');
  assert.equal(t.stderr, 'echo one two\n');
  assert.equal(await out('echo x | xargs false; echo "[$?]"'), '[123]\n');
  assert.equal(await out('true | xargs -r echo hi; echo "[$?]"'), '[0]\n');
});

test('clear writes the escape sequence into a pipe', async () => {
  assert.equal((await sh('clear | cat')).stdout, '\x1b[H\x1b[2J\x1b[3J');
});

test('python3 options that need no interpreter', async () => {
  assert.equal(await out('python3 --version'), 'Python 3.12.7\n');
  let r = await sh('python3 /tmp/nope.py');
  assert.equal(r.stderr, "python3: can't open file '/tmp/nope.py': [Errno 2] No such file or directory\n");
  assert.equal(r.code, 2);
  r = await sh('python3 -z');
  assert.match(r.stderr, /^unknown option -z\nusage: python3/);
  assert.equal(r.code, 2);
  assert.match(await out('python3 -h | head -1'), /^usage: python3 \[option\]/);
});
