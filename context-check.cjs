#!/usr/bin/env node
'use strict';
// Rotation warning: UserPromptSubmit hook for the orchestrator (the rig README, Daily use).
// Settings entry: node <rig>/context-check.cjs --project <name>
const fs = require('fs');

const RIG = fs.realpathSync.native(__dirname).replace(/\\/g, '/'); // the rig: this file's folder, as guard.cjs's RIG_DIR writes it

const LIMIT = Number(process.env.RIG_CONTEXT_LIMIT) || 400000; // tokens; the one calibration knob

// Context size = the latest assistant turn's input + cache read + cache creation tokens.
function lastContextTokens(transcriptText) {
  const lines = String(transcriptText).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      const u = e.type === 'assistant' && e.message && e.message.usage;
      if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    } catch {
      // a partial or non-JSON line; keep looking
    }
  }
  return 0;
}

// P: the project's profile (its name and its main checkout, rootDir), where the handoff goes.
function warning(tokens, limit, P) {
  if (tokens < limit) return '';
  return (
    `[rig] Context is at about ${Math.round(tokens / 1000)}k tokens (rotation limit ${Math.round(limit / 1000)}k). ` +
    `Finish the current step, then rotate: write ${P.rootDir}/.agent/handoffs/<YYYY-MM-DD>_PROMPT_next_shift.md (${P.name}'s main checkout), ` +
    'starting with a "## Start here" block of 20 lines max (ticket and step, decisions, open questions, what not to redo), ' +
    'then tell Jas exactly: "Handoff written, type /clear."'
  );
}

if (require.main === module) {
  // A call without --project, or with a project whose profile is missing or wrong, prints one warning line and exits 0: a rotation
  // reminder never blocks Jas's prompt (V4-R3). The guard still refuses every tool call of such a lane, so it is noticed at once.
  const i = process.argv.indexOf('--project');
  let P;
  let problem = '';
  try {
    if (i < 0 || process.argv[i + 1] === undefined) throw new Error('the rotation check was started without --project <name>');
    P = require('./guard.cjs').loadProfile(process.argv[i + 1]);
  } catch (e) {
    problem = e.message;
  }
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    if (problem) {
      process.stdout.write(`[rig] WARNING: ${problem}, so there is no rotation check in this session. The hook is node ${RIG}/context-check.cjs --project <name>; tell Jas (a lane started before v4 has to be restarted).\n`);
      return;
    }
    try {
      const { transcript_path } = JSON.parse(raw);
      const msg = warning(lastContextTokens(fs.readFileSync(transcript_path, 'utf8')), LIMIT, P);
      if (msg) process.stdout.write(msg + '\n');
    } catch {
      // never block Jas's message over a rotation check
    }
  });
}

module.exports = { lastContextTokens, warning };
