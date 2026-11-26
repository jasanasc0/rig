'use strict';
// Run: node <rig>/test/pms.test.cjs   (exit 1 on any miss)
// The real pms.cjs, copied with guard.cjs (its profile validator) into a temp rig, against a fake PMS on 127.0.0.1 (port 0), with temp
// profiles and temp env files that hold a made-up key: it never calls the real PMS. Every output pms.cjs prints is searched for that key.
// pam build: edit with its undo file, create --code and --priority, the privacy filter, the duplicate-comment skip, the
// ticket printed by every dry run, and the PRESENT/MISSING read-back after a live write.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

let total = 0;
let failed = 0;
function check(label, ok) {
  total++;
  if (!ok) {
    failed++;
    console.error('FAIL ' + label);
  }
}

const KEY = 'fake-' + crypto.randomBytes(16).toString('hex');
const PID = 'proj-test-1';
const COLUMNS = [
  { id: 'c-backlog', name: 'Backlog' },
  { id: 'c-todo', name: 'To Do' },
  { id: 'c-review', name: 'Review/QA' },
  { id: 'c-done', name: 'Done' },
];
// The next free code is EX-251: the highest first EX-<n> of any title (the EX-300 inside a title is not its first code).
const boardTasks = () => [
  { id: 't5', title: '[EX-5] Five', columnId: 'c-todo', position: 2, assignee: { name: 'Jas' }, description: 'The fifth ticket.' },
  { id: 't12', title: '[EX-12] Twelve', columnId: 'c-todo', position: 3, assignee: null, description: 'Line one.\nLine two.' },
  { id: 't120', title: '[EX-120] A hundred and twenty, see EX-12', columnId: 'c-backlog', position: 0 },
  { id: 't7', title: '[EX-7] Seven, after EX-300', columnId: 'c-done', position: 0 },
  { id: 't250a', title: '[EX-250] First of a pair', columnId: 'c-backlog', position: 1 },
  { id: 't250b', title: '[EX-250] Second of a pair', columnId: 'c-done', position: 1 },
  { id: 't40', title: 'Follow-up on EX-40 (no code in front)', columnId: 'c-backlog', position: 2 },
];
const state = {};
const reset = () =>
  Object.assign(state, {
    tasks: boardTasks(),
    comments: { t12: [{ content: 'First comment.', author: { name: 'Robin' }, createdAt: '2026-09-01T10:00:00Z' }] },
    wrap: false, // answer with { columns: [...] } / { tasks: [...] } / { comments: [...] } instead of a bare array
    getStatus: 0, // answer every GET with this status and errBody
    writeStatus: 0, // answer every write with this status and errBody
    errBody: '',
    getBody: null, // answer every GET 200 with this raw text instead of the board
    writeRedirect: '', // answer every write 307 with this Location
    writeCut: '', // a write is applied, then 'body': its answer stops after the headers; 'drop': no answer at all (the socket is destroyed)
    createAnswer: null, // a create is applied and answered 201 with this instead of the new task
    noApply: false, // answer every write as if it worked, but change nothing on the board (the read-back then finds it MISSING)
    createColumn: '', // a create lands in this column whatever the request asked
    readBackStatus: 0, // once a write has arrived in this run, answer every GET with this status and errBody (the read-back fails)
    undoAtEdit: null, // the names in work\pms-undo\ at the moment an edit request arrived
    reqs: [],
    nextId: 1,
  });

// The fake PMS: the routes the reference PMS scripts used. It records every request and applies the writes to its board.
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    state.reqs.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, data) => {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      if (req.method !== 'GET' && state.writeCut === 'drop') return req.socket.destroy();
      if (req.method !== 'GET' && state.writeCut === 'body') {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(text.length + 50) });
        res.write(text.slice(0, 5));
        return setTimeout(() => req.socket.destroy(), 100);
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };
    const wrapped = (k, list) => (state.wrap ? { [k]: list } : list);
    try {
      if (req.headers.authorization !== 'Bearer ' + KEY) return send(401, { error: 'unauthorized' });
      if (req.method === 'GET' && state.getStatus) return send(state.getStatus, state.errBody);
      // (state.reqs holds this run's requests, this one last: run() empties it before each pms.cjs call)
      if (req.method === 'GET' && state.readBackStatus && state.reqs.some((q) => q.method !== 'GET')) return send(state.readBackStatus, state.errBody);
      if (req.method !== 'GET' && state.writeStatus) return send(state.writeStatus, state.errBody);
      if (req.method === 'GET' && state.getBody !== null) return send(200, state.getBody);
      if (req.method !== 'GET' && state.writeRedirect) {
        res.writeHead(307, { Location: state.writeRedirect, 'Content-Type': 'text/plain' });
        return res.end('moved');
      }
      let m;
      if (req.method === 'GET' && req.url === `/api/projects/${PID}/columns`) return send(200, wrapped('columns', COLUMNS));
      if (req.method === 'GET' && req.url === `/api/projects/${PID}/tasks`) return send(200, wrapped('tasks', state.tasks));
      if (req.method === 'GET' && (m = /^\/api\/tasks\/([^/]+)\/comments$/.exec(req.url))) return send(200, wrapped('comments', state.comments[m[1]] || []));
      if (req.method === 'PATCH' && (m = /^\/api\/tasks\/([^/]+)\/move$/.exec(req.url))) {
        const b = JSON.parse(body);
        const t = state.tasks.find((x) => x.id === m[1]);
        if (!state.noApply) Object.assign(t, { columnId: b.columnId, position: b.position });
        return send(200, t);
      }
      // edit (pam build): the fields given replace the ticket's (the reference correction script's PATCH /api/tasks/<id>).
      if (req.method === 'PATCH' && (m = /^\/api\/tasks\/([^/]+)$/.exec(req.url))) {
        state.undoAtEdit = fs.existsSync(UNDO_DIR) ? fs.readdirSync(UNDO_DIR) : [];
        const b = JSON.parse(body);
        const t = state.tasks.find((x) => x.id === m[1]);
        if (!state.noApply) for (const k of ['title', 'description']) if (b[k] !== undefined) t[k] = b[k];
        return send(200, t);
      }
      if (req.method === 'POST' && (m = /^\/api\/tasks\/([^/]+)\/comments$/.exec(req.url))) {
        if (!state.noApply) (state.comments[m[1]] ||= []).push(JSON.parse(body));
        return send(201, { id: 'cm' + state.nextId++ });
      }
      if (req.method === 'POST' && req.url === `/api/projects/${PID}/tasks`) {
        const t = { id: 't-new' + state.nextId++, position: 99, ...JSON.parse(body) };
        if (state.createColumn) t.columnId = state.createColumn;
        if (!state.noApply) state.tasks.push(t);
        return send(201, state.createAnswer || t);
      }
      send(404, { error: `no route ${req.method} ${req.url}` });
    } catch (e) {
      send(400, { error: e.message });
    }
  });
});
let UNDO_DIR = ''; // <temp rig>/example/work/pms-undo, set once the temp rig exists
// A second server on 127.0.0.1, where the fake PMS's 307 answer points: it only counts what reaches it.
const elsewhere = [];
const other = http.createServer((req, res) => {
  elsewhere.push(req.method + ' ' + req.url);
  req.resume();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pms-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    const BASE = `http://127.0.0.1:${server.address().port}`;
    const ELSEWHERE = `http://127.0.0.1:${other.address().port}`;
    for (const f of ['hooks/guard.cjs', 'bin/pms.cjs']) {
      try {
        fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true });
        fs.copyFileSync(path.join(__dirname, '..', f), path.join(tmp, f));
      } catch {} // a missing pms.cjs fails every check below instead of the suite
    }
    // The temp rig: a project per profile case, all with example's profile (prefix ex), a temp root and the pms field under test.
    const ROOT = path.join(tmp, 'root');
    fs.mkdirSync(ROOT);
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'example', 'profile.json'), 'utf8'));
    const project = (name, pms, extra = {}) => {
      fs.mkdirSync(path.join(tmp, name, 'work'), { recursive: true });
      const p = { ...example, name, root: ROOT.replace(/\\/g, '/'), ...extra };
      if (pms === undefined) delete p.pms;
      else p.pms = pms;
      fs.writeFileSync(path.join(tmp, name, 'profile.json'), JSON.stringify(p));
    };
    project('example', { projectId: PID, envFile: '.env.local' });
    project('nokey', { projectId: PID, envFile: '.env.nokey' });
    project('nobase', { projectId: PID, envFile: '.env.nobase' });
    project('nofile', { projectId: PID, envFile: '.env.missing' });
    project('badpms', { projectId: '', envFile: '.env.local' });
    project('sample', null, { ticketPrefix: 'sm' });
    project('nopms', undefined);
    fs.writeFileSync(path.join(ROOT, '.env.local'), `# test env\nOTHER=1\nPMS_BASE_URL=${BASE}/\nPMS_API_KEY="${KEY}"\n`);
    fs.writeFileSync(path.join(ROOT, '.env.nokey'), `PMS_BASE_URL=${BASE}\n`);
    fs.writeFileSync(path.join(ROOT, '.env.nobase'), `PMS_API_KEY=${KEY}\n`);
    const WORK = path.join(tmp, 'example', 'work');
    const LOG = path.join(WORK, 'pms-log.md');
    fs.mkdirSync(path.join(WORK, 'pms'));
    const COMMENT = path.join(WORK, 'pms', 'ex12-comment.md');
    const COMMENT_TEXT = 'Shipped in abc123.\nVerified on the board.';
    fs.writeFileSync(COMMENT, '\uFEFFShipped in abc123.\r\nVerified on the board.\r\n'); // a BOM and CRLF: sent without the BOM, with LF
    const DESC = path.join(WORK, 'pms', 'new-ticket.md');
    const DESC_TEXT = 'What: a new ticket.\nDone when: it exists.';
    fs.writeFileSync(DESC, DESC_TEXT + '\n');
    const OUTSIDE = path.join(tmp, 'outside');
    fs.mkdirSync(OUTSIDE);
    fs.writeFileSync(path.join(OUTSIDE, 'secret.md'), 'not for the PMS');
    fs.symlinkSync(OUTSIDE, path.join(WORK, 'out'), 'junction'); // a link inside work\ to a folder outside it
    // A link inside work\ whose real name starts with .env: a junction to a .env-notes folder in work\ (a file link needs Windows Developer
    // Mode, which is off on this PC, so a junction is the link that exists here).
    fs.mkdirSync(path.join(WORK, '.env-notes'));
    fs.symlinkSync(path.join(WORK, '.env-notes'), path.join(WORK, 'notes'), 'junction');
    fs.writeFileSync(path.join(WORK, '.env.local'), 'PMS_API_KEY=' + KEY);
    fs.writeFileSync(path.join(WORK, 'empty.md'), '  \n');
    fs.writeFileSync(path.join(WORK, 'long.md'), 'x'.repeat(5001));
    // pam build: more drafts in work\pms\, the undo folder edit writes, and a profile whose lane names appear in no code (qx-...), so the
    // privacy filter is shown to take its names from the profiles.
    UNDO_DIR = path.join(WORK, 'pms-undo');
    const draft = (name, text) => {
      const f = path.join(WORK, 'pms', name);
      fs.writeFileSync(f, text);
      return f;
    };
    const COMMENT2 = draft('ex12-comment-2.md', 'Second note for the board.');
    const SAME80 = draft('same80.md', 'A'.repeat(80) + ' but another ending.');
    const DIFF79 = draft('diff79.md', 'A'.repeat(79) + 'B and the rest.');
    const NEWDESC = draft('new-desc.md', 'New description.\nWith two lines.');
    project('qx', { projectId: PID, envFile: '.env.local' }, { ticketPrefix: 'qx', lanes: Object.fromEntries(Object.keys(example.lanes).map((k) => [k, 'qx-' + k])) });

    const outputs = [];
    const run = (args, cwd = ROOT) =>
      new Promise((resolve) => {
        state.reqs = [];
        execFile(process.execPath, [path.join(tmp, 'bin', 'pms.cjs'), ...args], { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
          outputs.push(stdout, stderr);
          resolve({ status: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr, out: stdout + stderr, reqs: state.reqs.slice() });
        });
      });
    const writes = (r) => r.reqs.filter((q) => q.method !== 'GET');
    const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => /^\d{4}-/.test(l)) : []);
    const json = (s) => {
      try {
        return JSON.stringify(JSON.parse(s));
      } catch {
        return '(not JSON)';
      }
    };
    const V = ['--project', 'example'];
    const refused = (r, words, label) => {
      check(`${label}: exits non-zero`, r.status !== 0);
      check(`${label}: says ${JSON.stringify(words)}`, words.every((w) => r.stderr.includes(w)));
    };
    let r;
    reset();

    // board and show: GETs only.
    r = await run([...V, 'board']);
    check('board: exit 0', r.status === 0);
    check('board: GETs the columns and the tasks, nothing else', JSON.stringify(r.reqs.map((q) => q.method + ' ' + q.url)) === JSON.stringify([`GET /api/projects/${PID}/columns`, `GET /api/projects/${PID}/tasks`]));
    check('board: every request carries the key as a Bearer token', r.reqs.length > 0 && r.reqs.every((q) => q.headers.authorization === 'Bearer ' + KEY));
    const at = (s) => r.stdout.indexOf(s);
    check(
      'board: every column in board order with its count, empty ones too',
      at('===== Backlog (3) =====') > -1 && at('===== Backlog (3) =====') < at('===== To Do (2) =====') && at('===== To Do (2) =====') < at('===== Review/QA (0) =====') && at('===== Review/QA (0) =====') < at('===== Done (2) =====')
    );
    check('board: every ticket title, an assignee and a description line', boardTasks().every((t) => r.stdout.includes(t.title)) && r.stdout.includes('[Jas] [EX-5] Five') && r.stdout.includes('The fifth ticket.'));
    state.wrap = true;
    r = await run([...V, 'board']);
    check('board: reads { columns: [...] } and { tasks: [...] } answers too', r.status === 0 && r.stdout.includes('===== To Do (2) =====') && r.stdout.includes('[EX-12] Twelve'));
    state.wrap = false;
    r = await run([...V, 'show', 'EX-12']);
    check('show: exit 0', r.status === 0);
    check('show: the ticket, its column, position, assignee and description', r.stdout.includes('[EX-12] Twelve') && r.stdout.includes('To Do') && r.stdout.includes('Line one.') && r.stdout.includes('Line two.'));
    check('show: its comments with author and time', r.stdout.includes('First comment.') && r.stdout.includes('Robin') && r.stdout.includes('2026-09-01T10:00:00Z'));
    check('show: reads the tasks and GET /api/tasks/t12/comments, writes nothing', r.reqs.some((q) => q.method === 'GET' && q.url === '/api/tasks/t12/comments') && writes(r).length === 0);
    check('show EX-12 is [EX-12], not [EX-120] (a whole code, at the start of the title)', !r.stdout.includes('A hundred'));
    state.wrap = true;
    r = await run([...V, 'show', 'EX-12']);
    check('show: reads a { comments: [...] } answer too', r.status === 0 && r.stdout.includes('First comment.'));
    state.wrap = false;

    // M3: a code names a ticket as [CODE] at the start of its title, or CODE at the start not followed by a word character, . or -.
    const extra = [
      { id: 't12dot', title: '[EX-12.1] A sub-ticket', columnId: 'c-backlog', position: 5 },
      { id: 't12b', title: 'EX-12-b A variant', columnId: 'c-backlog', position: 6 },
      { id: 't60', title: 'EX-60 No brackets', columnId: 'c-todo', position: 7 },
      { id: 't61dot', title: '[EX-61.1] Only a sub-ticket', columnId: 'c-todo', position: 8 },
      { id: 't61b', title: 'EX-61-b Only a variant', columnId: 'c-todo', position: 9 },
    ];
    state.tasks.push(...extra);
    r = await run([...V, 'show', 'EX-12']);
    check('show EX-12 with [EX-12.1] and EX-12-b on the board: the one [EX-12] ticket', r.status === 0 && r.stdout.includes('[EX-12] Twelve') && !r.out.includes('A sub-ticket') && !r.out.includes('A variant'));
    r = await run([...V, 'show', 'EX-60']);
    check('show EX-60: "EX-60 <title>" (the code at the start, no brackets) is that ticket', r.status === 0 && r.stdout.includes('EX-60 No brackets'));
    r = await run([...V, 'show', 'EX-61']);
    refused(r, ['no ticket title starts with EX-61', '[EX-61.1] Only a sub-ticket', 'EX-61-b Only a variant'], '[EX-61.1] and EX-61-b are not EX-61 (listed as titles that mention it)');
    state.tasks = state.tasks.filter((t) => !extra.includes(t));

    // move: a dry run sends nothing; --live sends one PATCH and logs it; the log line is enough to undo it.
    r = await run([...V, 'move', 'EX-12', 'review/qa']);
    check('move dry run: exit 0 and says DRY RUN', r.status === 0 && r.stdout.includes('DRY RUN'));
    check('move dry run: prints the method, the path and the JSON body', r.stdout.includes('PATCH /api/tasks/t12/move') && r.stdout.includes(JSON.stringify({ columnId: 'c-review', position: 0 }, null, 2)));
    check('move dry run: names the column it leaves and the one it goes to (a column name matches in any case)', r.stdout.includes('"To Do"') && r.stdout.includes('"Review/QA"'));
    check('move dry run: sends nothing (GETs only) and logs nothing', r.reqs.length > 0 && writes(r).length === 0 && !fs.existsSync(LOG));
    // A.6: a write's dry run first prints the ticket's column, its full description and every comment, then the request.
    check(
      'move dry run: prints the ticket first: its column, its full description and every comment',
      r.stdout.includes('column "To Do"') && r.stdout.includes('Line one.\nLine two.') && r.stdout.includes('First comment.') && r.stdout.includes('Robin') && r.stdout.indexOf('First comment.') < r.stdout.indexOf('PATCH /api/tasks/t12/move')
    );
    check('move dry run: reads the comments (GET /api/tasks/t12/comments)', r.reqs.some((q) => q.method === 'GET' && q.url === '/api/tasks/t12/comments'));
    check('the dry run speaks to both seats: the orchestrator shows Jas and briefs pam on his "post"; pam adds --live only on "Jas approved: post"', r.stdout.includes('show Jas this output') && r.stdout.includes('brief pam') && r.stdout.includes('Pam: ') && r.stdout.includes('"Jas approved: post"'));
    r = await run([...V, 'move', 'EX-12', 'Review/QA', '--live']);
    let w = writes(r);
    check('move --live: exit 0 and exactly one write request', r.status === 0 && w.length === 1);
    // A.7: after a live write the ticket is read back, one PRESENT or MISSING line per check, with GETs only.
    check('move --live: reads the ticket back: EX-12 is in "Review/QA": PRESENT', r.stdout.includes('check: EX-12 is in "Review/QA": PRESENT'));
    check('move --live: the read-back comes after the write and is GETs only', r.reqs.findIndex((q) => q.method !== 'GET') < r.reqs.length - 1 && r.reqs.slice(r.reqs.findIndex((q) => q.method !== 'GET') + 1).every((q) => q.method === 'GET'));
    check('move --live: PATCH /api/tasks/t12/move with {"columnId":"c-review","position":0}', w.length === 1 && w[0].method === 'PATCH' && w[0].url === '/api/tasks/t12/move' && json(w[0].body) === JSON.stringify({ columnId: 'c-review', position: 0 }));
    check("move --live: JSON, the key, and the base URL's origin as Origin", w.length === 1 && w[0].headers['content-type'] === 'application/json' && w[0].headers.authorization === 'Bearer ' + KEY && w[0].headers.origin === BASE);
    const moveLine = logLines()[0] || '';
    check(
      'move --live: one log line: local time | move | code | task id | before-state | after | status',
      logLines().length === 1 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \| move \| EX-12 \| t12 \| before: "To Do" pos 3 \| after: "Review\/QA" pos 0 \| 200$/.test(moveLine)
    );
    check('move --live: prints the log line', moveLine !== '' && r.stdout.includes(moveLine));
    check('the log starts with a header that says what a line holds', fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').startsWith('# PMS log\n'));
    const oldColumn = (/before: "([^"]+)"/.exec(moveLine) || [])[1] || '?';
    r = await run([...V, 'move', 'EX-12', oldColumn, '--live']);
    w = writes(r);
    check('the log line is enough to undo the move: move EX-12 "<old column>" --live puts it back', r.status === 0 && w.length === 1 && json(w[0].body) === JSON.stringify({ columnId: 'c-todo', position: 0 }) && state.tasks.find((t) => t.id === 't12').columnId === 'c-todo');
    r = await run([...V, 'move', 'EX-12', 'To Do', '--live']);
    refused(r, ['already in "To Do"'], 'move to the column the ticket is in');
    check('move to the column the ticket is in: sends nothing', writes(r).length === 0);

    // comment: the text comes from a file in work\.
    const before = logLines().length;
    r = await run([...V, 'comment', 'EX-12', COMMENT]);
    check('comment dry run: exit 0, DRY RUN, POST /api/tasks/t12/comments and the body', r.status === 0 && r.stdout.includes('DRY RUN') && r.stdout.includes('POST /api/tasks/t12/comments') && r.stdout.includes(JSON.stringify({ content: COMMENT_TEXT }, null, 2)));
    check('comment dry run: sends nothing and logs nothing', writes(r).length === 0 && logLines().length === before);
    check('comment dry run: prints the ticket first (column, description, every comment)', r.stdout.includes('column "To Do"') && r.stdout.includes('Line one.\nLine two.') && r.stdout.indexOf('First comment.') < r.stdout.indexOf('POST /api/tasks/t12/comments'));
    r = await run([...V, 'comment', 'EX-12', 'pms/ex12-comment.md'], WORK);
    check('comment dry run: a path relative to the current folder works', r.status === 0 && r.stdout.includes('POST /api/tasks/t12/comments'));
    // M5: the work folder compare ignores letter case (realpathSync.native gives the on-disk case on this PC, so the lower-case compare is
    // the fallback for a path it would not normalize).
    r = await run([...V, 'comment', 'EX-12', path.join(WORK.toUpperCase(), 'pms', 'ex12-comment.md')]);
    check('comment dry run: the same work folder spelled in upper case is accepted', r.status === 0 && r.stdout.includes('DRY RUN') && r.stdout.includes('POST /api/tasks/t12/comments'));
    r = await run([...V, 'comment', 'EX-12', COMMENT, '--live']);
    w = writes(r);
    check('comment --live: exit 0 and exactly one write: POST /api/tasks/t12/comments {"content": <the file, no BOM, LF>}', r.status === 0 && w.length === 1 && w[0].method === 'POST' && w[0].url === '/api/tasks/t12/comments' && json(w[0].body) === JSON.stringify({ content: COMMENT_TEXT }));
    check('comment --live: Origin is the base URL origin', w.length === 1 && w[0].headers.origin === BASE && w[0].headers['content-type'] === 'application/json');
    const commentLine = logLines()[before] || '';
    check('comment --live: one log line, no before-state, the file, status 201', logLines().length === before + 1 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \| comment \| EX-12 \| t12 \| before: - \| text: ex12-comment\.md \(\d+ chars\) \| 201$/.test(commentLine));
    check('comment --live: prints the log line', commentLine !== '' && r.stdout.includes(commentLine));
    check('comment --live: reads the comments back: PRESENT', r.stdout.includes('check: the comment from ex12-comment.md is on EX-12: PRESENT'));
    // A.5: a comment whose first 80 characters equal a comment already on the ticket is skipped: no write, exit 0 (a re-run is safe).
    r = await run([...V, 'comment', 'EX-12', COMMENT, '--live']);
    check('the same comment --live again: skipped, exit 0, nothing sent, no log line', r.status === 0 && writes(r).length === 0 && logLines().length === before + 1 && r.stdout.includes('skipped'));
    r = await run([...V, 'comment', 'EX-12', COMMENT]);
    check('the same comment as a dry run: says skipped, exit 0, shows no request', r.status === 0 && r.stdout.includes('skipped') && !r.stdout.includes('POST /api/tasks/t12/comments'));
    state.comments.t5 = [{ content: 'A'.repeat(80) + ' then the first ending.', author: { name: 'Robin' }, createdAt: '2026-09-02T10:00:00Z' }];
    r = await run([...V, 'comment', 'EX-5', SAME80, '--live']);
    check('a comment whose first 80 characters equal an existing one is skipped, whatever follows', r.status === 0 && writes(r).length === 0 && r.stdout.includes('skipped'));
    r = await run([...V, 'comment', 'EX-5', DIFF79]);
    check('a comment that shares only 79 characters is not skipped (the dry run shows the request)', r.status === 0 && !r.stdout.includes('skipped') && r.stdout.includes('POST /api/tasks/t5/comments'));

    // create: the next free code in the dry run, recomputed at --live time.
    r = await run([...V, 'create', 'A new ticket', DESC]);
    const createBody = (code, columnId) => JSON.stringify({ title: `[${code}] A new ticket`, description: DESC_TEXT, columnId }, null, 2);
    check('create dry run: exit 0 and shows the next free code EX-251', r.status === 0 && r.stdout.includes('EX-251'));
    check('create dry run: POST /api/projects/<id>/tasks, title "[EX-251] <title>", the file as description, the first column by default', r.stdout.includes(`POST /api/projects/${PID}/tasks`) && r.stdout.includes(createBody('EX-251', 'c-backlog')));
    check('create dry run: sends nothing', writes(r).length === 0);
    state.tasks.push({ id: 't251', title: '[EX-251] Filed by someone else meanwhile', columnId: 'c-todo', position: 0 });
    const beforeCreate = logLines().length;
    r = await run([...V, 'create', 'A new ticket', DESC, '--column', 'to do', '--live']);
    w = writes(r);
    check('create --live: exit 0 and exactly one write request', r.status === 0 && w.length === 1);
    check('create --live: recomputes the code (EX-252 after someone filed EX-251) and --column picks the column', w.length === 1 && w[0].method === 'POST' && w[0].url === `/api/projects/${PID}/tasks` && json(w[0].body) === json(createBody('EX-252', 'c-todo')));
    check('create --live: prints the code it used', r.stdout.includes('EX-252'));
    const createLine = logLines()[beforeCreate] || '';
    check('create --live: one log line with the new ticket id, before: none, status 201', logLines().length === beforeCreate + 1 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \| create \| EX-252 \| t-new\d+ \| before: none \| column: "To Do", text: new-ticket\.md \(\d+ chars\) \| 201$/.test(createLine));
    check('create --live: reads the board back: the code is on it and in the asked column', r.stdout.includes('check: EX-252 is on the board: PRESENT') && r.stdout.includes('check: EX-252 is in "To Do": PRESENT'));
    r = await run([...V, 'create', 'Another', DESC]);
    check('create after a create: the board moved on, so the next code is EX-253', r.status === 0 && r.stdout.includes('EX-253'));
    // A.6: a create's dry run prints the board's highest code and every title like the new one.
    check('create dry run: prints the highest code on the board', r.stdout.includes('highest code on the board: EX-252'));
    r = await run([...V, 'create', 'twelve', DESC]);
    check('create dry run: lists a title on the board like the new one (any case, without its code)', r.status === 0 && r.stdout.includes('[EX-12] Twelve') && r.stdout.indexOf('[EX-12] Twelve') < r.stdout.indexOf('POST /api/projects/'));

    // A.3: create --code <CODE>. The same code with the same title is already posted (no write, exit 0); the code on the board with another
    // title, or a number not above the board's highest, refuses (numbers collide across sessions); a free code above the highest is used.
    r = await run([...V, 'create', 'Twelve', DESC, '--code', 'EX-12', '--live']);
    check('create --code EX-12 with its own title: "already posted", exit 0, nothing sent', r.status === 0 && writes(r).length === 0 && r.stdout.includes('already posted'));
    r = await run([...V, 'create', 'Twelve', DESC, '--code', 'EX-12']);
    check('create --code EX-12 with its own title, dry run: "already posted", exit 0, no request shown', r.status === 0 && r.stdout.includes('already posted') && !r.stdout.includes('POST /api/projects/'));
    r = await run([...V, 'create', 'Something else', DESC, '--code', 'EX-12', '--live']);
    refused(r, ['EX-12', 'another title', '[EX-12] Twelve'], 'create --code with a code on the board under another title');
    check('create --code with a code on the board under another title: sends nothing', writes(r).length === 0);
    r = await run([...V, 'create', 'Gap filler', DESC, '--code', 'EX-100', '--live']);
    refused(r, ['EX-100', 'highest', 'EX-252'], 'create --code with a number not above the highest on the board');
    check('create --code with a number not above the highest: sends nothing', writes(r).length === 0);
    r = await run([...V, 'create', 'Coded ticket', DESC, '--code', 'ex-900']);
    check('create --code EX-900 dry run: the title carries that code, nothing sent', r.status === 0 && r.stdout.includes('"title": "[EX-900] Coded ticket"') && writes(r).length === 0 && !r.stdout.includes('worked out again'));
    const beforeCoded = logLines().length;
    r = await run([...V, 'create', 'Coded ticket', DESC, '--code', 'EX-900', '--priority', 'high', '--live']);
    w = writes(r);
    check('create --code EX-900 --priority high --live: one write with that code and priority HIGH', r.status === 0 && w.length === 1 && json(w[0].body) === JSON.stringify({ title: '[EX-900] Coded ticket', description: DESC_TEXT, columnId: 'c-backlog', priority: 'HIGH' }));
    check('create --code --live: logged under EX-900 and read back PRESENT', / \| create \| EX-900 \| t-new\d+ \| /.test(logLines()[beforeCoded] || '') && r.stdout.includes('check: EX-900 is on the board: PRESENT'));
    r = await run([...V, 'create', 'Coded ticket', DESC, '--code', 'EX-900', '--live']);
    check('the same create --code --live again: "already posted", exit 0, nothing sent', r.status === 0 && writes(r).length === 0 && r.stdout.includes('already posted'));
    for (const p of ['LOW', 'MEDIUM', 'URGENT']) {
      r = await run([...V, 'create', 'Prioritised', DESC, '--priority', p]);
      check(`create --priority ${p}: the body carries it`, r.status === 0 && r.stdout.includes(`"priority": "${p}"`));
    }

    // A.2: edit <CODE> [--title "<title>"] [--description <file>]: PATCH /api/tasks/<id> with the fields given. The title keeps the ticket's
    // [CODE] in front. Before the live write the old title and description go to work\pms-undo\<yyyyMMdd-HHmmss>-<CODE>.json; when that file
    // can't be written, nothing is sent. The log line names the undo file.
    r = await run([...V, 'edit', 'EX-12', '--title', 'New title', '--description', NEWDESC]);
    check('edit dry run: exit 0, PATCH /api/tasks/t12 with the new title (its code in front) and description', r.status === 0 && r.stdout.includes('DRY RUN') && r.stdout.includes('PATCH /api/tasks/t12\n') && r.stdout.includes(JSON.stringify({ title: '[EX-12] New title', description: 'New description.\nWith two lines.' }, null, 2)));
    check('edit dry run: prints the ticket first, sends nothing, writes no undo file', r.stdout.indexOf('Line one.\nLine two.') > -1 && r.stdout.indexOf('First comment.') < r.stdout.indexOf('PATCH /api/tasks/t12') && writes(r).length === 0 && !fs.existsSync(UNDO_DIR));
    fs.writeFileSync(UNDO_DIR, 'a file where the undo folder should be');
    const beforeEdit = logLines().length;
    r = await run([...V, 'edit', 'EX-12', '--title', 'New title', '--live']);
    refused(r, ['undo', 'nothing was sent'], "edit --live when the undo file can't be written");
    check("edit --live when the undo file can't be written: sends nothing and logs nothing", writes(r).length === 0 && logLines().length === beforeEdit);
    fs.rmSync(UNDO_DIR);
    r = await run([...V, 'edit', 'EX-12', '--title', 'New title', '--description', NEWDESC, '--live']);
    w = writes(r);
    check('edit --live: exit 0 and exactly one write: PATCH /api/tasks/t12 with the title and description', r.status === 0 && w.length === 1 && w[0].method === 'PATCH' && w[0].url === '/api/tasks/t12' && json(w[0].body) === JSON.stringify({ title: '[EX-12] New title', description: 'New description.\nWith two lines.' }));
    const undoFiles = fs.existsSync(UNDO_DIR) ? fs.readdirSync(UNDO_DIR) : [];
    const undo = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(UNDO_DIR, undoFiles[0]), 'utf8'));
      } catch {
        return {};
      }
    })();
    check('edit --live: one undo file named <yyyyMMdd-HHmmss>-EX-12.json', undoFiles.length === 1 && /^\d{8}-\d{6}-EX-12\.json$/.test(undoFiles[0]));
    check('edit --live: the undo file holds the old title and the full old description', undo.title === '[EX-12] Twelve' && undo.description === 'Line one.\nLine two.');
    check('edit --live: the undo file existed before the write request arrived', JSON.stringify(state.undoAtEdit) === JSON.stringify(undoFiles));
    check('edit --live: the log line names the undo file', logLines().length === beforeEdit + 1 && (logLines()[beforeEdit] || '').includes(`| edit | EX-12 | t12 | before: pms-undo/${undoFiles[0]} |`) && / \| 200$/.test(logLines()[beforeEdit] || ''));
    check('edit --live: reads the ticket back: title and description PRESENT', r.stdout.includes('check: the title is "[EX-12] New title": PRESENT') && r.stdout.includes('check: the description is the text of new-desc.md: PRESENT'));
    r = await run([...V, 'edit', 'EX-12', '--title', 'Twelve', '--live']);
    check('edit --title only --live: the body holds the title alone', r.status === 0 && writes(r).length === 1 && json(writes(r)[0].body) === JSON.stringify({ title: '[EX-12] Twelve' }));
    state.tasks.find((t) => t.id === 't12').description = 'Line one.\nLine two.';
    r = await run([...V, 'edit', 'EX-12', '--title', '[EX-12] Twelve']);
    refused(r, ['without a code'], 'an edit title that carries a code');
    check('an edit title that carries a code: no request at all', r.reqs.length === 0);
    r = await run([...V, 'edit', 'EX-250', '--title', 'Pair']);
    refused(r, ['2 tickets'], 'edit of an ambiguous code');

    // A.4: every text pms.cjs would send (a title, a comment, a description) is refused before any request when it names the rig: herdr, rig,
    // or a lane name of any profile (word-bounded, any case). The names come from the profiles: qx-pam is in the temp qx profile only.
    const privacy = async (args, word, label) => {
      const res = await run(args);
      refused(res, [`"${word}"`, 'never reaches the PMS'], `privacy: ${label}`);
      check(`privacy: ${label}: no request at all`, res.reqs.length === 0);
    };
    await privacy([...V, 'comment', 'EX-12', draft('p-herdr.md', 'Checked it in herdr today.')], 'herdr', 'a comment that says herdr');
    await privacy([...V, 'comment', 'EX-12', draft('p-rig.md', 'Built on the Rig.'), '--live'], 'Rig', 'a comment that says Rig (any case), --live');
    await privacy([...V, 'comment', 'EX-12', draft('p-lane.md', 'ex-angela approved it.')], 'ex-angela', "a comment with a lane name from example's profile");
    await privacy([...V, 'comment', 'EX-12', draft('p-qx.md', 'Sent by qx-oscar.')], 'qx-oscar', 'a comment with a lane name only the qx profile holds');
    await privacy([...V, 'create', 'Ask the ex-orchestrator', DESC], 'ex-orchestrator', 'a create title with a lane name');
    await privacy([...V, 'create', 'A clean title', draft('p-desc.md', 'What: see the ex-coder notes.')], 'ex-coder', 'a create description with a lane name');
    await privacy([...V, 'edit', 'EX-12', '--title', 'herdr follow-up'], 'herdr', 'an edit title');
    await privacy([...V, 'edit', 'EX-12', '--description', draft('p-edit.md', 'Owner: ex-oscar.')], 'ex-oscar', 'an edit description');
    // scribe build: the new lane names come from the profiles too, so ex-scribe never reaches the PMS.
    await privacy([...V, 'comment', 'EX-12', draft('p-scribe.md', 'The ex-scribe wrote the day page.')], 'ex-scribe', 'a comment with the scribe lane name (a lane since the scribe build)');
    r = await run([...V, 'comment', 'EX-12', draft('p-clean.md', 'The trigger is rigorous; the flex-coders read the ex-pamphlet.')]);
    check('privacy: words that only contain a name (trigger, rigorous, flex-coders, ex-pamphlet) pass', r.status === 0 && r.stdout.includes('DRY RUN'));
    fs.mkdirSync(path.join(tmp, 'zz-broken'));
    fs.writeFileSync(path.join(tmp, 'zz-broken', 'profile.json'), '{ "name": "zz-broken", "lanes": ');
    r = await run([...V, 'comment', 'EX-12', COMMENT2]);
    refused(r, ['zz-broken', 'lane names'], "privacy: a profile whose lane names can't be read stops every write");
    check("privacy: a profile whose lane names can't be read: no request at all", r.reqs.length === 0);
    fs.rmSync(path.join(tmp, 'zz-broken'), { recursive: true, force: true });

    // A.7: a write the PMS answered 2xx but did not apply is MISSING on the read-back: exit 1, the line logged, nothing retried.
    state.noApply = true;
    const beforeMissing = logLines().length;
    r = await run([...V, 'move', 'EX-12', 'Done', '--live']);
    check('a move answered 200 but not applied: MISSING, exit 1, one write, logged', r.status !== 0 && r.stdout.includes('check: EX-12 is in "Done": MISSING') && writes(r).length === 1 && logLines().length === beforeMissing + 1);
    r = await run([...V, 'comment', 'EX-12', COMMENT2, '--live']);
    check('a comment answered 201 but not stored: MISSING, exit 1, one write', r.status !== 0 && r.stdout.includes('check: the comment from ex12-comment-2.md is on EX-12: MISSING') && writes(r).length === 1);
    r = await run([...V, 'edit', 'EX-12', '--title', 'Not applied', '--live']);
    check('an edit answered 200 but not applied: MISSING, exit 1, one write', r.status !== 0 && r.stdout.includes('check: the title is "[EX-12] Not applied": MISSING') && writes(r).length === 1);
    state.noApply = false;
    state.createColumn = 'c-done';
    r = await run([...V, 'create', 'Lands elsewhere', DESC, '--column', 'To Do', '--live']);
    check('a create that lands in another column: the code PRESENT, the column MISSING, exit 1, one write', r.status !== 0 && /check: EX-\d+ is on the board: PRESENT/.test(r.stdout) && /check: EX-\d+ is in "To Do": MISSING/.test(r.stdout) && writes(r).length === 1);
    state.createColumn = '';
    // review-pam M2: the write lands, then the read-back's GET fails: exit 1, the one write logged, no PRESENT line, nothing retried.
    state.readBackStatus = 500;
    state.errBody = 'read-back down';
    const beforeReadBack = logLines().length;
    r = await run([...V, 'move', 'EX-5', 'Review/QA', '--live']);
    refused(r, ['was sent and logged', 'reading the ticket back failed', '500', 'read-back down'], 'a read-back whose GET fails after the write landed');
    check('a read-back whose GET fails: exactly one write, and the board took it', writes(r).length === 1 && state.tasks.find((t) => t.id === 't5').columnId === 'c-review');
    check('a read-back whose GET fails: the write is logged once, with its status', logLines().length === beforeReadBack + 1 && / \| move \| EX-5 \| t5 \| before: "To Do" pos 2 \| after: "Review\/QA" pos 0 \| 200$/.test(logLines()[beforeReadBack] || ''));
    check('a read-back whose GET fails: no PRESENT line (and no MISSING line)', !r.out.includes('PRESENT') && !r.out.includes('MISSING'));
    state.readBackStatus = 0;
    state.errBody = '';

    // Refusals after reading the board: nothing is written.
    const noWrite = (r, label) => check(`${label}: sends nothing`, writes(r).length === 0);
    r = await run([...V, 'move', 'EX-40', 'Done']);
    refused(r, ['no ticket title starts with EX-40', 'Follow-up on EX-40'], 'a code no title starts with (lists the titles that mention it)');
    noWrite(r, 'a code no title starts with');
    r = await run([...V, 'show', 'EX-77']);
    refused(r, ['no ticket title starts with EX-77'], 'a code nowhere on the board');
    r = await run([...V, 'move', 'EX-250', 'Done', '--live']);
    refused(r, ['2 tickets', 't250a', 't250b', 'First of a pair', 'Second of a pair'], 'an ambiguous code (lists both)');
    noWrite(r, 'an ambiguous code');
    r = await run([...V, 'move', 'EX-12', 'Doing', '--live']);
    refused(r, ['no column "Doing"', '"Backlog", "To Do", "Review/QA", "Done"'], 'an unknown column (lists the valid names)');
    noWrite(r, 'an unknown column');
    r = await run([...V, 'create', 'A new ticket', DESC, '--column', 'Nope', '--live']);
    refused(r, ['no column "Nope"'], 'create with an unknown column');
    noWrite(r, 'create with an unknown column');
    r = await run([...V, 'create', '[EX-9] Coded already', DESC]);
    refused(r, ['without a code'], 'a create title that carries a code');

    // M5: a board answer pms.cjs can't read refuses before any write; a create answer without an id is logged with the task id "?".
    state.getBody = 'this is not JSON';
    r = await run([...V, 'move', 'EX-12', 'Done', '--live']);
    refused(r, ['the answer is not JSON', 'this is not JSON'], 'a GET answer that is not JSON');
    noWrite(r, 'a GET answer that is not JSON');
    state.getBody = JSON.stringify({ ok: true });
    r = await run([...V, 'move', 'EX-12', 'Done', '--live']);
    refused(r, ['the answer holds no list'], 'a GET answer with no list in it');
    noWrite(r, 'a GET answer with no list in it');
    state.getBody = null;
    state.createAnswer = { ok: true };
    const beforeNoId = logLines().length;
    r = await run([...V, 'create', 'No id in the answer', DESC, '--live']);
    check('a create answered without an id: exit 0 and exactly one write', r.status === 0 && writes(r).length === 1);
    check('a create answered without an id: logged with the task id "?"', logLines().length === beforeNoId + 1 && / \| create \| EX-\d+ \| \? \| before: none \| column: "Backlog", text: new-ticket\.md \(\d+ chars\) \| 201$/.test(logLines()[beforeNoId] || ''));
    state.createAnswer = null;

    // Refusals before any network call: the file, the profile, the env file, the arguments.
    const offline = async (args, words, label) => {
      const res = await run(args);
      refused(res, words, label);
      check(`${label}: no request at all`, res.reqs.length === 0);
      return res;
    };
    await offline([...V, 'comment', 'EX-12', path.join(OUTSIDE, 'secret.md'), '--live'], ['not inside'], 'a file outside work\\');
    await offline([...V, 'comment', 'EX-12', path.join(WORK, '.env.local'), '--live'], ['.env'], 'a .env file inside work\\');
    await offline([...V, 'comment', 'EX-12', path.join(WORK, 'out', 'secret.md'), '--live'], ['not inside'], 'a link out of work\\ (a junction)');
    await offline([...V, 'comment', 'EX-12', path.join(WORK, 'notes'), '--live'], ['a .env file is never sent'], 'a link inside work\\ whose real name starts with .env');
    await offline([...V, 'create', 'x', path.join(WORK, 'out', 'secret.md')], ['not inside'], 'create with a file through a link out of work\\');
    await offline([...V, 'comment', 'EX-12', path.join(WORK, 'nope.md')], ["can't be read"], 'a file that does not exist');
    await offline([...V, 'comment', 'EX-12', path.join(WORK, 'empty.md')], ['is empty'], 'an empty file');
    await offline([...V, 'comment', 'EX-12', path.join(WORK, 'long.md')], ['5001 characters', '5000'], 'a text over the 5000-character cap');
    await offline(['--project', 'sample', 'board'], ['no PMS configured for sample'], 'pms: null');
    await offline(['--project', 'nopms', 'board'], ['no PMS configured for nopms'], 'a profile without pms');
    await offline(['--project', 'badpms', 'board'], ['"pms" is missing or wrong'], "a pms the guard's validator refuses");
    await offline(['--project', 'nofile', 'board'], ["can't be read", 'PMS_BASE_URL', 'PMS_API_KEY'], 'a missing env file');
    r = await offline(['--project', 'nokey', 'board'], ['PMS_API_KEY is not set'], 'a missing key');
    check('a missing key: the base URL value is not printed', !r.out.includes('127.0.0.1'));
    await offline(['--project', 'nobase', 'board'], ['PMS_BASE_URL is not set'], 'a missing base URL');
    await offline([...V, 'delete', 'EX-12'], ['unknown verb "delete"'], 'an unknown verb (no delete)');
    await offline([...V, 'board', 'extra'], ['board takes no argument'], 'board with an extra argument');
    await offline([...V, 'show', 'EX-12', 'EX-5'], ['show takes 1 argument'], 'show with two codes (no bulk)');
    await offline([...V, 'move', 'EX-12'], ['move takes 2 arguments'], 'move without a column');
    await offline([...V, 'comment', 'EX-12', COMMENT, 'more'], ['comment takes 2 arguments'], 'comment with an extra argument');
    await offline([...V, 'board', '--live'], ['--live is only for move, comment, create and edit'], 'board --live');
    await offline([...V, 'move', 'EX-12', 'Done', '--column', 'Done'], ['--column is only for create'], 'move --column');
    await offline([...V, 'board', '--force'], ['unknown option --force'], 'an unknown option');
    await offline([...V, 'move', 'EX-12', 'Done', '--live', '--live'], ['--live given twice'], '--live twice');
    await offline(['board'], ['--project'], 'no --project');
    await offline([], ['--project'], 'no arguments');
    await offline(['--project', 'nosuch', 'board'], ['unknown project "nosuch"'], 'an unknown project');
    await offline(['--project', '../example', 'board'], ['is not a project name'], 'a project name with a path');
    await offline([...V, 'show', 'EX12'], ['EX-<n>'], 'a code without the dash');
    await offline([...V, 'show', 'SM-12'], ['EX-<n>'], "another project's code");
    // pam build: the new options belong to their verbs, and their values are checked before any request.
    await offline([...V, 'edit', 'EX-12'], ['edit needs --title', '--description'], 'edit with neither --title nor --description');
    await offline([...V, 'edit', 'EX-12', '--title', '  '], ['the title is empty'], 'edit with an empty title');
    await offline([...V, 'edit', 'EX-12', '--description', path.join(OUTSIDE, 'secret.md')], ['not inside'], 'edit with a description file outside work\\');
    await offline([...V, 'edit', 'EX-12', 'EX-5', '--title', 'x'], ['edit takes 1 argument'], 'edit with two codes (one ticket per call)');
    await offline([...V, 'move', 'EX-12', 'Done', '--title', 'x'], ['--title is only for edit'], 'move --title');
    await offline([...V, 'comment', 'EX-12', COMMENT, '--description', COMMENT], ['--description is only for edit'], 'comment --description');
    await offline([...V, 'move', 'EX-12', 'Done', '--code', 'EX-13'], ['--code is only for create'], 'move --code');
    await offline([...V, 'edit', 'EX-12', '--title', 'x', '--priority', 'HIGH'], ['--priority is only for create'], 'edit --priority');
    await offline([...V, 'create', 'x', DESC, '--priority', 'SOON'], ['--priority', 'LOW, MEDIUM, HIGH or URGENT'], 'create with an unknown priority');
    await offline([...V, 'create', 'x', DESC, '--code', 'EX12'], ['EX-<n>'], 'create --code without the dash');
    await offline([...V, 'create', 'x', DESC, '--code', 'SM-12'], ['EX-<n>'], "create --code with another project's code");
    await offline([...V, 'create', 'x', DESC, '--code', 'EX-12', '--code', 'EX-13'], ['--code given twice'], 'create --code twice');

    // A failed request: the status and the first 200 characters, non-zero, no retry; a failed --live write is logged too.
    state.writeStatus = 500;
    state.errBody = 'E'.repeat(200) + 'TAIL';
    const beforeFail = logLines().length;
    r = await run([...V, 'move', 'EX-12', 'Done', '--live']);
    refused(r, ['500', 'E'.repeat(200)], 'a write answered 500');
    check('a write answered 500: only the first 200 characters of the answer', !r.out.includes('TAIL'));
    check('a write answered 500: exactly one write request (no retry)', writes(r).length === 1);
    check('a write answered 500: logged with its status', logLines().length === beforeFail + 1 && / \| move \| EX-12 \| t12 \| before: "To Do" pos 0 \| after: "Done" pos 0 \| 500 FAILED$/.test(logLines()[beforeFail] || ''));
    state.writeStatus = 401;
    state.errBody = 'token rejected: ' + KEY;
    r = await run([...V, 'comment', 'EX-12', COMMENT2, '--live']); // (COMMENT is on the ticket by now, so a re-run of it would be skipped)
    refused(r, ['401', 'token rejected: [PMS_API_KEY]'], 'an answer that echoes the key');
    state.writeStatus = 0;
    state.getStatus = 403;
    state.errBody = 'forbidden here';
    r = await run([...V, 'board']);
    refused(r, ['403', 'forbidden here'], 'a GET answered 403');
    check('a GET answered 403: one request, no retry', r.reqs.length === 1);
    state.getStatus = 0;

    // M2: a 3xx answer is a failure and is never followed, so the write goes only to the path the dry run showed.
    state.writeRedirect = `${ELSEWHERE}/api/tasks/t12/move`;
    const before307 = logLines().length;
    r = await run([...V, 'move', 'EX-12', 'Done', '--live']);
    refused(r, ['307'], 'a write answered 307');
    check('a write answered 307: exactly one write request, to the PMS', writes(r).length === 1);
    check('a write answered 307: nothing reaches the redirect target', elsewhere.length === 0);
    check('a write answered 307: logged with 307 FAILED', logLines().length === before307 + 1 && / \| move \| EX-12 \| t12 \| before: "To Do" pos 0 \| after: "Done" pos 0 \| 307 FAILED$/.test(logLines()[before307] || ''));
    state.writeRedirect = '';

    // I3 + M1: a live write that went out always leaves its log line; when its outcome is unknown (the answer cut off after the headers, or
    // no answer at all) the line and the message say so instead of FAILED, the exit is non-zero, and nothing is retried.
    const UNKNOWN = 'outcome unknown: run show before any retry';
    state.writeCut = 'body';
    const beforeCut = logLines().length;
    r = await run([...V, 'move', 'EX-12', 'Done', '--live']);
    refused(r, [UNKNOWN, '200', 'answer cut off'], 'a write whose answer is cut off after the headers');
    check('a write whose answer is cut off: exactly one write request (no retry)', writes(r).length === 1);
    const cutLine = logLines()[beforeCut] || '';
    check(
      'a write whose answer is cut off: one log line with the real status 200, "answer cut off" and outcome unknown',
      logLines().length === beforeCut + 1 && / \| move \| EX-12 \| t12 \| before: "To Do" pos 0 \| after: "Done" pos 0 \| 200 \(answer cut off: [^)]+\); outcome unknown: run show before any retry$/.test(cutLine)
    );
    check('a write whose answer is cut off: no plain FAILED in the line or the output', !cutLine.includes('FAILED') && !/FAILED| failed: /.test(r.out));
    state.writeCut = 'drop';
    const beforeDrop = logLines().length;
    r = await run([...V, 'create', 'An answer that never came', DESC, '--live']);
    refused(r, [UNKNOWN, 'no response'], 'a write the PMS took without answering');
    check('a write the PMS took without answering: exactly one write request (no retry)', writes(r).length === 1);
    const dropLine = logLines()[beforeDrop] || '';
    check('a write the PMS took without answering: one log line, no response, outcome unknown', logLines().length === beforeDrop + 1 && / \| create \| EX-\d+ \| \? \| before: none \| column: "Backlog", text: new-ticket\.md \(\d+ chars\) \| no response \([^)]+\); outcome unknown: run show before any retry$/.test(dropLine));
    check('a write the PMS took without answering: no plain FAILED in the line or the output', !dropLine.includes('FAILED') && !/FAILED| failed: /.test(r.out));
    state.writeCut = '';

    // The key never shows: not in any output, not in the log; no output names the header.
    const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    check(`the key is in no output (${outputs.length} outputs) and not in the log`, outputs.length > 0 && outputs.every((o) => !o.includes(KEY)) && !logText.includes(KEY));
    check('no output names the Authorization header or a Bearer token', outputs.every((o) => !/authorization|bearer/i.test(o)));
  } catch (e) {
    check('the suite ran to the end (' + e.message + ')', false);
  } finally {
    server.close();
    other.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  check('the temp rig is removed', !fs.existsSync(tmp));
  if (failed) {
    console.error(`pms: ${failed} of ${total} checks failed`);
    process.exit(1);
  }
  console.log(`pms: all ${total} checks passed`);
})();
