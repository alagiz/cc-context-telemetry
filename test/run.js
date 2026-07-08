'use strict';
// Bounded test runner for cc-context-telemetry (PURE-SHELL entry + on-demand reader).
// Every test uses a temp CCT_DIR so the real telemetry dir is never touched. Nothing
// here calls `claude` or scans a binary; spawned children are tiny inline node/sh
// stubs, all bounded by short timeouts and cleaned up (no leaked processes).
//
// ARCHITECTURE UNDER TEST:
//   bin/cct-statusline  - PURE SHELL. Per render: reads stdin, extracts+sanitizes the
//                         session_id, ATOMICALLY writes the RAW payload to
//                         telemetry-raw-<sid>.json, then EITHER execs CCT_WRAP OR
//                         prints a minimal shell-extracted bar. NO Node on this path.
//   index.js            - readTelemetry(sid): reads + parses the raw file ON DEMAND,
//                         prunes stale/excess raw files (throttled, off the hot path).
//   bin/telemetry.js    - on-demand CLI READER over readTelemetry (NOT in hot path).
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'cct-statusline');   // the pure-shell entry
const READER = path.join(ROOT, 'bin', 'telemetry.js');    // the on-demand CLI reader

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e) { fail++; console.log('FAIL - ' + name + '\n       ' + (e && e.message)); }
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-')); }

// Run the shell ENTRY with a stub payload on stdin (which CLOSES, as Claude Code
// does) and the given env. Bounded by a short timeout.
function runEntry(payload, env) {
  return spawnSync('/bin/sh', [ENTRY], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
}
// Run the on-demand CLI reader.
function runReader(args, env, input) {
  return spawnSync(process.execPath, [READER].concat(args || []), {
    input: input,
    encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
}
// Read the RAW per-session payload file the entry wrote.
function rawFile(dir, sid) {
  return fs.readFileSync(path.join(dir, 'telemetry-raw-' + sid + '.json'), 'utf8');
}
const api = require('../index.js');

// ============================================================================
// (1) RAW WRITE: the entry writes telemetry-raw-<sid>.json verbatim, atomically
// ============================================================================

test('entry writes the RAW payload verbatim to telemetry-raw-<sid>.json', function () {
  const dir = tmpDir();
  const payload = '{"session_id":"s-raw","context_window":{"used_percentage":47.2,"context_window_size":200000},"extra":"keep me"}';
  const r = runEntry(payload, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(rawFile(dir, 's-raw'), payload, 'raw file is byte-identical to stdin');
});

test('atomic write leaves NO leftover .tmp files in the dir', function () {
  const dir = tmpDir();
  runEntry('{"session_id":"s-tmp","context_window":{"used_percentage":1}}', { CCT_DIR: dir });
  const files = fs.readdirSync(dir);
  assert.ok(files.every(function (f) { return f.slice(-4) !== '.tmp'; }),
    'no .tmp litter: ' + JSON.stringify(files));
  assert.deepStrictEqual(files, ['telemetry-raw-s-tmp.json']);
});

// ============================================================================
// (2) ON-DEMAND PARSE round-trip across payload shapes (full / null / missing /
//     malformed) via the entry + index.js readTelemetry
// ============================================================================

test('round-trip FULL Pro/Max payload (rate_limits + 200k window)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-pro', context_window: { used_percentage: 47.2, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1783359600 },
      seven_day: { used_percentage: 30, resets_at: 1783368000 } },
    model: { id: 'claude-opus-4-1' } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-pro');
  assert.ok(t);
  assert.strictEqual(t.contextPct, 47.2);
  assert.strictEqual(t.usedPercentage, 47.2);
  assert.strictEqual(t.windowSize, 200000);
  assert.strictEqual(t.fiveHourPct, 12);
  assert.strictEqual(t.sevenDayPct, 30);
  assert.strictEqual(t.fiveHourResetsAt, 1783359600, 'reset epoch surfaced for hooks');
  assert.strictEqual(t.sevenDayResetsAt, 1783368000);
  assert.strictEqual(t.model, 'claude-opus-4-1');
  assert.strictEqual(t.source, 'statusline');
  assert.strictEqual(t.fresh, true, 'a just-written raw file is fresh');
  delete process.env.CCT_DIR;
});

// ============================================================================
// (2b) RESET EPOCHS in the consumer API: readTelemetry/parsePayload surface
// fiveHourResetsAt / sevenDayResetsAt (Unix epoch), verbatim passthrough, omitted
// when absent - exactly like the percentages. For hooks that gate on reset timing.
// ============================================================================

test('parsePayload surfaces fiveHourResetsAt / sevenDayResetsAt verbatim', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1783359600 },
      seven_day: { used_percentage: 30, resets_at: 1783368000 } } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, 1783359600);
  assert.strictEqual(p.sevenDayResetsAt, 1783368000);
});

test('reset epochs OMITTED (undefined) when resets_at absent, like the percentages', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, undefined);
  assert.strictEqual(p.sevenDayResetsAt, undefined);
  assert.strictEqual('fiveHourResetsAt' in p, true, 'key present with undefined value, like fiveHourPct');
});

test('reset epochs OMITTED when NO rate_limits at all (API-key / Bedrock / Vertex)', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 60 } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, undefined);
  assert.strictEqual(p.sevenDayResetsAt, undefined);
});

test('reset epoch surfaced per-window independently (5h has it, 7d does not)', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1783359600 },
      seven_day: { used_percentage: 30 } } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, 1783359600);
  assert.strictEqual(p.sevenDayResetsAt, undefined);
});

test('non-numeric resets_at (string / null) -> undefined, never a bogus value', function () {
  const pStr = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: '1783359600' } } }, 's');
  assert.strictEqual(pStr.fiveHourResetsAt, undefined, 'string resets_at rejected (typeof check)');
  const pNull = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: null } } }, 's');
  assert.strictEqual(pNull.fiveHourResetsAt, undefined, 'null resets_at rejected');
});

// Plausible-epoch guard: the Node reader must agree with the shell renderer, which
// floors resets_at at a real Unix epoch. A corrupt/hostile raw file must never hand a hook
// a bogus reset time (negative, 0, sub-epoch, absurd far-future) or NaN/Infinity.
test('reset epoch: implausible values rejected, matching the shell renderer', function () {
  const mk = function (r) {
    return api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: r } } }, 's').fiveHourResetsAt;
  };
  assert.strictEqual(mk(-5), undefined, 'negative');
  assert.strictEqual(mk(0), undefined, 'zero');
  assert.strictEqual(mk(12345), undefined, 'below the 1e9 epoch floor');
  assert.strictEqual(mk(999999999), undefined, 'just below 1e9');
  assert.strictEqual(mk(1e15), undefined, 'absurd far-future (the devil-repro 1e15)');
  assert.strictEqual(mk(NaN), undefined, 'NaN fails the range compare');
  assert.strictEqual(mk(Infinity), undefined, 'Infinity fails the range compare');
  assert.strictEqual(mk(1000000000), 1000000000, 'exactly 1e9 accepted (boundary)');
  assert.strictEqual(mk(1783359600), 1783359600, 'a real epoch accepted');
});

// ============================================================================
// (3c) ACCOUNT-WIDE rate limits: the statusline segment shows the FRESHEST 5h/7d
// reading across ALL sessions' raw files (max plausible resets_at, tie-break max
// usage), so open sessions do not diverge on the account-wide limits. ctx stays
// per-session. Deterministic via CCT_NOW + pre-written raw files.
// ============================================================================

const AW_NOW = 1700000000;
function writeRaw(dir, sid, obj) {
  fs.writeFileSync(path.join(dir, 'telemetry-raw-' + sid + '.json'), JSON.stringify(obj));
}
// Render `current` (this session's payload) in a dir seeded with `others` (other sessions).
function awBar(current, others) {
  const dir = tmpDir();
  (others || []).forEach(function (s) { writeRaw(dir, s.sid, s.obj); });
  return runEntry(current, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
}

test('account-wide: 5h shows the FRESHEST reading across sessions, not this/stale one', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 55, resets_at: AW_NOW - 3600 } } },
    [ { sid: 'A', obj: { session_id: 'A', context_window: { used_percentage: 10 },
          rate_limits: { five_hour: { used_percentage: 90, resets_at: AW_NOW - 7200 } } } },
      { sid: 'B', obj: { session_id: 'B', context_window: { used_percentage: 20 },
          rate_limits: { five_hour: { used_percentage: 12, resets_at: AW_NOW + 10800 } } } } ]);
  assert.strictEqual(out, 'ctx 33% | 5h 12% ~3h', 'ctx from THIS session; 5h from freshest (B)');
});

test('account-wide: tie on resets_at -> higher usage wins (latest within the window)', function () {
  const R = AW_NOW + 7200;
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 40, resets_at: R } } },
    [ { sid: 'B', obj: { session_id: 'B', context_window: { used_percentage: 20 },
          rate_limits: { five_hour: { used_percentage: 71, resets_at: R } } } } ]);
  assert.strictEqual(out, 'ctx 33% | 5h 71% ~2h', 'same reset -> max usage (71) wins');
});

test('account-wide: a corrupt far-future resets_at does not win selection', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: AW_NOW + 3600 } } },
    [ { sid: 'X', obj: { session_id: 'X', context_window: { used_percentage: 5 },
          rate_limits: { five_hour: { used_percentage: 99, resets_at: AW_NOW + 5 * 86400 } } } } ]);
  assert.strictEqual(out, 'ctx 33% | 5h 20% ~1h', 'far-future (5d for a 5h window) rejected; legit 1h wins');
});

test('account-wide: all sessions stale -> least-stale usage, countdown honestly ~now', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 60, resets_at: AW_NOW - 7200 } } },
    [ { sid: 'A', obj: { session_id: 'A', context_window: { used_percentage: 10 },
          rate_limits: { five_hour: { used_percentage: 80, resets_at: AW_NOW - 3600 } } } } ]);
  assert.strictEqual(out, 'ctx 33% | 5h 80% ~now', 'newest reset among stale wins; ~now untouched');
});

test('account-wide: ctx is always THIS session, never another', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 7 } },
    [ { sid: 'B', obj: { session_id: 'B', context_window: { used_percentage: 88 },
          rate_limits: { five_hour: { used_percentage: 12, resets_at: AW_NOW + 3600 } } } } ]);
  assert.strictEqual(out, 'ctx 7% | 5h 12% ~1h', 'ctx 7 from THIS session, not 88 from B');
});

test('account-wide: 5h and 7d each pick their own freshest session independently', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 50, resets_at: AW_NOW - 100 },
        seven_day: { used_percentage: 40, resets_at: AW_NOW + 3 * 86400 } } },
    [ { sid: 'B', obj: { session_id: 'B', context_window: { used_percentage: 20 },
          rate_limits: { five_hour: { used_percentage: 15, resets_at: AW_NOW + 7200 } } } } ]);
  assert.strictEqual(out, 'ctx 33% | 5h 15% ~2h | 7d 40% ~3d', '5h freshest from B, 7d from this session');
});

// Regression tests for the review-gate findings on the account-wide pool.

test('account-wide: an unreadable or non-regular pool file is SKIPPED, segment stays intact', function () {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'telemetry-raw-adir.json'));   // a dir matching the glob (non-regular)
  const bad = path.join(dir, 'telemetry-raw-bad.json');
  fs.writeFileSync(bad, '{}'); fs.chmodSync(bad, 0);          // an unreadable file
  const out = runEntry({ session_id: 'C', context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: 20, resets_at: AW_NOW + 3600 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  fs.chmodSync(bad, 0o644);  // restore so the temp entry is not left unreadable
  assert.strictEqual(out, 'ctx 33% | 5h 20% ~1h', 'bad pool entries skipped, not fatal');
});

test('account-wide: the file pool is NOT leaked to CCT_WRAP as positional args', function () {
  const dir = tmpDir();
  writeRaw(dir, 'B', { session_id: 'B', context_window: { used_percentage: 20 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: AW_NOW + 3600 } } });
  const r = runEntry({ session_id: 'C', context_window: { used_percentage: 33 } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW), CCT_WRAP: 'printf "[argc=%s]" "$#"' });
  assert.strictEqual(r.stdout, 'ctx 33% | 5h 12% ~1h [argc=0]', 'CCT_WRAP sees no argv from the glob');
});

test('account-wide: with now unavailable, a corrupt far-future reading cannot win (falls back)', function () {
  const dir = tmpDir();
  writeRaw(dir, 'X', { session_id: 'X', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 99, resets_at: 50000000000 } } });  // corrupt, in [1e9,1e11)
  const out = runEntry({ session_id: 'C', context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: 20, resets_at: AW_NOW + 3600 } } },
    { CCT_DIR: dir, CCT_NOW: 'garbage' }).stdout;  // non-numeric -> now=""
  assert.strictEqual(out, 'ctx 33% | 5h 20%', 'now unset -> this session (20%), not the corrupt 99%, no countdown');
});

test('round-trip 1M window', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-1m', context_window: { used_percentage: 10, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: 5 } }, model: { id: 'claude-sonnet-4-5' } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-1m');
  assert.strictEqual(t.windowSize, 1000000);
  assert.strictEqual(t.fiveHourPct, 5);
  assert.strictEqual(t.sevenDayPct, undefined, '7d omitted when absent');
  delete process.env.CCT_DIR;
});

test('round-trip API-key payload WITHOUT rate_limits omits 5h/7d (never 0)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-api', context_window: { used_percentage: 60, context_window_size: 200000 },
    model: { id: 'claude-opus-4-1' } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-api');
  assert.strictEqual(t.fiveHourPct, undefined);
  assert.strictEqual(t.sevenDayPct, undefined);
  assert.strictEqual(t.contextPct, 60);
  delete process.env.CCT_DIR;
});

test('round-trip used_percentage null -> contextPct null, NOT fresh', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-null', context_window: { used_percentage: null, context_window_size: 200000 } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-null');
  assert.strictEqual(t.contextPct, null);
  assert.strictEqual(t.fresh, false, 'null context is never fresh');
  delete process.env.CCT_DIR;
});

test('round-trip MALFORMED payload -> raw file written, readTelemetry returns null (no throw)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // No session_id in malformed text -> entry falls back to "default" (matching the JS
  // sanitizeId empty-id fallback, so a reader resolves the same filename).
  runEntry('not json at all <<<', { CCT_DIR: dir });
  assert.ok(fs.existsSync(path.join(dir, 'telemetry-raw-default.json')), 'raw still written');
  let threw = false, t;
  try { t = api.readTelemetry(''); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, 'never throws on bad JSON');
  assert.strictEqual(t, null, 'unparseable raw -> null');
  delete process.env.CCT_DIR;
});

test('round-trip EMPTY stdin -> raw file empty, readTelemetry null', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry('', { CCT_DIR: dir });
  // shell empty-id fallback "default" matches JS sanitizeId('') -> "default".
  assert.strictEqual(api.readTelemetry(''), null);
  assert.ok(fs.existsSync(path.join(dir, 'telemetry-raw-default.json')), 'written under default');
  delete process.env.CCT_DIR;
});

test('round-trip partial payload (only session_id) -> contextPct null, fields null/omitted', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-partial' }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-partial');
  assert.ok(t);
  assert.strictEqual(t.contextPct, null);
  assert.strictEqual(t.windowSize, null);
  assert.strictEqual(t.model, null);
  assert.strictEqual(t.fiveHourPct, undefined);
  delete process.env.CCT_DIR;
});

// ============================================================================
// (3) STANDALONE shell bar extraction (incl. NO emoji)
// ============================================================================

test('standalone bar: ctx + 5h + 7d, rounded, no emoji', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-bar', context_window: { used_percentage: 33.4 },
    rate_limits: { five_hour: { used_percentage: 9 }, seven_day: { used_percentage: 21 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'ctx 33% | 5h 9% | 7d 21%');
  // No emoji: every byte is ASCII printable.
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'bar is plain ASCII (no emoji)');
});

test('standalone bar: ctx rounds 47.6 -> 48', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-rnd', context_window: { used_percentage: 47.6 } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 48%');
});

test('standalone bar: null used_percentage -> "ctx --"', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-bn', context_window: { used_percentage: null } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx --');
});

test('standalone bar: ctx present, NO rate_limits -> only ctx segment', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-bo', context_window: { used_percentage: 60, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 60%');
});

test('standalone bar: object scoping - rate_limits has pct but context_window does NOT (no leak)', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-scope', context_window: { context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 99 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx -- | 5h 99%', 'context % must not borrow the rate_limit value');
});

test('standalone bar: malformed/empty stdin -> "ctx --", exit 0', function () {
  const dir = tmpDir();
  assert.strictEqual(runEntry('not json {', { CCT_DIR: dir }).stdout, 'ctx --');
  assert.strictEqual(runEntry('', { CCT_DIR: dir }).stdout, 'ctx --');
});

// ============================================================================
// (3b) RESET COUNTDOWN: "~<time-left>" appended to 5h/7d from resets_at.
// DETERMINISTIC via the CCT_NOW seam (pins "now"); resets_at is now + secondsLeft, so
// every tier boundary is exercised without depending on the wall clock.
// ============================================================================

// Pinned epoch for all countdown tests (via CCT_NOW). Chosen realistic (~2023, well above
// the 1e9 plausible-epoch floor) so "reset just passed" cases (now - gap) stay above the
// floor and correctly render ~now, as they do with real ~1.78e9 epochs.
const NOW = 1700000000;
// Build a payload with a fixed ctx% and optional 5h/7d limits at now+secondsLeft.
function limitsPayload(fiveLeft, sevenLeft) {
  const rl = {};
  if (fiveLeft !== undefined) rl.five_hour = { used_percentage: 44, resets_at: NOW + fiveLeft };
  if (sevenLeft !== undefined) rl.seven_day = { used_percentage: 31, resets_at: NOW + sevenLeft };
  return { session_id: 's-cd', context_window: { used_percentage: 51 }, rate_limits: rl };
}
function bar(fiveLeft, sevenLeft) {
  const dir = tmpDir();
  return runEntry(limitsPayload(fiveLeft, sevenLeft), { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout;
}
const DAY = 86400, HOUR = 3600, MIN = 60;

test('countdown: days+hours tier, trailing hours shown when non-zero (~6d23h)', function () {
  assert.strictEqual(bar(2 * HOUR + 54 * MIN, 6 * DAY + 23 * HOUR + 59 * MIN),
    'ctx 51% | 5h 44% ~2h54m | 7d 31% ~6d23h');
});
test('countdown: days+hours mid-window (~4d8h)', function () {
  assert.strictEqual(bar(undefined, 4 * DAY + 8 * HOUR).replace('ctx 51% | ', ''), '7d 31% ~4d8h');
});
test('countdown: exact day boundary drops the 0h (~5d, never ~5d0h)', function () {
  assert.strictEqual(bar(undefined, 5 * DAY), 'ctx 51% | 7d 31% ~5d');
});
test('countdown: last day switches to hours+minutes (~10h, minutes dropped at 0)', function () {
  assert.strictEqual(bar(undefined, 10 * HOUR), 'ctx 51% | 7d 31% ~10h');
});
test('countdown: hours+minutes tier, minutes zero-dropped (~2h, not ~2h0m)', function () {
  assert.strictEqual(bar(2 * HOUR, undefined), 'ctx 51% | 5h 44% ~2h');
});
test('countdown: hours+minutes with minutes (~2h54m)', function () {
  assert.strictEqual(bar(2 * HOUR + 54 * MIN, undefined), 'ctx 51% | 5h 44% ~2h54m');
});
test('countdown: bare minutes tier under 1h (~44m)', function () {
  assert.strictEqual(bar(44 * MIN, undefined), 'ctx 51% | 5h 44% ~44m');
});
test('countdown: under a minute -> ~<1m', function () {
  assert.strictEqual(bar(30, undefined), 'ctx 51% | 5h 44% ~<1m');
});
test('countdown: at reset (0s) -> ~now', function () {
  assert.strictEqual(bar(0, undefined), 'ctx 51% | 5h 44% ~now');
});
test('countdown: past reset (negative gap) -> ~now, not a negative number', function () {
  assert.strictEqual(bar(-5 * HOUR, undefined), 'ctx 51% | 5h 44% ~now');
});
test('countdown: implausible gap (>8d) is omitted, plain % stays', function () {
  assert.strictEqual(bar(9 * DAY, undefined), 'ctx 51% | 5h 44%');
});
// Per-window horizon caps: the 5h field must never render a multi-day countdown from a
// corrupt/foreign resets_at. 5h cap = 6h (21600s), 7d cap = 8d (691200s).
test('countdown: 5h horizon cap - a >6h 5h gap is omitted (no "~6d" on a five-hour field)', function () {
  assert.strictEqual(bar(6 * HOUR + 60, undefined), 'ctx 51% | 5h 44%');   // just over 6h -> omit
  assert.strictEqual(bar(6 * DAY + 22 * HOUR, undefined), 'ctx 51% | 5h 44%'); // the devil's ~6d22h case
});
test('countdown: 5h horizon cap - a 5h gap right at the window (5h) still shows', function () {
  assert.strictEqual(bar(5 * HOUR, undefined), 'ctx 51% | 5h 44% ~5h');
});
test('countdown: 7d horizon cap - exactly 8d shows, just over 8d omits', function () {
  assert.strictEqual(bar(undefined, 691200), 'ctx 51% | 7d 31% ~8d');
  assert.strictEqual(bar(undefined, 691201), 'ctx 51% | 7d 31%');
});
// Exact tier-crossing boundaries (the neighbors were tested; assert the crossings themselves).
test('countdown: exact tier boundaries (60s->~1m, 3600s->~1h, 86400s->~1d, 7d->~7d)', function () {
  assert.strictEqual(bar(60, undefined), 'ctx 51% | 5h 44% ~1m');
  assert.strictEqual(bar(59, undefined), 'ctx 51% | 5h 44% ~<1m');
  assert.strictEqual(bar(3600, undefined), 'ctx 51% | 5h 44% ~1h');
  assert.strictEqual(bar(undefined, 86400), 'ctx 51% | 7d 31% ~1d');
  assert.strictEqual(bar(undefined, 86399), 'ctx 51% | 7d 31% ~23h59m');
  assert.strictEqual(bar(undefined, 7 * DAY), 'ctx 51% | 7d 31% ~7d');
});
// Fail-soft on malformed resets_at (the devil's misparse cases): never fabricate, omit.
function rawBar(resetsAtLiteral) {
  const dir = tmpDir();
  const p = '{"session_id":"s-cd","context_window":{"used_percentage":51},"rate_limits":' +
    '{"five_hour":{"used_percentage":44,"resets_at":' + resetsAtLiteral + '}}}';
  return runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout;
}
test('countdown: scientific-notation resets_at (1e12) is omitted, NOT fabricated as ~now', function () {
  assert.strictEqual(rawBar('1e12'), 'ctx 51% | 5h 44%');
});
test('countdown: string-valued resets_at ("...") is omitted (digit match blocked by quote)', function () {
  assert.strictEqual(rawBar('"' + (NOW + 2 * HOUR) + '"'), 'ctx 51% | 5h 44%');
});
test('countdown: negative resets_at is omitted (not misread as a positive)', function () {
  assert.strictEqual(rawBar('-5'), 'ctx 51% | 5h 44%');
});
test('countdown: below-epoch-floor resets_at (small int) is omitted, never ~now', function () {
  assert.strictEqual(rawBar('12345'), 'ctx 51% | 5h 44%');
});
test('countdown: resets_at ABSENT -> plain %, no countdown (never fabricated)', function () {
  const dir = tmpDir();
  const p = { session_id: 's-cd', context_window: { used_percentage: 51 },
    rate_limits: { five_hour: { used_percentage: 44 }, seven_day: { used_percentage: 31 } } };
  assert.strictEqual(runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout,
    'ctx 51% | 5h 44% | 7d 31%');
});
test('countdown: resets_at null -> plain % (no match, omitted)', function () {
  const dir = tmpDir();
  const p = { session_id: 's-cd', context_window: { used_percentage: 51 },
    rate_limits: { five_hour: { used_percentage: 44, resets_at: null } } };
  assert.strictEqual(runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout, 'ctx 51% | 5h 44%');
});
test('countdown: non-numeric CCT_NOW disables countdowns, plain % stays', function () {
  const dir = tmpDir();
  assert.strictEqual(runEntry(limitsPayload(2 * HOUR, 3 * DAY), { CCT_DIR: dir, CCT_NOW: 'garbage' }).stdout,
    'ctx 51% | 5h 44% | 7d 31%');
});
test('countdown: both 5h and 7d carry independent countdowns', function () {
  assert.strictEqual(bar(44 * MIN, 3 * DAY + 5 * HOUR),
    'ctx 51% | 5h 44% ~44m | 7d 31% ~3d5h');
});
test('countdown: object scoping - 5h resets_at must not leak into 7d', function () {
  const dir = tmpDir();
  // 7d has a pct but NO resets_at; 5h has one. 7d must stay plain, not borrow 5h.
  const p = { session_id: 's-cd', context_window: { used_percentage: 51 },
    rate_limits: { five_hour: { used_percentage: 44, resets_at: NOW + 2 * HOUR },
      seven_day: { used_percentage: 31 } } };
  assert.strictEqual(runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout,
    'ctx 51% | 5h 44% ~2h | 7d 31%');
});

// ============================================================================
// (4) WRAP-MODE exec passthrough
// ============================================================================

// NEW WRAP BEHAVIOR: wrap mode PREPENDS the telemetry segment, then EXECs the wrapped
// command, so stdout = "<segment> " + wrapped-command-output (one line). The wrapped
// command still gets the EXACT payload on its stdin (fd3), and its exit code still
// propagates (exec). Each test below asserts the same real invariant it always did,
// now accounting for the segment prefix.
test('wrap mode PREPENDS the segment then EXECs CCT_WRAP, prints ITS bar, still writes raw telemetry', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // ctx 5%, NO rate_limits -> segment is "ctx 5%"; wrap prints "MY-REAL-BAR" after it.
  const r = runEntry({ session_id: 'e-wrap', context_window: { used_percentage: 5, context_window_size: 200000 } },
    { CCT_DIR: dir, CCT_WRAP: "printf 'MY-REAL-BAR'" });
  assert.strictEqual(r.stdout, 'ctx 5% MY-REAL-BAR', 'segment prefix + verbatim wrapped output');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(api.readTelemetry('e-wrap').contextPct, 5, 'raw telemetry written under wrap');
  // No emoji: every byte is ASCII printable.
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'wrap output is plain ASCII (no emoji)');
  delete process.env.CCT_DIR;
});

test('wrap mode propagates the wrapped command exit code (segment prepended)', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 'e-exit', context_window: { used_percentage: 1 } },
    { CCT_DIR: dir, CCT_WRAP: "sh -c \"printf BAR; exit 7\"" });
  assert.strictEqual(r.stdout, 'ctx 1% BAR', 'segment prefix + wrapped bar');
  assert.strictEqual(r.status, 7, 'wrapped exit code still propagates through exec');
});

test('wrap mode forwards the EXACT stdin payload to the wrapped command (after the segment prefix)', function () {
  const dir = tmpDir();
  const payload = '{"session_id":"e-stdin","context_window":{"used_percentage":2,"context_window_size":200000},"x":"keep me"}';
  // The wrapped command (cat) echoes its stdin. stdout = "<segment> " + that stdin, so
  // the stdin invariant is asserted by requiring stdout to END WITH the exact payload.
  const r = runEntry(payload, { CCT_DIR: dir, CCT_WRAP: 'cat' });
  assert.strictEqual(r.stdout, 'ctx 2% ' + payload, 'wrapped command got the exact stdin after the segment prefix');
  assert.ok(r.stdout.endsWith(payload), 'stdout ends with the exact, unmodified payload');
});

test('wrap mode with a QUOTED path + args execs it directly (the adtention shape), segment prepended', function () {
  const dir = tmpDir();
  const prog = path.join(dir, 'my status.sh'); // space in path -> must stay quoted
  fs.writeFileSync(prog, '#!/bin/sh\nprintf "arg=%s;" "$1"\ncat\n');
  fs.chmodSync(prog, 0o755);
  const payload = '{"session_id":"e-args","context_window":{"used_percentage":4,"context_window_size":200000}}';
  const r = runEntry(payload, { CCT_DIR: dir, CCT_WRAP: "'" + prog + "' TOKEN" });
  assert.strictEqual(r.stdout, 'ctx 4% arg=TOKEN;' + payload,
    'segment prefix, then quoted path honored, arg passed, exact stdin forwarded');
  assert.ok(r.stdout.endsWith(payload), 'exact payload forwarded on stdin (stdout ends with it)');
  process.env.CCT_DIR = dir;
  assert.strictEqual(api.readTelemetry('e-args').contextPct, 4, 'raw telemetry written');
  delete process.env.CCT_DIR;
});

// SEGMENT EXTRACTION (the bug class that cost a session): the awk objspan pass must read
// context % from a REAL-shaped context_window that nests current_usage BEFORE
// used_percentage, must NOT leak a sibling's value, and must never emit emoji.
test('segment: REAL-shaped context_window nests current_usage BEFORE used_percentage -> correct ctx', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-realshape',
    context_window: { current_usage: { input_tokens: 123, cache_read_input_tokens: 45 },
      used_percentage: 66.4, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 66% | 5h 12% | 7d 30%',
    'ctx read past the nested current_usage; not blank, not the nested value');
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'plain ASCII (no emoji)');
});

test('segment: NO-LEAK - context_window lacks used_percentage but rate_limits has one -> "ctx --", not the rate_limit value', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-noleak',
    context_window: { current_usage: { input_tokens: 1 }, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 77 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx -- | 5h 77%',
    'context % must NOT borrow the rate_limit value across the object boundary');
});

test('segment: 5h/7d come from rate_limits.five_hour / seven_day', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-rl', context_window: { used_percentage: 10, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 55 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 10% | 5h 40% | 7d 55%');
});

test('segment: null used_percentage -> "ctx --"', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-segnull', context_window: { used_percentage: null, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx --');
});

test('segment: full combined "ctx X% | 5h Y% | 7d Z% <wrapped>" in WRAP mode', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-segwrap',
    context_window: { current_usage: { x: 1 }, used_percentage: 66.4, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } } },
    { CCT_DIR: dir, CCT_WRAP: 'printf WRAPPED' });
  assert.strictEqual(r.stdout, 'ctx 66% | 5h 12% | 7d 30% WRAPPED',
    'combined segment prefix then the wrapped bar on the same line');
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'plain ASCII (no emoji)');
});

test('wrap mode that backgrounds (trailing &) does NOT hang the entry', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 'e-bg', context_window: { used_percentage: 1 } },
    { CCT_DIR: dir, CCT_WRAP: "printf BG; sleep 1 &" });
  assert.strictEqual(r.signal, null, 'entry was not killed by the test timeout (did not hang)');
});

// ============================================================================
// (5) REGRESSION: exec (not spawn) - killing the entry tears down the wrapped
//     command. NOTHING orphans. (The pile-up fix, in a shell harness.)
// ============================================================================

test('REGRESSION: killing the entry kills the EXECd wrapped command - no leak', function () {
  // A wrapped command records its pid then sleeps. Under the OLD spawn model the
  // wrapper spawned this DETACHED, so killing the wrapper (as Claude Code does every
  // render) left it alive -> a per-render pile-up. The exec model makes the wrapped
  // command BE the process, so killing the entry kills it. The liveness check runs in
  // a SHELL harness (shell reaps killed jobs cleanly; a Node poll would see a zombie
  // as "alive", a false leak).
  const dir = tmpDir();
  const pidfile = path.join(dir, 'wrapped.pid');
  const heavy = path.join(dir, 'heavy.sh');
  const payloadFile = path.join(dir, 'payload.json');
  const harness = path.join(dir, 'leakcheck.sh');
  fs.writeFileSync(heavy, '#!/bin/sh\necho "$$" > "' + pidfile + '"\nexec sleep 60\n');
  fs.writeFileSync(payloadFile, '{"session_id":"e-leak","context_window":{"used_percentage":1,"context_window_size":200000}}');
  fs.writeFileSync(harness,
    '#!/bin/sh\n' +
    'CCT_WRAP="' + heavy + '" CCT_DIR="' + dir + '" ' +
      '/bin/sh "' + ENTRY + '" < "' + payloadFile + '" >/dev/null 2>&1 &\n' +
    'sp=$!\n' +
    'sleep 1\n' +                                  // let it write telemetry + exec heavy
    'kill -9 "$sp" 2>/dev/null\n' +                // simulate Claude Code killing the statusline
    'sleep 1\n' +
    'hp=$(cat "' + pidfile + '" 2>/dev/null)\n' +
    'if [ -n "$hp" ] && kill -0 "$hp" 2>/dev/null; then echo LEAK; else echo OK; fi\n' +
    '[ -n "$hp" ] && kill -9 "$hp" 2>/dev/null\n' +  // belt-and-suspenders cleanup
    'exit 0\n');
  const r = spawnSync('/bin/sh', [harness], { encoding: 'utf8', timeout: 15000 });
  assert.ok(/\bOK\b/.test(r.stdout || ''), 'wrapped command torn down with the entry (NO leak); said: ' + JSON.stringify(r.stdout));
});

// ============================================================================
// (6) SESSION_ID SANITIZATION: a hostile id cannot escape the dir (entry + api)
// ============================================================================

test('entry: hostile session_id "../../etc/evil" cannot escape CCT_DIR', function () {
  const dir = tmpDir();
  const escaped = path.resolve(dir, '..', '..', 'etc', 'evil.json');
  runEntry('{"session_id":"../../etc/evil","context_window":{"used_percentage":5}}', { CCT_DIR: dir });
  assert.strictEqual(fs.existsSync(escaped), false, 'no file outside the dir');
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1, 'exactly one raw file');
  assert.ok(/^telemetry-raw-[A-Za-z0-9_-]+\.json$/.test(files[0]), 'sanitized name: ' + files[0]);
  assert.strictEqual(files[0].indexOf('/'), -1, 'no path separator in the name');
});

test('entry: slashed session_id "a/b/c" creates no nested dirs', function () {
  const dir = tmpDir();
  runEntry('{"session_id":"a/b/c","context_window":{"used_percentage":1}}', { CCT_DIR: dir });
  assert.strictEqual(fs.existsSync(path.join(dir, 'a')), false, 'no nested dir');
  assert.strictEqual(fs.readdirSync(dir).length, 1);
});

test('entry + api agree on the sanitized id for the SAME hostile input (round-trip)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // Write via entry with a hostile id, then read it back via the api with the SAME
  // raw id: both must sanitize identically or the read would miss the file.
  runEntry('{"session_id":"a/b/c","context_window":{"used_percentage":7,"context_window_size":200000}}', { CCT_DIR: dir });
  const t = api.readTelemetry('a/b/c');
  assert.ok(t, 'entry and api sanitize the id identically');
  assert.strictEqual(t.contextPct, 7);
  delete process.env.CCT_DIR;
});

test('entry no-session-id write is readable via the JS empty-id fallback (both -> "default")', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // Entry writes with NO session_id -> "default"; a hook reading with an empty/absent
  // id (JS sanitizeId -> "default") must resolve the SAME file, not miss it.
  runEntry('{"context_window":{"used_percentage":50,"context_window_size":200000}}', { CCT_DIR: dir });
  const t = api.readTelemetry('');
  assert.ok(t, 'shell "default" and JS "default" agree');
  assert.strictEqual(t.contextPct, 50);
  delete process.env.CCT_DIR;
});

test('api: empty session_id -> "default", hostile id contained (writeTelemetry path)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  const escaped = path.resolve(os.tmpdir(), 'evil.json');
  try { fs.unlinkSync(escaped); } catch (e) {}
  api.writeTelemetry('../../tmp/evil', { session_id: 'x', context_pct: 1, ts: api.nowIso() });
  assert.strictEqual(fs.existsSync(escaped), false);
  assert.strictEqual(api.readTelemetry('../../tmp/evil').contextPct, 1);
  delete process.env.CCT_DIR;
});

// ============================================================================
// (7) PRUNING (off the hot path, on the reader side)
// ============================================================================

test('pruneRaw deletes raw files older than the age cutoff, keeps fresh ones', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const old = path.join(dir, 'telemetry-raw-old.json');
  const fresh = path.join(dir, 'telemetry-raw-fresh.json');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  // Backdate `old` two days; default age cutoff is 1 day.
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(old), false, 'stale raw file pruned');
  assert.strictEqual(fs.existsSync(fresh), true, 'fresh raw file kept');
  delete process.env.CCT_DIR;
});

test('pruneRaw enforces the count cap, deleting the OLDEST first', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  process.env.CCT_PRUNE_MAX_FILES = '3';
  api.ensureDir();
  // 5 fresh raw files with staggered mtimes (i seconds ago); cap is 3 -> 2 oldest go.
  const base = Date.now();
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'telemetry-raw-s' + i + '.json');
    fs.writeFileSync(p, '{}');
    const t = (base - i * 1000) / 1000; // s0 newest, s4 oldest
    fs.utimesSync(p, t, t);
  }
  api.pruneRaw();
  const left = fs.readdirSync(dir).filter(function (f) { return f.indexOf('telemetry-raw-') === 0; }).sort();
  assert.strictEqual(left.length, 3, 'capped to 3');
  // s0,s1,s2 are newest -> kept; s3,s4 oldest -> pruned.
  assert.deepStrictEqual(left, ['telemetry-raw-s0.json', 'telemetry-raw-s1.json', 'telemetry-raw-s2.json']);
  delete process.env.CCT_PRUNE_MAX_FILES; delete process.env.CCT_DIR;
});

test('pruneRaw reclaims a STALE atomic-write .tmp leftover, keeps a fresh one', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const staleTmp = path.join(dir, '.telemetry-raw-s.12345.tmp');
  const freshTmp = path.join(dir, '.telemetry-raw-s.67890.tmp');
  fs.writeFileSync(staleTmp, '{}');
  fs.writeFileSync(freshTmp, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(staleTmp, twoDaysAgo, twoDaysAgo);
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(staleTmp), false, 'stale crash-leftover .tmp reclaimed');
  assert.strictEqual(fs.existsSync(freshTmp), true, 'in-flight .tmp (fresh) NOT touched');
  delete process.env.CCT_DIR;
});

test('pruneRaw only touches telemetry-raw-* files, never others', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const other = path.join(dir, 'unrelated.json');
  const legacy = path.join(dir, 'telemetry-s.json'); // legacy parsed file, NOT a raw file
  const raw = path.join(dir, 'telemetry-raw-x.json');
  fs.writeFileSync(other, 'keep');
  fs.writeFileSync(legacy, 'keep');
  fs.writeFileSync(raw, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(other, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(legacy, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(raw, twoDaysAgo, twoDaysAgo);
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(other), true, 'unrelated file untouched');
  assert.strictEqual(fs.existsSync(legacy), true, 'legacy parsed file untouched');
  assert.strictEqual(fs.existsSync(raw), false, 'stale raw file pruned');
  delete process.env.CCT_DIR;
});

test('readTelemetry triggers throttled prune (stale raw files cleaned on a read)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const stale = path.join(dir, 'telemetry-raw-stale.json');
  fs.writeFileSync(stale, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  // A read for some other (absent) session must still run the prune (no sentinel yet).
  api.readTelemetry('whatever');
  assert.strictEqual(fs.existsSync(stale), false, 'stale raw file pruned on read');
  delete process.env.CCT_DIR;
});

test('prune is THROTTLED: a fresh sentinel suppresses a second prune', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  // First read writes the sentinel and prunes. Now drop a stale file and read again:
  // within the throttle window the prune is suppressed, so the stale file survives.
  api.readTelemetry('seed'); // creates the sentinel
  const stale = path.join(dir, 'telemetry-raw-stale2.json');
  fs.writeFileSync(stale, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  api.readTelemetry('again'); // throttled: should NOT prune
  assert.strictEqual(fs.existsSync(stale), true, 'throttle suppressed the second prune');
  // Forcing a prune (or expiring the sentinel) then cleans it.
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(stale), false, 'forced prune cleans it');
  delete process.env.CCT_DIR;
});

// ============================================================================
// (8) FRESHNESS (mtime-based for raw, ts-based for legacy) + TTL validation
// ============================================================================

test('readTelemetry on a raw file is fresh; stale-mtime raw is NOT fresh', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-fr', context_window: { used_percentage: 42, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(api.readTelemetry('s-fr').fresh, true);
  // Backdate the raw file beyond the TTL -> not fresh.
  const p = api.rawPath('s-fr');
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(p, old, old);
  assert.strictEqual(api.readTelemetry('s-fr').fresh, false, 'stale mtime -> not fresh');
  delete process.env.CCT_DIR;
});

test('opts.ttlSec overrides the default TTL for a raw file', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-ttl', context_window: { used_percentage: 1, context_window_size: 200000 } }, { CCT_DIR: dir });
  const p = api.rawPath('s-ttl');
  const t50 = (Date.now() - 50 * 1000) / 1000; // 50s old
  fs.utimesSync(p, t50, t50);
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 30 }).fresh, false);
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 120 }).fresh, true);
  delete process.env.CCT_DIR;
});

test('legacy writeTelemetry path still works (backward compat) - fresh/stale/future', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('L-fresh', { session_id: 'L-fresh', context_pct: 42, used_percentage: 42,
    context_window_size: 200000, model: 'm', ts: new Date().toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('L-fresh').fresh, true);
  api.writeTelemetry('L-stale', { session_id: 'L-stale', context_pct: 42,
    ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('L-stale').fresh, false);
  api.writeTelemetry('L-future', { session_id: 'L-future', context_pct: 42,
    ts: new Date(Date.now() + 10 * 60 * 1000).toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('L-future').fresh, false);
  delete process.env.CCT_DIR;
});

test('readTelemetry returns null when nothing exists for the session', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  assert.strictEqual(api.readTelemetry('nope'), null);
  delete process.env.CCT_DIR;
});

test('raw file present but UNPARSEABLE -> null (does not fall back to a stale legacy file)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  // Both a corrupt raw file AND a (valid) legacy file for the same id: raw wins, and a
  // corrupt raw yields null rather than masking it with the legacy reading.
  fs.writeFileSync(api.rawPath('s-corrupt'), 'not json <<<');
  api.writeTelemetry('s-corrupt', { session_id: 's-corrupt', context_pct: 99, ts: api.nowIso() });
  assert.strictEqual(api.readTelemetry('s-corrupt'), null, 'corrupt raw -> null, legacy not used');
  delete process.env.CCT_DIR;
});

test('CCT_TTL_SEC="" / negative fall back to default 120 (legacy path)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  const ts = new Date(Date.now() - 50 * 1000).toISOString();
  process.env.CCT_TTL_SEC = '';
  api.writeTelemetry('s-b', { session_id: 's-b', context_pct: 3, ts: ts });
  assert.strictEqual(api.readTelemetry('s-b').fresh, true);
  process.env.CCT_TTL_SEC = '-5';
  api.writeTelemetry('s-n', { session_id: 's-n', context_pct: 3, ts: ts });
  assert.strictEqual(api.readTelemetry('s-n').fresh, true);
  delete process.env.CCT_TTL_SEC; delete process.env.CCT_DIR;
});

// ============================================================================
// (9) ON-DEMAND CLI READER (bin/telemetry.js)
// ============================================================================

test('CLI reader: prints pretty JSON for a session with telemetry (argv id)', function () {
  const dir = tmpDir();
  runEntry({ session_id: 's-cli', context_window: { used_percentage: 22, context_window_size: 200000 } }, { CCT_DIR: dir });
  const r = runReader(['s-cli'], { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.contextPct, 22);
  assert.strictEqual(parsed.source, 'statusline');
});

test('CLI reader: reads session_id from a hook-style stdin payload', function () {
  const dir = tmpDir();
  runEntry({ session_id: 's-cli2', context_window: { used_percentage: 8, context_window_size: 200000 } }, { CCT_DIR: dir });
  const r = runReader([], { CCT_DIR: dir }, '{"session_id":"s-cli2","tool_name":"Bash"}');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).contextPct, 8);
});

test('CLI reader: "no telemetry for <id>" when absent, exit 0', function () {
  const dir = tmpDir();
  const r = runReader(['ghost'], { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(/no telemetry for ghost/.test(r.stdout));
});

test('CLI reader: no id and no stdin payload -> usage on stderr, exit 1', function () {
  const dir = tmpDir();
  const r = runReader([], { CCT_DIR: dir }, '');
  assert.strictEqual(r.status, 1);
  assert.ok(/usage:/.test(r.stderr));
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
