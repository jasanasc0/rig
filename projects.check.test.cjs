'use strict';
// Run: node <rig>/projects.check.test.cjs   (exit 1 on any FAIL)
// Tests projects.check.cjs, with projects made by new-project.ps1, on temp copies of the rig (guard.cjs, refocus.cjs, context-check.cjs,
// projects.check.cjs, new-project.ps1 and example/) and temp roots. It never reads or writes this rig's own project folders.
// shortcut: a TEMP path with a space makes new-project.ps1 refuse every project here (it refuses a rig path with a space); set TEMP to a
// folder without one to run this suite on such a machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = ['guard.cjs', 'refocus.cjs', 'context-check.cjs', 'projects.check.cjs', 'new-project.ps1', '.gitignore', 'example'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-check-'));
let rigs = 0;
const tempRig = () => {
  const dir = path.join(TMP, 'rig' + ++rigs);
  for (const f of ENGINE) fs.cpSync(path.join(__dirname, f), path.join(dir, f), { recursive: true });
  return dir;
};
const tempRoot = () => {
  const dir = path.join(TMP, 'root' + ++rigs);
  fs.mkdirSync(dir);
  return dir;
};
const check = (rig, ...names) => {
  const r = spawnSync(process.execPath, [path.join(rig, 'projects.check.cjs'), ...names], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const newProject = (rig, name, prefix) => {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(rig, 'new-project.ps1'), '-Name', name, '-Root', tempRoot(), '-Prefix', prefix], {
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
// A temp rig with one project per [name, prefix], each made by new-project.ps1 (which fails the test if it refuses).
const rigWith = (...projects) => {
  const rig = tempRig();
  for (const [name, prefix] of projects) {
    const r = newProject(rig, name, prefix);
    if (r.code !== 0) throw new Error(`new-project.ps1 ${name} ${prefix} exited ${r.code}:\n${r.out}`);
  }
  return rig;
};
const edit = (file, change) => fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));

let total = 0;
let failed = 0;
// Each test returns [ok, detail]; one that throws fails with its message, and the others still run.
function test(label, fn) {
  total++;
  let ok = false;
  let detail = '';
  try {
    [ok, detail] = fn();
  } catch (e) {
    detail = e.message;
  }
  if (ok) console.log('ok   ' + label);
  else {
    failed++;
    console.log('FAIL ' + label + (detail ? '\n  ' + String(detail).trim().replace(/\n/g, '\n  ') : ''));
  }
}

test('none besides example -> "projects: none besides example", exit 0', () => {
  const r = check(tempRig());
  return [r.code === 0 && r.out.trim() === 'projects: none besides example', r.out];
});

test('a project made by new-project passes', () => {
  const rig = tempRig();
  // Started through a lower-cased path: the rig folder it writes must still be the guard's RIG_DIR, in its case on disk.
  const made = newProject(rig.toLowerCase(), 'alpha', 'al');
  const r = check(rig);
  return [made.code === 0 && r.code === 0 && /^projects: 1 checked$/m.test(r.out) && /^ok /m.test(r.out) && !/^FAIL/m.test(r.out), made.out + '\n' + r.out];
});

test("its lane start lines match the guard's for its profile (RIG_DIR's case on disk, though new-project.ps1 ran through a lower-cased path)", () => {
  const rig = tempRig();
  const made = newProject(rig.toLowerCase(), 'alpha', 'al');
  const { loadProfile, RIG_DIR } = require(path.join(rig, 'guard.cjs'));
  const P = loadProfile('alpha');
  const starts = fs
    .readFileSync(path.join(rig, 'alpha', 'rules', 'orchestrator.md'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('herdr agent start '))
    .map((l) => l.replace(/<[a-z]+-pane>/, 'w1:p2'));
  const unmatched = starts.filter((l) => !P.laneStartRe.some((re) => re.test(l)));
  return [made.code === 0 && rig.toLowerCase() !== RIG_DIR.replace(/\//g, '\\') && starts.length === 4 && unmatched.length === 0, `${made.out}\n${starts.length} start lines; unmatched: ${unmatched.join(' | ')}`];
});

test('two projects with the same prefix fail', () => {
  const rig = rigWith(['alpha', 'al'], ['beta', 'be']);
  edit(path.join(rig, 'beta', 'profile.json'), (t) => t.replace('"ticketPrefix": "be"', '"ticketPrefix": "al"'));
  const r = check(rig);
  return [r.code === 1 && /^FAIL lane names, ticket prefixes and roots .*ticketPrefix al\b/m.test(r.out) && /^projects: 2 checked$/m.test(r.out), r.out];
});

test('new-project removes a project that fails its check (the same prefix as another) and exits 1', () => {
  const rig = rigWith(['alpha', 'al']);
  const second = newProject(rig, 'beta', 'al'); // new-project.ps1 writes it, then its own projects.check run fails
  return [
    second.code === 1 && /^FAIL lane names, ticket prefixes and roots .*ticketPrefix al\b/m.test(second.out) && / was removed; .*nothing written$/m.test(second.out) && !fs.existsSync(path.join(rig, 'beta')) && check(rig).code === 0,
    second.out,
  ];
});

test("a project with the prefix ex fails (example's: wt-new.ps1 and wt-remove.ps1 find a project by its prefix, example included)", () => {
  const rig = rigWith(['alpha', 'al']);
  edit(path.join(rig, 'alpha', 'profile.json'), (t) => t.replace('"ticketPrefix": "al"', '"ticketPrefix": "ex"'));
  const r = check(rig);
  return [r.code === 1 && /^FAIL lane names, ticket prefixes and roots .*ticketPrefix ex\b/m.test(r.out), r.out];
});

test("example's knowledgeDirs stay out of the knowledgeDirs check (they are the template's)", () => {
  const rig = rigWith(['alpha', 'al']);
  edit(path.join(rig, 'example', 'profile.json'), (t) => t.replace('"knowledgeDirs": [".agent", "docs"]', '"knowledgeDirs": [".agent", "docs", "notes"]'));
  const r = check(rig);
  return [r.code === 0 && /^ok every profile's knowledgeDirs/m.test(r.out) && fs.readFileSync(path.join(rig, 'example', 'profile.json'), 'utf8').includes('"notes"'), r.out];
});

test('a settings hook naming another project fails', () => {
  const rig = rigWith(['alpha', 'al'], ['beta', 'be']);
  edit(path.join(rig, 'alpha', 'rules', 'coder.settings.json'), (t) => t.replace('--project alpha --seat coder', '--project beta --seat coder'));
  const r = check(rig);
  return [r.code === 1 && /^FAIL alpha: every settings file's guard hook .*coder: /m.test(r.out) && /^ok beta: every settings file's guard hook/m.test(r.out), r.out];
});

// Every hook that runs a rig script, of any event: this rig's copy, this project, and the script there. One FAIL line per wrong hook.
test("a hook pointing at another rig folder fails (the orchestrator's rotation check: UserPromptSubmit, not only PreToolUse)", () => {
  const rig = rigWith(['alpha', 'al']);
  edit(path.join(rig, 'alpha', 'rules', 'orchestrator.settings.json'), (t) => t.replace(/node [^"]*\/context-check\.cjs/, 'node C:/old-rig/context-check.cjs'));
  const r = check(rig);
  const lines = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL '));
  return [
    r.code === 1 && lines.length === 1 && /^FAIL alpha: orchestrator\.settings\.json UserPromptSubmit hook "node C:\/old-rig\/context-check\.cjs --project alpha": it does not start with node \S+\/$/.test(lines[0]),
    r.out,
  ];
});

test('a hook naming another project fails (--project is a whole word: alpha-2 is not alpha)', () => {
  const rig = rigWith(['alpha', 'al'], ['alpha-2', 'ab']);
  edit(path.join(rig, 'alpha', 'rules', 'angela.settings.json'), (t) => t.replace('refocus.cjs --project alpha --seat angela"', 'refocus.cjs --project alpha-2 --seat angela"'));
  const r = check(rig);
  const lines = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL '));
  // The line shows the command's start only (90 characters), and this temp rig's path is long.
  return [r.code === 1 && lines.length === 1 && /^FAIL alpha: angela\.settings\.json SessionStart hook "node \S+\/refocus\.cjs [^"]*": it does not name --project alpha$/.test(lines[0]), r.out];
});

test('a missing hook script fails (context-check.cjs gone: the orchestrator rotation hook names it)', () => {
  const rig = rigWith(['alpha', 'al']);
  fs.rmSync(path.join(rig, 'context-check.cjs'));
  const r = check(rig);
  const lines = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL '));
  return [r.code === 1 && lines.length === 1 && /^FAIL alpha: orchestrator\.settings\.json UserPromptSubmit hook "node \S+\/context-check\.cjs [^"]*": \S+\/context-check\.cjs is missing$/.test(lines[0]), r.out];
});

test("a profile missing the other project's knowledge folder fails", () => {
  const rig = rigWith(['alpha', 'al'], ['beta', 'be']);
  edit(path.join(rig, 'beta', 'profile.json'), (t) => t.replace('"knowledgeDirs": [".agent", "docs"]', '"knowledgeDirs": [".agent", "docs", "notes"]'));
  const named = check(rig, 'alpha'); // naming one project still compares it with every other project here
  const all = check(rig);
  const missing = /^FAIL every profile's knowledgeDirs names every project's knowledge folders: alpha lacks notes$/m;
  return [named.code === 1 && missing.test(named.out) && all.code === 1 && missing.test(all.out), named.out + '\n' + all.out];
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `projects.check.test: ${failed} of ${total} tests failed` : `projects.check.test: all ${total} tests passed`);
process.exit(failed ? 1 : 0);
