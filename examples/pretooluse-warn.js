#!/usr/bin/env node
'use strict';
// Example: a COMPLETE PreToolUse hook that warns the user (without blocking)
// when the context window is at or over a threshold.
//
// Claude Code calls a PreToolUse hook with the hook payload on stdin (it includes
// session_id). This hook reads the latest telemetry that the statusline wrapper
// captured for that session, and if the reading is FRESH and contextPct is at or
// over THRESHOLD, it prints a one-line warning to stderr (which the user sees).
// It NEVER blocks the tool: it always exits 0. (A PreToolUse hook would block by
// exiting 2; this one deliberately does not.)
//
// NOTE: as written it warns on EVERY tool call while over the threshold (the
// matcher is "*"). If that is too noisy, tighten the matcher in settings.json or
// add your own throttling (e.g. warn once per N seconds or per session).
//
// Wire it in ~/.claude/settings.json (use an absolute path to THIS file):
//
//   {
//     "hooks": {
//       "PreToolUse": [
//         {
//           "matcher": "*",
//           "hooks": [
//             {
//               "type": "command",
//               "command": "node /absolute/path/to/cc-context-telemetry/examples/pretooluse-warn.js"
//             }
//           ]
//         }
//       ]
//     }
//   }
//
// This file requires the lib via a relative path so it runs straight from the
// repo. An npm-installed consumer would instead use:
//   const { readTelemetry } = require('cc-context-telemetry');
const { readTelemetry } = require('../index.js');
const fs = require('fs');

// Warn at or above this context percentage. Tune to taste.
const THRESHOLD = 85;

// Read the hook payload from stdin. Never throw.
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function parse(raw) {
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

const payload = parse(readStdin());
const sessionId = (payload && payload.session_id) || 'default';

try {
  const t = readTelemetry(sessionId);
  // Act only on a fresh reading with a real percentage at or over the threshold.
  if (t && t.fresh && typeof t.contextPct === 'number' && t.contextPct >= THRESHOLD) {
    process.stderr.write(
      'cc-context-telemetry: context at ' + Math.round(t.contextPct) +
      '% (>= ' + THRESHOLD + '%). Consider wrapping up or checkpointing soon.\n'
    );
  }
} catch (e) {
  // Best-effort warning only; never let it affect the tool call.
}

// ALWAYS exit 0: warn, never block.
process.exit(0);
