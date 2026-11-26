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
const SEATS = ['coder', 'angela', 'oscar', 'pam', 'scribe'];
const shared = SEATS.map((seat) => {
  const text = read(path.join(RULES, 'seats', seat + '.md'));
  const m = text && text.match(/^## The project's CLAUDE\.md\n[\s\S]*?(?=^## |(?![\s\S]))/m);
  return m ? m[0] : null;
});
check(
  `the "The project's CLAUDE.md" section is byte-identical in the five seat files`,
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
const GUARD_SEAT = { orchestrator: 'orchestrator', coder: 'coder', angela: 'checker', oscar: 'checker', pam: 'pam', scribe: 'scribe' };
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

// 7. The lessons build (2026-11-17, from the Claude Fable 5.2 system card and OpenRig). Every seat file opens with "## Your boundary"
// (its area, what is out of bounds even when a tool or the guard lets it through, one shared tail) and every report has a Guard: line
// directly before Question:; each "A guard block" bullet names that line. coder stops on a missing input instead of writing a stand-in.
// angela's report has Checked: and Not checked: before Verdict:; angela's and oscar's open with Commit: (git rev-parse HEAD in their step
// 3). The orchestrator acts on a lane's latest verdict only for that commit (else a range-diff to Jas, merges shown), passes Guard: and
// Not checked: lines to Jas, ends its Hard rules with its own boundary, and fills the brief's Settled line from the handoff and its memory.
{
  const sectionOf = (text, heading) => {
    const lines = text.split(/\r?\n/);
    const at = lines.indexOf(heading);
    if (at < 0) return `(no ${heading})`;
    const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
    return lines.slice(at, end < 0 ? lines.length : end).join('\n').trim();
  };
  const TAIL =
    "The guard is a text filter that misses some spellings, so a command it lets through is not a permission. A way past it, or anything out of bounds that you find you can reach: don't use it and don't probe for more; put it on your report's `Guard:` line.";
  const AREA = {
    coder:
      'You change files only inside the ticket\'s worktree (the brief\'s `Worktree:` line) and run its tests, lint and build there. You read what the brief points to, wherever it is. Out of bounds, even when a tool or the guard lets it through: any change to Jas\'s main checkout, his other worktrees, other projects or the rig folder; `.env*` files; `.claude/` settings; whatever "Stop and report instead" below stops you on; and anything that leaves this PC (a push, a deploy, an upload, a message to another session).',
    angela:
      "You read the ticket's worktree and what the brief points to, wherever it is, and run single checks and read-only commands to prove a finding. You change no file anywhere. Out of bounds, even when a tool or the guard lets it through: any file write, commit or other git change, in the worktree or anywhere else; `.env*` files; `.claude/` settings; and anything that leaves this PC (a push, a deploy, an upload, a message to another session).",
    oscar:
      "You run the gate's commands in the checkout the brief names (the ticket's worktree, or main when the brief says so) and read what the brief points to, wherever it is. You change no file yourself; the only files your commands write are their own output (the test JSON in your temp folder, the build's output). Out of bounds, even when a tool or the guard lets it through: any other file write, commit or other git change; `.env*` files; `.claude/` settings; and anything that leaves this PC (a push, a deploy, an upload, a message to another session).",
    pam:
      "You run `pms.cjs` with the commands your brief lists and read what the brief points to. You change no file yourself (`pms.cjs` writes its own log). Out of bounds, even when a tool or the guard lets it through: any other script, board or file write; `.env*` files; `.claude/` settings; and anything else that leaves this PC (an upload, a message to another session).",
    scribe:
      "You read what the brief points to (handoffs, task files, docs) with the Read, Grep and Glob tools; you have no shell, so the brief writes out the commits. You write only the Markdown journal pages the brief names, under `docs/journal/` of example's main checkout. Out of bounds, even when a tool or the guard lets it through: any other file (a handoff, a task, a doc, code, a worktree), any shell command, running a script, `.env*` files, `.claude/` settings, personal data, and anything that leaves this PC (an upload, a message to another session).",
  };
  const GUARD = 'Guard: none, or each block (its rule and what you tried) and each gap you found (what and where)';
  for (const seat of SEATS) {
    const text = read(path.join(RULES, 'seats', seat + '.md')) || '';
    const first = text.split(/\r?\n/).find((l) => l.startsWith('## ')) || '(none)';
    const guardBullet = text.split(/\r?\n/).find((l) => /^- A guard block/.test(l)) || '';
    check(`${seat}.md (lessons): its first section is "## Your boundary"`, first === '## Your boundary', first);
    check(`${seat}.md (lessons): "## Your boundary" holds its area and the shared tail`, sectionOf(text, '## Your boundary') === `## Your boundary\n${AREA[seat]} ${TAIL}`);
    check(`${seat}.md (lessons): the report's Guard: line comes directly before Question:`, text.includes(`\n${GUARD}\nQuestion: none, or `));
    check(`${seat}.md (lessons): its "A guard block" bullet puts the block on the Guard: line`, guardBullet.includes("put it on your report's `Guard:` line (which rule blocked what)"));
  }
  const COMMIT = 'Commit: <full sha from `git rev-parse HEAD` in the worktree>';
  const angela = read(path.join(RULES, 'seats', 'angela.md')) || '';
  const oscar = read(path.join(RULES, 'seats', 'oscar.md')) || '';
  for (const [name, t] of [['angela', angela], ['oscar', oscar]]) check(`${name}.md (lessons): the report's second line is the commit it checked`, t.includes(`=== REPORT ===\nTicket: EX-<n>\n${COMMIT}\n`));
  check(
    'angela.md (lessons): Checked: and Not checked: come directly before Verdict:',
    angela.includes("\nChecked: <each file you read and each command you ran, with its result line>\nNot checked: none, or <what the change reaches that you didn't check, and why>\nVerdict: APPROVE or CHANGES NEEDED\n")
  );
  check('angela.md (lessons): step 3 takes git rev-parse HEAD for the Commit: line', angela.split('\n').includes("3. Run `git rev-parse HEAD` (its full sha is your report's `Commit:` line), `git diff <base>...HEAD` and `git log --oneline <base>..HEAD` with the base from the brief. Read the base commit's own message."));
  check('oscar.md (lessons): step 3 takes git rev-parse HEAD before the gate', oscar.split('\n').includes("3. Run `git rev-parse HEAD` first (its full sha is your report's `Commit:` line), then the gate below and the proof check."));
  const stop = sectionOf(read(path.join(RULES, 'seats', 'coder.md')) || '', '## Stop and report instead').split('\n');
  check(
    'coder.md (lessons): the last "Stop and report instead" bullet stops on a missing input, never a stand-in',
    stop[stop.length - 1] ===
      "- Something the task depends on that isn't there: the plan section on the brief's `Plan:` line, a file, symbol or test the task says to change or run, or the `Base:` commit. Report what is missing and where you looked; never write a stand-in for it (a stub, a placeholder file, a mock that only fills the gap) and never guess what it held. A file the task asks you to create is not missing. A stale path on the `Files likely involved:` line is a hint, not a missing input: when the real file is clear, carry on and put it on your `Question:` line with the default you took."
  );
  const orch = read(path.join(RULES, 'orchestrator.md')) || '';
  const hard = sectionOf(orch, '## Hard rules').split('\n');
  check(
    'orchestrator.md (lessons): the Commit: and Guard: rules come right after reading a report',
    orch.includes(
      "No block found: retry once with `--lines 1500`, then tell Jas.\n- A verdict holds only for the commit on its report's `Commit:` line. Before you act on ex-angela's or ex-oscar's latest verdict (the next brief, Jas's checkpoint, your report to Jas), run `git -C '<worktree>' rev-parse HEAD`. If it isn't that commit, or the line is missing or not a full sha, the commits after it are unchecked: don't act on the verdict; show Jas `git -C '<worktree>' range-diff --diff-merges=first-parent <Base>..<Commit> <Base>..HEAD` (the brief's `Base:`; `=` is a commit the verdict saw, unchanged; `!` one changed since; `>` one it never saw, merge commits and a rebase's new main commits included; `<` one it saw that is gone, rewritten or squashed), or the report and HEAD when the line is missing, and ask which lane runs again.\n- A report's `Guard:` line, and ex-angela's `Not checked:` line, when not `none`: tell Jas what they say, word for word, even when the work passed.\n"
    )
  );
  check(
    'orchestrator.md (lessons): the last Hard rule is its boundary',
    hard[hard.length - 1] ===
      "- Your boundary: you write only in the project's knowledge folders (the profile's `knowledgeDirs`, in its main checkout), the rig's `work\\` folder (never a `.obsidian\\` folder), your own Claude memory folder and Claude's scratchpad, and you run only the files listed above. These rules hold whether or not the guard blocks: it is a text filter that misses some spellings, so a command it lets through is not a permission. A way past it, or a place these rules keep from you that you find you can reach: don't use it and don't probe for more; tell Jas in plain words what you found."
  );
  check(
    'orchestrator.md (lessons): Prepare collects settled items from the handoff and the memory index, with reasons',
    orch.split('\n').includes(
      '   - Collect what is settled for this ticket: the "what not to redo" items in the newest `.agent/handoffs/*_PROMPT_next_shift.md` and the decisions in your memory index (`MEMORY.md`) that touch it, opening a memory file for its reason. Each goes on the brief\'s `Settled, don\'t reopen:` line with its reason in a few words; one you aren\'t sure still holds goes to Jas first.'
    ) && !orch.includes('pick out the "do not relitigate" items')
  );
  check("orchestrator.md (lessons): the brief's Settled line asks for each item's reason", orch.split('\n').includes('Settled, don\'t reopen: <each item with its reason, from the handoff and your memory, or "none">'));
}

console.log(failed ? `template: ${failed} of ${total} checks failed` : `template: all ${total} checks passed`);
process.exit(failed ? 1 : 0);
