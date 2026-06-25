#!/usr/bin/env node
'use strict';
// Example: print the latest telemetry object for a session as pretty JSON.
//
// Useful for the manual live check: after wiring the statusline wrapper and
// sending one message in a session, run this with that session id to see what the
// wrapper captured.
//
// Usage:
//   node examples/print-telemetry.js <session-id>
//   echo '{"session_id":"<id>"}' | node examples/print-telemetry.js
//
// It reads the session id from argv[2], or (if absent) from a hook-style JSON on
// stdin (the session_id field). It prints the readTelemetry object as pretty JSON,
// or "no telemetry for <id>" when there is no reading.
//
// Requires the lib via a relative path so it runs straight from the repo. An
// npm-installed consumer would use require('cc-context-telemetry').
const { readTelemetry } = require('../index.js');
const fs = require('fs');

function sessionFromStdin() {
  // Only read stdin when it is not a TTY, so an interactive run does not hang.
  if (process.stdin.isTTY) return null;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    const d = JSON.parse(raw);
    return (d && typeof d.session_id === 'string') ? d.session_id : null;
  } catch (e) { return null; }
}

const sessionId = process.argv[2] || sessionFromStdin();
if (!sessionId) {
  process.stderr.write('usage: node print-telemetry.js <session-id>\n');
  process.exit(1);
}

const t = readTelemetry(sessionId);
if (!t) {
  process.stdout.write('no telemetry for ' + sessionId + '\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify(t, null, 2) + '\n');
process.exit(0);
