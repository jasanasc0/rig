'use strict';
// Run: node <rig>/config.test.cjs   (exit 1 on any miss)
// The engine's own setup: example's settings files (with {{RIG}} filled in as new-project.ps1 does), mcp.json, work folder and profile,
// rig.ps1's launch, the worktree scripts and the .gitignore globs. This machine's real projects are projects.check.cjs's.
const fs = require('fs');
const path = require('path');
const { RIG_DIR, loadProfile } = require('./guard.cjs');

const RIG = __dirname;
const PLUGINS = [
  'superpowers@claude-plugins-official',
  'figma@claude-plugins-official',
  'frontend-design@claude-plugins-official',
  'ponytail@ponytail',
  'claude-md-management@claude-plugins-official',
  'code-simplifier@claude-plugins-official',
  'customerio@customerio',
  'i-have-adhd@i-have-adhd',
  'watch@claude-video',
];
const SEATS = {
  orchestrator: { guard: 'orchestrator', off: ['figma@claude-plugins-official', 'watch@claude-video'], on: [], rotation: true, ponytailOff: false },
  coder: { guard: 'coder', off: PLUGINS.filter((p) => p !== 'ponytail@ponytail'), on: ['ponytail@ponytail'], rotation: false, ponytailOff: false },
  angela: { guard: 'checker', off: PLUGINS, on: [], rotation: false, ponytailOff: true },
  oscar: { guard: 'checker', off: PLUGINS, on: [], rotation: false, ponytailOff: true },
  pam: { guard: 'pam', off: PLUGINS, on: [], rotation: false, ponytailOff: true }, // pam build: oscar's settings with its own guard seat
};

let total = 0;
let failed = 0;
function check(label, ok) {
  total++;
  if (!ok) {
    failed++;
    console.error('FAIL ' + label);
  }
}
const commands = (hooks, event, matcher) =>
  (hooks[event] || []).filter((m) => matcher === undefined || m.matcher === matcher).flatMap((m) => m.hooks.map((h) => h.command));

// v4: the project's five settings files, the same shape, each hook command naming its own project. The project is example, the template
// (its {{RIG}} filled in with the guard's RIG_DIR, as new-project.ps1 writes it); a real project's hooks are checked by projects.check.cjs.
const PROJECTS = ['example'];
for (const project of PROJECTS)
  for (const [seat, want] of Object.entries(SEATS)) {
    const tag = `${project} ${seat}`;
    const file = path.join(RIG, project, 'rules', `${seat}.settings.json`);
    let s;
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8').split('{{RIG}}').join(RIG_DIR));
    } catch (e) {
      check(`${tag}: settings file parses (${e.message})`, false);
      continue;
    }
    const hooks = s.hooks || {};
    check(`${tag}: guard runs on every tool as seat ${want.guard} and fails closed`, commands(hooks, 'PreToolUse', '*').includes(`node ${RIG_DIR}/guard.cjs --project ${project} --seat ${want.guard} || exit 2`));
    for (const m of ['startup', 'clear', 'compact'])
      check(`${tag}: refocus on ${m}`, commands(hooks, 'SessionStart', m).includes(`node ${RIG_DIR}/refocus.cjs --project ${project} --seat ${seat}`));
    // settingsrc build: each of those entries runs Refocus, then Refocus --claude-md as its own (second) hook, with its own project and seat,
    // so the CLAUDE.md's 9,000 characters never share a hook's output cap with Refocus's own. It prints nothing where projectSettings is true.
    for (const m of ['startup', 'clear', 'compact']) {
      const refocus = `node ${RIG_DIR}/refocus.cjs --project ${project} --seat ${seat}`;
      const entries = (hooks.SessionStart || []).filter((e) => e.matcher === m);
      check(
        `${tag}: on ${m}, Refocus then Refocus --claude-md, two hooks of one entry`,
        entries.length === 1 && JSON.stringify(entries[0].hooks) === JSON.stringify([{ type: 'command', command: refocus }, { type: 'command', command: refocus + ' --claude-md' }])
      );
    }
    check(`${tag}: rotation check ${want.rotation ? 'present' : 'absent'}`, commands(hooks, 'UserPromptSubmit').includes(`node ${RIG_DIR}/context-check.cjs --project ${project}`) === want.rotation);
    for (const p of want.off) check(`${tag}: ${p} off`, Boolean(s.enabledPlugins) && s.enabledPlugins[p] === false);
    for (const p of want.on) check(`${tag}: ${p} on`, Boolean(s.enabledPlugins) && s.enabledPlugins[p] === true);
    check(`${tag}: PONYTAIL_DEFAULT_MODE ${want.ponytailOff ? 'off' : 'not set'}`, ((s.env || {}).PONYTAIL_DEFAULT_MODE === 'off') === want.ponytailOff);
    // Field note 7a: GitNexus's MCP server needs more than the default 30 s to answer at start, in every lane.
    check(`${tag}: env MCP_TIMEOUT is "60000"`, (s.env || {}).MCP_TIMEOUT === '60000');
    // Field note 9: every lane reads its briefs (pam also its drafts) without asking; the guard still blocks every write there. The
    // orchestrator runs without permission prompts and has none.
    const dirs = seat === 'orchestrator' ? undefined : [`${RIG_DIR}/${project}/work/briefs`, ...(seat === 'pam' ? [`${RIG_DIR}/${project}/work/pms`] : [])];
    check(`${tag}: permissions.additionalDirectories ${dirs ? 'is ' + JSON.stringify(dirs) : 'absent'}`, JSON.stringify((s.permissions || {}).additionalDirectories) === JSON.stringify(dirs));
    const all = Object.values(hooks).flat().flatMap((m) => m.hooks.map((h) => h.command));
    for (const cmd of all) {
      const script = cmd.split(' ')[1];
      check(`${tag}: hook script exists (${script})`, fs.existsSync(script));
    }
    check(`${tag}: every hook command names --project ${project}, and no other project`, all.length > 0 && all.every((c) => c.includes(` --project ${project} `) || c.endsWith(` --project ${project}`)));
  }

for (const project of PROJECTS) {
  let mcp = {};
  try {
    mcp = JSON.parse(fs.readFileSync(path.join(RIG, project, 'rules', 'mcp.json'), 'utf8'));
  } catch {}
  check(`${project} mcp.json has GitNexus only`, JSON.stringify(Object.keys(mcp.mcpServers || {})) === '["gitnexus"]' && mcp.mcpServers.gitnexus.command === 'gitnexus');
}
// log.md and later.md grow below their header as each orchestrator works, so only the headers are compared (callpath build): the lines
// before the first entry (a dated log line or a "- " item), line ends as LF, blank lines at the end left out. A missing file has none.
const header = (file) => {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => /^(?:\d{4}-\d{2}-\d{2} |- )/.test(l));
  return lines.slice(0, first < 0 ? lines.length : first).join('\n').trimEnd();
};
const starter = (f) => {
  const h = header(path.join(RIG, 'example', 'work', f));
  return h !== null && h.startsWith('# ');
};
check(
  "example's work folder is a project's starting one (log and later: a # header above their entries; seat notes), with no inbox",
  ['log.md', 'later.md'].every(starter) &&
    ['coder', 'angela', 'oscar'].every((s) => fs.existsSync(path.join(RIG, 'example', 'work', 'notes', s + '.md'))) &&
    !fs.existsSync(path.join(RIG, 'example', 'work', 'inbox-log.md'))
);

const rigPs1 = fs.existsSync(path.join(RIG, 'rig.ps1')) ? fs.readFileSync(path.join(RIG, 'rig.ps1'), 'utf8') : '';
check(
  'rig.ps1 starts the orchestrator with its flags',
  rigPs1.includes('claude --dangerously-skip-permissions --model opus --effort high -n $lane --settings "$rig\\$Project\\rules\\orchestrator.settings.json" --append-system-prompt-file "$rig\\$Project\\rules\\orchestrator.md"')
);
// settingsrc build: the launch follows the profile's projectSettings. true: the line above, byte for byte as in 3d78192, in its own
// branch; false (example's): the same line with --setting-sources user,local and the rig's mcp.json (GitNexus, which the repo's own settings
// would have enabled) directly after -n $lane. Exactly these two claude lines.
{
  const ps1 = rigPs1.replace(/\r\n/g, '\n');
  const launch = 'claude --dangerously-skip-permissions --model opus --effort high -n $lane --settings "$rig\\$Project\\rules\\orchestrator.settings.json" --append-system-prompt-file "$rig\\$Project\\rules\\orchestrator.md"';
  const launchOff = launch.replace('-n $lane ', '-n $lane --setting-sources user,local --mcp-config "$rig\\$Project\\rules\\mcp.json" ');
  check(
    'settingsrc rig.ps1: projectSettings true launches the 3d78192 line unchanged; otherwise the line with --setting-sources user,local and the rig mcp.json after -n $lane',
    ps1.includes(`\nif ($p.projectSettings -eq $true) {\n  ${launch}\n} else {\n  ${launchOff}\n}\n`) && ps1.split('claude --dangerously-skip-permissions').length === 3 && ps1.split('\nclaude ').length === 1
  );
}
// v4: the project is a parameter: any rig folder with a profile (no fixed list), checked by the guard first, started in its root as its
// orchestrator lane.
check('rig.ps1 takes any project with a profile, no fixed list', /param\(\[Parameter\(Mandatory = \$true\)\]\[string\]\$Project\)/.test(rigPs1) && !/ValidateSet/.test(rigPs1));
check('rig.ps1 asks the guard about the profile, then starts in its root as lanes.orchestrator', rigPs1.includes('--project $Project --seat orchestrator') && rigPs1.includes('Set-Location -LiteralPath $p.root') && rigPs1.includes('$lane = $p.lanes.orchestrator'));
check('rig.ps1 starts no project in a fixed folder (no quoted Set-Location path)', rigPs1 !== '' && !/Set-Location (?:-LiteralPath )?['"]/.test(rigPs1));
const rulesCheck = rigPs1.indexOf('foreach ($f in "$rig\\$Project\\rules\\orchestrator.settings.json", "$rig\\$Project\\rules\\orchestrator.md")');
check("rig.ps1 checks the project's orchestrator settings and role file exist before it starts claude", rulesCheck > -1 && rigPs1.includes('Test-Path -LiteralPath $f -PathType Leaf') && rulesCheck < rigPs1.indexOf('claude --dangerously-skip-permissions'));
// v4: the worktree scripts read the project from the name's prefix, through the profiles next to them.
for (const script of ['wt-new.ps1', 'wt-remove.ps1']) {
  const text = fs.existsSync(path.join(RIG, script)) ? fs.readFileSync(path.join(RIG, script), 'utf8') : '';
  check(`${script} finds the project by ticketPrefix and has no machine path`, text.includes('$rig = $PSScriptRoot') && text.includes('ticketPrefix') && !/[a-z]:\\users\\/i.test(text));
}
// Runs anywhere: the engine's code holds no machine path. Each script finds the rig as the folder it is in (__dirname, $PSScriptRoot) and
// the home folder from os.homedir() or $HOME; a path under some C:\Users\<name> in the code would be one machine's.
const ENGINE_CODE = ['guard.cjs', 'pms.cjs', 'report.cjs', 'refocus.cjs', 'context-check.cjs', 'projects.check.cjs', 'content-gate.cjs', 'rig.ps1', 'close.ps1', 'wt-new.ps1', 'wt-remove.ps1', 'statusline.ps1', 'new-project.ps1'];
const machinePaths = ENGINE_CODE.filter((f) => !fs.existsSync(path.join(RIG, f)) || /[a-z]:[\\/]+users[\\/]/i.test(fs.readFileSync(path.join(RIG, f), 'utf8')));
check(`no engine script holds a machine path (C:\\Users\\<name>) or is missing${machinePaths.length ? ' (' + machinePaths.join(', ') + ')' : ''}`, machinePaths.length === 0);
for (const script of ['rig.ps1', 'close.ps1'])
  check(`${script} finds the rig as its own folder ($PSScriptRoot)`, (fs.existsSync(path.join(RIG, script)) ? fs.readFileSync(path.join(RIG, script), 'utf8') : '').includes('$rig = $PSScriptRoot'));

// example's profile, through the guard's validator (loadProfile, the one the scripts rely on): it loads, it names its pam lane (pam build),
// and its projectSettings is false, the template's default (settingsrc build: every rig session of the project starts with
// --setting-sources user,local, so the repo's own .claude/settings.json and its hooks never load).
const exampleProfile = (() => {
  try {
    return loadProfile('example');
  } catch (e) {
    return e.message;
  }
})();
const exampleJson = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(RIG, 'example', 'profile.json'), 'utf8'));
  } catch {
    return null;
  }
})();
check(`example's profile loads through the guard's validator${typeof exampleProfile === 'string' ? ' (' + exampleProfile + ')' : ''}`, typeof exampleProfile === 'object' && exampleProfile.name === 'example');
check('pam build: example names its pam lane, ex-pam', Boolean(exampleJson && exampleJson.lanes) && exampleJson.lanes.pam === 'ex-pam');
check('settingsrc: example has projectSettings false', Boolean(exampleJson) && exampleJson.projectSettings === false);

// V4-R5: lane names (every value of every profile's lanes), ticket prefixes and roots are unique across every <rig>/*/profile.json, and no
// root is inside another. A clash would let two orchestrators drive one lane, give one worktree name to two projects, or make one folder
// two projects' checkout. projects.check.cjs checks this machine's projects; here it runs on copies in a temp rig holding made-up profiles.
{
  const { spawnSync } = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-clash-'));
  const fakeLanes = (n) => ({ orchestrator: `${n}-o`, coder: `${n}-c`, angela: `${n}-a`, oscar: `${n}-x` });
  // One temp rig holding these profiles (folders p0, p1, ...); the output of its projects.check.cjs.
  const clashRun = (rig, profiles) => {
    fs.mkdirSync(rig);
    for (const f of ['guard.cjs', 'projects.check.cjs']) fs.copyFileSync(path.join(RIG, f), path.join(rig, f));
    profiles.forEach((p, i) => {
      fs.mkdirSync(path.join(rig, 'p' + i));
      fs.writeFileSync(path.join(rig, 'p' + i, 'profile.json'), JSON.stringify(p));
    });
    const r = spawnSync(process.execPath, [path.join(rig, 'projects.check.cjs')], { encoding: 'utf8' });
    return (r.stdout || '') + (r.stderr || '');
  };
  try {
    const caught = clashRun(path.join(tmp, 'a'), [
      { lanes: fakeLanes('a'), ticketPrefix: 'aa', root: 'C:/p/a' },
      { lanes: { ...fakeLanes('b'), coder: 'a-c' }, ticketPrefix: 'aa', root: 'C:\\p\\a\\sub' },
      { lanes: fakeLanes('c'), ticketPrefix: 'cc', root: 'c:/P/A/' },
    ]);
    const line = caught.split(/\r?\n/).find((l) => l.startsWith('FAIL lane names, ticket prefixes and roots')) || '';
    const clean = clashRun(path.join(tmp, 'b'), [
      { lanes: fakeLanes('a'), ticketPrefix: 'aa', root: 'C:/p/a' },
      { lanes: fakeLanes('b'), ticketPrefix: 'bb', root: 'C:/p/ab' },
    ]);
    check(
      'V4-R5: the clash check catches a reused lane, a reused prefix, the same root spelled another way and a root inside another',
      ['lane a-c', 'ticketPrefix aa', 'root c:/p/a', 'root c:/p/a/sub is inside c:/p/a'].every((c) => line.includes(c)) && /^ok lane names, ticket prefixes and roots/m.test(clean)
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// v3 (M8/T1-M3): the rig .gitignore keeps Jas's inbox notes and Obsidian state out of rig history
const rigIgnore = fs.existsSync(path.join(RIG, '.gitignore')) ? fs.readFileSync(path.join(RIG, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()) : [];
check('.gitignore ignores the inbox and the work vault state', rigIgnore.includes('*/work/inbox/') && rigIgnore.includes('*/work/.obsidian/'));
check(
  ".gitignore keeps every project's working state out (globs, v4; pam build: pms.cjs edit undo files), with no line for one project's folder",
  ['*/work/now.md', '*/active-worktree', '*/work/briefs/', '*/work/pms/', '*/work/pms-undo/'].every((l) => rigIgnore.includes(l)) && !rigIgnore.some((l) => /^[a-z0-9][a-z0-9-]*\//.test(l))
);

// M4: the wt scripts read ticketPrefix on their own, so it is matched as text. A prefix "c+" must not match the name c12-x (as a regex it would);
// a plain prefix "c" must (the control: the script then goes on and stops at git, in a root that does not exist).
{
  const { spawnSync } = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-wtprefix-'));
  try {
    for (const script of ['wt-new.ps1', 'wt-remove.ps1']) {
      fs.copyFileSync(path.join(RIG, script), path.join(tmp, script));
      for (const [prefix, matches] of [['c+', false], ['c', true]]) {
        fs.mkdirSync(path.join(tmp, 'p'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'p', 'profile.json'), JSON.stringify({ ticketPrefix: prefix, root: path.join(tmp, 'no-such-root'), defaultBranch: 'main', worktreeCopy: [], nodeModulesJunction: false }));
        const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tmp, script), 'c12-x'], { encoding: 'utf8' });
        const out = (r.stdout || '') + (r.stderr || '');
        check(`M4: ${script} with prefix "${prefix}" ${matches ? 'finds' : 'does not find'} the project for c12-x`, r.status !== 0 && out.includes('No single project') === !matches);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// pam build, field notes 4 and 6: wt-new.ps1 <name> -Resume (no git change: a registered worktree of the root on worktree-<name>, then
// active-worktree), and no node_modules junction when the branch's package-lock.json differs from the root checkout's HEAD's (what main's
// node_modules was installed from; review-pam M3). Run on a copy of
// wt-new.ps1 in a temp rig whose one profile points at a throwaway repo with a local bare origin, all in %TEMP%: no network, no real repo.
{
  const { spawnSync } = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-wtresume-'));
  const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=rig-test', '-c', 'user.email=rig-test@localhost', ...args], { cwd, encoding: 'utf8' });
  const wtNew = (...args) => {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tmp, 'rig', 'wt-new.ps1'), ...args], { encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(none)');
  const isJunction = (p) => {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const lock = (dir, v) => fs.writeFileSync(path.join(dir, 'package-lock.json'), `{ "lockfileVersion": 3, "v": ${v} }\n`);
  try {
    const origin = path.join(tmp, 'origin.git');
    const root = path.join(tmp, 'root');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'init', '-q', '-b', 'main', root);
    git(root, 'remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.claude/\n');
    lock(root, 1);
    git(root, 'add', '.gitignore', 'package-lock.json');
    git(root, 'commit', '-q', '-m', 'one');
    git(root, 'push', '-q', 'origin', 'main');
    const one = git(root, 'rev-parse', 'HEAD').stdout.trim();
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(tmp, 'rig', 't'), { recursive: true });
    fs.copyFileSync(path.join(RIG, 'wt-new.ps1'), path.join(tmp, 'rig', 'wt-new.ps1'));
    fs.writeFileSync(path.join(tmp, 'rig', 't', 'profile.json'), JSON.stringify({ ticketPrefix: 't', root, defaultBranch: 'main', worktreeCopy: [], nodeModulesJunction: true }));
    const active = path.join(tmp, 'rig', 't', 'active-worktree');
    const wtPath = (n) => path.join(root, '.claude', 'worktrees', n);
    const state = () => git(root, 'for-each-ref').stdout + git(root, 'worktree', 'list', '--porcelain').stdout;

    let r = wtNew('t1-x');
    check('wt-new t1-x (lockfiles equal): worktree made, node_modules a junction, active-worktree set, no npm ci line', r.status === 0 && isJunction(path.join(wtPath('t1-x'), 'node_modules')) && read(active) === wtPath('t1-x') && !r.out.includes('npm ci'));
    fs.writeFileSync(active, '');
    let before = state();
    r = wtNew('t1-x', '-Resume');
    check('wt-new t1-x -Resume: exit 0, active-worktree set, prints the worktree and its branch', r.status === 0 && read(active) === wtPath('t1-x') && r.out.includes(`worktree=${wtPath('t1-x')}`) && r.out.includes('branch=worktree-t1-x'));
    check('wt-new -Resume changes nothing in git (refs and worktrees the same)', state() === before);
    fs.writeFileSync(active, 'unchanged');
    r = wtNew('t2-y', '-Resume');
    check('wt-new -Resume of a name with no worktree refuses and leaves active-worktree alone', r.status !== 0 && r.out.includes('not a registered worktree') && read(active) === 'unchanged');
    fs.mkdirSync(wtPath('t5-z'), { recursive: true });
    r = wtNew('t5-z', '-Resume');
    check('wt-new -Resume of a folder that git does not know as a worktree refuses', r.status !== 0 && r.out.includes('not a registered worktree') && read(active) === 'unchanged');
    git(root, 'worktree', 'add', '-q', '-b', 'other', wtPath('t3-z'), 'main');
    before = state();
    r = wtNew('t3-z', '-Resume');
    check('wt-new -Resume of a worktree on another branch refuses (names it), git unchanged, active-worktree alone', r.status !== 0 && r.out.includes('other') && r.out.includes('worktree-t3-z') && state() === before && read(active) === 'unchanged');
    // The coder's branch takes a lockfile of its own (a dependency change Jas approved): -Resume keeps the junction, but says npm ci is
    // needed and the junction has to go first; it never removes it.
    lock(wtPath('t1-x'), 2);
    git(wtPath('t1-x'), 'commit', '-q', '-am', 'deps');
    r = wtNew('t1-x', '-Resume');
    check('wt-new -Resume with a lockfile that differs and a junction: exit 0, the npm ci line, remove the junction first, the junction kept', r.status === 0 && r.out.includes('differs') && r.out.includes(`npm ci in ${wtPath('t1-x')}`) && r.out.includes('removes that junction first') && isJunction(path.join(wtPath('t1-x'), 'node_modules')) && read(active) === wtPath('t1-x'));
    // review-pam M3: the lockfile is compared with the root's HEAD (what main's node_modules was installed from), not with the local default
    // branch. The root sits on a branch level with origin/main (lockfile 3, so the stale-install check passes) while the local main stays one
    // commit behind (lockfile 1): a new worktree from origin/main gets the junction and no npm ci line.
    lock(root, 3);
    git(root, 'commit', '-q', '-am', 'two');
    git(root, 'push', '-q', 'origin', 'main');
    git(root, 'checkout', '-q', '-b', 'dev');
    git(root, 'branch', '-f', 'main', one);
    const npmLines = (out) => (out.match(/Jas runs npm ci/g) || []).length;
    r = wtNew('t4-w');
    check("wt-new t4-w with the root's HEAD lockfile (the local main's differs): exit 0, a node_modules junction, no npm ci line, active-worktree set (review-pam M3)", r.status === 0 && isJunction(path.join(wtPath('t4-w'), 'node_modules')) && npmLines(r.out) === 0 && read(active) === wtPath('t4-w'));
    r = wtNew('t4-w', '-Resume');
    check("wt-new -Resume with the root's HEAD lockfile and a junction: exit 0, no npm ci line", r.status === 0 && npmLines(r.out) === 0 && read(active) === wtPath('t4-w'));
    // A worktree whose branch has a lockfile unlike the root's HEAD and no node_modules: -Resume prints the npm ci line once, nothing about a junction.
    git(root, 'worktree', 'add', '-q', '-b', 'worktree-t6-v', wtPath('t6-v'), one);
    r = wtNew('t6-v', '-Resume');
    check("wt-new -Resume with a lockfile unlike the root's HEAD and no node_modules: the npm ci line once, nothing about a junction", r.status === 0 && r.out.includes('differs') && r.out.includes(`npm ci in ${wtPath('t6-v')}`) && npmLines(r.out) === 1 && !r.out.includes('removes that junction first') && !r.out.includes('has no node_modules'));
    // review-pam M4: the root's HEAD lockfile but no node_modules at all (a junction Jas removed earlier, no npm ci since): -Resume says so in
    // one line instead of leaving the coder's first test run to fail. It still makes no junction.
    git(root, 'worktree', 'add', '-q', '-b', 'worktree-t7-u', wtPath('t7-u'), 'HEAD');
    r = wtNew('t7-u', '-Resume');
    check('wt-new -Resume with the same lockfile and no node_modules: one line telling Jas to run npm ci there, no junction made (review-pam M4)', r.status === 0 && r.out.includes(`${wtPath('t7-u')} has no node_modules`) && r.out.includes(`npm ci in ${wtPath('t7-u')}`) && npmLines(r.out) === 1 && !r.out.includes('differs') && !fs.existsSync(path.join(wtPath('t7-u'), 'node_modules')) && read(active) === wtPath('t7-u'));
  } catch (e) {
    check('the wt-new -Resume checks ran to the end (' + e.message + ')', false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  check('the wt-new -Resume temp folder is removed', !fs.existsSync(tmp));
}

if (failed) {
  console.error(`config: ${failed} of ${total} checks failed`);
  process.exit(1);
}
console.log(`config: all ${total} checks passed`);
