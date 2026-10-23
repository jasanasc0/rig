#!/usr/bin/env node
'use strict';
// Prints only the last complete report block from a lane's screen (the rig README, The loop for a ticket).
// Usage: herdr agent read <seat> --source recent-unwrapped --lines 400 | node <rig>/report.cjs --ticket EX-<n>
const START = /^[\s●⏺•*>|-]*=== REPORT ===\s*$/;
const END = /^[\s●⏺•*>|-]*=== END ===\s*$/;

// Only the LAST start marker counts: an unfinished newest block must never fall back to an older one.
function extractReport(screen, ticket) {
  const lines = String(screen).split(/\r?\n/);
  let s = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (START.test(lines[i])) {
      s = i;
      break;
    }
  }
  if (s === -1) return null;
  const e = lines.slice(s + 1).findIndex((l) => END.test(l));
  if (e === -1) return null;
  const body = lines
    .slice(s + 1, s + 1 + e)
    .map((l) => l.replace(/^\s{1,2}/, ''))
    .join('\n')
    .trim();
  if (ticket && !new RegExp('^Ticket:\\s*' + String(ticket).replace(/[^\w-]/g, '') + '\\b', 'im').test(body)) return null;
  return body;
}

if (require.main === module) {
  const i = process.argv.indexOf('--ticket');
  const ticket = i > -1 ? process.argv[i + 1] : '';
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    const report = extractReport(raw, ticket);
    if (report === null) {
      process.stderr.write(`no complete === REPORT === ... === END === block${ticket ? ' for ' + ticket : ''} on this screen\n`);
      process.exitCode = 3;
      return;
    }
    process.stdout.write(report + '\n');
  });
}

module.exports = { extractReport };
