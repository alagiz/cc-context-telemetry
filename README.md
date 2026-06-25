# cc-context-telemetry

Claude Code hooks and plugins cannot see context fullness or rate limits. The ONLY
place Claude Code exposes the authoritative `context_window` (used percentage,
window size) and Pro/Max `rate_limits` is the `statusLine` command. This tiny,
zero-dependency library bridges that gap: it is a statusLine wrapper that captures
Claude Code's authoritative telemetry, writes it to a per-session file your hooks
can read, and passes through to your existing statusline so you keep your bar.

One job, three pieces:

- `bin/cct-statusline` - the POSIX shell entry Claude Code calls as its statusLine.
  It captures the payload, runs the telemetry writer, and then - if `CCT_WRAP` is set
  to your original statusline command - **`exec`s that command** so it BECOMES the
  statusLine process (see Process handling for why this matters). In standalone mode
  it prints a minimal bar so the segment is never blank.
- `bin/telemetry.js` - the telemetry writer. A fast node process that parses the
  payload, writes `telemetry-<session>.json`, and exits. It spawns nothing.
- `index.js` - `readTelemetry(sessionId)` for your hooks to read the latest reading,
  with a freshness check.

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
entry `exec`s it with the same stdin so you keep your bar, and Claude Code manages it
exactly as if it were your statusLine directly:

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

(If your Claude Code version does not support an `env` block on `statusLine`, export
`CCT_WRAP` in your shell profile instead. If `node` is not on the PATH Claude Code
uses, set `CCT_NODE` to its absolute path.)

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

`fresh` rejects both stale and far-future timestamps (it checks the absolute age
against the TTL). When `fresh` is false, treat it as "no signal" and stay
observe-only. `opts.ttlSec` (or env `CCT_TTL_SEC`) overrides the default 120s TTL.
An override is honored only when it is a finite number greater than 0; a blank,
zero, negative, or non-numeric value falls back to the default.

The module also exports `DEFAULT_TTL_SEC` (the 120s default, a number),
`writeTelemetry(sessionId, obj)`, `telemetryDir()`, `telemetryPath(sessionId)`,
and `nowIso()`. `telemetryPath` sanitizes the session id (everything outside
`[A-Za-z0-9_-]` becomes `_`), so a reading is always confined to the telemetry
directory.

## Telemetry file

One file per session at `<dir>/telemetry-<session>.json`:

```json
{
  "session_id": "abc123",
  "context_pct": 47.2,
  "used_percentage": 47.2,
  "context_window_size": 200000,
  "model": "claude-opus-4-1",
  "ts": "2026-06-22T12:00:00.000Z",
  "source": "statusline",
  "five_hour_pct": 12,
  "seven_day_pct": 30
}
```

`five_hour_pct` / `seven_day_pct` are present only when Claude Code reported them
(Pro/Max OAuth). They are omitted (never written as 0) for API-key / Bedrock /
Vertex. `context_pct` is `null` before the first API response and right after a
compaction.

## Environment variables

- `CCT_WRAP` - your original statusline command, as a SINGLE foreground command (a
  program plus args, e.g. `'/path/to/your-statusline' status`). The entry `exec`s it
  with the same stdin so it becomes the statusLine process and forwards its output. It
  must NOT be a pipeline (`a | b`) or backgrounded (trailing `&`): a pipeline mis-routes
  stdin, and `&` leaves a process running past the render (exactly as it would running
  directly). If you need a pipeline, put it in a small script and point `CCT_WRAP` at
  that script. When `CCT_WRAP` is unset, the entry prints its own minimal bar
  (`ctx 47% | 5h 12% | 7d 30%`).
- `CCT_NODE` - absolute path to the `node` binary, if `node` is not on the PATH that
  Claude Code uses to run the statusLine. Defaults to `node`.
- `CCT_DIR` - telemetry directory (default `~/.claude/cc-context-telemetry/`).
- `CCT_TTL_SEC` - freshness window for `readTelemetry` in seconds (default 120).
- `CCT_DEBUG` - when set to a truthy value (e.g. `1`, `true`, `yes`), the wrapper
  dumps the exact raw statusline stdin to `<CCT_DIR>/debug-statusline.json`,
  overwriting it each call so it is always the latest real payload. The values
  `0`, `false`, `off`, `no`, and an empty string (case-insensitive) count as OFF.
  Off by default; best-effort (it never throws, never affects the bar or exit
  code). Use it to inspect the real payload field paths when telemetry comes back
  null. The dump may contain real session content, overwrites in place, and is
  NOT auto-cleaned, so delete it when you are done.

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

The only added process is the telemetry writer - a fast node process that parses the
payload, writes one small file, and exits in milliseconds. It spawns nothing and cannot
accumulate.

## Verify it works (one cheap session)

The wrapper has been tested against stub payloads. To confirm it parses Claude
Code's REAL statusline payload, one short session is enough (the statusline
renders every turn, so there is no need to fill the context):

1. Wire `bin/cct-statusline` as your `statusLine` (see Wiring above) and set
   `CCT_DEBUG=1` so the raw payload is also dumped. Add `CCT_WRAP` (your original
   statusline command) so you keep your existing bar during the test. For example:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "/absolute/path/to/cc-context-telemetry/bin/cct-statusline",
       "env": {
         "CCT_WRAP": "node /absolute/path/to/your/original-statusline.js",
         "CCT_DEBUG": "1"
       }
     }
   }
   ```

   (If your Claude Code version does not support an `env` block on `statusLine`,
   export `CCT_WRAP` and `CCT_DEBUG=1` in your shell profile instead.) Without
   `CCT_WRAP`, the minimal standalone `ctx ..%` bar REPLACES your existing bar for
   the duration of the test; remove the test wiring (or set `CCT_WRAP`) to get it
   back. Editing `settings.json` only takes effect in a FRESH session, so start a
   new one after saving.

2. Open any session and send ONE message. The statusline runs that turn.

3. Check `~/.claude/cc-context-telemetry/telemetry-<session>.json` for sane
   values: a numeric (or null) `context_pct`, a `context_window_size`, and a
   `model`. Your session id is the `<session>` in that filename (the only
   `telemetry-*.json` written this session), and it is also the `session_id`
   field in any hook payload. You can also run
   `node examples/print-telemetry.js <session-id>` to print it as pretty JSON.

4. If the values are null or missing, inspect
   `~/.claude/cc-context-telemetry/debug-statusline.json` (the verbatim raw
   payload) to see the real field paths Claude Code sent.

## Examples

See the [`examples/`](examples/) directory for complete, runnable files: a
copy-pasteable PreToolUse warning hook (`pretooluse-warn.js`) and a telemetry
printer for the live check (`print-telemetry.js`). The examples are not shipped to
npm.

## License

MIT
