'use strict';
// Run: node <rig>/test/template.test.cjs   (exit 1 on any miss)
// Checks example/, the project template new-project.ps1 copies (and the guard tests' fixture): its shared seat section, its one
// placeholder, its settings hooks and its lanes.ps1 line against the guard, its FILL IN paragraphs and the content gate's local word list.
const fs = require('fs');
const path = require('path');
const { decide, RIG_DIR } = require('../hooks/guard.cjs');
const { loadList, scan } = require('../bin/content-gate.cjs');

const EX = path.join(__dirname, '..', 'example');
const RULES = path.join(EX, 'rules');

let total = 0;
let failed = 0;
function check(label, ok, extra) {
  total++;
  if (!ok) {
    failed++;
    console.error('FAIL ' + label + (extra ? '\n  ' + extra : ''));
  }
}
const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
// Every file under example/, as { path: 'example/...', text }.
const exampleFiles = () =>
  (fs.existsSync(EX) ? fs.readdirSync(EX, { recursive: true }) : [])
    .map((rel) => path.join(EX, rel))
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => ({ path: path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));

// 1. The shared section: from its heading to the next ## heading (or the end of the file).
const SEATS = ['coder', 'angela', 'oscar', 'pam'];
const shared = SEATS.map((seat) => {
  const text = read(path.join(RULES, 'seats', seat + '.md'));
  const m = text && text.match(/^## The project's CLAUDE\.md\n[\s\S]*?(?=^## |(?![\s\S]))/m);
  return m ? m[0] : null;
});
check(
  `the "The project's CLAUDE.md" section is byte-identical in the four seat files`,
  shared.every((s) => s !== null && s.length > 100 && s === shared[0]),
  SEATS.map((seat, i) => `${seat}: ${shared[i] === null ? 'missing' : shared[i] === shared[0] ? 'same as coder' : 'differs from coder'}`).join(', ')
);

// 2. {{RIG}} is the only placeholder (new-project.ps1 fills in exactly that one and the project tokens).
const files = exampleFiles();
const others = files.flatMap((f) => (f.text.match(/\{\{[^{}]*\}\}/g) || []).filter((p) => p !== '{{RIG}}').map((p) => `${f.path}: ${p}`));
check('{{RIG}} is the only {{...}} placeholder in example/', others.length === 0 && files.some((f) => f.text.includes('{{RIG}}')), others.join(', ') || 'no {{RIG}} anywhere');

// 2b. new-project.ps1 replaces the word example as the project's name, so English "example" would turn into that name too. The rule:
// no line in example/ holds "for/an/as example", "e.g. example", "example of" or "examples" (any case), or Example/EXAMPLE capitalised.
const ENGLISH = [/\b(?:for|an|as)\s+example\b|e\.g\.,?\s+example\b|\bexample\s+of\b|\bexamples\b/i, /\bE(?:xample|XAMPLE)/];
const english = files.flatMap((f) => f.text.split(/\r?\n/).flatMap((l, i) => (ENGLISH.some((re) => re.test(l)) ? [`${f.path}:${i + 1}`] : [])));
check(
  'the word example appears in example/ only as the project token (no "for example", "an example", "e.g. example", "example of", "examples", Example)',
  english.length === 0,
  english.join(', ')
);

// 3. The guard hook of each settings file, with {{RIG}} replaced as new-project.ps1 does.
const GUARD_SEAT = { orchestrator: 'orchestrator', coder: 'coder', angela: 'checker', oscar: 'checker', pam: 'pam' };
const hookProblems = Object.entries(GUARD_SEAT).flatMap(([seat, guardSeat]) => {
  const text = read(path.join(RULES, seat + '.settings.json'));
  if (text === null) return [`${seat}.settings.json is missing`];
  let s;
  try {
    s = JSON.parse(text.split('{{RIG}}').join(RIG_DIR));
  } catch (e) {
    return [`${seat}.settings.json does not parse (${e.message})`];
  }
  const want = `node ${RIG_DIR}/hooks/guard.cjs --project example --seat ${guardSeat} || exit 2`;
  const pre = ((s.hooks || {}).PreToolUse || []).flatMap((m) => (m.hooks || []).map((h) => [m.matcher, h.command]));
  return pre.length === 1 && pre[0][0] === '*' && pre[0][1] === want ? [] : [`${seat}: ${JSON.stringify(pre)}`];
});
check(
  'with {{RIG}} replaced by RIG_DIR, every settings file\'s guard hook is node <RIG_DIR>/hooks/guard.cjs --project example --seat <seat> || exit 2',
  hookProblems.length === 0,
  hookProblems.join('; ')
);

// 4. The lanes (the lean build): one lanes.ps1 line, with {{RIG}} as RIG_DIR, that the guard lets example's orchestrator run, and no herdr
// agent start or pane split line (the guard refuses both for the orchestrator; lanes.ps1 holds the lanes' flags).
const orch = read(path.join(RULES, 'orchestrator.md'));
const roleLines = (orch || '').split('{{RIG}}').join(RIG_DIR).split(/\r?\n/);
const lanesLines = roleLines.filter((l) => l.startsWith("& '") && l.includes('lanes.ps1'));
const lanesVerdict = lanesLines.length === 1 ? decide({ seat: 'orchestrator', tool_name: 'PowerShell', tool_input: { command: lanesLines[0] }, cwd: 'C:\\example-project' }, {}) : null;
check(
  "orchestrator.md starts the lanes with one lanes.ps1 line the guard lets example's orchestrator run, and holds no herdr agent start or pane split line",
  lanesLines.length === 1 && lanesLines[0] === `& '${RIG_DIR}/bin/lanes.ps1' example` && lanesVerdict !== null && lanesVerdict.allow === true && !roleLines.some((l) => /^herdr (?:agent start|pane split) /.test(l)),
  `${lanesLines.length} lanes.ps1 line(s): ${lanesLines.join(' | ') || 'none'}; guard: ${lanesVerdict ? JSON.stringify(lanesVerdict).slice(0, 160) : 'not asked'}`
);

// 5. The FILL IN paragraphs: each starts a line with "FILL IN: <topic>." (the README's "Adding a project" lists them).
const FILL_IN = {
  'rules/orchestrator.md': ['the project', 'test, lint and build commands', 'core and money paths', 'risky areas', 'non-core call-path code', 'PMS board'],
  'rules/seats/coder.md': ['the project', 'test, lint and build commands', 'core and money paths', 'risky areas'],
};
const missing = Object.entries(FILL_IN).flatMap(([rel, topics]) => {
  const text = read(path.join(EX, rel)) || '';
  return topics.filter((t) => !text.split(/\r?\n/).some((l) => l.startsWith(`FILL IN: ${t}.`))).map((t) => `${rel}: ${t}`);
});
check('orchestrator.md and the coder seat each hold the FILL IN paragraphs the spec lists', missing.length === 0, 'missing: ' + missing.join(', '));

// 6. The content gate's local list (git-ignored; a fresh clone has none). Only the places are printed, never the words.
const words = loadList(path.join(__dirname, '..', '.content-gate.local'));
if (!words) console.log('template: content check skipped: no local list');
else {
  const hits = scan({ words, files, messages: [] });
  check('no file under example/ holds a .content-gate.local word', files.length > 0 && hits.length === 0, `${hits.length} hits at ${hits.map((h) => h.where).join(', ')}`);
}

console.log(failed ? `template: ${failed} of ${total} checks failed` : `template: all ${total} checks passed`);
process.exit(failed ? 1 : 0);
