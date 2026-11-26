#!/usr/bin/env node
'use strict';
// Refocus: SessionStart hook (startup, clear, compact). Prints the lane's intent back into its context (the rig README, Daily use).
// For the orchestrator it also prints Jas's new inbox notes (a project's optional work\inbox\) and the startup warnings.
// Settings entry: node <rig>/hooks/refocus.cjs --project <name> --seat <orchestrator|coder|angela|oscar|pam|scribe>
const fs = require('fs');
const path = require('path');

const RIG = fs.realpathSync.native(path.dirname(__dirname)).replace(/\\/g, '/'); // the rig: the folder above this file's hooks/, as guard.cjs's RIG_DIR writes it
// A project's paths: its rig work folder, and the handoffs and docs folders in its main checkout (from <rig>/<name>/profile.json).
const projectPaths = (P) => ({ work: `${RIG}/${P.name}/work`, handoffs: `${P.rootDir}/.agent/handoffs`, docs: `${P.rootDir}/docs` });
const INBOX_SHOWN = 10;
const HISTORY_LAG_MS = 2 * 60 * 60 * 1000;
// Notes Obsidian creates when a link to a code file is clicked (route.ts -> route.ts.md).
const STRAY = /\.(?:ts|tsx|js|jsx|cjs|mjs|mts|cts|json|ps1|sh|sql|css|ya?ml)\.md$/i;
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) \| ([^|]+?) \|/;

function readOr(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// The "## Start here" block of a handoff, 20 lines max. Older handoffs have none: then the first 20 lines.
function startHere(text) {
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+start here\b/i.test(l.trim()));
  if (at === -1) return { block: lines.slice(0, 20).join('\n').trim(), found: false };
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return { block: (end === -1 ? rest : rest.slice(0, end)).slice(0, 20).join('\n').trim(), found: true };
}

function newestHandoff(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /_PROMPT_next_shift(_\d+)?\.md$/i.test(n));
  } catch {
    return null;
  }
  const stated = names
    .map((n) => {
      try {
        return { n, t: fs.statSync(path.join(dir, n)).mtimeMs }; // a dangling link throws here, not out of render (Refocus never throws)
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (stated.length === 0) return null;
  const newest = stated.sort((a, b) => b.t - a.t)[0].n;
  return path.join(dir, newest);
}

// A note's first lines of text, without its property block, joined with " / ".
function noteHead(text, lines = 3) {
  let body = String(text).replace(/^\uFEFF/, '');
  if (/^---\r?\n/.test(body)) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      const after = body.indexOf('\n', end + 1);
      body = after === -1 ? '' : body.slice(after + 1);
    }
  }
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join(' / ')
    .slice(0, 200); // cap the head so ten long notes don't flood every start (M7)
}

// When each note was last handled, from inbox-log.md lines "YYYY-MM-DD HH:MM | <note file name> | ...".
function handledTimes(logText) {
  const times = new Map();
  for (const line of String(logText).split(/\r?\n/)) {
    const m = LOG_LINE.exec(line);
    if (!m) continue;
    const t = new Date(`${m[1]}T${m[2]}:${m[3]}:00`).getTime(); // local time, like the log
    if (Number.isNaN(t)) continue; // a malformed time (25:99) is NaN; skip it so it can't hide a note for good (M7)
    const name = m[4].trim();
    if (!(times.get(name) >= t)) times.set(name, t);
  }
  return times;
}

// New inbox notes, newest first: .md files directly in the inbox that the log doesn't list, or that changed after
// their last log line. The log has minute resolution, so a note changed within 60 s of its log time counts as read.
// ponytail: an edit inside that minute is missed; log seconds if that ever matters.
function newInboxNotes(inboxDir, logText) {
  const handled = handledTimes(logText);
  return fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.md$/i.test(d.name))
    .map((d) => {
      const file = path.join(inboxDir, d.name);
      return { name: d.name, mtimeMs: fs.statSync(file).mtimeMs, head: noteHead(readOr(file)) };
    })
    .filter((n) => !handled.has(n.name) || n.mtimeMs > handled.get(n.name) + 60000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Throws when the inbox can't be read; render turns that into a warning. A project without an inbox folder (the template's) has none.
function inboxBlock(work) {
  const dir = path.join(work, 'inbox');
  if (!fs.existsSync(dir)) return '';
  const notes = newInboxNotes(dir, readOr(path.join(work, 'inbox-log.md')));
  if (notes.length === 0) return '';
  const lines = notes.slice(0, INBOX_SHOWN).map((n) => `- ${n.name}: ${n.head || '(empty)'}`);
  if (notes.length > INBOX_SHOWN) lines.push(`- … and ${notes.length - INBOX_SHOWN} more`);
  return (
    `[rig] Inbox: ${notes.length} new note(s) from Jas. Sort each one, propose one next step, ask Jas, ` +
    `then log it in work\\inbox-log.md:\n${lines.join('\n')}`
  );
}

// Files under dir, skipping dot-folders and dot-files (.git, .obsidian, .trash). Links are not followed.
function walk(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) out.push(...walk(dir, r));
    else if (d.isFile()) out.push({ rel: r, mtimeMs: fs.statSync(path.join(dir, r)).mtimeMs });
  }
  return out;
}

// The newest commit time of a repo, from .git/logs/HEAD ("<old> <new> Name <email> <unix-seconds> <tz>\t<msg>").
function lastCommitMs(repo) {
  const lines = fs.readFileSync(path.join(repo, '.git', 'logs', 'HEAD'), 'utf8').trim().split(/\r?\n/);
  const m = /> (\d+) [+-]\d{4}\t/.exec(lines[lines.length - 1]);
  if (!m) throw new Error('no commit time in .git/logs/HEAD');
  return Number(m[1]) * 1000;
}

// One-line warnings for things that would otherwise fail silently. Never throws.
function startupWarnings(paths, now = Date.now()) {
  const warn = [];
  const check = (name, fn) => {
    try {
      fn();
    } catch (e) {
      warn.push(`[rig] WARNING: the startup check "${name}" could not run (${e.message}). Tell Jas.`);
    }
  };
  // docs\ is checked where it is an Obsidian vault or has a history (an hourly task committing it); a plain docs\ gets none of its checks.
  const docs = paths.docs && ['.obsidian', '.git'].some((d) => fs.existsSync(path.join(paths.docs, d))) ? paths.docs : '';
  const vaults = [['work', paths.work], ['docs', docs]].filter(([, dir]) => dir);
  for (const [name, dir] of vaults) {
    const conf = path.join(dir, '.obsidian');
    if (!fs.existsSync(conf)) continue; // not a vault (yet)
    check(`${name} vault Sync`, () => {
      const core = JSON.parse(fs.readFileSync(path.join(conf, 'core-plugins.json'), 'utf8'));
      const on = Array.isArray(core) ? core.includes('sync') : core.sync !== false;
      if (on) warn.push(`[rig] WARNING: Obsidian Sync is not switched off in the "${name}" vault; it would upload the vault. Tell Jas.`);
    });
    check(`${name} vault plugins`, () => {
      const file = path.join(conf, 'community-plugins.json');
      if (!fs.existsSync(file)) return;
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(list) && list.length)
        warn.push(`[rig] WARNING: community plugins are enabled in the "${name}" vault (${list.join(', ')}). Tell Jas.`);
    });
  }
  if (docs) {
    check('docs folder', () => {
      const files = walk(docs);
      const strays = files.map((f) => f.rel).filter((r) => STRAY.test(r));
      if (strays.length)
        warn.push(
          `[rig] WARNING: ${strays.length} stray note(s) from links to code in docs\\ (Obsidian made them): ` +
            `${strays.slice(0, 5).join(', ')}${strays.length > 5 ? ', …' : ''}. Tell Jas.`
        );
      let last;
      try {
        last = lastCommitMs(docs);
      } catch (e) {
        warn.push(`[rig] WARNING: docs\\ has no readable history (${e.message}); the hourly docs history task may not be set up. Tell Jas.`);
        return;
      }
      const behind = files.filter((f) => f.mtimeMs > last && now - f.mtimeMs > HISTORY_LAG_MS);
      if (behind.length)
        warn.push(
          `[rig] WARNING: ${behind.length} file(s) in docs\\ changed over 2 hours ago and aren't in its history yet; ` +
            'the hourly docs history task may have stopped. Tell Jas.'
        );
    });
  }
  return warn;
}

// paths: { work, handoffs, docs } (projectPaths for the CLI; the tests pass their own).
function render(seat, paths) {
  const parts = [];
  const work = paths.work;
  const now = readOr(path.join(work, 'now.md'));
  if (now) parts.push('[rig] Current intent (now.md):\n' + now);
  if (seat === 'orchestrator') {
    const file = newestHandoff(paths.handoffs);
    const { block, found } = file ? startHere(readOr(file)) : { block: '', found: false };
    if (block) parts.push(`[rig] Newest handoff ${path.basename(file)} (${found ? 'Start here block' : 'first 20 lines; it has no Start here block'}):\n${block}`);
    try {
      const inbox = inboxBlock(work);
      if (inbox) parts.push(inbox);
    } catch (e) {
      parts.push(`[rig] WARNING: the inbox (work\\inbox\\) can't be read (${e.code || e.message}). Tell Jas.`);
    }
    const warnings = startupWarnings(paths);
    if (warnings.length) parts.push(warnings.join('\n'));
  } else if (seat) {
    const notes = readOr(path.join(work, 'notes', seat + '.md'));
    if (notes) parts.push(`[rig] Your seat notes (${seat}):\n${notes}`);
  }
  return parts.join('\n\n');
}

// --claude-md (settingsrc build), its own SessionStart hook so its 9,000 characters never share a hook's output cap with Refocus's: where
// the profile says projectSettings false, the lanes start with --setting-sources user,local, which also keeps Claude Code from loading
// <root>\CLAUDE.md, so it is printed here. Nothing when projectSettings is true or there is no such file. The count is of the text as
// printed (a BOM dropped, CRLF as LF); over the limit the lane is told to read the file itself.
const CLAUDE_MD_MAX = 9000;
function claudeMd(P) {
  if (P.projectSettings) return '';
  const file = P.rootDir.replace(/\//g, '\\') + '\\CLAUDE.md';
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw new Error(`${file} can't be read (${e.code || e.message})`);
  }
  text = text.replace(/^\u{FEFF}/u, '').replace(/\r\n/g, '\n');
  return (
    `[rig] ${P.name}'s repo settings are off in rig sessions (they can run commands; see its profile's projectSettings), so its CLAUDE.md is not loaded. ` +
    `It follows; read it as the project's CLAUDE.md, and where it differs from your role file or the guard, they win.\n` +
    (text.length <= CLAUDE_MD_MAX ? text : `It is ${text.length} characters, too long to print here: before your first task, read ${file} in full with the Read tool.`)
  );
}

// The project comes from --project and its profile, read with the guard's own loader. A missing, unknown or broken project is one
// warning line, never a throw (Refocus never stops a session from starting).
function cli(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const mdMode = argv.includes('--claude-md');
  try {
    const project = arg('--project');
    if (project === undefined) throw new Error('Refocus was started without --project <name>');
    const P = require('./guard.cjs').loadProfile(project);
    return mdMode ? claudeMd(P) : render(arg('--seat') || '', projectPaths(P));
  } catch (e) {
    return mdMode
      ? `[rig] WARNING: ${e.message}, so the project's CLAUDE.md was not printed. Every CLAUDE.md hook is node ${RIG}/hooks/refocus.cjs --project <name> --seat <seat> --claude-md. Tell Jas.`
      : `[rig] WARNING: ${e.message}, so no intent or notes were loaded. Every Refocus hook is node ${RIG}/hooks/refocus.cjs --project <name> --seat <seat>. Tell Jas.`;
  }
}

if (require.main === module) {
  const out = cli(process.argv);
  if (out) process.stdout.write(out + '\n');
}

module.exports = { startHere, newestHandoff, render, noteHead, newInboxNotes, startupWarnings, projectPaths, cli };
