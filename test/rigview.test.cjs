'use strict';
// Run: node <rig>/test/rigview.test.cjs   (exit 1 on any miss)
// Checks bin/rigview.mjs (README, Daily use) on a made-up rig in %TEMP%: two projects, a saved herdr snapshot
// (--snapshot, so herdr is never called) and one lane transcript (CLAUDE_CONFIG_DIR). One --once frame per view, without colour.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let total = 0;
let failed = 0;
function check(label, ok) {
  total++;
  if (!ok) {
    failed++;
    console.error('FAIL ' + label);
  }
}

const VIEW = path.join(__dirname, '..', 'bin', 'rigview.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-view-'));
const rig = path.join(tmp, 'my rig');
const put = (rel, text) => {
  const f = path.join(rig, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};
put('bin/lanes.ps1', [
  "    coder = '--model', 'opus', '--effort', 'max', '--permission-mode', 'auto'",
  "    angela = '--model', 'fable', '--effort', 'xhigh', '--permission-mode', 'auto'",
  "    oscar = '--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'auto'",
  "    pam = '--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'auto'",
].join('\n'));
put('bin/rig.ps1', '  claude --dangerously-skip-permissions --model opus --effort high -n $lane');
const lanes = (pre) => ({ orchestrator: pre + 'orchestrator', coder: pre + 'coder', angela: pre + 'angela', oscar: pre + 'oscar', pam: pre + 'pam' });
put('alpha/profile.json', JSON.stringify({ name: 'alpha', lanes: lanes('') }));
put('beta/profile.json', JSON.stringify({ name: 'beta', lanes: lanes('b-') }));
put('alpha/work/now.md', [
  'Goal: the dashboard never shows a wrong number',
  'Mission: fix the last two dashboard leftovers',
  'Ticket · plan: AL-1 dashboard leftovers · plan none · next: angela reviews round 2',
  'Done when: both fixes ship with a test each',
].join('\n'));
put('alpha/active-worktree', 'C:\\work\\al1-leftovers\n');
put('alpha/work/log.md', ['# Task log', '', '2026-11-16 | AL-0 | prompts 4 | rounds 1 | ~30 min | PASS | the first fix'].join('\n'));
const older = put('alpha/work/briefs/al0-coder.md', 'Ticket: AL-0 The first fix\nDone when: it works\n');
fs.utimesSync(older, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
put('alpha/work/briefs/al1-coder-t2.md', 'Ticket: AL-1 Make the dropdown show full text\nDone when: hover shows it\n');

// One transcript: coder's. A sidechain line with a bigger usage and an older tool call come first; the last main-chain turn wins.
const cfg = path.join(tmp, 'claude config');
const sid = '11111111-2222-3333-4444-555555555555';
const tr = path.join(cfg, 'projects', 'C--work-al1-leftovers', sid + '.jsonl');
fs.mkdirSync(path.dirname(tr), { recursive: true });
const turn = (content, usage, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content, usage }, ...extra });
fs.writeFileSync(tr, [
  turn([{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\x\\old.ts' } }], { input_tokens: 10, cache_read_input_tokens: 90000 }),
  turn([{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\x\\StyledSelect.tsx' } }], { input_tokens: 1000, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000 }),
  JSON.stringify({ type: 'user', message: { content: 'ok' } }),
].join('\n') + '\n');

const agent = (o) => ({ agent: 'claude', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'idle', terminal_title_stripped: o.name || '', ...o });
const snapshot = {
  result: {
    snapshot: {
      version: '0.9.5',
      protocol: 22,
      workspaces: [{ workspace_id: 'w1', label: 'alpha' }],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' }, { tab_id: 'w1:t2', workspace_id: 'w1', label: 'seats' }],
      panes: [],
      agents: [
        agent({ pane_id: 'w1:p1', agent_status: 'working', terminal_title_stripped: 'orchestrator' }), // no name: matched by its title
        agent({ pane_id: 'w1:p2', name: 'coder', agent_session: { value: sid } }),
        agent({ pane_id: 'w1:p3', name: 'angela', agent_status: 'blocked' }),
        agent({ pane_id: 'w1:p4', name: 'oscar', agent_status: 'done' }),
        agent({ pane_id: 'w1:p5', name: 'pam', tab_id: 'w1:t2' }),
      ],
    },
  },
};
const snap = path.join(tmp, 'snapshot.json');
fs.writeFileSync(snap, JSON.stringify(snapshot));

const W = 160;
function frame(viewFlag, snapFile = snap) {
  const r = spawnSync(process.execPath, [VIEW, rig, '--once', '--snapshot', snapFile, ...(viewFlag ? [viewFlag] : [])], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', COLUMNS: String(W), CLAUDE_CONFIG_DIR: cfg },
  });
  return { code: r.status, lines: r.stdout.split('\n').filter((l, i, a) => i < a.length - 1), err: r.stderr };
}
const row = (lines, name) => lines.find((l) => l.includes('║ ' + name + ' ')) || '';

// TABLE
let f = frame(null);
check('table: exits 0, nothing on stderr', f.code === 0 && f.err === '');
check(`table: every line is exactly ${W} columns`, f.lines.length > 20 && f.lines.every((l) => [...l].length === W));
check('table: both rigs get a frame', f.lines.some((l) => l.includes('╔═ ALPHA ')) && f.lines.some((l) => l.includes('╔═ BETA ')));
check('table: the frame title names the space and the counts', f.lines.some((l) => l.includes('space alpha · 1 BLOCKED · 1 working · 1 done · 2 idle')));
check('table: the nameless orchestrator is matched by its terminal title', row(f.lines, 'orchestrator').includes('● working'));
check('table: models and efforts come from lanes.ps1 and rig.ps1', row(f.lines, 'orchestrator').includes('opus · high') && row(f.lines, 'coder').includes('opus · max') && row(f.lines, 'oscar').includes('sonnet · med'));
check('table: a blocked lane says BLOCKED', row(f.lines, 'angela').includes('◐ BLOCKED'));
check('table: CTX is the last main-chain turn (context-check.cjs count)', row(f.lines, 'coder').includes('153k'));
check('table: NOW is the last tool call', row(f.lines, 'coder').includes('Edit StyledSelect.tsx'));
check('table: LAST BRIEF is the newest brief of that seat', row(f.lines, 'coder').includes('al1-t2 · '));
check('table: pam sits in the seats tab', row(f.lines, 'pam').includes('seats'));
check('table: a lane herdr does not know is off', row(f.lines, 'b-coder').includes('○ off'));
check('table: ticket, next and worktree come from the rig files', f.lines.some((l) => l.includes('ticket    AL-1 dashboard leftovers')) && f.lines.some((l) => l.includes('next      angela reviews round 2')) && f.lines.some((l) => l.includes('C:\\work\\al1-leftovers')));
check('table: the summary counts what waits on you', f.lines.some((l) => l.includes('10 seats · 1 working · 1 need you · 1 done, unseen')));
check('top bar: a rig shows its loudest state (blocked)', f.lines[0].includes('◐ alpha') && f.lines[0].includes('○ beta'));
check('status bar: names herdr and says read-only', f.lines[f.lines.length - 1].includes('herdr 0.9.5') && f.lines[f.lines.length - 1].includes('read-only'));
check('tree: each rig lists its seats', f.lines.some((l) => l.includes('■ alpha')) && f.lines.some((l) => l.includes('├ ◐ angela')));

// RECENT
f = frame('--recent');
const i1 = f.lines.findIndex((l) => l.includes('al1-coder-t2.md'));
const i0 = f.lines.findIndex((l) => l.includes('al0-coder.md'));
check('recent: briefs newest first, with lane@rig', i1 > 0 && i0 > i1 && f.lines[i1].includes('coder@alpha'));
check("recent: a brief's line under it is its Ticket: line", f.lines[i1 + 1].includes('AL-1 Make the dropdown show full text'));
check('recent: finished tickets come from log.md', f.lines.some((l) => l.includes('2026-11-16') && l.includes('PASS') && l.includes('AL-0 @alpha')));

// OVERVIEW
f = frame('--overview');
check('overview: Goal, Mission, Ticket and Done when from now.md', ['goal       the dashboard never shows', 'mission    fix the last two', 'ticket     AL-1 dashboard', 'done when  both fixes ship'].every((s) => f.lines.some((l) => l.includes(s))));
check('overview: the last finished ticket', f.lines.some((l) => l.includes('last done  2026-11-16 · AL-0 · PASS')));

// GRAPH (the first rig)
f = frame('--graph');
check('graph: the orchestrator card and four lane cards', f.lines.filter((l) => (l.match(/┌─/g) || []).length === 4).length === 1 && f.lines.some((l) => l.includes('│ orchestrator')));
check('graph: the hub edges reach every lane', f.lines.some((l) => (l.match(/▼/g) || []).length === 4));
check('graph: a blocked card says so', f.lines.some((l) => l.includes('◐ BLOCKED')));

// herdr answering an error instead of a snapshot: the frame says so and the view does not crash
const bad = path.join(tmp, 'error.json');
fs.writeFileSync(bad, JSON.stringify({ id: 'cli:api:snapshot', error: { code: 'server_not_running', message: 'no herdr server' } }));
f = frame(null, bad);
check('no snapshot: exit 0 and the error shows', f.code === 0 && f.lines.some((l) => l.includes('herdr gave no snapshot') && l.includes('server_not_running')));

// A folder with no project: the frame says so instead of crashing in a view that needs a rig.
for (const v of [null, '--graph', '--recent']) {
  const r = spawnSync(process.execPath, [VIEW, path.join(tmp, 'claude config'), '--once', '--snapshot', snap, ...(v ? [v] : [])], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', COLUMNS: String(W) } });
  check(`no rig (${v || 'table'}): exit 0 and it says why`, r.status === 0 && r.stdout.includes('no rig folder with a profile.json'));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`rigview: ${failed} of ${total} checks failed`);
  process.exit(1);
}
console.log(`rigview: all ${total} checks passed`);
