'use strict';
// Run: node <rig>/helpers.test.cjs   (exit 1 on any miss)
// The project it reads is example (this repo's); every other project is made in temp folders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHere, newestHandoff, render, noteHead, newInboxNotes, startupWarnings } = require('./refocus.cjs');
const { lastContextTokens, warning } = require('./context-check.cjs');
const { extractReport } = require('./report.cjs');

let total = 0;
let failed = 0;
function check(label, ok) {
  total++;
  if (!ok) {
    failed++;
    console.error('FAIL ' + label);
  }
}

// refocus: the Start here block
const handoff = ['# Next shift', '', '## Start here', 'Ticket EX-9 step 3', 'Open: ask Jas about X', '', '## Details', 'long text'].join('\n');
let sh = startHere(handoff);
check('startHere finds the block', sh.found && sh.block === 'Ticket EX-9 step 3\nOpen: ask Jas about X');
sh = startHere(Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\n'));
check('startHere falls back to the first 20 lines', !sh.found && sh.block.split('\n').length === 20 && sh.block.endsWith('line 20'));
sh = startHere(['## Start here', ...Array.from({ length: 30 }, (_, i) => 'x' + i)].join('\n'));
check('startHere caps the block at 20 lines', sh.block.split('\n').length === 20);

// refocus: newest handoff by modified time, _2 files included
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-helpers-'));
const hdir = path.join(tmp, 'handoffs');
fs.mkdirSync(hdir);
fs.writeFileSync(path.join(hdir, '2026-09-24_PROMPT_next_shift.md'), 'old');
fs.writeFileSync(path.join(hdir, '2026-09-25_PROMPT_next_shift_2.md'), '## Start here\nnewest');
fs.writeFileSync(path.join(hdir, 'notes.md'), 'not a handoff');
fs.utimesSync(path.join(hdir, '2026-09-24_PROMPT_next_shift.md'), new Date('2026-09-24'), new Date('2026-09-24'));
fs.utimesSync(path.join(hdir, '2026-09-25_PROMPT_next_shift_2.md'), new Date('2026-09-25'), new Date('2026-09-25'));
check('newestHandoff picks the newest handoff', path.basename(newestHandoff(hdir)) === '2026-09-25_PROMPT_next_shift_2.md');
check('newestHandoff returns null for a missing folder', newestHandoff(path.join(tmp, 'nope')) === null);

// refocus: what each kind of seat gets
const rig = path.join(tmp, 'rig');
fs.mkdirSync(path.join(rig, 'example', 'work', 'notes'), { recursive: true });
fs.writeFileSync(path.join(rig, 'example', 'work', 'now.md'), 'Ticket: EX-9 demo');
fs.writeFileSync(path.join(rig, 'example', 'work', 'notes', 'angela.md'), 'Check copied pre-guards.');
const paths = { work: path.join(rig, 'example', 'work'), handoffs: hdir };
const forOrch = render('orchestrator', paths);
check('orchestrator gets now.md and the newest Start here block', forOrch.includes('EX-9 demo') && forOrch.includes('newest') && !forOrch.includes('pre-guards'));
const forAngela = render('angela', paths);
check('angela gets now.md and her notes', forAngela.includes('EX-9 demo') && forAngela.includes('pre-guards') && !forAngela.includes('newest'));
check('render prints nothing when files are missing', render('oscar', { work: path.join(tmp, 'empty'), handoffs: path.join(tmp, 'empty') }) === '');

// context-check: the latest assistant usage counts, not the first
const transcript = [
  JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } }),
  'not json',
  JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 20, cache_read_input_tokens: 400000, cache_creation_input_tokens: 30 } } }),
].join('\n');
check('lastContextTokens sums the latest usage', lastContextTokens(transcript) === 400050);
check('lastContextTokens is 0 without usage', lastContextTokens('{"type":"user"}') === 0);
check('no warning under the limit', warning(399999, 400000) === '');
const w = warning(400050, 400000, { name: 'example', rootDir: 'C:/example-project' });
check('the warning names the handoff and the exact phrase', w.includes('_PROMPT_next_shift.md') && w.includes('Handoff written, type /clear.'));

// report: markers on their own lines, the last block wins, the ticket must match (Review Focus 1)
const screen = [
  '> Read C:\\rig\\example\\briefs\\ex9-coder.md and do it. Reply between === REPORT === and === END ===',
  '=== REPORT ===',
  'Ticket: EX-8',
  'old task',
  '=== END ===',
  '⏺ === REPORT ===',
  '  Ticket: EX-9',
  '  Changed: src/lib/format.ts',
  '  === END ===',
].join('\n');
check('extractReport returns the last block, cleaned', extractReport(screen, 'EX-9') === 'Ticket: EX-9\nChanged: src/lib/format.ts');
check('extractReport refuses a block for another ticket', extractReport(screen, 'EX-10') === null);
check('extractReport ignores markers inside a sentence', extractReport('Reply between === REPORT === and === END ===', 'EX-9') === null);
check('extractReport refuses an unfinished block', extractReport('=== REPORT ===\nTicket: EX-9\nstill writing', 'EX-9') === null);
check('extractReport does not take EX-90 for EX-9', extractReport('=== REPORT ===\nTicket: EX-90\n=== END ===', 'EX-9') === null);
check('extractReport refuses a block that merely mentions the ticket', extractReport('=== REPORT ===\nTicket: EX-8\nLesson: EX-9 will need a migration\n=== END ===', 'EX-9') === null);

// refocus v3: Jas's inbox (a project's optional work\inbox\)
const work = path.join(rig, 'example', 'work');
const inbox = path.join(work, 'inbox');
fs.mkdirSync(path.join(inbox, 'done'), { recursive: true });
const at = (s) => new Date(s);
fs.writeFileSync(path.join(inbox, '2026-09-29-0900.md'), '---\ntype: inbox\n---\nCall the hosting vendor\nabout the outage\n');
fs.writeFileSync(path.join(inbox, '2026-09-29-0930.md'), 'Handled already');
fs.writeFileSync(path.join(inbox, '2026-09-29-1000.md'), 'Edited after reading');
fs.writeFileSync(path.join(inbox, 'done', 'old.md'), 'done note');
fs.utimesSync(path.join(inbox, '2026-09-29-0900.md'), at('2026-09-29T09:00:00'), at('2026-09-29T09:00:00'));
fs.utimesSync(path.join(inbox, '2026-09-29-0930.md'), at('2026-09-29T09:30:40'), at('2026-09-29T09:30:40'));
fs.utimesSync(path.join(inbox, '2026-09-29-1000.md'), at('2026-09-29T11:00:00'), at('2026-09-29T11:00:00'));
const inboxLog = [
  '# Inbox log',
  '',
  '2026-09-29 09:30 | 2026-09-29-0930.md | question | answered in chat | ok',
  '2026-09-29 10:05 | 2026-09-29-1000.md | idea | park in later.md | ok',
].join('\n');
const fresh = newInboxNotes(inbox, inboxLog).map((n) => n.name).join(',');
check('newInboxNotes lists unlogged and changed notes, newest first', fresh === '2026-09-29-1000.md,2026-09-29-0900.md');
check('noteHead skips the property block', noteHead('---\ntype: inbox\n---\nCall the hosting vendor\nabout the outage\n') === 'Call the hosting vendor / about the outage');
fs.writeFileSync(path.join(work, 'inbox-log.md'), inboxLog);
const orchInbox = render('orchestrator', paths);
check(
  'the orchestrator gets the inbox block',
  orchInbox.includes('[rig] Inbox: 2 new note(s) from Jas') && orchInbox.includes('2026-09-29-0900.md: Call the hosting vendor / about the outage') && !orchInbox.includes('done note')
);
check('workers never get the inbox', !render('coder', paths).includes('Inbox'));
for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(inbox, `2026-09-30-${1000 + i}.md`), 'note ' + i);
check('the inbox block shows 10 notes plus a count', render('orchestrator', paths).includes('- … and 4 more'));
const rig2 = path.join(tmp, 'rig2');
fs.mkdirSync(path.join(rig2, 'example', 'work'), { recursive: true });
fs.writeFileSync(path.join(rig2, 'example', 'work', 'inbox'), 'a file where the inbox folder should be');
check("an unreadable inbox is a warning, not a crash", render('orchestrator', { work: path.join(rig2, 'example', 'work'), handoffs: hdir }).includes("[rig] WARNING: the inbox (work\\inbox\\) can't be read"));

// refocus v3: startup checks (a docs\ that is a vault or has a history)
const docs = path.join(tmp, 'docs');
const norig = path.join(tmp, 'norig');
fs.mkdirSync(path.join(docs, '.obsidian'), { recursive: true });
fs.mkdirSync(path.join(docs, 'src'), { recursive: true });
fs.writeFileSync(path.join(docs, '.obsidian', 'core-plugins.json'), JSON.stringify({ sync: true, bases: true }));
fs.writeFileSync(path.join(docs, '.obsidian', 'community-plugins.json'), JSON.stringify(['dataview']));
fs.writeFileSync(path.join(docs, 'src', 'route.ts.md'), '');
fs.writeFileSync(path.join(docs, 'plan.md'), 'x');
const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
fs.utimesSync(path.join(docs, 'plan.md'), hoursAgo(3), hoursAgo(3));
let warns = startupWarnings({ work: path.join(norig, 'example', 'work'), docs }).join('\n');
check('warns when Sync is on', warns.includes('Obsidian Sync is not switched off in the "docs" vault'));
check('warns when a community plugin is on', warns.includes('community plugins are enabled in the "docs" vault (dataview)'));
check('warns about stray notes from links to code', warns.includes('1 stray note(s)') && warns.includes('src/route.ts.md'));
check('warns when docs has no history', warns.includes('docs\\ has no readable history'));
fs.mkdirSync(path.join(docs, '.git', 'logs'), { recursive: true });
const commitSec = Math.floor((Date.now() - 5 * 3600000) / 1000);
fs.writeFileSync(path.join(docs, '.git', 'logs', 'HEAD'), `0000000 1111111 Docs history <docs-history@localhost> ${commitSec} +0800\tcommit (initial): auto\n`);
warns = startupWarnings({ work: path.join(norig, 'example', 'work'), docs }).join('\n');
check('warns when docs history is over 2 hours behind', warns.includes("1 file(s) in docs\\ changed over 2 hours ago and aren't in its history yet"));
fs.utimesSync(path.join(docs, 'plan.md'), hoursAgo(1), hoursAgo(1));
fs.utimesSync(path.join(docs, 'src', 'route.ts.md'), hoursAgo(6), hoursAgo(6));
warns = startupWarnings({ work: path.join(norig, 'example', 'work'), docs }).join('\n');
check('no history warning for a change under 2 hours old', !warns.includes("aren't in its history yet"));
fs.writeFileSync(path.join(docs, '.obsidian', 'core-plugins.json'), '{not json');
warns = startupWarnings({ work: path.join(norig, 'example', 'work'), docs }).join('\n');
check('a check that fails is a warning, not a crash', warns.includes('the startup check "docs vault Sync" could not run'));
fs.writeFileSync(path.join(docs, '.obsidian', 'core-plugins.json'), JSON.stringify({ sync: false }));
fs.writeFileSync(path.join(docs, '.obsidian', 'community-plugins.json'), '[]');
fs.rmSync(path.join(docs, 'src'), { recursive: true });
check('no warnings when the vault and the history are healthy', startupWarnings({ work: path.join(norig, 'example', 'work'), docs }).length === 0);

// refocus W9 (M7): a dangling handoff link, a malformed log time, and a long note head must not break Refocus (it never throws)
const hdir9 = path.join(tmp, 'handoffs9');
fs.mkdirSync(hdir9);
fs.writeFileSync(path.join(hdir9, '2026-09-26_PROMPT_next_shift.md'), '## Start here\nreal handoff');
fs.utimesSync(path.join(hdir9, '2026-09-26_PROMPT_next_shift.md'), new Date('2026-09-26'), new Date('2026-09-26'));
let danglingMade = false;
try {
  const target = path.join(tmp, 'gone-target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(hdir9, '2026-09-27_PROMPT_next_shift.md'), 'junction'); // newer name than the real one
  fs.rmSync(target, { recursive: true, force: true }); // now the junction dangles: statSync throws
  danglingMade = true;
} catch {
  /* junctions unavailable: the other two W9 checks still run */
}
if (danglingMade) {
  let threw = false;
  let picked = '';
  try {
    picked = path.basename(newestHandoff(hdir9) || '');
  } catch {
    threw = true;
  }
  check('newestHandoff skips a dangling handoff link instead of throwing', !threw && picked === '2026-09-26_PROMPT_next_shift.md');
  const paths9 = { work: path.join(tmp, 'empty'), handoffs: hdir9 };
  let rendered = null;
  try {
    rendered = render('orchestrator', paths9);
  } catch {
    rendered = null;
  }
  check('render does not throw on a dangling handoff link', rendered !== null && rendered.includes('real handoff'));
}
check('a malformed log time does not hide a note (M7)', newInboxNotes(inbox, '2026-09-29 25:99 | 2026-09-29-0900.md | q | x | ok').some((n) => n.name === '2026-09-29-0900.md'));
check('noteHead caps the head at 200 characters (M7)', noteHead('x'.repeat(500)).length === 200 && noteHead('a / b / c').length <= 200);

// v4 P3: each project's paths come from its profile; a plain layout (plain docs\, no vault, no docs history, no inbox) warns about
// nothing; a missing or unknown --project is one warning line, never a throw; the rotation message names the project's handoff folder.
// pg* below is that plain layout, a second project in temp folders.
const { projectPaths, cli: refocusCli } = require('./refocus.cjs');
const { loadProfile, RIG_DIR } = require('./guard.cjs');
const RIGF = RIG_DIR; // refocus.cjs and context-check.cjs write the rig as the guard does: real path, case on disk, forward slashes
const safe = (fn) => {
  try {
    return fn();
  } catch (e) {
    return 'THREW ' + e.message;
  }
};
check(
  'projectPaths for example: the work folder in the rig refocus.cjs is in, handoffs and docs in its main checkout',
  JSON.stringify(safe(() => projectPaths(loadProfile('example')))) ===
    JSON.stringify({ work: `${RIGF}/example/work`, handoffs: 'C:/example-project/.agent/handoffs', docs: 'C:/example-project/docs' })
);
const pgRoot = path.join(tmp, 'sample');
const pgWork = path.join(tmp, 'rigsm', 'sample', 'work');
fs.mkdirSync(path.join(pgWork, 'notes'), { recursive: true });
fs.mkdirSync(path.join(pgRoot, '.agent', 'handoffs'), { recursive: true });
fs.mkdirSync(path.join(pgRoot, 'docs'), { recursive: true });
fs.writeFileSync(path.join(pgWork, 'now.md'), 'Ticket: SM-3 page copy');
fs.writeFileSync(path.join(pgWork, 'notes', 'coder.md'), 'Run npm run lint before you report.');
fs.writeFileSync(path.join(pgRoot, '.agent', 'handoffs', '2026-10-02_PROMPT_next_shift.md'), '## Start here\nsample handoff');
fs.writeFileSync(path.join(pgRoot, 'docs', 'notes.md'), 'x');
fs.utimesSync(path.join(pgRoot, 'docs', 'notes.md'), hoursAgo(5), hoursAgo(5)); // old enough for the docs-history check, had it run
const pgPaths = { work: pgWork, handoffs: path.join(pgRoot, '.agent', 'handoffs'), docs: path.join(pgRoot, 'docs') };
const pgOrch = safe(() => render('orchestrator', pgPaths));
check('plain layout: the orchestrator gets now.md and the newest Start here block', pgOrch.includes('SM-3 page copy') && pgOrch.includes('sample handoff'));
// The whole output, so a render that threw (safe's 'THREW ...') or printed anything else fails too.
const pgOrchWant = '[rig] Current intent (now.md):\nTicket: SM-3 page copy\n\n[rig] Newest handoff 2026-10-02_PROMPT_next_shift.md (Start here block):\nsample handoff';
check('plain layout: no warning (no vault, no docs history, no inbox), only now.md and the handoff', pgOrch === pgOrchWant);
check('plain layout: startupWarnings is empty', JSON.stringify(safe(() => startupWarnings(pgPaths))) === '[]');
check('plain layout without a docs folder: still no warning, the same output', safe(() => render('orchestrator', { ...pgPaths, docs: path.join(pgRoot, 'nodocs') })) === pgOrchWant);
check('plain layout: the coder gets now.md and its notes', safe(() => render('coder', pgPaths)).includes('npm run lint before you report'));
for (const [label, argv, words] of [
  ['no --project', ['node', 'refocus.cjs', '--seat', 'coder'], ['without --project']],
  ['an unknown project', ['node', 'refocus.cjs', '--project', 'nosuch', '--seat', 'coder'], ['unknown project "nosuch"']],
  ['a bad project name', ['node', 'refocus.cjs', '--project', '..', '--seat', 'coder'], ['is not a project name']],
]) {
  const out = safe(() => refocusCli(argv));
  check(`Refocus with ${label} prints one [rig] WARNING line`, out.startsWith('[rig] WARNING: ') && !out.includes('\n') && words.every((x) => out.includes(x)) && out.includes('--project <name> --seat <seat>'));
}
const { spawnSync } = require('child_process');
let res = spawnSync(process.execPath, [path.join(__dirname, 'refocus.cjs'), '--seat', 'coder'], { encoding: 'utf8' });
check('the Refocus CLI without --project exits 0 with the warning line', res.status === 0 && res.stdout.startsWith('[rig] WARNING: Refocus was started without --project'));
// Started through a lower-cased path, Refocus and the rotation check still name the rig as the guard's RIG_DIR (case on disk), the way
// the settings files' hook commands write it.
const lowerRig = __dirname.toLowerCase();
res = spawnSync(process.execPath, [path.join(lowerRig, 'refocus.cjs'), '--seat', 'coder'], { encoding: 'utf8' });
check("Refocus started through a lower-cased path names the guard's RIG_DIR in its warning", res.status === 0 && res.stdout.includes(`node ${RIG_DIR}/refocus.cjs --project <name>`));
res = spawnSync(process.execPath, [path.join(lowerRig, 'context-check.cjs')], { input: '', encoding: 'utf8' });
check("the rotation check started through a lower-cased path names the guard's RIG_DIR in its warning", res.status === 0 && res.stdout.includes(`node ${RIG_DIR}/context-check.cjs --project <name>`));
const pw = safe(() => warning(400050, 400000, { name: 'sample', rootDir: 'D:/work/sample-app' }));
check('the rotation warning names the project and its handoff folder', pw.includes('D:/work/sample-app/.agent/handoffs/<YYYY-MM-DD>_PROMPT_next_shift.md') && pw.includes("sample's main checkout"));
check("example's rotation warning names its handoff folder", w.includes('C:/example-project/.agent/handoffs/<YYYY-MM-DD>_PROMPT_next_shift.md'));
const transcriptFile = path.join(tmp, 'transcript.jsonl');
fs.writeFileSync(transcriptFile, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10 } } }));
const hookIn = JSON.stringify({ transcript_path: transcriptFile });
const rotation = (args) => spawnSync(process.execPath, [path.join(__dirname, 'context-check.cjs'), ...args], { input: hookIn, encoding: 'utf8' });
// V4-R3: the rotation check never blocks Jas's prompt. A missing or unknown --project, or a profile it can't read, is one warning line
// on stdout and exit 0 (the guard still refuses the lane's tool calls).
const oneWarning = (r, words) => r.status === 0 && r.stderr === '' && r.stdout.startsWith('[rig] WARNING: ') && r.stdout.endsWith('\n') && !r.stdout.slice(0, -1).includes('\n') && words.every((x) => r.stdout.includes(x));
res = rotation([]);
check('the rotation check without --project: one warning line, exit 0', oneWarning(res, ['without --project', 'context-check.cjs --project <name>']));
res = rotation(['--project']);
check('the rotation check with a trailing --project: one warning line, exit 0', oneWarning(res, ['without --project']));
res = rotation(['--project', 'nosuch']);
check('the rotation check with an unknown project: one warning line, exit 0', oneWarning(res, ['unknown project "nosuch"']));
res = rotation(['--project', 'example']);
check('the rotation check with --project example under the limit: exit 0, nothing printed', res.status === 0 && res.stdout === '' && res.stderr === '');
// A profile that is not valid JSON, on copies of the three scripts in a temp rig (each reads <its folder>/<name>/profile.json): Refocus
// and the rotation check each print one warning line naming the file and exit 0.
const rigCopy = path.join(tmp, 'rigcopy');
fs.mkdirSync(path.join(rigCopy, 'broken'), { recursive: true });
for (const f of ['guard.cjs', 'refocus.cjs', 'context-check.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(rigCopy, f));
fs.writeFileSync(path.join(rigCopy, 'broken', 'profile.json'), '{ "name": "broken",');
res = spawnSync(process.execPath, [path.join(rigCopy, 'refocus.cjs'), '--project', 'broken', '--seat', 'coder'], { encoding: 'utf8' });
check('Refocus with a profile that is not valid JSON: one warning line naming the file, exit 0', oneWarning(res, ['broken/profile.json is not valid JSON']));
res = spawnSync(process.execPath, [path.join(rigCopy, 'context-check.cjs'), '--project', 'broken'], { input: hookIn, encoding: 'utf8' });
check('the rotation check with a profile that is not valid JSON: one warning line naming the file, exit 0', oneWarning(res, ['broken/profile.json is not valid JSON']));

// settingsrc build: Refocus --claude-md, its own SessionStart hook. Where a profile says projectSettings false, Claude Code doesn't load the
// repo's CLAUDE.md (--setting-sources user,local drops it), so this mode prints a header and the file, or over 9,000 characters a line that
// says to read it. Nothing for projectSettings true or a missing file; any failure is one warning line and exit 0. The scratch projects
// live in the temp rig copy (rigCopy, whose guard and refocus are this folder's), their roots in tmp written with forward slashes.
const CLAUDE_MD_HEADER = (name) =>
  `[rig] ${name}'s repo settings are off in rig sessions (they can run commands; see its profile's projectSettings), so its CLAUDE.md is not loaded. It follows; read it as the project's CLAUDE.md, and where it differs from your role file or the guard, they win.`;
const exProfileJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'example', 'profile.json'), 'utf8'));
const scratchProject = (name, projectSettings) => {
  const root = path.join(tmp, name + '-root');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(rigCopy, name), { recursive: true });
  fs.writeFileSync(path.join(rigCopy, name, 'profile.json'), JSON.stringify({ ...exProfileJson, name, root: root.replace(/\\/g, '/'), projectSettings }));
  return root;
};
const offRoot = scratchProject('scratchoff', false);
const onRoot = scratchProject('scratchon', true);
const claudeMd = (project, extra = []) => spawnSync(process.execPath, [path.join(rigCopy, 'refocus.cjs'), '--project', project, '--seat', 'coder', '--claude-md', ...extra], { encoding: 'utf8' });
const printed = (r, text) => r.status === 0 && r.stderr === '' && r.stdout === text + '\n';
fs.writeFileSync(path.join(offRoot, 'CLAUDE.md'), '\u{FEFF}# Scratch rules\r\nRun npm run lint before you report.\r\n');
check('--claude-md, projectSettings false, a short CLAUDE.md with a BOM and CRLF: the header, then the text (no BOM, LF), exit 0', printed(claudeMd('scratchoff'), CLAUDE_MD_HEADER('scratchoff') + '\n# Scratch rules\nRun npm run lint before you report.\n'));
fs.writeFileSync(path.join(offRoot, 'CLAUDE.md'), 'a'.repeat(9000));
check('--claude-md: a CLAUDE.md of exactly 9,000 characters is printed whole', printed(claudeMd('scratchoff'), CLAUDE_MD_HEADER('scratchoff') + '\n' + 'a'.repeat(9000)));
fs.writeFileSync(path.join(offRoot, 'CLAUDE.md'), ('b'.repeat(89) + '\r\n').repeat(100)); // 9,100 characters on disk, 9,000 with LF line ends
check('--claude-md: the count is of the text as printed (CRLF as LF): 9,100 on disk, 9,000 printed whole', printed(claudeMd('scratchoff'), CLAUDE_MD_HEADER('scratchoff') + '\n' + ('b'.repeat(89) + '\n').repeat(100)));
fs.writeFileSync(path.join(offRoot, 'CLAUDE.md'), 'c'.repeat(9001));
check(
  '--claude-md: a CLAUDE.md of 9,001 characters: the header, then the Read line naming the file with backslashes (the root is written with forward slashes)',
  printed(claudeMd('scratchoff'), CLAUDE_MD_HEADER('scratchoff') + `\nIt is 9001 characters, too long to print here: before your first task, read ${offRoot}\\CLAUDE.md in full with the Read tool.`) && offRoot.includes('\\')
);
fs.rmSync(path.join(offRoot, 'CLAUDE.md'));
res = claudeMd('scratchoff');
check('--claude-md, projectSettings false, no CLAUDE.md: nothing, exit 0', res.status === 0 && res.stdout === '' && res.stderr === '');
fs.mkdirSync(path.join(offRoot, 'CLAUDE.md'));
check("--claude-md: a CLAUDE.md it can't read (a folder) is one warning line, exit 0", oneWarning(claudeMd('scratchoff'), ['CLAUDE.md', '--claude-md']));
fs.writeFileSync(path.join(onRoot, 'CLAUDE.md'), '# On rules\n');
res = claudeMd('scratchon');
check('--claude-md, projectSettings true, a CLAUDE.md there: nothing, exit 0', res.status === 0 && res.stdout === '' && res.stderr === '');
check('--claude-md with a profile that is not valid JSON: one warning line naming the file, exit 0', oneWarning(claudeMd('broken'), ['broken/profile.json is not valid JSON', '--claude-md']));
check('--claude-md without --project: one warning line, exit 0', oneWarning(spawnSync(process.execPath, [path.join(rigCopy, 'refocus.cjs'), '--seat', 'coder', '--claude-md'], { encoding: 'utf8' }), ['without --project']));
// The temp rig's own refocus.cjs in process (it loads the temp rig's guard copy, so it reads the scratch profiles): a rig in another folder.
const rigRefocus = require(path.join(rigCopy, 'refocus.cjs'));
const rigGuard = require(path.join(rigCopy, 'guard.cjs'));
res = spawnSync(process.execPath, [path.join(rigCopy, 'refocus.cjs'), '--project', 'scratchon', '--seat', 'orchestrator', '--claude-md'], { encoding: 'utf8' });
check('--claude-md for the orchestrator of a projectSettings true project with a CLAUDE.md: nothing, exit 0', res.status === 0 && res.stdout === '' && res.stderr === '');
check('--claude-md for it in process: nothing', safe(() => rigRefocus.cli(['node', 'refocus.cjs', '--project', 'scratchon', '--seat', 'orchestrator', '--claude-md'])) === '');
const offRootF = offRoot.replace(/\\/g, '/');
check(
  "projectPaths in the temp rig: the work folder in that rig (refocus.cjs's own folder), handoffs and docs in the project's root",
  JSON.stringify(safe(() => rigRefocus.projectPaths(rigGuard.loadProfile('scratchoff')))) ===
    JSON.stringify({ work: `${rigGuard.RIG_DIR}/scratchoff/work`, handoffs: `${offRootF}/.agent/handoffs`, docs: `${offRootF}/docs` })
);
// Refocus without --claude-md is what it was: for every seat of both scratch projects the CLI prints render() of the project's paths, and
// for the scratch project with projectSettings false and a CLAUDE.md, nothing of the file.
fs.rmSync(path.join(offRoot, 'CLAUDE.md'), { recursive: true });
fs.writeFileSync(path.join(offRoot, 'CLAUDE.md'), '# Scratch rules\n');
for (const project of ['scratchon', 'scratchoff'])
  for (const seat of ['orchestrator', 'coder', 'angela', 'oscar', 'pam'])
    check(`Refocus without --claude-md (${project} ${seat}) dispatches to render() of its paths (render itself is unchanged since 3d78192)`, safe(() => rigRefocus.cli(['node', 'refocus.cjs', '--project', project, '--seat', seat])) === safe(() => rigRefocus.render(seat, rigRefocus.projectPaths(rigGuard.loadProfile(project)))));
res = spawnSync(process.execPath, [path.join(rigCopy, 'refocus.cjs'), '--project', 'scratchoff', '--seat', 'coder'], { encoding: 'utf8' });
check('Refocus without --claude-md, projectSettings false and a CLAUDE.md: none of it printed, exit 0', res.status === 0 && !res.stdout.includes('CLAUDE.md') && !res.stdout.includes('Scratch rules'));

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`helpers: ${failed} of ${total} checks failed`);
  process.exit(1);
}
console.log(`helpers: all ${total} checks passed`);
