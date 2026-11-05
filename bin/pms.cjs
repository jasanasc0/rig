#!/usr/bin/env node
'use strict';
// The rig's one PMS script (the rig README, Safety rules): a project's PMS board, one ticket per call. The guard lets two seats run this
// file, by its full path: the orchestrator reads the board and dry-runs writes, and pam, the PMS writer, also sends them with --live once
// its brief says "Jas approved: post" (a role rule: the guard can't hear Jas). No worker runs it.
//   node <rig>/bin/pms.cjs --project <name> board                   columns and tickets
//   node <rig>/bin/pms.cjs --project <name> show <CODE>             one ticket and its comments
//   node <rig>/bin/pms.cjs --project <name> move <CODE> "<column>"
//   node <rig>/bin/pms.cjs --project <name> comment <CODE> <file>
//   node <rig>/bin/pms.cjs --project <name> create "<title>" <file> [--column "<column>"] [--code <CODE>] [--priority LOW|MEDIUM|HIGH|URGENT]
//   node <rig>/bin/pms.cjs --project <name> edit <CODE> [--title "<title>"] [--description <file>]
// A write is a dry run unless --live is given: it prints the ticket's column, full description and every comment (a create: the board's
// highest code and any title like the new one), then the method, path and JSON body, and sends nothing. --live sends exactly one write
// request, no retry, appends one line to <rig>/<project>/work/pms-log.md, then reads the ticket back and prints PRESENT or MISSING per
// check (any MISSING exits 1). An edit first saves the old title and description in <rig>/<project>/work/pms-undo/. A comment already on
// the ticket (the same first 80 characters) and a create --code already on the board under the same title are skipped (exit 0), so a
// re-run is safe. No delete, no bulk, no other verb.
// Every text it would send is refused, before any network call, when it names the rig: herdr, rig, or a lane name of any profile.
// The profile's pms field ({ projectId, envFile }) names the board; PMS_BASE_URL and PMS_API_KEY come from <root>/<envFile>, read here.
// The key is sent only in the Authorization header, never printed: every line this script prints or logs passes through hideKey.
// API shapes from the reference PMS scripts, which worked against the real PMS.
const fs = require('fs');
const path = require('path');
const { loadProfile } = require('../hooks/guard.cjs'); // profile.json reader: guard.cjs (loadProfile) is the one validator

const RIG = path.dirname(__dirname); // the rig: the profiles, work folders and log sit in the folder above this file's bin/ (in the tests, a temp copy of the rig)
const ARITY = { board: 0, show: 1, move: 2, comment: 2, create: 2, edit: 1 };
const WRITES = new Set(['move', 'comment', 'create', 'edit']);
// The options that take a value, and the one verb each belongs to (--project: every verb).
const VALUE_OPTS = { '--project': null, '--column': 'create', '--code': 'create', '--priority': 'create', '--title': 'edit', '--description': 'edit' };
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT']; // what the reference create scripts send
const CAP = 5000; // the PMS caps a comment and a description at 5,000 characters (the reference scripts guard it)
const SAME = 80; // a comment whose first 80 characters equal one already on the ticket is that comment (the reference correction script)

let KEY = '';
const hideKey = (s) => (KEY ? String(s).split(KEY).join('[PMS_API_KEY]') : String(s));
const say = (s) => process.stdout.write(hideKey(s) + '\n');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};

function parseArgs(argv) {
  const o = { live: false, opts: {}, words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') {
      if (o.live) refuse('--live given twice');
      o.live = true;
    } else if (Object.hasOwn(VALUE_OPTS, a)) {
      if (o.opts[a] !== undefined) refuse(`${a} given twice`);
      if (i + 1 >= argv.length) refuse(`${a} needs a value`);
      o.opts[a] = argv[++i];
    } else if (a.startsWith('--')) refuse(`unknown option ${a}`);
    else o.words.push(a);
  }
  if (o.opts['--project'] === undefined) refuse('say which project: --project <name>');
  const [verb, ...args] = o.words;
  if (verb === undefined) refuse('no verb: board, show, move, comment, create or edit');
  if (!Object.hasOwn(ARITY, verb)) refuse(`unknown verb "${verb}"; the verbs are board, show, move, comment, create and edit (there is no delete)`);
  const n = ARITY[verb];
  if (args.length !== n) refuse(`${verb} takes ${n === 0 ? 'no argument' : n === 1 ? '1 argument' : n + ' arguments'}, got ${args.length}: one ticket per call`);
  if (o.live && !WRITES.has(verb)) refuse('--live is only for move, comment, create and edit');
  for (const [opt, only] of Object.entries(VALUE_OPTS)) if (only && o.opts[opt] !== undefined && verb !== only) refuse(`${opt} is only for ${only}`);
  if (verb === 'edit' && o.opts['--title'] === undefined && o.opts['--description'] === undefined) refuse('edit needs --title "<title>", --description <file>, or both');
  const opt = (k) => o.opts['--' + k];
  return { live: o.live, project: opt('project'), column: opt('column'), code: opt('code'), priority: opt('priority'), title: opt('title'), description: opt('description'), verb, args };
}

// The text of a comment or a description: a file whose real path (links followed) is inside <rig>/<project>/work/ and whose name doesn't
// start with .env, so this script can't upload any other file on the PC. Checked before any network call.
function readText(arg, project) {
  const work = path.join(RIG, project, 'work');
  const given = path.resolve(arg);
  const isEnv = (p) => /^\.env/i.test(path.basename(p));
  if (isEnv(given)) refuse(`${arg}: a .env file is never sent`);
  let real;
  let realWork;
  try {
    real = fs.realpathSync.native(given);
    realWork = fs.realpathSync.native(work);
  } catch {
    refuse(`${arg} can't be read (no such file, or no ${work})`);
  }
  if (!real.toLowerCase().startsWith(realWork.toLowerCase() + path.sep)) refuse(`${arg} is not inside ${work}${path.sep} (after following links); write the text there with the Write tool first`);
  if (isEnv(real)) refuse(`${arg}: a .env file is never sent`);
  if (!fs.statSync(real).isFile()) refuse(`${arg} is not a file`);
  const text = fs.readFileSync(real, 'utf8').replace(/\r\n?/g, '\n').trim(); // trim also drops a BOM
  if (!text) refuse(`${arg} is empty`);
  if (text.length > CAP) refuse(`${arg} holds ${text.length} characters; the PMS takes at most ${CAP}`);
  return { text, name: path.basename(real) };
}

// The rig's names: herdr, rig, and every lane name of every <rig>/<name>/profile.json, read here, so a new seat or project is covered
// without a change to this file. A profile whose lanes can't be read stops every write: its names would be missing from the check.
// (Read as plain JSON, not through loadProfile: a profile wrong in another field still names lanes that must never reach the PMS.)
function rigNames() {
  const names = new Set(['herdr', 'rig']);
  for (const d of fs.readdirSync(RIG, { withFileTypes: true })) {
    const file = path.join(RIG, d.name, 'profile.json');
    if (!d.isDirectory() || !fs.existsSync(file)) continue;
    let lanes;
    try {
      lanes = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).lanes;
    } catch {}
    if (lanes === null || typeof lanes !== 'object' || Array.isArray(lanes) || !Object.values(lanes).every((v) => typeof v === 'string' && v !== ''))
      refuse(`${file} can't be read for its lane names, and every text is checked against every lane name before anything is sent; tell Jas`);
    for (const v of Object.values(lanes)) names.add(v.toLowerCase());
  }
  return [...names];
}
// A name as a whole word (no letter, digit or _ on either side), in any case: "rig" in "rig-v4" counts, in "trigger" it doesn't.
function privacy(texts) {
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${rigNames().map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'i');
  for (const [what, text] of texts) {
    const m = re.exec(text);
    if (m) refuse(`the ${what} holds "${m[0]}", a name of the rig (herdr, rig or a lane name of a profile); the rig never reaches the PMS, so take it out of the text`);
  }
}

// PMS_BASE_URL and PMS_API_KEY from the project's env file, parsed like the reference scripts (KEY=value lines, # comments, quotes off).
// A refusal names the variable, never its value.
function readEnv(P) {
  const file = path.join(P.rootDir, P.pms.envFile);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    refuse(`${file} can't be read; pms.cjs reads PMS_BASE_URL and PMS_API_KEY from it`);
  }
  const env = {};
  for (const l of raw.trimStart().split(/\r?\n/)) {
    const i = l.indexOf('=');
    if (i > 0 && !l.trimStart().startsWith('#')) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  for (const name of ['PMS_BASE_URL', 'PMS_API_KEY']) if (!env[name]) refuse(`${name} is not set in ${file}`);
  let url = null;
  try {
    url = new URL(env.PMS_BASE_URL);
  } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) refuse(`PMS_BASE_URL in ${file} is not an http(s) URL`);
  KEY = env.PMS_API_KEY;
  return { base: env.PMS_BASE_URL.replace(/\/+$/, ''), origin: url.origin };
}

const clip = (s) => String(s).slice(0, 200);
// Why a request or its answer broke off: the error code, else the message, on one line and without the log's | separator.
const why = (e) => String((e && e.cause && e.cause.code) || (e && e.message) || e).replace(/[\r\n|]+/g, ' ').slice(0, 100);
// One request. A write carries a JSON body and the Origin header the PMS asks of writes (the reference scripts send it); no retry.
// A redirect is never followed (a 3xx is a failure like any other non-2xx), so a write goes only to the path the dry run showed.
// `unknown`: the request went out but no full answer came back (no status at all, or the answer cut off after its status), so whether
// the PMS applied a write can't be told.
async function request(E, method, p, body) {
  const headers = { Authorization: 'Bearer ' + KEY, Accept: 'application/json' };
  if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', Origin: E.origin });
  let res;
  try {
    res = await fetch(E.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ok: false, unknown: true, status: 'no response', text: `(${why(e)})` };
  }
  try {
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, unknown: true, status: res.status, text: `(answer cut off: ${why(e)})` };
  }
}
async function getList(E, p, key) {
  const r = await request(E, 'GET', p);
  if (!r.ok) refuse(`GET ${p} failed: ${r.status} ${clip(r.text)}`);
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    refuse(`GET ${p}: the answer is not JSON: ${clip(r.text)}`);
  }
  const list = Array.isArray(j) ? j : j && (j[key] || j.data);
  if (!Array.isArray(list)) refuse(`GET ${p}: the answer holds no list: ${clip(r.text)}`);
  return list;
}

const colName = (c) => String(c.name ?? c.title ?? c.id);
const colOf = (t) => t.columnId ?? (t.column && t.column.id) ?? t.column;
const who = (t) => (t.assignee && (t.assignee.name || t.assignee.email)) || (typeof t.assignee === 'string' && t.assignee) || t.assigneeId || '-';
const line = (t, cols) => `  ${t.id}  "${(cols.find((c) => c.id === colOf(t)) && colName(cols.find((c) => c.id === colOf(t)))) || '?'}"  ${t.title}`;
const plain = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim(); // a text as pms.cjs sends one: LF, no blanks at either end
const commentText = (c) => plain(c.content ?? c.body ?? c.text);

// <CODE> names one ticket: "[EX-12] ..." at the start of its title, or "EX-12 ..." with no word character, . or - right after the code
// (so "[EX-12.1]" and "EX-12-b" are other tickets). 0 or 2+ refuse. (code is <PREFIX>-<digits>: no regex character but the escaped [ ].)
const codeAt = (code) => new RegExp(`^\\s*(?:\\[${code}\\]|${code}(?![\\w.-]))`);
function findTicket(tasks, cols, code) {
  const re = codeAt(code);
  const hits = tasks.filter((t) => re.test(String(t.title ?? '')));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    const near = tasks.filter((t) => String(t.title ?? '').includes(code));
    refuse(`no ticket title starts with ${code} (${tasks.length} tickets on the board)` + (near.length ? '; titles that mention it:\n' + near.map((t) => line(t, cols)).join('\n') : ''));
  }
  refuse(`${hits.length} tickets start with ${code}, and pms.cjs changes one ticket it can name:\n` + hits.map((t) => line(t, cols)).join('\n'));
}
function findColumn(cols, name) {
  const hits = cols.filter((c) => colName(c).toLowerCase() === String(name).toLowerCase());
  if (hits.length !== 1) refuse(`${hits.length ? 'more than one' : 'no'} column "${name}"; the columns are ${cols.map((c) => `"${colName(c)}"`).join(', ')}`);
  return hits[0];
}
// The highest number on the board, the way the reference next-free-code script counts: the first <PREFIX>-<n> in each title. The next free code
// is that plus one.
const highest = (tasks, prefix) => tasks.reduce((max, t) => Math.max(max, Number((new RegExp(`${prefix}-(\\d+)`).exec(String(t.title ?? '')) || [])[1] || 0)), 0);
// The tickets that already carry a code: "[CODE]" anywhere in the title, or the code at its start (the create scripts' check).
const carrying = (tasks, code) => tasks.filter((t) => String(t.title ?? '').includes(`[${code}]`) || new RegExp(`^\\s*\\[?${code}(?!\\w)`).test(String(t.title ?? '')));
// A title without the code in front of it.
const titleText = (t, prefix) => String(t.title ?? '').replace(new RegExp(`^\\s*(?:\\[${prefix}-\\d+\\]|${prefix}-\\d+(?![\\w.-]))`), '').trim();

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fileStamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const LOG_HEAD =
  '# PMS log\n\nOne line per live write by pms.cjs: local time | verb | code | task id | before | after | status. Undo a move by hand: move <code> "<before column>"; ' +
  'an edit: its work/pms-undo/ file holds the old title and description.\n\n';
const UNKNOWN = 'outcome unknown: run show before any retry';

// The ticket as a write's dry run and show print it: its column, full description and every comment.
function printTicket(t, comments, nameOf) {
  say(`${t.title}`);
  say(`  id ${t.id} · column "${nameOf(colOf(t))}" position ${t.position ?? '?'} · assignee ${who(t)}`);
  say('\n--- description ---');
  say(plain(t.description) || '(none)');
  say(`\n--- ${comments.length} comment(s) ---`);
  for (const c of comments) {
    const author = (c.author && c.author.name) || c.authorName || (c.user && c.user.name) || c.createdBy || '?';
    say(`[${c.createdAt ?? c.updatedAt ?? '?'}] ${author}:`);
    say(commentText(c));
  }
  say('');
}

// The old title and description of an edit, in work/pms-undo/<yyyyMMdd-HHmmss>-<CODE>.json (a second edit of the same ticket in the same
// second gets -2, -3, ...). Written before the request; when it can't be written, nothing is sent.
function saveUndo(project, code, t) {
  const dir = path.join(RIG, project, 'work', 'pms-undo');
  const base = `${fileStamp()}-${code}`;
  const data = hideKey(JSON.stringify({ code, taskId: t.id, title: t.title ?? '', description: t.description ?? '' }, null, 2)) + '\n';
  let last = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    refuse(`the undo folder ${dir} can't be made (${e.code || e.message}), so nothing was sent`);
  }
  for (let k = 1; k <= 9; k++) {
    const name = k === 1 ? `${base}.json` : `${base}-${k}.json`;
    try {
      fs.writeFileSync(path.join(dir, name), data, { flag: 'wx' });
      return name;
    } catch (e) {
      last = e.code || e.message;
      if (e.code !== 'EEXIST') break;
    }
  }
  refuse(`the undo file ${path.join(dir, base)}.json could not be written (${last}), so nothing was sent`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let P;
  try {
    P = loadProfile(o.project);
  } catch (e) {
    refuse(e.message);
  }
  if (!P.pms) refuse(`no PMS configured for ${o.project} (its profile's pms is null or missing)`);
  const prefix = P.ticketPrefix.toUpperCase();
  const codeArg = (s) => {
    const m = new RegExp(`^${prefix}-([1-9]\\d*)$`, 'i').exec(s);
    if (!m) refuse(`"${s}" is not a ticket code of ${o.project}: ${prefix}-<n>, like ${prefix}-12`);
    return `${prefix}-${m[1]}`;
  };
  const noCode = (title) => {
    if (!title) refuse('the title is empty');
    if (new RegExp(`^\\[?${prefix}-\\d`, 'i').test(title)) refuse(`give the title without a code; pms.cjs puts the ${prefix}-<n> in front`);
    return title;
  };
  const code = ['show', 'move', 'comment', 'edit'].includes(o.verb) ? codeArg(o.args[0]) : null;
  const title = o.verb === 'create' ? noCode(o.args[0].trim()) : o.verb === 'edit' && o.title !== undefined ? noCode(o.title.trim()) : null;
  const askedCode = o.code !== undefined ? codeArg(o.code) : null;
  const priority = o.priority === undefined ? null : String(o.priority).toUpperCase();
  if (priority !== null && !PRIORITIES.includes(priority)) refuse(`--priority takes LOW, MEDIUM, HIGH or URGENT, not "${o.priority}"`);
  const fileArg = o.verb === 'comment' || o.verb === 'create' ? o.args[1] : o.verb === 'edit' ? o.description : undefined;
  const text = fileArg !== undefined ? readText(fileArg, o.project) : null;
  if (WRITES.has(o.verb))
    privacy([
      ...(title !== null ? [['title', title]] : []),
      ...(text !== null ? [[o.verb === 'comment' ? 'comment' : 'description', text.text]] : []),
    ]);
  const E = readEnv(P);
  const pid = encodeURIComponent(P.pms.projectId);
  const tasksPath = `/api/projects/${pid}/tasks`;
  const cols = await getList(E, `/api/projects/${pid}/columns`, 'columns');
  const tasks = await getList(E, tasksPath, 'tasks');
  const commentsOf = (t) => getList(E, `/api/tasks/${encodeURIComponent(t.id)}/comments`, 'comments');
  const nameOf = (id) => {
    const c = cols.find((x) => x.id === id);
    return c ? colName(c) : String(id ?? '?');
  };

  if (o.verb === 'board') {
    say(`${o.project} PMS board: ${tasks.length} tickets in ${cols.length} columns`);
    const num = (t) => Number((new RegExp(`${prefix}-(\\d+)`).exec(String(t.title ?? '')) || [])[1] || 1e9);
    const groups = [...cols.map((c) => [colName(c), tasks.filter((t) => colOf(t) === c.id)]), ['(no known column)', tasks.filter((t) => !cols.some((c) => c.id === colOf(t)))]];
    for (const [name, list] of groups) {
      if (name === '(no known column)' && !list.length) continue;
      say(`\n===== ${name} (${list.length}) =====`);
      for (const t of list.sort((a, b) => num(a) - num(b))) {
        say(`  [${who(t)}] ${t.title}`);
        const desc = String(t.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
        if (desc) say(`      ${desc}`);
      }
    }
    return;
  }

  if (o.verb === 'show') {
    const t = findTicket(tasks, cols, code);
    printTicket(t, await commentsOf(t), nameOf);
    return;
  }

  // The writes: one request, built from the board just read, and `verify`, which reads the ticket back after a live write: one
  // [what, PRESENT?] pair per check.
  let req;
  let taskId;
  let before;
  let after;
  let verify;
  let usedCode = code;
  let undoFor = null; // edit: the ticket whose old title and description are saved before the request
  const freshTasks = () => getList(E, tasksPath, 'tasks');
  if (o.verb === 'move') {
    const t = findTicket(tasks, cols, code);
    const to = findColumn(cols, o.args[1]);
    if (colOf(t) === to.id) refuse(`${code} is already in "${colName(to)}"; nothing to move`);
    if (!o.live) printTicket(t, await commentsOf(t), nameOf);
    req = { method: 'PATCH', path: `/api/tasks/${encodeURIComponent(t.id)}/move`, body: { columnId: to.id, position: 0 } };
    taskId = t.id;
    before = `before: "${nameOf(colOf(t))}" pos ${t.position ?? '?'}`;
    after = `after: "${colName(to)}" pos 0`;
    say(`${t.title}\n  moves from "${nameOf(colOf(t))}" (position ${t.position ?? '?'}) to the top of "${colName(to)}"`);
    verify = async () => {
      const now = (await freshTasks()).find((x) => x.id === t.id);
      return [[`${code} is in "${colName(to)}"`, Boolean(now) && colOf(now) === to.id]];
    };
  } else if (o.verb === 'comment') {
    const t = findTicket(tasks, cols, code);
    const comments = await commentsOf(t);
    const same = (list) => list.some((c) => commentText(c).slice(0, SAME) === text.text.slice(0, SAME));
    if (same(comments)) {
      say(`${t.title}\n  already has a comment that starts like ${text.name} (the same first ${SAME} characters): skipped, nothing sent`);
      return;
    }
    if (!o.live) printTicket(t, comments, nameOf);
    req = { method: 'POST', path: `/api/tasks/${encodeURIComponent(t.id)}/comments`, body: { content: text.text } };
    taskId = t.id;
    before = 'before: -';
    after = `text: ${text.name} (${text.text.length} chars)`;
    say(`${t.title}\n  gets a comment of ${text.text.length} characters from ${text.name}`);
    verify = async () => [[`the comment from ${text.name} is on ${code}`, same(await commentsOf(t))]];
  } else if (o.verb === 'edit') {
    const t = findTicket(tasks, cols, code);
    if (!o.live) printTicket(t, await commentsOf(t), nameOf);
    const body = {};
    if (title !== null) body.title = `[${code}] ${title}`;
    if (text !== null) body.description = text.text;
    req = { method: 'PATCH', path: `/api/tasks/${encodeURIComponent(t.id)}`, body };
    taskId = t.id;
    undoFor = t;
    after = 'after: ' + [title !== null ? 'title' : '', text !== null ? `description: ${text.name} (${text.text.length} chars)` : ''].filter(Boolean).join(', ');
    say(`${t.title}\n  gets ${[title !== null ? 'a new title' : '', text !== null ? `the description from ${text.name}` : ''].filter(Boolean).join(' and ')}` + (o.live ? '' : ' (with --live, the old title and description are saved first in work/pms-undo/)'));
    verify = async () => {
      const now = (await freshTasks()).find((x) => x.id === t.id);
      return [
        ...(title !== null ? [[`the title is "${body.title}"`, Boolean(now) && String(now.title ?? '') === body.title]] : []),
        ...(text !== null ? [[`the description is the text of ${text.name}`, Boolean(now) && plain(now.description) === text.text]] : []),
      ];
    };
  } else {
    const to = o.column !== undefined ? findColumn(cols, o.column) : cols[0] || refuse('the board has no column');
    const top = highest(tasks, prefix);
    if (!o.live) {
      say(`highest code on the board: ${top ? `${prefix}-${top}` : 'none'}`);
      const like = tasks.filter((t) => titleText(t, prefix).toLowerCase() === title.toLowerCase());
      say(like.length ? `titles like "${title}" on the board:\n${like.map((t) => line(t, cols)).join('\n')}` : `no title on the board is like "${title}"`);
    }
    if (askedCode !== null) {
      usedCode = askedCode;
      const taken = carrying(tasks, usedCode);
      if (taken.length === 1 && titleText(taken[0], prefix) === title) {
        say(`${usedCode} is already posted: ${taken[0].title} (in "${nameOf(colOf(taken[0]))}"); skipped, nothing sent`);
        return;
      }
      if (taken.length) refuse(`${usedCode} is already on the board under another title:\n` + taken.map((t) => line(t, cols)).join('\n'));
      if (Number(usedCode.split('-')[1]) <= top) refuse(`${usedCode} is not above the highest code on the board (${prefix}-${top}); codes taken by two sessions collide, so give a higher one or leave --code out`);
    } else {
      usedCode = `${prefix}-${top + 1}`;
      const taken = carrying(tasks, usedCode);
      if (taken.length) refuse(`the next free code ${usedCode} is already on the board:\n` + taken.map((t) => line(t, cols)).join('\n'));
    }
    req = { method: 'POST', path: `/api/projects/${pid}/tasks`, body: { title: `[${usedCode}] ${title}`, description: text.text, columnId: to.id, ...(priority !== null ? { priority } : {}) } };
    before = 'before: none';
    after = `column: "${colName(to)}", text: ${text.name} (${text.text.length} chars)`;
    say(`new ticket ${usedCode} in "${colName(to)}"` + (o.live || askedCode !== null ? '' : ` (the code is worked out again at --live time and may move on if someone files a ticket first)`));
    verify = async () => {
      const hits = (await freshTasks()).filter((t) => codeAt(usedCode).test(String(t.title ?? '')));
      return [
        [`${usedCode} is on the board`, hits.length === 1],
        [`${usedCode} is in "${colName(to)}"`, hits.length === 1 && colOf(hits[0]) === to.id],
      ];
    };
  }
  const shown = `${req.method} ${req.path}\n${JSON.stringify(req.body, null, 2)}`;
  if (!o.live) {
    say(
      `\nDRY RUN: nothing was sent. With --live, pms.cjs sends exactly this one request:\n${shown}\n\n` +
        'Orchestrator: show Jas this output, and on his "post" brief pam with this same command. Pam: run it with --live only when your brief says "Jas approved: post".'
    );
    return;
  }

  if (undoFor) before = `before: pms-undo/${saveUndo(o.project, code, undoFor)}`;
  const res = await request(E, req.method, req.path, req.body);
  if (o.verb === 'create' && res.ok) {
    try {
      const made = JSON.parse(res.text);
      taskId = made.id || (made.task && made.task.id) || '?';
    } catch {
      taskId = '?';
    }
  }
  // The result: the status, FAILED for any status but 2xx (a 3xx included: never followed), or, when no full answer came back, what broke
  // off and that the outcome is unknown: the write may have landed, so a retry could file a second comment or ticket.
  const result = res.unknown ? `${res.status} ${res.text}; ${UNKNOWN}` : `${res.status}${res.ok ? '' : ' FAILED'}`;
  const entry = [stamp(), o.verb, usedCode, taskId || '?', before, after, result].join(' | ');
  let logged = true;
  const logFile = path.join(RIG, o.project, 'work', 'pms-log.md');
  try {
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, LOG_HEAD);
    fs.appendFileSync(logFile, hideKey(entry) + '\n');
  } catch (e) {
    logged = false;
    process.stderr.write(hideKey(`pms: the request was sent, but ${logFile} could not be written (${e.code || e.message}); the line is:\n${entry}\n`));
    process.exitCode = 1;
  }
  const logNote = logged ? `\npms-log.md: ${entry}` : '';
  if (res.unknown) refuse(`LIVE ${req.method} ${req.path}: ${result} (the PMS may have applied it; pms.cjs never retries)${logNote}`);
  if (!res.ok) refuse(`LIVE ${req.method} ${req.path} failed: ${res.status} ${clip(res.text)}${res.status >= 300 && res.status < 400 ? ' (a redirect; pms.cjs never follows one)' : ''}${logNote}`);
  say(`LIVE: sent ${req.method} ${req.path}: ${res.status}${o.verb === 'create' ? `, new ticket ${usedCode}` : ''}`);
  if (logged) say(`pms-log.md: ${entry}`);
  // The read-back: GETs only. A check that fails, or a read-back that can't be done, exits 1 (the write is sent and logged; nothing is retried).
  let checks;
  try {
    checks = await verify();
  } catch (e) {
    refuse(`LIVE ${req.method} ${req.path} was sent and logged, but reading the ticket back failed (${e.message}); run show before anything else`);
  }
  for (const [what, ok] of checks) say(`check: ${what}: ${ok ? 'PRESENT' : 'MISSING'}`);
  if (checks.some(([, ok]) => !ok)) {
    process.stderr.write('pms: MISSING on the read-back: the write was sent and logged, but the board does not show it; run show, and never retry on your own\n');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(hideKey(`pms: ${e instanceof Refusal ? '' : 'error: '}${e.message}`) + '\n');
  process.exitCode = 1;
});
