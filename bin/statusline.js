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
//   - PROCESS-GROUP CONTAINMENT: the wrapped command is a shell string that may
//     itself spawn children (a user's statusline often shells out). It runs in its
//     OWN process group (detached), and on timeout / overflow we SIGKILL the WHOLE
//     group, not just the shell. spawnSync's timeout only kills the direct child,
//     which orphans grandchildren; across many renders x sessions those orphans
//     accumulate into a fork-bomb. This is why this wrapper MUST use group-kill.
//   - No per-model / per-plan / per-window assumptions: every field is read
//     straight from the payload (omit, never fabricate, what is absent).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
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

// OPT-IN raw payload dump. When env CCT_DEBUG is truthy, write the EXACT raw
// stdin string (overwriting each call, so the file is always the latest real
// payload) to <CCT_DIR>/debug-statusline.json. This lets a user inspect the real
// statusline payload shape when telemetry comes back null. Best-effort ONLY:
// wrapped in try/catch, never throws, never affects the bar output or exit code,
// never blocks. Off by default - no file is written unless CCT_DEBUG is set.
//
// Truthiness: env vars are always non-empty strings, so a bare `if (env)` would
// treat CCT_DEBUG=0 / false / off as ON. Treat "", "0", "false", "off", "no"
// (case-insensitive, trimmed) as OFF; everything else (e.g. "1", "true", "yes")
// is ON.
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
  } catch (e) { /* debug dump is best-effort; never affect output */ }
}

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

// STANDALONE segment (no wrapper configured, or it produced nothing): render a
// minimal own bar so a standalone install shows something. Plain text ONLY, no
// emoji (the project rule forbids emoji everywhere, including statusline output).
// Always print SOMETHING; always exit 0.
function renderStandalone() {
  function pct(p) { return (typeof p === 'number') ? Math.round(p) + '%' : '--'; }
  const parts = ['ctx ' + pct(ctxPct)];
  if (typeof fiveH === 'number') parts.push('5h ' + pct(fiveH));
  if (typeof sevenD === 'number') parts.push('7d ' + pct(sevenD));
  try { process.stdout.write(parts.join(' | ')); }
  catch (e) { try { process.stdout.write('ctx --'); } catch (e2) {} }
  process.exit(0);
}

function wrapTimeoutMs() {
  const t = Number(process.env.CCT_WRAP_TIMEOUT_MS);
  return (isFinite(t) && t > 0) ? t : 5000;
}

// Run the wrapped command in its OWN process group and SIGKILL the WHOLE group on
// timeout / overflow, so a slow command that spawned children leaves NO orphans.
// Calls done(childOut, status, broke) EXACTLY once, and GUARANTEES the wrapper
// eventually exits even if a wrapped command daemonizes and holds our stdout pipe
// open. Never throws.
function runWrap(wrap, input, timeoutMs, done) {
  const MAXBUF = 10 * 1024 * 1024;
  let child;
  try {
    child = spawn(wrap, {
      shell: true,
      // detached => the shell leads a NEW process group, so process.kill(-pid, ...)
      // reaps the shell AND every child it spawned that STAYS in the group (the
      // common case for a statusline that shells out).
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    return done('', 0, true);
  }
  if (!child || typeof child.pid !== 'number') {
    return done('', 0, true);
  }

  let out = '';
  let settled = false;
  let killedByUs = false;
  let exitCode = 0;

  function killGroup() {
    // SIGKILL the whole process group (negative pid); fall back to the lone child
    // where there are no POSIX groups (Windows). A wrapped command that DELIBERATELY
    // daemonizes (setsid / double-fork) moves into its OWN session and escapes this -
    // by OS design, and identical to running that command as the statusline directly.
    // We cannot, and should not, kill a process that detached itself. What we DO
    // guarantee is that THIS wrapper always exits (see settle + the hard deadline).
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
  }

  function settle(status, broke) {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimer);
    // done() force-exits via process.exit(); any stdout fd a re-parented grandchild
    // still holds open cannot keep us alive past that, so the wrapper never hangs.
    done(out, status, broke);
  }

  // HARD DEADLINE - intentionally NOT unref'd, so it ALWAYS fires and SETTLES (not
  // merely kills) even if every other handle is gone. A daemonizing wrapped command
  // can hold the stdout pipe open so 'close' never fires; a design that only killed
  // here, or that relied on 'close' alone, would freeze the bar forever. This
  // backstop guarantees we kill the group AND exit.
  const hardTimer = setTimeout(function () {
    killedByUs = true;
    killGroup();
    settle(0, true);
  }, timeoutMs);

  child.on('error', function () { settle(0, true); });

  if (child.stdout) {
    child.stdout.on('error', function () {});
    child.stdout.on('data', function (chunk) {
      if (out.length >= MAXBUF) return;
      out += chunk.toString('utf8');
      if (out.length >= MAXBUF) { killedByUs = true; killGroup(); settle(0, true); }
    });
  }

  // 'exit' fires when the DIRECT child (the shell) terminates, INDEPENDENT of any
  // stdout fd a grandchild may still hold. 'close' (full stdout drain) is preferred
  // when it arrives promptly; otherwise a short grace settles us so a pipe-holding
  // escapee cannot wedge the bar until the hard deadline.
  child.on('exit', function (code) {
    exitCode = (typeof code === 'number') ? code : 0;
    const grace = setTimeout(function () {
      settle(exitCode, killedByUs || out.length === 0);
    }, 200);
    if (grace && typeof grace.unref === 'function') grace.unref();
  });
  child.on('close', function (code) {
    if (typeof code === 'number') exitCode = code;
    // EMPTY child stdout is ALWAYS "broke", regardless of exit status: a wrapped
    // command that exits 0 but prints nothing (e.g. `true`) must NOT blank the bar.
    // A timeout/overflow kill (killedByUs) is likewise broke.
    settle(exitCode, killedByUs || out.length === 0);
  });

  // Feed the SAME captured stdin, then close it. Never let a broken pipe throw.
  try {
    if (child.stdin) {
      child.stdin.on('error', function () {});
      child.stdin.write(input);
      child.stdin.end();
    }
  } catch (e) { /* child may have already exited; exit/close/deadline cover it */ }
}

// PASS-THROUGH: run the user's original statusline command with the SAME stdin,
// forward its stdout verbatim, propagate its exit code. On any error / timeout /
// empty output, fall through to the standalone bar (never blank).
const wrap = process.env.CCT_WRAP;
if (wrap && String(wrap).trim()) {
  runWrap(wrap, raw, wrapTimeoutMs(), (childOut, status, broke) => {
    // Produced a real bar and exited cleanly: forward it, propagate exit code.
    if (!broke) { try { process.stdout.write(childOut); } catch (e) {} return process.exit(status); }
    // Broke but still printed something: forward it and exit 0.
    if (childOut && childOut.length > 0) { try { process.stdout.write(childOut); } catch (e) {} return process.exit(0); }
    // Printed nothing (timeout / spawn error / empty): fall through to standalone.
    renderStandalone();
  });
} else {
  renderStandalone();
}
