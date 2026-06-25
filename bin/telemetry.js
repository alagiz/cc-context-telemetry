#!/usr/bin/env node
'use strict';
// cc-context-telemetry - telemetry READER (CLI).
//
// HISTORY: this file used to be a per-render WRITER that the statusLine entry
// spawned every render to parse the payload and write the parsed telemetry file.
// That per-render Node spawn, across many concurrent sessions at high render
// frequency, piled up machine load. The fix moved ALL parsing off the hot path:
// the statusLine entry (bin/cct-statusline) is now PURE SHELL and only writes the
// RAW payload, and parsing happens ON DEMAND in index.js when a hook reads. This
// file is now a thin CLI READER over that on-demand parse - it spawns nothing, runs
// only when a human/script invokes it, and never touches the per-render hot path.
//
// Usage:
//   node bin/telemetry.js <session-id>
//   echo '{"session_id":"<id>"}' | node bin/telemetry.js
//
// Reads the session id from argv[2], or (absent) from a hook-style JSON on stdin
// (its session_id field), then prints readTelemetry(sessionId) as pretty JSON, or
// "no telemetry for <id>" when there is no reading. NEVER throws.
const fs = require('fs');
const { readTelemetry } = require('../index.js');

function sessionFromStdin() {
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
  process.stderr.write('usage: node bin/telemetry.js <session-id>\n');
  process.exit(1);
}

let t = null;
try { t = readTelemetry(sessionId); } catch (e) { t = null; }
if (!t) {
  process.stdout.write('no telemetry for ' + sessionId + '\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify(t, null, 2) + '\n');
process.exit(0);
