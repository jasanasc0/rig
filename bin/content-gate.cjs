'use strict';
// Content gate: fails when a word from a local, git-ignored list appears in tracked files, their paths, or commits (message, author,
// committer). Run: node bin/content-gate.cjs [--list <file>] [--tree <rev>] [--messages <rev-range>]
// Exit: 0 clean (or no list), 1 hits (one "<where>: <word>" line each), 2 usage error or a list that is not UTF-8 or holds no words.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function loadList(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  // UTF-16 (Windows PowerShell 5.1's > and Out-File) reads as UTF-8 with a NUL in every ASCII character, so no word would ever match
  if (text.includes('\0')) throw new Error(`${file} is not UTF-8 (it holds NUL bytes); save it as UTF-8: (Get-Content '${file}') | Set-Content -Encoding utf8 '${file}'`);
  // trim() below already drops U+FEFF; stripping it here keeps that from being an accident
  const words = text.replace(/^\u{FEFF}/u, '').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (!words.length) throw new Error(`${file} holds no words; put one word per line in it`);
  return words;
}

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// messages: strings "<sha7> <text>"; the first space ends the sha
function scan({ words, files, messages }) {
  const hits = [];
  const res = words.map((w) => [w, new RegExp('(?<![a-z0-9_-])' + esc(w) + '(?![a-z0-9_-])', 'i')]);
  const test = (where, line) => {
    for (const [w, re] of res) if (re.test(line)) hits.push({ where, word: w });
  };
  for (const f of files) {
    test(f.path, f.path);
    if (f.text.includes('\0')) continue;
    f.text.split(/\r?\n/).forEach((line, i) => test(f.path + ':' + (i + 1), line));
  }
  for (const m of messages) {
    const sp = m.indexOf(' ');
    const sha = sp < 0 ? m : m.slice(0, sp);
    test('commit ' + sha, sp < 0 ? '' : m.slice(sp + 1));
  }
  return hits;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 28 });
}

function main(argv) {
  const repo = path.dirname(__dirname); // the repo root: this file is in bin/
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!['--list', '--tree', '--messages'].includes(k) || argv[i + 1] === undefined) {
      console.error('usage: node bin/content-gate.cjs [--list <file>] [--tree <rev>] [--messages <rev-range>]');
      return 2;
    }
    opt[k.slice(2)] = argv[i + 1];
  }
  let words;
  let files;
  let messages;
  try {
    words = loadList(opt.list || path.join(repo, '.content-gate.local'));
    if (!words) {
      console.log('skipped: no local list');
      return 0;
    }
    const names = opt.tree
      ? git(repo, ['ls-tree', '-r', '-z', '--name-only', opt.tree]).toString('utf8').split('\0').filter(Boolean)
      : git(repo, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
    files = names.map((n) => ({
      path: n,
      text: (opt.tree ? git(repo, ['show', opt.tree + ':' + n]) : fs.readFileSync(path.join(repo, n))).toString('utf8'),
    }));
    // no commits yet (and no explicit range): nothing to scan
    const range = opt.messages || 'HEAD';
    let log = '';
    try {
      // the people fields too: a work name or email in an author or committer line is a hit, labelled with the commit
      log = git(repo, ['log', '--format=%h %an <%ae>%n%cn <%ce>%n%B%x00', range]).toString('utf8');
    } catch (e) {
      if (opt.messages) throw e;
    }
    messages = log.split('\0').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim());
  } catch (e) {
    console.error('content-gate: ' + (e.stderr ? e.stderr.toString() : e.message));
    return 2;
  }
  const hits = scan({ words, files, messages });
  for (const h of hits) console.log(h.where + ': ' + h.word);
  return hits.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { loadList, scan };
