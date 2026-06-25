'use strict';
// Bounded test runner for cc-context-telemetry (exec model). Zero deps, home-grown.
// Every test uses a temp CCT_DIR so the real telemetry dir is never touched. Nothing
// here calls `claude` or scans a binary; spawned children are tiny inline node/sh
// stubs, all bounded by short timeouts and cleaned up (no leaked processes).
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'cct-statusline');   // the shell entry (execs CCT_WRAP)
const TELEMETRY = path.join(ROOT, 'bin', 'telemetry.js');  // the telemetry-only writer

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e) { fail++; console.log('FAIL - ' + name + '\n       ' + (e && e.message)); }
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-')); }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Run the shell ENTRY with a stub payload on stdin and the given env. Bounded.
function runEntry(payload, env) {
  return spawnSync('/bin/sh', [ENTRY], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
}
// Run the telemetry-only writer directly.
function runTelemetry(payload, env) {
  return spawnSync(process.execPath, [TELEMETRY], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
}
function readTelFile(dir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'telemetry-' + sessionId + '.json'), 'utf8'));
}
const api = require('../index.js');

// ---- telemetry writer: field mapping -------------------------------------------

test('Pro/Max payload (rate_limits + 200k window) writes full telemetry', function () {
  const dir = tmpDir();
  const r = runTelemetry({
    session_id: 's-pro',
    context_window: { used_percentage: 47.2, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } },
    model: { id: 'claude-opus-4-1' },
  }, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  const t = readTelFile(dir, 's-pro');
  assert.strictEqual(t.context_pct, 47.2);
  assert.strictEqual(t.context_window_size, 200000);
  assert.strictEqual(t.five_hour_pct, 12);
  assert.strictEqual(t.seven_day_pct, 30);
  assert.strictEqual(t.model, 'claude-opus-4-1');
  assert.strictEqual(t.source, 'statusline');
});

test('Max + 1M window writes the large window size', function () {
  const dir = tmpDir();
  runTelemetry({ session_id: 's-1m', context_window: { used_percentage: 10, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: 5 } }, model: { id: 'claude-sonnet-4-5' } }, { CCT_DIR: dir });
  const t = readTelFile(dir, 's-1m');
  assert.strictEqual(t.context_window_size, 1000000);
  assert.strictEqual(t.five_hour_pct, 5);
});

test('API-key payload WITHOUT rate_limits omits 5h/7d (never 0)', function () {
  const dir = tmpDir();
  runTelemetry({ session_id: 's-api', context_window: { used_percentage: 60, context_window_size: 200000 },
    model: { id: 'claude-opus-4-1' } }, { CCT_DIR: dir });
  const t = readTelFile(dir, 's-api');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(t, 'five_hour_pct'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(t, 'seven_day_pct'), false);
  assert.strictEqual(t.context_pct, 60);
});

test('used_percentage null -> context_pct null', function () {
  const dir = tmpDir();
  runTelemetry({ session_id: 's-null', context_window: { used_percentage: null, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(readTelFile(dir, 's-null').context_pct, null);
});

// ---- telemetry writer: bar printing only in standalone -------------------------

test('telemetry writer STANDALONE (no CCT_WRAP) prints the minimal bar', function () {
  const dir = tmpDir();
  const r = runTelemetry({ session_id: 's-stand', context_window: { used_percentage: 33, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 9 }, seven_day: { used_percentage: 21 } } }, { CCT_DIR: dir });
  assert.ok(/ctx 33%/.test(r.stdout), 'ctx in bar');
  assert.ok(/5h 9%/.test(r.stdout) && /7d 21%/.test(r.stdout), 'usage in bar');
  assert.strictEqual(r.status, 0);
});

test('telemetry writer WRAP mode (CCT_WRAP set) prints NOTHING (exec prints the bar)', function () {
  const dir = tmpDir();
  const r = runTelemetry({ session_id: 's-quiet', context_window: { used_percentage: 33, context_window_size: 200000 } },
    { CCT_DIR: dir, CCT_WRAP: "printf 'X'" });
  assert.strictEqual(r.stdout, '', 'no bar printed in wrap mode');
  assert.strictEqual(readTelFile(dir, 's-quiet').context_pct, 33, 'telemetry still written');
});

test('telemetry writer NEVER spawns a child (no lingering process)', function () {
  // It only reads stdin + writes a file; assert it returns promptly with no children.
  const dir = tmpDir();
  const start = Date.now();
  const r = runTelemetry({ session_id: 's-fast', context_window: { used_percentage: 1, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(Date.now() - start < 8000, 'returns promptly');
});

// ---- shell entry: standalone + wrap pass-through -------------------------------

test('entry STANDALONE prints minimal bar AND writes telemetry', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 'e-stand', context_window: { used_percentage: 12, context_window_size: 200000 } },
    { CCT_DIR: dir, CCT_NODE: process.execPath });
  assert.strictEqual(r.status, 0);
  assert.ok(/ctx 12%/.test(r.stdout), 'bar printed');
  assert.strictEqual(readTelFile(dir, 'e-stand').context_pct, 12);
});

test('entry WRAP mode EXECs CCT_WRAP, prints ITS bar verbatim, still writes telemetry', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 'e-wrap', context_window: { used_percentage: 5, context_window_size: 200000 } },
    { CCT_DIR: dir, CCT_NODE: process.execPath, CCT_WRAP: "printf 'MY-REAL-BAR'" });
  assert.strictEqual(r.stdout, 'MY-REAL-BAR', 'verbatim wrapped output');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(readTelFile(dir, 'e-wrap').context_pct, 5, 'telemetry written under wrap');
});

test('entry WRAP mode propagates the wrapped command exit code', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 'e-exit', context_window: { used_percentage: 1, context_window_size: 200000 } },
    { CCT_DIR: dir, CCT_NODE: process.execPath, CCT_WRAP: "sh -c \"printf BAR; exit 7\"" });
  assert.strictEqual(r.stdout, 'BAR');
  assert.strictEqual(r.status, 7, 'exec propagates the wrapped exit code');
});

test('entry WRAP mode receives the EXACT stdin payload', function () {
  const dir = tmpDir();
  // The wrapped command echoes its stdin; assert it is byte-identical to what we sent.
  const payload = '{"session_id":"e-stdin","context_window":{"used_percentage":2,"context_window_size":200000},"x":"keep me"}';
  const r = runEntry(payload, { CCT_DIR: dir, CCT_NODE: process.execPath, CCT_WRAP: 'cat' });
  assert.strictEqual(r.stdout, payload, 'wrapped command got the exact stdin');
});

test('entry WRAP with a QUOTED path + args execs it directly with args + exact stdin (the adtention shape)', function () {
  // The real-world CCT_WRAP is a quoted program path plus args, e.g.
  // "'/path/to/adtention' status". Assert the quoting is honored (arg passed), the
  // program is exec'd, and it still receives the exact payload on stdin.
  const dir = tmpDir();
  const prog = path.join(dir, 'my status.sh'); // space in the path -> must stay quoted
  fs.writeFileSync(prog, '#!/bin/sh\nprintf "arg=%s;" "$1"\ncat\n');
  fs.chmodSync(prog, 0o755);
  const payload = '{"session_id":"e-args","context_window":{"used_percentage":4,"context_window_size":200000}}';
  const r = runEntry(payload, { CCT_DIR: dir, CCT_NODE: process.execPath, CCT_WRAP: "'" + prog + "' TOKEN" });
  assert.strictEqual(r.stdout, 'arg=TOKEN;' + payload, 'quoted path honored, arg passed, exact stdin forwarded');
  assert.strictEqual(readTelFile(dir, 'e-args').context_pct, 4, 'telemetry written');
});

test('entry WRAP that backgrounds (trailing &) does NOT hang the entry (no stuck wrapper)', function () {
  // A trailing & is a misuse (it backgrounds the statusline, same as running it
  // directly), but it must not HANG our entry. Bounded: assert the entry returns.
  const dir = tmpDir();
  // Use a SHORT-lived background process (sleep 1) so it self-cleans - no broad pkill
  // that could hit unrelated processes.
  const r = runEntry({ session_id: 'e-bg', context_window: { used_percentage: 1, context_window_size: 200000 } },
    { CCT_DIR: dir, CCT_NODE: process.execPath, CCT_WRAP: "printf BG; sleep 1 &" });
  // spawnSync returns when the entry exits; a hang would hit the 10s timeout (status null).
  assert.strictEqual(r.signal, null, 'entry was not killed by the test timeout (did not hang)');
});

// ---- shell entry: the no-leak regression (the fork-bomb fix) --------------------

test('REGRESSION: entry EXECs (does not spawn) the wrapped command - killing the entry kills it, no leak', function () {
  // A wrapped command that records its pid then sleeps. Under the OLD spawn model the
  // wrapper spawned this DETACHED, so killing the wrapper (as Claude Code does every
  // render) left it alive -> a per-render pile-up. The exec model makes the wrapped
  // command BE the process, so killing the entry kills it.
  //
  // The liveness check runs in a SHELL harness, not the Node test process: a shell
  // reaps its killed jobs cleanly, whereas this suite's blocking Atomics.wait poll
  // would stall Node's event loop, leave the killed child as an unreaped ZOMBIE, and
  // process.kill(pid,0) reports a zombie as "alive" (a false leak). The shell `kill -0`
  // correctly reports a reaped/dead pid as gone. (This is the same harness shape that
  // proved direct==exec safe and spawn unsafe.)
  const dir = tmpDir();
  const pidfile = path.join(dir, 'wrapped.pid');
  const heavy = path.join(dir, 'heavy.sh');
  const payloadFile = path.join(dir, 'payload.json');
  const harness = path.join(dir, 'leakcheck.sh');
  fs.writeFileSync(heavy, '#!/bin/sh\necho "$$" > "' + pidfile + '"\nexec sleep 60\n');
  fs.writeFileSync(payloadFile, '{"session_id":"e-leak","context_window":{"used_percentage":1,"context_window_size":200000}}');
  fs.writeFileSync(harness,
    '#!/bin/sh\n' +
    'CCT_WRAP="' + heavy + '" CCT_DIR="' + dir + '" CCT_NODE="' + process.execPath + '" ' +
      '/bin/sh "' + ENTRY + '" < "' + payloadFile + '" >/dev/null 2>&1 &\n' +
    'sp=$!\n' +
    'sleep 1\n' +                                  // let it write telemetry + exec heavy (-> exec sleep)
    'kill -9 "$sp" 2>/dev/null\n' +                // simulate Claude Code killing the statusline process
    'sleep 1\n' +
    'hp=$(cat "' + pidfile + '" 2>/dev/null)\n' +
    'if [ -n "$hp" ] && kill -0 "$hp" 2>/dev/null; then echo LEAK; else echo OK; fi\n' +
    '[ -n "$hp" ] && kill -9 "$hp" 2>/dev/null\n' +  // belt-and-suspenders: never leak
    'exit 0\n');
  const r = spawnSync('/bin/sh', [harness], { encoding: 'utf8', timeout: 15000 });
  assert.ok(/\bOK\b/.test(r.stdout || ''), 'wrapped command torn down with the entry (NO leak); harness said: ' + JSON.stringify(r.stdout));
});

// ---- malformed / empty stdin ---------------------------------------------------

test('entry: non-JSON stdin -> telemetry null, bar "ctx --", exit 0', function () {
  const dir = tmpDir();
  const r = runEntry('not json {', { CCT_DIR: dir, CCT_NODE: process.execPath });
  assert.strictEqual(r.status, 0);
  assert.ok(/ctx --/.test(r.stdout));
  assert.strictEqual(readTelFile(dir, 'default').context_pct, null);
});

test('entry: empty stdin -> telemetry null, bar "ctx --", exit 0', function () {
  const dir = tmpDir();
  const r = runEntry('', { CCT_DIR: dir, CCT_NODE: process.execPath });
  assert.strictEqual(r.status, 0);
  assert.ok(/ctx --/.test(r.stdout));
});

// ---- readTelemetry freshness (index.js) ----------------------------------------

test('readTelemetry returns null when the file is absent', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  assert.strictEqual(api.readTelemetry('nope'), null);
  delete process.env.CCT_DIR;
});
test('readTelemetry fresh for a recent ts', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('s-fresh', { session_id: 's-fresh', context_pct: 42, used_percentage: 42,
    context_window_size: 200000, model: 'm', ts: new Date().toISOString(), source: 'statusline' });
  const t = api.readTelemetry('s-fresh');
  assert.ok(t); assert.strictEqual(t.fresh, true); assert.strictEqual(t.contextPct, 42);
  delete process.env.CCT_DIR;
});
test('readTelemetry NOT fresh for a stale ts', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('s-stale', { session_id: 's-stale', context_pct: 42,
    ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('s-stale').fresh, false);
  delete process.env.CCT_DIR;
});
test('readTelemetry NOT fresh for a far-future ts', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('s-future', { session_id: 's-future', context_pct: 42,
    ts: new Date(Date.now() + 10 * 60 * 1000).toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('s-future').fresh, false);
  delete process.env.CCT_DIR;
});
test('readTelemetry NOT fresh when context_pct is null even with recent ts', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('s-noctx', { session_id: 's-noctx', context_pct: null, ts: new Date().toISOString(), source: 'statusline' });
  const t = api.readTelemetry('s-noctx');
  assert.strictEqual(t.fresh, false); assert.strictEqual(t.contextPct, null);
  delete process.env.CCT_DIR;
});
test('opts.ttlSec overrides the default TTL', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('s-ttl', { session_id: 's-ttl', context_pct: 1, ts: new Date(Date.now() - 50 * 1000).toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 30 }).fresh, false);
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 120 }).fresh, true);
  delete process.env.CCT_DIR;
});

// ---- path traversal containment (index.js) -------------------------------------

test('writeTelemetry with a "../../tmp/evil" id stays INSIDE CCT_DIR', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  const escaped = path.resolve(os.tmpdir(), 'evil.json');
  try { fs.unlinkSync(escaped); } catch (e) {}
  api.writeTelemetry('../../tmp/evil', { session_id: 'x', context_pct: 1, ts: api.nowIso() });
  assert.strictEqual(fs.existsSync(escaped), false);
  assert.strictEqual(api.readTelemetry('../../tmp/evil').contextPct, 1);
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  assert.ok(/^telemetry-.*\.json$/.test(files[0]));
  delete process.env.CCT_DIR;
});
test('writeTelemetry with a slashed id ("a/b/c") cannot create nested dirs', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('a/b/c', { session_id: 'x', context_pct: 9, ts: api.nowIso() });
  assert.strictEqual(fs.existsSync(path.join(dir, 'a')), false);
  assert.strictEqual(fs.readdirSync(dir).length, 1);
  assert.strictEqual(api.readTelemetry('a/b/c').contextPct, 9);
  delete process.env.CCT_DIR;
});

// ---- readTelemetry on garbage / TTL validation ---------------------------------

test('readTelemetry on a non-JSON file returns null, does not throw', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  fs.writeFileSync(api.telemetryPath('s-garbage'), 'not json at all <<<');
  let result, threw = false;
  try { result = api.readTelemetry('s-garbage'); } catch (e) { threw = true; }
  assert.strictEqual(threw, false); assert.strictEqual(result, null);
  delete process.env.CCT_DIR;
});
test('CCT_TTL_SEC="" / negative fall back to default 120', function () {
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

// ---- CCT_DEBUG opt-in raw dump -------------------------------------------------

test('CCT_DEBUG=1 dumps verbatim raw stdin; telemetry still written', function () {
  const dir = tmpDir();
  const rawPayload = '{"session_id":"s-dbg","context_window":{"used_percentage":12,"context_window_size":200000},"extra":"keep"}';
  const r = runTelemetry(rawPayload, { CCT_DIR: dir, CCT_DEBUG: '1' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'debug-statusline.json'), 'utf8'), rawPayload);
});
test('CCT_DEBUG falsey (0/false) writes NO debug file; "1" does', function () {
  const d0 = tmpDir();
  runTelemetry('{"session_id":"s-d0","context_window":{"used_percentage":1,"context_window_size":200000}}', { CCT_DIR: d0, CCT_DEBUG: '0' });
  assert.strictEqual(fs.existsSync(path.join(d0, 'debug-statusline.json')), false);
  const d1 = tmpDir();
  runTelemetry('{"session_id":"s-d1","context_window":{"used_percentage":1,"context_window_size":200000}}', { CCT_DIR: d1, CCT_DEBUG: '1' });
  assert.strictEqual(fs.existsSync(path.join(d1, 'debug-statusline.json')), true);
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
