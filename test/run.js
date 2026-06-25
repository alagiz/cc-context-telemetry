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

// Synchronous bounded sleep (no child spawned), for the reaping poll below.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// REGRESSION (the fork-bomb): a wrapped statusline command commonly shells out,
// so the wrapped command has its OWN children. spawnSync's timeout SIGKILLs only
// the direct child (the shell), orphaning those grandchildren; across many renders
// x sessions the orphans pile up into a fork-bomb. The wrapper MUST kill the whole
// process group on timeout. This test spawns a grandchild that records its pid and
// then sleeps 60s; after the wrapper times out, that grandchild MUST be dead.
test('timeout SIGKILLs the WHOLE process group: a wrapped command grandchild is reaped (no orphan)', function () {
  const dir = tmpDir();
  const pidfile = path.join(dir, 'gc.pid');
  // CCT_WRAP is a node grandchild: it writes its pid, prints NOTHING, sleeps 60s.
  // (statusline -> sh -> this node; under the old bug the node would be orphaned.)
  const gc = process.execPath +
    ' -e "var fs=require(\'fs\');fs.writeFileSync(process.env.GC_PIDFILE,String(process.pid));setTimeout(function(){},60000)"';
  const r = runWrapper({
    session_id: 's-orphan',
    context_window: { used_percentage: 50, context_window_size: 200000 },
  }, { CCT_DIR: dir, CCT_WRAP: gc, CCT_WRAP_TIMEOUT_MS: '500', GC_PIDFILE: pidfile });
  assert.strictEqual(r.status, 0, 'fell through to standalone, exit 0');
  assert.ok(/ctx 50%/.test(r.stdout), 'standalone bar printed after kill');
  // The grandchild must have started and recorded its pid before the timeout.
  assert.ok(fs.existsSync(pidfile), 'grandchild started and wrote its pid');
  const gpid = parseInt(fs.readFileSync(pidfile, 'utf8'), 10);
  assert.ok(gpid > 0, 'valid grandchild pid');
  // It must now be DEAD (group-killed). Poll briefly (bounded <= ~2s) for reaping.
  let alive = true;
  for (let i = 0; i < 40; i++) {
    try { process.kill(gpid, 0); } catch (e) { alive = false; break; } // ESRCH => gone
    sleepSync(50);
  }
  // ALWAYS clean up: if the fix regressed, never leak the 60s sleeper.
  if (alive) { try { process.kill(gpid, 'SIGKILL'); } catch (e) {} }
  assert.strictEqual(alive, false, 'grandchild was reaped by group-kill (NOT orphaned)');
});

// REGRESSION (the HANG the devil's-advocate found): a wrapped command that
// DAEMONIZES (detached/setsid double-fork) puts a helper into its OWN process
// group, which escapes our group-kill AND inherits our stdout pipe. With a design
// that waited only on 'close', that pipe stays open forever, 'close' never fires,
// and bin/statusline.js HANGS - freezing the bar and leaking a stuck wrapper per
// render. We cannot kill the escapee (it detached itself, by OS design), but the
// WRAPPER MUST STILL EXIT promptly. This test proves it exits and prints a bar; it
// would hang (spawnSync hits its 10s timeout, status null) against a 'close'-only
// design. The escapee is killed in cleanup.
test('daemonizing wrap that holds the stdout pipe does NOT hang the wrapper (it exits + prints a bar)', function () {
  const dir = tmpDir();
  const pidfile = path.join(dir, 'daemon.pid');
  // gc.js: the escapee. Inherits stdio (holds our stdout fd) and just sleeps.
  const gcScript = path.join(dir, 'gc.js');
  fs.writeFileSync(gcScript, "setTimeout(function(){}, 30000);\n");
  // launcher.js: spawns the escapee DETACHED (new group, escapes our group-kill)
  // with stdio:'inherit' (so it holds our stdout pipe). It records the escapee's pid
  // SYNCHRONOUSLY (it knows c.pid at spawn) BEFORE exiting, so the pidfile is
  // guaranteed present the instant the launcher exits - the cleanup below can never
  // race a slow grandchild boot and leak the 30s sleeper.
  const launcher = path.join(dir, 'launcher.js');
  fs.writeFileSync(launcher,
    "var cp=require('child_process');\n" +
    "var fs=require('fs');\n" +
    "var c=cp.spawn(process.execPath,[process.env.GC_SCRIPT],{detached:true,stdio:'inherit'});\n" +
    "fs.writeFileSync(process.env.GC_PIDFILE, String(c.pid));\n" +
    "c.unref();\n" +
    "process.exit(0);\n");
  const wrap = process.execPath + ' ' + JSON.stringify(launcher);
  const r = runWrapper({
    session_id: 's-daemon',
    context_window: { used_percentage: 66, context_window_size: 200000 },
  }, { CCT_DIR: dir, CCT_WRAP: wrap, CCT_WRAP_TIMEOUT_MS: '1500', GC_SCRIPT: gcScript, GC_PIDFILE: pidfile });

  // Read + kill the escapee FIRST (always clean up, even if assertions below fail).
  // The launcher writes the pidfile synchronously before exiting, so it is present
  // by the time runWrapper returns; the short poll is belt-and-suspenders.
  let dpid = -1;
  for (let i = 0; i < 40; i++) {
    try { dpid = parseInt(fs.readFileSync(pidfile, 'utf8'), 10); } catch (e) {}
    if (dpid > 0) break;
    sleepSync(50);
  }
  if (dpid > 0) { try { process.kill(dpid, 'SIGKILL'); } catch (e) {} }

  // The wrapper EXITED (did not hang): spawnSync returned a real status, not the
  // null+SIGTERM of a 10s-timeout kill. And it printed a bar (its standalone one,
  // since the daemonizing wrap produced no stdout of its own before exiting).
  assert.strictEqual(r.signal, null, 'wrapper was NOT killed by the test timeout (no hang)');
  assert.strictEqual(r.status, 0, 'wrapper exited 0');
  assert.ok(/ctx 66%/.test(r.stdout), 'standalone bar printed, not frozen');
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

// ---- CCT_DEBUG opt-in raw dump ----------------------------------------------

test('CCT_DEBUG=1 dumps verbatim raw stdin to debug-statusline.json; bar still prints, exit 0', function () {
  const dir = tmpDir();
  // Use a raw string so we can assert the dump is byte-for-byte the stdin.
  const rawPayload = '{"session_id":"s-dbg","context_window":{"used_percentage":12,"context_window_size":200000},"extra":"keep me"}';
  const r = runWrapper(rawPayload, { CCT_DIR: dir, CCT_DEBUG: '1' });
  assert.strictEqual(r.status, 0, 'exit 0 even with debug on');
  assert.ok(/ctx 12%/.test(r.stdout), 'bar still prints');
  const dumped = fs.readFileSync(path.join(dir, 'debug-statusline.json'), 'utf8');
  assert.strictEqual(dumped, rawPayload, 'raw stdin dumped verbatim');
});

test('without CCT_DEBUG no debug file is written; bar still prints, exit 0', function () {
  const dir = tmpDir();
  const r = runWrapper({
    session_id: 's-nodbg',
    context_window: { used_percentage: 12, context_window_size: 200000 },
  }, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0, 'exit 0');
  assert.ok(/ctx 12%/.test(r.stdout), 'bar still prints');
  assert.strictEqual(fs.existsSync(path.join(dir, 'debug-statusline.json')), false, 'no debug file written');
});

test('CCT_DEBUG falsey values (0, false) write NO debug file; "1" does', function () {
  // CCT_DEBUG=0 -> OFF (no debug file).
  const d0 = tmpDir();
  runWrapper('{"session_id":"s-d0","context_window":{"used_percentage":1,"context_window_size":200000}}',
    { CCT_DIR: d0, CCT_DEBUG: '0' });
  assert.strictEqual(fs.existsSync(path.join(d0, 'debug-statusline.json')), false, 'CCT_DEBUG=0 -> no debug file');

  // CCT_DEBUG=false -> OFF (no debug file).
  const dF = tmpDir();
  runWrapper('{"session_id":"s-dF","context_window":{"used_percentage":1,"context_window_size":200000}}',
    { CCT_DIR: dF, CCT_DEBUG: 'false' });
  assert.strictEqual(fs.existsSync(path.join(dF, 'debug-statusline.json')), false, 'CCT_DEBUG=false -> no debug file');

  // CCT_DEBUG=1 -> ON (debug file written).
  const d1 = tmpDir();
  runWrapper('{"session_id":"s-d1","context_window":{"used_percentage":1,"context_window_size":200000}}',
    { CCT_DIR: d1, CCT_DEBUG: '1' });
  assert.strictEqual(fs.existsSync(path.join(d1, 'debug-statusline.json')), true, 'CCT_DEBUG=1 -> debug file written');
});

test('CCT_DEBUG overwrites debug-statusline.json with the latest payload', function () {
  const dir = tmpDir();
  const first = '{"session_id":"s-ovr","context_window":{"used_percentage":1,"context_window_size":200000}}';
  const second = '{"session_id":"s-ovr","context_window":{"used_percentage":2,"context_window_size":200000}}';
  runWrapper(first, { CCT_DIR: dir, CCT_DEBUG: '1' });
  runWrapper(second, { CCT_DIR: dir, CCT_DEBUG: '1' });
  const dumped = fs.readFileSync(path.join(dir, 'debug-statusline.json'), 'utf8');
  assert.strictEqual(dumped, second, 'debug file holds only the latest payload');
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
