#!/usr/bin/env node
'use strict';
// Rig guard: PreToolUse hook that blocks the tool calls the rig README's "Safety rules" forbid.
// Settings entry: node <rig>/guard.cjs --project <name> --seat <orchestrator|coder|checker|pam> || exit 2
// Exit 0 allows the call. Exit 2 blocks it, and stderr goes back to the model. The `|| exit 2` makes a missing or crashed
// guard block too: without it the shell's exit 127 or 1 is an error Claude Code carries on past.
// Jas's core scope (<rig>/<project>/core-scope.json, the core-scope build) opens the core paths it lists to the coder's Edit and Write in one
// ticket's worktree; without the file the core rule blocks every seat's edit, as before.
const fs = require('fs');
const os = require('os');
const path = require('path');

// This machine's values: its home folder, and the rig, the folder that holds this file. HOME and RIG are as norm() writes paths (norm
// itself reads HOME); RIG_DIR keeps the folder's case as on disk, as the settings and lane start commands write it. Everything that
// differs per project comes from <rig>/<project>/profile.json (loadProfile below).
const HOME = path.posix.normalize(os.homedir().replace(/\\/g, '/')).toLowerCase().replace(/\/+$/, '');
const RIG_DIR = fs.realpathSync.native(__dirname).replace(/\\/g, '/');
const RIG = norm(RIG_DIR);
const SHARED_TEMP = HOME + '/appdata/local/temp/claude/'; // Claude's scratchpad, writable for every orchestrator
// pam (pam build): the PMS writer on herdr tab 2, with the checker's limits plus one runnable file, the rig's pms.cjs (README, Safety rules).
const SEATS = ['orchestrator', 'coder', 'checker', 'pam'];
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// Obsidian CLI subcommands the orchestrator may run: read-only ones only. Workers get none.
const OBSIDIAN_READ = new Set(['help', 'search', 'search:context', 'backlinks', 'links', 'unresolved', 'orphans', 'deadends', 'properties', 'property:read', 'files', 'tags', 'tasks', 'base:query', 'read']);
// The herdr groups and subcommands the orchestrator may run (README, Safety rules). `agent prompt` has to name one of its project's lanes
// and `agent start` has to be one of its project's lane start commands (loadProfile); everything else, and every option in front of the
// group, is blocked. `tab create` (pam build) opens the second tab for the tab-2 seats, in the orchestrator's own project root only.
const HERDR_OK = new Map(Object.entries({ agent: ['read', 'get', 'list', 'wait', 'prompt', 'start'], pane: ['split', 'list', 'current', 'read'], workspace: ['list'], tab: ['list', 'create'] }));
// The flags each worker lane starts with, the same in every project. A project's lane start commands (loadProfile)
// are these plus its own rules folder: the only `herdr agent start` its orchestrator may run, so every lane starts with its own settings
// file and therefore its own guard. guard.test.cjs reads each orchestrator role ("Starting lanes") and fails when the two disagree.
const SEAT_FLAGS = {
  coder: '--model opus --effort high --permission-mode auto --disallowedTools Agent',
  angela: '--model fable --effort max --permission-mode auto --disallowedTools Edit Write NotebookEdit Agent',
  oscar: '--model sonnet --effort medium --permission-mode auto --disallowedTools Edit Write NotebookEdit Agent',
  pam: '--model sonnet --effort medium --permission-mode auto --disallowedTools Edit Write NotebookEdit Agent', // oscar's flags (pam build)
};
const WORKERS = Object.keys(SEAT_FLAGS);
// A pane id in a lane start command: one token of letters, digits and : . _ - (it never starts with "-", so it can't pass for a flag).
const PANE_ID = '[A-Za-z0-9][A-Za-z0-9:._-]*';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALLOW = Object.freeze({ allow: true });
const block = (rule, reason) => ({ allow: false, rule, reason });

// Lowercase, forward slashes, Git Bash /c/ paths and ~ expanded, relative paths resolved against cwd.
// \\?\ (or //?/) is stripped; a lone leading slash roots to C:; any other \\ or // (UNC) can't be read.
function norm(p, cwd) {
  if (typeof p !== 'string' || p.trim() === '') return '';
  let s = p.trim().replace(/\\/g, '/');
  s = s.replace(/^~(?=\/|$)/, HOME);
  s = s.replace(/^\/\/\?\//, '');
  s = s.replace(/^\/([a-z])\//i, '$1:/');
  if (/^\/\//.test(s)) return '';
  s = s.replace(/^\/(?!\/)/, 'c:/');
  if (!/^[a-z]:\//i.test(s) && cwd) s = norm(cwd) + '/' + s;
  return path.posix.normalize(s).toLowerCase().replace(/\/+$/, '');
}

// The real path after following links (junctions, symlinks), normalized. For a path that doesn't exist yet the
// nearest existing folder is resolved and the rest appended. '' when it can't be resolved (the caller blocks).
// ponytail: a dangling link resolves to its parent folder (as if the file were new) and a hard link is invisible (it is
// the same file, with no link to follow). File symlinks need Windows Developer Mode, which is off here, so junctions
// are the only links that exist. Upgrade path if that changes: lstat every segment and block any link that dangles.
function realOf(p) {
  if (!/^[a-z]:\//.test(p)) return '';
  const parts = p.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const head = i === 1 ? parts[0] + '/' : parts.slice(0, i).join('/');
    try {
      const real = fs.realpathSync.native(head).replace(/\\/g, '/').replace(/\/+$/, '');
      return norm([real, ...parts.slice(i)].join('/'));
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return '';
    }
  }
  return '';
}

const isUnder = (p, prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix);
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const isSecret = (p) => /^\.env(\..+)?$/.test(baseName(p)) && baseName(p) !== '.env.example';
const isCore = (p, P) =>
  P.coreFiles.some((f) => p.endsWith(f)) || P.coreDirs.some((d) => p.includes(d)) || P.moneyNames.includes(baseName(p));
const inFolderNamed = (p, name) => p.split('/').includes(name);

// The whole rig folder is a rule path for every seat (so no lane edits any project's rules, work or active-worktree), apart from the
// project's own work folder.
function isRuleFile(p, P) {
  if (p === P.root + '/docs/.gitignore') return true; // a * line here would stop a docs-history task (M5); only Jas changes it
  if (p === RIG || p.startsWith(RIG + '/')) return !isUnder(p, P.work + '/');
  if (/\/\.claude\/settings(\.local)?\.json$/.test(p)) return true;
  return p.startsWith(HOME + '/.claude/skills/herdr/');
}

function readActiveWorktree(P) {
  try {
    return fs.readFileSync(P.activeWorktreeFile, 'utf8').trim();
  } catch {
    return '';
  }
}

// A project's profile, <rig>/<name>/profile.json next to this file (a guard copy in another folder reads that folder's profiles, and
// that folder is its rig), checked field by field and compiled once per process. Throws a readable Error when the name, the file
// or a field is wrong: the CLI turns that into a block of every call (fail closed).
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const LANE_NAME = /^[a-z][a-z0-9-]*$/;
const FOLDER_NAME = /^(?!\.{1,2}$)[\w.-]+$/;
const REL_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/; // a relative path with / and no .. segment
// A core path is compared with paths as norm() writes them: forward slashes, no empty, . or .. segment (both sides are lower-cased, so
// case doesn't matter). An entry in any other shape could never match, so its core rule would be off without a word: it is refused.
const corePath = (s, shape) => typeof s === 'string' && shape.test(s) && path.posix.normalize(s) === s;
const PROFILE_FIELDS = {
  name: (v) => typeof v === 'string',
  root: (v) => typeof v === 'string' && /^[a-z]:[\\/]/i.test(v),
  defaultBranch: (v) => typeof v === 'string' && /^[\w./-]+$/.test(v),
  ticketPrefix: (v) => typeof v === 'string' && /^[a-z]+$/.test(v),
  lanes: (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort()) === '["angela","coder","orchestrator","oscar","pam"]' &&
    Object.values(v).every((n) => typeof n === 'string' && LANE_NAME.test(n)) && new Set(Object.values(v)).size === 5,
  knowledgeDirs: (v) => Array.isArray(v) && v.length > 0 && v.every((d) => typeof d === 'string' && FOLDER_NAME.test(d)),
  coreDirs: (v) => Array.isArray(v) && v.every((d) => corePath(d, /^\/(?:[^\\/]+\/)+$/)),
  coreFiles: (v) => Array.isArray(v) && v.every((f) => corePath(f, /^\/(?:[^\\/]+\/)*[^\\/]+$/)),
  moneyNames: (v) => Array.isArray(v) && v.every((f) => typeof f === 'string' && FOLDER_NAME.test(f)),
  boardScript: (v) => v === null || (typeof v === 'string' && REL_PATH.test(v)),
  worktreeCopy: (v) => Array.isArray(v) && v.every((f) => typeof f === 'string' && REL_PATH.test(f)),
  nodeModulesJunction: (v) => typeof v === 'boolean',
  // settingsrc build: false = every rig session of the project starts with --setting-sources user,local (laneStart below, rig.ps1), so the
  // repo's own .claude/settings.json, whose hooks would run outside the guard, never loads; Refocus --claude-md prints its CLAUDE.md instead.
  projectSettings: (v) => typeof v === 'boolean',
  // v4 add-on, optional (left out is the same as null): the project's PMS board for <rig>/pms.cjs. projectId goes into the URL path.
  pms: (v) =>
    v === undefined ||
    v === null ||
    (typeof v === 'object' && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort()) === '["envFile","projectId"]' &&
      typeof v.projectId === 'string' && /^[\w-]+$/.test(v.projectId) && typeof v.envFile === 'string' && REL_PATH.test(v.envFile)),
};
const OPTIONAL_FIELDS = new Set(['pms']);
const PROFILE_RULES = {
  name: 'the folder name',
  root: 'an absolute path (C:/...)',
  defaultBranch: 'a branch name',
  ticketPrefix: 'lowercase letters only',
  lanes: 'an object with orchestrator, coder, angela, oscar and pam, five different names of lowercase letters, digits and -',
  knowledgeDirs: 'a non-empty list of folder names',
  coreDirs: 'a list of folder paths like /src/core/: start and end with /, forward slashes only, no empty, . or .. segment',
  coreFiles: 'a list of file paths like /src/payments.ts: start with /, end in a file name, forward slashes only, no empty, . or .. segment',
  moneyNames: 'a list of file names',
  boardScript: 'null or a relative path inside the root, with / and no ..',
  worktreeCopy: 'a list of relative paths inside the root, with / and no ..',
  nodeModulesJunction: 'true or false',
  projectSettings: "true or false (false: the repo's own .claude/settings.json stays off in every rig session)",
  pms: 'null, left out, or { "projectId": "<letters, digits, _ and ->", "envFile": "<a relative path inside the root, with / and no ..>" }',
};
const PROFILES = new Map();
function loadProfile(name) {
  if (typeof name !== 'string' || !PROJECT_NAME.test(name)) throw new Error(`"${name}" is not a project name (lowercase letters, digits and -)`);
  const cached = PROFILES.get(name);
  if (cached) return cached;
  const file = path.join(__dirname, name, 'profile.json').replace(/\\/g, '/');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? `unknown project "${name}": there is no ${file}` : `${file} can't be read (${e.code || e.message})`);
  }
  let p;
  try {
    p = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message})`);
  }
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${file} must hold one JSON object`);
  for (const key of Object.keys(p)) if (!Object.hasOwn(PROFILE_FIELDS, key)) throw new Error(`${file} has an unknown field "${key}"`);
  for (const [key, ok] of Object.entries(PROFILE_FIELDS))
    if ((!Object.hasOwn(p, key) && !OPTIONAL_FIELDS.has(key)) || !ok(p[key]) || (key === 'name' && p.name !== name)) throw new Error(`${file}: "${key}" is missing or wrong; it must be ${PROFILE_RULES[key]}`);
  const root = norm(p.root);
  const work = RIG + '/' + name + '/work';
  const rules = RIG_DIR + '/' + name + '/rules';
  const lower = (list) => list.map((s) => s.toLowerCase());
  const dirs = p.knowledgeDirs.map(escapeRe).join('|');
  const rootRe = spelled(root);
  // The worker lanes' herdr names and start commands. `-n <lane>` (Claude Code's session name) shows the lane's name on its prompt bar
  // and lets the status line recognise it. settingsrc build: a profile with projectSettings false adds --setting-sources user,local
  // directly after it, so the repo's own settings never load in that project's lanes; with true the command is the same as before.
  const lanes = WORKERS.map((seat) => p.lanes[seat]);
  const sources = p.projectSettings ? '' : '--setting-sources user,local ';
  const laneStart = WORKERS.map(
    (seat) =>
      `herdr agent start ${p.lanes[seat]} --kind claude --pane <pane> -- -n ${p.lanes[seat]} ${sources}${SEAT_FLAGS[seat]} --settings ${rules}/${seat}.settings.json ` +
      `--append-system-prompt-file ${rules}/seats/${seat}.md --strict-mcp-config --mcp-config ${rules}/mcp.json`
  );
  const runPaths = [...(p.boardScript ? [norm(root + '/' + p.boardScript)] : []), ...RIG_SCRIPTS];
  const knowledgeNames = p.knowledgeDirs.map((d) => d + '/').join(' and ');
  const P = {
    name,
    root,
    rootDir: p.root.replace(/\\/g, '/').replace(/\/+$/, ''), // the root as written, for Refocus and the rotation check
    projectSettings: p.projectSettings, // read by Refocus --claude-md
    work,
    inbox: work + '/inbox',
    activeWorktreeFile: RIG_DIR + '/' + name + '/active-worktree',
    coreScopeFile: RIG_DIR + '/' + name + '/core-scope.json', // Jas's core scope (the core-scope build), next to active-worktree
    coreDirs: lower(p.coreDirs),
    coreFiles: lower(p.coreFiles),
    moneyNames: lower(p.moneyNames),
    // The orchestrator's writable folders: the project's knowledge folders, its rig work folder and the shared scratchpad.
    // Plus its own Claude memory folder: ~/.claude/projects/<root with every non-letter, non-digit as ->/memory/ (Claude Code's rule), never another project's.
    orchWritable: [
      ...p.knowledgeDirs.map((d) => root + '/' + d.toLowerCase() + '/'),
      work + '/',
      SHARED_TEMP,
      HOME + '/.claude/projects/' + p.root.replace(/[^A-Za-z0-9]/g, '-').toLowerCase() + '/memory/',
    ],
    knowledgeNames,
    knowledgeOr: p.knowledgeDirs.join(' or '),
    // The only lanes its orchestrator may `agent prompt` and `agent start`: its own project's.
    lanes,
    laneList: lanes.slice(0, -1).join(', ') + ' or ' + lanes[lanes.length - 1],
    // One anchored pattern per lane start command: the tokens separated by one or more spaces, any pane id, and nothing before or after
    // but blanks.
    laneStartRe: laneStart.map((line) => new RegExp('^\\s*' + line.split(' ').map((tok) => (tok === '<pane>' ? PANE_ID : escapeRe(tok))).join(' +') + '\\s*$')),
    // The ticket name wt-new.ps1 and wt-remove.ps1 take: the project's own prefix, digits, - and a slug (ex12-x). The slug is optional
    // here only because a v3 case runs `wt-remove.ps1 ex1`; the scripts themselves refuse a name without one.
    worktreeName: new RegExp(`^${p.ticketPrefix}\\d+(?:-[a-z0-9][a-z0-9-]*)?$`),
    ticketPrefix: p.ticketPrefix,
    // The project's knowledge folders named as a whole path segment (a trailing dot is the same folder on Windows): not part of a longer
    // name, and not the "docs:" or "docs(scope):" prefix of a commit message.
    knowledgeDir: new RegExp(String.raw`(?<![\w.$-])(?:${dirs})\.*(?![\w.:(-])`, 'i'),
    mainKnowledge: new RegExp(rootRe + SEP + String.raw`(?:${dirs})\.*(?![\w.-])`, 'i'),
    boardRun: p.boardScript ? new RegExp(String.raw`^\s*node\s+(?:\.[\\/])?` + p.boardScript.split('/').map(escapeRe).join('[\\\\/]') + String.raw`\s*$`, 'i') : null,
    runPaths,
    pms: p.pms ?? null, // read by <rig>/pms.cjs, not by the guard
    scriptsMsg: `running ${name} scripts/ is blocked` + (p.boardScript ? ` (the orchestrator may run node ${p.boardScript} only)` : ''),
    // W6: the files the orchestrator may run through an interpreter or launcher. Everything else it writes would run outside the guard
    // with Jas's permissions, and it has no other file to run.
    scriptMsg:
      `the orchestrator runs only its ${runPaths.length === 7 ? 'seven' : 'six'} named scripts (${p.boardScript ? `${name} ${p.boardScript} and ` : ''}the rig pms.cjs, report.cjs, refocus.cjs, wt-new.ps1, wt-remove.ps1, close.ps1); ` +
      'a script it writes would run outside the guard with Jas’s permissions. Read files with Read/Grep, write with Write/Edit, or report what you need',
    // pam's one file (pam build): the rig's pms.cjs, for its own project.
    pamScriptMsg: `pam runs only the rig's pms.cjs (node ${RIG_DIR}/pms.cjs --project ${name} <verb> ..., as the brief writes it); any other script would run outside the guard with Jas’s permissions. Report what you need`,
  };
  PROFILES.set(name, P);
  return P;
}

function checkToolName(seat, tool, input, P) {
  if (/^mcp__.*customerio.*__cio_(write|delete)_api$/i.test(tool)) return block('production-money', 'Customer.io write and delete tools are blocked');
  if (/^(?:Artifact\w*|RemoteTrigger)$/.test(tool) || /^mcp__(claude_ai_|plugin_engineering_)/.test(tool))
    return block('outside-services', `${tool} sends data to an outside service`);
  if (tool === 'Agent' && input && input.isolation === 'remote') return block('outside-services', 'a remote agent leaves the PC; not allowed');
  if (tool === 'Skill' && /^schedule$/i.test(String((input && input.skill) || '')))
    return block('outside-services', 'the schedule skill runs in the cloud; not allowed');
  if (tool === 'SendMessage')
    return block('outside-services', `SendMessage reaches Claude sessions outside the rig, which have no guard; lanes talk only through the orchestrator (workers: say it in your report; the orchestrator: herdr agent prompt ${P.laneList})`);
  if (seat !== 'orchestrator') {
    if (tool === 'AskUserQuestion')
      return block('seat-limits', "nobody watches a worker lane; stop and put your question on the report's Question: line (the rig README, Safety rules)");
    if (/^(PushNotification|WebFetch|WebSearch)$/.test(tool))
      return block('outside-services', `${tool} leaves the PC or interrupts Jas; research goes through the orchestrator, so ask for it on the report's Question: line`);
  }
  if (seat !== 'orchestrator' && /^(Agent|Task|Workflow)$/.test(tool)) return block('seat-limits', 'workers do not delegate');
  // Field note 2: a worker's command run in the background looks finished to the orchestrator (the lane goes idle while it still runs), so
  // every worker command runs in the foreground. The orchestrator keeps background runs: it waits on its lanes that way. Any value but
  // false or none counts.
  if (seat !== 'orchestrator' && (tool === 'Bash' || tool === 'PowerShell') && input && input.run_in_background !== undefined && input.run_in_background !== false)
    return block('seat-limits', 'a worker runs every command in the foreground: run it again without run_in_background and wait for it, and never end your turn while a command you started is still running');
  if (seat === 'orchestrator' && tool === 'EnterWorktree') return block('seat-limits', 'the orchestrator stays in the main checkout');
  if (tool === 'mcp__gitnexus__rename' && input.dry_run !== true)
    return block('seat-limits', 'mcp__gitnexus__rename with dry_run:false edits files in the indexed repo past every path check; run it with dry_run: true and apply the edits with the Edit tool');
  return null;
}

// Jas's core scope (the core-scope build): one JSON object, { "ticket": "<the ticket's worktree name>", "paths": [<folders and files from
// the worktree root>] }. null: no scope; { error }: broken, so it opens nothing; else { ticket, paths } with the paths lower-cased. The tests
// give its text as opts.coreScope ('' = no file); live (no opts.activeWorktree either) it is read from the rig, and only when the core rule
// would block a coder's edit (checkEditPath).
function coreScope(P, opts) {
  let raw = null;
  if ('coreScope' in opts) raw = opts.coreScope || null;
  else if (!('activeWorktree' in opts)) {
    try {
      raw = fs.readFileSync(P.coreScopeFile, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') return { error: `it can't be read (${e.code || e.message})` };
    }
  }
  if (raw === null) return null;
  let s;
  try {
    s = JSON.parse(raw.startsWith('\u{FEFF}') ? raw.slice(1) : raw); // Set-Content -Encoding utf8 (PowerShell 5.1) writes a BOM first
  } catch {
    return { error: 'it is not JSON' };
  }
  if (s === null || typeof s !== 'object' || Array.isArray(s) || JSON.stringify(Object.keys(s).sort()) !== '["paths","ticket"]')
    return { error: 'it must hold one JSON object with exactly two fields, "ticket" and "paths"' };
  if (typeof s.ticket !== 'string' || !P.worktreeName.test(s.ticket)) return { error: `"ticket" must be the ticket's worktree name (${P.ticketPrefix}<n>-<slug>)` };
  // Each entry in the shape of a profile's coreDirs or coreFiles entry (corePath), so it compares with paths as norm() writes them.
  if (!Array.isArray(s.paths) || s.paths.length === 0 || !s.paths.every((e) => PROFILE_FIELDS.coreDirs([e]) || PROFILE_FIELDS.coreFiles([e])))
    return { error: '"paths" must be a non-empty list of folders like /src/core/ and files like /src/payments.ts, from the worktree root (forward slashes; no empty, . or .. segment)' };
  return { ticket: s.ticket, paths: s.paths.map((e) => e.toLowerCase()) };
}

// A valid scope opens a core path only when the active worktree is the ticket's and the path is inside it, and only on an entry: the path
// from the worktree root equals a file entry or starts with a folder entry. A money file opens only by its own file entry.
function scopeOpens(s, p, activeWorktree, P) {
  const wt = norm(P.root + '/.claude/worktrees/' + s.ticket);
  if (norm(activeWorktree) !== wt || !isUnder(p, wt + '/')) return false;
  const rel = p.slice(wt.length);
  return s.paths.includes(rel) || (!P.moneyNames.includes(baseName(p)) && s.paths.some((e) => isUnder(rel, e)));
}

// The decision for one normalized path. checkEdit runs it on the path as given and on its real path.
function checkEditPath(seat, p, activeWorktree, P, scope) {
  if (!p) return block('unreadable', 'edit call without a file path');
  if (isSecret(p)) return block('secrets', `${p} is a secrets file`);
  if (isUnder(p, P.inbox + '/') || p === P.inbox)
    return block('seat-limits', "work/inbox/ is Jas's; no seat writes there. Log what you handled in work/inbox-log.md");
  if (inFolderNamed(p, '.obsidian')) return block('rule-files', "Obsidian settings (.obsidian/) are Jas's; no seat edits them");
  if (inFolderNamed(p, '.git')) return block('rule-files', 'git internals (.git) are never edited by a seat');
  if (isRuleFile(p, P)) return block('rule-files', `${p} is a rig rule file; only Jas changes the rules`);
  if (isCore(p, P)) {
    const reason = `${p} is core or money code; it stays with Jas and one session`;
    const s = seat === 'coder' ? scope() : null; // only a coder's edit reads Jas's core scope
    if (!s) return block('core-money', reason);
    if (s.error) return block('core-money', `${reason}; Jas's core scope (${P.coreScopeFile}) is broken, so it opens nothing: ${s.error}`);
    if (!scopeOpens(s, p, activeWorktree, P))
      return block('core-money', `${reason}; Jas's core scope opens only ${s.paths.join(', ')} (ticket ${s.ticket}), only for coder in that ticket's worktree, and a money file only by its own path`);
  }
  if (seat === 'checker') return block('seat-limits', 'angela and oscar never edit files');
  if (seat === 'pam') return block('seat-limits', 'pam never edits files; it changes tickets only through pms.cjs, with the drafts the orchestrator wrote');
  if (seat === 'coder') {
    const wt = norm(activeWorktree);
    if (!wt) return block('seat-limits', 'there is no active worktree; the orchestrator runs wt-new.ps1 first');
    if (!isUnder(p, wt + '/')) return block('seat-limits', `coder edits only inside the active worktree (${wt})`);
    return ALLOW;
  }
  if (P.orchWritable.some((w) => isUnder(p, w))) return ALLOW;
  return block('seat-limits', `the orchestrator edits only knowledge files (${P.name} ${P.knowledgeNames}, the rig work/ folder, its memory)`);
}

function checkEdit(seat, p, activeWorktree, P, scope) {
  const given = checkEditPath(seat, p, activeWorktree, P, scope);
  if (!given.allow) return given;
  const real = realOf(p);
  if (!real) return block('unreadable', `could not resolve the real path of ${p}; paths are checked after following links`);
  return real === p ? given : checkEditPath(seat, real, activeWorktree, P, scope);
}

function checkRead(tool, input, cwd) {
  const secret = (raw) => {
    const p = norm(raw, cwd);
    return p !== '' && (isSecret(p) || isSecret(realOf(p)));
  };
  if (tool === 'Read' && secret(input.file_path)) return block('secrets', 'reading .env files is blocked');
  if (tool === 'Grep') {
    if (secret(input.path)) return block('secrets', 'searching .env files is blocked');
    if (typeof input.glob === 'string' && /\.env(?!\.example)/i.test(input.glob)) return block('secrets', 'searching .env files is blocked');
  }
  return ALLOW;
}

// Every pattern below has to take time linear in the command's length: this guard runs on every tool call, and Claude Code
// lets a call run when its hook times out (tried live on 2026-09-29). Two things blow that up. Alternatives that can parse
// the same text two ways (once per repeated word: `git -c a -c a ...` took minutes at 30 words), so the options, values and
// prefix words below each parse one way only. And `head[^|;&\n]*tail`, which is quadratic in the number of head words
// (cubic with a second scan), so those are headTail() below.
// A third thing (V3-R24): a chain of options and values that runs on into the next match. Each chain below belongs to a match that
// starts at a program's name (git, supabase, node ...). If the chain can run on across a separator or a line break, or through a word
// that itself ends in that name (`-c /usr/bin/git`, `--x=node`), the match that starts at that word scans the same rest again, and
// a text with K such words takes K*K steps: `git -c a;git -c a;...` 1.4 s for 36 KB, `--until` as a keyword 5 s for 30 KB. So the
// words of a chain hold no separator and no redirect (IW), the blanks between them stay on the line (HS), and a word that ends in
// the program's own name ends the chain (ownEnd; the match that starts there reads the rest).
const HS = String.raw`[^\S\n]+`; // blanks on one line
const IW = String.raw`[^\s|;&()<>\x60]`; // a character of an argument word
const ownEnd = (start) => String.raw`(?!${IW}*${start}(?!\S))`;
// -c and -C are one alternative (the i flag), and -c takes a value that is not itself an option. The long options that take a path or
// a name may give it as the next word (`--git-dir /x`) or after an = ; every other long option is one word. A quoted value holds
// blanks and separators the words above can't, so GIT_QUOTED takes each one out of the text (checkShell) before these run.
const GIT_START = String.raw`\bgit(?:\.exe)?["']?`;
const GIT_END = ownEnd(GIT_START);
const GIT_VALUE_OPTS = 'git-dir|work-tree|namespace|super-prefix|config-env';
const GIT_VAL = String.raw`${GIT_END}[^-\s|;&()<>\x60"']${IW}*`; // an option's value: a bare word that is no option
const GIT_EQ = String.raw`=${GIT_END}${IW}+`;
const GIT_OPTS = String.raw`(?:${HS}(?:-c(?:${HS}${GIT_VAL})?|--(?:${GIT_VALUE_OPTS})(?:${GIT_EQ}|${HS}${GIT_VAL})?|--(?!(?:${GIT_VALUE_OPTS})(?![\w-]))[\w-]+(?:${GIT_EQ})?|-[abd-z]))*`;
const gitSub = (sub) => new RegExp(String.raw`\bgit(?:\.exe)?` + GIT_OPTS + HS + String.raw`(?:` + sub + String.raw`)\b`, 'i');
// A quoted value of one of git's options (`-C "my dir"`, `-c 'a b'`, `--git-dir="x y"`) becomes the word Q.
const GIT_QUOTED = new RegExp(String.raw`(\s(?:-c|--(?:${GIT_VALUE_OPTS}))(?:\s+|=))(?:"[^"\n]*"|'[^'\n]*')`, 'gi');

// `head` followed, later in the same command segment, by `tail`. A segment ends at | ; & or a line break (unless a backtick or
// backslash before the break continues the line); `segEnd` sets another end, for token-sized segments. Only a segment's first
// head is tried, since a later head sees less of the same segment.
const SEGMENT_END = /[|;&]|(?<![`\\]\r?)\n/;
function headTail(head, tail, segEnd = SEGMENT_END) {
  const heads = new RegExp(head.source, head.flags + 'g');
  return {
    test(cmd) {
      heads.lastIndex = 0;
      for (let m; (m = heads.exec(cmd)); ) {
        const from = m.index + m[0].length;
        const rest = cmd.slice(from);
        const end = rest.search(segEnd);
        if (tail.test(end < 0 ? rest : rest.slice(0, end))) return true;
        if (end < 0) return false;
        heads.lastIndex = Math.max(from + end, m.index + 1);
      }
      return false;
    },
  };
}

// A command-position anchor: start of string (leading whitespace allowed), after a shell separator/opener or a
// backtick (\x60, command substitution), after xargs (and its options), after find's -exec/-execdir/-ok/-okdir, or after a
// shell keyword that starts a command (then, do, else, elif, if, while, until). After a separator only the same line's
// spaces are skipped: a line break is an anchor itself, so nothing that follows an anchor (options, prefix words, keywords) is
// separated by a line break either (HS is a run of blanks on one line). Otherwise a chain of prefix words on many lines is one long
// match from every line break, and the regex rescans it from each: quadratic (`command -v -c` + a line break, 12 s at 64 KB).
// Then come any command prefixes (PREFIX), then the verb itself, which may carry a path or quotes (VERB_LEAD: /bin/rm, \rm, 'rm',
// "C:\...\rm.exe").
// Keeps verbs like copy/del/tee from matching inside slugs and file names (ex12-sample-copy-task, text/copy.ts).
// Only non-capturing groups here: callers count on their own group numbers.
const CHAIN = 'env|time|command|builtin|nohup|nice|stdbuf|exec|sudo|setsid|ionice|doas|unbuffer|coproc|watch|rtk(?:\\.exe|\\.cmd)?(?:' + HS + 'proxy)?\\b'; // prefix words that take options (rtk, rtk.exe, rtk.cmd, with or without proxy, run their argument raw: I1/W2)
// Options of a prefix word: -x, --long=v, -n 5. An option or value holds no anchor character and is not itself an anchor
// word (-exec, then, xargs ...), so a chain never runs into the next anchor and two chains never overlap. A value is also
// not something that could be a chain item (a prefix word, "!", ".", NAME=value), so a word is an option's value or a chain
// item, never both.
const AW = String.raw`(?:[^\s|;&(){\x60]|\{\})`; // a character of such a word ({} is xargs' placeholder, not an anchor)
const OPT = String.raw`-(?!(?:exec|execdir|ok|okdir)(?:\s|$))${AW}+`;
const VAL = String.raw`(?!(?:${CHAIN}|xargs|then|do|else|elif|if|while|until|!|\.|\})(?:\s|$))(?:[^-\s=|;&(){\x60]|\{\})(?:[^\s=|;&(){\x60]|\{\})*`;
// xargs and the shell keywords are anchors only as words of their own (after a blank, a separator, the start; xargs also after a path
// or a quote): the `until` of an option `--until idle` is no keyword, and an anchor inside an option would start a chain of its own from
// every `--until` of a long command, each rescanning the rest of the line (quadratic: 5 s for 2,000 of them).
const WORD_START = String.raw`(?<=^|[\s|;&(){\x60/\\"'])`;
const OPTS = String.raw`(?:${HS}${OPT}(?:${HS}${VAL})?)*`;
// A redirect in front of the command name is a prefix word too (Bash runs `2>&1 claude -p hi` and `> out.txt rm x`): a dup or close
// (`2>&1`, `>&2`, `<&-`, `>&file`), or an operator with its target, glued or after blanks (`>/dev/null`, `< in`, `&>x`, `>> x`, `<<EOF`).
const REDIR = String.raw`\d*(?:[<>]&[^\s|;&(){}<>\x60]+|(?:&>>?|<<<|<<-?|<>|>>|>\||[<>])(?:${HS})?(?:"[^"\n]*"|'[^'\n]*'|[^\s"'|;&(){}<>\x60][^\s|;&(){}<>\x60]*))`;
const PREFIX_ITEM = String.raw`(?:(?:${CHAIN})${OPTS}${HS}|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|(?:[^\s"'|;&(){\x60]${AW}*)?)${HS}|!${HS}|\.${HS}|${REDIR}${HS})`;
const PREFIX = PREFIX_ITEM + '*';
// The path in front of the verb starts like a path (/ \ . ~ $VAR C:), so words like src/copy in a grep pattern are not verbs.
// It never holds an anchor character, so anchors in a row don't rescan each other and a path can't swallow the command
// that follows it. A quoted path may hold spaces (C:\Program Files\...) but stays short.
const PATH_START = String.raw`(?=[\\/.~$]|[A-Za-z]:)`;
const VERB_LEAD = String.raw`(?:["']${PATH_START}[^"'\n|;&(){\x60]{0,260}?[\\/]|${PATH_START}[^\s"'|;&(){\x60]*[\\/])?["']?`;
// A PowerShell assignment is one too (`$out = herdr ...`, `[string]$out = ...`, `$null = New-Item ...`), unless what follows is a quoted
// string. It has to start a word (after a blank, a separator or the start), with any [type] in front part of the match, so a glued
// `$a=$b]$a=$b]...` holds one anchor, not one per `$a=`: the word after an anchor is scanned to its end (VERB_LEAD), and two anchors in
// one word would rescan each other. (An anchor after `]` did that, quadratically: 7 s at 96 KB.)
const ASSIGN = String.raw`(?<=^|[\s|;&(){\x60])(?:\[[\w.]+\])?\$\{?[\w:.]+\}?[^\S\n]*[-+*/%]?=[^\S\n]*(?!["'\s])`;
// (A ) is an anchor for Bash's case, `case $x in y) claude -p hi ;; esac`, and a } of its own for PowerShell, which goes on with the
// next statement after a block, `if ($x) { a } claude -p hi`.)
const CMD_START = String.raw`(?:^\s*|[|;&(){\n\x60][^\S\n]*|(?<=^|[\s|;&()\x60])\}[^\S\n]*|${WORD_START}xargs${OPTS}${HS}|\s-(?:exec|execdir|ok|okdir)${HS}|(?<=^|[\s|;&(){\x60])(?:then|do|else|elif|if|while|until)${HS}|${ASSIGN})`;
const CMD_POS = CMD_START + PREFIX + VERB_LEAD;
// The same with the fewest prefix words, for a verb that is itself a prefix word (a launcher: the first one found counts).
const CMD_POS_FIRST = CMD_START + PREFIX_ITEM + '*?' + VERB_LEAD;
// Words that start another program. In front of the Obsidian CLI or herdr one skips its allow list (the launcher's own arguments
// can't be read), so that is a block. LAUNCH_ONLY are the ones that are not also command prefixes: CMD_POS already follows a
// prefix word (env, time, ...) to the program after it, so for claude only these need the wider scan.
const LAUNCHER = 'start-process|start|saps|winpty|env|command|exec|nohup|time|timeout|sudo|setsid|ionice|doas|unbuffer|coproc|watch|invoke-item|ii|wt|conhost|runas|rtk(?:\\.exe|\\.cmd)?';
const LAUNCH_ONLY = 'start-process|start|saps|winpty|timeout|invoke-item|ii|wt|conhost|runas|rtk(?:\\.exe|\\.cmd)?';
// Package runners: `npx claude` runs the globally installed CLI just like `claude` does (checked on this PC). A runner starts the first
// word after its options, so it counts only when that word is claude (`npx vitest run -t "claude"` starts vitest). RUNNER_OPTS are its
// options: a valued one takes the next word (never a runner's own name, so two runner words in a row can't share a chain), any other
// option is one word. `npx -c` / `--call` runs a shell string, which the guard can't read (RE.runnerCall).
const RUNNER = String.raw`npx|bunx|pnpx|npm${HS}(?:exec|x)|pnpm${HS}(?:dlx|exec)|yarn${HS}(?:dlx|exec)|bun${HS}x`;
const RUNNER_OPTS = String.raw`(?:${HS}(?:(?:-p|--package|--registry|--prefix|--cache|--userconfig|-w|--workspace)${HS}(?!(?:npx|npm|bunx|pnpx|pnpm|yarn|bun)(?:\s|$))[^\s|;&(){}<>\x60-][^\s|;&(){}<>\x60]*|-[^\s|;&(){}<>\x60]*))*`;
// The verb of CMD_POS for a program (claude, herdr), with its Windows extension (and `tail`, e.g. claude@latest). The name ends where a
// shell ends a word (NAME_END): at a blank, ; & | ) < > or a backtick (a Bash group, substitution, pipe or redirect: `(claude)`,
// `claude|cat`), at } ( or { (PowerShell: a scriptblock that closes, an argument list or block that opens: `& {claude}`, `claude("x")`),
// or at the end of the command. A quoted name also ends at its own closing quote, whatever follows it glued on (PowerShell: `& "claude"-x`
// runs claude with -x). A closing quote belongs to the name only after an opening quote or a path separator ("claude",
// "C:\x\claude.cmd"). What keeps the words of a quoted pattern, `"a|claude|b"` and `"(claude)"`, from being commands is the quote
// filter of checkClaude and checkHerdr, not the name's ending.
const NAME_END = String.raw`(?:[\s;&)|<>\x60}({$]|\\\n)`; // also a $ (claude$x may expand to the bare name) and a backslash-newline (Bash joins the lines)
const program = (name, tail = '') =>
  String.raw`(?:(?<=["'\\/])${name}${tail}(?:\.(?:exe|cmd|bat|ps1))?(?:["']|(?=${NAME_END}|$))|(?<!["'\\/])${name}${tail}(?:\.(?:exe|cmd|bat|ps1))?(?=${NAME_END}|$))`;
// Between path segments: repeated separators and "." segments (C:\\Users, /c//Users, example-project/./docs).
const SEP = String.raw`[\\/]+(?:\.[\\/]+)*`;
const segments = (s) => s.split('/').map(escapeRe).join(SEP);
// A normalized drive path in every spelling a shell accepts: C:\ C:/ /c/ and doubled separators.
// shortcut: a home that is no drive path (a UNC home) gets no spelling of its own in USER_DIR, only ~ and the variables; add one if a rig
// ever runs under such a home.
const driveSpelled = (p) => `(?:${escapeRe(p[0])}:|/${escapeRe(p[0])})` + SEP + segments(p.slice(3));
// The home folder in every spelling a shell accepts: c:\ c:/ c:\\ /c/ /c// ~ $HOME ${HOME} $USERPROFILE $env:USERPROFILE ${env:USERPROFILE}.
const USER_DIR = String.raw`(?:${driveSpelled(HOME)}|~|\$\{?(?:env:)?(?:home|userprofile)\}?)`;
// A normalized path in every spelling a shell accepts: under the home folder through USER_DIR as well (a project's root, the rig).
const spelled = (p) => (p.startsWith(HOME + '/') ? USER_DIR + SEP + segments(p.slice(HOME.length + 1)) : driveSpelled(p));
// The rig folder with one \ or / between its segments, for the powershell -File <rig>\wt-new.ps1 form.
const RIG_FILE = RIG.split('/').map(escapeRe).join('[\\\\/]');
// A null target (redirects and curl/wget output there write nothing).
const NULL_TARGET = String.raw`(?:\/dev\/null|\$null|nul)(?![\w.])`;
// An interpreter (not part of a longer name), its own options (a bare word after an option is its value, unless it is the
// interpreter's own name again, so chains that start at different words can't overlap), then the flag that runs code from
// the command line: node -e, python -c, perl -pi -e. Options after the script name belong to the script.
const SUPABASE_END = ownEnd(String.raw`\bsupabase(?:@[\w.-]+)?`);
const inline = (names, flag) => {
  const start = String.raw`(?<![\w.-])(?:${names})(?:\.exe)?["']?`;
  const end = ownEnd(start); // the interpreter's own name (also behind a path or an =) ends a chain: the match that starts there reads the rest
  return String.raw`${start}(?:${HS}-[\w-]+(?:=${end}${IW}*)?(?:${HS}${end}[^-\s|;&()<>\x60]${IW}*)?)*?${HS}(?:${flag})(?=[\s="']|$)`;
};
const RE = {
  // A shell given its command as a string: bash/sh/zsh -c, also with other options (-lc, -l -c, --login -c) or as bash.exe, and
  // cmd /c or /k, also behind other switches (/d /c). A start is never inside a longer name or option (-bash), and each option is one
  // word that parses one way, so a long run of options is scanned once per start. PowerShell code built from a string is the same
  // ([scriptblock]::Create("..."), InvokeCommand.InvokeScript, .NewScriptBlock): checkClaude skips commands inside quotes, so a string
  // that runs would hide one.
  wrappers: /\b(?:invoke-expression|iex)\b|-encodedcommand\b|\[scriptblock\]::create\b|\binvokecommand\.(?:invokescript|newscriptblock)\b|processstartinfo|diagnostics\.process\]::start|(?<![\w.-])(?:bash|sh|zsh|dash|ksh)(?:\.exe)?["']?\s+(?:-[\w-]+(?:[=\s]+[^\s-]\S*)?\s+)*-(?=[a-z]*c)[a-z]+\b|(?<![\w.-])cmd(?:\.exe)?["']?\s+(?:\/[a-z](?::\w+)?\s+)*\/[ck]\b/i,
  nestedPowershell: /\b(?:powershell|pwsh)(?:\.exe)?\b/i,
  rigScriptFile: new RegExp(String.raw`^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-noprofile\s+)?-file\s+["']?` + RIG_FILE + String.raw`[\\/](?:wt-new|wt-remove)\.ps1["']?(?:\s+([\w-]+))?\s*$`, 'i'),
  rigScript: new RegExp(RIG_FILE + String.raw`[\\/](?:wt-new|wt-remove)\.ps1`, 'i'),
  // git push in any form: quoted/full-path git.exe invocations and `git subtree push`.
  push: new RegExp(String.raw`\bgit(?:\.exe)?['"]?` + GIT_OPTS + String.raw`(?:${HS}subtree)?${HS}push\b`, 'i'),
  gitWrite: gitSub(
    String.raw`add|commit|reset|stash(?!\s+list\b)|apply|checkout|switch|restore|rebase|merge|cherry-pick|revert|am|clean|rm|mv|tag|push|pull|worktree(?!\s+list\b)|branch\s+-[dDmMcC]`
  ),
  gitWorktree: gitSub('worktree'),
  gitClean: gitSub('clean'),
  gitAddAll: headTail(/\bgit\b/i, headTail(/\badd\b/i, /\s-A\b|\s--all\b|\s\.(?=\s|$)/i)),
  // Git configuration and plumbing nobody in the rig needs, and some of it runs code as Jas or reads secrets (I3). `git config` is blocked
  // unless it only reads (gitConfigRead); `git credential` prints the stored token; update-ref/reflog/gc/prune/filter-*/replace/symbolic-ref
  // rewrite or destroy a project's docs history; `git remote add|remove|rm|set-url|rename` repoints the remote. `reflog show` and
  // `git remote -v` stay. For every seat (the coder commits in its worktree, but never configures git or touches these).
  gitConfig: gitSub('config'),
  gitConfigRead: /--get(?:-all|-regexp)?\b|--list\b|--show-origin\b|--show-scope\b|(?<![\w-])-l\b/i,
  gitPlumbing: gitSub(String.raw`credential\b|update-ref\b|reflog(?!${HS}show\b)|gc\b|prune\b|filter-branch\b|filter-repo\b|replace\b|symbolic-ref\b|remote${HS}(?:add|remove|rm|set-url|rename)\b`),
  // Scheduled tasks and jobs: a seat could register a task (a file it wrote, run as Jas, outside any guard, and it persists) or switch off
  // a docs-history task (I2). Every verb but Get- is blocked, for every seat; Get-ScheduledTask(Info) stay.
  scheduledTask: /\b(?:register|unregister|disable|enable|set|stop|start|new)-scheduled(?:task|job)\w*\b|\bschtasks(?:\.exe)?\b/i,
  vercel: /(?:^|[\s;&|(\/\\])(?:npx\s+|bunx\s+|pnpm\s+dlx\s+)?vercel(?:@[\w.-]+)?(?=\s|$)/i,
  supabase: new RegExp(String.raw`\bsupabase(?:@[\w.-]+)?(?:${HS}(?:--(?:\w[\w-]*(?:=${SUPABASE_END}${IW}+)?)?|-\w[\w-]*(?:=${SUPABASE_END}${IW}+)?))*${HS}(?:db${HS}push|migration\b|functions${HS}deploy)`, 'i'),
  ssh: /(?:^|[\s;&|(])(?:ssh|scp)(?=\s|$)/i,
  gh: /\bgh\b\s+(?:pr\s+(?:create|merge|close|reopen|edit|comment|review|ready)\b|issue\s+(?:create|close|reopen|edit|comment|delete)\b|release\b|repo\s+(?!view\b|list\b|clone\b)\S+|api\b|workflow\s+(?:run|enable|disable)\b|run\s+(?:rerun|cancel|delete)\b|secret\b|variable\b|auth\s+(?:token|login|logout|refresh|setup-git)\b)/i,
  envFile: /(?<![\w$])\.env[\w.-]*/gi,
  recursiveDelete: headTail(/\b(?:remove-item|rm|del|rmdir|rd|erase|ri)\b/i, /\s-(?=[a-z]*r)[a-z]+\b|\s--recursive\b|\s\/s\b/i),
  rimraf: /\brimraf\b/i,
  // A parent path: ../ or ..\, or .. as a whole token (from a worktree, a bare .. is .claude\worktrees).
  parentPath: /(?:^|[^\w.-])\.\.(?:[\\/]|(?![\w.-]))/,
  // With one of the project's knowledge folders named (its knowledgeDir), a verb that moves, renames or deletes at a command position
  // counts (a pipe is one, so `| Remove-Item` does), and so do find -delete and [IO.Directory] Delete/Move.
  moveDelete: new RegExp(CMD_POS + String.raw`(?:mv|move|move-item|mi|robocopy|rename-item|ren|rni|remove-item|rm|del|rmdir|rd|erase|ri)\b(?!=)`, 'i'),
  findDelete: headTail(/\bfind\b/i, /\s-delete\b/i),
  dotNetDir: /\[(?:system\.)?io\.directory\]::(?:delete|move)\b/i,
  // The Obsidian CLI at a command position: bare, as Obsidian.com/.exe, or by (quoted) full path. It ends at the name; scanArgs reads
  // the arguments (global: checkObsidian resumes each search where the arguments end, so a call nested in them is found too).
  obsidian: new RegExp(CMD_POS + String.raw`obsidian(?:\.com|\.exe)?["']?(?=\s|$)`, 'gi'),
  // A launcher in front of the Obsidian CLI skips the allow list. obsidian:// links and names like obsidian.md or .obsidian don't count.
  obsidianLauncher: headTail(
    new RegExp(CMD_POS_FIRST + String.raw`(?:${LAUNCHER})\b`, 'i'),
    /(?<![\w.-])obsidian(?:\.com|\.exe)?(?![\w.-]|:\/\/)/i
  ),
  // herdr. A worker's shell may not name it at all: the whole word herdr (herdr, herdr.exe, ...\herdr.exe; not HERDR_ENV). The
  // orchestrator's herdr commands are checked where they run, at a command position (the regex ends at the name; scanArgs reads the
  // arguments, as for the Obsidian CLI), and a launcher in front of herdr is a block, as for the Obsidian CLI.
  herdrWord: /\bherdr\b/i,
  // pms.cjs, the same way: a worker's shell may not name it at all (the whole word, any case; review-pms I2).
  pmsWord: /\bpms\.cjs\b/i,
  // close.ps1 too (the close build): it closes the lanes' panes through herdr, which no worker may drive.
  closeWord: /(?<![\w.-])close\.ps1(?![\w.-])/i,
  herdr: new RegExp(CMD_POS + program('herdr'), 'gi'),
  herdrLauncher: headTail(
    new RegExp(CMD_POS_FIRST + String.raw`(?:${LAUNCHER})\b`, 'i'),
    /(?<![\w.-])herdr(?:\.(?:exe|cmd|bat|ps1))?(?![\w.-])/i
  ),
  // The Claude Code CLI (claude, claude.cmd, .exe, .ps1: bare, by path or quoted) at a command position, which includes after a
  // prefix word (env, time, ...) but not inside a quoted argument (checkClaude filters the matches by quoteMap); after a launcher that
  // isn't a prefix word (Start-Process, start, ...) anywhere in the segment; as the word a package runner starts (npx claude); and its
  // npm package anywhere, with either slash. `.claude` in a path, "claude" as an argument or in text, and `--kind claude` don't count.
  claudeCli: new RegExp(CMD_POS + program('claude'), 'gi'),
  claudeLauncher: headTail(
    new RegExp(CMD_POS_FIRST + String.raw`(?:${LAUNCH_ONLY})\b`, 'i'),
    /(?<![\w.-])claude(?:\.(?:cmd|exe|ps1|bat))?["']?(?![\w.:\\\/-])/i
  ),
  runnerClaude: new RegExp(CMD_POS_FIRST + String.raw`(?:${RUNNER})` + RUNNER_OPTS + HS + VERB_LEAD + program('claude', String.raw`(?:@[^\s|;&(){}<>\x60]*)?`), 'gi'),
  runnerCall: new RegExp(CMD_POS_FIRST + String.raw`(?:${RUNNER})` + RUNNER_OPTS + HS + String.raw`(?:-c|--call)(?=[\s="']|$)`, 'gi'),
  claudePackage: /@anthropic-ai[\\/]+claude-code/i,
  // eval runs a string the guard can't read, like the wrappers above.
  evalCmd: new RegExp(CMD_POS + String.raw`eval(?=\s|$)`, 'gi'),
  scriptsExec: headTail(/\b(?:node|npx|tsx|ts-node|bun|deno|python3?|py)\b/i, /\bscripts[\\/]/i),
  scriptsDirect: headTail(/(?:^|[\s&;|(])\.?[\\/]?scripts[\\/]/i, /^[^\s'"]+\.(?:ps1|sh|bat|cmd)\b/i, /[\s'"]/),
  // Dependency changes: npm, and bun (for a project with a bun.lockb).
  npmWrite: /\bnpm\s+(?:install|i|ci|uninstall|un|remove|rm|update|up|add|publish)\b|\bbun\s+(?:add|a|install|i|remove|rm|update|upgrade|publish)\b/i,
  // The write verbs, with PowerShell's built-in aliases of them.
  shellWrite: new RegExp(
    CMD_POS +
      String.raw`(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|tee-object|export-csv|export-clixml|tee|rm|mv|cp|copy|move|ren|rni|sc|ac|mkdir|md|touch|del|erase|rmdir|rd|ni|ri|mi|cpi|clc|robocopy|xcopy|install|ln|unlink|shred|truncate)\b(?!=)`,
    'i'
  ),
  // Commands that write only with a certain argument: dd of=, curl -o/-O/--output, wget -O/--output-document,
  // Invoke-WebRequest and Invoke-RestMethod -OutFile. Output to a null target writes nothing, so curl -o /dev/null passes.
  ddOf: headTail(new RegExp(CMD_POS + String.raw`dd\b`, 'i'), /\sof=/i),
  curlOut: headTail(
    new RegExp(CMD_POS + String.raw`curl\b`, 'i'),
    new RegExp(String.raw`\s(?:-[sSLkvfiIgGjJNZ#]*[oO]|--output\b)(?!\s*=?\s*${NULL_TARGET})`, 'i')
  ),
  wgetOut: headTail(
    new RegExp(CMD_POS + String.raw`wget\b`, 'i'),
    new RegExp(String.raw`\s(?:-[a-z]*o\b|--output-document\b)(?!\s*=?\s*${NULL_TARGET})`, 'i')
  ),
  webOutFile: headTail(new RegExp(CMD_POS + String.raw`(?:invoke-webrequest|iwr|invoke-restmethod|irm)\b`, 'i'), /\s-outf/i),
  // Uploads (I4): a POST/PUT/PATCH, a body, a form or a file-upload through curl/wget, Invoke-WebRequest/RestMethod, WebClient or HttpClient.
  // Blocked for every seat unless the only host in the segment is localhost/127.0.0.1/[::1] (checkUpload reads the URL hosts). A plain
  // non-localhost GET (curl https://..., iwr GET) is NOT an upload and stays allowed; the worker-read question is Jas's (final review, For Jas 5b).
  uploadCurl: /(?<![\w.-])(?:curl|wget)(?:\.exe)?\b/i,
  // Case-SENSITIVE: curl's short flags differ by case (-d data vs -D dump-header, -F form vs -f fail, -T upload vs -t, -X method vs -x proxy).
  uploadCurlFlag: /\s(?:-d\b|--data(?:-\w+|\b)|--json\b|-F\b|--form\b|-T\b|--upload-file\b|-X\s*(?:POST|PUT|PATCH|post|put|patch)\b|--request(?:\s+|=)(?:POST|PUT|PATCH|post|put|patch)\b|--post-data(?:=|\b)|--post-file(?:=|\b)|--body-data(?:=|\b)|--body-file(?:=|\b)|--method(?:\s+|=)(?:POST|PUT|PATCH|DELETE|post|put|patch|delete)\b)/,
  uploadWeb: /(?<![\w.-])(?:invoke-webrequest|iwr|invoke-restmethod|irm)\b/i,
  uploadWebFlag: /\s-method\s+(?:post|put|patch)\b|\s-body\b|\s-infile\b/i,
  uploadNet: /\.upload(?:file|string|data|values)\(|webclient\]::upload|\bhttpclient\b|new-object\s+(?:-typename\s+)?(?:system\.)?net\.webclient\b/i,
  // The authority of a URL (or an -Uri/--url value) in a segment; group 1 runs to the path/space/quote. checkUpload strips userinfo and
  // the port/path to get the host, including for a bracketed IPv6 literal (`[::1]@evil` has host evil; `user@[::1]:80` has host [::1]).
  urlHost: /(?:https?:\/\/|(?<![\w.-])(?:-uri|--url)[=\s]+["']?)([^/\s"'`)\\]+)/gi,
  // An interpreter fed its program on stdin by a pipe or a redirect, which the guard can't read (I4): `... | bash`, `curl ... | node`,
  // `bash < x.sh`. An interpreter that names a module or a file (`| python -m json.tool`, `| node report.cjs`) is not this.
  stdinInterp: /\|[^\S\n]*(?:bash|sh|zsh|node|nodejs|python3?|py|perl|ruby|php|pwsh|powershell|deno|bun)(?:\.exe)?[^\S\n]*(?:-[^\S\n]*)?(?=$|[;&|)\n])|(?<![\w.-])(?:bash|sh|zsh|node|nodejs|python3?|py|perl|ruby|php|deno|bun)(?:\.exe)?[^\S\n]*(?:-[^\S\n]*)?<(?!<)/i,
  editFence: new RegExp(CMD_POS + String.raw`(?:set-content|add-content|out-file|tee-object|tee)\b(?!=)`, 'i'),
  dotNetWrite: /\[(?:system\.)?io\.(?:file|directory)\]::(?:(?=\w*(?:write|append|copy|move|delete|create|replace))\w+|open\b)|\bnew-object\s+(?:-typename\s+)?(?:system\.)?io\.streamwriter\b|\[(?:system\.)?io\.streamwriter\]/i,
  // .NET path-object methods (case-sensitive: TypeScript's map.delete( is not one).
  dotNetMethod: /\.(?:Delete|MoveTo|CopyTo)\(/,
  inPlaceSed: headTail(/\bsed\b/i, /\s-i\b/i),
  inPlacePerl: headTail(/\bperl\b/i, /\s-(?=\w*i)\w+\b/i),
  formatWrite: headTail(/\b(?:prettier|eslint)\b/i, /\s--(?:write|fix)\b/i),
  // Code given on the command line, which the guard can't read: an interpreter's own options up to the flag that runs it.
  // Case-sensitive on purpose: PowerShell's -Force or -WindowStyle after a word "node" (Stop-Process -Name node -Force) is not a flag.
  inlineCode: new RegExp(
    [
      inline('node|nodejs|bun', '-(?:e|p|pe|ep)|--eval|--print'),
      inline('tsx|ts-node', '-e|--eval'),
      inline('python3?|py', '-[a-zA-Z]{0,3}c'),
      inline('perl|ruby', '-[a-z0-9]{0,8}[eE]'),
      inline('php', '-r'),
      String.raw`(?<![\w.-])deno\s+eval\b`,
    ].join('|')
  ),
  // The rig folder in every spelling (a trailing dot is the same folder; <rig>-notes and <rig>.old are not). Group 1 = the rest
  // of the path, up to a space, quote or separator.
  rigPath: new RegExp(spelled(RIG) + String.raw`\.*(?![\w.-])([^\s"'|;&<>()\x60]*)`, 'gi'),
  // A .. path that reaches a segment named like the rig folder, within one token.
  rigUp: headTail(/(?<![\w.-])\.\.[\\/]/i, new RegExp(String.raw`^(?:[^\s"'|;&]*[\\/])?` + escapeRe(baseName(RIG)) + String.raw`\.*(?![\w.-])`, 'i'), /[\s"'|;&]/),
  // The flags of `herdr agent start` whose values are rig paths on purpose.
  herdrFlag: /(--(?:settings|append-system-prompt-file|mcp-config)(?:=|\s+))(?:"[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/gi,
  // The coder's shell may not name Claude's settings files or the herdr skill either.
  claudeRules: /\.claude[\\/]+settings|\.claude[\\/]+skills[\\/]+herdr/i,
  // W6 (C1), orchestrator only: an interpreter at a command position (its file argument is checked against the profile's runPaths), and a script file
  // executed at a command position (bare, after & or a dot-source, after its path). Start-Process/Start-Job targets are handled separately.
  orchInterp: new RegExp(CMD_POS + String.raw`(?:node|nodejs|python3?|py|bash|sh|zsh|deno|bun|tsx|ts-node|ruby|perl|php)(?:\.exe)?(?=[\s;&|)<>\x60]|$)`, 'gi'),
  // A script file run at a command position, with its FULL path (CMD_START + PREFIX, not VERB_LEAD, so the directory is captured too: group 1).
  orchScriptAt: new RegExp(CMD_START + PREFIX + String.raw`(["']?(?:[a-zA-Z]:)?[^\s"';|&(){}<>\x60]*\.(?:ps1|bat|cmd|cjs|mjs|js|py|sh))(?=["']|[\s;&|)<>\x60]|$)`, 'gi'),
  orchStartFile: /\b(?:start-process|start-job|saps)\b[\s\S]*?(?:-filepath[=\s]+)?["']?([^\s"';|&]*\.(?:ps1|bat|cmd|cjs|mjs|js|py|sh))\b/i,
  // Package-script runners at a command position: they run a package.json the orchestrator can write (W6). npm view/ls are not here.
  orchRunner: new RegExp(CMD_POS + String.raw`(?:npm${HS}(?:run|run-script|exec|x|start|test|restart)|npx|pnpm${HS}(?:run|exec|dlx|x)|yarn${HS}(?:run|exec|dlx)|bunx|bun${HS}(?:run|x))\b`, 'gi'),
  // Field note 5, orchestrator only: a change of folder at a command position (its target is read by orchestratorCdDenied).
  orchCd: new RegExp(CMD_POS + String.raw`(?:cd|chdir|pushd|push-location|set-location|sl)(?=[\s;&|)<>\x60]|$)`, 'gi'),
};
// W6 (C1): the files the orchestrator may run, as ABSOLUTE normalized paths (W6, wave 2): the project's board script when it has one
// (its runPaths) and these six rig scripts. A script argument is allowed only when its resolved real path (norm + realOf against the
// call's cwd) is exactly one of them, whatever its file name or spelling. pms.cjs (v4 add-on) is the orchestrator's one way to its
// project's PMS board; what it may send is pms.cjs's own business. close.ps1 (the close build) ends its shift.
const RIG_SCRIPTS = ['pms.cjs', 'report.cjs', 'refocus.cjs', 'wt-new.ps1', 'wt-remove.ps1', 'close.ps1'].map((f) => RIG + '/' + f);
const PMS_SCRIPT = RIG + '/pms.cjs';
const SCRIPT_EXT = /\.(?:ps1|bat|cmd|cjs|mjs|js|py|sh)$/i;
const NODE_LOAD_OPT = /^(?:-r|--require|--import|--loader|--experimental-loader)(?:=([\s\S]*))?$/;

// A redirect that writes a file. 2>&1, >&2, redirects to null and => arrows don't count.
const NULL_REDIRECT = new RegExp(String.raw`\d?>{1,2}\s*` + NULL_TARGET, 'gi');
function hasRedirect(cmd) {
  const s = cmd
    .replace(/<[^<>\s@]+@[^<>\s]+>(?=["'\r\n)]|$)/g, '') // an email in angle brackets closing a line or a quote: Co-Authored-By: Name <a@b.c>
    .replace(/\d?>&\d/g, '')
    .replace(NULL_REDIRECT, '')
    .replace(/[=-]>/g, '');
  return />/.test(s);
}

// The arguments of the command whose name ends at `from`, read in one quote-aware pass (linear): their `words` as typed (quotes
// included, split at unquoted blanks), and `end`, where they stop: an unquoted ; | & line break ) or #-comment, a } that closes a
// scriptblock or group (AFTER_BRACE), or the end of the text.
// `opaque` is true when they hold something that runs another command or expands into more words (an unquoted ( or { , $( included,
// or a backtick) or quoting that Bash and Windows PowerShell 5.1 read differently (an unterminated quote; in "...": a backtick, $( ,
// a backslash before a quote, a curly double quote, where PowerShell ends the string; in '...': a double quote, a curly single quote,
// or a backslash right before the closing quote); `end` is then where that starts, and a word it is glued to ends in \0. `ownBacktick`:
// the command itself sits in a `...` pair, so the first backtick only closes it. checkObsidian and checkHerdr resume their search at
// `end`, so a call nested in the arguments is found at its own command position, once, and never rescanned.
// A } ends the words only when what follows is a separator, a comment, another } or ), the end, or a keyword that continues a
// PowerShell statement (`{ herdr agent list } else { ... }`). Any other } is an ordinary word, as in Bash, where `herdr pane split
// --current } --env A=1` hands herdr the --env.
// (A backslash in front of a separator, `herdr agent get coder \; --remote x`, makes it a literal ; in Bash, so the shell's arguments go
// on past where these words stop. The word left holding the backslash is no plain target, value or text, so it is refused anyway.)
const SQ_BAD = /["‘-‛]/;
const AFTER_BRACE = /[^\S\n]*(?:$|[\n;|&)}#]|(?:else|elseif|catch|finally|while|until)(?![\w-]))/iy;
function scanArgs(cmd, from, ownBacktick = false) {
  const words = [];
  const n = cmd.length;
  let start = -1; // where the current word began, or -1
  const done = (at, opaque) => {
    if (start >= 0) words.push(cmd.slice(start, at) + (opaque ? '\0' : ''));
    return { words, end: at, opaque };
  };
  for (let i = from; i < n; i++) {
    const c = cmd[i];
    if (c === ' ' || c === '\t' || (c === '\\' && cmd[i + 1] === '\n')) {
      if (start >= 0) words.push(cmd.slice(start, i));
      start = -1;
      if (c === '\\') i++; // a backslash before a line break continues the line
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === ')') return done(i, false);
    if (c === '}') {
      AFTER_BRACE.lastIndex = i + 1;
      if (AFTER_BRACE.test(cmd)) return done(i, false);
    }
    if (c === '#' && start < 0) {
      const eol = cmd.indexOf('\n', i); // a comment runs to the end of the line
      return done(eol < 0 ? n : eol, false);
    }
    if (c === '`') return done(i, !ownBacktick);
    if (c === '(' || c === '{') return done(i, true);
    if (start < 0) start = i;
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0 || cmd[j - 1] === '\\' || SQ_BAD.test(cmd.slice(i + 1, j))) return done(i, true);
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < n && cmd[j] !== '"'; j++) {
        const d = cmd[j];
        if (d === '`' || (d === '$' && cmd[j + 1] === '(') || (d === '\\' && cmd[j + 1] === '"') || (d >= '“' && d <= '„')) return done(i, true);
      }
      if (j >= n) return done(i, true);
      i = j;
    }
  }
  return done(n, false);
}

// Which characters of a command sit inside a quoted string, as text and not as a command: 1 inside '...', 2 inside "...", 0 anywhere
// else. It is null when the quoting can't be read with certainty (then every match counts): a backtick (PowerShell's escape, bash's
// substitution), a $( in "...", a backslash before a quote (Bash escapes it, PowerShell does not; that also covers $'a\'b'), @' @"
// (PowerShell here-strings, whose lines can hold any quote), << (a heredoc, whose lines can too), a
// # that may start a comment (at the start, or after anything but a word character or one of $ . : @ ~ \ / [ ] ? ^: after `;#it's` the
// apostrophe is comment text, not a quote, and pairing it would turn the next line's command into "quoted text"), a curly quote (PowerShell
// reads it as a quote) or an unterminated quote. Otherwise bash and PowerShell pair quotes the same way, left to right, so nothing that
// runs can hide in a string.
// The quotes a shell removes inside one word, taken out, so a program name written in pieces reads as the plain name: a quoted chunk
// whose text is word characters only, glued on both sides to word characters (cl'a'ude, her""dr, cla""ude), and an empty pair that opens and
// closes outside any string (""claude, claude''). Quotes are paired left to right as quoteMap pairs them, so a chunk with a blank, a
// separator or a backslash in it, a quote inside another string ('x" y'), and a doubled quote inside a string ("a""b") stay as typed: the
// herdr argument rules keep seeing what they refuse. Only the claude and herdr rules read this view. Linear: each quote is visited once.
function unglue(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // Skip what the shell does not read as a quote, so a stray quote there can't mis-pair with a real one and leave a name split:
    // a backslash-escaped character (`\'`, `\"`), and a `#` comment to end of line (its quotes are literal). Mirrors quoteMap.
    if (c === '\\') {
      out += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '#' && !/[\w$.:@~\\/[\]?^]/.test(s[i - 1] ?? '')) {
      const nl = s.indexOf('\n', i);
      const end = nl < 0 ? s.length : nl;
      out += s.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1);
      if (j > 0) {
        const text = s.slice(i + 1, j);
        const word = /^[\w.-]*$/.test(text);
        const L = s[i - 1] ?? '';
        const R = s[j + 1] ?? '';
        // A shell drops quotes at a name's edge too (`cla'ude'`, `'cla'ude`, `he"rdr"`), so remove a word-char chunk when a letter/digit/_
        // is on EITHER side (\w), not only both. Keep the both-sides `[\w.-]` case as a superset so nothing that used to unglue stops. A `-`
        // or `.` on the far side is NOT \w, so `& "claude"-x` (quoted name, a flag after) stays quoted for the quoted-name rule to catch.
        const edge = /\w/.test(L) || /\w/.test(R) || (/[\w.-]/.test(L) && /[\w.-]/.test(R));
        out += word && (text === '' || edge) ? text : s.slice(i, j + 1);
        i = j;
        continue;
      }
    }
    out += c;
  }
  return out;
}

function quoteMap(s) {
  if (/[‘-„]/.test(s)) return null;
  const n = s.length;
  const q = new Uint8Array(n);
  let mode = 0;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (mode === 1) {
      q[i] = 1;
      if (c === "'") mode = 0;
    } else if (mode === 2) {
      q[i] = 2;
      if (c === '"') mode = 0; // (a doubled "" is a literal quote in PowerShell and a close and reopen in Bash: inside a string either way)
      else if (c === '`' || (c === '$' && s[i + 1] === '(') || (c === '\\' && s[i + 1] === '"')) return null;
    } else if (c === "'") {
      q[i] = 1;
      mode = 1;
    } else if (c === '"') {
      q[i] = 2;
      mode = 2;
    } else if (c === '`') {
      if (s[i + 1] !== '\n') return null;
    } else if (c === '\\') {
      if (s[i + 1] === '"' || s[i + 1] === "'") return null;
    } else if (c === '@') {
      if (s[i + 1] === "'" || s[i + 1] === '"') return null;
    } else if (c === '<') {
      if (s[i + 1] === '<') return null;
    } else if (c === '#' && !/[\w$.:@~\\/[\]?^]/.test(s[i - 1] ?? '')) return null; // a # that may start a comment (after a blank, a separator, an operator, a quote)
  }
  return mode === 0 ? q : null;
}

// Whether the global regex `re` matches `s` somewhere that is not inside a quoted string (`q` from quoteMap; null: every match counts). A
// match counts by where it starts, which is where its command position begins (the separator, keyword or prefix word in front of the
// program); index 0 is the start of the command, so a program that is itself quoted there ("claude" -p hi) counts too.
function outside(re, s, q) {
  re.lastIndex = 0;
  for (let m; (m = re.exec(s)); ) if (!q || m.index === 0 || q[m.index] === 0) return true;
  return false;
}

// Every Obsidian CLI call in the command: workers get none, the orchestrator only the read-only subcommands.
// Through a launcher (Start-Process, env, time, ...) no seat gets it: a launcher would skip the allow list. The search resumes where a
// call's arguments end, so a call nested in them ({ }, $( ), ( ), a backtick) is checked like any other.
function checkObsidian(seat, cmd) {
  if (RE.obsidianLauncher.test(cmd))
    return block('seat-limits', 'the Obsidian CLI cannot be started through Start-Process, env, time or another launcher; the orchestrator runs it directly (obsidian vault=docs <read-only command>) and workers not at all');
  const re = RE.obsidian;
  re.lastIndex = 0;
  for (let m; (m = re.exec(cmd)); ) {
    if (seat !== 'orchestrator') return block('seat-limits', 'the Obsidian CLI is for the orchestrator only');
    const a = scanArgs(cmd, re.lastIndex, cmd[m.index] === '`');
    const sub = (a.words.find((w) => !/^vault=/i.test(w)) || '').toLowerCase();
    if (!OBSIDIAN_READ.has(sub))
      return block('seat-limits', `Obsidian CLI "${sub.replace(/\0/g, '') || '(no subcommand)'}" is not a read-only command; the orchestrator writes files only with Write and Edit`);
    re.lastIndex = Math.max(a.end, re.lastIndex);
  }
  return null;
}

// Flags that only print help or the version.
const HERDR_HELP = new Set(['--help', '-h']);
const HERDR_INFO = new Set([...HERDR_HELP, '--version', '-V']);
// Redirects that write no file (2>&1, >&2, 2>$null, *>$null, >/dev/null) are not words of the command: `herdr --help 2>&1` is a lone --help.
const QUIET_REDIRECT = new RegExp(String.raw`(?:\*|\d)?>{1,2}\s*(?:${NULL_TARGET}|&\d)`, 'gi');
// `command -v claude` only looks the program up (command is a prefix word, so it would read as running it). The looked-up word ends at
// a blank or a separator, on the same line: `command -v claude&&claude` is a lookup and then a run, and so is `command -v` + a line
// break + `claude`. It also ends at a quote, so taking it out never removes half of a quoted string (that would shift the quote pairs
// quoteMap reads); the price is that `command -v "claude"` still reads as a run.
const LOOKUP = /(?<![\w.-])command[^\S\n]+-[vV][^\S\n]+[^\s|;&(){}<>\x60'"]+/g;

// The block reasons for a herdr command that is not on the orchestrator's list (P: the project's profile, whose lanes it names).
const herdrList = (P) =>
  `The orchestrator may run herdr --help, pane split, pane list, pane current, pane read, agent prompt (to ${P.laneList}, its own project's lanes), ` +
  "agent read, agent get, agent list, agent wait, workspace list, tab list, tab create (a second tab in its own project's root), and agent start only with the exact commands in the orchestrator role " +
  '("Starting lanes"), and a lone --help after any of them. Never agent send-keys or pane run; lanes start only with the exact commands in the orchestrator role';
const notListed = (what, P) => `${what} is not allowed. ${herdrList(P)}`;
const herdrOpaque = (P) =>
  `the arguments of this herdr command hold something the guard can't read (a $( ) substitution, a backtick, a ( ) or { } group, a quote it can't pair, a quoted string that ends in a backslash, a double quote inside single quotes), and whatever the shell expands there could add options the allow list refuses (--remote, --session, --env); write the arguments out plainly. ${herdrList(P)}`;
// (A word or value that ends in \0 was cut off by something unreadable, so that is the reason.)
const refused = (P, key, takes, word, value = '') =>
  (word + value).includes('\0')
    ? herdrOpaque(P)
    : `herdr ${key} ${word.slice(0, 60)} is not allowed. herdr ${key} takes ${takes}; any other option or word (--remote, --session and --socket included) is refused, ` +
      `and an option is given once${takes.includes('--until') ? ' (--until may repeat)' : ''}. ${herdrList(P)}`;

// The options each herdr subcommand the orchestrator may run takes, and the values they accept: only what the herdr skill documents
// (V3-R24). Any other word in the command is refused, --remote, --session and --socket included. Words are compared as typed, so a
// quoted or glued word never matches; an option is given once (--until may repeat, as herdr allows).
const STATES = /^(?:idle|working|blocked|done|unknown)$/;
const READ_OPTS = new Map([['--source', /^(?:visible|recent|recent-unwrapped|detection)$/], ['--lines', /^\d+$/], ['--format', /^(?:text|ansi)$/]]);
const WAIT_OPTS = new Map([['--timeout', /^\d+$/], ['--until', STATES]]);
const NO_OPTS = new Map();
const HERDR_ARGS = new Map([
  ['agent read', { pos: 1, opts: READ_OPTS }],
  ['pane read', { pos: 1, opts: READ_OPTS }],
  ['agent wait', { pos: 1, opts: WAIT_OPTS }],
  ['agent get', { pos: 1, opts: NO_OPTS }],
  ['agent list', { pos: 0, opts: NO_OPTS }],
  ['pane list', { pos: 0, opts: NO_OPTS }],
  ['pane current', { pos: 0, opts: NO_OPTS }],
  ['workspace list', { pos: 0, opts: NO_OPTS }],
  ['tab list', { pos: 0, opts: NO_OPTS }],
]);
const TARGET_RE = new RegExp('^' + PANE_ID + '$');
const unquote = (w) => (/^(["'])([^"']*)\1$/.exec(w) || [, , w])[2]; // 'coder' and "recent" are the words coder and recent
function plainDenied(key, words, P) {
  const spec = HERDR_ARGS.get(key);
  const takes = (spec.opts.size ? 'only ' + [...spec.opts.keys()].join(', ') : 'no options') + (spec.pos ? ' and one target' : '');
  const seen = new Set();
  let targets = 0;
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    const value = spec.opts.get(w);
    if (value && (!seen.has(w) || w === '--until')) {
      seen.add(w);
      const v = words[++k];
      if (v === undefined || !value.test(unquote(v))) return refused(P, key, takes, w, v);
    } else if (targets < spec.pos && TARGET_RE.test(unquote(w))) targets++;
    else return refused(P, key, takes, w);
  }
  return '';
}

// `herdr agent prompt <lane> <text> [--wait] [--timeout <ms>] [--until <state>]`. A lane gets the text as if Jas typed it, and Claude
// Code reads a first character of ! as bash mode (the rest runs as a shell command, past the lane's guard), # as a memory note and /
// as a command. So the text never starts with one of them, except exactly /clear.
// herdr takes the word right after the lane as the text and rejects a later stray word, so an option before the text can't carry one
// (checked: `--wait "a"` is "unknown option: a"); the guard skips those options anyway, so a herdr that allowed them couldn't hide a
// text behind one. The text is the first word after them; what the guard can't read there (a variable or other expansion, a
// here-string, a value that starts on the next line, an option in its place, no text, a word made of several pieces) is refused, not
// guessed. Quotes, blanks and escape characters in front of the first character don't hide it (`" !ls"`, `\!ls`, `""!ls`); a ! or #
// later in the text is fine. The options after the text are checked like every other subcommand's.
const PROMPT_OPTS = new Map([['--wait', null], ['--timeout', /^\d+$/], ['--until', STATES]]);
const PROMPT_WORD = /^(?:'[^']*'|"[^"]*"|[\w.,:%+=/-]+)$/; // one plain word or one quoted string, with nothing glued to it
const PROMPT_SEND = 'send a lane only a brief line, /clear, or plain text';
const PROMPT_UNREADABLE = `the prompt text has to be plain text that starts on the same line as the command (a variable or other expansion, a here-string, a line break before the text, an option in its place, or a word made of several pieces can't be checked); ${PROMPT_SEND}`;
function promptTextProblem(tok) {
  if (tok === undefined) return PROMPT_UNREADABLE;
  if (tok === '"/clear"' || tok === "'/clear'" || tok === '/clear') return '';
  if (tok[0] === '-') return PROMPT_UNREADABLE; // an option in the text's place
  const c = /^[\s"'\\`]*([\s\S])?/.exec(tok)[1];
  if (c === undefined) return PROMPT_UNREADABLE;
  if (c === '!') return `a prompt that starts with ! runs a shell command in that lane past its guard (Claude Code's bash mode); ${PROMPT_SEND}`;
  if (c === '#') return `a prompt that starts with # writes a note into that lane's memory files (Claude Code's # shortcut); ${PROMPT_SEND}`;
  if (c === '/') return `a prompt that starts with / runs a Claude Code command in that lane (/permissions, /model, /hooks and the rest change how it runs); only /clear is allowed; ${PROMPT_SEND}`;
  return c === '$' || !PROMPT_WORD.test(tok) ? PROMPT_UNREADABLE : '';
}
// The lane has to be one of the orchestrator's own project's lanes (P.lanes): another project's lanes have their own orchestrator.
function promptDenied(words, P) {
  const lane = words[0];
  if (!P.lanes.includes(lane)) return notListed(`herdr agent prompt ${lane === undefined ? '(no target)' : lane.replace(/\0/g, '').slice(0, 60)}`, P);
  let k = 1;
  while (PROMPT_OPTS.has(words[k])) {
    const value = PROMPT_OPTS.get(words[k]);
    if (value === null) k += 1;
    else if (value.test(unquote(words[k + 1] ?? ''))) k += 2;
    else break;
  }
  const problem = promptTextProblem(words[k]);
  if (problem) return problem;
  const takes = 'only --wait, --timeout and --until, after the text';
  const seen = new Set();
  for (let j = k + 1; j < words.length; j++) {
    const w = words[j];
    const value = PROMPT_OPTS.get(w);
    if (value === undefined || (seen.has(w) && w !== '--until')) return refused(P, 'agent prompt', takes, w);
    seen.add(w);
    if (value !== null) {
      const v = words[++j];
      if (v === undefined || !value.test(unquote(v))) return refused(P, 'agent prompt', takes, w, v);
    }
  }
  return '';
}

// `herdr pane split` takes only --current or one pane id, --direction <right|down>, --ratio <number>, --cwd <folder>, --focus and
// --no-focus, each once. --env would set a variable such as BASH_ENV or PROMPT_COMMAND in the new pane's shell, which could make it run
// a command before any guard loads; --pane and --right-click are not needed either. A lone --help prints help. herdr itself takes an
// option's value from the next word, rejects --option=value and abbreviations, and has no -e.
// The guard reads every value as one word it can see whole (V3-R24): --direction and --ratio bare; --cwd a bare path-like word, the
// variable $PWD, a single-quoted string or a double-quoted string, and never a value that ends in a backslash or holds a double quote.
// Why: Windows PowerShell 5.1 hands a native program a value with a blank in it wrapped in double quotes, and escapes neither an inner
// double quote nor a backslash in front of the closing one. herdr.exe (an MSVC build) reads that backslash and quote as a literal quote,
// so `--cwd 'C:\a b\' --cwd 'x --env A=1 y'` reaches it as `C:\a b" --cwd x`, `--env`, `A=1`, `y`. With no such value, and no option twice,
// no later quote can shift and an --env can't hide inside a value. (scanArgs already reads a quote it can't pair, or a quoted string that
// ends in a backslash or holds a double quote, as unreadable, so those arrive here as a word ending in \0.)
const SPLIT_TAKES = 'only --current or one pane id, --direction <right|down>, --ratio <number>, --cwd <folder>, --focus and --no-focus, each once';
const SPLIT_ENV = '--env is refused because a variable such as BASH_ENV or PROMPT_COMMAND could make the new shell run a command before any guard loads';
// The only variable a --cwd may hold is $PWD (the skill's form): a path can't hold a double quote, whereas any other variable might carry one
// (or a blank and a --env after it) that the guard can't see and PowerShell 5.1 would re-split.
const PWD_VAR = String.raw`\$(?:pwd(?![\w:])|\{pwd\})`;
const CWD_PLAIN = new RegExp(String.raw`^(?:[\w.:~\\/][\w.:~\\/-]*|${PWD_VAR}|'[^'"]*'|"(?:[^"$]|${PWD_VAR})*")$`, 'i');
const SPLIT_VALUES = new Map([
  ['--direction', (v) => /^(?:right|down)$/.test(v)],
  ['--ratio', (v) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v)],
  ['--cwd', (v) => CWD_PLAIN.test(v) && !/\\['"]?$/.test(v)],
]);
function splitDenied(words, P) {
  const seen = new Set();
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    const shown = w.replace(/\0/g, '').slice(0, 60);
    const target = w === '--current' || TARGET_RE.test(w);
    const check = SPLIT_VALUES.get(w);
    if (!target && !check && w !== '--focus' && w !== '--no-focus')
      return w.includes('\0') ? herdrOpaque(P) : `herdr pane split ${shown} is not allowed. pane split takes ${SPLIT_TAKES} (a lone --help is fine). ${SPLIT_ENV}`;
    const key = target ? 'target' : w;
    if (seen.has(key)) return `herdr pane split ${shown} is given twice. pane split takes ${SPLIT_TAKES}. A value that Windows PowerShell 5.1 re-splits could hide the second one from this check`;
    seen.add(key);
    if (check && !check(words[++k] ?? ''))
      return (
        `herdr pane split ${w} needs one plain value: ` +
        (w === '--cwd'
          ? 'a bare folder, $PWD (no other variable), or a quoted string, and never one that ends in a backslash or holds a double quote (Windows PowerShell 5.1 gives herdr a value with a blank in it in double quotes, so a trailing backslash or an inner double quote would split the rest of the command line into more herdr options, --env among them)'
          : w === '--direction'
            ? 'right or down, written bare'
            : 'a number, written bare (0.5)')
      );
  }
  return '';
}

// `herdr tab create` (pam build): the second tab, where the tab-2 seats run, opened in the orchestrator's own project root. It takes only
// --cwd <that root> (required: the same plain values as pane split --cwd, but no variable, and the path has to be the profile's root), --label
// <one plain word> and --no-focus, each once. --env (a variable such as BASH_ENV could make the new shell run a command before any guard
// loads), --workspace (a tab in another space), --focus and every other option or word are refused.
const TAB_TAKES = "only --cwd <this project's root> (required), --label <one plain word> and --no-focus, each once";
function tabCreateDenied(words, P) {
  const seen = new Set();
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w.includes('\0')) return herdrOpaque(P);
    if (w !== '--cwd' && w !== '--label' && w !== '--no-focus')
      return `herdr tab create ${w.slice(0, 60)} is not allowed. tab create takes ${TAB_TAKES}; --env, --workspace, --focus and every other option or word are refused. ${SPLIT_ENV}`;
    if (seen.has(w)) return `herdr tab create ${w} is given twice. tab create takes ${TAB_TAKES}`;
    seen.add(w);
    const v = w === '--no-focus' ? '' : words[++k] ?? '';
    if (w === '--cwd' && !(SPLIT_VALUES.get('--cwd')(v) && !v.includes('$') && norm(unquote(v)) === P.root))
      return `herdr tab create --cwd takes this project's root written out plainly (${P.rootDir}, quoted or bare; no variable and no other folder). tab create takes ${TAB_TAKES}`;
    if (w === '--label' && !/^[A-Za-z0-9][\w-]*$/.test(unquote(v))) return `herdr tab create --label takes one plain word (letters, digits, _ and -), like seats. tab create takes ${TAB_TAKES}`;
  }
  return seen.has('--cwd') ? '' : `herdr tab create needs --cwd ${P.rootDir}, so the tab opens in this project's root. tab create takes ${TAB_TAKES}`;
}

// What is wrong with one herdr command at a command position: the whole block reason, or '' when the orchestrator may run it. `words`
// are what follows `herdr` (scanArgs). The group and subcommand are compared as written (herdr's own words are lower case). A group
// alone or with --help prints help and does nothing; a lone --help, -h, --version or -V does too; every other option in front of the
// group (--session, --remote, ...) is refused, so the group is always the first word. After a listed subcommand only its documented
// options pass (HERDR_ARGS, the prompt and split rules above), each once.
function herdrDenied(cmd, words, P) {
  const [group, sub, ...rest] = words;
  if (group === undefined) return notListed('a bare herdr (it opens the TUI)', P);
  if (group.startsWith('-')) return HERDR_INFO.has(group) && sub === undefined ? '' : notListed(`herdr ${group.replace(/\0/g, '').slice(0, 60)}`, P);
  const subs = HERDR_OK.get(group);
  if (!subs) return notListed(`herdr ${group.replace(/\0/g, '').slice(0, 60)}`, P);
  if (sub === undefined || (HERDR_HELP.has(sub) && rest.length === 0)) return '';
  if (!subs.includes(sub)) return notListed(`herdr ${group} ${sub.replace(/\0/g, '').slice(0, 60)}`, P);
  // Field note 8: a lone --help (or -h) after any subcommand on the list prints its help and runs nothing; with any other word it is checked
  // like the subcommand itself.
  if (rest.length === 1 && HERDR_HELP.has(rest[0])) return '';
  const key = group + ' ' + sub;
  if (key === 'agent prompt') return promptDenied(rest, P);
  // Only the project's own lane start commands (P.laneStartRe), so every lane starts with its own project's settings and guard.
  if (key === 'agent start') return P.laneStartRe.some((re) => re.test(cmd)) ? '' : notListed('this herdr agent start', P);
  if (key === 'pane split') return splitDenied(rest, P);
  if (key === 'tab create') return tabCreateDenied(rest, P);
  return plainDenied(key, rest, P);
}

// herdr: workers get none, in any spelling (any whole word herdr in the shell command). The orchestrator gets the allow list in
// HERDR_OK, only at a command position, and never through a launcher (Start-Process, env, time, ...), which would skip the list.
// Every herdr at a command position is checked, also one nested in another call's arguments ({ }, $( ), ( ), a backtick, a prompt text):
// scanArgs stops a call's words where that starts, and the search goes on from there, so each one is found at its own position, once
// (V3-R24). What stops the words but leaves the call itself readable (a group, a substitution) is a reason to refuse it too, since
// whatever the shell expands there could add options.
function checkHerdr(seat, cmd, P) {
  if (seat !== 'orchestrator')
    return RE.herdrWord.test(unglue(cmd))
      ? block('seat-limits', "only the orchestrator drives herdr; lanes report, and a question goes on the report's Question: line (the rig README, Safety rules)")
      : null;
  const view = unglue(cmd.replace(LOOKUP, ' '));
  if (RE.herdrLauncher.test(view))
    return block('seat-limits', 'herdr cannot be started through Start-Process, env, time or another launcher; run it directly, and only the commands the orchestrator role lists');
  const flat = view.replace(QUIET_REDIRECT, ' ');
  const q = quoteMap(flat);
  const re = RE.herdr;
  re.lastIndex = 0;
  for (let m; (m = re.exec(flat)); ) {
    // A herdr inside a quoted string whose name ends at one of the endings added in V3-R27 and V3-R28 (anything but a blank, ; & or the end:
    // `"a|herdr|b"`, `"(herdr)"`) is text, as for claude (checkClaude); index 0 is the start of the command, so it counts. A name that ends at
    // a blank, ; or & is checked wherever it sits, as before, and when the quotes can't be read (q is null) every match counts.
    if (q && m.index !== 0 && q[m.index] !== 0 && !/[\s;&]/.test(flat[re.lastIndex] ?? ' ')) continue;
    const a = scanArgs(flat, re.lastIndex, flat[m.index] === '`');
    const denied = herdrDenied(cmd, a.words, P) || (a.opaque ? herdrOpaque(P) : '');
    if (denied) return block('seat-limits', denied);
    re.lastIndex = Math.max(a.end, re.lastIndex);
  }
  return null;
}

// The Claude Code CLI and its npm package, for every seat: a Claude started from a shell loads no rig settings, so it has no guard.
// `q` is the command's quoteMap: a claude inside a quoted string ("... (claude or gpt) ...", -t "claude") is text, not a command, so the
// position-based rules skip it. The launcher rule (Start-Process claude, timeout 5 claude) has no such filter: it looks for the word
// claude anywhere after the launcher in the segment, and a quoted one counts.
function checkClaude(cmd, view, q) {
  return outside(RE.claudeCli, view, q) || outside(RE.runnerClaude, view, q) || RE.claudeLauncher.test(view) || RE.claudePackage.test(cmd)
    ? block('seat-limits', 'a Claude started from a shell loads no rig settings, so it has no guard; workers report, and the orchestrator starts lanes only with the herdr agent start commands in its role')
    : null;
}

// W5 (I4): an upload (POST/PUT/PATCH, a body, a form, a file upload) may reach only localhost. Checked per segment (chain pieces and pipes),
// so a curl in a pipeline is judged on its own piece. The hosts come from the URLs in the segment (an IPv6 literal kept whole); a segment with
// an upload shape but no local host named is blocked, so the `?localhost`-in-the-query trick and a bare non-local host are both caught.
const LOCAL_HOST = new Set(['localhost', '127.0.0.1', '[::1]']);
function checkUpload(cmd) {
  for (const seg of cmd.split(/&&|\|\||;|\||(?<![`\\]\r?)\n/)) {
    const up =
      (RE.uploadCurl.test(seg) && RE.uploadCurlFlag.test(seg)) ||
      (RE.uploadWeb.test(seg) && RE.uploadWebFlag.test(seg)) ||
      RE.uploadNet.test(seg);
    if (!up) continue;
    const hosts = [];
    RE.urlHost.lastIndex = 0;
    for (let m; (m = RE.urlHost.exec(seg)); ) {
      const a = m[1].replace(/^.*@/, ''); // strip userinfo (a host has no @); a bracket before @ is userinfo too
      let h;
      if (a[0] === '[') {
        const e = a.indexOf(']');
        h = e < 0 ? null : a.slice(0, e + 1); // an unterminated bracket is unparseable -> not local
      } else h = a.replace(/[:/?#].*$/, '') || null;
      hosts.push(h === null ? null : h.toLowerCase());
    }
    const nonLocal = hosts.some((h) => !LOCAL_HOST.has(h));
    const localNamed = hosts.some((h) => LOCAL_HOST.has(h)) || /(?<![\w.-])(?:localhost|127\.0\.0\.1|\[::1\])(?![\w.-])/i.test(seg);
    if (nonLocal || !localNamed)
      return block('outside-services', 'an upload (a POST/PUT/PATCH, a request body, a form or a file upload) may go only to localhost, 127.0.0.1 or [::1]; nothing else leaves the PC without Jas (the rig README, Safety rules). A plain GET of a URL is not blocked');
  }
  return null;
}

// W6 (C1), orchestrator only: the only files it may run are its named scripts (P.runPaths). An interpreter at a command position is checked
// on its first file argument (a module name or no argument, like `node --version` or `python -m json.tool`, is fine); a script file run at a
// command position (bare, after & or a dot-source) and a Start-Process/Start-Job target are checked on their name.
// A worktree script (wt-new.ps1, wt-remove.ps1) run by the orchestrator also has to be given exactly one ticket name with its own project's
// prefix (ex12-x for a project with the prefix ex): the script picks the project from that prefix, and a new worktree becomes that project's
// coder fence, so another project's worktrees stay with its own orchestrator.
const WT_SCRIPTS = [RIG + '/wt-new.ps1', RIG + '/wt-remove.ps1'];
const RIG_WIN = RIG_DIR.replace(/\//g, '\\'); // as the block reasons show the rig scripts' & lines
// Field note 4: wt-new.ps1 also takes -Resume (once, before or after the name; PowerShell reads a switch name in any case), which makes an
// existing ticket worktree the coder's again without a git change. Only the & (or . or bare-path) call passes `resumeOk`.
function worktreeNameDenied(words, P, resumeOk = false) {
  const at = resumeOk ? words.findIndex((w) => /^-resume$/i.test(w)) : -1;
  const name = at < 0 ? words : [...words.slice(0, at), ...words.slice(at + 1)];
  if (name.length === 1 && P.worktreeName.test(unquote(name[0]))) return '';
  return (
    `wt-new.ps1 and wt-remove.ps1 take exactly one ticket name of this project, ${P.ticketPrefix}<n>-<slug> in lowercase, written out plainly: ` +
    `& '${RIG_WIN}\\wt-new.ps1' ${P.ticketPrefix}12-short-slug (wt-new.ps1 also takes -Resume after the name, for an existing ticket worktree). ` +
    "Another project's worktrees belong to its own orchestrator"
  );
}
// close.ps1 (the close build) ends the shift of the project it is given: that project's lanes, its seats tab and the orchestrator's own pane,
// in the orchestrator's herdr space; it holds the herdr closes the orchestrator itself may not run (pane close, tab close, an /exit prompt).
// So the orchestrator's call names exactly its own project, written out plainly, plus -Force (once, in any case: PowerShell reads a switch
// name in any case) when Jas said "close anyway"; words the guard can't all read (`opaque`) could hold another argument, so they refuse too.
// Only the & (or . or bare-path) run gets here: powershell -File <rig>\close.ps1 stays a nested-powershell block.
const CLOSE_SCRIPT = RIG + '/close.ps1';
function closeDenied(words, opaque, P) {
  const name = words.filter((w) => !/^-force$/i.test(w));
  if (!opaque && words.length - name.length <= 1 && name.length === 1 && unquote(name[0]) === P.name) return '';
  return (
    `close.ps1 takes exactly this project's name, written out plainly, and -Force only after Jas said "close anyway": ` +
    `& '${RIG_WIN}\\close.ps1' ${P.name} (or ${P.name} -Force), from the PowerShell tool. Another project's lanes belong to its own orchestrator`
  );
}
// pms.cjs (v4 add-on) picks the PMS board from its own --project, so the orchestrator's pms.cjs call has to hold exactly one plain
// `--project <its own project>` among the script's words (review-pms I1). Any other spelling of --project counts as a second one (quoted,
// escaped, `--project=x`, another case), and a call whose words the guard can't all read (`opaque`: a $( ), a backtick, a ( ) or { } group,
// a quote it can't pair) could hold one more, so both are refused; pms.cjs itself refuses a --project given twice and an unknown option.
// pms.cjs never takes a { or } outside quotes (rereview-pms N1): scanArgs reads `} <word>` as two words, but in PowerShell a } that closes a
// block ends the statement and the word after it runs on its own (`if (...) { & <rig>\pms.cjs ... } .\other.ps1`). A title with braces is
// quoted, so it stays one quoted word.
// pam build (B.2): only pam sends a write; the orchestrator's pms.cjs call holds no --live (in any spelling the shell turns into --live:
// quoted or escaped pieces count, so the word is read with its quotes and backslashes taken out, like --project above). That pam writes only
// after Jas's yes stays a role rule: the orchestrator writes "Jas approved: post" into pam's brief, and the guard can't hear Jas.
const pmsOnly = (P) =>
  `pms.cjs takes only this project: --project ${P.name}, given once and written out plainly (node ${RIG_DIR}/pms.cjs --project ${P.name} <verb> ...); ` +
  "another project's PMS board belongs to that project's own seats";
const PMS_LIVE =
  'only pam, the PMS writer, runs pms.cjs with --live: the orchestrator reads the board (board, show) and runs a write without --live (a dry run), shows Jas the output, ' +
  'and on his "post" writes pam a brief with the exact commands and the line "Jas approved: post"';
function pmsProjectDenied(words, opaque, P, seat) {
  if (words.some((w) => /[{}]/.test(w.replace(/"[^"]*"|'[^']*'/g, ''))))
    return pmsOnly(P) + '; pms.cjs takes no { or } outside quotes (quote a title that holds one)';
  const bare = words.map((w) => w.replace(/["'\\]/g, '').toLowerCase());
  const at = words.indexOf('--project');
  const named = bare.filter((w) => w.startsWith('--project')).length;
  if (opaque || named !== 1 || at < 0 || words[at + 1] !== P.name) return pmsOnly(P);
  return seat === 'orchestrator' && bare.some((w) => w.startsWith('--live')) ? PMS_LIVE : '';
}

// W6 (C1) for the two seats that run a rig script: the orchestrator its named scripts (P.runPaths), pam only pms.cjs (pam build, B.1).
function scriptRun(view, q, cwd, P, seat) {
  const runPaths = seat === 'orchestrator' ? P.runPaths : [PMS_SCRIPT];
  const scriptMsg = seat === 'orchestrator' ? P.scriptMsg : P.pamScriptMsg;
  // A script argument is allowed only when its resolved real path (as the edit checks resolve: norm + realOf against cwd) is one of them.
  const realPath = (name) => {
    const p = norm(name, cwd);
    return p ? realOf(p) : ''; // '' when it can't be resolved -> block, like checkEdit
  };
  const unlisted = (name) => {
    const real = realPath(name);
    return real === '' || !runPaths.includes(real);
  };
  // A package-script runner (npm run, npx, pnpm dlx, ...) runs a package.json the orchestrator can write.
  if (outside(RE.orchRunner, view, q)) return block('seat-limits', scriptMsg);
  RE.orchInterp.lastIndex = 0;
  for (let m; (m = RE.orchInterp.exec(view)); ) {
    if (!q || m.index === 0 || q[m.index] === 0) {
      const a = scanArgs(view, RE.orchInterp.lastIndex, view[m.index] === '`');
      for (let k = 0; k < a.words.length; k++) {
        const w = unquote(a.words[k]).replace(/\0/g, '');
        const lo = NODE_LOAD_OPT.exec(w); // -r/--require/--import/--loader load a file that runs
        if (lo) {
          const val = lo[1] !== undefined ? lo[1] : unquote(a.words[++k] ?? '').replace(/\0/g, '');
          // pms.cjs loaded in front of another script would read that script's arguments as its own, past the --project check below.
          if (val && realPath(val) === PMS_SCRIPT) return block('seat-limits', pmsOnly(P) + '; it runs as the script itself, never loaded with -r, --require, --import or --loader');
          if (val && unlisted(val)) return block('seat-limits', scriptMsg);
          continue;
        }
        if (w.startsWith('-')) continue; // an ordinary option
        if (/[\\/]/.test(w) || SCRIPT_EXT.test(baseName(w))) {
          const real = realPath(w);
          if (real === '' || !runPaths.includes(real)) return block('seat-limits', scriptMsg);
          // The script's own words are the ones after its path; the reason says which rule (verify-n1 M1: the brace hint too).
          const denied = real === PMS_SCRIPT ? pmsProjectDenied(a.words.slice(k + 1), a.opaque, P, seat) : '';
          if (denied) return block('seat-limits', denied);
        }
        break; // a module name or bareword (python -m json.tool) is not a file argument
      }
      RE.orchInterp.lastIndex = Math.max(a.end, RE.orchInterp.lastIndex);
    }
  }
  const strip = (s) => s.replace(/^["']|["']$/g, '');
  // The worktree name is read with the redirects that write no file (2>&1, *>$null) blanked out, as checkHerdr drops them: they are not
  // words of the command. Same length, so the positions match view's.
  let quiet = null;
  RE.orchScriptAt.lastIndex = 0;
  for (let m; (m = RE.orchScriptAt.exec(view)); ) {
    if (q && m.index !== 0 && q[m.index] !== 0) continue;
    const real = realPath(strip(m[1]));
    if (real === '' || !runPaths.includes(real)) return block('seat-limits', scriptMsg);
    if (WT_SCRIPTS.includes(real) || real === PMS_SCRIPT || real === CLOSE_SCRIPT) {
      // Its arguments start after the path's closing quote. The search goes on where they end (linear), as for an interpreter's words:
      // a worktree name that passes is one word (two with wt-new's -Resume), pms.cjs's words are its own arguments, and so are close.ps1's.
      const end = RE.orchScriptAt.lastIndex;
      quiet ??= view.replace(QUIET_REDIRECT, (r) => ' '.repeat(r.length));
      const a = scanArgs(quiet, /["']/.test(view[end] ?? '') ? end + 1 : end);
      const denied =
        real === PMS_SCRIPT ? pmsProjectDenied(a.words, a.opaque, P, seat) : real === CLOSE_SCRIPT ? closeDenied(a.words, a.opaque, P) : worktreeNameDenied(a.words, P, real === RIG + '/wt-new.ps1');
      if (denied) return block('seat-limits', denied);
      RE.orchScriptAt.lastIndex = Math.max(a.end, end);
    }
  }
  const sm = RE.orchStartFile.exec(view);
  if (sm) {
    const real = realPath(strip(sm[1]));
    if (real === '' || !runPaths.includes(real)) return block('seat-limits', scriptMsg);
    if (WT_SCRIPTS.includes(real)) return block('seat-limits', worktreeNameDenied([], P) + " (through Start-Process or Start-Job the guard can't read the name)");
    if (real === PMS_SCRIPT) return block('seat-limits', pmsOnly(P) + " (through Start-Process or Start-Job the guard can't read its arguments)");
    if (real === CLOSE_SCRIPT) return block('seat-limits', closeDenied([], false, P) + " (through Start-Process or Start-Job the guard can't read its arguments)");
  }
  const file = RE.rigScriptFile.exec(view); // powershell -File <rig>\wt-new.ps1 <name>
  if (file) {
    if (seat !== 'orchestrator') return block('seat-limits', scriptMsg);
    const denied = worktreeNameDenied(file[1] === undefined ? [] : [file[1]], P);
    if (denied) return block('seat-limits', denied);
  }
  return null;
}

// Field note 5: the orchestrator stays in the main checkout, so its shell never moves into a worktree: a cd there changes the folder every
// later command of its session runs in. The target of a cd, chdir, pushd, Set-Location (sl) or Push-Location at a command position is read
// in every path spelling norm() knows (C:\, /c/, ~, relative to the call's folder; an option glued to its value, -Path:<p>, too), and one
// inside <root>/.claude/worktrees/ (or that folder itself) blocks. git -C <worktree> reads a worktree without moving.
function orchestratorCdDenied(view, q, cwd, P) {
  const wts = P.root + '/.claude/worktrees';
  const re = RE.orchCd;
  re.lastIndex = 0;
  for (let m; (m = re.exec(view)); ) {
    if (q && m.index !== 0 && q[m.index] !== 0) continue;
    const a = scanArgs(view, re.lastIndex, view[m.index] === '`');
    for (const w of a.words) {
      const v = w.startsWith('-') ? w.slice(w.indexOf(':') + 1 || w.length) : w;
      const p = v ? norm(unquote(v.replace(/\0/g, '')), cwd) : '';
      if (p === wts || p.startsWith(wts + '/'))
        return block('seat-limits', `the orchestrator stays in the main checkout and never moves into a worktree (${w.replace(/\0/g, '').slice(0, 80)}): read one with git -C <worktree path> ... or the Read tool`);
    }
    re.lastIndex = Math.max(a.end, re.lastIndex);
  }
  return null;
}

// The rig paths the orchestrator's shell may name: its project's working files (work\, but not inbox\ or any .obsidian\) and the
// scripts pms.cjs, report.cjs, refocus.cjs (it lists the inbox when Jas says "inbox"), wt-new.ps1, wt-remove.ps1 and close.ps1. `rest` is
// what follows the rig folder in the command's own spelling.
function orchestratorMayName(rest, P) {
  const p = norm(RIG + rest);
  if (RIG_SCRIPTS.includes(p)) return true;
  return (p === P.work || p.startsWith(P.work + '/')) && p !== P.inbox && !isUnder(p, P.inbox + '/') && !inFolderNamed(p, '.obsidian');
}

// The rig paths pam's shell may name (pam build): pms.cjs and its own project's drafts folder, work\pms\, which its brief's commands send.
function pamMayName(rest, P) {
  const p = norm(RIG + rest);
  return p === PMS_SCRIPT || p === P.work + '/pms' || p.startsWith(P.work + '/pms/');
}

// The first rig path the command names that this seat may not, or ''. The orchestrator also gets, in a
// `herdr agent start` command, the values of --settings, --append-system-prompt-file and --mcp-config.
function rigPathMention(seat, cmd, P) {
  const orch = seat === 'orchestrator';
  const text = orch && /^\s*herdr\s+agent\s+start\b/i.test(cmd) ? cmd.replace(RE.herdrFlag, '$1') : cmd;
  for (const m of text.matchAll(RE.rigPath)) if (!(orch ? orchestratorMayName(m[1], P) : seat === 'pam' && pamMayName(m[1], P))) return m[0];
  return RE.rigUp.test(text) ? 'a .. path' : '';
}

function checkShell(seat, cmd, cwd, P) {
  // Windows PowerShell 5.1 ends a statement at a lone CR as well as at a line feed (checked through powershell.exe -Command), so a CR, alone
  // or in a CRLF, is a line break for every rule below, the command-position anchors included (V3-R24). In Bash a CR is an ordinary
  // character, so treating it as a line break only adds blocks.
  cmd = cmd.replace(/\r\n?/g, '\n');
  if (RE.wrappers.test(cmd)) return block('unreadable', 'wrapped or encoded commands cannot be checked; run the command directly');
  if (RE.inlineCode.test(cmd))
    return block('unreadable', "inline interpreter code can't be checked; the coder: a file in its worktree; every other seat: use Read, Grep, Write and Edit, or report what you need");
  // The command with `command -v <name>` lookups taken out, and which of its characters sit inside quotes (null: can't tell, then every match counts).
  const view = cmd.replace(LOOKUP, ' ');
  const q = quoteMap(view);
  // eval, and a package runner's -c / --call, run a string: anything in it (a claude, a herdr) would be missed, so like bash -c they are refused.
  if (outside(RE.evalCmd, view, q) || outside(RE.runnerCall, view, q))
    return block('unreadable', "eval and a package runner's -c or --call run a string the guard can't check; run the command directly");
  if (RE.nestedPowershell.test(cmd) && !RE.rigScriptFile.test(cmd))
    return block('unreadable', 'nested powershell calls cannot be checked; use the PowerShell tool directly');
  const git = cmd.replace(GIT_QUOTED, '$1Q'); // git's quoted option values taken out (see GIT_OPTS)
  if (RE.push.test(git)) return block('production-money', 'git push is blocked; Jas pushes');
  if (RE.vercel.test(cmd) || RE.supabase.test(cmd)) return block('production-money', 'deploys and prod database changes are blocked');
  if (RE.ssh.test(cmd)) return block('production-money', 'ssh and scp to servers are blocked');
  if (RE.gh.test(cmd)) return block('production-money', 'gh writes (PRs, issues, releases, repo admin, workflows, secrets, auth) are blocked; Jas does this');
  if (RE.scheduledTask.test(cmd))
    return block('rule-files', 'scheduled tasks and jobs are blocked (a task runs as Jas, outside the guard, and could switch off the docs-history task); Jas manages them. Get-ScheduledTask and Get-ScheduledTaskInfo are allowed');
  // Each `git config` must carry its own read flag in its OWN statement, so a read flag in a later statement (or inside a $( )) can't
  // unlock an earlier write (W4). Split on the statement separators and on ( ) $( ` so a config nested in a substitution is its own piece.
  if (RE.gitConfig.test(git) && git.split(/&&|\|\||[;|()`]|(?<![`\\]\r?)\n/).some((s) => RE.gitConfig.test(s) && !RE.gitConfigRead.test(s)))
    return block('production-money', "git config may only read (--get, --get-all, -l, --list, --show-origin), and each git config statement needs its own read flag; a config write can point a hook or pager at code that runs as Jas. Read it with --get");
  if (RE.gitPlumbing.test(git))
    return block('production-money', "git credential, update-ref, reflog (not reflog show), gc, prune, filter-branch, filter-repo, replace, symbolic-ref and remote add/remove/set-url/rename are blocked (secret reads, history rewrites, remote changes); Jas does this");
  const obsidian = checkObsidian(seat, cmd);
  if (obsidian) return obsidian;
  const herdr = checkHerdr(seat, cmd, P);
  if (herdr) return herdr;
  // pms.cjs reads and writes a production PMS board: the orchestrator runs it (reads and dry runs) and pam (pam build, B.4), nobody else. A
  // coder's or checker's shell may not name it at all, as for herdr: the rig-path rule alone misses a worker whose shell is already in the
  // rig folder (review-pms I2).
  if (seat !== 'orchestrator' && seat !== 'pam' && RE.pmsWord.test(unglue(cmd)))
    return block('seat-limits', "only the orchestrator and pam run pms.cjs (the PMS board script); a worker's shell may not name it. What the board should say goes in your report");
  // close.ps1 (the close build) closes the lanes' panes through herdr, so no worker's shell may name it either, pam's included: the rig-path
  // rule alone misses a shell that is already in the rig folder, as for pms.cjs.
  if (seat !== 'orchestrator' && RE.closeWord.test(unglue(cmd)))
    return block('seat-limits', "only the orchestrator runs close.ps1 (it ends the shift: it closes the lanes' panes); a worker's shell may not name it");
  const unglued = unglue(view);
  const claude = checkClaude(cmd, unglued, unglued === view ? q : quoteMap(unglued));
  if (claude) return claude;
  const upload = checkUpload(cmd);
  if (upload) return upload;
  if (RE.stdinInterp.test(cmd))
    return block('unreadable', "an interpreter fed its program on a pipe or a redirect (| bash, curl ... | node, bash < x.sh) can't be checked; run a named script or module, or use the tools");
  if (seat === 'orchestrator' || seat === 'pam') {
    const uq = unglued === view ? q : quoteMap(unglued);
    const ran = scriptRun(unglued, uq, cwd, P, seat) || (seat === 'orchestrator' ? orchestratorCdDenied(unglued, uq, cwd, P) : null);
    if (ran) return ran;
  }
  if ((cmd.match(RE.envFile) || []).some((m) => m.toLowerCase() !== '.env.example'))
    return block('secrets', 'shell commands may not name .env files (search code with the Grep tool instead)');
  if ((RE.recursiveDelete.test(cmd) || RE.rimraf.test(cmd)) && (/worktrees|node_modules/i.test(cmd) || RE.parentPath.test(cmd)))
    return block('worktree-safety', 'recursive deletes of worktrees, node_modules or a parent (..) path are blocked; the orchestrator uses wt-remove.ps1');
  // Each part of a chain is checked on its own (split at ;, && and ||, not at a single |: a pipeline is one unit).
  if (cmd.split(/&&|\|\||;|(?<![`\\]\r?)\n/).some((seg) => P.knowledgeDir.test(seg) && [RE.recursiveDelete, RE.rimraf, RE.moveDelete, RE.findDelete, RE.dotNetDir].some((re) => re.test(seg))))
    return block('worktree-safety', `deleting, moving or renaming ${P.knowledgeOr} is blocked, by any verb and with or without a recursive flag; that is where ${P.name}'s knowledge lives. Ask Jas. Each part of a chain (split at ; && || and new lines) is checked on its own: put text that only mentions ${P.knowledgeOr} (a commit message) in its own command`);
  const boardRun = seat === 'orchestrator' && P.boardRun !== null && P.boardRun.test(cmd);
  if (!boardRun && (RE.scriptsExec.test(cmd) || RE.scriptsDirect.test(cmd))) return block('production-money', P.scriptsMsg);
  const rigScript = RE.rigScript.test(cmd);
  if (rigScript && seat !== 'orchestrator') return block('seat-limits', 'only the orchestrator creates and removes worktrees');
  const rig = rigPathMention(seat, cmd, P);
  if (rig)
    return block(
      'rule-files',
      `a shell command may not name the rig folder (${rig}); read rig files with the Read tool. Only Jas changes the rules` +
        (seat === 'orchestrator'
          ? " (the orchestrator's shell may name its work/ files except inbox/, pms.cjs, report.cjs, refocus.cjs, wt-new.ps1, wt-remove.ps1 and close.ps1)"
          : seat === 'pam'
            ? " (pam's shell may name pms.cjs and its project's work/pms/ files)"
            : '')
    );
  if (seat === 'coder') {
    if (RE.claudeRules.test(cmd)) return block('rule-files', `${cmd} names Claude's settings files or the herdr skill; only Jas changes the rules`);
    if (P.mainKnowledge.test(cmd) || (RE.parentPath.test(cmd) && P.knowledgeDir.test(cmd)))
      return block('seat-limits', `the coder's shell may not touch main's ${P.knowledgeOr} (a .. path reaches them from the worktree); read plans with the Read tool`);
    if (hasRedirect(cmd) || RE.editFence.test(cmd) || RE.dotNetWrite.test(cmd) || RE.inPlaceSed.test(cmd) || RE.inPlacePerl.test(cmd))
      return block('seat-limits', 'this shell write bypasses the file fence; use the Edit and Write tools');
    if (RE.gitAddAll.test(cmd)) return block('seat-limits', 'stage files by explicit path; never git add -A, git add . or git add --all');
    if (RE.npmWrite.test(cmd)) return block('seat-limits', 'dependency changes need Jas; stop and report');
    if (RE.gitWorktree.test(git)) return block('seat-limits', 'only the orchestrator manages worktrees');
    if (RE.gitClean.test(git)) return block('worktree-safety', 'git clean deletes untracked files including node_modules and .env.local; not allowed');
    return ALLOW;
  }
  const who =
    seat === 'checker' ? 'angela and oscar never write files' : seat === 'pam' ? 'pam never writes files; it changes tickets only through pms.cjs' : 'the orchestrator writes files only with the Write and Edit tools';
  const writes = [RE.shellWrite, RE.ddOf, RE.curlOut, RE.wgetOut, RE.webOutFile, RE.findDelete, RE.dotNetWrite, RE.dotNetMethod, RE.inPlaceSed, RE.inPlacePerl, RE.formatWrite];
  if (hasRedirect(cmd) || writes.some((re) => re.test(cmd))) return block('seat-limits', who);
  if (RE.gitWrite.test(git)) return block('seat-limits', 'git writes are not allowed for this seat');
  if (RE.npmWrite.test(cmd)) return block('seat-limits', 'installs are not allowed for this seat');
  return ALLOW;
}

// opts.profile names the project (default example, the template and test fixture); opts.activeWorktree stands in for its
// active-worktree file in the tests. opts.coreScope stands in for its core-scope.json (the text; '' = no file), and a call that gives
// opts.activeWorktree without it has no core scope, so a test never reads the live file.
function decide(call, opts = {}) {
  const P = loadProfile(opts.profile === undefined ? 'example' : opts.profile);
  const { seat, tool_name: tool, cwd = '' } = call || {};
  const input = (call && call.tool_input) || {};
  if (!SEATS.includes(seat)) return block('config', `unknown seat "${seat}"; expected ${SEATS.join(', ')}`);
  if (typeof tool !== 'string' || tool === '') return block('unreadable', 'hook input has no tool name');
  const named = checkToolName(seat, tool, input, P);
  if (named) return named;
  if (EDIT_TOOLS.has(tool)) {
    const active = 'activeWorktree' in opts ? opts.activeWorktree : readActiveWorktree(P);
    return checkEdit(seat, norm(input.file_path || input.notebook_path || '', cwd), active, P, () => coreScope(P, opts));
  }
  if (tool === 'Read' || tool === 'Grep') return checkRead(tool, input, cwd);
  if (typeof input.command === 'string') return checkShell(seat, input.command, cwd, P);
  return ALLOW;
}

const blockedMessage = (result) =>
  `BLOCKED by rig guard [${result.rule}]: ${result.reason}. ` +
  'This is on purpose (the rig README, Safety rules). Do not work around it; report it.\n';

if (require.main === module) {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const seat = arg('--seat') || '';
  const project = arg('--project');
  // Every hook command names its project. A call without one, or with a project whose profile is missing or wrong, is refused (fail
  // closed, like a missing guard): there is no project to check it against.
  let profileError = '';
  try {
    if (project === undefined) throw new Error('the guard was started without --project <name>');
    loadProfile(project);
  } catch (e) {
    profileError = e.message;
  }
  // A hook that times out lets the call run (Claude Code's default is 60 s), so the checks must be linear-time, and
  // if one is not, the call is blocked rather than allowed: decide() runs under a time budget that stops even a regex that runs away
  // (vm's timeout does; checked). RIG_GUARD_BUDGET_MS lowers it for the tests; it never goes above 30 s, and a value that is not a whole
  // number of milliseconds (1.5, -5, a word, nothing) is ignored, since vm would throw on it and every call would block.
  const asked = Number(process.env.RIG_GUARD_BUDGET_MS);
  const BUDGET_MS = Number.isInteger(asked) && asked > 0 ? Math.min(30000, asked) : 20000;
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let result;
    if (profileError) {
      result = block(
        'config',
        `${profileError}. Every hook command is node ${RIG_DIR}/guard.cjs --project <name> --seat <seat> || exit 2, with a valid <rig>/<name>/profile.json; tell Jas (a lane started before v4 has to be restarted)`
      );
    } else {
      try {
        const hook = JSON.parse(raw.trimStart()); // trimStart drops a BOM too: a PowerShell 5.1 pipe in a UTF-8 console starts with one (rig.ps1)
        const call = { seat, tool_name: hook.tool_name, tool_input: hook.tool_input, cwd: hook.cwd };
        result = require('vm').runInNewContext('decide(call, opts)', { decide, call, opts: { profile: project } }, { timeout: BUDGET_MS });
      } catch (e) {
        result =
          e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
            ? block('unreadable', `the guard ran out of time (${BUDGET_MS / 1000} s) on this call, and a call it cannot finish counts as blocked; split the command into smaller ones`)
            : block('unreadable', 'the guard could not read the hook input (' + e.message + ')');
      }
    }
    if (result.allow) return;
    process.stderr.write(blockedMessage(result));
    process.exitCode = 2;
  });
}

module.exports = { decide, norm, loadProfile, RIG_DIR };
