# cc-context-telemetry

Claude Code hooks and plugins cannot see context fullness or rate limits. The ONLY
place Claude Code exposes the authoritative `context_window` (used percentage,
window size) and Pro/Max `rate_limits` is the `statusLine` command. This tiny,
zero-dependency library bridges that gap: it is a statusLine wrapper that captures
Claude Code's authoritative telemetry to a per-session file your hooks can read, and
renders a compact `ctx % | 5h % | 7d %` segment in front of your existing statusline
bar - the context/usage readout shown next to whatever bar you already use.

One job, three pieces:

- `bin/cct-statusline` - the POSIX shell entry Claude Code calls as its statusLine,
  every render. It is **pure shell, with NO Node on the per-render path**: it reads the
  payload once, extracts the session id, and atomically writes the RAW payload to
  `telemetry-raw-<session>.json`. Then it prints a compact `ctx % | 5h % | 7d %`
  segment and, if `CCT_WRAP` is set to your original statusline command, **`exec`s that
  command** so its bar appends right after the segment on the same line and it BECOMES
  the statusLine process (see Process handling for why this matters); with no `CCT_WRAP`
  the segment is the whole bar, never blank. There is no per-render Node spawn at all (an
  earlier design spawned `node` every render; across many sessions that piled up - see
  Process handling).
- `index.js` - the consumer. `readTelemetry(sessionId)` reads the raw payload file,
  parses it ON DEMAND, and returns the latest reading with a freshness check. So all
  JSON parsing happens here, only when a hook actually asks - never on the hot path. It
  also prunes stale per-session raw files (off the hot path, throttled).
- `bin/telemetry.js` - an on-demand CLI reader over `readTelemetry`, for the manual
  live check. It is NOT in the per-render path; it runs only when you invoke it.

Zero third-party dependencies. Node >= 18. POSIX shell (Linux/macOS). Never throws,
never calls `claude`.

## Wiring

Add this to `~/.claude/settings.json` (use an absolute path to the entry script, or
the `cc-context-telemetry-statusline` command if installed globally):

```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/cc-context-telemetry/bin/cct-statusline"
  }
}
```

To keep your existing bar, point `CCT_WRAP` at your original statusline command. The
entry prints its `ctx % | 5h % | 7d %` segment and then `exec`s your command with the
same stdin, so the statusLine is that segment followed by your own bar on one line:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/cc-context-telemetry/bin/cct-statusline",
    "env": {
      "CCT_WRAP": "node /absolute/path/to/your/original-statusline.js"
    }
  }
}
```

With that wiring your statusLine renders as the telemetry segment followed by your own
bar on one line. This works with ANY statusline command (it is not specific to any
one), for example:

```
ctx 48% | 5h 14% | 7d 50%   <whatever your CCT_WRAP command prints>
```

(If your Claude Code version does not support an `env` block on `statusLine`, export
`CCT_WRAP` in your shell profile instead. The per-render path is pure shell, so no
`node` needs to be on Claude Code's PATH for the wrapper itself - only your `CCT_WRAP`
command and your hooks need their own interpreters.)

## Consumer API (hooks)

In any hook (PreToolUse, PreCompact, etc.), read the latest reading:

```js
const { readTelemetry } = require('cc-context-telemetry');
const d = require('fs').readFileSync(0, 'utf8'); // hook stdin
const sessionId = JSON.parse(d).session_id;
const t = readTelemetry(sessionId);
if (t && t.fresh && t.contextPct >= 85) { /* near the wall: act */ }
```

`readTelemetry(sessionId, opts)` returns `null` when absent, otherwise:

```js
{
  sessionId,      // string
  contextPct,     // number or null (context window used %)
  usedPercentage, // number or null (alias of contextPct)
  windowSize,     // number or null (context_window_size)
  fiveHourPct,    // number, OMITTED when Claude Code did not report it
  sevenDayPct,    // number, OMITTED when Claude Code did not report it
  model,          // string or null (model id)
  ts,             // ISO timestamp string or null
  source,         // "statusline"
  fresh           // true when contextPct is a finite number AND ts is within the TTL
}
```

`contextPct` / `usedPercentage` are passed through verbatim from Claude Code's
`context_window.used_percentage` (a percentage, 0..100 in practice). The library does
NOT range-clamp them; it only verifies they are numbers, so treat them as advisory and
do not assume a strict `0..100` bound. `fresh` already rejects non-finite values.

`fresh` rejects both stale and far-future timestamps (it checks the absolute age
against the TTL). When `fresh` is false, treat it as "no signal" and stay
observe-only. `opts.ttlSec` (or env `CCT_TTL_SEC`) overrides the default 120s TTL.
An override is honored only when it is a finite number greater than 0; a blank,
zero, negative, or non-numeric value falls back to the default.

The module also exports `DEFAULT_TTL_SEC` (the 120s default, a number),
`parsePayload(d, sessionId)` (the raw-to-normalized field mapping),
`rawPath(sessionId)`, `pruneRaw()`, `telemetryDir()`, `telemetryPath(sessionId)`,
`writeTelemetry(sessionId, obj)`, and `nowIso()`. The session id is sanitized
(everything outside `[A-Za-z0-9_-]` becomes `_`), so a reading is always confined to
the telemetry directory.

## Telemetry file

The pure-shell entry writes ONE file per session: the RAW Claude Code statusline
payload, verbatim, at `<dir>/telemetry-raw-<session>.json`. It is overwritten each
render (atomically, via a temp file + rename), so a single session never grows the
directory. `readTelemetry(sessionId)` parses that raw file on demand. The raw payload
looks like (fields vary by plan/model/version - the lib reads them straight, never
assuming a shape):

```json
{
  "session_id": "abc123",
  "context_window": { "used_percentage": 47.2, "context_window_size": 200000 },
  "rate_limits": { "five_hour": { "used_percentage": 12 }, "seven_day": { "used_percentage": 30 } },
  "model": { "id": "claude-opus-4-1" }
}
```

`rate_limits` is present only for Pro/Max OAuth; it is absent (so `fiveHourPct` /
`sevenDayPct` are omitted, never reported as 0) for API-key / Bedrock / Vertex.
`context_window.used_percentage` is `null` before the first API response and right
after a compaction (so `contextPct` is `null` and `fresh` is `false`).

### Raw-file hygiene

`telemetry-raw-<session>.json` is per session, so live sessions bound the file count,
but a long-lived machine sees a new session id (UUID) per `claude` run. So
`readTelemetry` prunes off the hot path (throttled, at most once per
`CCT_PRUNE_EVERY_SEC`, default hourly): it deletes raw files older than
`CCT_PRUNE_AGE_SEC` (default 1 day) and then caps the total at `CCT_PRUNE_MAX_FILES`
(default 200, deleting the oldest beyond the cap). It only ever touches this lib's own
`telemetry-raw-*.json` files. Pruning is best-effort and never throws.

## Environment variables

- `CCT_WRAP` - your original statusline command, as a SINGLE foreground command (a
  program plus args, e.g. `'/path/to/your-statusline' status`). The entry `exec`s it
  with the same stdin so it becomes the statusLine process and forwards its output. It
  must NOT be a pipeline (`a | b`) or backgrounded (trailing `&`): a pipeline mis-routes
  stdin, and `&` leaves a process running past the render (exactly as it would running
  directly). If you need a pipeline, put it in a small script and point `CCT_WRAP` at
  that script. When `CCT_WRAP` is unset, the entry prints its own minimal bar
  (`ctx 47% | 5h 12% | 7d 30%`).
- `CCT_DIR` - telemetry directory (default `~/.claude/cc-context-telemetry/`). The
  shell entry mirrors this default; set it on the statusLine env AND for your hooks so
  both sides agree.
- `CCT_TTL_SEC` - freshness window for `readTelemetry` in seconds (default 120).
- `CCT_PRUNE_AGE_SEC` - delete raw files older than this on the reader side (default
  86400, 1 day).
- `CCT_PRUNE_MAX_FILES` - hard cap on raw files; the oldest beyond it are deleted
  (default 200).
- `CCT_PRUNE_EVERY_SEC` - throttle: prune at most once per this interval across reader
  invocations (default 3600, hourly).

The raw payload file (`telemetry-raw-<session>.json`) IS the verbatim statusline
payload, so it doubles as the debug dump: inspect it directly to see the real field
paths Claude Code sent. It may contain real session content and is overwritten each
render; the reader auto-prunes it (see Raw-file hygiene).

## Process handling (why the wrapper is safe to run every render)

Claude Code runs the statusLine command on every render, in every open session, and
keeps it bounded by killing that per-render process. So a wrapper around your existing
statusline must let Claude Code manage your statusline's lifecycle exactly as it would
directly - or the wrapped command piles up.

This entry `exec`s your `CCT_WRAP` command: the entry process **becomes** your
statusline, so the process Claude Code spawns and later kills IS your statusline. It is
torn down each render just like running it directly - no extra long-lived process, no
pile-up.

It does NOT spawn your statusline as a child and babysit it. Spawning a child (detached
or not) from a per-render process is unsafe: when Claude Code kills the wrapper, the
spawned statusline can survive, and a heavy statusline (one that itself shells out)
then leaks an instance every render until the machine is overloaded. `exec`, not spawn,
is what makes wrapping safe. (Versions before 0.2.0 spawned; do not use them.)

A corollary: do NOT make YOUR wrapped statusline background a helper (a trailing `&` or
a detached child that outlives the front process). Such a statusline leaks that helper
on every render-kill - but it leaks IDENTICALLY whether you run it directly or through
this wrapper. Because `exec` makes your command BECOME the process Claude Code kills, the
process tree is the same as running it directly, so the wrapper introduces no extra
orphan; the leak is the forking statusline's own foot-gun. `test/loadrepro` proves this
with a forking callee run both ways and asserts the orphan counts are EQUAL.

There is also NO Node process on the per-render path. An earlier design ran a small
`node` telemetry writer every render. When Claude Code killed the statusline's front
process while that node child was still running, the node child reparented to init and
SURVIVED - one orphan per render, times many concurrent sessions, times a high render
rate, which piled up. The rewrite moved all JSON parsing off the hot path (the shell
entry only writes the raw payload; `index.js` parses on demand), so the per-render path
is pure shell and spawns nothing that can outlive the render. `test/loadrepro` is a
synthetic, self-cleaning harness that reproduces the old node-per-render orphan pile-up
and asserts the current exec-through wrapper leaves nothing behind.

The entry reads stdin with a plain `cat` and NO timeout, relying on Claude Code closing
the statusLine's stdin after a single bounded write (the same contract a direct
statusLine command sees). This is not an assumption: the `adtention` statusLine binary
reads its stdin with `io.ReadAll(os.Stdin)` (which blocks until EOF) and runs flat as a
DIRECT statusLine with no pile-up, so if Claude Code did not close the statusLine stdin a
direct `adtention` would hang every render - it does not, so Claude Code closes it, and
our `cat` (reading the identical stdin) gets the identical EOF. We deliberately avoid a
per-render timeout subprocess because that would reintroduce the per-render spawn this
rewrite removed. If a future Claude Code build ever held statusLine stdin open, the
`cat` would block - so confirm the EOF behavior on your Claude Code version with the one
cheap session below before trusting it in long autonomous runs.

## Verify it works (one cheap session)

The wrapper has been tested against stub payloads. To confirm it parses Claude
Code's REAL statusline payload, one short session is enough (the statusline
renders every turn, so there is no need to fill the context):

1. Wire `bin/cct-statusline` as your `statusLine` (see Wiring above). Add `CCT_WRAP`
   (your original statusline command) so you keep your existing bar during the test.
   For example:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "/absolute/path/to/cc-context-telemetry/bin/cct-statusline",
       "env": {
         "CCT_WRAP": "node /absolute/path/to/your/original-statusline.js"
       }
     }
   }
   ```

   (If your Claude Code version does not support an `env` block on `statusLine`,
   export `CCT_WRAP` in your shell profile instead.) Without `CCT_WRAP`, the minimal
   standalone `ctx ..%` bar REPLACES your existing bar for the duration of the test;
   remove the test wiring (or set `CCT_WRAP`) to get it back. Editing `settings.json`
   only takes effect in a FRESH session, so start a new one after saving.

2. Open any session and send ONE message. The statusline runs that turn.

3. Run `node examples/print-telemetry.js <session-id>` to print the parsed reading
   as pretty JSON; check for sane values (a numeric or null `contextPct`, a
   `windowSize`, a `model`). Your session id is the `session_id` field in any hook
   payload, and it is the `<session>` in the raw file written this session (the only
   `telemetry-raw-*.json` for this session, under
   `~/.claude/cc-context-telemetry/`).

4. If the values are null or missing, inspect the raw file itself
   (`~/.claude/cc-context-telemetry/telemetry-raw-<session>.json`), which IS the
   verbatim statusline payload, to see the real field paths Claude Code sent.

## Examples

See the [`examples/`](examples/) directory for complete, runnable files: a
copy-pasteable PreToolUse warning hook (`pretooluse-warn.js`) and a telemetry
printer for the live check (`print-telemetry.js`). The examples are not shipped to
npm.

## License

MIT
