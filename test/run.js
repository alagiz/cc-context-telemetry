'use strict';
// Small bounded test runner for cc-context-telemetry. Zero deps, home-grown.
// Every test uses a temp CCT_DIR so the real telemetry dir is never touched.
// Nothing here calls `claude` or scans a binary; the only spawned children are
// tiny inline node stubs, all bounded by short timeouts.
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WRAPPER = path.join(ROOT, 'bin', 'statusline.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e) { fail++; console.log('FAIL - ' + name + '\n       ' + (e && e.message)); }
}

// Fresh temp dir per call so tests never collide.
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-'));
}

// Run the wrapper with a stub payload on stdin and the given env. Bounded.
function runWrapper(payload, env) {
  return spawnSync(process.execPath, [WRAPPER], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
}

function readTelFile(dir, sessionId) {
  const p = path.join(dir, 'telemetry-' + sessionId + '.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Load index.js fresh so CCT_DIR / CCT_TTL_SEC are read at call time (they are,
// since telemetryDir/ttl read process.env on each call).
const api = require('../index.js');

// ---- wrapper telemetry writes ----------------------------------------------

test('Pro/Max payload (rate_limits + 200k window) writes full telemetry', function () {
  const dir = tmpDir();
  const r = runWrapper({
    session_id: 's-pro',
    context_window: { used_percentage: 47.2, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } },
    model: { id: 'claude-opus-4-1' },
  }, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0, 'exit 0 standalone');
  const t = readTelFile(dir, 's-pro');
  assert.strictEqual(t.context_pct, 47.2);
  assert.strictEqual(t.context_window_size, 200000);
  assert.strictEqual(t.five_hour_pct, 12);
  assert.strictEqual(t.seven_day_pct, 30);
  assert.strictEqual(t.model, 'claude-opus-4-1');
  assert.strictEqual(t.source, 'statusline');
  // standalone bar shows all three segments
  assert.ok(/ctx 47%/.test(r.stdout), 'ctx in bar');
  assert.ok(/5h 12%/.test(r.stdout) && /7d 30%/.test(r.stdout), 'usage in bar');
});

test('Max + 1M window writes the large window size', function () {
  const dir = tmpDir();
  runWrapper({
    session_id: 's-1m',
    context_window: { used_percentage: 10, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 8 } },
    model: { id: 'claude-sonnet-4-5' },
  }, { CCT_DIR: dir });
  const t = readTelFile(dir, 's-1m');
  assert.strictEqual(t.context_window_size, 1000000);
  assert.strictEqual(t.five_hour_pct, 5);
});

test('API-key payload WITHOUT rate_limits omits 5h/7d (never 0)', function () {
  const dir = tmpDir();
  const r = runWrapper({
    session_id: 's-api',
    context_window: { used_percentage: 60, context_window_size: 200000 },
    model: { id: 'claude-opus-4-1' },
  }, { CCT_DIR: dir });
  const t = readTelFile(dir, 's-api');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(t, 'five_hour_pct'), false, '5h omitted');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(t, 'seven_day_pct'), false, '7d omitted');
  assert.strictEqual(t.context_pct, 60);
  // bar shows only ctx
  assert.ok(/ctx 60%/.test(r.stdout));
  assert.ok(!/5h/.test(r.stdout) && !/7d/.test(r.stdout), 'no usage segments');
});

test('used_percentage null -> context_pct null', function () {
  const dir = tmpDir();
  const r = runWrapper({
    session_id: 's-null',
    context_window: { used_percentage: null, context_window_size: 200000 },
    model: { id: 'claude-opus-4-1' },
  }, { CCT_DIR: dir });
  const t = readTelFile(dir, 's-null');
  assert.strictEqual(t.context_pct, null);
  assert.ok(/ctx --/.test(r.stdout), 'bar shows -- for unknown ctx');
});

// ---- wrapper pass-through ---------------------------------------------------

test('pass-through forwards child stdout verbatim AND writes telemetry', function () {
  const dir = tmpDir();
  // Child prints a fixed bar and exits 0.
  const child = process.execPath + ' -e "process.stdout.write(\'MY-CUSTOM-BAR\')"';
  const r = runWrapper({
    session_id: 's-wrap',
    context_window: { used_percentage: 33, context_window_size: 200000 },
    model: { id: 'claude-opus-4-1' },
  }, { CCT_DIR: dir, CCT_WRAP: child });
  assert.strictEqual(r.stdout, 'MY-CUSTOM-BAR', 'verbatim child output');
  assert.strictEqual(r.status, 0, 'child exit code propagated');
  const t = readTelFile(dir, 's-wrap');
  assert.strictEqual(t.context_pct, 33, 'telemetry still written under wrap');
});

test('pass-through propagates a non-zero exit code when child produced output', function () {
  const dir = tmpDir();
  const child = process.execPath + ' -e "process.stdout.write(\'BAR\'); process.exit(7)"';
  const r = runWrapper({
    session_id: 's-exit',
    context_window: { used_percentage: 1, context_window_size: 200000 },
  }, { CCT_DIR: dir, CCT_WRAP: child });
  assert.strictEqual(r.stdout, 'BAR');
  assert.strictEqual(r.status, 7, 'non-zero exit propagated');
});

test('hanging wrap command is killed by timeout; bar still prints (exit 0)', function () {
  const dir = tmpDir();
  // A child that sleeps far longer than the timeout and prints nothing.
  const child = process.execPath + ' -e "setTimeout(function(){}, 60000)"';
  const r = runWrapper({
    session_id: 's-hang',
    context_window: { used_percentage: 55, context_window_size: 200000 },
  }, { CCT_DIR: dir, CCT_WRAP: child, CCT_WRAP_TIMEOUT_MS: '300' });
  assert.strictEqual(r.status, 0, 'fell through to standalone bar, exit 0');
  assert.ok(/ctx 55%/.test(r.stdout), 'standalone bar printed after kill');
  // telemetry was still written before the wrap attempt
  const t = readTelFile(dir, 's-hang');
  assert.strictEqual(t.context_pct, 55);
});

// ---- readTelemetry freshness ------------------------------------------------

test('readTelemetry returns null when the file is absent', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  assert.strictEqual(api.readTelemetry('nope'), null);
  delete process.env.CCT_DIR;
});

test('readTelemetry fresh for a recent ts', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  api.writeTelemetry('s-fresh', {
    session_id: 's-fresh', context_pct: 42, used_percentage: 42,
    context_window_size: 200000, model: 'm', ts: new Date().toISOString(),
    source: 'statusline',
  });
  const t = api.readTelemetry('s-fresh');
  assert.ok(t, 'object returned');
  assert.strictEqual(t.fresh, true);
  assert.strictEqual(t.contextPct, 42);
  assert.strictEqual(t.windowSize, 200000);
  delete process.env.CCT_DIR;
});

test('readTelemetry NOT fresh for a stale ts', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
  api.writeTelemetry('s-stale', {
    session_id: 's-stale', context_pct: 42, ts: old, source: 'statusline',
  });
  const t = api.readTelemetry('s-stale');
  assert.ok(t);
  assert.strictEqual(t.fresh, false, 'stale ts is not fresh');
  delete process.env.CCT_DIR;
});

test('readTelemetry NOT fresh for a far-future ts', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min ahead
  api.writeTelemetry('s-future', {
    session_id: 's-future', context_pct: 42, ts: future, source: 'statusline',
  });
  const t = api.readTelemetry('s-future');
  assert.ok(t);
  assert.strictEqual(t.fresh, false, 'far-future ts is rejected');
  delete process.env.CCT_DIR;
});

test('readTelemetry NOT fresh when context_pct is null even with recent ts', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  api.writeTelemetry('s-noctx', {
    session_id: 's-noctx', context_pct: null, ts: new Date().toISOString(), source: 'statusline',
  });
  const t = api.readTelemetry('s-noctx');
  assert.ok(t);
  assert.strictEqual(t.fresh, false, 'null context is not fresh');
  assert.strictEqual(t.contextPct, null);
  delete process.env.CCT_DIR;
});

test('opts.ttlSec overrides the default TTL', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  const ts = new Date(Date.now() - 50 * 1000).toISOString(); // 50s ago
  api.writeTelemetry('s-ttl', { session_id: 's-ttl', context_pct: 1, ts: ts, source: 'statusline' });
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 30 }).fresh, false, '30s ttl -> stale');
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 120 }).fresh, true, '120s ttl -> fresh');
  delete process.env.CCT_DIR;
});

// ---- path traversal containment --------------------------------------------

test('writeTelemetry with a "../../tmp/evil" id stays INSIDE CCT_DIR', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  const escaped = path.resolve(os.tmpdir(), 'evil.json');
  try { fs.unlinkSync(escaped); } catch (e) {}
  api.writeTelemetry('../../tmp/evil', { session_id: 'x', context_pct: 1, ts: api.nowIso() });
  // No file escaped to the resolved traversal target.
  assert.strictEqual(fs.existsSync(escaped), false, 'no file written outside CCT_DIR');
  // The sanitized file lives inside CCT_DIR and is readable back.
  const t = api.readTelemetry('../../tmp/evil');
  assert.ok(t, 'sanitized read returns the same object');
  assert.strictEqual(t.contextPct, 1);
  // Every file the write produced is under CCT_DIR.
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1, 'exactly one file, inside CCT_DIR');
  assert.ok(/^telemetry-.*\.json$/.test(files[0]), 'sanitized name');
  assert.ok(files[0].indexOf('/') === -1 && files[0].indexOf('..') === -1, 'no separators/dots-pair');
  delete process.env.CCT_DIR;
});

test('writeTelemetry with a slashed id ("a/b/c") cannot create nested dirs', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  api.writeTelemetry('a/b/c', { session_id: 'x', context_pct: 9, ts: api.nowIso() });
  assert.strictEqual(fs.existsSync(path.join(dir, 'a')), false, 'no nested dir created');
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1, 'one flat file');
  assert.strictEqual(api.readTelemetry('a/b/c').contextPct, 9, 'reads back via sanitized path');
  delete process.env.CCT_DIR;
});

// ---- blank-bar fix ----------------------------------------------------------

test('wrap exits 0 with EMPTY stdout -> standalone bar (never blank), exit 0', function () {
  const dir = tmpDir();
  // `true`-equivalent: exits 0, prints nothing.
  const child = process.execPath + ' -e "process.exit(0)"';
  const r = runWrapper({
    session_id: 's-empty0',
    context_window: { used_percentage: 44, context_window_size: 200000 },
  }, { CCT_DIR: dir, CCT_WRAP: child });
  assert.strictEqual(r.status, 0, 'exit 0');
  assert.ok(r.stdout.length > 0, 'bar is not blank');
  assert.ok(/ctx 44%/.test(r.stdout), 'standalone bar printed');
});

test('wrap prints only to stderr (empty stdout) -> standalone bar, exit 0', function () {
  const dir = tmpDir();
  const child = process.execPath + ' -e "process.stderr.write(\'noise\'); process.exit(0)"';
  const r = runWrapper({
    session_id: 's-stderr',
    context_window: { used_percentage: 21, context_window_size: 200000 },
  }, { CCT_DIR: dir, CCT_WRAP: child });
  assert.strictEqual(r.status, 0, 'exit 0');
  assert.ok(/ctx 21%/.test(r.stdout), 'standalone bar printed, not blank');
});

test('wrap exits nonzero (3) with NO output -> standalone bar, exit 0', function () {
  const dir = tmpDir();
  const child = process.execPath + ' -e "process.exit(3)"';
  const r = runWrapper({
    session_id: 's-exit3',
    context_window: { used_percentage: 5, context_window_size: 200000 },
  }, { CCT_DIR: dir, CCT_WRAP: child });
  assert.strictEqual(r.status, 0, 'fell through to standalone, exit 0');
  assert.ok(/ctx 5%/.test(r.stdout), 'standalone bar printed');
});

// ---- malformed / empty stdin ------------------------------------------------

test('non-JSON stdin -> telemetry context_pct null, bar "ctx --", exit 0', function () {
  const dir = tmpDir();
  const r = runWrapper('this is not json {', { CCT_DIR: dir });
  assert.strictEqual(r.status, 0, 'exit 0');
  assert.ok(/ctx --/.test(r.stdout), 'unknown ctx shown as --');
  const t = readTelFile(dir, 'default');
  assert.strictEqual(t.context_pct, null, 'context_pct null on garbage stdin');
});

test('empty stdin -> telemetry context_pct null, bar "ctx --", exit 0', function () {
  const dir = tmpDir();
  const r = runWrapper('', { CCT_DIR: dir });
  assert.strictEqual(r.status, 0, 'exit 0');
  assert.ok(/ctx --/.test(r.stdout), 'unknown ctx shown as --');
  const t = readTelFile(dir, 'default');
  assert.strictEqual(t.context_pct, null);
});

// ---- readTelemetry on garbage file -----------------------------------------

test('readTelemetry on a non-JSON file returns null, does not throw', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  fs.writeFileSync(api.telemetryPath('s-garbage'), 'not json at all <<<');
  let result, threw = false;
  try { result = api.readTelemetry('s-garbage'); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, 'no throw on garbage');
  assert.strictEqual(result, null, 'garbage -> null');
  delete process.env.CCT_DIR;
});

// ---- TTL validation ---------------------------------------------------------

test('CCT_TTL_SEC="" falls back to default 120 (does NOT disable freshness)', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  process.env.CCT_TTL_SEC = '';
  const ts = new Date(Date.now() - 50 * 1000).toISOString(); // 50s ago, fresh under 120
  api.writeTelemetry('s-ttlblank', { session_id: 's-ttlblank', context_pct: 3, ts: ts });
  assert.strictEqual(api.readTelemetry('s-ttlblank').fresh, true, 'default 120 used, recent is fresh');
  delete process.env.CCT_TTL_SEC;
  delete process.env.CCT_DIR;
});

test('CCT_TTL_SEC negative falls back to default 120', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  process.env.CCT_TTL_SEC = '-5';
  const ts = new Date(Date.now() - 50 * 1000).toISOString();
  api.writeTelemetry('s-ttlneg', { session_id: 's-ttlneg', context_pct: 3, ts: ts });
  assert.strictEqual(api.readTelemetry('s-ttlneg').fresh, true, 'negative -> default, recent is fresh');
  delete process.env.CCT_TTL_SEC;
  delete process.env.CCT_DIR;
});

test('opts.ttlSec "" and negative fall back to default 120', function () {
  const dir = tmpDir();
  process.env.CCT_DIR = dir;
  const ts = new Date(Date.now() - 50 * 1000).toISOString();
  api.writeTelemetry('s-ttlopt', { session_id: 's-ttlopt', context_pct: 3, ts: ts });
  assert.strictEqual(api.readTelemetry('s-ttlopt', { ttlSec: '' }).fresh, true, 'blank opt -> default');
  assert.strictEqual(api.readTelemetry('s-ttlopt', { ttlSec: -5 }).fresh, true, 'negative opt -> default');
  delete process.env.CCT_DIR;
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
