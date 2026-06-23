'use strict';
// cc-context-telemetry - consumer API.
//
// Claude Code hooks and plugins cannot see context fullness or rate limits. The
// ONLY place Claude Code exposes the AUTHORITATIVE context_window /
// rate_limits is the statusLine command. The statusline wrapper (bin/statusline.js)
// captures that telemetry and writes it to a per-session file. This module is the
// reader: a hook calls readTelemetry(sessionId) to get the latest reading.
//
// CONTRACT: never throws. readTelemetry returns a normalized object or null.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Telemetry directory. Default ~/.claude/cc-context-telemetry/, override via
// env CCT_DIR (tests point this at a temp dir).
function telemetryDir() {
  return process.env.CCT_DIR || path.join(os.homedir(), '.claude', 'cc-context-telemetry');
}

// Sanitize a session id into a safe filename component. A real Claude Code
// session_id is a UUID, so legit ids pass through unchanged; a hostile id like
// "../../tmp/evil" or "a/b" cannot escape telemetryDir() because every character
// outside [A-Za-z0-9_-] (dots and slashes included) becomes "_", killing ".."
// and path separators. Empty result falls back to "default".
function sanitizeId(sessionId) {
  const s = String(sessionId == null ? '' : sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return s.length ? s : 'default';
}

function telemetryPath(sessionId) {
  const dir = telemetryDir();
  const safe = sanitizeId(sessionId);
  const p = path.join(dir, 'telemetry-' + safe + '.json');
  // Belt-and-suspenders: if the resolved path is not strictly inside the
  // telemetry dir, fall back to the sanitized-default path. With sanitizeId this
  // never triggers, but it guarantees containment even if sanitizeId regresses.
  const prefix = path.resolve(dir) + path.sep;
  if (!(path.resolve(p) + path.sep).startsWith(prefix)) {
    return path.join(dir, 'telemetry-default.json');
  }
  return p;
}

function ensureDir() {
  try { fs.mkdirSync(telemetryDir(), { recursive: true }); } catch (e) {}
}

function nowIso() { return new Date().toISOString(); }

// Default freshness window in seconds. Override via env CCT_TTL_SEC or opts.ttlSec.
const DEFAULT_TTL_SEC = 120;

// Resolve the freshness TTL. An override (opts.ttlSec or env CCT_TTL_SEC) is
// honored ONLY when it is a finite number strictly greater than 0; "" (-> 0),
// 0, negatives, and NaN all fall back to the default so freshness is never
// silently disabled by a blank or bad value.
function ttlFrom(opts) {
  if (opts && opts.ttlSec != null && opts.ttlSec !== '') {
    const o = Number(opts.ttlSec);
    if (isFinite(o) && o > 0) return o;
  }
  if (process.env.CCT_TTL_SEC != null && process.env.CCT_TTL_SEC !== '') {
    const env = Number(process.env.CCT_TTL_SEC);
    if (isFinite(env) && env > 0) return env;
  }
  return DEFAULT_TTL_SEC;
}

// Write a raw telemetry object for a session. Best-effort, never throws. The
// wrapper uses this; exported so a consumer can stub telemetry in tests.
function writeTelemetry(sessionId, obj) {
  ensureDir();
  try {
    fs.writeFileSync(telemetryPath(sessionId), JSON.stringify(obj));
    return true;
  } catch (e) { return false; }
}

// Read the latest telemetry reading for a session. Returns a normalized object
// or null when absent / unreadable. NEVER throws.
//
//   {
//     sessionId, contextPct, usedPercentage, windowSize,
//     fiveHourPct?, sevenDayPct?, model, ts, source, fresh
//   }
//
// `fresh` is true only when contextPct is a finite number AND ts is within the
// TTL, rejecting BOTH stale and far-future timestamps (Math.abs of the age).
function readTelemetry(sessionId, opts) {
  let raw;
  try {
    raw = fs.readFileSync(telemetryPath(sessionId), 'utf8');
  } catch (e) { return null; }

  let d;
  try { d = JSON.parse(raw); } catch (e) { return null; }
  if (!d || typeof d !== 'object') return null;

  const ttl = ttlFrom(opts);
  const contextPct = (typeof d.context_pct === 'number') ? d.context_pct : null;

  let fresh = false;
  if (typeof contextPct === 'number' && isFinite(contextPct) && typeof d.ts === 'string') {
    const t = Date.parse(d.ts);
    if (isFinite(t)) {
      const ageSec = (Date.now() - t) / 1000;
      // Reject stale (age > ttl) AND far-future (age < -ttl) timestamps; a small
      // clock skew within the TTL is tolerated either way.
      fresh = Math.abs(ageSec) <= ttl;
    }
  }

  return {
    sessionId: (typeof d.session_id === 'string') ? d.session_id : (sessionId || 'default'),
    contextPct: contextPct,
    usedPercentage: (typeof d.used_percentage === 'number') ? d.used_percentage : contextPct,
    windowSize: (typeof d.context_window_size === 'number') ? d.context_window_size : null,
    fiveHourPct: (typeof d.five_hour_pct === 'number') ? d.five_hour_pct : undefined,
    sevenDayPct: (typeof d.seven_day_pct === 'number') ? d.seven_day_pct : undefined,
    model: (typeof d.model === 'string') ? d.model : null,
    ts: (typeof d.ts === 'string') ? d.ts : null,
    source: (typeof d.source === 'string') ? d.source : null,
    fresh: fresh,
  };
}

module.exports = {
  readTelemetry,
  writeTelemetry,
  telemetryDir,
  telemetryPath,
  nowIso,
  DEFAULT_TTL_SEC,
};
