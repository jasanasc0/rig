'use strict';
// Run: node <rig>/projects.check.cjs [<name>...]   (exit 1 on any FAIL)
// Checks this machine's real projects, the <rig>/<name>/ folders next to example/ that new-project.ps1 makes (git ignores them, so the
// engine suites, which test example only, never see them). Each named project, or with no name every project folder but example:
// its profile loads, each settings file's guard hook names this rig, the project and the seat, and every hook of any event that runs a
// rig script (guard, Refocus, the rotation check) runs this rig's copy, which is there, for this project. Across the named projects and every
// other project here: no two share a lane name, a ticket prefix or a root (nor is one root inside another), example included, and
// every profile's knowledgeDirs names every project's knowledge folders, so each project's lanes keep their hands off the others'.
// node <rig>/projects.check.cjs --rig-dir prints the rig folder as the guard writes it (RIG_DIR), for new-project.ps1's {{RIG}}.
const fs = require('fs');
const path = require('path');
const { loadProfile, RIG_DIR } = require('./guard.cjs');

if (process.argv[2] === '--rig-dir') {
  console.log(RIG_DIR);
  process.exit(0);
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').trimStart()); // trimStart drops a BOM too (a file PowerShell 5.1 wrote)
  } catch {
    return null;
  }
};
const here = fs
  .readdirSync(__dirname, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'example' && fs.existsSync(path.join(__dirname, d.name, 'profile.json')))
  .map((d) => d.name);
const named = process.argv.slice(2);
const checked = named.length ? named : here;
if (!checked.length) {
  console.log('projects: none besides example');
  process.exit(0);
}

let failed = 0;
const report = (label, problems) => {
  if (problems.length) failed++;
  console.log(problems.length ? `FAIL ${label}: ${problems.join('; ')}` : `ok ${label}`);
};

// 1. Each checked project: its profile, then its settings files' guard hooks (the seat the guard takes for each settings file), then
// every hook that runs a rig script. A settings file still naming an old rig folder, another project or a script that is gone would
// run that copy, or nothing, unnoticed: each such hook is its own FAIL line.
const GUARD_SEAT = { orchestrator: 'orchestrator', coder: 'coder', angela: 'checker', oscar: 'checker', pam: 'pam' };
const HOOK_SCRIPTS = ['guard.cjs', 'refocus.cjs', 'context-check.cjs']; // the rig scripts a settings file's hooks run
const loaded = [];
for (const name of checked) {
  try {
    loadProfile(name);
  } catch (e) {
    report(`${name}: the profile loads`, [e.message]);
    continue; // a bad name or profile: nothing else of it is read
  }
  loaded.push(name);
  report(`${name}: the profile loads`, []);
  const settings = Object.keys(GUARD_SEAT).map((file) => [file, readJson(path.join(__dirname, name, 'rules', file + '.settings.json'))]);
  const problems = settings.flatMap(([file, s]) => {
    if (s === null) return [`${file}.settings.json is missing or not JSON`];
    const want = `node ${RIG_DIR}/guard.cjs --project ${name} --seat ${GUARD_SEAT[file]} || exit 2`;
    const pre = ((s.hooks || {}).PreToolUse || []).flatMap((m) => (m.hooks || []).map((h) => [m.matcher, h.command]));
    return pre.length === 1 && pre[0][0] === '*' && pre[0][1] === want ? [] : [`${file}: ${JSON.stringify(pre)}`];
  });
  report(`${name}: every settings file's guard hook is node ${RIG_DIR}/guard.cjs --project ${name} --seat <seat> || exit 2`, problems);
  // A hook runs a rig script when its command is node <script> and the script is under RIG_DIR or is one of HOOK_SCRIPTS anywhere.
  // (name passed loadProfile, so it is letters, digits and - only: safe in the pattern as it is.)
  const hooks = settings.flatMap(([file, s]) =>
    Object.entries((s && s.hooks) || {}).flatMap(([event, entries]) => (Array.isArray(entries) ? entries : []).flatMap((m) => ((m && m.hooks) || []).map((h) => [file, event, String(h.command || '')])))
  );
  let wrong = 0;
  for (const [file, event, cmd] of hooks) {
    const [exe, script = ''] = cmd.trim().split(/\s+/);
    const base = path.posix.basename(script.replace(/\\/g, '/'));
    const ours = script.startsWith(RIG_DIR + '/');
    if (exe !== 'node' || !(ours || HOOK_SCRIPTS.includes(base))) continue;
    const why = [];
    if (!cmd.startsWith(`node ${RIG_DIR}/`)) why.push(`it does not start with node ${RIG_DIR}/`);
    if (!new RegExp(`(?:^|\\s)--project\\s+${name}(?=\\s|$)`).test(cmd)) why.push(`it does not name --project ${name}`);
    const target = ours ? script : `${RIG_DIR}/${base}`;
    if (!fs.existsSync(target)) why.push(`${target} is missing`);
    if (why.length) {
      wrong++;
      report(`${name}: ${file}.settings.json ${event} hook "${cmd.length > 90 ? cmd.slice(0, 90) + '...' : cmd}"`, why);
    }
  }
  if (!wrong) report(`${name}: every hook that runs a rig script runs node ${RIG_DIR}/<script> for --project ${name}, and the script is there`, []);
}

// 2. Across projects: the named ones that loaded and every project folder here. A clash would let two orchestrators drive one lane, give
// one worktree name to two projects, or make one folder two projects' checkout. A profile.json that doesn't parse is left out here (its
// own check above fails). example's lanes, prefix and root count too: wt-new.ps1 and wt-remove.ps1 find a project by its ticket prefix
// among every rig folder with a profile.json, example included. Its knowledgeDirs are the template's, not a project's, so check 3 skips it.
const withProfile = (names) => names.map((name) => [name, readJson(path.join(__dirname, name, 'profile.json'))]).filter(([, p]) => p && typeof p === 'object');
const profiles = withProfile([...new Set([...loaded, ...here])].filter((name) => name !== 'example'));
const clashInputs = [...profiles, ...withProfile(['example'])];
const clashes = [];
const unique = (what, values) => {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) clashes.push(`${what} ${v}`);
    seen.add(v);
  }
};
unique('lane', clashInputs.flatMap(([, p]) => Object.values(p.lanes || {})));
unique('ticketPrefix', clashInputs.map(([, p]) => p.ticketPrefix));
const roots = clashInputs.map(([, p]) => String(p.root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
unique('root', roots);
for (const a of roots) for (const b of roots) if (b.startsWith(a + '/')) clashes.push(`root ${b} is inside ${a}`);
report("lane names, ticket prefixes and roots are unique across projects and example's, and no root is inside another", clashes);

const lists = profiles.map(([name, p]) => [name, Array.isArray(p.knowledgeDirs) ? p.knowledgeDirs : []]);
const allDirs = [...new Set(lists.flatMap(([, l]) => l))];
report(
  "every profile's knowledgeDirs names every project's knowledge folders",
  lists.flatMap(([name, l]) => {
    const lacks = allDirs.filter((d) => !l.includes(d));
    return lacks.length ? [`${name} lacks ${lacks.join(', ')}`] : [];
  })
);

console.log(`projects: ${checked.length} checked`);
process.exit(failed ? 1 : 0);
