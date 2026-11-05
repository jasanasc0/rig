'use strict';
// Run: node test/content-gate.test.cjs   (exit 1 on any miss)
// Temp git repos and temp word lists only; the words here are made up.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.dirname(__dirname); // the repo: this test is in test/
const GATE = path.join(ROOT, 'bin', 'content-gate.cjs');
const HOOK = path.join(ROOT, '.githooks', 'pre-push');

let total = 0;
let failed = 0;
function check(label, ok, extra) {
  total++;
  if (!ok) {
    failed++;
    console.error('FAIL ' + label + (extra ? '\n' + extra : ''));
  }
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !git.soft) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r;
}

// a temp repo with a copy of the gate and the hook, one commit of `files`, message `msg`
function makeRepo(files, msg, list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(GATE, path.join(dir, 'bin', 'content-gate.cjs'));
  fs.mkdirSync(path.join(dir, '.githooks'));
  fs.copyFileSync(HOOK, path.join(dir, '.githooks', 'pre-push'));
  if (list !== undefined) fs.writeFileSync(path.join(dir, '.content-gate.local'), list);
  commit(dir, files, msg || 'plain message');
  return dir;
}

// write `files` (subfolders made as needed) and commit them with message `msg`; `extra` goes to git commit (e.g. --author)
function commit(dir, files, msg, ...extra) {
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  git(dir, 'add', '-A', '--', '.', ':!.content-gate.local');
  git(dir, 'commit', '-q', '-m', msg, ...extra);
}

function gate(dir, ...args) {
  return spawnSync('node', [path.join(dir, 'bin', 'content-gate.cjs'), ...args], { cwd: dir, encoding: 'utf8' });
}

// no list
let dir = makeRepo({ 'a.txt': 'zorblax\n' });
let r = gate(dir);
check('no list -> skipped, exit 0', r.status === 0 && /skipped: no local list/.test(r.stdout), r.stdout + r.stderr);

// a listed word in a tracked file
dir = makeRepo({ 'a.txt': 'one\ntwo Zorblax here\n' }, 'plain message', 'zorblax\n\n');
r = gate(dir);
check('listed word in a tracked file -> exit 1, file:line and the word', r.status === 1 && r.stdout.trim() === 'a.txt:2: zorblax', r.stdout + r.stderr);

// a list written with a UTF-8 BOM (Windows PowerShell 5.1) still hits its first word
dir = makeRepo({ 'a.txt': 'zorblax\n' }, 'plain message', '\u{FEFF}zorblax\n');
r = gate(dir);
check('a list starting with a BOM still hits its first word', r.status === 1 && r.stdout.trim() === 'a.txt:1: zorblax', r.stdout + r.stderr);

// whole word only
dir = makeRepo({ 'a.txt': 'pineapple tree\n' }, 'plain message', 'pine\n');
r = gate(dir);
check('whole word only: pineapple does not hit pine', r.status === 0, r.stdout + r.stderr);

// commit message
dir = makeRepo({ 'a.txt': 'clean\n' }, 'fix the zorblax thing', 'zorblax\n');
r = gate(dir);
check('a listed word in a commit message -> exit 1', r.status === 1 && /^commit [0-9a-f]{7}: zorblax/m.test(r.stdout), r.stdout + r.stderr);

// binary file
dir = makeRepo({ 'b.bin': Buffer.from('zorblax\0\x01zorblax') }, 'plain message', 'zorblax\n');
r = gate(dir);
check('a binary file holding the word is skipped', r.status === 0, r.stdout + r.stderr);

// CRLF
dir = makeRepo({ 'c.txt': 'ok\r\nzorblax\r\nok\r\n' }, 'plain message', 'zorblax\n');
r = gate(dir);
check('CRLF text is scanned per line', r.status === 1 && r.stdout.trim() === 'c.txt:2: zorblax', r.stdout + r.stderr);

// usage error
r = gate(dir, '--bogus');
check('unknown option -> exit 2', r.status === 2, r.stdout + r.stderr);

// a UTF-16 list (what Windows PowerShell 5.1's > and Out-File write) holds NUL bytes: refused with one line, exit 2
dir = makeRepo({ 'a.txt': 'zorblax\n' }, 'plain message', Buffer.from('\u{FEFF}zorblax\r\n', 'utf16le'));
r = gate(dir);
check(
  'a UTF-16 list -> exit 2 and one line saying to save it as UTF-8 (Set-Content -Encoding utf8)',
  r.status === 2 && r.stdout === '' && r.stderr.trim().split('\n').length === 1 && r.stderr.includes('Set-Content -Encoding utf8'),
  r.stdout + r.stderr
);

// a list that exists but holds no words
dir = makeRepo({ 'a.txt': 'zorblax\n' }, 'plain message', '\u{FEFF}\r\n  \r\n');
r = gate(dir);
check('a list with no words -> exit 2', r.status === 2 && r.stdout === '', r.stdout + r.stderr);

// a listed word in a folder name
dir = makeRepo({ 'Zorblax/a.txt': 'clean\n' }, 'plain message', 'zorblax\n');
r = gate(dir);
check('a listed word in a file path -> exit 1, "<path>: <word>"', r.status === 1 && r.stdout.trim() === 'Zorblax/a.txt: zorblax', r.stdout + r.stderr);

// the build repo's own .gitignore: /*/ ignores every top-level project folder (two made-up names here), but not example/
git.soft = true; // check-ignore exits 1 for "not ignored"
const ign = ['.content-gate.local', 'zz-foreign/x', 'zz-other/x', 'example/x'].map((p) => git(ROOT, 'check-ignore', '-q', p).status === 0);
check('the build repo ignores .content-gate.local, project folders, and not example/x', ign[0] && ign[1] && ign[2] && !ign[3], JSON.stringify(ign));

// pre-push
function pushTest(files, label, expectOk) {
  const work = makeRepo(files, 'plain message', 'zorblax\n');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bare-'));
  git(bare, 'init', '-q', '--bare');
  git(work, 'config', 'core.hooksPath', '.githooks');
  git(work, 'remote', 'add', 'origin', bare);
  const p = git(work, 'push', 'origin', 'main');
  check(label, expectOk ? p.status === 0 : p.status !== 0 && /zorblax/.test(p.stdout + p.stderr), p.stdout + p.stderr);
}
pushTest({ 'a.txt': 'has zorblax\n' }, 'pre-push: refused when the pushed tree holds a listed word', false);
pushTest({ 'a.txt': 'clean\n' }, 'pre-push: passes when clean', true);

// a clean repo with the hook on and a temp bare origin, nothing pushed yet
function hooked() {
  const work = makeRepo({ 'a.txt': 'clean\n' }, 'plain message', 'zorblax\n');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bare-'));
  git(bare, 'init', '-q', '--bare');
  git(work, 'config', 'core.hooksPath', '.githooks');
  git(work, 'remote', 'add', 'origin', bare);
  return work;
}
const push = (work, ...args) => git(work, 'push', 'origin', ...args);
const out = (p) => p.stdout + p.stderr;
const refused = (p) => p.status !== 0 && /zorblax/.test(out(p));

// every pushed commit is checked, not only the tip
let w = hooked();
commit(w, { 'b.txt': 'has zorblax\n' }, 'add b');
commit(w, { 'b.txt': 'clean now\n' }, 'clean b');
let p = push(w, 'main');
check('pre-push: a word added in one commit and removed in the next is refused', refused(p), out(p));

// the people fields
w = hooked();
commit(w, { 'b.txt': 'clean\n' }, 'plain message', '--author=t <zorblax@example.com>');
p = push(w, 'main');
check('pre-push: a listed word in the author email is refused', refused(p), out(p));

// a non-zero remote sha: only <remote>..<local> is checked
w = hooked();
p = push(w, 'main');
check('pre-push a..b: the first clean push passes', p.status === 0, out(p));
commit(w, { 'b.txt': 'clean\n' }, 'old zorblax message');
push(w, '--no-verify', 'main'); // a commit already on the remote, put there past the hook
commit(w, { 'c.txt': 'clean\n' }, 'new clean');
p = push(w, 'main');
check('pre-push a..b: an old commit on the remote does not matter, only the new ones are checked', p.status === 0, out(p));
commit(w, { 'd.txt': 'has zorblax\n' }, 'new dirty');
commit(w, { 'd.txt': 'clean\n' }, 'new cleanup');
p = push(w, 'main');
check('pre-push a..b: a new dirty commit is refused, even when the tip is clean', refused(p), out(p));

// a delete push has nothing to check
w = hooked();
commit(w, { 'b.txt': 'has zorblax\n' }, 'plain message');
push(w, '--no-verify', 'main:gone');
p = push(w, ':gone');
check('pre-push: a delete push is skipped', p.status === 0 && git(w, 'ls-remote', 'origin', 'gone').stdout === '', out(p));

console.log(total - failed + '/' + total + ' passed');
process.exit(failed ? 1 : 0);
