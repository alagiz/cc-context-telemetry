#!/usr/bin/env node
'use strict';
// cc-context-telemetry - statusLine wrapper (the telemetry bridge).
//
// Claude Code invokes the configured statusLine command with the session JSON on
// stdin. The statusLine is the ONE place Claude Code computes the AUTHORITATIVE
// context_window.context_window_size / used_percentage and the Pro/Max
// rate_limits, correctly, for every model + plan + window. Hooks and plugins
// receive NONE of that. So this wrapper reads the payload, persists a per-session
// telemetry snapshot that hooks can read (via index.js readTelemetry), and passes
// the SAME stdin through to the user's ORIGINAL statusline command (env CCT_WRAP)
// so they keep their own bar.
//
// CONTRACT / INVARIANTS:
//   - Never throw; a telemetry-write failure must not affect output.
//   - Never blank the bar: always print SOMETHING, and exit 0 when standalone.
//   - PASS-THROUGH (env CCT_WRAP = the user's original command): run it with the
//     SAME captured stdin, forward its stdout VERBATIM, propagate ITS exit code.
//     A SIGKILL-bounded timeout (env CCT_WRAP_TIMEOUT_MS, default 5000) guards a
//     hanging child. On any wrap error or empty output, fall through to a minimal
//     standalone bar rather than blanking.
//   - No per-model / per-plan / per-window assumptions: every field is read
//     straight from the payload (omit, never fabricate, what is absent).
const { spawnSync } = require('child_process');
const fs = require('fs');
const tel = require('../index.js');

// Read raw stdin ONCE and keep the exact string: we both parse it for telemetry
// and re-pipe it byte-for-byte to the wrapped command. Never throws.
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function parse(raw) {
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

const raw = readStdin();
const d = parse(raw);

// Parse the AUTHORITATIVE fields. context_window_size and used_percentage are
// computed by Claude Code for the active model+plan; rate_limits is Pro/Max OAuth
// ONLY and is OMITTED entirely for API-key / Bedrock / Vertex. used_percentage is
// null before the first API response and right after a compaction. We never coerce
// a missing field to 0 - absence is signalled by null/undefined so a hook can
// distinguish "no signal" from "0%".
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
// written as 0), so a hook only ever sees a usage % when Claude Code actually
// reported one. Never throws.
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

// PASS-THROUGH: run the user's original statusline command with the SAME stdin,
// forward its stdout verbatim, propagate its exit code. On any error / timeout /
// empty output, fall through to the standalone bar (never blank).
const wrap = process.env.CCT_WRAP;
if (wrap && String(wrap).trim()) {
  try {
    const wrapTimeout = Number(process.env.CCT_WRAP_TIMEOUT_MS);
    const r = spawnSync(wrap, {
      input: raw,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: isFinite(wrapTimeout) && wrapTimeout > 0 ? wrapTimeout : 5000,
      killSignal: 'SIGKILL',
    });
    const childOut = (r && typeof r.stdout === 'string') ? r.stdout : '';
    // Propagate the child's exit code WHEN it produced a bar (stdout). If the
    // wrapped command broke - a spawn error, a TIMEOUT (r.error, status null,
    // empty stdout after SIGKILL), OR a non-zero exit with NO output (e.g.
    // command-not-found 127) - do NOT blank the bar over our wrapper.
    const status = (r && typeof r.status === 'number') ? r.status : 0;
    // EMPTY child stdout is ALWAYS "broke", regardless of exit status: a wrapped
    // command that exits 0 but prints nothing (e.g. `true`, or one that writes
    // only to stderr) must NOT blank the bar - fall through to the standalone bar.
    const broke = !r || r.error || childOut.length === 0 || (status !== 0 && childOut.length === 0);
    if (!broke) { process.stdout.write(childOut); process.exit(status); }
    // Broke but still printed something: forward it and exit 0. Printed nothing
    // (timeout / spawn error): fall through to the standalone bar below.
    if (childOut.length > 0) { process.stdout.write(childOut); process.exit(0); }
  } catch (e) {
    // Could not even spawn: fall through to the standalone bar (never blank).
  }
}

// STANDALONE segment (no wrapper configured, or it produced nothing): render a
// minimal own bar so a standalone install shows something. Plain text ONLY, no
// emoji (the project rule forbids emoji everywhere, including statusline output).
// Always print SOMETHING; always exit 0.
function pct(p) { return (typeof p === 'number') ? Math.round(p) + '%' : '--'; }
const parts = ['ctx ' + pct(ctxPct)];
if (typeof fiveH === 'number') parts.push('5h ' + pct(fiveH));
if (typeof sevenD === 'number') parts.push('7d ' + pct(sevenD));
try { process.stdout.write(parts.join(' | ')); }
catch (e) { try { process.stdout.write('ctx --'); } catch (e2) {} }
process.exit(0);
