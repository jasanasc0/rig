#!/usr/bin/env node
// rigview.mjs - the rig view (README, Daily use): a read-only OpenRig-style view of every rig.
// Reads `herdr api snapshot`, the rig's files and each lane's Claude transcript; never sends keys to, focuses, starts or stops a lane.
// The owner's own: launch.ps1 starts it in herdr's `view` space; the guard keeps every seat's shell off this file.
// Palette and the ● ◐ ○ status vocabulary are adapted from OpenRig's packages/tui/src/theme.ts and
// topology/glyphs.ts (github.com/mvschwarz/openrig, Apache-2.0). No code copied.
// Run: node rigview.mjs [rigDir] [--recent|--overview|--graph] [--once] [--snapshot <file>]
// --snapshot reads a saved `herdr api snapshot` answer instead of asking herdr (test\rigview.test.cjs); --once prints one frame and ends.
// Keys: t r o g (or ←/→) views, Tab next rig, q quit; click the view tabs, rig names and the explorer tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { lastContextTokens } = createRequire(import.meta.url)('../hooks/context-check.cjs');

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const SNAP = args.includes('--snapshot') ? args[args.indexOf('--snapshot') + 1] : null;
const RIG = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--snapshot') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Claude Code keeps its transcripts under CLAUDE_CONFIG_DIR when that is set, else ~\.claude.
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const EVERY = 3000, TREE_W = 24;
const VIEWS = ['table', 'recent', 'overview', 'graph'];
const short = e => ({ medium: 'med' })[e] ?? e;

// ---- look: OpenRig's truecolor tokens; null = the terminal's own foreground
// shortcut: truecolor only, add a 256-color table if herdr's panes ever show wrong colors
const C = {
  accent: [111, 168, 255], accentBright: [154, 194, 255], warn: [244, 190, 92], error: [224, 108, 117], ok: [152, 195, 121],
  dim: [109, 116, 128], chrome: [78, 105, 145], selection: [34, 52, 82], ink: [12, 10, 9],
  actActive: [152, 195, 121], actIdle: [110, 142, 170], actDone: [111, 168, 255], actOff: [109, 116, 128], actAttention: [230, 181, 110],
};
const PLAIN = !!process.env.NO_COLOR;
const sgr = (tok, o = {}) => {
  if (PLAIN) return '';
  const p = [];
  if (o.bold) p.push(1);
  p.push(C[tok] ? `38;2;${C[tok].join(';')}` : '39');
  if (o.bg) p.push(`48;2;${C[o.bg].join(';')}`);
  return `\x1b[${p.join(';')}m`;
};
// herdr state -> [glyph, token, label, loudness]
const ST = {
  blocked: ['◐', 'actAttention', 'BLOCKED', 5], working: ['●', 'actActive', 'working', 4], done: ['●', 'actDone', 'done', 3],
  idle: ['●', 'actIdle', 'idle', 2], unknown: ['○', 'actOff', 'unknown', 1], off: ['○', 'actOff', 'off', 0],
};
const st = s => ST[s] ?? ST.unknown;

// ---- a character canvas: every cell is [char, token, opts]; width math holds because every glyph used is one column
function canvas(w, h) {
  const cells = Array.from({ length: h }, () => Array.from({ length: w }, () => [' ', null, null]));
  return {
    put(x, y, s, tok = null, o = null) {
      if (y < 0 || y >= h) return;
      [...String(s)].forEach((ch, i) => { if (x + i >= 0 && x + i < w) cells[y][x + i] = [ch, tok, o]; });
    },
    shade(x0, x1, y, bg) {
      if (y < 0 || y >= h) return;
      for (let x = Math.max(0, x0); x <= x1 && x < w; x++) { const [ch, tok, o] = cells[y][x]; cells[y][x] = [ch, tok, { ...(o || {}), bg }]; }
    },
    lines: () => cells.map(row => {
      let out = '', cur = '';
      for (const [ch, tok, o] of row) {
        const k = tok || o ? sgr(tok, o || {}) : '';
        if (k !== cur) { out += (PLAIN ? '' : '\x1b[0m') + k; cur = k; }
        out += ch;
      }
      return out + (PLAIN || !cur ? '' : '\x1b[0m');
    }),
  };
}
const len = s => [...String(s)].length;
const fit = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? a.slice(0, Math.max(0, n - 1)).join('') + '…' : a.join('') + ' '.repeat(n - a.length); };
const wrap = (s, w) => {
  const out = [];
  let cur = '';
  for (const word of String(s).split(/\s+/).filter(Boolean)) {
    if (cur && len(cur) + 1 + len(word) > w) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out.length ? out.map(l => fit(l, w).trimEnd()) : ['—'];
};
function box(c, x, y, w, h, tok, dbl = false, o = null) {
  const [tl, tr, bl, br, hz, vt] = [...(dbl ? '╔╗╚╝═║' : '┌┐└┘─│')];
  c.put(x, y, tl + hz.repeat(w - 2) + tr, tok, o);
  for (let i = 1; i < h - 1; i++) { c.put(x, y + i, vt, tok, o); c.put(x + w - 1, y + i, vt, tok, o); }
  c.put(x, y + h - 1, bl + hz.repeat(w - 2) + br, tok, o);
}
const age = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const clock = t => new Date(t).toTimeString().slice(0, 8);
const stamp = t => {
  const d = new Date(t), hm = clock(t).slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
};

// ---- data: one herdr snapshot, the rig's files and the lanes' transcripts per refresh
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const seen = new Map(); // lane -> {state, since}: since is known only once the view saw the state change

function models() {
  const m = {};
  for (const [, seat, model, effort] of read(path.join(RIG, 'bin', 'lanes.ps1')).matchAll(/^\s*(\w+) = '--model', '(\w+)', '--effort', '(\w+)'/gm)) m[seat] = `${model} · ${short(effort)}`;
  const o = read(path.join(RIG, 'bin', 'rig.ps1')).match(/--model (\w+) --effort (\w+)/);
  if (o) m.orchestrator = `${o[1]} · ${short(o[2])}`;
  return m;
}

// A lane's transcript: herdr's agent_session is its current Claude session id (it changes on /clear);
// the file sits in ~/.claude/projects/<folder of the lane's cwd>/<id>.jsonl. Re-read only when it changed.
const toolText = x => {
  const i = x.input || {};
  const arg = i.command ?? (i.file_path && path.basename(i.file_path)) ?? i.pattern ?? i.description ?? i.url ?? Object.values(i).find(v => typeof v === 'string') ?? '';
  return `${x.name} ${String(arg).replace(/\s+/g, ' ')}`;
};
const tcache = new Map();
function transcript(id) {
  if (!id) return null;
  let e = tcache.get(id);
  if (!e) {
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS); } catch {}
    const d = dirs.find(d => fs.existsSync(path.join(PROJECTS, d, `${id}.jsonl`)));
    if (!d) return null;
    e = { file: path.join(PROJECTS, d, `${id}.jsonl`), mtime: 0, ctx: null, now: null };
    tcache.set(id, e);
  }
  let s;
  try { s = fs.statSync(e.file); } catch { tcache.delete(id); return null; }
  if (s.mtimeMs === e.mtime) return e;
  e.mtime = s.mtimeMs;
  // shortcut: reads the last 512 KB only; a lane whose last assistant turn sits further back shows — until it acts again
  const n = Math.min(s.size, 512 * 1024), buf = Buffer.alloc(n), fd = fs.openSync(e.file, 'r');
  try { fs.readSync(fd, buf, 0, n, s.size - n); } finally { fs.closeSync(fd); }
  const text = buf.toString('utf8');
  e.ctx = lastContextTokens(text) || e.ctx; // the rotation warning's own count (context-check.cjs)
  for (const l of text.split('\n')) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.isSidechain || j.type !== 'assistant') continue;
    for (const x of Array.isArray(j.message?.content) ? j.message.content : []) {
      if (x.type === 'tool_use') e.now = { t: Date.parse(j.timestamp), text: toolText(x) };
      else if (x.type === 'text' && x.text.trim()) {
        // the first line that says something: skip `=== REPORT ===`-style markers, drop markdown heading/list marks
        const line = x.text.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(l => l && !/^[=\-_*#\s]*[A-Z\s]*[=\-_*#\s]*$/.test(l)) ?? x.text.trim();
        e.now = { t: Date.parse(j.timestamp), text: `"${line}"` };
      }
    }
  }
  return e;
}

const heads = new Map(); // brief file -> {t, title}
function briefTitle(b) {
  const h = heads.get(b.file);
  if (h && h.t === b.t) return h.title;
  const txt = read(b.file);
  const title = (txt.match(/^Ticket:\s*(.*)$/m) || [])[1] || txt.split('\n').find(l => l.trim()) || '';
  heads.set(b.file, { t: b.t, title });
  return title;
}
function briefList(dir, seatKeys) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch {}
  return names.map(f => {
    const parts = f.slice(0, -3).split('-'), seat = seatKeys.find(s => parts.includes(s));
    let t = 0;
    try { t = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
    return { f, file: path.join(dir, f), t, seat, label: parts.filter(p => p !== seat).join('-') };
  }).sort((a, b) => b.t - a.t);
}
// work\log.md: "date | ticket | prompts | rounds | minutes | result | note", newest last in the file
const logLines = file => read(file).split('\n').filter(l => /^\d{4}-\d\d-\d\d \|/.test(l)).map(l => {
  const [date, ticket = '', , , minutes = '', result = '', ...note] = l.split(' | ').map(x => x.trim());
  return { date, ticket, minutes, result, note: note.join(' | ') };
}).reverse();

function gather() {
  // herdr's stderr is piped, not inherited: its error JSON would otherwise land on the view's screen (refresh shows it in the status bar).
  const raw = SNAP ? fs.readFileSync(SNAP, 'utf8') : execFileSync('herdr', ['api', 'snapshot'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const snap = JSON.parse(raw).result?.snapshot;
  if (!snap) throw new Error(`herdr gave no snapshot: ${raw.trim().slice(0, 200)}`);
  const mods = models();
  const rigs = fs.readdirSync(RIG).filter(d => fs.existsSync(path.join(RIG, d, 'profile.json'))).map(d => {
    const p = JSON.parse(read(path.join(RIG, d, 'profile.json')));
    const now = read(path.join(RIG, d, 'work', 'now.md'));
    const field = k => (now.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '';
    const segs = field('Ticket · plan').split(' · ');
    const briefs = briefList(path.join(RIG, d, 'work', 'briefs'), Object.keys(p.lanes));
    const seats = Object.entries(p.lanes).map(([seat, lane]) => {
      const a = snap.agents.find(x => x.name === lane || (!x.name && x.terminal_title_stripped === lane));
      const state = a ? a.agent_status : 'off';
      const prev = seen.get(lane);
      if (!prev || prev.state !== state) seen.set(lane, { state, since: prev ? Date.now() : null });
      return {
        seat, lane, state, since: seen.get(lane).since, model: mods[seat] ?? '?', a,
        tab: a ? snap.tabs.find(t => t.tab_id === a.tab_id)?.label ?? '' : '',
        brief: seat === 'orchestrator' ? null : briefs.find(b => b.seat === seat) ?? null,
        tr: transcript(a?.agent_session?.value),
      };
    });
    const any = seats.find(s => s.a);
    return {
      name: p.name, lanes: p.lanes, seats, briefs, log: logLines(path.join(RIG, d, 'work', 'log.md')),
      space: any ? snap.workspaces.find(w => w.workspace_id === any.a.workspace_id)?.label ?? '?' : 'not running',
      goal: field('Goal'), mission: field('Mission'), plan: field('Ticket · plan'), done: field('Done when'),
      ticket: segs[0] || '—', next: (segs.find(s => /\bnext\b/.test(s)) || '').replace(/^.*?\bnext:?\s*/, '') || '—',
      worktree: read(path.join(RIG, d, 'active-worktree')).trim() || '—',
      loudest: seats.reduce((m, s) => (st(s.state)[3] > st(m)[3] ? s.state : m), 'off'),
    };
  });
  return { snap, rigs, at: Date.now() };
}

// ---- views
let view = VIEWS.find(v => args.includes(`--${v}`)) ?? 'table', sel = 0, only = null, data = null, err = '';
let hits = []; // clickable spans of the last frame: {x0, x1, y, go}
const click = (x0, x1, y, go) => hits.push({ x0, x1, y, go });
const shown = () => (only == null ? data.rigs : [data.rigs[only]]);

function rigFrame(c, x, y, w, h, r, active) {
  box(c, x, y, w, h, active ? 'accent' : 'chrome', true);
  c.put(x + 2, y, ` ${r.name.toUpperCase()} `, 'accentBright', { bold: true });
  const counts = Object.entries(r.seats.reduce((m, s) => ((m[s.state] = (m[s.state] || 0) + 1), m), {}))
    .sort((a, b) => st(b[0])[3] - st(a[0])[3]).map(([k, n]) => `${n} ${st(k)[2]}`).join(' · ');
  const right = ` space ${r.space} · ${counts} `;
  c.put(x + w - 2 - len(right), y, right, 'dim');
}
const kv = (c, x, y, k, v, w) => { c.put(x, y, fit(k, 10), 'dim'); c.put(x + 10, y, fit(v, w - 10)); };
const stateCell = (c, x, y, s, w) => {
  const [g, tok, label] = st(s.state), loud = s.state === 'blocked' || s.state === 'working';
  c.put(x, y, g, tok); c.put(x + 2, y, label, tok, loud ? { bold: true } : null);
  if (s.since) c.put(x + w - len(age(Date.now() - s.since)), y, age(Date.now() - s.since), 'dim');
};
const rule = (c, x, y, w, title) => {
  c.put(x, y, '── ', 'chrome'); c.put(x + 3, y, title, 'accentBright', { bold: true });
  c.put(x + 4 + len(title), y, '─'.repeat(Math.max(0, w - 4 - len(title))), 'chrome');
};

function drawTree(c, y) {
  const W = TREE_W;
  c.put(1, y, '{ EXPLORER }', 'accentBright', { bold: true }); y += 2;
  c.put(1, y++, 'RIGS', null, { bold: true });
  c.put(1, y, '├ ', 'chrome'); c.put(3, y, '◆', 'accent'); c.put(5, y, 'all rigs', only == null ? 'accentBright' : 'dim', only == null ? { bold: true } : null);
  if (only == null) c.shade(0, W - 1, y, 'selection');
  click(0, W - 1, y++, () => { only = null; });
  data.rigs.forEach((r, i) => {
    const last = i === data.rigs.length - 1, on = only === i, n = String(r.seats.filter(s => s.state !== 'off').length);
    c.put(1, y, last ? '└ ' : '├ ', 'chrome'); c.put(3, y, '■', st(r.loudest)[1]);
    c.put(5, y, r.name, on ? 'accentBright' : null, { bold: true }); c.put(W - 1 - len(n), y, n, 'dim');
    if (on) c.shade(0, W - 1, y, 'selection');
    click(0, W - 1, y++, () => { only = sel = i; });
    r.seats.forEach((s, k) => {
      const [g, tok] = st(s.state);
      c.put(1, y, (last ? '  ' : '│ ') + (k === r.seats.length - 1 ? '└ ' : '├ '), 'chrome');
      c.put(5, y, g, tok); c.put(7, y, fit(s.lane, W - 8), on ? null : 'dim');
      click(0, W - 1, y++, () => { only = sel = i; });
    });
  });
  return y;
}

function drawTable(c, x, y, w) {
  const fixed = [['SEAT', 16], ['MODEL · EFFORT', 16], ['STATE', 13], ['CTX', 6], ['TAB', 7]], briefW = 20;
  const nowW = Math.max(0, w - 4 - fixed.reduce((a, [, n]) => a + n, 0) - briefW);
  for (const r of shown()) {
    const i = data.rigs.indexOf(r), h = 7 + r.seats.length;
    rigFrame(c, x, y, w, h, r, i === sel);
    click(x, x + w - 1, y, () => { sel = i; view = 'graph'; });
    let yy = y + 1;
    kv(c, x + 2, yy++, 'ticket', r.ticket, w - 4);
    kv(c, x + 2, yy++, 'next', r.next, w - 4);
    kv(c, x + 2, yy++, 'worktree', r.worktree, w - 4);
    c.put(x + 2, yy++, '┄'.repeat(w - 4), 'chrome');
    let cx = x + 2;
    for (const [hd, n] of [...fixed, ['NOW', nowW], ['LAST BRIEF', briefW]]) {
      if (n > 1) c.put(hd === 'CTX' ? cx + 5 - len(hd) : cx, yy, fit(hd, n - 1).trimEnd(), 'dim', { bold: true });
      cx += n;
    }
    yy++;
    for (const s of r.seats) {
      cx = x + 2;
      c.put(cx, yy, fit(s.lane, 15), null, { bold: true }); cx += 16;
      c.put(cx, yy, fit(s.model, 15), 'dim'); cx += 16;
      stateCell(c, cx, yy, s, 12); cx += 13;
      const ctx = s.tr?.ctx != null ? `${Math.round(s.tr.ctx / 1000)}k` : '—';
      c.put(cx + 5 - len(ctx), yy, ctx, 'dim'); cx += 6;
      c.put(cx, yy, fit(s.tab || '—', 6), 'dim'); cx += 7;
      if (nowW > 4) {
        const nw = s.tr?.now;
        if (nw) { const a = age(Date.now() - nw.t); c.put(cx, yy, a, 'dim'); c.put(cx + len(a) + 1, yy, fit(nw.text, nowW - len(a) - 2)); }
        else c.put(cx, yy, '—', 'dim');
      }
      cx += nowW;
      c.put(cx, yy, fit(s.brief ? `${s.brief.label} · ${age(Date.now() - s.brief.t)}` : '—', briefW - 1), 'dim');
      yy++;
    }
    y = yy + 2;
  }
  const all = shown().flatMap(r => r.seats), n = k => all.filter(s => s.state === k).length;
  if (!all.length) return y;
  let sx = x + 1;
  for (const [t, tok] of [[`${all.length} seats`, 'dim'], [`${n('working')} working`, n('working') ? 'actActive' : 'dim'],
    [`${n('blocked')} need you`, n('blocked') ? 'actAttention' : 'dim'], [`${n('done')} done, unseen`, n('done') ? 'actDone' : 'dim']]) {
    c.put(sx, y - 1, t, tok, tok === 'dim' ? null : { bold: true }); sx += len(t);
    c.put(sx, y - 1, ' · ', 'dim'); sx += 3;
  }
  c.put(sx - 3, y - 1, '   ');
  return y;
}

function drawRecent(c, x, y, w, maxY) {
  const rigs = shown();
  const fin = rigs.flatMap(r => r.log.slice(0, 6).map(l => ({ ...l, rig: r.name }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const rows = Math.max(1, Math.floor((maxY - y - fin.length - 3) / 2));
  const bs = rigs.flatMap(r => r.briefs.slice(0, rows).map(b => ({ ...b, rig: r.name, lane: r.lanes[b.seat] ?? b.seat ?? '?' })))
    .sort((a, b) => b.t - a.t).slice(0, rows);
  rule(c, x, y++, w, `BRIEFS HANDED OUT · ${rigs.length > 1 ? 'both rigs' : rigs[0].name} · newest first`);
  for (const b of bs) {
    const when = fit(`${stamp(b.t)} · ${age(Date.now() - b.t)} ago`, 20);
    c.put(x + 1, y, '▪', 'accent'); c.put(x + 3, y, when, 'dim');
    c.put(x + 5 + len(when), y, `${b.lane}@${b.rig}`, 'accentBright', { bold: true });
    c.put(x + w - 1 - len(b.f), y, b.f, 'dim');
    c.put(x + 3, y + 1, fit(briefTitle(b), w - 4));
    y += 2;
  }
  y++;
  rule(c, x, y++, w, 'FINISHED · work\\log.md');
  for (const l of fin) {
    c.put(x + 1, y, l.date, 'dim');
    c.put(x + 13, y, fit(l.result, 5), /PASS/.test(l.result) ? 'ok' : 'warn', { bold: true });
    c.put(x + 19, y, fit(`${l.ticket} @${l.rig}`, 26), null, { bold: true });
    c.put(x + 46, y++, fit(`${l.minutes} · ${l.note}`, w - 47), 'dim');
  }
  return y;
}

function drawOverview(c, x, y, w) {
  for (const r of shown()) {
    const i = data.rigs.indexOf(r), iw = w - 15;
    const rows = [['goal', r.goal], ['mission', r.mission], ['ticket', r.plan], ['done when', r.done]]
      .flatMap(([k, v]) => wrap(v || '—', iw).map((l, j) => [j ? '' : k, l]));
    const fin = r.log[0];
    rigFrame(c, x, y, w, rows.length + 5, r, i === sel);
    click(x, x + w - 1, y, () => { sel = i; view = 'graph'; });
    let yy = y + 1;
    for (const [k, l] of rows) { c.put(x + 2, yy, fit(k, 11), 'dim'); c.put(x + 13, yy++, l); }
    c.put(x + 2, yy++, '┄'.repeat(w - 4), 'chrome');
    c.put(x + 2, yy, fit('seats', 11), 'dim');
    let sx = x + 13;
    for (const s of r.seats) {
      const [g, tok] = st(s.state);
      c.put(sx, yy, g, tok); c.put(sx + 2, yy, s.lane, s.state === 'idle' || s.state === 'off' ? 'dim' : tok); sx += len(s.lane) + 4;
    }
    yy++;
    c.put(x + 2, yy, fit('last done', 11), 'dim');
    c.put(x + 13, yy++, fit(fin ? `${fin.date} · ${fin.ticket} · ${fin.result} · ${fin.note}` : '—', iw), fin ? null : 'dim');
    y = yy + 2;
  }
  return y;
}

function card(c, x, y, w, h, s, homeTab) {
  const blocked = s.state === 'blocked';
  box(c, x, y, w, h, blocked ? 'warn' : 'chrome', false, blocked ? { bold: true } : null);
  c.put(x + 2, y + 1, fit(s.lane, w - 4), null, { bold: true });
  if (s.tab && s.tab !== homeTab) c.put(x + w - 3 - len(`(${s.tab})`), y + 1, `(${s.tab})`, 'dim');
  c.put(x + 2, y + 2, fit(s.model, w - 4), 'dim');
  stateCell(c, x + 2, y + 3, s, w - 4);
  if (h > 5) c.put(x + 2, y + 4, fit(s.brief ? `${s.brief.label} · ${age(Date.now() - s.brief.t)}` : '—', w - 4), 'dim');
}

function drawGraph(c, x, y, w) {
  const r = data.rigs[sel], CW = 19, G = 2, OW = 24;
  const [orch, ...workers] = r.seats, n = workers.length;
  const total = n * CW + (n - 1) * G, gx = x + Math.max(2, Math.floor((w - total) / 2));
  rigFrame(c, x, y, w, 21, r, true);
  kv(c, x + 2, y + 1, 'ticket', r.ticket, w - 4);
  kv(c, x + 2, y + 2, 'next', r.next, w - 4);
  const oy = y + 4, ox = gx + Math.floor((total - OW) / 2), ocx = ox + Math.floor(OW / 2);
  card(c, ox, oy, OW, 5, orch, orch.tab);
  c.put(ocx, oy + 4, '┬', 'chrome');
  const by = oy + 5, cxs = workers.map((_, i) => gx + i * (CW + G) + Math.floor(CW / 2));
  c.put(cxs[0], by, '─'.repeat(cxs[n - 1] - cxs[0] + 1), 'chrome');
  cxs.forEach((cx, i) => c.put(cx, by, i === 0 ? '┌' : i === n - 1 ? '┐' : '┬', 'chrome'));
  c.put(ocx, by, cxs.includes(ocx) ? '┼' : '┴', 'chrome');
  workers.forEach((s, i) => {
    const live = s.state === 'working' || s.state === 'blocked';
    c.put(cxs[i], by + 1, '▼', live ? st(s.state)[1] : 'chrome');
    card(c, gx + i * (CW + G), by + 2, CW, 6, s, orch.tab);
  });
  let lx = gx;
  for (const k of ['working', 'idle', 'done', 'blocked', 'unknown']) {
    const [g, tok, label] = st(k);
    c.put(lx, by + 9, g, tok); c.put(lx + 2, by + 9, label.toLowerCase(), 'dim'); lx += len(label) + 5;
  }
  c.put(gx, by + 10, 'edges: the orchestrator briefs every lane; lanes never talk to each other', 'dim');
  return y + 21;
}

function frame(W, H) {
  const c = canvas(W, H ?? 80);
  hits = [];
  // top bar: name, view tabs, rigs (loudest state each), clock
  c.put(0, 0, ' RIG VIEW ', 'ink', { bold: true, bg: 'accent' });
  let x = 12;
  for (const v of VIEWS) {
    const on = v === view, t = on ? `[ ${v.toUpperCase()} ]` : `  ${v.toUpperCase()}  `;
    c.put(x, 0, t, on ? 'accentBright' : 'dim', on ? { bold: true } : null);
    click(x, x + len(t) - 1, 0, () => { view = v; });
    x += len(t) + 1;
  }
  x += 2;
  (data?.rigs ?? []).forEach((r, i) => {
    const [g, tok] = st(r.loudest);
    c.put(x, 0, g, tok); c.put(x + 2, 0, r.name, i === sel ? 'accentBright' : 'dim', i === sel ? { bold: true } : null);
    click(x, x + 1 + len(r.name), 0, () => { sel = i; view = 'graph'; });
    x += len(r.name) + 5;
  });
  c.put(W - 9, 0, clock(Date.now()), 'dim');
  const where = !data ? '' : view === 'graph' ? data.rigs[sel].name : only == null ? 'all rigs' : data.rigs[only].name;
  c.put(1, 1, `rig › ${where} › ${view}`, 'dim');
  c.put(0, 2, '─'.repeat(W), 'chrome');
  let bottom;
  if (data) {
    const x0 = TREE_W + 2, mw = W - x0 - 1;
    const end = view === 'table' ? drawTable(c, x0, 3, mw) : view === 'recent' ? drawRecent(c, x0, 3, mw, (H ?? 60) - 2)
      : view === 'overview' ? drawOverview(c, x0, 3, mw) : drawGraph(c, x0, 3, mw);
    bottom = Math.max(drawTree(c, 3), end);
  } else { c.put(2, 4, err || 'reading herdr…', err ? 'error' : 'dim'); bottom = 6; }
  const h = H ?? bottom + 1;
  if (data) { c.put(TREE_W, 2, '┬', 'chrome'); for (let yy = 3; yy < h - 1; yy++) c.put(TREE_W, yy, '│', 'chrome'); }
  // status bar: source + snapshot time on the left, keys on the right
  const left = err ? ` herdr: ${err}` : data ? ` herdr ${data.snap.version} · snapshot ${clock(data.at)} · every ${EVERY / 1000} s · read-only` : '';
  c.put(0, h - 1, ' '.repeat(W), null, { bg: 'selection' });
  let kx = W - 1;
  for (const [k, what] of [['q', 'quit'], ['Tab', 'rig'], ['t r o g', 'views'], ['click', 'tabs, tree']]) {
    kx -= len(what) + 1; c.put(kx, h - 1, what, 'dim', { bg: 'selection' });
    kx -= len(k) + 3; c.put(kx, h - 1, ` ${k} `, 'ink', { bold: true, bg: 'accent' }); kx -= 1;
  }
  c.put(0, h - 1, fit(left, kx - 1), err ? 'error' : 'dim', { bg: 'selection' });
  return c.lines().slice(0, h);
}

const cols = () => process.stdout.columns || +process.env.COLUMNS || 150;
function draw() {
  if (ONCE) { process.stdout.write(frame(cols()).join('\n') + '\n'); return; }
  // A drawing bug shows its message and the view keeps refreshing, instead of dying with the terminal still in mouse mode.
  try { process.stdout.write('\x1b[H' + frame(cols(), process.stdout.rows || 40).join('\r\n')); }
  catch (e) { process.stdout.write(`\x1b[H\x1b[2Jrig view: could not draw (${e.message}); it tries again in ${EVERY / 1000} s, q quits`); }
}
function refresh() {
  try {
    data = gather();
    if (!data.rigs.length) throw new Error(`no rig folder with a profile.json in ${RIG}`);
    err = '';
  } catch (e) { data = data?.rigs.length ? data : null; err = String(e.stderr || e.message).trim().split('\n')[0]; }
  draw();
}

if (ONCE) { refresh(); process.exit(0); }
// mouse: SGR reporting (1000 + 1006), button presses only; herdr passes the clicks through. However the view ends, the terminal is reset.
process.on('exit', () => process.stdout.write('\x1b[0m\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'));
const quit = () => process.exit(0);
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', b => {
  const k = b.toString(), step = d => { view = VIEWS[(VIEWS.indexOf(view) + d + VIEWS.length) % VIEWS.length]; };
  const clicks = [...k.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)].filter(m => m[1] === '0');
  if (clicks.length) {
    const [, , mx, my] = clicks.at(-1), hit = hits.find(h => h.y === my - 1 && mx - 1 >= h.x0 && mx - 1 <= h.x1);
    if (!hit) return;
    hit.go();
  } else if (k.startsWith('\x1b[<')) return; // a release or other mouse report
  else if (k === 'q' || k === '\x03') quit();
  else if ('trog'.includes(k) && k.length === 1) view = VIEWS['trog'.indexOf(k)];
  else if (k === '\x1b[C') step(1);
  else if (k === '\x1b[D') step(-1);
  else if (k === '\t' && data) { sel = (sel + 1) % data.rigs.length; if (only != null) only = sel; }
  else return;
  process.stdout.write('\x1b[2J'); draw();
});
process.stdout.on('resize', () => { process.stdout.write('\x1b[2J'); draw(); });
refresh();
setInterval(refresh, EVERY);
