'use strict';
// Fake herdr for the rig's self-tests (close.selftest.ps1, rig.selftest.ps1, lanes.selftest.ps1, launch.selftest.ps1): each test copies this file next to a
// herdr.cmd in a temp bin folder and puts only that folder, node and Windows on PATH, so the real herdr (Jas's live server) is never called.
// It answers from state.json next to it, in herdr 0.8.2's JSON shapes, changes the state as herdr would, and appends every call to
// calls.log with its words joined by tabs (a root with a blank stays one word). A command named in state.json's `canned` (its words joined
// by blanks) gets that answer instead: `oops` (not JSON, exit 0), `long` (1,000 characters that are not JSON, exit 0), `noid` (JSON
// without the id, exit 0) or a herdr error code (exit 1).
// State: panes [{ pane_id, tab_id, workspace_id, agent, name, agent_status, stubborn, args, cwd }], tabs [{ tab_id, workspace_id, label }],
// current (the calling pane), names (workspace labels), canned, notReady (pane id -> how many more agent starts in it answer
// agent_pane_unavailable: its shell is not at its prompt yet), made (the last pane number per space: herdr never reuses a pane id), and for
// launch.selftest.ps1: down (no server: api snapshot answers server_not_running), an agent pane's terminal_title_stripped, a pane's fg
// (its foreground command lines for pane process-info) and ran (what pane run typed into it), focused (the last workspace focus).
// An /exit ends the agent (its herdr name goes with it) unless the pane is stubborn; a blocked agent refuses a prompt; a closed tab takes
// its panes; a split opens a pane in the anchor's tab; agent start puts a named agent in an empty pane.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'state.json');
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), a.join('\t') + '\n');
const ok = (result) => process.stdout.write(JSON.stringify({ id: 'cli:fake', result }) + '\n');
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ id: 'cli:fake', error: { code, message } }) + '\n');
  process.exitCode = 1;
};
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const named = (n) => s.panes.find((p) => p.name === n && p.agent);
const pane = (id) => s.panes.find((p) => p.pane_id === id);
const opt = (name) => a[a.indexOf(name) + 1];
const cmd = a.slice(0, 2).join(' ');
const canned = (s.canned || {})[a.join(' ')];
if (canned === 'oops') process.stdout.write('oops\n');
else if (canned === 'long') process.stdout.write('x'.repeat(1000) + '\n');
else if (canned === 'noid') ok({ type: 'ok' });
else if (canned) fail(canned, a.join(' ') + ' failed');
else if (cmd === 'pane current' && a[2] === '--current' && a.length === 3) {
  const p = pane(s.current);
  p ? ok({ type: 'pane_current', pane: p }) : fail('pane_not_found', 'no current pane');
} else if (cmd === 'pane list' && a.length === 2) ok({ type: 'pane_list', panes: s.panes });
else if (cmd === 'tab list' && a.length === 2) ok({ type: 'tab_list', tabs: s.tabs });
else if (cmd === 'workspace rename' && a.length === 4) {
  s.names = { ...s.names, [a[2]]: a[3] };
  save();
  ok({ type: 'ok' });
} else if (cmd === 'tab create') {
  const tab = { tab_id: opt('--workspace') + ':t' + (s.tabs.length + 1), workspace_id: opt('--workspace'), label: opt('--label') };
  s.tabs.push(tab);
  save();
  ok({ type: 'tab_created', tab, root_pane: { pane_id: tab.workspace_id + ':p9', tab_id: tab.tab_id, workspace_id: tab.workspace_id } });
} else if (cmd === 'pane split') {
  const from = pane(a[2]);
  if (!from) fail('pane_not_found', 'no pane ' + a[2]);
  else {
    const ws = from.workspace_id;
    const n = Math.max(0, (s.made || {})[ws] || 0, ...s.panes.filter((p) => p.workspace_id === ws).map((p) => Number(p.pane_id.split(':p')[1]) || 0)) + 1;
    s.made = { ...s.made, [ws]: n };
    const p = { pane_id: `${ws}:p${n}`, tab_id: from.tab_id, workspace_id: ws, cwd: opt('--cwd') };
    s.panes.push(p);
    save();
    ok({ type: 'pane_split', pane: p });
  }
} else if (cmd === 'agent start' && a[3] === '--kind' && a[5] === '--pane' && a[7] === '--') {
  const p = pane(a[6]);
  if (!p) fail('pane_not_found', 'no pane ' + a[6]);
  else if ((s.notReady || {})[a[6]] > 0) {
    s.notReady[a[6]]--;
    save();
    fail('agent_pane_unavailable', a[6] + "'s shell is not at its interactive prompt yet");
  } else if (p.agent) fail('pane_busy', a[6] + ' already runs an agent');
  else if (named(a[2])) fail('agent_name_taken', a[2] + ' already runs');
  else {
    Object.assign(p, { agent: a[4], name: a[2], agent_status: 'idle', args: a.slice(8) });
    save();
    ok({ type: 'agent_started', agent: { ...p } });
  }
} else if (cmd === 'agent get' && a.length === 3) {
  const p = named(a[2]);
  p ? ok({ type: 'agent_info', agent: { ...p } }) : fail('agent_not_found', 'no agent ' + a[2]);
} else if (cmd === 'agent prompt' && a.length === 4) {
  const p = named(a[2]);
  if (!p) fail('agent_not_found', 'no agent ' + a[2]);
  else if (p.agent_status === 'blocked') fail('agent_blocked', a[2] + ' is blocked');
  else {
    if (a[3] === '/exit' && !p.stubborn) Object.assign(p, { agent: null, name: null, agent_status: 'unknown' });
    save();
    ok({ type: 'agent_prompted' });
  }
} else if (cmd === 'pane close' && a.length === 3) {
  const i = s.panes.findIndex((p) => p.pane_id === a[2]);
  if (i < 0) fail('pane_not_found', 'no pane ' + a[2]);
  else {
    s.panes.splice(i, 1);
    save();
    ok({ type: 'ok' });
  }
} else if (cmd === 'tab close' && a.length === 3) {
  const i = s.tabs.findIndex((t) => t.tab_id === a[2]);
  if (i < 0) fail('tab_not_found', 'no tab ' + a[2]);
  else {
    s.tabs.splice(i, 1);
    s.panes = s.panes.filter((p) => p.tab_id !== a[2]);
    save();
    ok({ type: 'ok' });
  }
} else if (cmd === 'api snapshot' && a.length === 2) {
  // The rig-view build (launch.selftest.ps1): `down` = no server; spaces are the ids of the panes and tabs, labelled from names.
  // Only the fields herdr 0.9.5 shows (probed 2026-11-18): a shell pane has no agent or title fields; agents[] carry the herdr name.
  if (s.down) fail('server_not_running', 'no herdr server is running');
  else {
    const ids = [...new Set([...s.panes, ...s.tabs].map((x) => x.workspace_id))];
    const workspaces = ids.map((id) => ({ workspace_id: id, label: (s.names || {})[id] || '' }));
    const base = (p) => ({ pane_id: p.pane_id, tab_id: p.tab_id, workspace_id: p.workspace_id, cwd: p.cwd, agent_status: p.agent ? p.agent_status || 'idle' : 'unknown' });
    const withAgent = (p) => ({ ...base(p), agent: p.agent, terminal_title_stripped: p.terminal_title_stripped || '' });
    const panes = s.panes.map((p) => (p.agent ? withAgent(p) : base(p)));
    const agents = s.panes.filter((p) => p.agent).map((p) => ({ ...withAgent(p), ...(p.name ? { name: p.name } : {}) }));
    ok({ type: 'snapshot', snapshot: { version: '0.9.5', protocol: 22, workspaces, tabs: s.tabs, panes, agents } });
  }
} else if (cmd === 'pane process-info' && a.length === 4 && a[2] === '--pane') {
  // A pane's foreground: its fg list (command lines) when set, else claude for an agent pane and the shell for any other.
  const p = pane(a[3]);
  if (!p) fail('pane_not_found', 'no pane ' + a[3]);
  else {
    const fg = p.fg || [p.agent ? 'C:\\Users\\you\\.local\\bin\\claude.exe' : 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoExit -Command x'];
    ok({ type: 'process_info', process_info: { foreground_processes: fg.map((c) => ({ argv0: c.split(' ')[0], cmdline: c })) } });
  }
} else if (cmd === 'workspace create' && a.length === 7 && a[2] === '--cwd' && a[4] === '--label' && a[6] === '--no-focus') {
  const ws = 'w' + (Math.max(0, ...[...s.panes, ...s.tabs].map((x) => Number(x.workspace_id.slice(1)) || 0)) + 1);
  const tab = { tab_id: ws + ':t1', workspace_id: ws, label: '1' };
  const p = { pane_id: ws + ':p1', tab_id: tab.tab_id, workspace_id: ws, cwd: a[3] };
  s.tabs.push(tab);
  s.panes.push(p);
  s.names = { ...s.names, [ws]: a[5] };
  save();
  ok({ type: 'workspace_created', workspace: { workspace_id: ws, label: a[5] }, tab, root_pane: p });
} else if (cmd === 'pane run' && a.length === 4) {
  const p = pane(a[2]);
  if (!p) fail('pane_not_found', 'no pane ' + a[2]);
  else {
    p.ran = [...(p.ran || []), a[3]];
    save();
    ok({ type: 'ok' });
  }
} else if (cmd === 'workspace focus' && a.length === 3) {
  if (![...s.panes, ...s.tabs].some((x) => x.workspace_id === a[2])) fail('workspace_not_found', 'no workspace ' + a[2]);
  else {
    s.focused = a[2];
    save();
    ok({ type: 'ok' });
  }
} else {
  process.stderr.write('fake herdr: unexpected command: ' + a.join(' ') + '\n');
  process.exitCode = 2;
}
