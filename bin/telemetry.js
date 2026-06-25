#!/usr/bin/env node
'use strict';
// cc-context-telemetry - telemetry writer (the SAFE half of the bridge).
//
// Claude Code invokes the configured statusLine command with the session JSON on
// stdin. The statusLine is the ONE place Claude Code computes the AUTHORITATIVE
// context_window.context_window_size / used_percentage and the Pro/Max rate_limits,
// correctly, for every model + plan + window. Hooks and plugins receive NONE of it.
// This script reads that payload and persists a per-session telemetry snapshot that
// hooks can read (via index.js readTelemetry).
//
// It does ONE thing and then exits: parse stdin, write the telemetry file, and -
// ONLY when no wrapped statusline is configured (CCT_WRAP unset) - print a minimal
// standalone bar. It NEVER spawns a child process. Running the user's existing
// statusline is the job of the shell entry (bin/cct-statusline), which EXECs it so
// Claude Code manages it exactly like a direct statusLine. (Earlier versions spawned
// the wrapped command from here as a detached child; because Claude Code kills the
// statusline process every render to bound it, that left the heavy wrapped command
// alive each render - a process pile-up. EXEC, not spawn, is the fix.)
//
// CONTRACT / INVARIANTS:
//   - Never throw; a telemetry-write failure must not affect output.
//   - Never spawn anything; this process has no children and self-terminates in ms.
//   - In standalone mode (no CCT_WRAP) print a minimal bar and exit 0; in wrap mode
//     print NOTHING (the EXEC'd statusline prints the real bar) and exit 0.
//   - No per-model / per-plan / per-window assumptions: every field is read straight
//     from the payload (omit, never fabricate, what is absent).
const fs = require('fs');
const path = require('path');
const tel = require('../index.js');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function parse(raw) {
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

const raw = readStdin();
const d = parse(raw);

// OPT-IN raw payload dump (env CCT_DEBUG truthy). Best-effort, never throws, never
// affects output. Treat "", "0", "false", "off", "no" (case-insensitive) as OFF.
function isTruthyEnv(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return true;
}
if (isTruthyEnv(process.env.CCT_DEBUG)) {
  try {
    tel.ensureDir();
    fs.writeFileSync(path.join(tel.telemetryDir(), 'debug-statusline.json'), raw);
  } catch (e) { /* best-effort */ }
}

// Parse the AUTHORITATIVE fields. context_window_size / used_percentage are computed
// by Claude Code for the active model+plan; rate_limits is Pro/Max OAuth ONLY and is
// OMITTED for API-key / Bedrock / Vertex. used_percentage is null before the first
// API response and right after a compaction. Never coerce a missing field to 0.
const cw = (d && d.context_window) || {};
const ctxPct = (typeof cw.used_percentage === 'number') ? cw.used_percentage : null;
const windowSize = (typeof cw.context_window_size === 'number') ? cw.context_window_size : null;
const rl = (d && d.rate_limits) || null;
const fiveH = (rl && rl.five_hour && typeof rl.five_hour.used_percentage === 'number')
  ? rl.five_hour.used_percentage : undefined;
const sevenD = (rl && rl.seven_day && typeof rl.seven_day.used_percentage === 'number')
  ? rl.seven_day.used_percentage : undefined;
const model = (d && d.model && typeof d.model.id === 'string') ? d.model.id : null;
const sessionId = (d && d.session_id) || 'default';

// Persist telemetry. five_hour_pct / seven_day_pct are OMITTED when absent (not
// written as 0). Never throws.
try {
  const out = {
    session_id: sessionId,
    context_pct: ctxPct,
    used_percentage: ctxPct,
    context_window_size: windowSize,
    model: model,
    ts: tel.nowIso(),
    source: 'statusline',
  };
  if (typeof fiveH === 'number') out.five_hour_pct = fiveH;
  if (typeof sevenD === 'number') out.seven_day_pct = sevenD;
  tel.writeTelemetry(sessionId, out);
} catch (e) { /* telemetry is best-effort; never affect output */ }

// In WRAP mode (CCT_WRAP set) the shell entry will EXEC the user's statusline, which
// prints the real bar - so print NOTHING here to avoid a double bar. In STANDALONE
// mode (no CCT_WRAP) print a minimal own bar so the segment is never blank. Plain
// text only, no emoji (project rule). Always exit 0.
function hasWrap() {
  const w = process.env.CCT_WRAP;
  return typeof w === 'string' && w.trim().length > 0;
}
if (!hasWrap()) {
  function pct(p) { return (typeof p === 'number') ? Math.round(p) + '%' : '--'; }
  const parts = ['ctx ' + pct(ctxPct)];
  if (typeof fiveH === 'number') parts.push('5h ' + pct(fiveH));
  if (typeof sevenD === 'number') parts.push('7d ' + pct(sevenD));
  try { process.stdout.write(parts.join(' | ')); }
  catch (e) { try { process.stdout.write('ctx --'); } catch (e2) {} }
}
process.exit(0);
